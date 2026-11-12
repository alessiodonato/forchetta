import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { slimPayload } from '../src/daemon/server.ts';
import { type Agent, type HookPayload, markEnded, newAgent } from '../src/daemon/state.ts';
import {
  anySubagentActive,
  applySubagentHook,
  checkSubagents,
  FOREGROUND_ORPHAN_MS,
  readSubagentMeta,
  readSubagentThread,
  type SubagentMeta,
  subagentFile,
  subagentResultOf,
  SUBAGENTS_KEPT,
} from '../src/daemon/subagents.ts';
import { modelShort, nextChange, shownSubagents, SUBAGENT_SHOWN_MS, subagentDetail, subagentKey, subagentTime } from '../src/shared/present.ts';
import { toolLabel } from '../src/daemon/labels.ts';
import { defaultSubagent } from '../src/ui/store.ts';
import { tempDir } from './helpers.ts';

const temp = tempDir('subagents');
afterAll(() => temp.cleanup());

// The subagents of a session (daemon/subagents.ts): started by its Agent calls, followed through their events, ended
// by the result of the call or by their meta.json, read in their transcript. The shapes are those of Claude Code
// 2.1.322, seen in its transcripts and in the files next to them.

const T0 = 1_794_500_000_000;
const PARENT = '/Users/me/.claude/projects/-Users-me-app/1fd7d46c-686f-4264-8d47-cda69e628ad3.jsonl';
const SUB_ID = 'a7dcd64e6dc4a9723';
const SUB_FILE = `/Users/me/.claude/projects/-Users-me-app/1fd7d46c-686f-4264-8d47-cda69e628ad3/subagents/agent-${SUB_ID}.jsonl`;

function session(): Agent {
  const agent = newAgent({ id: 'a1', cwd: '/Users/me/app', control: { kind: 'readonly', reason: 'fuori-tmux' } }, T0);
  agent.transcriptPath = PARENT;
  agent.sessionId = '1fd7d46c-686f-4264-8d47-cda69e628ad3';
  agent.state = 'working';
  return agent;
}

const hook = (fields: Partial<HookPayload>): HookPayload => ({ hook_event_name: 'PreToolUse', session_id: '1fd7d46c-686f-4264-8d47-cda69e628ad3', transcript_path: PARENT, ...fields });

const agentCall = (input: Record<string, unknown>, id = 'toolu_01Rho'): HookPayload => hook({ tool_name: 'Agent', tool_use_id: id, tool_input: input });

const noMeta = (): SubagentMeta | undefined => undefined;

describe('what the hook input keeps of an Agent call', () => {
  it('the id of the call, and of its result only what says the subagent', () => {
    const payload = slimPayload({
      hook_event_name: 'PostToolUse',
      session_id: 's-1',
      tool_name: 'Agent',
      tool_use_id: 'toolu_01Rho',
      tool_input: { description: 'Find hook code', prompt: 'Look for…', subagent_type: 'Explore' },
      tool_response: { isAsync: true, status: 'async_launched', agentId: SUB_ID, description: 'Find hook code', resolvedModel: 'claude-haiku-5-5', prompt: 'Look for…', outputFile: '/tmp/x.output' },
    });
    expect(payload?.tool_use_id).toBe('toolu_01Rho');
    expect(payload?.subagent_result).toEqual({ status: 'async_launched', agentId: SUB_ID, model: 'claude-haiku-5-5', async: true });
    // The rest of the response is not kept.
    expect(payload?.tool_response).toBeUndefined();
  });

  it('the result of a subagent in the foreground: done, with its tokens', () => {
    const result = subagentResultOf('Agent', { status: 'completed', agentId: SUB_ID, agentType: 'web-fetch', content: [{ type: 'text', text: 'long report' }], resolvedModel: 'claude-opus-5-5', totalDurationMs: 70_000, totalTokens: 24_047, totalToolUseCount: 4 });
    expect(result).toEqual({ status: 'completed', agentId: SUB_ID, model: 'claude-opus-5-5', tokens: 24_047 });
  });

  it('nothing for another tool, or before the call ends', () => {
    expect(subagentResultOf('Bash', { stdout: 'x' })).toBeUndefined();
    expect(slimPayload({ hook_event_name: 'PreToolUse', session_id: 's-1', tool_name: 'Agent', tool_response: { agentId: SUB_ID } })?.subagent_result).toBeUndefined();
  });
});

