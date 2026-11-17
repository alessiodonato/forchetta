import { UserError } from '../shared/errors.ts';
import { type GuardStatsInfo, shortSummary, statLines } from '../shared/guard-stats.ts';
import { paths } from '../shared/paths.ts';
import { readStats, statsOver } from '../daemon/guard-stats.ts';
import { code } from './help.ts';
import type { RunIO } from './run.ts';
import { tildify } from './style.ts';

// `forchetta stats`: what the guard did on this Mac in the last days, from var/guard-stats.json (written by the
// daemon a moment after each count). It works with the daemon off too.

export interface StatsOptions {
  days: number;
  json: boolean;
}

/** The days asked with --days: a whole number from 1 to 120. */
export function parseDays(value: string | undefined): number {
  if (value === undefined) throw new UserError('--days needs a number', 'for example `forchetta stats --days 30`');
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 120) throw new UserError(`--days takes a whole number from 1 to 120, not "${value}"`);
  return days;
}

/** The report, as the terminal shows it. */
export function statsText(info: GuardStatsInfo, io: Pick<RunIO, 'style'>): string {
  const s = io.style;
  const span = info.days === 1 ? 'today' : `the last ${info.days} days`;
  const lines = statLines(info.counts);
  if (lines.length === 0) {
    return `${s.mark('○', 'gray', `The guard did nothing in ${span}.`)}\n  ${s.dim('It counts what it stops, asks and tells, as soon as two sessions work in one folder.')}\n`;
  }
  const width = Math.max(...lines.map((line) => String(line.count).length));
  return [
    s.bold(`What the guard did in ${span}${info.since ? ` ${s.dim(`(counted since ${info.since})`)}` : ''}`),
    ...lines.map((line) => `  ${String(line.count).padStart(width)}  ${line.text}`),
    '',
    `  ${s.dim('Today:')} ${shortSummary(info.today)}.`,
    '',
  ].join('\n');
}

export function statsCommand(options: StatsOptions, io: RunIO, file = paths.guardStats, now = Date.now()): number {
  const days = readStats(file);
  const info = statsOver(days ?? {}, options.days, now);
  if (options.json) {
    io.stdout(`${JSON.stringify(info, null, 2)}\n`);
    return 0;
  }
  if (!days) {
    io.stdout(`${io.style.mark('○', 'gray', 'Nothing counted yet.')}\n  ${code(`The daemon writes ${tildify(file)} after the first thing the guard does.`, io.style)}\n`);
    return 0;
  }
  io.stdout(statsText(info, io));
  return 0;
}
