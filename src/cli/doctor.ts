import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, release, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import type { Agent } from '../shared/agent.ts';
import { loadConfig, which } from '../shared/config.ts';
import { api, runningDaemon } from '../shared/daemon-client.ts';
import { paths, ROOT } from '../shared/paths.ts';
import { onWindowsDrive, PLATFORM } from '../shared/platform.ts';
import { compareVersions, type SetupCheck, type SystemInfo } from '../shared/system.ts';
import { VERSION } from '../shared/version.ts';
import { versionIn } from '../daemon/claude-update.ts';
import { readClaudeSettings, systemInfo } from '../daemon/system.ts';
import { ptyProblem } from '../daemon/pty.ts';
import { parseArgs } from './args.ts';
import { code } from './help.ts';
import type { RunIO } from './run.ts';
import { tildify } from './style.ts';

// `forchetta doctor`: whether everything is in place, what to do when it is not, and the last warnings of the log.
// With --bundle, the same in a file to attach to an issue: what could tell who you are or what you work on (your
// home, your user name, the names of your projects and teams, e-mail addresses, tokens) is replaced first.

interface Finding {
  ok: boolean | 'warn';
  label: string;
  detail: string;
  fix?: string;
}

/** The last warnings and errors of the log of the daemon, from the last day. */
export function logProblems(text: string, now = Date.now(), max = 12): string[] {
  const since = now - 86_400_000;
  return text
    .split('\n')
    .filter((line) => / (WARN|ERROR) /.test(line))
    .filter((line) => {
      const at = Date.parse(line.slice(0, 24));
      return Number.isFinite(at) && at >= since;
    })
    .slice(-max);
}

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The folder of a user of Windows, as WSL writes it, as Windows does, and as JSON writes that. */
const WINDOWS_USER = /((?:\/mnt)?\/[a-z]\/|[a-z]:(?:\\{1,2}|\/))(Users)(\\{1,2}|\/)([^\\/\r\n"'`<>|:*?]{1,64}(?=[\\/])|[^\s\\/"'`<>|:*?,;)]+)/gi;

/**
 * The text with what could say who you are taken out: the home and the user name, e-mail addresses, long hex
 * tokens, and the names given (projects, teams), each replaced by a neutral one. With `host` (Linux and WSL, where
 * it is the name of the PC) also that, and the users of Windows, whose folders the paths of WSL name.
 */
export function redact(text: string, names: readonly string[] = [], home = homedir(), user = userInfo().username, host = PLATFORM === 'macos' ? '' : hostname()): string {
  let out = text.split(home).join('~');
  if (host) {
    const users = new Set<string>();
    out = out.replace(WINDOWS_USER, (_path, drive: string, folder: string, slash: string, name: string) => {
      if (!/^(?:public|default|default user|all users)$/i.test(name)) users.add(name);
      return `${drive}${folder}${slash}<user>`;
    });
    for (const name of [...users, host]) if (name.length >= 3) out = out.replace(new RegExp(`(?<![\\w-])${literal(name)}(?![\\w-])`, 'gi'), name === host ? '<computer>' : '<user>');
  }
  out = out.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>');
  out = out.replace(/\b[0-9a-f]{32,}\b/gi, '<token>');
  out = out.replace(/\bsk-ant-[\w-]+/g, '<key>');
  const unique = [...new Set(names.filter((name) => name && name.length >= 3))].sort((a, b) => b.length - a.length);
  unique.forEach((name, index) => {
    out = out.split(name).join(`name-${index + 1}`);
  });
  if (user && user.length >= 3) out = out.replace(new RegExp(`\\b${literal(user)}\\b`, 'g'), '<user>');
  return out;
}

function readLog(): string {
  let text = '';
  for (const file of [`${paths.log}.1`, paths.log]) {
    try {
      text += readFileSync(file, 'utf8');
    } catch {
      // Not there.
    }
  }
  return text;
}

/** Files set aside in the private folder: a data file that could not be read, entries not valid any more. */
function setAside(): string[] {
  try {
    return readdirSync(paths.varDir).filter((name) => /\.corrupt-|\.rejected\.json$/.test(name));
  } catch {
    return [];
  }
}

function toolVersion(file: string | undefined, args: string[]): string | undefined {
  if (!file) return undefined;
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 ? `${result.stdout}${result.stderr}`.trim().split('\n')[0] : undefined;
}

/** The Linux this is: "Ubuntu 24.04.1 LTS (WSL, 5.15.153.1-microsoft-standard-WSL2)". */
export function osName(platform = PLATFORM, kernel = release()): string {
  let name = 'Linux';
  try {
    name = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? name;
  } catch {
    // No such file: the kernel says enough.
  }
  return `${name} (${platform === 'wsl' ? 'WSL, ' : ''}${kernel})`;
}

export async function doctorCommand(args: readonly string[], io: RunIO): Promise<number> {
  const { flags, values } = parseArgs('doctor', args, { flags: ['--bundle', '--json'], values: ['--out'] });
  const s = io.style;
  const findings: Finding[] = [];
  const node = process.versions.node;
  findings.push({ ok: compareVersions(node, '22.0.0') >= 0, label: 'Node.js', detail: `${node}${compareVersions(node, '22.0.0') < 0 ? ': Forchetta needs 22 or later' : ''}`, ...(compareVersions(node, '22.0.0') < 0 ? { fix: PLATFORM === 'macos' ? 'brew upgrade node' : 'install Node.js 22 or later, from https://nodejs.org' } : {}) });
  findings.push({ ok: true, label: 'Forchetta', detail: `${VERSION} · ${tildify(ROOT)}` });
  let mode = '';
  try {
    mode = (statSync(paths.varDir).mode & 0o777).toString(8);
  } catch {
    mode = '';
  }
  findings.push({ ok: mode === '700' ? true : mode ? 'warn' : true, label: 'Private folder', detail: `${tildify(paths.varDir)}${mode && mode !== '700' ? ` (permissions ${mode}, not 700)` : mode ? '' : ' (not created yet)'}`, ...(mode && mode !== '700' ? { fix: `chmod 700 ${JSON.stringify(paths.varDir)}` } : {}) });

  if (PLATFORM === 'wsl' && [ROOT, paths.varDir].some(onWindowsDrive)) {
    findings.push({ ok: false, label: 'Folder of Windows', detail: 'Forchetta is on a drive of Windows, which cannot hold its sockets and private data: put it in your home of WSL' });
  }

  const daemon = await runningDaemon();
  let system: SystemInfo | undefined;
  let agents: Agent[] = [];
  let crews: string[] = [];
  if (daemon) {
    const health = await api<{ version: string; pid: number; startedAt: number }>(daemon, 'GET', '/api/health');
    const same = health.version === VERSION;
    findings.push({ ok: same ? true : 'warn', label: 'Daemon', detail: `${health.version} · pid ${health.pid}${same ? '' : ` — this forchetta is ${VERSION}`}`, ...(same ? {} : { fix: 'forchetta daemon stop && forchetta daemon start' }) });
    try {
      system = (await api<{ system: SystemInfo }>(daemon, 'GET', '/api/system')).system;
    } catch {
      // A daemon from before /api/system: the checks are made here.
    }
    try {
      agents = (await api<{ agents: Agent[] }>(daemon, 'GET', '/api/agents')).agents;
      crews = (await api<{ teams: { name: string }[] }>(daemon, 'GET', '/api/teams')).teams.map((team) => team.name);
    } catch {
      // Names only for the bundle.
    }
  } else {
    findings.push({ ok: 'warn', label: 'Daemon', detail: 'not running', fix: 'forchetta daemon start' });
  }
  if (!system) {
    // Without the daemon: the same checks, from here.
    const config = loadConfig();
    const claude = config.paths.claude ?? which('claude');
    system = systemInfo({
      config,
      tmux: config.paths.tmux ?? which('tmux'),
      ptyProblem: PLATFORM === 'macos' ? undefined : ptyProblem(),
      claude,
      claudeVersion: versionIn(toolVersion(claude, ['--version']) ?? ''),
      arricurdai: config.arricurdai,
      notesSupported: false,
      haikuOn: false,
      socket: existsSync(paths.hooksSocket),
      hookSeen: false,
      sessions: 0,
      settingsText: readClaudeSettings(),
    });
    system.checks = system.checks.filter((check) => check.id !== 'events' && (check.id !== 'socket' || daemon));
    // Only a daemon of this version knows whether arricurdAI writes the note before /clear.
    system.features = system.features.filter((feature) => feature.id !== 'notes');
  }
  for (const check of system.checks) findings.push({ ok: check.ok, label: check.label, detail: check.detail ?? '', ...(check.fix ? { fix: check.fix } : {}) });
  if (system.claude.installed) {
    const newer = system.claude.newer;
    findings.push({
      ok: newer === 'minor' ? 'warn' : true,
      label: 'Claude Code version',
      detail: `${system.claude.installed}, tested with ${system.claude.tested}${newer === 'minor' ? ': newer than tested, if something looks off, say so in an issue' : ''}`,
    });
  }
  const aside = setAside();
  if (aside.length > 0) findings.push({ ok: 'warn', label: 'Files set aside', detail: `${aside.slice(0, 4).join(', ')}${aside.length > 4 ? ` and ${aside.length - 4} more` : ''} in ${tildify(paths.varDir)}: data that could not be read, kept for you` });
  const problems = logProblems(readLog());

  if (flags.has('--json')) {
    io.stdout(`${JSON.stringify({ findings, features: system.features, logProblems: problems }, null, 2)}\n`);
  } else {
    const width = Math.max(...findings.map((finding) => finding.label.length));
    for (const finding of findings) {
      const mark = finding.ok === true ? s.mark('✓', 'green', '') : finding.ok === 'warn' ? s.mark('▲', 'amber', '') : s.mark('✗', 'red', '');
      io.stdout(`${mark}${s.bold(finding.label.padEnd(width))}  ${s.dim(finding.detail)}\n`);
      if (finding.fix) io.stdout(`${s.color ? '  ' : ''}${' '.repeat(width)}  ${code(`→ \`${finding.fix}\``, s)}\n`);
    }
    io.stdout(`\n${s.bold('Optional features')}\n`);
    for (const feature of system.features) io.stdout(`  ${feature.on ? s.green('on ') : s.dim('off')}  ${feature.label} ${s.dim(`— ${feature.why}`)}${!feature.on && feature.how ? `\n         ${code(feature.how.startsWith('forchetta ') ? `\`${feature.how}\`` : feature.how, s)}` : ''}\n`);
    if (problems.length > 0) {
      io.stdout(`\n${s.bold('Warnings in the log, last day')} ${s.dim(`(${tildify(paths.log)})`)}\n`);
      for (const line of problems) io.stdout(`  ${s.dim(line.slice(0, 24))} ${line.slice(25, 220)}\n`);
    }
  }

  if (flags.has('--bundle')) {
    const names = [...agents.flatMap((agent) => [agent.project, agent.name ?? '', agent.team?.label ?? '', ...(agent.cwd ? [agent.cwd.split('/').at(-1) ?? ''] : [])]), ...crews];
    const scrub = (text: string): string => redact(text, names);
    const dir = mkdtempSync(join(tmpdir(), 'forchetta-doctor-'));
    const stamp = new Date().toISOString().slice(0, 10);
    const folder = join(dir, `forchetta-doctor-${stamp}`);
    try {
      mkdirSync(folder, { recursive: true });
      const report = { forchetta: VERSION, node, ...(PLATFORM === 'macos' ? { macos: toolVersion('/usr/bin/sw_vers', ['-productVersion']) ?? release() } : { os: osName() }), tmux: toolVersion(system.checks.find((check) => check.id === 'tmux')?.ok ? (loadConfig().paths.tmux ?? which('tmux')) : undefined, ['-V']), findings, features: system.features, claude: system.claude };
      writeFileSync(join(folder, 'doctor.json'), scrub(`${JSON.stringify(report, null, 2)}\n`));
      writeFileSync(join(folder, 'daemon.log'), scrub(readLog().split('\n').slice(-3000).join('\n')));
      writeFileSync(join(folder, 'config.json'), scrub(`${JSON.stringify(loadConfig(), null, 2)}\n`));
      writeFileSync(
        join(folder, 'sessions.json'),
        scrub(`${JSON.stringify(agents.map((agent) => ({ state: agent.state, project: agent.project, control: agent.control.kind, model: agent.model, lastEvent: agent.lastEvent, team: agent.team?.crew ? 'yes' : undefined, error: agent.error?.kind })), null, 2)}\n`),
      );
      const out = resolve(values.get('--out') ?? process.cwd(), `forchetta-doctor-${stamp}.tar.gz`);
      const tar = spawnSync('/usr/bin/tar', ['-czf', out, '-C', dir, `forchetta-doctor-${stamp}`], { encoding: 'utf8' });
      if (tar.status !== 0) throw new Error(tar.stderr || 'tar failed');
      io.stdout(`\n${s.mark('✓', 'green', `Written ${s.bold(tildify(out))}`)}\n  ${s.dim('Your home, user name, project and team names, e-mails and tokens are replaced. Look inside before you share it.')}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return findings.some((finding) => finding.ok === false) ? 1 : 0;
}

export type { SetupCheck };