describe('where the transcript of a subagent is', () => {
  it('next to the transcript of its session, in a folder named after the session', () => {
    expect(subagentFile(PARENT, SUB_ID)).toBe(SUB_FILE);
  });

  it('from the transcript of another subagent of the same session too', () => {
    expect(subagentFile(SUB_FILE.replace(SUB_ID, 'a0f2d6b9507104e06'), SUB_ID)).toBe(SUB_FILE);
  });

  it('nowhere without a transcript, or with an id that is not one', () => {
    expect(subagentFile(undefined, SUB_ID)).toBeUndefined();
    expect(subagentFile(PARENT, '../../etc')).toBeUndefined();
  });
});

describe('a subagent in the foreground', () => {
  it('starts with the Agent call, with what it was started with', () => {
    const agent = session();
    expect(applySubagentHook(agent, agentCall({ description: 'Find hook code', prompt: 'Look for the hooks.\nThen report.', subagent_type: 'Explore', model: 'haiku' }), T0, noMeta)).toBe(true);
    expect(agent.subagents).toEqual([{ type: 'Explore', description: 'Find hook code', prompt: 'Look for the hooks.\nThen report.', model: 'haiku', toolUseId: 'toolu_01Rho', state: 'running', startedAt: T0 }]);
  });

  it('a call without a type is a general-purpose subagent; a long task is cut', () => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'Big job', prompt: 'x'.repeat(5000) }), T0, noMeta);
    expect(agent.subagents?.[0]?.type).toBe('general-purpose');
    expect(agent.subagents?.[0]?.prompt).toHaveLength(1500);
  });

  it('its events, by its meta.json, show what it does; the result of the call ends it', () => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'Find hook code', prompt: 'Look', subagent_type: 'Explore' }), T0, noMeta);
    const meta = (file: string): SubagentMeta | undefined => (file === SUB_FILE ? { agentType: 'Explore', toolUseId: 'toolu_01Rho', background: false } : undefined);
    applySubagentHook(agent, hook({ agent_id: SUB_ID, agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'SubagentStart' } }), T0 + 4000, meta);
    const subagent = agent.subagents![0]!;
    expect(subagent).toMatchObject({ id: SUB_ID, transcript: SUB_FILE, background: false, tools: 1, action: { label: 'Grep "SubagentStart"', family: 'read', at: T0 + 4000 } });

    applySubagentHook(agent, hook({ agent_id: SUB_ID, agent_type: 'Explore', tool_name: 'Read', tool_input: { file_path: '/Users/me/app/src/a.ts' } }), T0 + 6000, meta);
    expect(subagent.action?.label).toBe('Read src/a.ts');
    expect(subagent.tools).toBe(2);

    applySubagentHook(agent, hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_01Rho', subagent_result: { status: 'completed', agentId: SUB_ID, model: 'claude-haiku-5-5', tokens: 9000 } }), T0 + 70_000, meta);
    expect(subagent).toMatchObject({ state: 'done', endedAt: T0 + 70_000, tokens: 9000, model: 'claude-haiku-5-5' });
  });

  it('without its meta.json, the oldest call of the same type not linked yet is its call', () => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'one', subagent_type: 'Explore' }, 'toolu_A'), T0, noMeta);
    applySubagentHook(agent, agentCall({ description: 'two', subagent_type: 'Plan' }, 'toolu_B'), T0 + 1, noMeta);
    applySubagentHook(agent, agentCall({ description: 'three', subagent_type: 'Explore' }, 'toolu_C'), T0 + 2, noMeta);
    applySubagentHook(agent, hook({ agent_id: 'aaa', agent_type: 'Explore', tool_name: 'Glob', tool_input: { pattern: '*.ts' } }), T0 + 10, noMeta);
    applySubagentHook(agent, hook({ agent_id: 'bbb', agent_type: 'Explore', tool_name: 'Glob', tool_input: { pattern: '*.md' } }), T0 + 11, noMeta);
    expect(agent.subagents?.map((subagent) => [subagent.description, subagent.id])).toEqual([
      ['one', 'aaa'],
      ['two', undefined],
      ['three', 'bbb'],
    ]);
  });

  it('a call that failed, and one that never got a subagent by the end of the turn', () => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'fails', subagent_type: 'Explore' }, 'toolu_A'), T0, noMeta);
    applySubagentHook(agent, agentCall({ description: 'denied', subagent_type: 'Plan' }, 'toolu_B'), T0, noMeta);
    applySubagentHook(agent, hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'toolu_A', error: 'Agent type not found' }), T0 + 100, noMeta);
    expect(agent.subagents?.[0]).toMatchObject({ state: 'failed', error: 'Agent type not found', endedAt: T0 + 100 });
    applySubagentHook(agent, hook({ hook_event_name: 'Stop' }), T0 + 200, noMeta);
    expect(agent.subagents?.[1]).toMatchObject({ state: 'stopped', endedAt: T0 + 200 });
  });

  it('stopped with its session: an interrupt sends no hook, and the session stays quiet', () => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'long', subagent_type: 'Explore' }), T0, noMeta);
    applySubagentHook(agent, hook({ agent_id: SUB_ID, agent_type: 'Explore', tool_name: 'Bash', tool_input: { command: 'npm test' } }), T0 + 1000, noMeta);
    agent.state = 'idle';
    agent.lastEvent = { name: 'Notification', at: T0 + 2000 };
    // Still at work for a while: maybe a long command.
    expect(checkSubagents(agent, T0 + 30_000, noMeta)).toBe(false);
    expect(checkSubagents(agent, T0 + 2000 + FOREGROUND_ORPHAN_MS + 1, noMeta)).toBe(true);
    expect(agent.subagents?.[0]?.state).toBe('stopped');
  });
});

