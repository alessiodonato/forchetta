import { type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig, resolveTool, which } from '../shared/config.ts';
import { api, ensureDaemon, runningDaemon } from '../shared/daemon-client.ts';
import { installLaunchAgent, launchAgentFile } from '../daemon/launch-agent.ts';
import { UserError } from '../shared/errors.ts';
import { ensurePrivateDir, paths, ROOT } from '../shared/paths.ts';
import { VERSION } from '../shared/version.ts';
import { code } from './help.ts';
import { hooksCommand, NOT_APPLIED } from './hooks.ts';
import type { RunIO } from './run.ts';
import { spinner, tildify } from './style.ts';

// `forchetta setup`: what makes an installed Forchetta ready, in one command. It checks tmux, claude and the
// Command Line Tools, builds the app on this Mac and puts it in ~/Applications, then installs the hooks, with the
// diff and the question of `forchetta hooks install`. The app is built here, not downloaded: macOS does not
// quarantine it, so it opens with no warning even without a signature of Apple. After an upgrade it is run again,
// and builds the app only when its version or the Forchetta folder it runs changed.

export interface SetupOptions {
  /** Install the hooks without asking. */
  yes: boolean;
  /** Show the whole diff of settings.json before asking. */
  diff: boolean;
  /** Build the app even when the installed one is up to date. */
  force: boolean;
  /** Start a daemon of another version again on this one (default). */
  restart?: boolean;
  /** Where the app goes: ~/Applications unless told otherwise. */
  appDir: string;
}

export const defaultAppDir = (): string => join(homedir(), 'Applications');

/** Version and Forchetta folder of an app built by build-app.sh, from its Info.plist; undefined when there is none. */
export function installedApp(app: string): { version?: string; root?: string } | undefined {
  const plist = join(app, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return undefined;
  const text = readFileSync(plist, 'utf8');
  const value = (key: string): string | undefined => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1];
  return { version: value('CFBundleShortVersionString'), root: value('ForchettaRoot') };
}

/** Whether the app must be built: missing, of another version, or running another Forchetta folder. */
export function needsBuild(installed: { version?: string; root?: string } | undefined, version: string, root: string, force: boolean): boolean {
  return force || !installed || installed.version !== version || installed.root !== root;
}

/** The Swift compiler of the Command Line Tools (or of Xcode), asked without opening the dialog that installs them. */
function swiftCompiler(): string | undefined {
  if (spawnSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' }).status !== 0) return undefined;
  const found = spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() || 'swiftc' : undefined;
}

/** A command that does not block the event loop, so that the spinner turns meanwhile. */
function run(command: string, args: string[], options: SpawnOptions): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output: (stderr || stdout).trim() }));
  });
}

