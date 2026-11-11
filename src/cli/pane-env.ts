// The environment of a Forchetta pane: the one of the terminal where `forchetta run` was typed, not the one of
// the tmux server, which may have been started from another terminal long ago. bin/forchetta-exec loads it.

/** What tmux sets for the pane itself: it must win over the terminal outside. */
const SET_BY_TMUX = new Set(['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TMUX', 'TMUX_PANE']);

/** The identity of the outer terminal window: inside tmux it would point to the wrong place. */
const OUTER_TERMINAL = new Set(['TERM_SESSION_ID', 'ITERM_SESSION_ID', 'WINDOWID']);

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
const FORCHETTA_ONLY = new Set(['FORCHETTA_ANTHROPIC_API_KEY', 'FORCHETTA_AGENT']);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function paneEnv(env: NodeJS.ProcessEnv, agentId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !NAME.test(name)) continue;
    if (SET_BY_TMUX.has(name) || OUTER_TERMINAL.has(name) || SET_BY_CLAUDE.has(name) || FORCHETTA_ONLY.has(name)) continue;
    out[name] = value;
  }
  out.FORCHETTA_AGENT = agentId;
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
