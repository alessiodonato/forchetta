import { describe, expect, it } from 'vitest';
import type { EnqueueResult } from '../src/daemon/commands.ts';
import { Restarter } from '../src/daemon/restarts.ts';
import { newAgent } from '../src/daemon/state.ts';
import type { Agent, QueuedCommand } from '../src/shared/agent.ts';
import { CACHE_GONE_MS, isOutdated, passing, restartView } from '../src/shared/restarts.ts';

// The sessions on an older Claude Code: which can restart on the one installed, and the restarts, one at a time.

const MIN = 60_000;
const NOW = 100_000_000;
const NEW = '2.1.331';

const session = (id: string, extra: Partial<Agent> = {}): Agent => ({
  ...newAgent({ id, cwd: `/Users/dev/${id}`, control: { kind: 'tmux', session: `fk-${id}`, paneId: '%1' }, state: 'idle' }, NOW - 5 * CACHE_GONE_MS),
  lastEvent: { name: 'Stop', at: NOW - 2 * CACHE_GONE_MS },
  version: '2.1.328',
  ...extra,
});

describe('a session on an older Claude Code', () => {
  it('is one with a version before the one installed', () => {
    expect(isOutdated(session('a'), NEW)).toBe(true);
    expect(isOutdated(session('a', { version: NEW }), NEW)).toBe(false);
    expect(isOutdated(session('a', { version: '2.2.0' }), NEW)).toBe(false);
    expect(isOutdated(session('a', { version: undefined }), NEW)).toBe(false);
    expect(isOutdated(session('a', { state: 'ended' }), NEW)).toBe(false);
    expect(isOutdated(session('a'), undefined)).toBe(false);
  });

  it('restarts when it is at rest with nothing under way and no cache left', () => {
    expect(restartView(session('a'), NEW, NOW)).toEqual({ when: 'ready' });
    expect(restartView(session('a', { version: NEW }), NEW, NOW)).toBeUndefined();
    const cache = (left: number) => ({ cache: { expiresAt: NOW + left, live: left > 0, guardWillStop: false } });
    expect(restartView(session('a', cache(-1)), NEW, NOW)?.when).toBe('ready');
    expect(restartView(session('a', cache(5 * MIN)), NEW, NOW)?.when).toBe('warm');
    // No word on the cache: an hour of rest.
    expect(restartView(session('a', { lastEvent: { name: 'Stop', at: NOW - 59 * MIN } }), NEW, NOW)?.when).toBe('warm');
    expect(restartView(session('a', { lastEvent: { name: 'Stop', at: NOW - 61 * MIN } }), NEW, NOW)?.when).toBe('ready');
  });

  it('waits while something of it is under way', () => {
    const when = (extra: Partial<Agent>) => restartView(session('a', extra), NEW, NOW);
    for (const state of ['working', 'waiting', 'compacting', 'starting', 'error'] as const) expect(when({ state })?.when).toBe('later');
    expect(when({ backgroundShell: true })).toEqual({ when: 'later', reason: 'a command runs in the background' });
    expect(when({ subagents: [{ type: 'Explore', state: 'running', startedAt: NOW } as NonNullable<Agent['subagents']>[number]] })?.reason).toBe('a subagent is at work');
    expect(when({ commands: [{ id: 'c', kind: 'compact', status: 'in-coda', createdAt: NOW }] })?.reason).toBe('a command is in its queue');
    expect(when({ commands: [{ id: 'c', kind: 'compact', status: 'confermato', createdAt: NOW }] })?.when).toBe('ready');
  });

  it('cannot outside the tmux of Forchetta, nor with Remote Control', () => {
    expect(restartView(session('a', { control: { kind: 'readonly', reason: 'fuori-tmux' } }), NEW, NOW)?.when).toBe('never');
    expect(restartView(session('a', { remoteControl: true }), NEW, NOW)).toMatchObject({ when: 'never', reason: expect.stringContaining('Remote Control') });
  });

  it('is asked again only for what ends by itself', () => {
    expect(passing("Can't restart while work is running in the background. Wait for it to finish.")).toBe(true);
    expect(passing("Can't restart this session. It isn't saved to disk")).toBe(false);
  });
});

