import type { UsageLimits, UsageWindow } from '../shared/agent.ts';

// The limits of the Claude plan, from `rate_limits` of the status line: the share of the 5-hour window and of the
// weekly one used so far, and when each resets. Claude Code sends them only with a Claude subscription (not with an
// API key). They are the same for every session of the account, so the daemon keeps one copy: the last one said.
//
// It also keeps how the 5-hour share grew in the last half hour, to tell when it would reach 100% at that pace:
// with several sessions at work the window runs out sooner than you think, and a session that hits it stops.

/** How far back the pace looks, and the least time it needs to say anything. */
const PACE_SPAN_MS = 30 * 60_000;
const PACE_MIN_MS = 10 * 60_000;
/** The share is a whole number: under 2 points of growth the pace says nothing. */
const PACE_MIN_POINTS = 2;
/** A sample of the 5-hour share at least this often while the status line runs, and at every change. */
const SAMPLE_MS = 60_000;

export interface RateLimits {
  fiveHour?: { percent: number; resetsAt: number };
  sevenDay?: { percent: number; resetsAt: number };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** One window of `rate_limits`: `used_percentage` 0-100 and `resets_at` in seconds (or an ISO date). */
function windowOf(value: unknown): { percent: number; resetsAt: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const window = value as Record<string, unknown>;
  const used = window.used_percentage;
  if (!finite(used)) return undefined;
  const raw = window.resets_at;
  const resetsAt = finite(raw) ? (raw < 1e12 ? raw * 1000 : raw) : typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  return { percent: Math.min(100, Math.max(0, used)), resetsAt };
}

/** The windows of `rate_limits` in an input of the status line; undefined when it carries none. */
export function rateLimitsOf(body: Buffer): RateLimits | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const limits = (raw as { rate_limits?: unknown }).rate_limits;
  if (!limits || typeof limits !== 'object') return undefined;
  const fiveHour = windowOf((limits as Record<string, unknown>).five_hour);
  const sevenDay = windowOf((limits as Record<string, unknown>).seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  return { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }) };
}

/**
 * When the share reaches 100% at the pace of the samples of the last half hour; undefined when they are too few or
 * too close, when it barely grew, or when the window resets first.
 */
export function runsOutAt(samples: ReadonlyArray<{ at: number; percent: number }>, now: number, percent: number, resetsAt: number): number | undefined {
  if (percent >= 100) return undefined;
  const from = samples.find((sample) => sample.at >= now - PACE_SPAN_MS);
  if (!from || now - from.at < PACE_MIN_MS || percent - from.percent < PACE_MIN_POINTS) return undefined;
  const perMs = (percent - from.percent) / (now - from.at);
  const at = now + (100 - percent) / perMs;
  return at < resetsAt ? Math.round(at / 60_000) * 60_000 : undefined;
}

export class Limits {
  private samples: Array<{ at: number; percent: number }> = [];
  private windowResetsAt = 0;
  /** Worked out with each new sample only, so that the inputs in between change nothing. */
  private runsOut: number | undefined;
  private shares: Array<{ agentId: string; percent: number }> | undefined;
  /** What each session spent in this 5-hour window, from the cost of its status line: its last cost, and the sum. */
  private readonly spend = new Map<string, { last: number; spent: number }>();
  private current: UsageLimits | undefined;

  get info(): UsageLimits | undefined {
    return this.current;
  }

  /**
   * The cost of a session went up: the difference counts for this window. A session seen for the first time counts
   * from then (the daemon may have started in the middle of the window); a cost that went down is a new
   * conversation (/clear), which counts from zero.
   */
  private spent(agentId: string, usd: number): void {
    const entry = this.spend.get(agentId);
    if (!entry) {
      this.spend.set(agentId, { last: usd, spent: 0 });
      return;
    }
    entry.spent += usd >= entry.last ? usd - entry.last : usd;
    entry.last = usd;
  }

  /**
   * Takes the windows of one input of the status line. Returns what the page shows when it changed: a share, a
   * reset, or the pace (at most once a minute); undefined when nothing did, as for most inputs.
   */
  take(limits: RateLimits, now = Date.now(), session?: { agentId: string; usd: number }): UsageLimits | undefined {
    const five = limits.fiveHour;
    let sampled = false;
    if (five) {
      // A new 5-hour window: the pace of the old one, and what the sessions spent in it, say nothing about it.
      if (five.resetsAt !== this.windowResetsAt) {
        this.windowResetsAt = five.resetsAt;
        this.samples = [];
        for (const entry of this.spend.values()) entry.spent = 0;
      }
      if (session) this.spent(session.agentId, session.usd);
      const last = this.samples.at(-1);
      if (!last || last.percent !== five.percent || now - last.at >= SAMPLE_MS) {
        this.samples.push({ at: now, percent: five.percent });
        this.samples = this.samples.filter((sample) => sample.at >= now - PACE_SPAN_MS);
        this.runsOut = runsOutAt(this.samples, now, five.percent, five.resetsAt);
        this.shares = sharesOf(this.spend);
        sampled = true;
      }
    }
    const fiveHour: UsageWindow | undefined = five && {
      percent: Math.round(five.percent),
      resetsAt: five.resetsAt,
      ...withRunsOut(this.runsOut),
      ...(this.shares && { sessions: this.shares }),
    };
    const sevenDay: UsageWindow | undefined = limits.sevenDay && { percent: Math.round(limits.sevenDay.percent), resetsAt: limits.sevenDay.resetsAt };
    const next: UsageLimits = { at: now, ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }) };
    const before = this.current;
    this.current = next;
    const same = before !== undefined && JSON.stringify({ ...before, at: 0 }) === JSON.stringify({ ...next, at: 0 });
    // Unchanged: the page hears of it only with a new sample, so it knows the numbers are fresh.
    if (same && !sampled) return undefined;
    return next;
  }
}

const withRunsOut = (at: number | undefined): { runsOutAt?: number } => (at === undefined ? {} : { runsOutAt: at });

/** The share of each session in what they all spent, the most first: six at most; undefined when nothing was spent. */
export function sharesOf(spend: ReadonlyMap<string, { spent: number }>): Array<{ agentId: string; percent: number }> | undefined {
  const total = [...spend.values()].reduce((sum, entry) => sum + entry.spent, 0);
  if (total <= 0) return undefined;
  return [...spend]
    .filter(([, entry]) => entry.spent > 0)
    .sort((a, b) => b[1].spent - a[1].spent)
    .slice(0, 6)
    .map(([agentId, entry]) => ({ agentId, percent: Math.round((entry.spent / total) * 100) }));
}