/** Builds the app in the private folder, then puts it in place of the old one in a single rename. */
async function buildApp(target: string): Promise<void> {
  ensurePrivateDir(paths.tmpDir);
  const work = join(paths.tmpDir, `setup-${process.pid}`);
  const staging = join(work, 'Forchetta.app');
  mkdirSync(work, { recursive: true });
  try {
    const built = await run('/bin/sh', [join(ROOT, 'scripts', 'build-app.sh'), staging], {
      env: { ...process.env, FORCHETTA_ROOT: ROOT, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` },
    });
    if (built.status !== 0) throw new UserError(`the app was not built:\n${built.output}`);
    mkdirSync(dirname(target), { recursive: true });
    const old = `${target}.old-${process.pid}`;
    if (existsSync(target)) renameSync(target, old);
    try {
      renameSync(staging, target);
    } catch (error) {
      // Another volume: a copy instead.
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      cpSync(staging, target, { recursive: true, verbatimSymlinks: true });
    }
    rmSync(old, { recursive: true, force: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const running = (app: string): boolean => spawnSync('/usr/bin/pgrep', ['-f', join(app, 'Contents', 'MacOS', 'Forchetta')], { stdio: 'ignore' }).status === 0;

/** A daemon of another version, or kept alive by macOS with old paths, starts again on this one. */
async function restartOldDaemon(io: RunIO): Promise<void> {
  const s = io.style;
  const keepalive = existsSync(launchAgentFile());
  const info = await runningDaemon();
  let version: string | undefined;
  if (info) {
    try {
      version = (await api<{ version: string }>(info, 'GET', '/api/health')).version;
    } catch {
      version = undefined;
    }
  }
  if (!keepalive && (!info || version === VERSION)) return;
  if (keepalive) {
    // Written again with the paths of this version: macOS stops the old daemon and starts the new one.
    if (info && version !== VERSION) {
      await api(info, 'POST', '/api/shutdown').catch(() => undefined);
      for (let attempt = 0; attempt < 30 && (await runningDaemon()); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const installed = installLaunchAgent(resolveTool('node', loadConfig()));
    io.stdout(installed.ok ? `${s.mark('✓', 'green', `Daemon kept alive by macOS, on ${VERSION}`)}\n` : `${s.mark('▲', 'amber', `The LaunchAgent was not loaded again: ${installed.error}`)}\n`);
    return;
  }
  await api(info!, 'POST', '/api/shutdown').catch(() => undefined);
  for (let attempt = 0; attempt < 30 && (await runningDaemon()); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  const started = await ensureDaemon(resolveTool('node', loadConfig()));
  io.stdout(
    started
      ? `${s.mark('✓', 'green', `Daemon started again on ${VERSION}`)} ${s.dim(`(it was ${version ?? 'older'}; the sessions go on)`)}\n`
      : `${s.mark('▲', 'amber', 'The old daemon stopped; open the app to start the new one')}\n`,
  );
}

export async function setupCommand(options: SetupOptions, io: RunIO): Promise<number> {
  const s = io.style;
  if (process.platform !== 'darwin') throw new UserError('Forchetta works only on macOS');
  if (!existsSync(paths.daemonJs) || !existsSync(join(ROOT, 'dist', 'ui', 'index.html'))) throw new UserError(`${tildify(join(ROOT, 'dist'))} is missing`, 'run `pnpm build` first');
  const width = 18;
  /** One step: "✓ tmux              /usr/local/bin/tmux". Without a symbol it lines up with the others. */
  const step = (label: string, detail: string, mark?: '✓' | '▲'): void => {
    const text = `${label.padEnd(width)}  ${detail}`;
    io.stdout(`${mark ? s.mark(mark, mark === '✓' ? 'green' : 'amber', text) : `${s.color ? '  ' : ''}${text}`}\n`);
  };

  const tmux = which('tmux');
  if (!tmux) throw new UserError('tmux is missing', 'install it with `brew install tmux`, then run `forchetta setup` again');
  step('tmux', s.dim(tildify(tmux)), '✓');
  const claude = which('claude');
  if (claude) step('claude', s.dim(tildify(claude)), '✓');
  else step('claude', code('not in the PATH: Forchetta finds it once you install Claude Code (then run `forchetta setup` again)', s), '▲');
  const swiftc = swiftCompiler();
  if (!swiftc) throw new UserError('building the app needs the Xcode Command Line Tools', 'install them with `xcode-select --install`, then run `forchetta setup` again');
  step('Swift compiler', s.dim(tildify(swiftc)), '✓');

  const app = join(options.appDir, 'Forchetta.app');
  if (needsBuild(installedApp(app), VERSION, ROOT, options.force)) {
    const spin = spinner(`Building the app ${s.dim('(about 10 seconds)')}…`, s, io.stdout, Boolean(process.stdout.isTTY));
    try {
      await buildApp(app);
    } finally {
      spin.stop();
    }
    step('App installed', `${tildify(app)} ${s.dim(VERSION)}`, '✓');
    if (running(app)) step('', 'Forchetta is open with the previous version: quit it (⌘Q) and open it again', '▲');
  } else {
    step('App up to date', `${tildify(app)} ${s.dim(VERSION)}`, '✓');
  }
  step('Data', s.dim(tildify(paths.varDir)));
  io.stdout('\n');

  const status = await hooksCommand('install', { yes: options.yes, diff: options.diff }, io);
  if (status !== 0 && status !== NOT_APPLIED) return status;
  // After an upgrade the daemon that runs is the old one: it starts again on this version (the sessions go on).
  if (options.restart !== false) await restartOldDaemon(io);
  // Not ready: the hooks are not all there.
  if (status !== 0) return status;
  io.stdout(
    `\n${s.mark('✓', 'green', s.bold('Ready.'))} Open the app with:\n\n    ${s.claude(`open ${JSON.stringify(app)}`)}\n\n` +
      `${code('Sessions started with `forchetta run claude`, or from the app, also open in its terminals.', s)}\n`,
  );
  return 0;
}