/** A restarter over some sessions: what it asks for, and how each restart ends. */
function bench(sessions: Agent[], options: { auto?: boolean; busy?: string[]; installed?: string } = {}) {
  const agents = new Map(sessions.map((one) => [one.id, one]));
  const asked: string[] = [];
  const commands = new Map<string, QueuedCommand>();
  const state = { now: NOW, auto: options.auto ?? false, changes: 0, refuse: undefined as string | undefined };
  const restarter = new Restarter({
    installed: () => options.installed ?? NEW,
    agents: () => agents.values(),
    agent: (id) => agents.get(id),
    enqueue: (id): EnqueueResult => {
      if (state.refuse) return { ok: false, error: state.refuse };
      asked.push(id);
      const command: QueuedCommand = { id: `c-${asked.length}`, kind: 'restart', status: 'in-coda', createdAt: state.now };
      commands.set(id, command);
      return { ok: true, command };
    },
    teamBusy: (id) => options.busy?.includes(id) ?? false,
    auto: () => state.auto,
    touch: () => {},
    onChange: () => (state.changes += 1),
    log: () => {},
    now: () => state.now,
  });
  const end = (id: string, status: QueuedCommand['status'], reason?: string, refused = false): void => {
    const command = commands.get(id)!;
    Object.assign(command, { status, reason });
    if (status === 'confermato') agents.get(id)!.version = NEW;
    restarter.commandChanged(agents.get(id)!, command, refused);
  };
  const later = (ms: number): void => {
    state.now += ms;
    restarter.tick();
  };
  return { restarter, agents, asked, state, end, later };
}

describe('the restarts you ask for', () => {
  it('go one at a time, the next once the one before is on the new version', () => {
    const { restarter, asked, end, later } = bench([session('a'), session('b'), session('c')]);
    restarter.restart(['a', 'b', 'c', 'a', 'gone']);
    expect(asked).toEqual(['a']);
    expect(restarter.info().running).toEqual({ agentId: 'a', auto: false, next: 2, done: 0 });
    later(60_000);
    expect(asked).toEqual(['a']);
    end('a', 'inviato');
    end('a', 'confermato', NEW);
    expect(asked).toEqual(['a']);
    later(6000);
    expect(asked).toEqual(['a', 'b']);
    end('b', 'confermato', NEW);
    later(6000);
    end('c', 'confermato', NEW);
    later(6000);
    expect(restarter.info()).toMatchObject({ last: { done: ['a', 'b', 'c'], failed: [] } });
    expect(restarter.info().running).toBeUndefined();
  });

  it('go with a warm cache too, but not with work under way or a request of the team open', () => {
    const { restarter, asked, later } = bench([session('warm', { cache: { expiresAt: NOW + MIN, live: true, guardWillStop: false } }), session('working', { state: 'working' }), session('member')], { busy: ['member'] });
    restarter.restart(['working', 'member', 'warm']);
    later(1);
    later(1);
    expect(asked).toEqual(['warm']);
    expect(restarter.info().last!.failed).toEqual([
      { name: 'working', reason: 'it is at work' },
      { name: 'member', reason: 'a request of its team is open' },
    ]);
  });

  it('keep what Claude Code refused, with its reason, and go on', () => {
    const { restarter, agents, asked, end, later } = bench([session('a'), session('b')]);
    restarter.restart(['a', 'b']);
    end('a', 'fallito', "Can't restart this session. It isn't saved to disk", true);
    expect(agents.get('a')!.restartRefused).toEqual({ version: NEW, reason: "Can't restart this session. It isn't saved to disk", at: NOW });
    expect(restarter.info().paused).toBeUndefined();
    later(6000);
    expect(asked).toEqual(['a', 'b']);
  });

  it('stop when one does not go as expected, until you say to go on or to leave the others', () => {
    for (const goOn of [true, false]) {
      const { restarter, asked, end, later } = bench([session('a'), session('b'), session('c')]);
      restarter.restart(['a', 'b', 'c']);
      end('a', 'non-confermato', 'no confirmation: see the terminal');
      later(MIN);
      expect(asked).toEqual(['a']);
      expect(restarter.info()).toMatchObject({ paused: { name: 'a', reason: 'no confirmation: see the terminal', waiting: 2 } });
      expect(restarter.info().running).toBeUndefined();
      restarter.resume(goOn);
      later(6000);
      expect(asked).toEqual(goOn ? ['a', 'b'] : ['a']);
      expect(restarter.info().paused).toBeUndefined();
    }
  });

  it('say when a session was not ready after all', () => {
    const { restarter, end } = bench([session('a')]);
    restarter.restart(['a']);
    end('a', 'annullato', 'there is text in the prompt: it stays as it is');
    expect(restarter.info()).toMatchObject({ last: { done: [], failed: [{ name: 'a', reason: 'there is text in the prompt: it stays as it is' }] } });
    expect(restarter.info().paused).toBeUndefined();
  });
});

