import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderLost } from '../src/cli/reopen.ts';
import { makeStyle } from '../src/cli/style.ts';
import { cliApi } from '../src/daemon/cli-api.ts';
import { Crews } from '../src/daemon/crews.ts';
import { Registry } from '../src/daemon/registry.ts';
import { type ReopenDeps, Reopener } from '../src/daemon/reopen.ts';
import { claudeArgs, startCommand } from '../src/daemon/spawn.ts';
import { newAgent } from '../src/daemon/state.ts';
import type { Agent, QueuedCommand } from '../src/shared/agent.ts';
import type { CrewSpec } from '../src/shared/crew.ts';
import { endedAtShutdown, endedByRestart, lostOf, lostText, modelAlias, REOPEN_KEEP_MS } from '../src/shared/reopen.ts';
import { MACHINE } from '../src/shared/machine.ts';
import { tempDir } from './helpers.ts';

const temp = tempDir('reopen');
afterAll(() => temp.cleanup());

const BOOT = new Date(2026, 10, 22, 8, 0).getTime();
const session = (patch: Partial<Agent> = {}): Agent =>
  newAgent({ id: randomUUID(), control: { kind: 'tmux', session: 'fk-1', paneId: '%1' }, cwd: '/Users/you/Desktop/shop', sessionId: randomUUID(), state: 'idle', ...patch }, BOOT - 3_600_000);

describe('the sessions that ended with the Mac', () => {
  it('are those whose last sign of life came before the Mac started', () => {
    const before = session({ lastEvent: { name: 'Stop', at: BOOT - 60_000 } });
    const after = session({ lastEvent: { name: 'Stop', at: BOOT + 60_000 } });
    const ended = session({ state: 'ended', lastEvent: { name: 'SessionEnd', at: BOOT - 60_000 } });
    const newer = { ...session({ lastEvent: { name: 'creata', at: BOOT - 1 } }), createdAt: BOOT + 1000 };
    expect(endedByRestart([before, after, ended, newer], BOOT)).toEqual([before]);
  });

  it('and those the shutdown ended while the daemon still listened, not on purpose', () => {
    const savedAt = BOOT - 8 * 3_600_000;
    const stopped = { ...session(), state: 'ended' as const, endedAt: savedAt - 30_000, endReason: 'other' };
    const died = { ...session(), state: 'ended' as const, endedAt: savedAt - 60_000, endReason: 'process ended' };
    const exited = { ...session(), state: 'ended' as const, endedAt: savedAt - 30_000, endReason: 'prompt_input_exit' };
    const earlier = { ...session(), state: 'ended' as const, endedAt: savedAt - 3_600_000, endReason: 'other' };
    expect(endedAtShutdown([stopped, died, exited, earlier, session()], savedAt, BOOT)).toEqual([stopped, died]);
    // No restart since the last save (the daemon alone restarted): nothing.
    expect(endedAtShutdown([stopped], BOOT + 1000, BOOT)).toEqual([]);
  });

  it('reopen with their conversation, folder, name, model, place in the window and context', () => {
    const agent = session({ name: 'api work', model: 'claude-opus-5-5', team: { label: 'api', color: 'blue' }, context: { tokens: 412_000, window: 1_000_000, percent: 41, at: 0 }, endedAt: BOOT - 10 });
    expect(lostOf(agent, BOOT)).toEqual({ agentId: agent.id, sessionId: agent.sessionId, cwd: '/Users/you/Desktop/shop', project: 'shop', name: 'api work', model: 'claude-opus-5-5', team: { label: 'api', color: 'blue' }, contextTokens: 412_000, endedAt: BOOT - 10 });
    // Without a conversation, or a folder, there is nothing to reopen.
    expect(lostOf(session({ sessionId: undefined }), BOOT)).toBeUndefined();
    expect(lostOf(session({ sessionId: 'not-a-session' }), BOOT)).toBeUndefined();
    expect(lostOf(session({ cwd: undefined }), BOOT)).toBeUndefined();
    expect(modelAlias('claude-sonnet-5-5[1m]')).toBe('sonnet');
    expect(modelAlias('claude-haiku-5-5')).toBe('haiku');
    expect(modelAlias('gpt')).toBeUndefined();
    const lost = [agent, session({ cwd: '/Users/you/b' }), session({ team: { label: 'lead', crew: 'c', group: 'Studio' } }), session({ team: { label: 'dev', crew: 'c', group: 'Studio' } })].map((one) => lostOf(one, BOOT)!);
    expect(lostText(lost)).toBe('api, b and the team Studio (2)');
  });

  it('go on with --resume, a session id and nothing else', () => {
    const id = randomUUID();
    expect(claudeArgs({ model: 'opus', resume: id })).toEqual({ args: ['--model', 'opus', '--resume', id] });
    expect(claudeArgs({ resume: 'x; rm -rf ~' })).toEqual({ error: 'invalid conversation to resume' });
    expect(startCommand('/bin/zsh', '/s', '/c', ['--resume', id])).toEqual(['/bin/zsh', '-l', '-i', '-c', `exec '/s' '/c' '--resume' '${id}'`]);
  });
});

