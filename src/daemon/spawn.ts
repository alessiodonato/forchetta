import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { envFileText, paneEnv } from '../cli/pane-env.ts';
import { ensurePrivateDir, paths } from '../shared/paths.ts';
import { type Tmux, tmuxSessionName } from '../shared/tmux.ts';
import type { Registry } from './registry.ts';
import { markEnded } from './state.ts';

// A new session started from the app: a folder and, if you want, a first prompt. It runs in the tmux of
// Forchetta as with `forchetta run claude`, through your login shell, so that it has the PATH and the
// variables of a new terminal tab (the daemon started by the app has the short ones of the Finder):
//
//   forchetta-exec <env file> -- <login shell> -l -i -c "exec forchetta-start <claude>"
//
// The first prompt goes in the private env file, never through tmux or a shell; forchetta-start hands it to
// claude as its argument. Every step execs the next one: the pid of the pane is the pid of claude.

export const MAX_PROMPT = 20_000;

/** The models the panel offers: aliases of Claude Code, valid for that session only (unlike /model). */
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
/** The permission modes the panel offers. bypassPermissions and dontAsk stay in the terminal. */
export const MODES = ['manual', 'acceptEdits', 'auto', 'plan'] as const;
const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export interface SpawnChoices {
  model?: unknown;
  mode?: unknown;
  /** true for a worktree with a name chosen by Claude Code, or the name. */
  worktree?: unknown;
}

/** The arguments of claude for the choices of the panel, or the reason one is not valid. */
export function claudeArgs(choices: SpawnChoices): { args: string[] } | { error: string } {
  const args: string[] = [];
  if (choices.model !== undefined && choices.model !== '') {
    if (!(MODELS as readonly unknown[]).includes(choices.model)) return { error: 'invalid model' };
    args.push('--model', String(choices.model));
  }
  if (choices.mode !== undefined && choices.mode !== '') {
    if (!(MODES as readonly unknown[]).includes(choices.mode)) return { error: 'invalid permission mode' };
    args.push('--permission-mode', String(choices.mode));
  }
  if (choices.worktree === true) args.push('--worktree');
  else if (typeof choices.worktree === 'string' && choices.worktree.trim()) {
    const name = choices.worktree.trim();
    if (!WORKTREE_NAME.test(name)) return { error: 'worktree name: letters, digits, ".", "_" and "-", 40 at most' };
    args.push('--worktree', name);
  }
  return { args };
}

export type SpawnResult = { ok: true; agentId: string } | { ok: false; error: string };

export interface SpawnOptions {
  tmux: Tmux;
  /** How long to watch the new pane: a claude that ends at once (a worktree in an untrusted folder) is reported. */
  watchMs?: number;
  registry: Registry;
  /** The full path of claude. */
  claude: string | undefined;
  env?: NodeJS.ProcessEnv;
  shell?: string;
  log: (message: string) => void;
}

/** A folder as typed: ~ for the home, and absolute. */
export function folderOf(input: string): string | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const expanded = text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text;
  return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

/** Whether a folder is inside a git working tree: .git in it or in a folder above. */
function inGitRepo(dir: string): boolean {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    if (dirname(current) === current) return false;
  }
}

/** A path inside single quotes, for any shell; undefined when it has a single quote itself. */
const quoted = (path: string): string | undefined => (path.includes("'") ? undefined : `'${path}'`);

/** The command of the pane: the login shell, then forchetta-start, then claude with its arguments. */
export function startCommand(shell: string, startScript: string, claude: string, args: readonly string[] = []): string[] | undefined {
  const start = quoted(startScript);
  const target = quoted(claude);
  // The arguments come from claudeArgs: fixed words and checked names, safe in single quotes.
  if (!start || !target || args.some((arg) => !/^[A-Za-z0-9._-]+$/.test(arg))) return undefined;
  return [shell, '-l', '-i', '-c', ['exec', start, target, ...args.map((arg) => `'${arg}'`)].join(' ')];
}

export async function spawnSession(options: SpawnOptions, input: { cwd: unknown; prompt?: unknown } & SpawnChoices): Promise<SpawnResult> {
  const { tmux, registry, claude, log } = options;
  if (!claude) return { ok: false, error: `claude not found: set its path in ${paths.config} (paths.claude)` };
  const cwd = typeof input.cwd === 'string' ? folderOf(input.cwd) : undefined;
  if (!cwd) return { ok: false, error: 'write a folder with its full path (~/… works too)' };
  try {
    if (!statSync(cwd).isDirectory()) return { ok: false, error: `${cwd} is not a folder` };
  } catch {
    return { ok: false, error: `the folder ${cwd} does not exist` };
  }
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (prompt.length > MAX_PROMPT) return { ok: false, error: `prompt too long (more than ${MAX_PROMPT} characters)` };
  const chosen = claudeArgs(input);
  if ('error' in chosen) return { ok: false, error: chosen.error };
  if (input.worktree && !inGitRepo(cwd)) return { ok: false, error: 'for a worktree the folder must be in a git repository' };
  const shell = options.shell ?? (userInfo().shell || '/bin/zsh');
  const command = startCommand(shell, paths.startScript, claude, chosen.args);
  if (!command) return { ok: false, error: 'the path of Forchetta or of claude contains a quote: the session cannot start from here' };

  const id = randomUUID();
  const session = tmuxSessionName(id);
  ensurePrivateDir(paths.runDir);
  const envFile = join(paths.runDir, `${id}.env`);
  const env = paneEnv(options.env ?? process.env, id);
  if (prompt) env.FORCHETTA_PROMPT = prompt;
  writeFileSync(envFile, envFileText(env), { mode: 0o600 });

  registry.register({ id, cwd, tmuxSession: session });
  const created = await tmux.run('new-session', ['-d', '-s', session, '-c', cwd, '-x', '200', '-y', '50', '--', '/bin/sh', paths.execScript, envFile, '--', ...command]);
  if (created.code !== 0) {
    rmSync(envFile, { force: true });
    log(`nuova sessione in ${cwd} non avviata: ${created.stderr.trim()}`);
    return { ok: false, error: `tmux did not create the session: ${created.stderr.trim() || `code ${created.code}`}` };
  }
  // claude can end at once, with code 0, and its pane with it: its message would be lost. Watch the pane until the
  // session says hello (SessionStart) or a few seconds pass; a folder never trusted shows its dialog first, and no
  // hook runs before it is answered: that is fine too.
  const watchMs = options.watchMs ?? 6000;
  for (let waited = 0; waited < watchMs; waited += 200) {
    if (registry.agents.get(id)?.sessionId) break;
    if ((await tmux.run('has-session', ['-t', session])).code !== 0) {
      log(`nuova sessione in ${cwd}: claude è uscito subito`);
      const agent = registry.agents.get(id);
      if (agent && agent.state !== 'ended') {
        markEnded(agent, 'exited at start', Date.now());
        registry.touch(agent);
      }
      return {
        ok: false,
        error: input.worktree
          ? 'Claude exited at once. For a worktree, Claude Code wants a folder you already trust: open it once without a worktree, accept the trust dialog and try again.'
          : 'Claude exited right after it started: open the folder with claude from the Terminal to see the message.',
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  log(`nuova sessione dall'app: ${basename(cwd)} (${session})${chosen.args.length ? ` ${chosen.args.join(' ')}` : ''}${prompt ? ', con un primo prompt' : ''}`);
  return { ok: true, agentId: id };
}
