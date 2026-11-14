import { describe, expect, it } from 'vitest';
import { Limits, sharesOf } from '../src/daemon/limits.ts';
import { applyHook, newAgent } from '../src/daemon/state.ts';
import type { Agent } from '../src/shared/agent.ts';
import { cornerTime, errorLine, folderText, limitParts, restLine, resultAt } from '../src/shared/present.ts';
import { Store } from '../src/ui/store.ts';

// What a box says beyond its state: the line under the name, the time in its corner, the dot of a result not seen
// yet; and who spent the 5-hour window.

const MIN = 60_000;
const NOW = Date.parse('2026-11-14T12:00:00Z');

const agent = (state: Agent['state'], extra: Partial<Agent> = {}): Agent => ({
  ...newAgent({ id: 'a1', cwd: '/Users/me/Desktop/shop', control: { kind: 'tmux', session: 'fk-a1' }, state }, NOW - 60 * MIN),
  lastEvent: { name: 'Stop', at: NOW - 2 * MIN },
  ...extra,
});

describe('the line under the name', () => {
  it('does not say again what the state says', () => {
    expect(restLine(agent('idle', { completedAt: NOW - 12 * MIN }), NOW)).toBe('finished 12 min ago');
    expect(restLine(agent('idle', { completedAt: NOW - 1000 }), NOW)).toBe('finished just now');
    expect(restLine(agent('idle'), NOW)).toBe('~/Desktop/shop');
    expect(restLine(agent('starting'), NOW)).toBe('~/Desktop/shop');
    expect(restLine(agent('compacting', { compactTrigger: 'auto' }), NOW)).toBe('the context was full');
    expect(restLine(agent('ended', { endReason: 'prompt_input_exit' }), NOW)).toBe('closed');
    expect(restLine(agent('ended', { endReason: 'other' }), NOW)).toBe('');
    expect(folderText('/Users/me')).toBe('~');
  });

  it('says an error in words, and when a used-up limit comes back', () => {
    const error = agent('error', { error: { kind: 'rate_limit', at: NOW } });
    expect(errorLine(error, undefined, NOW)).toBe('rate limit');
    expect(errorLine(agent('error', { error: { kind: 'max_output_tokens', at: NOW } }), undefined, NOW)).toBe('answer too long');
    expect(errorLine(agent('error', { error: { kind: 'something_new', at: NOW } }), undefined, NOW)).toBe('something new');
    const used = { at: NOW, fiveHour: { percent: 100, resetsAt: NOW + 40 * MIN }, sevenDay: { percent: 60, resetsAt: NOW + 3 * 24 * 60 * MIN } };
    expect(errorLine(error, used, NOW)).toMatch(/^5-hour limit used up · back \d{1,2}:\d\d [AP]M$/);
    expect(errorLine(error, { ...used, sevenDay: { percent: 100, resetsAt: NOW + 3 * 24 * 60 * MIN } }, NOW)).toMatch(/^weekly limit used up · back [A-Z][a-z]{2} /);
    // A 429 with the limits not used up: an overload of the API, as Claude Code called it.
    expect(errorLine(error, { at: NOW, fiveHour: { percent: 40, resetsAt: NOW + MIN } }, NOW)).toBe('rate limit');
  });
});