/** A Reopener with sessions that start at once, and a team. */
function world(options: { file?: string; now?: number } = {}) {
  const agents = new Map<string, Agent>();
  const started: { input: Parameters<ReopenDeps['spawn']>[0]; extras: Parameters<ReopenDeps['spawn']>[1] }[] = [];
  const forgotten: string[] = [];
  const crewCalls: string[] = [];
  let crewAnswer: ReturnType<ReopenDeps['crewReopen']>;
  const reopener = new Reopener({
    file: options.file,
    log: () => {},
    agent: (id) => agents.get(id),
    agents: () => agents.values(),
    isFolder: (dir) => dir.startsWith('/Users/you/'),
    spawn: async (input, extras) => {
      started.push({ input, extras });
      const id = randomUUID();
      agents.set(id, { ...session({ cwd: input.cwd, sessionId: input.resume }), id });
      return { ok: true, agentId: id };
    },
    crewReopen: (crewId, agentId) => {
      crewCalls.push(`${crewId} ${agentId}`);
      return crewAnswer;
    },
    forget: (id) => {
      forgotten.push(id);
      agents.delete(id);
    },
    onChange: () => {},
    now: () => options.now ?? BOOT + 60_000,
  });
  return { agents, started, forgotten, crewCalls, reopener, setCrewAnswer: (answer: ReturnType<ReopenDeps['crewReopen']>) => (crewAnswer = answer) };
}