describe('a subagent in the background', () => {
  it('stays at work after its call; its meta.json says when it finished', () => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'Tiny probe', prompt: 'ls', subagent_type: 'Explore', model: 'haiku', run_in_background: true }), T0, noMeta);
    applySubagentHook(agent, hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_01Rho', subagent_result: { status: 'async_launched', agentId: SUB_ID, model: 'claude-haiku-5-5', async: true } }), T0 + 50, noMeta);
    const subagent = agent.subagents![0]!;
    expect(subagent).toMatchObject({ id: SUB_ID, transcript: SUB_FILE, state: 'running', background: true, model: 'claude-haiku-5-5' });
    expect(anySubagentActive([agent])).toBe(true);

    // Its session ends its turn and waits: it goes on.
    agent.state = 'idle';
    applySubagentHook(agent, hook({ hook_event_name: 'Stop' }), T0 + 100, noMeta);
    let finished = false;
    const meta = (): SubagentMeta => ({ agentType: 'Explore', toolUseId: 'toolu_01Rho', background: true, finished });
    expect(checkSubagents(agent, T0 + 5 * 60_000, meta)).toBe(false);
    expect(subagent.state).toBe('running');
    finished = true;
    expect(checkSubagents(agent, T0 + 5 * 60_000 + 5000, meta)).toBe(true);
    expect(subagent).toMatchObject({ state: 'done', endedAt: T0 + 5 * 60_000 + 5000 });
    expect(anySubagentActive([agent])).toBe(false);
  });

  it('a message of the session starts it again: its next call, not the late end of the last one', () => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'probe', subagent_type: 'Explore', run_in_background: true }), T0, noMeta);
    applySubagentHook(agent, hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_01Rho', subagent_result: { agentId: SUB_ID, async: true } }), T0 + 10, noMeta);
    checkSubagents(agent, T0 + 30_000, () => ({ finished: true }));
    const subagent = agent.subagents![0]!;
    expect(subagent.state).toBe('done');
    applySubagentHook(agent, hook({ hook_event_name: 'PostToolUse', agent_id: SUB_ID, agent_type: 'Explore', tool_name: 'Bash', tool_input: { command: 'sleep 20' } }), T0 + 30_100, noMeta);
    expect(subagent.state).toBe('done');
    applySubagentHook(agent, hook({ agent_id: SUB_ID, agent_type: 'Explore', tool_name: 'Bash', tool_input: { command: 'sleep 15' } }), T0 + 90_000, noMeta);
    expect(subagent).toMatchObject({ state: 'running', action: { label: 'Bash sleep 15' } });
    expect(subagent.endedAt).toBeUndefined();
    // Claude Code took "finished" away when it started it again.
    expect(checkSubagents(agent, T0 + 95_000, () => ({ finished: false }))).toBe(false);
  });

  it('one the daemon did not see start comes from its meta.json', () => {
    const agent = session();
    const meta = (): SubagentMeta => ({ agentType: 'claude-code-guide', description: 'Verify slash commands', toolUseId: 'toolu_01DS', background: true, model: 'haiku' });
    applySubagentHook(agent, hook({ agent_id: SUB_ID, agent_type: 'claude-code-guide', tool_name: 'WebFetch', tool_input: { url: 'https://code.claude.com/docs/en/hooks' } }), T0, meta);
    expect(agent.subagents).toEqual([
      {
        type: 'claude-code-guide',
        description: 'Verify slash commands',
        toolUseId: 'toolu_01DS',
        background: true,
        model: 'haiku',
        id: SUB_ID,
        transcript: SUB_FILE,
        state: 'running',
        startedAt: T0,
        tools: 1,
        action: { label: 'WebFetch code.claude.com/docs/en/hooks', family: 'web', at: T0 },
      },
    ]);
  });
});