describe('the restarts by themselves', () => {
  it('are off unless turned on, and not in the first minutes of the daemon', () => {
    const off = bench([session('a')]);
    off.later(10 * MIN);
    expect(off.asked).toEqual([]);
    const on = bench([session('a')], { auto: true });
    on.later(MIN);
    expect(on.asked).toEqual([]);
    on.later(2 * MIN);
    expect(on.asked).toEqual(['a']);
  });

  it('take only the sessions at rest with no cache left, one at a time, and say nothing of the others', () => {
    const { restarter, asked, end, later } = bench(
      [session('working', { state: 'working' }), session('warm', { cache: { expiresAt: NOW + CACHE_GONE_MS, live: true, guardWillStop: false } }), session('rc', { remoteControl: true }), session('member'), session('a'), session('b')],
      { auto: true, busy: ['member'] },
    );
    later(3 * MIN);
    expect(asked).toEqual(['a']);
    expect(restarter.info().running).toMatchObject({ agentId: 'a', auto: true });
    later(6000);
    expect(asked).toEqual(['a']);
    end('a', 'confermato', NEW);
    later(6000);
    expect(asked).toEqual(['a', 'b']);
    end('b', 'confermato', NEW);
    later(6000);
    expect(asked).toEqual(['a', 'b']);
    expect(restarter.info().last).toBeUndefined();
    // Its cache ends: then it goes.
    later(CACHE_GONE_MS);
    expect(asked).toEqual(['a', 'b', 'warm']);
  });

  it('do not ask again what Claude Code refuses for this version, unless it was for work in the background', () => {
    const { asked, end, later, agents } = bench([session('a')], { auto: true });
    later(3 * MIN);
    end('a', 'fallito', "Can't restart this session. It isn't saved to disk", true);
    later(5 * CACHE_GONE_MS);
    expect(asked).toEqual(['a']);
    agents.get('a')!.restartRefused = { version: NEW, reason: "Can't restart while work is running in the background.", at: NOW };
    later(MIN);
    expect(asked).toEqual(['a', 'a']);
    end('a', 'annullato', 'it is not at rest');
    later(20 * MIN);
    expect(asked).toEqual(['a', 'a']);
    later(20 * MIN);
    expect(asked).toEqual(['a', 'a', 'a']);
  });

  it('stop too when one does not go as expected', () => {
    const { restarter, asked, end, later } = bench([session('a'), session('b')], { auto: true });
    later(3 * MIN);
    end('a', 'non-confermato', 'no confirmation: see the terminal');
    later(CACHE_GONE_MS);
    expect(asked).toEqual(['a']);
    expect(restarter.info().paused).toMatchObject({ name: 'a' });
    restarter.resume();
    later(6000);
    expect(asked).toEqual(['a', 'a']);
  });
});
