import { api, apiAnswer, type DaemonInfo, runningDaemon } from '../shared/daemon-client.ts';
import { UserError } from '../shared/errors.ts';
import { usdText } from '../shared/present.ts';
import type { AutoLine } from '../daemon/cli-api.ts';
import { parseArgs } from './args.ts';
import { closest } from './help.ts';
import type { RunIO } from './run.ts';
import { tildify } from './style.ts';

// `forchetta auto`: the teams that start by themselves (made in the app, panel "auto"), from the command line. ls
// says where each one stands; add puts items in a queue (or starts a run of a schedule now, or looks at GitHub now);
// pause and resume. A script, a git hook or cron can feed a queue: `forchetta auto add fixes APP-42 APP-43`.

export const AUTO_ACTIONS = ['ls', 'add', 'pause', 'resume'] as const;

async function daemon(): Promise<DaemonInfo> {
  const info = await runningDaemon();
  if (!info) throw new UserError('the Forchetta daemon is not running', 'start it with `forchetta daemon start`, or open the app');
  try {
    await api(info, 'GET', '/api/auto');
  } catch {
    throw new UserError('the daemon that runs is older than this command', 'restart it: `forchetta daemon stop && forchetta daemon start` (the sessions go on)');
  }
  return info;
}

const when = (at: number, now: number): string => {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay ? `today ${time}` : `${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
};

/** The lines of `forchetta auto ls`. */
export function renderAutos(lines: readonly AutoLine[], io: Pick<RunIO, 'style'>, now = Date.now()): string {
  const s = io.style;
  if (lines.length === 0) return `${s.dim('No automation yet: make one in the app, "+ new" → "automatic team".')}\n`;
  const out: string[] = [];
  for (const line of lines) {
    out.push(`${s.bold(line.name)}  ${s.dim(`${line.template} in ${tildify(line.cwd)} · ${line.starts}`)}`);
    if (line.paused) out.push(`  ${s.mark('‖', 'amber', `paused: ${line.paused}`)}`);
    if (line.running) {
      const minutes = line.running.startedAt ? Math.max(0, Math.round((now - line.running.startedAt) / 60_000)) : undefined;
      const parts = [minutes !== undefined ? `${minutes} min` : '', line.running.usd ? `≈ ${usdText(line.running.usd)}` : ''].filter(Boolean).join(', ');
      out.push(`  ${s.mark('▶', 'claude', `at work: ${line.running.label}${parts ? ` (${parts})` : ''}${line.running.team ? s.dim(` · team "${line.running.team}"`) : ''}`)}`);
    }
    if (line.waiting > 0) out.push(`  ${s.dim('·')} ${line.waiting} waiting${line.wait ? s.dim(` · ${line.wait}`) : ''}`);
    if (line.nextAt && !line.paused) out.push(`  ${s.dim('·')} next run ${when(line.nextAt, now)}`);
    if (line.github?.error) out.push(`  ${s.mark('▲', 'amber', `GitHub: ${line.github.error}`)}`);
    if (line.last) {
      const mark = line.last.status === 'done' ? s.mark('✓', 'green', '') : line.last.status === 'failed' ? s.mark('✗', 'red', '') : s.mark('○', 'gray', '');
      const detail = [line.last.where ?? line.last.note ?? '', line.last.usd ? `≈ ${usdText(line.last.usd)}` : '', line.last.endedAt ? when(line.last.endedAt, now) : ''].filter(Boolean).join(' · ');
      out.push(`  ${mark}${s.dim('last:')} ${line.last.label}${detail ? s.dim(` · ${detail}`) : ''}`);
    }
  }
  return `${out.join('\n')}\n`;
}

async function listAutos(args: readonly string[], io: RunIO): Promise<number> {
  const { flags } = parseArgs('auto ls', args, { flags: ['--json'] });
  const info = await daemon();
  const answer = await apiAnswer<{ ok: true; automations: AutoLine[] } | { ok: false; error: string }>(info, 'GET', '/api/auto');
  if (!answer.ok) throw new UserError(answer.error);
  if (flags.has('--json')) io.stdout(`${JSON.stringify(answer.automations, null, 2)}\n`);
  else io.stdout(renderAutos(answer.automations, io));
  return 0;
}

async function changeAuto(action: 'add' | 'pause' | 'resume', args: readonly string[], io: RunIO): Promise<number> {
  const { positional } = parseArgs(`auto ${action}`, args, {});
  const [name, ...items] = positional;
  if (!name) throw new UserError('say which automation', 'see `forchetta auto ls`');
  if (action !== 'add' && items.length > 0) throw new UserError(`auto ${action} takes one automation: put its name in quotes`);
  const info = await daemon();
  const answer = await apiAnswer<{ ok: true; name: string; kind: AutoLine['kind']; added?: number } | { ok: false; error: string }>(info, 'POST', `/api/auto/${action}`, { name, items });
  if (!answer.ok) throw new UserError(answer.error, /no automation/.test(answer.error) ? 'see `forchetta auto ls`' : undefined);
  const s = io.style;
  const text =
    action === 'pause'
      ? `${answer.name} is paused: the run at work goes on, nothing new starts.`
      : action === 'resume'
        ? `${answer.name} goes on.`
        : answer.kind === 'github'
          ? `${answer.name} looks at GitHub now.`
          : answer.kind === 'schedule'
            ? `A run of ${answer.name} is in the queue, now.`
            : `${answer.added ?? 0} ${answer.added === 1 ? 'item' : 'items'} in the queue of ${answer.name}.`;
  io.stdout(`${s.mark('✓', 'green', text)}\n`);
  return 0;
}

export async function autoCommand(args: readonly string[], io: RunIO): Promise<number> {
  const [action, ...rest] = args;
  switch (action) {
    case 'ls':
    case undefined:
      return listAutos(rest, io);
    case 'add':
    case 'pause':
    case 'resume':
      return changeAuto(action, rest, io);
    default: {
      const near = closest(action, AUTO_ACTIONS);
      throw new UserError(`unknown action "${action}" for auto`, near ? `did you mean \`forchetta auto ${near}\`?` : 'see `forchetta auto --help`');
    }
  }
}