describe('the subagents a session keeps', () => {
  it('the last 20: the oldest finished ones go first, the running ones stay', () => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'kept', subagent_type: 'Explore', run_in_background: true }, 'toolu_keep'), T0, noMeta);
    for (let index = 0; index < 25; index++) {
      applySubagentHook(agent, agentCall({ description: `n${index}`, subagent_type: 'Explore' }, `toolu_${index}`), T0 + index + 1, noMeta);
      applySubagentHook(agent, hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: `toolu_${index}`, subagent_result: { status: 'completed' } }), T0 + index + 1, noMeta);
    }
    expect(agent.subagents).toHaveLength(SUBAGENTS_KEPT);
    expect(agent.subagents?.[0]?.description).toBe('kept');
    expect(agent.subagents?.at(-1)?.description).toBe('n24');
  });

  it('the end of the session stops the ones at work', () => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'bg', subagent_type: 'Explore', run_in_background: true }), T0, noMeta);
    markEnded(agent, 'process ended', T0 + 500);
    expect(agent.subagents?.[0]).toMatchObject({ state: 'stopped', endedAt: T0 + 500 });
  });

  it('an event of a subagent does not change the transcript of its session', async () => {
    const { applyHook } = await import('../src/daemon/state.ts');
    const agent = session();
    applyHook(agent, hook({ agent_id: SUB_ID, agent_type: 'Explore', transcript_path: SUB_FILE, tool_name: 'Read', tool_input: { file_path: '/x' } }), T0);
    expect(agent.transcriptPath).toBe(PARENT);
  });
});

describe('the meta.json of a subagent', () => {
  it('read as Claude Code writes it, at the start and at the end', () => {
    const dir = join(temp.dir, 'meta');
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, `agent-${SUB_ID}.jsonl`);
    writeFileSync(join(dir, `agent-${SUB_ID}.meta.json`), JSON.stringify({ agentType: 'Explore', isBuiltIn: true, description: 'Tiny probe', toolUseId: 'toolu_01Rho', spawnDepth: 1, requestShape: 'background', requestNonInteractive: true, model: 'haiku', pickedEffortModel: 'claude-opus-5-5' }));
    expect(readSubagentMeta(transcript)).toEqual({ agentType: 'Explore', description: 'Tiny probe', toolUseId: 'toolu_01Rho', background: true, model: 'haiku', finished: false });
    writeFileSync(join(dir, `agent-${SUB_ID}.meta.json`), JSON.stringify({ agentType: 'web-fetch', description: 'Check', toolUseId: 'toolu_X', requestShape: 'foreground', finished: true }));
    expect(readSubagentMeta(transcript)).toMatchObject({ background: false, finished: true });
    expect(readSubagentMeta(join(dir, 'agent-none.jsonl'))).toBeUndefined();
  });
});

