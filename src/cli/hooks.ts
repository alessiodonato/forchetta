import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, homedir, join, WINDOWS } from '../shared/fspath.ts';
import { type Config, detectArricurdai, loadConfig, saveConfig, which } from '../shared/config.ts';
import { UserError } from '../shared/errors.ts';
import { hookTargets, statusTargets } from '../shared/hook-targets.ts';
import { claudeConfigDir, ensurePrivateDir, paths, stablePath } from '../shared/paths.ts';
import {
  formatSettings,
  isOurStatusLine,
  UnexpectedSettings,
  withForchettaHooks,
  type StatusLinePlan,
  withForchettaStatusLine,
  withoutForchettaHooks,
  withoutForchettaStatusLine,
} from '../shared/settings.ts';
import { code } from './help.ts';
import type { RunIO } from './run.ts';
import { windowsGit } from '../shared/windows.ts';
import { paintDiff, type Style, tildify } from './style.ts';

// `forchetta hooks install|uninstall`: the only commands that change a file outside the Forchetta folder,
// ~/.claude/settings.json. They show the diff, ask first, keep a copy of the old file in var/backups, and
// refuse when the file changed while they were asking. Besides the hooks they put bin/forchetta-statusline in
// front of your status line (see shared/settings.ts), and take it away.

export interface HooksOptions {
  /** Apply without asking. */
  yes: boolean;
  /** Show the whole diff before asking, not only the list of the changes. */
  diff: boolean;
}

