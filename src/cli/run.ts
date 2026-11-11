import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveTool } from '../shared/config.ts';
import { api, ensureDaemon } from '../shared/daemon-client.ts';
import { UserError } from '../shared/errors.ts';
import { ensurePrivateDir, paths } from '../shared/paths.ts';
import { Tmux, tmuxSessionName } from '../shared/tmux.ts';
import { envFileText, paneEnv } from './pane-env.ts';
import type { Style } from './style.ts';

// `forchetta run claude [args]`: starts Claude Code in a session of the private tmux server and attaches this
// terminal to it, so it looks and works like `claude`. Detaching (Ctrl-b d) or closing the window leaves the
// session running: Forchetta keeps showing it, and /exit ends it as usual.

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

  const tmuxBin = resolveTool('tmux', config);
  const tmux = new Tmux(tmuxBin, paths.tmuxSocket, paths.tmuxConf);
  ensurePrivateDir(paths.varDir);
  ensurePrivateDir(paths.runDir);

  const id = randomUUID();
  const session = tmuxSessionName(id);
  const cwd = process.cwd();

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
  writeFileSync(envFile, envFileText(paneEnv(process.env, id)), { mode: 0o600 });

  const columns = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const created = spawnSync(
    tmuxBin,
    tmux.argv('new-session', ['-d', '-s', session, '-c', cwd, '-x', String(columns), '-y', String(rows), '--', '/bin/sh', paths.execScript, envFile, '--', claude, ...args.slice(1)]),
    { stdio: ['ignore', 'ignore', 'pipe'], env: clientEnv() },
  );
  if (created.status !== 0) {
    rmSync(envFile, { force: true });
    throw new UserError(`tmux did not create the session: ${String(created.stderr).trim() || `code ${created.status}`}`);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    io.stdout(`${io.style.mark('✓', 'green', `Session started in tmux (${session}).`)} This is not a terminal, so it is not attached here: you see it in Forchetta.\n`);
    return 0;
  }
  const attached = spawnSync(tmuxBin, tmux.argv('attach-session', ['-t', session]), { stdio: 'inherit', env: clientEnv() });
  return attached.status ?? 0;
}