describe('the transcript of a subagent', () => {
  const line = (entry: Record<string, unknown>): string => JSON.stringify({ parentUuid: null, isSidechain: true, agentId: SUB_ID, ...entry });

  it('its task, its calls with their results, its text and its report; nothing else', async () => {
    const file = join(temp.dir, `agent-${SUB_ID}.jsonl`);
    writeFileSync(
      file,
      [
        line({ type: 'user', message: { role: 'user', content: 'Run ls src/daemon, then report.' }, timestamp: '2026-11-12T15:03:10.000Z' }),
        line({ type: 'attachment', attachment: { type: 'skill_listing', content: 'x'.repeat(5000) } }),
        line({ type: 'user', message: { role: 'user', content: '<system-reminder> Your final report is delivered through SubagentHandback</system-reminder>' } }),
        JSON.stringify({ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'text', text: 'not a step' }] } }),
        line({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'thinking', thinking: '' }] } }),
        line({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls src/daemon', description: 'List' } }] }, timestamp: '2026-11-12T15:03:12.000Z' }),
        line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'arricurdai.ts\nattention.ts' }] }, toolUseResult: { stdout: '…' } }),
        line({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/Users/me/app/src/missing.ts' } }] } }),
        line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [{ type: 'text', text: 'File does not exist.' }] }] } }),
        line({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Two files found.' }] } }),
        line({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'toolu_3', name: 'SubagentHandback', input: { message: 'labels.ts builds the texts of the box.' } }] } }),
        line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: '{"success":true}' }] } }),
        line({ type: 'user', message: { role: 'user', content: 'One more tiny step: run sleep 15.' } }),
        'not json',
      ].join('\n'),
    );
    const thread = await readSubagentThread(file, '/Users/me/app');
    expect(thread.model).toBe('claude-haiku-5-5');
    expect(thread.steps).toEqual([
      { kind: 'prompt', text: 'Run ls src/daemon, then report.', at: Date.parse('2026-11-12T15:03:10.000Z') },
      { kind: 'tool', label: 'Bash ls src/daemon', family: 'shell', result: 'arricurdai.ts attention.ts', at: Date.parse('2026-11-12T15:03:12.000Z') },
      { kind: 'tool', label: 'Read src/missing.ts', family: 'read', result: 'File does not exist.', error: true },
      { kind: 'text', text: 'Two files found.' },
      { kind: 'report', text: 'labels.ts builds the texts of the box.' },
      { kind: 'message', text: 'One more tiny step: run sleep 15.' },
    ]);
  });

  it('a long one: the task, then the last steps', async () => {
    const file = join(temp.dir, 'agent-long.jsonl');
    const lines = [line({ type: 'user', message: { content: 'The task.' } })];
    for (let index = 0; index < 450; index++) lines.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: `step ${index}` }] } }));
    writeFileSync(file, lines.join('\n'));
    const thread = await readSubagentThread(file);
    expect(thread.skipped).toBe(51);
    expect(thread.steps[0]).toEqual({ kind: 'prompt', text: 'The task.' });
    expect(thread.steps[1]).toEqual({ kind: 'text', text: 'step 50' });
    expect(thread.steps.at(-1)).toEqual({ kind: 'text', text: 'step 449' });
  });
});