/** On Windows the diff is that of git, when there is one: without it the list of the changes has to do. */
function gitDiff(a: string, b: string, label: string): string {
  const git = windowsGit();
  if (!git) return '(git is not installed: no diff to show)\n';
  const result = spawnSync(git, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', a, b], { encoding: 'utf8', windowsHide: true });
  const lines = result.stdout.split('\n');
  const from = lines.findIndex((line) => line.startsWith('@@'));
  return from < 0 ? '' : [`--- ${label} (now)`, `+++ ${label} (after)`, ...lines.slice(from)].join('\n');
}

/** A unified diff of two texts, from the diff of the system. */
export function unifiedDiff(before: string, after: string, label: string): string {
  ensurePrivateDir(paths.tmpDir);
  const a = join(paths.tmpDir, `diff-a-${process.pid}`);
  const b = join(paths.tmpDir, `diff-b-${process.pid}`);
  writeFileSync(a, before, { mode: 0o600 });
  writeFileSync(b, after, { mode: 0o600 });
  try {
    if (WINDOWS) return gitDiff(a, b, label);
    const result = spawnSync('/usr/bin/diff', ['-u', '--label', `${label} (now)`, '--label', `${label} (after)`, a, b], { encoding: 'utf8' });
    return result.stdout;
  } finally {
    rmSync(a, { force: true });
    rmSync(b, { force: true });
  }
}

/** The answer to a question on the terminal, trimmed and in lower case. */
export async function ask(question: string, choices: string, io: RunIO): Promise<string> {
  const s = io.style;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${s.color ? `${s.claude('?')} ` : ''}${question} ${s.dim(choices)} `)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/**
 * Whether to apply the changes: y applies them, anything else leaves the file as it is, and d shows the whole
 * diff (when it was not shown yet) and asks again.
 */
async function confirm(io: RunIO, showDiff: (() => void) | undefined): Promise<boolean> {
  const s = io.style;
  if (!process.stdin.isTTY) {
    io.stdout(`${s.mark('○', 'gray', 'No change: this is not an interactive terminal.')} ${code('To apply the changes without a question: `--yes`', s)}\n`);
    return false;
  }
  let pending = showDiff;
  for (;;) {
    const answer = await ask('Apply the changes?', pending ? '[y/N, d = see the whole diff]' : '[y/N]', io);
    if (pending && (answer === 'd' || answer === 'diff')) {
      io.stdout('\n');
      pending();
      pending = undefined;
      continue;
    }
    return /^(s|si|sì|y|yes)$/.test(answer);
  }
}

/** Writes the file in one step, through a symbolic link if there is one, with the permissions of the old file. */
function writeSettings(file: string, text: string): string | undefined {
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(dirname(target), { recursive: true });
  let backup: string | undefined;
  if (existsSync(target)) {
    ensurePrivateDir(paths.backups);
    backup = join(paths.backups, `settings.json.${new Date().toISOString().replace(/[:.]/g, '-')}`);
    copyFileSync(target, backup);
    chmodSync(backup, 0o600);
  }
  const temporary = `${target}.forchetta-${process.pid}`;
  writeFileSync(temporary, text);
  if (existsSync(target)) chmodSync(temporary, statSync(target).mode & 0o777);
  renameSync(temporary, target);
  return backup;
}

/** The full paths of the tools, and the command of arricurdAI, for an app opened from the Finder with a short PATH. */
function withToolPaths(config: Config, settingsText: string | undefined): Config {
  return {
    ...config,
    paths: {
      // node of Homebrew lives in a folder per version: its opt path survives `brew upgrade node`.
      node: stablePath(config.paths.node ?? process.execPath),
      // No tmux on Windows: each session has a host of its own.
      ...(WINDOWS ? {} : { tmux: config.paths.tmux ?? which('tmux') }),
      claude: config.paths.claude ?? which('claude'),
    },
    arricurdai: config.arricurdai ?? detectArricurdai(settingsText),
  };
}

export async function hooksCommand(action: 'install' | 'uninstall', options: HooksOptions, io: RunIO): Promise<number> {
  const file = join(claudeConfigDir(), 'settings.json');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  let settings: unknown;
  try {
    settings = before === undefined || before.trim() === '' ? {} : JSON.parse(before);
  } catch {
    throw new UserError(`${tildify(file)} is not valid JSON: left as it is`, 'fix it and try again');
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new UserError(`${tildify(file)} is not a JSON object: left as it is`);

  const config = withToolPaths(loadConfig(), before);
  if (action === 'install') saveConfig(config);

  let plan: { settings: Record<string, unknown>; changes: string[] };
  /** The status line command to keep in var/statusline-command: a string to write, null to remove the file. */
  let saveCommand: string | null | undefined;
  try {
    if (action === 'install') {
      const hooks = withForchettaHooks(settings as Record<string, unknown>, hookTargets(config));
      const line = statusTargets(config);
      const status: StatusLinePlan = line ? withForchettaStatusLine(hooks.settings, line) : { settings: hooks.settings, changes: [] };
      if (!line) io.stdout(`${io.style.mark('▲', 'amber', 'The status line stays as it is: forchetta-statusline.cmd is not in the PATH of this terminal. Open a new one and run this again.')}\n`);
      plan = { settings: status.settings, changes: [...hooks.changes, ...status.changes] };
      // Only when the status line becomes ours now: a second install keeps the command saved the first time.
      if (status.changes.length > 0 && !isOurStatusLine(hooks.settings.statusLine)) saveCommand = status.original ?? null;
    } else {
      const saved = existsSync(paths.statusCommand) ? readFileSync(paths.statusCommand, 'utf8') : '';
      const hooks = withoutForchettaHooks(settings as Record<string, unknown>);
      const status = withoutForchettaStatusLine(hooks.settings, saved.trim() ? saved : undefined);
      plan = { settings: status.settings, changes: [...hooks.changes, ...status.changes] };
      if (status.changes.length > 0) saveCommand = null;
    }
  } catch (error) {
    if (error instanceof UnexpectedSettings) throw new UserError(`${tildify(file)} left as it is: ${error.message}`);
    throw error;
  }

  const s = io.style;
  const shown = tildify(file);
  if (plan.changes.length === 0) {
    io.stdout(`${s.mark('✓', 'green', action === 'install' ? `The hooks of Forchetta are already in ${shown}.` : `No hook of Forchetta in ${shown}.`)}\n`);
    return 0;
  }

  const after = formatSettings(plan.settings);
  io.stdout(`${s.bold(`${action === 'install' ? 'Adding' : 'Removing'} these hooks in ${shown}`)}\n\n${plan.changes.map((line) => `  ${paintChange(line, s)}`).join('\n')}\n\n`);
  if (before !== undefined && formatSettings(settings as Record<string, unknown>) !== before) {
    io.stdout(`${s.dim('Note: the file will be written again with an indent of two spaces, as Claude Code writes it; the diff shows it.')}\n\n`);
  }
  // The list above says every change; the whole diff, with all the JSON, only when asked (--diff, or d).
  const showDiff = (): void => io.stdout(`${s.bold('The whole diff')}\n\n${paintDiff(unifiedDiff(before ?? '', after, shown), s)}\n`);
  if (options.diff) showDiff();

  if (!options.yes && !(await confirm(io, options.diff ? undefined : showDiff))) {
    if (process.stdin.isTTY) io.stdout(`${s.mark('○', 'gray', 'No change.')}\n`);
    return 0;
  }
  const now = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (now !== before) throw new UserError(`${shown} changed meanwhile: left as it is`, 'run the command again');

  // The command you had goes in place before the status line that runs it.
  if (typeof saveCommand === 'string') {
    ensurePrivateDir(paths.varDir);
    writeFileSync(paths.statusCommand, saveCommand, { mode: 0o600 });
  }
  const backup = writeSettings(file, after);
  if (saveCommand === null) rmSync(paths.statusCommand, { force: true });
  io.stdout(
    `${s.mark('✓', 'green', `Done.${backup ? ` ${s.dim(`Copy of the previous file: ${tildify(backup)}`)}` : ''}`)}\n` +
      (action === 'install'
        ? `${s.dim('Claude Code reads the hooks again by itself: they work for the sessions already open too.')}\n${code('To remove them: `forchetta hooks uninstall`', s)}\n`
        : ''),
  );
  return 0;
}

/**
 * "+ PreToolUse: command ~/Forchetta/bin/forchetta-hook 47821 (async)": the sign in green (+), red (-) or amber
 * (~), the event in bold, the rest dimmed, with ~ for the home folder.
 */
export function paintChange(line: string, style: Style, home = homedir()): string {
  const text = line.replaceAll(`${home}/`, '~/');
  const match = /^([+~-]) ([^:]+)(?:: (.*))?$/.exec(text);
  if (!match) return text;
  const [, sign, name, rest] = match;
  const paint = sign === '+' ? style.green : sign === '-' ? style.red : style.amber;
  return `${paint(sign!)} ${style.bold(name!)}${rest === undefined ? '' : `: ${style.dim(rest)}`}`;
}
