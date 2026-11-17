import { describe, expect, it } from 'vitest';
import { Guard } from '../src/daemon/guard.ts';
import { type Agent, type HookPayload, newAgent } from '../src/daemon/state.ts';

// At the first step of a session, the guard tells it who else is halfway through which files in its folder: it
// plans around them from the start, instead of finding out when it is stopped.

const REPO = '/p/shop';

function setup(notes = true) {
  let now = 10_000_000;
  const agents: Agent[] = [];
  const counted: string[] = [];
  const guard = new Guard({
    agents: () => agents,
    repoOf: (dir) => (dir === REPO || dir.startsWith(`${REPO}/`) ? REPO : undefined),
    writesOf: () => [],
    enabled: () => ({ files: true, git: true, notes }),
    touch: () => {},
    count: (kind) => counted.push(kind),
    now: () => now,
  });
  const add = (id: string, cwd = REPO, state: Agent['state'] = 'working'): Agent => {
    const agent = newAgent({ id, cwd, control: { kind: 'tmux', session: `fk-${id}` }, state, sessionId: `${id}-1` }, now);
    agents.push(agent);
    return agent;
  };
  const step = (agent: Agent, payload: Partial<HookPayload> = {}) =>
    guard.arrival(agent, { hook_event_name: 'PreToolUse', session_id: agent.sessionId ?? agent.id, tool_name: 'Bash', tool_input: { command: 'git status' }, ...payload });
  return { guard, add, step, counted, advance: (ms: number) => (now += ms) };
}

describe('the note at the first step of a session', () => {
  it('says who is halfway through which files, since when, and what to do', () => {
    const t = setup();
    const retries = t.add('retries');
    retries.team = { label: 'retries' };
    retries.turnStartedAt = 10_000_000 - 4 * 60_000;
    t.guard.wrote(retries, `${REPO}/src/api.ts`);
    t.guard.wrote(retries, `${REPO}/test/api.test.ts`);
    const docs = t.add('docs');
    expect(t.step(docs)).toBe(
      'Forchetta: other Claude Code sessions are working in this folder right now: "retries" is in the middle of changing src/api.ts and test/api.test.ts (its turn started 4 min ago). ' +
        'Leave those files to them while they work: if your task needs them, start from the rest. If you try to change one of them now, Forchetta stops you and tells you when it is free.',
    );
    expect(t.counted).toEqual(['arrival']);
  });

  it('comes once per conversation: again after a /clear, never to its subagents', () => {
    const t = setup();
    const busy = t.add('busy');
    t.guard.wrote(busy, `${REPO}/src/a.ts`);
    const other = t.add('other');
    expect(t.step(other, { agent_id: 'sub-1' })).toBeUndefined();
    expect(t.step(other)).toContain('src/a.ts');
    expect(t.step(other)).toBeUndefined();
    other.sessionId = 'other-2';
    expect(t.step(other)).toContain('src/a.ts');
  });

  it('says nothing when nobody is halfway through anything here; and that first step is spent', () => {
    const t = setup();
    const idle = t.add('idle', REPO, 'idle');
    t.guard.wrote(idle, `${REPO}/src/a.ts`);
    t.add('elsewhere', '/p/blog');
    const me = t.add('me');
    expect(t.step(me)).toBeUndefined();
    // Someone starts working later: the other notes say it when it matters, not this one.
    const late = t.add('late');
    t.guard.wrote(late, `${REPO}/src/b.ts`);
    expect(t.step(me)).toBeUndefined();
    expect(t.counted).toEqual([]);
  });

  it('another note of the same answer already says it: not twice', () => {
    const t = setup();
    const busy = t.add('busy');
    t.guard.wrote(busy, `${REPO}/src/a.ts`);
    const me = t.add('me');
    expect(t.guard.arrival(me, { hook_event_name: 'PreToolUse', session_id: 'me-1' }, true)).toBeUndefined();
    expect(t.step(me)).toBeUndefined();
  });

  it('is off with the notes of the guard', () => {
    const t = setup(false);
    const busy = t.add('busy');
    t.guard.wrote(busy, `${REPO}/src/a.ts`);
    expect(t.step(t.add('me'))).toBeUndefined();
  });
});
