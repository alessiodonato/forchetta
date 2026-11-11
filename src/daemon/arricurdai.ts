import { execFile } from 'node:child_process';
import type { SessionTodayInfo, TodayInfo } from '../shared/agent.ts';

// Context and prompt cache of the sessions, from `arricurdai status --json`. Forchetta does not compute them: it
// shows what arricurdAI says, so that the box and `arricurdai status` agree. One run reads the end of every
// recent transcript and costs about a third of a second of CPU, so the daemon runs it after the events that
// change it, every 30 s while a session works and someone looks, and otherwise rarely.

export interface ArricurdaiSession {
  sessionId: string;
  project?: string;
  model?: string;
  /** Tokens of the last request: what the next prompt sends again. */
  context: number;
  lastCallAt: number;
  cacheExpiresAt: number;
  cacheLive: boolean;
  guardWillStop: boolean;
  /** Its part of today, from an arricurdAI that gives it (sessions[].today). */
  today?: SessionTodayInfo;
}

const time = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** The part of today of one session, when arricurdAI gives it. */
function sessionToday(value: unknown): SessionTodayInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  const tokens = (entry.tokens ?? {}) as Record<string, unknown>;
  if (typeof entry.calls !== 'number') return undefined;
  return { calls: count(entry.calls), tokens: count(tokens.input) + count(tokens.cacheWrite) + count(tokens.cacheRead) + count(tokens.output), usd: count(entry.usd) };
}

/** The sessions of `arricurdai status --json`, keyed by session id. Lines it cannot read are left out. */
export function parseArricurdaiStatus(stdout: string): Map<string, ArricurdaiSession> {
  const data = JSON.parse(stdout) as { sessions?: unknown };
  if (!data || typeof data !== 'object' || !Array.isArray(data.sessions)) throw new Error('arricurdai status --json: manca "sessions"');
  const sessions = new Map<string, ArricurdaiSession>();
  for (const item of data.sessions as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const lastCallAt = time(entry.lastCallAt);
    const cacheExpiresAt = time(entry.cacheExpiresAt);
    if (typeof entry.sessionId !== 'string' || typeof entry.context !== 'number' || lastCallAt === undefined || cacheExpiresAt === undefined) continue;
    sessions.set(entry.sessionId, {
      sessionId: entry.sessionId,
      project: typeof entry.project === 'string' ? entry.project : undefined,
      model: typeof entry.model === 'string' ? entry.model : undefined,
      context: entry.context,
      lastCallAt,
      cacheExpiresAt,
      cacheLive: entry.cacheLive === true,
      guardWillStop: entry.guardWillStop === true,
      today: sessionToday(entry.today),
    });
  }
  return sessions;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** What every session cost since midnight, from the "today" of `arricurdai status --json`, if it has one. */
export function parseArricurdaiToday(stdout: string): TodayInfo | undefined {
  const data = JSON.parse(stdout) as { today?: unknown };
  const today = data?.today;
  if (!today || typeof today !== 'object') return undefined;
  const entry = today as Record<string, unknown>;
  const since = time(entry.since);
  if (since === undefined || typeof entry.usd !== 'number') return undefined;
  const tokens = (entry.tokens ?? {}) as Record<string, unknown>;
  return {
    since,
    calls: num(entry.calls),
    tokens: num(tokens.input) + num(tokens.cacheWrite) + num(tokens.cacheRead) + num(tokens.output),
    usd: num(entry.usd),
    unpricedCalls: num(entry.unpricedCalls),
  };
}

export function readArricurdaiStatus(command: readonly string[]): Promise<{ sessions: Map<string, ArricurdaiSession>; today?: TodayInfo }> {
  const [bin, ...prefix] = command;
  if (!bin) return Promise.reject(new Error('empty arricurdAI command'));
  return new Promise((resolve, reject) => {
    execFile(bin, [...prefix, 'status', '--json', '--hours', '24', '--limit', '200'], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const text = String(stdout);
        resolve({ sessions: parseArricurdaiStatus(text), today: parseArricurdaiToday(text) });
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

/**
 * When to read `arricurdai status` again: soon after the events that change context or cache, every 30 s while
 * a session works, every 10 minutes otherwise, and never while no window shows the boxes.
 */
export class ArricurdaiPoller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = 0;
  private running: Promise<void> | undefined;
  private lastRun = 0;
  private stopped = false;

  constructor(
    private readonly options: {
      run: () => Promise<void>;
      /** Whether a window shows the boxes now. */
      watched: () => boolean;
      /** Whether some session works now. */
      busy: () => boolean;
      now?: () => number;
      soonMs?: number;
      busyMs?: number;
      idleMs?: number;
    },
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Runs now, or waits for the run in progress. For `forchetta ls`, which asks for fresh numbers. */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.options
      .run()
      .catch(() => undefined)
      .finally(() => {
        this.running = undefined;
        this.lastRun = this.now;
        this.schedule();
      });
    return this.running;
  }

  /** An event that changes context or cache: a run in a few seconds, when someone looks. */
  soon(): void {
    if (!this.options.watched()) return;
    this.schedule(this.options.soonMs ?? 3000);
  }

  /** Plans the next run: the given delay, or the regular rhythm. */
  schedule(delayMs?: number): void {
    if (this.stopped) return;
    if (!this.options.watched()) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    const regular = this.options.busy() ? (this.options.busyMs ?? 30_000) : (this.options.idleMs ?? 10 * 60_000);
    const wait = delayMs ?? Math.max(0, this.lastRun + regular - this.now);
    const at = this.now + wait;
    // A run already planned earlier stays: it comes first.
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, wait);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

/**
 * The note of a session before /clear. Up to 0.4.0, arricurdAI gives the new session a note only after a /clear
 * that follows a prompt its guard stopped: there is no command to ask for it. 0.5.0 adds
 * `arricurdai handoff --prepare --transcript <path>` (docs/proposta-arricurdai.md); this uses it as soon as the
 * installed arricurdAI has it, and says so in the help of `handoff`.
 */
export class ArricurdaiNotes {
  private support: Promise<boolean> | undefined;

  constructor(private readonly command: readonly string[] | undefined) {}

  private run(args: string[]): Promise<string> {
    const [bin, ...prefix] = this.command ?? [];
    if (!bin) return Promise.reject(new Error('arricurdAI not found'));
    return new Promise((resolve, reject) => {
      const child = execFile(bin, [...prefix, ...args], { timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
      child.stdin?.end();
    });
  }

  supported(): Promise<boolean> {
    if (!this.command) return Promise.resolve(false);
    this.support ??= this.run(['handoff', '--help']).then(
      (help) => /--prepare\b/.test(help),
      () => false,
    );
    return this.support;
  }

  async prepare(transcriptPath: string): Promise<void> {
    await this.run(['handoff', '--prepare', '--transcript', transcriptPath]);
  }
}
