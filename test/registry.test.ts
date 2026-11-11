import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUIET_MS, Registry } from '../src/daemon/registry.ts';
import type { HookPayload } from '../src/daemon/state.ts';
import { sleep } from './helpers.ts';

const AGENT = '3f2b8c1e-1111-4222-8333-444455556666';
const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const CWD = '/Users/dev/progetto';

const ev = (hook_event_name: string, extra: Partial<HookPayload> = {}, session_id = S1): HookPayload => ({
  hook_event_name,
  session_id,
  cwd: CWD,
  transcript_path: `/Users/dev/.claude/projects/x/${session_id}.jsonl`,
  ...extra,
});

let clock = 1_000_000;
const now = (): number => clock;
let registry: Registry;

function fresh(options: ConstructorParameters<typeof Registry>[0] = {}): Registry {
  clock = 1_000_000;
  registry = new Registry({ now, settleMs: 5, ...options });
  return registry;
}

afterEach(() => registry?.dispose());

/** A session started with `forchetta run` and its SessionStart hook. */
function started(): string {
  fresh();
  registry.register({ id: AGENT, cwd: CWD, tmuxSession: 'fk-3f2b8c1e' });
  registry.hook(ev('SessionStart', { source: 'startup', model: 'claude-opus-5-5' }), { agentId: AGENT, pid: 4242, pane: '%3' });
  return AGENT;
}

describe('a session of forchetta run', () => {
  it('shows up before Claude starts, then links pid, pane and session', async () => {
    fresh();
    const early = registry.register({ id: AGENT, cwd: CWD, tmuxSession: 'fk-3f2b8c1e' });
    expect(early.state).toBe('starting');
    expect(early.project).toBe('progetto');
    registry.hook(ev('SessionStart', { source: 'startup' }), { agentId: AGENT, pid: 4242, pane: '%3' });
    const agent = registry.agents.get(AGENT)!;
    expect(registry.agents.size).toBe(1);
    expect(agent).toMatchObject({ pid: 4242, sessionId: S1, control: { kind: 'tmux', session: 'fk-3f2b8c1e', paneId: '%3' }, state: 'starting' });
    await sleep(20);
    expect(agent.state).toBe('idle');
  });

  it('follows a turn with a permission dialog', () => {
    started();
    const agent = registry.agents.get(AGENT)!;
    registry.hook(ev('UserPromptSubmit', { prompt: 'Sistema i test del modulo api' }));
    expect(agent.state).toBe('working');
    expect(agent.summary?.text).toBe('Working on: Sistema i test del modulo api');

    registry.hook(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    expect(agent.action?.label).toBe('Bash npm test');

    registry.hook(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }));
    registry.hook(ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }));
    expect(agent.state).toBe('waiting');
    expect(agent.waiting).toMatchObject({ kind: 'permesso', detail: 'Bash rm -rf dist' });

    // The other call of the same batch ends while the dialog is open: still waiting.
    registry.hook(ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    expect(agent.state).toBe('waiting');

    registry.hook(ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }));
    expect(agent.state).toBe('working');
    expect(agent.waiting).toBeUndefined();

    clock += 1000;
    registry.hook(ev('Stop', { last_assistant_message: 'Fatto. I test passano tutti e la build è pulita.\n\nDettagli...' }));
    expect(agent.state).toBe('idle');
    expect(agent.completedAt).toBe(clock);
    expect(agent.summary?.text).toBe('Fatto. I test passano tutti e la build è pulita.');
    expect(agent.action).toBeUndefined();
  });

  it('keeps the same box across /clear, with the new session id', () => {
    started();
    const agent = registry.agents.get(AGENT)!;
    registry.hook(ev('UserPromptSubmit', { prompt: 'ciao' }));
    registry.hook(ev('Stop', { last_assistant_message: 'Ciao!' }));
    registry.hook(ev('SessionEnd', { reason: 'clear' }));
    expect(agent.state).toBe('idle');
    registry.hook(ev('SessionStart', { source: 'clear' }, S2), { pid: 4242, agentId: AGENT });
    expect(registry.agents.size).toBe(1);
    expect(agent).toMatchObject({ sessionId: S2, pastSessionIds: [S1], state: 'idle' });
    expect(agent.summary).toBeUndefined();
    // Late events of the old session still land in the same box.
    registry.hook(ev('Notification', { notification_type: 'idle_prompt' }, S1));
    expect(registry.agents.size).toBe(1);
  });

  it('finds the box after /clear even when the hook could not say the pid', () => {
    fresh();
    registry.hook(ev('SessionStart', { source: 'startup' }));
    const agent = registry.list()[0]!;
    registry.hook(ev('SessionEnd', { reason: 'clear' }));
    registry.hook(ev('SessionStart', { source: 'clear' }, S2));
    expect(registry.agents.size).toBe(1);
    expect(agent.sessionId).toBe(S2);
  });

  it('ends with SessionEnd', () => {
    started();
    registry.hook(ev('SessionEnd', { reason: 'prompt_input_exit' }));
    expect(registry.agents.get(AGENT)).toMatchObject({ state: 'ended', endReason: 'prompt_input_exit' });
  });
});