describe('how the box shows them', () => {
  const running = { type: 'Explore', description: 'Find hook code', model: 'claude-haiku-5-5', background: true, state: 'running' as const, startedAt: T0, action: { label: 'Grep "x"', family: 'read' as const, at: T0 } };

  it('a short model, a time, a second line', () => {
    expect(modelShort('claude-haiku-5-5')).toBe('haiku 5.5');
    expect(modelShort('claude-opus-4-6[1m]')).toBe('opus 4.6');
    expect(modelShort('claude-sonnet-4-20250514')).toBe('sonnet 4');
    expect(modelShort('claude-haiku-4-5-20251001')).toBe('haiku 4.5');
    expect(modelShort('haiku')).toBe('haiku');
    expect(modelShort(undefined)).toBeUndefined();
    expect(subagentTime(running, T0 + 2000)).toBe('starting');
    expect(subagentTime(running, T0 + 42_000)).toBe('40 s');
    expect(subagentTime({ ...running, state: 'done', endedAt: T0 + 70_000 }, T0 + 80_000)).toBe('done in 1 min');
    expect(subagentTime({ ...running, state: 'failed', endedAt: T0 + 1000 }, T0 + 80_000)).toBe('failed');
    expect(subagentDetail(running)).toBe('haiku 5.5 · background · Grep "x"');
    expect(subagentDetail({ type: 'Plan', state: 'running', startedAt: T0 })).toBe('thinking…');
  });

  it('those at work, then those ended in the last minutes, the latest first', () => {
    const subagents = [
      { type: 'a', state: 'done' as const, startedAt: T0, endedAt: T0 + 1000 },
      { type: 'b', state: 'running' as const, startedAt: T0 + 10 },
      { type: 'c', state: 'stopped' as const, startedAt: T0 + 20, endedAt: T0 + 5000 },
      { type: 'd', state: 'done' as const, startedAt: T0 - SUBAGENT_SHOWN_MS, endedAt: T0 - SUBAGENT_SHOWN_MS + 10 },
    ];
    expect(shownSubagents({ subagents }, T0 + 6000).map((subagent) => subagent.type)).toEqual(['b', 'c', 'a']);
    expect(shownSubagents({ subagents }, T0 + 1000 + SUBAGENT_SHOWN_MS).map((subagent) => subagent.type)).toEqual(['b', 'c']);
  });

  it('the page renders again when their time changes, and when an ended one leaves the box', () => {
    const agent = session();
    agent.lastEvent = { name: 'Stop', at: T0 - 3_600_000 * 3 };
    agent.subagents = [{ ...running, startedAt: T0 }];
    expect(nextChange(agent, T0 + 12_000)).toBe(T0 + 15_000);
    agent.subagents = [{ type: 'x', state: 'done', startedAt: T0, endedAt: T0 + 1000 }];
    expect(nextChange(agent, T0 + 2000)).toBe(T0 + 1000 + SUBAGENT_SHOWN_MS);
  });

  it('the panel opens on the last one still at work, else on the last one', () => {
    const agent = session();
    agent.subagents = [
      { type: 'a', state: 'running', startedAt: T0 },
      { type: 'b', state: 'running', startedAt: T0 + 1 },
      { type: 'c', state: 'done', startedAt: T0 + 2, endedAt: T0 + 3 },
    ];
    expect(defaultSubagent(agent)).toBe(subagentKey({ type: 'b', startedAt: T0 + 1 }));
    agent.subagents = agent.subagents.map((subagent) => ({ ...subagent, state: 'done' as const }));
    expect(defaultSubagent(agent)).toBe('c@' + String(T0 + 2));
    expect(defaultSubagent(undefined)).toBeUndefined();
  });
});

describe('what changes the box', () => {
  it('a call of a subagent, its first event, its end; not the other events', () => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'x', subagent_type: 'Explore' }), T0, noMeta);
    expect(applySubagentHook(agent, hook({ hook_event_name: 'Notification', agent_id: SUB_ID, agent_type: 'Explore' }), T0 + 1, noMeta)).toBe(true);
    expect(applySubagentHook(agent, hook({ hook_event_name: 'PostToolUse', agent_id: SUB_ID, agent_type: 'Explore', tool_name: 'Read', tool_input: {} }), T0 + 2, noMeta)).toBe(false);
    expect(applySubagentHook(agent, hook({ agent_id: SUB_ID, agent_type: 'Explore', tool_name: 'Read', tool_input: {} }), T0 + 3, noMeta)).toBe(true);
    expect(applySubagentHook(agent, hook({ hook_event_name: 'SubagentStop', agent_id: SUB_ID, agent_type: 'Explore' }), T0 + 4, noMeta)).toBe(true);
    expect(agent.subagents?.[0]?.state).toBe('done');
    expect(applySubagentHook(agent, hook({ hook_event_name: 'SubagentStop', agent_id: SUB_ID, agent_type: 'Explore' }), T0 + 5, noMeta)).toBe(false);
  });
});

