import { describe, expect, it } from 'vitest';
import { newAgent } from '../src/daemon/state.ts';
import { stalledFor, stallText } from '../src/shared/present.ts';

// A session "al lavoro" that gave no sign of life for N minutes.

const MIN = 60_000;
const base = (state: 'working' | 'compacting' | 'waiting' | 'idle', lastAt: number) => ({
  ...newAgent({ id: 'a', cwd: '/x/alpha', control: { kind: 'readonly', reason: 'fuori-tmux' } }, 0),
  state,
  lastEvent: { name: 'PreToolUse', at: lastAt },
});

describe('stall', () => {
  it('a session at work, quiet for N minutes or more', () => {
    expect(stalledFor(base('working', 0), 9 * MIN, 10 * MIN)).toBeUndefined();
    expect(stalledFor(base('working', 0), 10 * MIN, 10 * MIN)).toBe(10 * MIN);
    expect(stalledFor(base('compacting', 0), 12 * MIN, 10 * MIN)).toBe(12 * MIN);
  });

  it('never a session that waits for you or is idle: that is not a stall', () => {
    expect(stalledFor(base('waiting', 0), 60 * MIN, 10 * MIN)).toBeUndefined();
    expect(stalledFor(base('idle', 0), 60 * MIN, 10 * MIN)).toBeUndefined();
  });

  it('a cost that went up counts as a sign of life', () => {
    const agent = { ...base('working', 0), usage: { usd: 1, at: 5 * MIN } };
    expect(stalledFor(agent, 12 * MIN, 10 * MIN)).toBeUndefined();
    expect(stalledFor(agent, 15 * MIN, 10 * MIN)).toBe(10 * MIN);
  });

  it('says how long, and the tool in progress', () => {
    const agent = { ...base('working', 0), action: { tool: 'Bash', label: 'Bash npm test', family: 'shell' as const, at: 0 } };
    expect(stallText(agent, 12 * MIN)).toBe('nessun evento da 12 min · Bash npm test in corso');
    expect(stallText({ ...agent, action: undefined }, 12 * MIN)).toBe('nessun evento da 12 min');
  });
});
