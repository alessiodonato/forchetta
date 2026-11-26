import { WINDOWS } from '../shared/fspath.ts';
import { type Platform, PLATFORM } from '../shared/platform.ts';

// The environment of a Forchetta pane: the one of the terminal where `forchetta run` was typed, not the one of
// the tmux server, which may have been started from another terminal long ago. bin/forchetta-exec loads it.

/** What tmux sets for the pane itself: it must win over the terminal outside. */
const SET_BY_TMUX = new Set(['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TMUX', 'TMUX_PANE']);

/** The identity of the outer terminal window: inside tmux it would point to the wrong place. */
const OUTER_TERMINAL = new Set(['TERM_SESSION_ID', 'ITERM_SESSION_ID', 'WINDOWID', 'WT_SESSION', 'WT_PROFILE_ID']);

/**
 * What a running Claude Code session sets for its own child processes. A new session started from inside
 * one (from its shell, for example) must not inherit them.
 */
const SET_BY_CLAUDE = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
]);

/** The key for the optional summaries is for the daemon only: a Claude session has no use for it. */
const FORCHETTA_ONLY = new Set(['FORCHETTA_ANTHROPIC_API_KEY', 'FORCHETTA_AGENT', 'FORCHETTA_PANE']);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Windows has names like ProgramFiles(x86), and hidden ones that start with =. */
const WINDOWS_NAME = /^[^=\0]+$/;

/**
 * A locale in UTF-8, when there is none: an app opened from the Finder has no LANG, and neither has what it starts.
 * Without one, pbcopy takes its text for Mac Roman: "perché" in the clipboard becomes "perch√©". Linux may have no
 * en_US.UTF-8, and a LANG it does not have is no UTF-8 at all: there it is C.UTF-8. Windows has no LANG to give.
 */
export function withUtf8<T extends NodeJS.ProcessEnv>(env: T, platform: Platform | undefined = PLATFORM): T {
  if (platform === 'windows') return env;
  if (!/UTF-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) (env as NodeJS.ProcessEnv).LANG = platform === 'macos' ? 'en_US.UTF-8' : 'C.UTF-8';
  return env;
}

export function paneEnv(env: NodeJS.ProcessEnv, agentId: string, windows = WINDOWS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !(windows ? WINDOWS_NAME : NAME).test(name)) continue;
    if (SET_BY_TMUX.has(name) || OUTER_TERMINAL.has(name) || SET_BY_CLAUDE.has(name) || FORCHETTA_ONLY.has(name)) continue;
    out[name] = value;
  }
  out.FORCHETTA_AGENT = agentId;
  return withUtf8(out, windows ? 'windows' : PLATFORM);
}

/** The environment of a session in its host (Windows): the one of a pane, and the terminal it is. */
export const hostEnv = (env: Readonly<Record<string, string>>, session: string): Record<string, string> => ({ ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCHETTA_PANE: session });

/**
 * The environment of the daemon: the one of whoever started it, without what belongs to a Claude session or to
 * a tmux pane. Started with `forchetta daemon start` from the shell of a session, the daemon would otherwise keep
 * CLAUDECODE, CLAUDE_PID, TMUX_PANE and the rest, and the tmux server and the sessions it starts would get them.
 * The key of the summaries stays: it is for the daemon.
 */
export function daemonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (name === 'TMUX' || name === 'TMUX_PANE' || name === 'FORCHETTA_AGENT' || name === 'FORCHETTA_PANE' || SET_BY_CLAUDE.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/** The variables as `export NAME='value'` lines for sh, with single quotes escaped. */
export function envFileText(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([name]) => NAME.test(name))
    .map(([name, value]) => `export ${name}='${value.replace(/'/g, `'\\''`)}'`)
    .join('\n')
    .concat('\n');
}
