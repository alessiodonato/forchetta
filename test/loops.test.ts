import { afterEach, describe, expect, it, vi } from 'vitest';
import { Attention, type AttentionNotice } from '../src/daemon/attention.ts';
import { callKey, errorKey, errorLine, LOOP_AFTER, Loops } from '../src/daemon/loops.ts';
import { type HookPayload, newAgent } from '../src/daemon/state.ts';
import { slimPayload } from '../src/daemon/server.ts';
import { loopText } from '../src/shared/present.ts';

// A session going in circles: in its turn, the same call fails the same way again and again. Its box says it, and
// a notification brings you there.

afterEach(() => vi.useRealTimers());

function setup() {
  const loops = new Loops();
  const agent = newAgent({ id: 'a-1', cwd: '/p/shop', control: { kind: 'tmux', session: 'fk-a' }, state: 'working' }, 0);
  let now = 1_000;
  const hook = (payload: Partial<HookPayload> & { hook_event_name: string }): boolean => loops.hook(agent, { session_id: 's', ...payload }, (now += 1_000));
  const fail = (command: string, error: string, extra: Partial<HookPayload> = {}) =>
    hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command, description: `try ${now}` }, error, ...extra });
  const pass = (command: string) => hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command } });
  return { loops, agent, hook, fail, pass };
}

const TEST_ERROR = (ms: number) => `Exit code 1\n FAIL  test/api.test.ts > retries\nAssertionError: expected 2 to be 3\n Duration  ${ms}ms (transform 12ms)`;

describe('a session going in circles', () => {
  it('is the same command failing the same way three times in its turn; the box says it', () => {
    const t = setup();
    expect(t.fail('npm test', TEST_ERROR(812))).toBe(false);
    expect(t.fail('npm  test', TEST_ERROR(790))).toBe(false);
    expect(t.agent.loop).toBeUndefined();
    expect(t.fail('npm test ', TEST_ERROR(801))).toBe(true);
    expect(t.agent.loop).toEqual({ tool: 'Bash', label: 'npm test', error: 'exit 1 · FAIL test/api.test.ts > retries', count: 3, since: 2_000, at: 4_000 });
    expect(loopText(t.agent.loop!)).toBe('npm test: the same error 3 times');
    // A fourth time: the same episode, counted.
    expect(t.fail('npm test', TEST_ERROR(799))).toBe(true);
    expect(t.agent.loop).toMatchObject({ count: 4, since: 2_000 });
    expect(LOOP_AFTER).toBe(3);
  });

  it('a different error is progress: the count starts again, and the box no longer says it', () => {
    const t = setup();
    for (let i = 0; i < 3; i++) t.fail('npm test', TEST_ERROR(800));
    expect(t.agent.loop).toBeDefined();
    expect(t.fail('npm test', 'Exit code 1\n FAIL  test/api.test.ts > backoff')).toBe(true);
    expect(t.agent.loop).toBeUndefined();
    t.fail('npm test', 'Exit code 1\n FAIL  test/api.test.ts > backoff');
    expect(t.agent.loop).toBeUndefined();
  });

  it('the call working ends it; other calls failing in between do not count for it', () => {
    const t = setup();
    t.fail('npm test', TEST_ERROR(1));
    t.fail('npm run lint', 'Exit code 2\nerror');
    t.fail('npm test', TEST_ERROR(2));
    t.fail('npm test', TEST_ERROR(3));
    expect(t.agent.loop?.label).toBe('npm test');
    expect(t.pass('npm run lint')).toBe(false);
    expect(t.agent.loop).toBeDefined();
    expect(t.pass('npm test')).toBe(true);
    expect(t.agent.loop).toBeUndefined();
  });

  it('ends with its turn, a prompt of yours, a /clear or the end of the session; Esc is not a failure', () => {
    for (const end of [
      { hook_event_name: 'Stop' },
      { hook_event_name: 'StopFailure' },
      { hook_event_name: 'SessionEnd' },
      { hook_event_name: 'SessionStart', source: 'clear' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'try another way' },
    ]) {
      const t = setup();
      for (let i = 0; i < 3; i++) t.fail('make', 'Exit code 2\nmake: *** [all] Error 1');
      expect(t.hook(end)).toBe(true);
      expect(t.agent.loop).toBeUndefined();
      // And the count starts from zero in the next turn.
      t.fail('make', 'Exit code 2\nmake: *** [all] Error 1');
      expect(t.agent.loop).toBeUndefined();
    }
    const t = setup();
    for (let i = 0; i < 2; i++) t.fail('make', 'Exit code 2\nboom');
    // The Stop of a subagent is not the end of the turn; a command of the box (/btw) is not a prompt.
    t.hook({ hook_event_name: 'Stop', agent_id: 'sub-1' });
    t.hook({ hook_event_name: 'UserPromptSubmit', prompt: '/btw how is it going' });
    t.fail('make', 'Exit code 2\nboom', { is_interrupt: true });
    expect(t.agent.loop).toBeUndefined();
    t.fail('make', 'Exit code 2\nboom');
    expect(t.agent.loop?.count).toBe(3);
  });

  it('a subagent going in circles is said with its type, apart from the session', () => {
    const t = setup();
    for (let i = 0; i < 2; i++) t.fail('pytest', 'Exit code 1\nE   ImportError');
    t.fail('pytest', 'Exit code 1\nE   ImportError', { agent_id: 'x1', agent_type: 'general-purpose' });
    expect(t.agent.loop).toBeUndefined();
    t.fail('pytest', 'Exit code 1\nE   ImportError', { agent_id: 'x1', agent_type: 'general-purpose' });
    t.fail('pytest', 'Exit code 1\nE   ImportError', { agent_id: 'x1', agent_type: 'general-purpose' });
    expect(t.agent.loop).toMatchObject({ subagent: 'general-purpose', count: 3 });
    expect(loopText(t.agent.loop!)).toBe('↳ general-purpose · pytest: the same error 3 times');
  });

  it('works for any tool: the same input, the same error', () => {
    const t = setup();
    for (let i = 0; i < 3; i++) t.hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'WebFetch', tool_input: { url: 'https://example.com/x', prompt: 'read' }, error: 'Request failed with status code 404' });
    expect(t.agent.loop).toMatchObject({ tool: 'WebFetch', error: 'Request failed with status code 404', count: 3 });
  });
});

