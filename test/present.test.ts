import { describe, expect, it } from 'vitest';
import { newAgent } from '../src/daemon/state.ts';
import type { Agent } from '../src/shared/agent.ts';
import { agoShort, cacheText, COMPLETED_MS, nextChange, percentText, shortTokens } from '../src/shared/present.ts';
import { springKeyframes, springProgress } from '../src/ui/spring.ts';

const T = 10_000_000;
const agent = (init: Partial<Agent>): Agent => ({ ...newAgent({ id: 'a', control: { kind: 'readonly', reason: 'fuori-tmux' } }, T), lastEvent: { name: 'Stop', at: T }, ...init });

describe('texts of the box', () => {
  it('counts the first minute in steps of 5 s', () => {
    expect(agoShort(3000)).toBe('now');
    expect(agoShort(14_999)).toBe('10 s');
    expect(agoShort(59_000)).toBe('55 s');
    expect(agoShort(61_000)).toBe('1 min');
  });

  it('counts the cache down', () => {
    expect(cacheText({ expiresAt: T + 42.5 * 60_000, live: true, guardWillStop: false }, T)).toBe('cache 42 min');
    expect(cacheText({ expiresAt: T + 43_000, live: true, guardWillStop: false }, T)).toBe('cache 45 s');
    expect(cacheText({ expiresAt: T - 1, live: false, guardWillStop: true }, T)).toBe('cache expired');
  });

  it('writes tokens and share as arricurdai does', () => {
    expect(shortTokens(812)).toBe('812');
    expect(shortTokens(357_310)).toBe('357k');
    expect(shortTokens(1_240_000)).toBe('1.2M');
    expect(percentText({ tokens: 1, window: 1, percent: 36, lastCallAt: 0, at: 0 })).toBe('≈36%');
  });
});

describe('nextChange', () => {
  it('wakes the page only when a text would change', () => {
    // 12 s after the last event the text is "10 s": it becomes "15 s" at 15 s.
    expect(nextChange(agent({}), T + 12_000)).toBe(T + 15_000);
    // After a minute, once a minute.
    expect(nextChange(agent({}), T + 125_000)).toBe(T + 180_000);
  });

  it('follows the cache countdown and the check of a finished turn', () => {
    const base = { lastEvent: { name: 'rilevata', at: T } };
    // 125 s left: "2 min" until 120 s left.
    expect(nextChange(agent({ ...base, cache: { expiresAt: T + 125_000, live: true, guardWillStop: false } }), T)).toBe(T + 5000 + 1);
    // 47 s left: "cache 50 s" until 45 s left.
    expect(nextChange(agent({ ...base, cache: { expiresAt: T + 47_000, live: true, guardWillStop: false } }), T)).toBe(T + 2000);
    expect(nextChange(agent({ ...base, completedAt: T - 1000 }), T)).toBe(T - 1000 + COMPLETED_MS);
    expect(nextChange(agent({ ...base }), T)).toBeUndefined();
  });

  it('agrees with the texts it schedules', () => {
    const cache = { expiresAt: T + 3_600_000, live: true, guardWillStop: false };
    let now = T;
    for (let step = 0; step < 200; step++) {
      const next = nextChange(agent({ lastEvent: { name: 'rilevata', at: T }, cache }), now);
      if (next === undefined) break;
      expect(cacheText(cache, next - 1)).not.toBe(cacheText(cache, next));
      now = next;
    }
  });
});

describe('spring', () => {
  it('goes from 0 to 1 with a little overshoot and settles', () => {
    const values = springProgress();
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(1);
    expect(Math.max(...values)).toBeLessThan(1.15);
    expect(values.length * (1000 / 60)).toBeLessThan(1500);
  });

  it('becomes at most 40 keyframes with growing offsets', () => {
    const { keyframes, duration } = springKeyframes((p) => ({ opacity: p }));
    expect(keyframes.length).toBeLessThanOrEqual(41);
    expect(keyframes[0]).toMatchObject({ opacity: 0, offset: 0 });
    expect(keyframes.at(-1)).toMatchObject({ opacity: 1, offset: 1 });
    for (let index = 1; index < keyframes.length; index++) expect(keyframes[index]!.offset).toBeGreaterThan(keyframes[index - 1]!.offset as number);
    expect(duration).toBeGreaterThan(200);
  });
});