describe('a subagent that waits for work of its own in the background', () => {
  // Seen with 2.1.322: a subagent ran `sleep 60` with run_in_background and stopped to wait. Claude Code wrote
  // "finished" and said it "is waiting on its own background work"; 55 s later it started it again, with a call.
  const background = (): Agent => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'sleep', subagent_type: 'general-purpose', run_in_background: true }), T0, noMeta);
    applySubagentHook(agent, hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_01Rho', subagent_result: { agentId: SUB_ID, async: true } }), T0 + 10, noMeta);
    applySubagentHook(agent, hook({ agent_id: SUB_ID, agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'sleep 60', run_in_background: true } }), T0 + 1000, noMeta);
    return agent;
  };

  it('stopped with work in the background and no report: waiting, not done', () => {
    const agent = background();
    const subagent = agent.subagents![0]!;
    expect(subagent.backgroundWork).toBe(true);
    expect(checkSubagents(agent, T0 + 5000, () => ({ finished: true }))).toBe(true);
    expect(subagent.state).toBe('waiting');
    expect(subagent.endedAt).toBeUndefined();
    // Still read while it waits, and still in the box.
    expect(anySubagentActive([agent])).toBe(true);
    expect(checkSubagents(agent, T0 + 30_000, () => ({ finished: true }))).toBe(false);
    expect(shownSubagents(agent, T0 + 60 * 60_000)).toEqual([subagent]);
    expect(subagentTime(subagent, T0 + 30_000)).toBe('waiting');
    expect(subagentDetail(subagent)).toBe('background · waits for its work in the background');
  });

  it('started again by the end of that work: at work at its next call, done after its report', () => {
    const agent = background();
    const subagent = agent.subagents![0]!;
    checkSubagents(agent, T0 + 5000, () => ({ finished: true }));
    applySubagentHook(agent, hook({ agent_id: SUB_ID, agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'date +%T' } }), T0 + 61_000, noMeta);
    expect(subagent).toMatchObject({ state: 'running', action: { label: 'Bash date +%T' } });
    applySubagentHook(agent, hook({ agent_id: SUB_ID, agent_type: 'general-purpose', tool_name: 'SubagentHandback', tool_input: { message: 'It is 16:41:34.' } }), T0 + 62_000, noMeta);
    expect(subagent).toMatchObject({ reported: true, action: { label: 'sending its report', family: 'agent' } });
    expect(checkSubagents(agent, T0 + 65_000, () => ({ finished: true }))).toBe(true);
    expect(subagent).toMatchObject({ state: 'done', endedAt: T0 + 65_000 });
  });

  it('started again with no call seen: Claude Code took "finished" away', () => {
    const agent = background();
    checkSubagents(agent, T0 + 5000, () => ({ finished: true }));
    expect(checkSubagents(agent, T0 + 61_000, () => ({ finished: false }))).toBe(true);
    expect(agent.subagents?.[0]?.state).toBe('running');
  });

  it('a new task after its report starts clean: its old work in the background does not count', () => {
    const agent = background();
    const subagent = agent.subagents![0]!;
    applySubagentHook(agent, hook({ agent_id: SUB_ID, agent_type: 'general-purpose', tool_name: 'SubagentHandback', tool_input: { message: 'ok' } }), T0 + 2000, noMeta);
    checkSubagents(agent, T0 + 5000, () => ({ finished: true }));
    expect(subagent.state).toBe('done');
    applySubagentHook(agent, hook({ agent_id: SUB_ID, agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'ls' } }), T0 + 90_000, noMeta);
    expect(subagent).toMatchObject({ state: 'running' });
    expect(subagent.backgroundWork).toBeUndefined();
    expect(subagent.reported).toBeUndefined();
    // It stops with no report and nothing in the background: done.
    checkSubagents(agent, T0 + 95_000, () => ({ finished: true }));
    expect(subagent.state).toBe('done');
  });

  it('the end of its session stops it', () => {
    const agent = background();
    checkSubagents(agent, T0 + 5000, () => ({ finished: true }));
    markEnded(agent, 'process ended', T0 + 9000);
    expect(agent.subagents?.[0]).toMatchObject({ state: 'stopped', endedAt: T0 + 9000 });
  });
});

