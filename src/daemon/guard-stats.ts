import { readFileSync } from 'node:fs';
import { writeDataJson } from '../shared/data-file.ts';
import { dayOf, type GuardCounts, type GuardStatKind, type GuardStatsInfo } from '../shared/guard-stats.ts';

// What the guard did, by day (shared/guard-stats.ts): kept in var/guard-stats.json, on this Mac only. Nothing of a
// session goes in: no file, no command, no name; only how many times each kind happened on a day. Written a little
// after a count, so a burst of them is one write.

/** The days kept: older ones go. */
export const KEPT_DAYS = 120;
const SAVE_DELAY_MS = 2_000;

interface Saved {
  version: 1;
  days: Record<string, GuardCounts>;
}

export class GuardStats {
  private days: Record<string, GuardCounts> = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(
    private readonly file: string | undefined,
    private readonly options: { now?: () => number; onChange?: () => void; log?: (message: string, level?: 'info' | 'warn' | 'error') => void } = {},
  ) {
    this.now = options.now ?? Date.now;
    if (!file) return;
    this.days = readStats(file) ?? {};
  }

  count(kind: GuardStatKind, n = 1): void {
    if (n <= 0) return;
    const day = dayOf(this.now());
    const counts = (this.days[day] ??= {});
    counts[kind] = (counts[kind] ?? 0) + n;
    this.prune();
    this.saveSoon();
    this.options.onChange?.();
  }

  /** The counts of the last `days` days, today included, and of today. */
  info(days = 7): GuardStatsInfo {
    return statsOver(this.days, days, this.now());
  }

  /** Writes what is pending now: at the end of the daemon. */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.save();
  }

  private prune(): void {
    const keys = Object.keys(this.days).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - KEPT_DAYS))) delete this.days[key];
  }

  private saveSoon(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  private save(): void {
    if (!this.file) return;
    try {
      const saved: Saved = { version: 1, days: this.days };
      writeDataJson(this.file, saved, false);
    } catch (error) {
      this.options.log?.(`guard counts not saved: ${String(error)}`, 'warn');
    }
  }
}

/** The days of the file, or undefined when it is missing or cannot be read. */
export function readStats(file: string): Record<string, GuardCounts> | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>;
    const days: Record<string, GuardCounts> = {};
    for (const [day, counts] of Object.entries(raw.days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !counts || typeof counts !== 'object') continue;
      const clean: GuardCounts = {};
      for (const [kind, value] of Object.entries(counts)) if (typeof value === 'number' && Number.isFinite(value) && value > 0) clean[kind as GuardStatKind] = Math.round(value);
      days[day] = clean;
    }
    return days;
  } catch {
    return undefined;
  }
}

/** The counts of the last `days` days up to `now`, today included. */
export function statsOver(byDay: Record<string, GuardCounts>, days: number, now: number): GuardStatsInfo {
  const span = Math.max(1, Math.round(days));
  const wanted = new Set<string>();
  // Day by day back from today, at noon: a change of daylight saving time does not skip or repeat a day.
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);
  for (let i = 0; i < span; i++) wanted.add(dayOf(noon.getTime() - i * 86_400_000));
  const counts: GuardCounts = {};
  for (const [day, dayCounts] of Object.entries(byDay)) {
    if (!wanted.has(day)) continue;
    for (const [kind, value] of Object.entries(dayCounts)) counts[kind as GuardStatKind] = (counts[kind as GuardStatKind] ?? 0) + (value ?? 0);
  }
  // "Counted since" only when the counts started within these days: a week of history needs no date.
  const oldest = [...wanted].sort()[0]!;
  const earliest = Object.keys(byDay).sort()[0];
  return { days: span, counts, today: { ...(byDay[dayOf(now)] ?? {}) }, ...(earliest && earliest > oldest ? { since: earliest } : {}) };
}