describe('the time in the corner', () => {
  it('is how long the turn has gone on while it works, how long it waits, nothing once finished', () => {
    expect(cornerTime(agent('working', { turnStartedAt: NOW - 40 * MIN }), NOW)).toEqual({ text: 'for 40 min', title: 'At work on this turn for 40 min; the last event came 2 min ago' });
    expect(cornerTime(agent('waiting', { waiting: { kind: 'permesso', since: NOW - 3 * MIN } }), NOW)?.text).toBe('3 min');
    expect(cornerTime(agent('idle', { completedAt: NOW - MIN }), NOW)).toBeUndefined();
    expect(cornerTime(agent('error', { error: { kind: 'unknown', at: NOW } }), NOW)?.text).toBe('2 min');
  });

  it('starts with the prompt, or with the first tool call after a pause, and not again inside the turn', () => {
    const one = newAgent({ id: 'a2', control: { kind: 'tmux', session: 'fk-a2' }, state: 'idle' }, NOW);
    applyHook(one, { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'go' }, NOW);
    expect(one.turnStartedAt).toBe(NOW);
    applyHook(one, { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }, NOW + MIN);
    expect(one.turnStartedAt).toBe(NOW);
    applyHook(one, { hook_event_name: 'Stop', session_id: 's' }, NOW + 2 * MIN);
    applyHook(one, { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }, NOW + 5 * MIN);
    expect(one.turnStartedAt).toBe(NOW + 5 * MIN);
  });
});

describe('a result not seen yet', () => {
  it('is a turn finished or an error', () => {
    expect(resultAt(agent('idle', { completedAt: NOW - MIN }))).toBe(NOW - MIN);
    expect(resultAt(agent('error', { error: { kind: 'unknown', at: NOW } }))).toBe(NOW);
    expect(resultAt(agent('working'))).toBeUndefined();
    expect(resultAt(agent('idle'))).toBeUndefined();
  });

  it('shows from the second result on, and goes with a click on its box', () => {
    const store = new Store();
    const first = agent('idle', { completedAt: NOW - 10 * MIN });
    store.apply({ type: 'hello', now: NOW, agents: [first], settings: { replace: 'lru', arricurdaiNotes: false } });
    // What was there when the page first kept track counts as seen.
    expect(store.unseen(store.state.agents.get('a1')!)).toBe(false);
    store.apply({ type: 'agents', now: NOW, agents: [{ ...first, completedAt: NOW }] });
    expect(store.unseen(store.state.agents.get('a1')!)).toBe(true);
    store.open('a1');
    expect(store.unseen(store.state.agents.get('a1')!)).toBe(false);
  });
});

describe('who spent the 5-hour window', () => {
  it('counts what each session spent since it was first seen in the window, the most first', () => {
    const limits = new Limits();
    const window = { fiveHour: { percent: 10, resetsAt: NOW + 3 * 60 * MIN } };
    limits.take(window, NOW, { agentId: 'billing', usd: 5 });
    limits.take(window, NOW, { agentId: 'frontend', usd: 1 });
    limits.take(window, NOW + 10_000, { agentId: 'billing', usd: 8 });
    limits.take(window, NOW + 20_000, { agentId: 'frontend', usd: 2 });
    // A /clear: the cost starts again from zero, and what it costs now counts.
    limits.take(window, NOW + 30_000, { agentId: 'frontend', usd: 0.5 });
    const info = limits.take({ fiveHour: { percent: 11, resetsAt: NOW + 3 * 60 * MIN } }, NOW + 2 * MIN);
    expect(info?.fiveHour?.sessions).toEqual([
      { agentId: 'billing', percent: 67 },
      { agentId: 'frontend', percent: 33 },
    ]);
    expect(sharesOf(new Map([['x', { spent: 0 }]]))).toBeUndefined();
  });

  it('is named in the tooltip of the 5-hour limit when two sessions or more spent', () => {
    const limits = { at: NOW, fiveHour: { percent: 62, resetsAt: NOW + 60 * MIN, sessions: [{ agentId: 'b', percent: 70 }, { agentId: 'f', percent: 30 }] } };
    const [five] = limitParts(limits, NOW, (id) => ({ b: 'billing', f: 'frontend' })[id]);
    expect(five?.title).toContain('What the sessions spent in this window, an estimate from their cost: billing 70%, frontend 30%.');
    const [alone] = limitParts({ ...limits, fiveHour: { ...limits.fiveHour, sessions: [{ agentId: 'b', percent: 100 }] } }, NOW, () => 'billing');
    expect(alone?.title).not.toContain('What the sessions spent');
  });
});