describe('the same call, the same error', () => {
  it('a call is its tool and input; for Bash the command, never the description', () => {
    expect(callKey('Bash', { command: 'npm  test', description: 'a' })).toBe(callKey('Bash', { command: 'npm test', description: 'b' }));
    expect(callKey('Read', { file_path: '/x', description: 'a' })).toBe(callKey('Read', { file_path: '/x' }));
    expect(callKey('Read', { file_path: '/x' })).not.toBe(callKey('Read', { file_path: '/y' }));
    expect(callKey('Bash', { command: 'x' }, 'Explore')).not.toBe(callKey('Bash', { command: 'x' }));
  });

  it('an error without what changes from one run to the next', () => {
    expect(errorKey(TEST_ERROR(812))).toBe(errorKey(TEST_ERROR(790)));
    expect(errorKey('at 2026-11-17T01:02:03Z took 1.5s')).toBe(errorKey('at 2026-11-17T09:12:44.120Z took 2s'));
    expect(errorKey('\u001b[31mFAIL\u001b[0m 12:01:02')).toBe(errorKey('FAIL 12:05:09'));
    expect(errorKey('object at 0x7ffee12 pid 4411')).toBe(errorKey('object at 0x7ffaa98 pid 77'));
    expect(errorKey('expected 2 to be 3')).not.toBe(errorKey('expected 1 to be 3'));
    expect(errorKey(`${'a'.repeat(5000)}END`).length).toBeLessThan(4100);
  });

  it('the line of the box: the exit code and the first line of the output', () => {
    expect(errorLine('Exit code 1\nls: x: No such file or directory')).toBe('exit 1 · ls: x: No such file or directory');
    expect(errorLine('Exit code 3')).toBe('exit 3');
    expect(errorLine('Request failed')).toBe('Request failed');
    expect(errorLine(undefined)).toBe('failed');
  });

  it('Claude Code sends the error and whether you stopped it: the daemon keeps both', () => {
    expect(slimPayload({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: { command: 'x' }, error: 'Exit code 1', is_interrupt: true })).toMatchObject({
      error: 'Exit code 1',
      is_interrupt: true,
    });
  });
});

describe('the notification of a session going in circles', () => {
  it('comes at once, once per episode, with the call and the error', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const notices: AttentionNotice[] = [];
    const attention = new Attention({ notify: (notice) => notices.push(notice) });
    const agent = newAgent({ id: 'a-1', cwd: '/x/alpha', control: { kind: 'tmux', session: 'x' }, state: 'working' }, Date.now());
    agent.loop = { tool: 'Bash', label: 'npm test', error: 'exit 1 · FAIL test/api.test.ts', count: 3, since: 900_000, at: 999_000 };
    attention.agentChanged(agent);
    vi.advanceTimersByTime(0);
    expect(notices).toEqual([{ agentId: 'a-1', kind: 'loop', title: 'alpha is going in circles', body: 'npm test: the same error 3 times · exit 1 · FAIL test/api.test.ts' }]);
    agent.loop = { ...agent.loop, count: 4 };
    attention.agentChanged(agent);
    vi.advanceTimersByTime(1000);
    expect(notices).toHaveLength(1);
    // Over, then again: a new episode.
    agent.loop = undefined;
    attention.agentChanged(agent);
    agent.loop = { tool: 'Bash', label: 'make', error: 'exit 2', count: 3, since: 1_100_000, at: 1_100_000 };
    attention.agentChanged(agent);
    vi.advanceTimersByTime(0);
    expect(notices).toHaveLength(2);
  });
});
