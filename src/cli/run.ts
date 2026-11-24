import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fromOutside, join, WINDOWS } from '../shared/fspath.ts';
import { loadConfig, resolveTool } from '../shared/config.ts';
import { TEMPLATE_TOOLS, TEMPLATE_TOOLS_ALLOWED } from '../shared/crew.ts';
import { api, ensureDaemon } from '../shared/daemon-client.ts';
import { UserError } from '../shared/errors.ts';
import { mcpConfigFile, writeMcpConfig } from '../shared/mcp-config.ts';
import { ensurePrivateDir, paths } from '../shared/paths.ts';
import { HostSessions } from '../shared/host-sessions.ts';
import { Tmux, tmuxSessionName } from '../shared/tmux.ts';
import { attachHere } from './attach.ts';
import { envFileText, hostEnv, paneEnv } from './pane-env.ts';
import type { Style } from './style.ts';

// `forchetta run claude [args]`: starts Claude Code in a session of the private tmux server and attaches this
// terminal to it, so it looks and works like `claude`. Detaching (Ctrl-b d) or closing the window leaves the
// session running: Forchetta keeps showing it, and /exit ends it as usual. On Windows the host of the session does what
// tmux does (shared/host-sessions.ts).

export interface RunIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** How to paint what goes to stdout, and to stderr: with colors only on a terminal. */
  style: Style;
  errorStyle: Style;
}

/** The environment of the tmux client: without TMUX, so that it works inside another tmux too. */
function clientEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

/**
 * Whether the session gets the tools of templates (mcp/team.ts): their options go first, and the next option of
 * claude or "--" closes them, since they take several values. So only when claude starts with an option or with
 * nothing: a first word may be a subcommand (`claude mcp list`), which refuses them, or a prompt, which
 * --allowedTools would take for one more tool.
 */
export const takesTemplateTools = (claudeArgs: readonly string[]): boolean => claudeArgs.length === 0 || claudeArgs[0]!.startsWith('-');

/** The options of claude for the tools of templates: their MCP configuration, and reading allowed without asking. */
export const templateToolArgs = (configFile: string): string[] => ['--mcp-config', configFile, '--allowedTools', TEMPLATE_TOOLS_ALLOWED];

export async function runClaude(args: string[], io: RunIO): Promise<number> {
  if (args[0] !== 'claude') {
    throw new UserError(
      args[0] ? `run starts claude, not ${args[0]}` : 'run needs the command to start: claude',
      'for example `forchetta run claude`, or `forchetta run claude --continue`',
    );
  }
  const config = loadConfig();
  const claude = resolveTool('claude', config);

  // Already inside a Forchetta session (from its shell, say): a nested tmux would only get in the way.
  if (process.env.FORCHETTA_AGENT) return spawnSync(claude, args.slice(1), { stdio: 'inherit' }).status ?? 1;

  const tmuxBin = WINDOWS ? '' : resolveTool('tmux', config);
  const tmux = new Tmux(tmuxBin, paths.tmuxSocket, paths.tmuxConf);
  ensurePrivateDir(paths.varDir);
  ensurePrivateDir(paths.runDir);

  const id = randomUUID();
  const session = tmuxSessionName(id);
  const cwd = fromOutside(process.cwd());

  let announced = false;
  try {
    const daemon = await ensureDaemon(resolveTool('node', config));
    if (daemon) {
      await api(daemon, 'POST', '/api/agents', { id, cwd, tmuxSession: session });
      announced = true;
    }
  } catch {
    // Claude starts anyway; its hooks announce it as soon as the daemon is there.
  }
  if (!announced) {
    const s = io.errorStyle;
    io.stderr(`${s.color ? s.amber('▲ ') : 'forchetta: '}the daemon does not answer. The session starts anyway, and shows up once the daemon runs.\n`);
  }

  const envFile = join(paths.runDir, `${id}.env`);
  if (!WINDOWS) writeFileSync(envFile, envFileText(paneEnv(process.env, id)), { mode: 0o600 });
  // The tools of templates, as for a session started from the app; the daemon takes the file away when it forgets
  // the session.
  const tools =
    takesTemplateTools(args.slice(1)) && existsSync(paths.teamMcpJs)
      ? templateToolArgs(writeMcpConfig({ command: resolveTool('node', config), args: [paths.teamMcpJs] }, id, TEMPLATE_TOOLS))
      : [];

  const columns = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  if (WINDOWS) {
    // Its host starts claude, with the environment of this terminal; then this terminal is a window on it.
    const sessions = new HostSessions({ node: resolveTool('node', config) });
    const started = await sessions.start({ session, agentId: id, file: claude, args: [...tools, ...args.slice(1)], cwd, env: hostEnv(paneEnv(process.env, id), session), cols: columns, rows });
    if ('error' in started) {
      rmSync(mcpConfigFile(id), { force: true });
      throw new UserError(`the session did not start: ${started.error}`, 'see `forchetta doctor`');
    }
    if (process.stdin.isTTY && process.stdout.isTTY) return attachHere(session, sessions);
    io.stdout(`${io.style.mark('✓', 'green', `Session started (${session}).`)} This is not a terminal, so it is not attached here: you see it in Forchetta.\n`);
    return 0;
  }
  const created = spawnSync(
    tmuxBin,
    tmux.argv('new-session', ['-d', '-s', session, '-c', cwd, '-x', String(columns), '-y', String(rows), '--', '/bin/sh', paths.execScript, envFile, '--', claude, ...tools, ...args.slice(1)]),
    { stdio: ['ignore', 'ignore', 'pipe'], env: clientEnv() },
  );
  if (created.status !== 0) {
    rmSync(envFile, { force: true });
    rmSync(mcpConfigFile(id), { force: true });
    throw new UserError(`tmux did not create the session: ${String(created.stderr).trim() || `code ${created.status}`}`);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    io.stdout(`${io.style.mark('✓', 'green', `Session started in tmux (${session}).`)} This is not a terminal, so it is not attached here: you see it in Forchetta.\n`);
    return 0;
  }
  const attached = spawnSync(tmuxBin, tmux.argv('attach-session', ['-t', session]), { stdio: 'inherit', env: clientEnv() });
  return attached.status ?? 0;
}
