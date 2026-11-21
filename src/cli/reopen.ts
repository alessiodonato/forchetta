import { api, apiAnswer, type DaemonInfo, runningDaemon } from '../shared/daemon-client.ts';
import { UserError } from '../shared/errors.ts';
import { shortTokens } from '../shared/present.ts';
import { type LostSession, lostName } from '../shared/reopen.ts';
import { parseArgs } from './args.ts';
import type { RunIO } from './run.ts';
import { tildify } from './style.ts';

// `forchetta reopen`: the sessions that ended with the Mac, each on its conversation again, in Forchetta. Without
// arguments it lists them; with names (of the window, of a folder, of a team) it reopens those; --all, every one.

async function daemon(): Promise<DaemonInfo> {
  const info = await runningDaemon();
  if (!info) throw new UserError('the Forchetta daemon is not running', 'start it with `forchetta daemon start`, or open the app');
  try {
    await api(info, 'GET', '/api/reopen');
  } catch {
    throw new UserError('the daemon that runs is older than this command', 'restart it: `forchetta daemon stop && forchetta daemon start` (the sessions go on)');
  }
  return info;
}

/** The lines of `forchetta reopen`: what ended with the Mac, and how big its conversation is. */
export function renderLost(sessions: readonly LostSession[], io: Pick<RunIO, 'style'>): string {
  const s = io.style;
  if (sessions.length === 0) return `${s.dim('No session ended with the Mac is waiting to reopen.')}\n`;
  const width = Math.max(...sessions.map((one) => lostName(one).length));
  const lines = sessions.map((one) => {
    const team = one.team?.crew && one.team.group ? s.dim(` · team ${one.team.group}`) : '';
    const context = one.contextTokens ? s.dim(` · ${shortTokens(one.contextTokens)} of context`) : '';
    return `  ${s.bold(lostName(one).padEnd(width))}  ${s.dim(tildify(one.cwd))}${team}${context}`;
  });
  return `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} ended with the Mac:\n${lines.join('\n')}\n${s.dim('`forchetta reopen --all`, or `forchetta reopen <name>…`: each goes on with its conversation, in Forchetta.')}\n`;
}

export async function reopenCommand(args: readonly string[], io: RunIO): Promise<number> {
  const { positional, flags } = parseArgs('reopen', args, { flags: ['--all', '--json'] });
  const info = await daemon();
  const s = io.style;
  if (!flags.has('--all') && positional.length === 0) {
    const answer = await apiAnswer<{ ok: true; sessions: LostSession[] } | { ok: false; error: string }>(info, 'GET', '/api/reopen');
    if (!answer.ok) throw new UserError(answer.error);
    io.stdout(flags.has('--json') ? `${JSON.stringify(answer.sessions, null, 2)}\n` : renderLost(answer.sessions, io));
    return 0;
  }
  // Each session takes a few seconds to start.
  const answer = await apiAnswer<{ ok: true; reopened: { name: string }[]; failed: { name: string; error: string }[] } | { ok: false; error: string }>(
    info,
    'POST',
    '/api/reopen',
    flags.has('--all') ? { all: true } : { names: positional },
    600_000,
  );
  if (!answer.ok) throw new UserError(answer.error, /called so/.test(answer.error) ? 'see `forchetta reopen`' : undefined);
  if (flags.has('--json')) {
    io.stdout(`${JSON.stringify({ reopened: answer.reopened, failed: answer.failed }, null, 2)}\n`);
    return answer.failed.length > 0 ? 1 : 0;
  }
  for (const one of answer.reopened) io.stdout(`${s.mark('✓', 'green', `${one.name} reopened`)}\n`);
  for (const one of answer.failed) io.stdout(`${s.mark('✗', 'red', `${one.name}: ${one.error}`)}\n`);
  return answer.failed.length > 0 ? 1 : 0;
}
