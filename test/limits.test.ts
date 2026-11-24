import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Limits, type RateLimits, rateLimitsOf, runsOutAt } from '../src/daemon/limits.ts';
import { Registry } from '../src/daemon/registry.ts';
import { createDaemonServer, STATUS_PATH } from '../src/daemon/server.ts';
import { limitParts, LIMITS_PACE_FRESH_MS } from '../src/shared/present.ts';
import { hooksAt, http, sleep, tempDir } from './helpers.ts';

// The limits of the Claude plan, from `rate_limits` of the status line: the share of the 5-hour and weekly windows,
// when they reset, and when the 5-hour one runs out at the pace of the last half hour.

/** `rate_limits` as Claude Code 2.1.322 gives it to the status line, with a Claude subscription (trimmed). */
const STATUS_INPUT = {
  session_id: '104f8710-a72c-4554-8825-485d1e746f45',
  version: '2.1.322',
  rate_limits: { five_hour: { used_percentage: 21, resets_at: 1794367800 }, seven_day: { used_percentage: 37, resets_at: 1794571200 } },
};

const input = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const MIN = 60_000;

describe('rate limits of the status line', () => {
  it('reads both windows, with the reset in milliseconds', () => {
    expect(rateLimitsOf(input(STATUS_INPUT))).toEqual({
      fiveHour: { percent: 21, resetsAt: 1794367800_000 },
      sevenDay: { percent: 37, resetsAt: 1794571200_000 },
    });
  });

  it('says nothing without a subscription, or with a window it cannot read', () => {
    expect(rateLimitsOf(input({ session_id: 'x' }))).toBeUndefined();
    expect(rateLimitsOf(input({ session_id: 'x', rate_limits: null }))).toBeUndefined();
    expect(rateLimitsOf(input({ rate_limits: { five_hour: { used_percentage: null, resets_at: 1 } } }))).toBeUndefined();
    expect(rateLimitsOf(Buffer.from('{not json'))).toBeUndefined();
  });

  it('keeps the window it can read when the other is missing, and takes an ISO date too', () => {
    expect(rateLimitsOf(input({ rate_limits: { seven_day: { used_percentage: 120, resets_at: '2026-11-21T09:00:00Z' } } }))).toEqual({
      sevenDay: { percent: 100, resetsAt: Date.parse('2026-11-21T09:00:00Z') },
    });
  });
});

describe('the status line route', () => {
  it('passes the limits of an input on, with the cost of its session', async () => {
    const taken: RateLimits[] = [];
    const registry = new Registry({});
    const server = createDaemonServer({ registry, token: 'c'.repeat(64), port: () => 0, log: () => {}, info: () => ({}), onShutdown: () => {}, onRateLimits: (limits) => taken.push(limits) });
    // The status line talks on the socket of the hooks, as bin/forchetta-statusline does.
    const temp = tempDir('limits');
    const socket = hooksAt(temp.dir);
    await new Promise<void>((resolve) => server.hooks.listen(socket, resolve));
    try {
      const body = JSON.stringify({ ...STATUS_INPUT, cost: { total_cost_usd: 0.5 } });
      const reply = await http(socket, { method: 'POST', path: STATUS_PATH, headers: { 'Content-Type': 'application/json' }, body });
      expect(reply.status).toBe(200);
      await sleep(20);
      expect(taken).toEqual([{ fiveHour: { percent: 21, resetsAt: 1794367800_000 }, sevenDay: { percent: 37, resetsAt: 1794571200_000 } }]);
    } finally {
      registry.dispose();
      await new Promise((resolve) => server.hooks.close(resolve));
      temp.cleanup();
    }
  });
});