describe('states', () => {
  it('ignores commands and shell lines as the start of a turn', () => {
    started();
    const agent = registry.agents.get(AGENT)!;
    agent.state = 'idle';
    registry.hook(ev('UserPromptSubmit', { prompt: '/btw che ore sono?' }));
    registry.hook(ev('UserPromptSubmit', { prompt: '/model' }));
    registry.hook(ev('UserPromptSubmit', { prompt: '! ls' }));
    expect(agent.state).toBe('idle');
  });

  it('waits on a question and resumes when it is answered', () => {
    started();
    const agent = registry.agents.get(AGENT)!;
    // The sequence Claude Code 2.1.322 sends: PreToolUse, PermissionRequest for the same tool, and the
    // permission_prompt notification about six seconds later.
    const input = { questions: [{ question: 'Preferisci il rosso o il blu?', header: 'Colore', options: [{ label: 'Rosso' }, { label: 'Blu' }] }] };
    registry.hook(ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: input }));
    expect(agent).toMatchObject({ state: 'waiting', waiting: { kind: 'domanda', detail: 'Preferisci il rosso o il blu?' } });
    const since = agent.waiting!.since;
    clock += 60;
    registry.hook(ev('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: input }));
    clock += 6000;
    registry.hook(ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use AskUserQuestion' }));
    expect(agent).toMatchObject({ state: 'waiting', waiting: { kind: 'domanda', detail: 'Preferisci il rosso o il blu?', since } });
    registry.hook(ev('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: input }));
    expect(agent.state).toBe('working');
  });

  it('lets a subagent change the action but not a waiting state', () => {
    started();
    const agent = registry.agents.get(AGENT)!;
    registry.hook(ev('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: `${CWD}/a.ts` } }));
    registry.hook(ev('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x' }, agent_id: 'sub1', agent_type: 'Explore' }));
    expect(agent.state).toBe('waiting');
    expect(agent.action).toMatchObject({ label: 'Grep "x"', subagent: 'Explore' });
  });

  it('compacts and comes back to where it was', () => {
    started();
    const agent = registry.agents.get(AGENT)!;
    agent.state = 'idle';
    registry.hook(ev('PreCompact', { trigger: 'manual' }));
    expect(agent.state).toBe('compacting');
    registry.hook(ev('PostCompact', { trigger: 'manual' }));
    expect(agent.state).toBe('idle');

    registry.hook(ev('UserPromptSubmit', { prompt: 'lavora' }));
    registry.hook(ev('PreCompact', { trigger: 'auto' }));
    registry.hook(ev('SessionStart', { source: 'compact' }));
    expect(agent.state).toBe('working');
  });

  it('shows an API error until the next activity', () => {
    started();
    const agent = registry.agents.get(AGENT)!;
    registry.hook(ev('UserPromptSubmit', { prompt: 'vai' }));
    registry.hook(ev('StopFailure', { error: 'rate_limit', last_assistant_message: 'API Error: rate limit' }));
    expect(agent).toMatchObject({ state: 'error', error: { kind: 'rate_limit', message: 'API Error: rate limit' } });
    registry.hook(ev('UserPromptSubmit', { prompt: 'riprova' }));
    expect(agent.state).toBe('working');
    expect(agent.error).toBeUndefined();
  });

  it('ends a turn interrupted without Stop at the idle notification', () => {
    started();
    const agent = registry.agents.get(AGENT)!;
    registry.hook(ev('UserPromptSubmit', { prompt: 'vai' }));
    registry.hook(ev('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }));
    expect(agent.state).toBe('idle');
  });

  it('makes a new box for a new process that resumes an ended session', () => {
    started();
    registry.hook(ev('SessionEnd', { reason: 'other' }));
    registry.hook(ev('SessionStart', { source: 'resume' }), { pid: 5151 });
    expect(registry.agents.size).toBe(2);
    expect(registry.list()[1]).toMatchObject({ pid: 5151, sessionId: S1, state: 'starting', control: { kind: 'readonly' } });
  });
});

describe('sessions found without forchetta run', () => {
  it('creates a read-only box from any event and asks for its pid', () => {
    const onUnknownPid = vi.fn();
    fresh({ onUnknownPid });
    registry.hook(ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: `${CWD}/README.md` } }));
    const agent = registry.list()[0]!;
    expect(agent).toMatchObject({ state: 'working', control: { kind: 'readonly', reason: 'fuori-tmux' }, sessionId: S1, project: 'progetto' });
    expect(onUnknownPid).toHaveBeenCalled();
  });

  it('merges claude agents --json and the tmux panes', () => {
    fresh();
    registry.hook(ev('UserPromptSubmit', { prompt: 'vai' }));
    const known = registry.list()[0]!;
    const alive = (pid: number): boolean => pid !== 999;
    const changed = registry.reconcile(
      [
        { pid: 111, sessionId: S1, cwd: CWD, kind: 'interactive', status: 'busy' },
        { pid: 222, sessionId: S2, cwd: '/Users/dev/altro', kind: 'interactive', status: 'waiting', waitingFor: 'approve Bash' },
        { pid: 333, sessionId: 'bg', cwd: '/Users/dev/bg', kind: 'background', status: 'idle' },
        { pid: 444, sessionId: 'tm', cwd: '/Users/dev/tm', kind: 'interactive', status: 'idle' },
      ],
      [{ paneId: '%7', panePid: 444, session: 'fk-12345678' }],
      alive,
    );
    expect(changed).toBe(true);
    expect(known.pid).toBe(111);
    const [, other, background, inTmux] = registry.list();
    expect(other).toMatchObject({ project: 'altro', state: 'waiting', waiting: { detail: 'approve Bash' }, control: { reason: 'fuori-tmux' } });
    expect(background).toMatchObject({ kind: 'background', control: { kind: 'readonly', reason: 'background' } });
    expect(inTmux).toMatchObject({ control: { kind: 'tmux', session: 'fk-12345678', paneId: '%7' } });
  });

  it('corrects a stale state only after the hooks have been quiet', () => {
    fresh();
    registry.hook(ev('UserPromptSubmit', { prompt: 'vai' }), {});
    const agent = registry.list()[0]!;
    agent.pid = 111;
    registry.reconcile([{ pid: 111, sessionId: S1, status: 'idle' }], [], () => true);
    expect(agent.state).toBe('working');
    clock += QUIET_MS;
    registry.reconcile([{ pid: 111, sessionId: S1, status: 'idle' }], [], () => true);
    expect(agent.state).toBe('idle');
  });

  it('follows a /clear the hooks missed, and ends processes that are gone', () => {
    fresh();
    registry.hook(ev('UserPromptSubmit', { prompt: 'vai' }));
    const agent = registry.list()[0]!;
    agent.pid = 111;
    registry.reconcile([{ pid: 111, sessionId: S2, status: 'idle' }], [], () => true);
    expect(agent).toMatchObject({ sessionId: S2, pastSessionIds: [S1] });
    registry.checkAlive(() => false);
    expect(agent).toMatchObject({ state: 'ended', endReason: 'process ended' });
  });

  it('forgets ended sessions after the retention time', () => {
    started();
    registry.hook(ev('SessionEnd', { reason: 'other' }));
    clock += 61_000;
    expect(registry.sweep(60_000)).toEqual([AGENT]);
    expect(registry.agents.size).toBe(0);
  });
});
