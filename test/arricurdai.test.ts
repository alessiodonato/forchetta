import { afterEach, describe, expect, it } from 'vitest';
import { ArricurdaiPoller, parseArricurdaiStatus } from '../src/daemon/arricurdai.ts';
import { Registry } from '../src/daemon/registry.ts';
import { contextWindowOf, DEFAULT_CONTEXT_WINDOWS, detectArricurdai } from '../src/shared/config.ts';
import { sleep } from './helpers.ts';

/** The shape `arricurdai status --json` 0.4.0 prints. */
const STATUS = JSON.stringify({
  generatedAt: '2026-11-10T18:07:59.730Z',
  hours: 24,
  minTokens: 100000,
  sessions: [
    {
      sessionId: 's-opus',
      project: '/Users/dev/forchetta',
      model: 'claude-opus-5-5',
      context: 126876,
      lastCallAt: '2026-11-10T18:07:58.046Z',
      cacheExpiresAt: '2026-11-10T19:07:58.046Z',
      cacheLive: true,
      guardWillStop: false,
    },
    {
      sessionId: 's-haiku',
      model: 'claude-haiku-4-5-20251001',
      context: 150000,
      lastCallAt: '2026-11-09T12:21:25.808Z',
      cacheExpiresAt: '2026-11-09T12:26:25.808Z',
      cacheLive: false,
      guardWillStop: true,
    },
    { sessionId: 'broken', context: 'many' },
  ],
  today: { calls: 1 },
});

let registry: Registry | undefined;
afterEach(() => registry?.dispose());

describe('the part of today of each session (arricurdAI with sessions[].today)', () => {
  it('is read when it is there, and goes to the box of the session', () => {
    const withToday = JSON.parse(STATUS) as { sessions: Array<Record<string, unknown>> };
    withToday.sessions[0]!.today = { calls: 12, tokens: { input: 10, cacheWrite: 2_000, cacheRead: 1_000_000, output: 5_000 }, usd: 1.25, unpricedCalls: 0 };
    const sessions = parseArricurdaiStatus(JSON.stringify(withToday));
    expect(sessions.get('s-opus')!.today).toEqual({ calls: 12, tokens: 1_007_010, usd: 1.25 });
    // 0.4.0 has none: nothing is made up.
    expect(parseArricurdaiStatus(STATUS).get('s-opus')!.today).toBeUndefined();
    registry = new Registry();
    const agent = registry.hook({ hook_event_name: 'SessionStart', session_id: 's-opus', cwd: '/Users/dev/forchetta', source: 'startup' });
    registry.applyArricurdai(sessions, () => 1_000_000);
    expect(agent.today).toEqual({ calls: 12, tokens: 1_007_010, usd: 1.25 });
  });
});

describe('arricurdai status', () => {
  it('reads the sessions and leaves out what it cannot read', () => {
    const sessions = parseArricurdaiStatus(STATUS);
    expect([...sessions.keys()]).toEqual(['s-opus', 's-haiku']);
    expect(sessions.get('s-opus')).toMatchObject({ context: 126876, cacheLive: true, cacheExpiresAt: Date.parse('2026-11-10T19:07:58.046Z') });
    expect(() => parseArricurdaiStatus('{}')).toThrow();
  });

  it('gives each session its context and cache, with the window of the model of its last call', () => {
    const changes: string[] = [];
    registry = new Registry({ onChange: (agent) => changes.push(agent.id) });
    const opus = registry.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's-opus', cwd: '/Users/dev/forchetta', prompt: 'vai' });
    const haiku = registry.hook({ hook_event_name: 'SessionStart', session_id: 's-haiku', cwd: '/Users/dev/x', source: 'startup', model: 'claude-opus-5-5' });
    const windowOf = (model: string | undefined): number => contextWindowOf(model, DEFAULT_CONTEXT_WINDOWS);
    changes.length = 0;
    const changed = registry.applyArricurdai(parseArricurdaiStatus(STATUS), windowOf);
    expect(changed).toHaveLength(2);
    expect(opus.context).toMatchObject({ tokens: 126876, window: 1_000_000, percent: 13 });
    expect(opus.cache).toMatchObject({ live: true, guardWillStop: false });
    // The SessionStart said Opus, the last call was Haiku 4.5 (after /model): 200k window.
    expect(haiku.model).toBe('claude-haiku-4-5-20251001');
    expect(haiku.context).toMatchObject({ tokens: 150000, window: 200_000, percent: 75 });
    expect(haiku.cache).toMatchObject({ live: false, guardWillStop: true });
    // The same numbers again: nothing changes, nothing is sent to the page.
    changes.length = 0;
    expect(registry.applyArricurdai(parseArricurdaiStatus(STATUS), windowOf)).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('knows the window of a model by id, by beginning, or by default', () => {
    expect(contextWindowOf('claude-haiku-4-5', DEFAULT_CONTEXT_WINDOWS)).toBe(200_000);
    expect(contextWindowOf('claude-haiku-4-5-20251001', DEFAULT_CONTEXT_WINDOWS)).toBe(200_000);
    expect(contextWindowOf('claude-opus-5-5', DEFAULT_CONTEXT_WINDOWS)).toBe(1_000_000);
    expect(contextWindowOf(undefined, { '*': 500 })).toBe(500);
  });

  it('finds the command of arricurdai in the PATH or in its hooks', () => {
    const none = (): undefined => undefined;
    const settings = '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node /Users/dev/arricurdAI/packages/cli/dist/bin.js guard"}]}]}}';
    expect(detectArricurdai(settings, (name) => (name === 'node' ? '/usr/local/bin/node' : undefined))).toEqual(['/usr/local/bin/node', '/Users/dev/arricurdAI/packages/cli/dist/bin.js']);
    expect(detectArricurdai('{"command":"node \\"/a b/arricurdai/bin.js\\" handoff"}', (name) => (name === 'node' ? '/n' : undefined))).toBeUndefined();
    expect(detectArricurdai(settings, (name) => (name === 'arricurdai' ? '/usr/local/bin/arricurdai' : undefined))).toEqual(['/usr/local/bin/arricurdai']);
    expect(detectArricurdai(undefined, none)).toBeUndefined();
  });
});

describe('ArricurdaiPoller', () => {
  it('runs soon after an event only while someone looks, and shares a run in progress', async () => {
    let runs = 0;
    let watched = false;
    const poller = new ArricurdaiPoller({
      run: async () => {
        runs++;
        await sleep(30);
      },
      watched: () => watched,
      busy: () => false,
      soonMs: 10,
      idleMs: 60_000,
    });
    poller.soon();
    await sleep(40);
    expect(runs).toBe(0);
    watched = true;
    poller.soon();
    await sleep(25);
    expect(runs).toBe(1);
    // The run started by soon() is still going: both requests share it.
    await Promise.all([poller.refresh(), poller.refresh()]);
    expect(runs).toBe(1);
    await poller.refresh();
    expect(runs).toBe(2);
    poller.stop();
  });

  it('keeps a rhythm of 30 s while a session works', async () => {
    let runs = 0;
    const poller = new ArricurdaiPoller({ run: async () => void runs++, watched: () => true, busy: () => true, busyMs: 20, idleMs: 60_000 });
    await poller.refresh();
    // Three runs 20 ms apart; under the load of the whole suite they may come later, never not at all.
    for (let waited = 0; runs < 3 && waited < 2000; waited += 10) await sleep(10);
    poller.stop();
    expect(runs).toBeGreaterThanOrEqual(3);
  });
});
