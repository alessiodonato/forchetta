import { afterEach, describe, expect, it, vi } from 'vitest';
import { Attention, type AttentionNotice } from '../src/daemon/attention.ts';
import { newAgent } from '../src/daemon/state.ts';
import { waitingIds } from '../src/ui/attention.ts';

// When a session that waits for you gets a notification of macOS: once per wait, and only if the wait lasts.

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const notices: AttentionNotice[] = [];
  const attention = new Attention({ notify: (notice) => notices.push(notice), delayMs: 5000 });
  const agent = newAgent({ id: 'a-1', cwd: '/x/alpha', control: { kind: 'readonly', reason: 'fuori-tmux' } }, Date.now());
  const wait = (since = Date.now()) => {
    agent.state = 'waiting';
    agent.waiting = { kind: 'permesso', tool: 'Bash', detail: 'Bash rm -rf build', since };
    attention.agentChanged(agent);
  };
  const work = () => {
    agent.state = 'working';
    agent.waiting = undefined;
    attention.agentChanged(agent);
  };
  return { notices, attention, agent, wait, work };
}

describe('notifications of a wait', () => {
  it('come once, after the wait lasted 5 s, with what is asked', () => {
    const { notices, attention, agent, wait } = setup();
    wait();
    vi.advanceTimersByTime(4900);
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(notices).toEqual([{ agentId: 'a-1', kind: 'waiting', title: 'alpha ti aspetta', body: 'Permesso: Bash rm -rf build' }]);
    // The same wait, changed again (the Notification of Claude Code that follows): no second one.
    attention.agentChanged(agent);
    vi.advanceTimersByTime(10_000);
    expect(notices).toHaveLength(1);
  });

  it('none for a wait answered within 5 s, at the terminal or from the box', () => {
    const { notices, wait, work } = setup();
    wait();
    vi.advanceTimersByTime(2000);
    work();
    vi.advanceTimersByTime(10_000);
    expect(notices).toEqual([]);
  });

  it('keeps a long question short', () => {
    const { notices, agent, attention } = setup();
    agent.state = 'waiting';
    agent.waiting = { kind: 'domanda', detail: 'parola '.repeat(80), since: Date.now() };
    attention.agentChanged(agent);
    vi.advanceTimersByTime(6000);
    expect(notices[0]!.body.length).toBeLessThanOrEqual(180);
    expect(notices[0]!.body.endsWith('…')).toBe(true);
  });

  it('a new wait gets its own', () => {
    const { notices, wait, work } = setup();
    wait();
    vi.advanceTimersByTime(6000);
    work();
    wait();
    vi.advanceTimersByTime(6000);
    expect(notices).toHaveLength(2);
  });

  it('none for the waits that were there when the daemon started', () => {
    const { notices, attention, agent } = setup();
    agent.state = 'waiting';
    agent.waiting = { kind: 'domanda', detail: 'Quale?', since: Date.now() - 60_000 };
    attention.prime([agent]);
    attention.agentChanged(agent);
    vi.advanceTimersByTime(10_000);
    expect(notices).toEqual([]);
  });

  it('none for a wait only claude agents saw: an answer of /btw open on screen', () => {
    const { notices, attention, agent } = setup();
    agent.state = 'waiting';
    agent.waiting = { kind: 'dialogo', since: Date.now(), fromAgentView: true };
    attention.agentChanged(agent);
    vi.advanceTimersByTime(10_000);
    expect(notices).toEqual([]);
  });

  it('a wait that started long ago, seen late, is notified at once', () => {
    const { notices, wait } = setup();
    wait(Date.now() - 30_000);
    vi.advanceTimersByTime(0);
    expect(notices).toHaveLength(1);
  });
});

describe('notifications of a stall and of an error', () => {
  it('a session at work with no sign of life for the threshold gets one, with the command in progress', () => {
    const { notices, agent, attention } = setup();
    agent.state = 'working';
    agent.lastEvent = { name: 'PreToolUse', at: Date.now() };
    agent.action = { tool: 'Bash', label: 'Bash npm test', family: 'shell', at: Date.now() };
    attention.agentChanged(agent);
    vi.advanceTimersByTime(9 * 60_000);
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(notices).toEqual([{ agentId: 'a-1', kind: 'stall', title: 'alpha sembra ferma', body: 'nessun evento da 10 min · Bash npm test in corso' }]);
    // Still stalled: no second one.
    attention.agentChanged(agent);
    vi.advanceTimersByTime(30 * 60_000);
    expect(notices).toHaveLength(1);
  });

  it('a timer that fires a hair early still says the threshold, not less', () => {
    const { notices, agent, attention } = setup();
    agent.state = 'working';
    agent.lastEvent = { name: 'PreToolUse', at: Date.now() + 50 };
    attention.agentChanged(agent);
    vi.advanceTimersByTime(10 * 60_000 + 50);
    vi.setSystemTime(Date.now() - 100);
    expect(notices[0]?.body).toBe('nessun evento da 10 min');
  });

  it('a sign of life moves the stall away: a new event, or a cost that went up', () => {
    const { notices, agent, attention } = setup();
    agent.state = 'working';
    agent.lastEvent = { name: 'PreToolUse', at: Date.now() };
    attention.agentChanged(agent);
    vi.advanceTimersByTime(8 * 60_000);
    agent.usage = { usd: 1, at: Date.now() };
    attention.agentChanged(agent);
    vi.advanceTimersByTime(8 * 60_000);
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(2 * 60_000);
    expect(notices.map((notice) => notice.kind)).toEqual(['stall']);
  });

  it('an error, at once, once', () => {
    const { notices, agent, attention } = setup();
    agent.state = 'error';
    agent.error = { kind: 'rate_limit', message: 'Limite raggiunto, riprova alle 15', at: Date.now() };
    attention.agentChanged(agent);
    vi.advanceTimersByTime(0);
    expect(notices).toEqual([{ agentId: 'a-1', kind: 'error', title: 'alpha: errore', body: 'rate_limit · Limite raggiunto, riprova alle 15' }]);
    attention.agentChanged(agent);
    vi.advanceTimersByTime(1000);
    expect(notices).toHaveLength(1);
  });

  it('none for what was already going on when the daemon started', () => {
    const { notices, agent, attention } = setup();
    agent.state = 'error';
    agent.error = { kind: 'overloaded', at: Date.now() - 60_000 };
    attention.prime([agent]);
    attention.agentChanged(agent);
    vi.advanceTimersByTime(1000);
    expect(notices).toEqual([]);
  });
});

describe('badge', () => {
  it('counts the sessions that wait, as the header does', () => {
    const make = (id: string, state: 'waiting' | 'idle') => ({ ...newAgent({ id, control: { kind: 'readonly', reason: 'fuori-tmux' } }, 0), state });
    expect(waitingIds([make('a', 'waiting'), make('b', 'idle'), make('c', 'waiting')])).toEqual(['a', 'c']);
  });
});