describe('reopening', () => {
  it('a session alone: on its conversation, in its folder, with its name, color and model; its old box goes', async () => {
    const file = join(temp.dir, 'reopen.json');
    const w = world({ file });
    const old = { ...session({ name: 'api work', model: 'claude-opus-5-5', team: { label: 'api', color: 'blue' } }), state: 'ended' as const, endedAt: BOOT };
    w.agents.set(old.id, old);
    expect(w.reopener.remember([old])).toBe(1);
    expect(w.reopener.remember([old])).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toHaveLength(1);
    const outcome = await w.reopener.reopen([old.id]);
    expect(outcome.reopened).toEqual([{ agentId: old.id, newAgentId: expect.any(String), name: 'api' }]);
    expect(w.started).toEqual([{ input: { cwd: '/Users/you/Desktop/shop', model: 'opus', resume: old.sessionId }, extras: { name: 'api work', team: { label: 'api', color: 'blue' } } }]);
    expect(w.forgotten).toEqual([old.id]);
    expect(w.reopener.list()).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toEqual([]);
  });

  it('never a conversation twice, nor in a folder that is gone; not now forgets them', async () => {
    const w = world();
    const open = session();
    const lost = { ...session({ sessionId: open.sessionId }), state: 'ended' as const };
    const gone = { ...session({ cwd: '/elsewhere/old' }), state: 'ended' as const };
    w.agents.set(open.id, open);
    w.reopener.remember([lost, gone]);
    const outcome = await w.reopener.reopen([lost.id, gone.id, 'nobody']);
    expect(outcome.reopened).toEqual([]);
    expect(outcome.failed).toEqual([
      { agentId: lost.id, name: 'shop', error: 'its conversation is already open in a session' },
      { agentId: gone.id, name: 'old', error: 'its folder /elsewhere/old is gone' },
      { agentId: 'nobody', name: 'nobody', error: 'nothing to reopen: the session is not ended, or its conversation is not known' },
    ]);
    // The folder may come back (a disk mounted again): offered still; the one open, no more.
    expect(w.reopener.list().map((one) => one.agentId)).toEqual([gone.id]);
    w.reopener.dismiss();
    expect(w.reopener.list()).toEqual([]);
    expect(w.started).toEqual([]);
  });

  it('a member of a team goes back into its team; when its team does not take it back, it reopens alone with its name and color', async () => {
    const w = world();
    const member = { ...session({ team: { label: 'developer', crew: 'crew-1', group: 'Studio', talk: 'twoway', color: 'cyan' } }), state: 'ended' as const };
    w.reopener.remember([member]);
    w.setCrewAnswer(Promise.resolve({ ok: true, agentId: 'new-developer' }));
    expect((await w.reopener.reopen([member.id])).reopened).toEqual([{ agentId: member.id, newAgentId: 'new-developer', name: 'developer' }]);
    expect(w.crewCalls).toEqual([`crew-1 ${member.id}`]);
    expect(w.started).toEqual([]);

    const again = { ...session({ team: { label: 'tester', crew: 'crew-2', group: 'Old', talk: 'oneway', color: 'pink' } }), state: 'ended' as const };
    w.reopener.remember([again]);
    w.setCrewAnswer(undefined);
    await w.reopener.reopen([again.id]);
    expect(w.started[0]!.extras).toEqual({ team: { label: 'tester', color: 'pink' } });
  });

  it('a box still on screen reopens too; what was offered expires after a week', async () => {
    const w = world();
    const ended = { ...session(), state: 'ended' as const, endReason: 'process ended' };
    w.agents.set(ended.id, ended);
    expect((await w.reopener.reopen([ended.id])).reopened).toHaveLength(1);
    const file = join(temp.dir, 'old.json');
    const first = world({ file, now: BOOT });
    first.reopener.remember([{ ...session(), state: 'ended', endedAt: BOOT }]);
    expect(world({ file, now: BOOT + REOPEN_KEEP_MS - 1 }).reopener.list()).toHaveLength(1);
    expect(world({ file, now: BOOT + REOPEN_KEEP_MS + 1 }).reopener.list()).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});

describe('a member of a team reopened', () => {
  it('starts with its prompt, tools and folder on its conversation, takes its place, and what it was doing is to send again', async () => {
    const crews = new Crews(undefined);
    const starts: { input: Record<string, unknown>; extras: Record<string, unknown> }[] = [];
    crews.enqueue = (_agentId, text, link) => ({ ok: true, command: { id: randomUUID(), kind: 'request', arg: text, request: link, status: 'in-coda', createdAt: 0 } as QueuedCommand });
    let n = 0;
    const start = async (input: Record<string, unknown>, extras: Record<string, unknown>) => {
      starts.push({ input, extras });
      return { ok: true as const, agentId: `agent-${++n}` };
    };
    const spec: CrewSpec = { name: 'Studio', cwd: '/Users/you/shop', talk: 'twoway', lead: { kind: 'claude', name: 'lead', role: 'Leads.', model: 'opus' }, members: [{ name: 'developer', role: 'Builds.', model: 'sonnet', mode: 'acceptEdits' }] };
    const created = await crews.create(spec, start as never);
    expect(created).toMatchObject({ ok: true });
    const crew = crews.get(created.crewId!)!;
    const oldDeveloper = crew.agents.developer!;
    crews.request(crew.id, ['developer'], 'Write the export');
    crew.requests![0]!.deliveries[0]!.status = 'working';
    const sessionId = randomUUID();
    const reopened = await crews.reopen(crew.id, oldDeveloper, sessionId, '/Users/you/shop/.claude/worktrees/developer', start as never);
    expect(reopened).toEqual({ ok: true, agentId: 'agent-3' });
    const last = starts.at(-1)!;
    expect(last.input).toEqual({ cwd: '/Users/you/shop/.claude/worktrees/developer', model: 'sonnet', mode: 'acceptEdits', resume: sessionId });
    expect(last.extras).toMatchObject({ name: 'developer', team: { label: 'developer', crew: crew.id, group: 'Studio' }, teamTools: expect.any(Array) });
    expect(String(last.extras.system)).toContain('developer');
    expect(crews.get(crew.id)!.agents.developer).toBe('agent-3');
    expect(crews.get(crew.id)!.requests![0]!.deliveries[0]).toMatchObject({ status: 'failed', reason: `its session ended with the ${MACHINE}: send it again`, agentId: 'agent-3' });
    // The lead too, as lead.
    const lead = await crews.reopen(crew.id, crew.agents.lead!, randomUUID(), '/Users/you/shop', start as never);
    expect(lead).toMatchObject({ ok: true });
    expect(starts.at(-1)!.extras).toMatchObject({ name: 'lead', team: { lead: true } });
    // A session that is not (or no more) in the team, or a team stopped: not taken back.
    expect(crews.reopen(crew.id, 'someone-else', randomUUID(), '/x', start as never)).toBeUndefined();
    crews.stop(crew.id, 'stopped by you', () => {});
    expect(crews.reopen(crew.id, crews.get(crew.id)!.agents.developer!, randomUUID(), '/x', start as never)).toBeUndefined();
  });
});

describe('a box forgotten, and the command line', () => {
  it('the registry forgets a session that ended, not one alive', () => {
    const removed: string[][] = [];
    const registry = new Registry({ onRemove: (ids) => removed.push([...ids]) });
    registry.register({ id: 'a', cwd: '/x', tmuxSession: 'fk-a' });
    registry.forget('a');
    expect(registry.agents.has('a')).toBe(true);
    registry.agents.get('a')!.state = 'ended';
    registry.forget('a');
    expect(registry.agents.has('a')).toBe(false);
    expect(removed).toEqual([['a']]);
    registry.dispose();
  });

  it('forchetta reopen lists them, and reopens all of them or those named (a team: all its sessions)', async () => {
    const w = world();
    const alone = { ...session({ cwd: '/Users/you/Desktop/api' }), state: 'ended' as const };
    const lead = { ...session({ team: { label: 'lead', crew: 'c', group: 'Studio' }, context: { tokens: 790_000, window: 1e6, percent: 79, at: 0 } }), state: 'ended' as const };
    const dev = { ...session({ team: { label: 'dev', crew: 'c', group: 'Studio' } }), state: 'ended' as const };
    w.reopener.remember([alone, lead, dev]);
    w.setCrewAnswer(Promise.resolve({ ok: true, agentId: randomUUID() }));
    const handle = cliApi({
      crews: { list: () => [], get: () => undefined, create: async () => ({ ok: false, error: 'no' }), request: () => ({ ok: false, error: 'no' }), reviewsOf: () => [] },
      templates: { list: () => [] },
      agent: () => undefined,
      importTeam: async () => ({ ok: false, error: 'no' }),
      folderOf: (path) => path,
      withRepoRules: (spec) => spec,
      log: () => {},
      reopen: w.reopener,
    });
    const listed = (await handle('GET', '/api/reopen', new URLSearchParams(), {}))!.body as { sessions: unknown[] };
    expect(listed.sessions).toHaveLength(3);
    const text = renderLost(w.reopener.list(), { style: makeStyle(0) });
    expect(text).toContain(`3 sessions ended with the ${MACHINE}:`);
    expect(text).toContain('lead  /Users/you/Desktop/shop · team Studio · 790k of context');
    expect(await handle('POST', '/api/reopen', new URLSearchParams(), { names: ['nobody'] })).toMatchObject({ status: 404 });
    const studio = (await handle('POST', '/api/reopen', new URLSearchParams(), { names: ['studio'] }))!.body as { reopened: { name: string }[] };
    expect(studio.reopened.map((one) => one.name)).toEqual(['lead', 'dev']);
    const rest = (await handle('POST', '/api/reopen', new URLSearchParams(), { all: true }))!.body as { reopened: { name: string }[] };
    expect(rest.reopened.map((one) => one.name)).toEqual(['api']);
    expect(await handle('POST', '/api/reopen', new URLSearchParams(), { all: true })).toMatchObject({ status: 404, body: { error: `no session ended with the ${MACHINE} is waiting to reopen` } });
  });
});