describe('foreground or background', () => {
  it('unknown until Claude Code says it: a call that asks nothing may go to the background', () => {
    const agent = session();
    applySubagentHook(agent, agentCall({ description: 'x', subagent_type: 'Explore' }), T0, noMeta);
    expect(agent.subagents?.[0]?.background).toBeUndefined();
    applySubagentHook(agent, hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_01Rho', subagent_result: { status: 'completed', agentId: SUB_ID } }), T0 + 9000, noMeta);
    expect(agent.subagents?.[0]).toMatchObject({ background: false, state: 'done' });
  });
});

describe('the report and the notices in the transcript', () => {
  const line = (entry: Record<string, unknown>): string => JSON.stringify({ isSidechain: true, agentId: SUB_ID, ...entry });

  it('the end of its work in the background is a notice; a message of the session loses the words around it', async () => {
    const file = join(temp.dir, 'agent-notice.jsonl');
    const notice = '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n\n<task-notification>\n<task-id>bimjxy9nq</task-id>\n<status>completed</status>\n<summary>Background command "Sleep for 60 seconds in background" completed (exit code 0)</summary>\n</task-notification>';
    const message = 'The coordinator sent a message while you were working:\nOne more step: run date.\n\nAddress this before completing your current task.';
    writeFileSync(file, [line({ type: 'user', message: { content: 'Sleep, then tell the time.' } }), line({ type: 'user', message: { content: notice } }), line({ type: 'user', message: { content: message } }), line({ type: 'user', message: { content: '<task-notification>\n<status>failed</status>\n</task-notification>' } })].join('\n'));
    const thread = await readSubagentThread(file);
    expect(thread.steps).toEqual([
      { kind: 'prompt', text: 'Sleep, then tell the time.' },
      { kind: 'notice', text: 'Background command "Sleep for 60 seconds in background" completed (exit code 0)' },
      { kind: 'message', text: 'One more step: run date.' },
      { kind: 'notice', text: 'Work in the background: failed' },
    ]);
  });

  it('the call that sends its report has a name of its own in the box', () => {
    expect(toolLabel('SubagentHandback', { message: 'long report' })).toEqual({ label: 'sending its report', family: 'agent' });
  });
});

describe('a new conversation in the same session', () => {
  const withSubagents = (): Agent => {
    const agent = session();
    agent.subagents = [
      { type: 'Explore', description: 'old, done', state: 'done', startedAt: T0, endedAt: T0 + 1000 },
      { type: 'Plan', description: 'old, failed', state: 'failed', startedAt: T0, endedAt: T0 + 500 },
      { type: 'general-purpose', description: 'still at work', state: 'running', startedAt: T0 + 2000 },
      { type: 'general-purpose', description: 'waiting', state: 'waiting', startedAt: T0 + 3000 },
    ];
    return agent;
  };

  it('/clear forgets the subagents that ended; those at work or waiting stay until they end', async () => {
    const { applyHook } = await import('../src/daemon/state.ts');
    const agent = withSubagents();
    applyHook(agent, { hook_event_name: 'SessionStart', session_id: 'new-session', source: 'clear' }, T0 + 10_000);
    expect(agent.subagents?.map((subagent) => subagent.description)).toEqual(['still at work', 'waiting']);
  });

  it('/resume too; with none at work, the list goes, and the button with it', async () => {
    const { applyHook } = await import('../src/daemon/state.ts');
    const agent = withSubagents();
    agent.subagents = agent.subagents!.slice(0, 2);
    applyHook(agent, { hook_event_name: 'SessionStart', session_id: 'other-session', source: 'resume' }, T0 + 10_000);
    expect(agent.subagents).toBeUndefined();
  });

  it('a /clear that only claude agents reports does the same', async () => {
    const { Registry } = await import('../src/daemon/registry.ts');
    const registry = new Registry({ now: () => T0 + 20_000 });
    const agent = withSubagents();
    agent.pid = 4242;
    registry.restore([agent]);
    registry.reconcile([{ pid: 4242, sessionId: 'after-clear', status: 'idle' }], [], () => true);
    expect(agent.sessionId).toBe('after-clear');
    expect(agent.subagents?.map((subagent) => subagent.state)).toEqual(['running', 'waiting']);
    registry.dispose();
  });

  it('the same conversation going on keeps them', async () => {
    const { applyHook } = await import('../src/daemon/state.ts');
    const agent = withSubagents();
    applyHook(agent, { hook_event_name: 'SessionStart', session_id: agent.sessionId!, source: 'compact' }, T0 + 10_000);
    expect(agent.subagents).toHaveLength(4);
  });
});