describe('when the 5-hour window runs out', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const resetsAt = now + 3 * 60 * MIN;

  it('follows the pace of the last half hour', () => {
    // 40% half an hour ago, 55% now: 0.5 points a minute, 45 points left, 90 minutes.
    const samples = [
      { at: now - 30 * MIN, percent: 40 },
      { at: now, percent: 55 },
    ];
    expect(runsOutAt(samples, now, 55, resetsAt)).toBe(now + 90 * MIN);
  });

  it('says nothing when the window resets first, when it barely grew, or too soon', () => {
    const slow = [{ at: now - 30 * MIN, percent: 50 }];
    expect(runsOutAt(slow, now, 55, resetsAt)).toBeUndefined();
    expect(runsOutAt([{ at: now - 30 * MIN, percent: 54 }], now, 55, resetsAt)).toBeUndefined();
    expect(runsOutAt([{ at: now - 5 * MIN, percent: 40 }], now, 55, resetsAt)).toBeUndefined();
    expect(runsOutAt([{ at: now - 30 * MIN, percent: 40 }], now, 100, resetsAt)).toBeUndefined();
  });

  it('forgets the pace of the old window when a new one begins', () => {
    const limits = new Limits();
    limits.take({ fiveHour: { percent: 70, resetsAt } }, now - 20 * MIN);
    // 10 points in 10 minutes, 20 left: 20 minutes more.
    limits.take({ fiveHour: { percent: 80, resetsAt } }, now - 10 * MIN);
    expect(limits.info?.fiveHour?.runsOutAt).toBe(now + 10 * MIN);
    const next = limits.take({ fiveHour: { percent: 1, resetsAt: resetsAt + 5 * 60 * MIN } }, now);
    expect(next?.fiveHour).toEqual({ percent: 1, resetsAt: resetsAt + 5 * 60 * MIN });
  });

  it('tells the page only what changed, and at most once a minute while nothing does', () => {
    const limits = new Limits();
    const windows = { fiveHour: { percent: 21, resetsAt }, sevenDay: { percent: 37, resetsAt: resetsAt + 3 * 24 * 60 * MIN } };
    expect(limits.take(windows, now)).toMatchObject({ at: now, fiveHour: { percent: 21 } });
    expect(limits.take(windows, now + 10_000)).toBeUndefined();
    expect(limits.take(windows, now + 30_000)).toBeUndefined();
    expect(limits.take(windows, now + MIN)).toMatchObject({ at: now + MIN });
    expect(limits.take({ ...windows, fiveHour: { percent: 22, resetsAt } }, now + MIN + 1000)).toMatchObject({ fiveHour: { percent: 22 } });
  });
});

describe('the limits in the top line', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const resetsAt = now + 3 * 60 * MIN;
  const week = { percent: 31, resetsAt: now + 4 * 24 * 60 * MIN };

  it('shows the share of both windows', () => {
    const parts = limitParts({ at: now, fiveHour: { percent: 62, resetsAt }, sevenDay: week }, now);
    expect(parts.map(({ name, value, note, percent, level }) => ({ name, value, note, percent, level }))).toEqual([
      { name: '5h', value: '62%', note: undefined, percent: 62, level: 'calm' },
      { name: 'week', value: '31%', note: undefined, percent: 31, level: 'calm' },
    ]);
    expect(parts[0]?.title).toMatch(/^5-hour limit of your Claude plan: 62% used, it resets at /);
  });

  it('warns when at this pace the 5-hour window runs out before the reset', () => {
    const runsOutAt = now + 80 * MIN;
    const [five] = limitParts({ at: now, fiveHour: { percent: 62, resetsAt, runsOutAt } }, now);
    expect(five).toMatchObject({ name: '5h', value: '62%', percent: 62, level: 'warn' });
    expect(five?.note).toMatch(/^out ≈\d{1,2}:\d\d [AP]M$/);
    expect(five?.title).toContain('1 h 40 min before the reset');
  });

  it('drops the pace when no status line came for a while, and a window whose reset passed', () => {
    const old = { at: now - LIMITS_PACE_FRESH_MS - 1, fiveHour: { percent: 62, resetsAt, runsOutAt: now + 80 * MIN } };
    expect(limitParts(old, now).map(({ name, value, note }) => [name, value, note])).toEqual([['5h', '62%', undefined]]);
    expect(limitParts({ at: now, fiveHour: { percent: 62, resetsAt: now - 1 }, sevenDay: week }, now).map(({ name, value }) => `${name} ${value}`)).toEqual(['week 31%']);
    expect(limitParts(undefined, now)).toEqual([]);
  });

  it('says when a window is used up, and when it comes back', () => {
    const parts = limitParts({ at: now, fiveHour: { percent: 100, resetsAt }, sevenDay: { ...week, percent: 100 } }, now);
    expect(parts.map((part) => part.level)).toEqual(['out', 'out']);
    expect(parts.map(({ name, value, percent }) => [name, value, percent])).toEqual([
      ['5h', 'used up', 100],
      ['week', 'used up', 100],
    ]);
    expect(parts[0]?.note).toMatch(/^back \d/);
    expect(parts[1]?.note).toMatch(/^back [A-Z][a-z]{2} /);
  });
});
