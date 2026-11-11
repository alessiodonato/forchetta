import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { crewApi, CrewTemplates, Crews, shortRole } from '../src/daemon/crews.ts';
import type { SpawnChoices, SpawnExtras } from '../src/daemon/spawn.ts';
import { Teams } from '../src/daemon/teams.ts';
import { newAgent } from '../src/daemon/state.ts';
import type { Agent } from '../src/shared/agent.ts';
import { BUILTIN_TEMPLATES, cleanTemplate, worktreeName, type CrewRequest, type CrewSummary, cleanCrewSpec, templateOf, type CrewSpec, crewLineOf, DEFAULT_LEAD_ROLE, effectiveTalk, leadPrompt, MAX_OPEN_DELIVERIES, memberPrompt, teamToolsFor, threadOf } from '../src/shared/crew.ts';
import { panesToOpen } from '../src/ui/store.ts';
import { groupsOf, ledByYou, roleText } from '../src/ui/Team.tsx';
import { entryHead, entryTag, recipientText, toggleRecipient } from '../src/ui/TeamRequests.tsx';
import type { QueuedCommand } from '../src/shared/agent.ts';
import { draftsOf, specOf } from '../src/ui/NewTeam.tsx';
import { tempDir } from './helpers.ts';

// Teams of agents: a lead (Claude or you) and members that execute (→) or also answer (⇄).

const temp = tempDir('crews');
afterAll(() => temp.cleanup());

const spec = (patch: Record<string, unknown> = {}): unknown => ({
  name: 'checkout',
  cwd: '/Users/dev/shop',
  lead: { kind: 'claude', name: 'lead', role: 'Split the work.' },
  talk: 'twoway',
  members: [
    { name: 'tester', role: 'Write and run the tests.' },
    { name: 'formatter', role: 'Format the code.', talk: 'oneway' },
  ],
  ...patch,
});

const checked = (input: unknown): CrewSpec => {
  const result = cleanCrewSpec(input);
  if ('error' in result) throw new Error(result.error);
  return result.spec;
};

describe('the spec of a team', () => {
  it('keeps what the panel wrote, trimmed, with the default of the team for who has no choice', () => {
    const crew = checked(spec({ name: '  checkout  ', members: [{ name: ' tester ', role: '  Write\r\nthe tests ' }] }));
    expect(crew.name).toBe('checkout');
    expect(crew.members).toEqual([{ name: 'tester', role: 'Write\nthe tests' }]);
    expect(effectiveTalk(crew, crew.members[0]!)).toBe('twoway');
    expect(checked(spec()).members[1]).toMatchObject({ talk: 'oneway' });
  });

  it('gives a lead with no role, and a member with no role, a sentence of their own', () => {
    const crew = checked(spec({ lead: { kind: 'claude', name: 'boss' }, members: [{ name: 'dev' }] }));
    expect(crew.lead).toEqual({ kind: 'claude', name: 'boss', role: DEFAULT_LEAD_ROLE });
    expect(crew.members[0]!.role).toContain('Help the team');
  });

  it('refuses what cannot become a team, saying why', () => {
    const error = (input: unknown) => (cleanCrewSpec(input) as { error: string }).error;
    expect(error(spec({ name: ' ' }))).toContain('name');
    expect(error(spec({ cwd: '' }))).toContain('folder');
    expect(error(spec({ members: [] }))).toContain('at least one');
    expect(error(spec({ members: Array.from({ length: 7 }, (_, i) => ({ name: `m${i}` })) }))).toContain('6 members');
    expect(error(spec({ members: [{ name: 'Tester' }, { name: 'tester' }] }))).toContain('two members');
    expect(error(spec({ members: [{ name: 'lead' }] }))).toContain('two members');
    expect(error(spec({ members: [{ name: '-x' }] }))).toContain('start with a letter');
    expect(error(spec({ members: [{ name: 'a', model: 'gpt' }] }))).toContain('model');
  });

  it('a team led by you has no Claude lead, and "you" is not a name for a member', () => {
    const crew = checked(spec({ lead: { kind: 'you' } }));
    expect(crew.lead).toEqual({ kind: 'you' });
    expect(leadPrompt(crew)).toBe('');
    expect((cleanCrewSpec(spec({ lead: { kind: 'you' }, members: [{ name: 'You' }] })) as { error: string }).error).toContain('two members');
  });
});

describe('who each session is', () => {
  const crew = checked(spec());

  it('the lead knows its team, and who answers', () => {
    const text = leadPrompt(crew);
    expect(text).toContain('You are lead, the lead of the team "checkout"');
    expect(text).toContain('Your role: Split the work.');
    expect(text).toContain('- tester (answers you): Write and run the tests.');
    expect(text).toContain('- formatter (executes only, no answer): Format the code.');
  });

  it('a member knows its role, its lead, how requests come, and whether it reports back', () => {
    const tester = memberPrompt(crew, crew.members[0]!);
    expect(tester).toContain('You are tester, a member of the team "checkout"');
    expect(tester).toContain('Your lead is lead, another Claude Code session.');
    expect(tester).toContain('"Request #<n> from lead:"');
    expect(tester).toContain('your final message goes back to your lead');
    expect(tester).toContain('- formatter: Format the code.');
    const formatter = memberPrompt(crew, crew.members[1]!);
    expect(formatter).toContain('is not sent to your lead');
    expect(memberPrompt(checked(spec({ lead: { kind: 'you' } })), crew.members[0]!)).toContain('Your lead is the user, from the Forchetta app.');
  });
});

describe('starting a team', () => {
  const fake = () => {
    const calls: { choices: SpawnChoices & { cwd: string }; extras: SpawnExtras }[] = [];
    let next = 0;
    const start = async (choices: SpawnChoices & { cwd: string }, extras: SpawnExtras) => {
      calls.push({ choices, extras });
      return { ok: true as const, agentId: `agent-${++next}` };
    };
    return { calls, start };
  };

  it('starts the lead first, then the members, each with its name, its prompt and its place in the chart', async () => {
    const crews = new Crews(join(temp.dir, 'one'));
    crews.inGit = () => true;
    const { calls, start } = fake();
    const crew = checked(spec({ members: [{ name: 'tester', role: 'Write and run the tests.', model: 'haiku' }, { name: 'formatter', role: 'Format.', talk: 'oneway', worktree: true }] }));
    const result = await crews.create(crew, start, 1000);
    expect(result).toMatchObject({ ok: true, agentIds: ['agent-1', 'agent-2', 'agent-3'] });
    expect(calls.map((call) => call.extras.name)).toEqual(['lead', 'tester', 'formatter']);
    expect(calls[0]!.extras.team).toEqual({ label: 'lead', role: 'Split the work.', lead: true, group: 'checkout', crew: result.crewId });
    expect(calls[1]!.extras.team).toMatchObject({ label: 'tester', talk: 'twoway', group: 'checkout' });
    expect(calls[2]!.extras.team).toMatchObject({ talk: 'oneway' });
    expect(calls[1]!.choices).toMatchObject({ cwd: '/Users/dev/shop', model: 'haiku' });
    // A worktree of its own, with a name of its team: the lead and the tester stay in the folder.
    expect(calls[2]!.choices.worktree).toBe(`checkout-formatter-${result.crewId!.slice(0, 6)}`);
    expect(calls[0]!.choices.worktree).toBeUndefined();
    expect(calls[1]!.choices.worktree).toBeUndefined();
    expect(calls[1]!.extras.system).toContain('You are tester');
  });

  it('is kept in a private file and found again when the daemon starts', async () => {
    const dir = join(temp.dir, 'kept');
    const { start } = fake();
    const result = await new Crews(dir).create(checked(spec()), start, 1000);
    const file = join(dir, `${result.crewId}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).agents).toEqual({ lead: 'agent-1', tester: 'agent-2', formatter: 'agent-3' });
    const again = new Crews(dir);
    expect(again.get(result.crewId!)?.name).toBe('checkout');
    expect(again.summaries()).toMatchObject([{ id: result.crewId, name: 'checkout', lead: 'lead' }]);
  });

  it('refuses the name of a team that exists: it would be the same group in the chart', async () => {
    const crews = new Crews(undefined);
    const { start } = fake();
    expect((await crews.create(checked(spec()), start)).ok).toBe(true);
    expect(await crews.create(checked(spec({ name: 'Checkout' })), start)).toEqual({ ok: false, error: 'a team called "Checkout" already exists: give this one another name' });
  });

  it('a team led by you starts only its members', async () => {
    const { calls, start } = fake();
    const result = await new Crews(undefined).create(checked(spec({ lead: { kind: 'you' } })), start);
    expect(result.agentIds).toHaveLength(2);
    expect(calls.map((call) => call.extras.name)).toEqual(['tester', 'formatter']);
  });

  it('says what did not start; with nothing started it keeps no team', async () => {
    const dir = join(temp.dir, 'failed');
    const crews = new Crews(dir);
    let call = 0;
    const partial = await crews.create(checked(spec()), async () => (++call === 2 ? { ok: false, error: 'tmux said no' } : { ok: true, agentId: `a${call}` }));
    expect(partial).toMatchObject({ ok: true, agentIds: ['a1', 'a3'], error: 'not started: tester: tmux said no' });
    const none = await crews.create(checked(spec({ name: 'other' })), async () => ({ ok: false, error: 'the folder does not exist' }));
    expect(none).toEqual({ ok: false, error: 'lead: the folder does not exist' });
    expect(crews.list()).toHaveLength(1);
    expect(existsSync(join(dir, `${partial.crewId}.json`))).toBe(true);
  });

  it('cuts a long role to the 40 characters of the box', () => {
    expect(shortRole('Write and run the tests of what you are asked, without touching the code of the app')).toBe('Write and run the tests of what you are…');
    expect(shortRole('Tests')).toBe('Tests');
  });
});

describe('a member in its box and in the chart', () => {
  const agent = (id: string, team: Agent['team']): Agent => ({ ...newAgent({ id, control: { kind: 'tmux', session: `fk-${id}` }, cwd: '/Users/dev/shop' }, 0), team });

  it('shows how it talks before its role', () => {
    expect(roleText(agent('a', { role: 'tests', talk: 'twoway' }))).toBe('⇄ tests');
    expect(roleText(agent('b', { role: 'formats', talk: 'oneway' }))).toBe('→ formats');
    expect(roleText(agent('c', { talk: 'oneway' }))).toBe('→');
    expect(roleText(agent('d', { role: 'split', lead: true, group: 'x' }))).toBe('lead · split');
  });

  it('a team led by you has you on top', () => {
    const groups = groupsOf([agent('a', { group: 'checkout', crew: 'c1', talk: 'twoway' }), agent('b', { group: 'manual' })]);
    expect(groups.map((group) => group.crew)).toEqual(['c1', undefined]);
    expect(ledByYou(groups[0]!, [{ id: 'c1', name: 'checkout' }])).toBe(true);
    expect(ledByYou(groups[0]!, [{ id: 'c1', name: 'checkout', lead: 'lead' }])).toBe(false);
    expect(ledByYou(groups[1]!, [{ id: 'c1', name: 'checkout' }])).toBe(false);
  });

  it('editing its name from the box keeps it in its team, and remembers nothing for the folder', () => {
    const file = join(temp.dir, 'teams.json');
    const teams = new Teams(file);
    const member = agent('m', { label: 'tester', group: 'checkout', role: 'tests', crew: 'c1', talk: 'twoway' });
    teams.set(member, { label: 'qa', group: 'checkout', role: 'tests', crew: 'other', talk: 'oneway' });
    expect(member.team).toEqual({ label: 'qa', group: 'checkout', role: 'tests', crew: 'c1', talk: 'twoway' });
    expect(existsSync(file)).toBe(false);
    teams.set(member, undefined);
    expect(member.team).toBeUndefined();
  });
});

describe('the panel', () => {
  it('writes the spec the daemon checks', () => {
    const spec = specOf({
      name: ' checkout ',
      folder: ' ~/shop ',
      leadKind: 'claude',
      leadName: ' ',
      leadRole: '',
      leadModel: 'opus',
      leadMode: '',
      talk: 'twoway',
      members: [
        { name: 'tester', role: 'tests', talk: undefined, model: '', mode: 'acceptEdits', worktree: false },
        { name: 'fmt', role: '', talk: 'oneway', model: 'haiku', mode: '', worktree: true },
      ],
    });
    expect(spec).toEqual({
      name: 'checkout',
      cwd: '~/shop',
      lead: { kind: 'claude', name: 'lead', role: '', model: 'opus' },
      talk: 'twoway',
      members: [
        { name: 'tester', role: 'tests', mode: 'acceptEdits', worktree: false },
        { name: 'fmt', role: '', talk: 'oneway', model: 'haiku', worktree: true },
      ],
    });
    expect('error' in cleanCrewSpec(spec)).toBe(false);
  });

  it('opens at most 4 panes, the lead last, in the large one', () => {
    expect(panesToOpen(['lead', 'a', 'b', 'c', 'd'])).toEqual(['c', 'b', 'a', 'lead']);
    expect(panesToOpen(['a'])).toEqual(['a']);
  });
});

describe('requests to a team', () => {
  const started = async (lead: unknown = { kind: 'claude', name: 'lead', role: 'Split.' }) => {
    const dir = join(temp.dir, `requests-${Math.random()}`);
    const crews = new Crews(dir);
    let next = 0;
    const result = await crews.create(checked(spec({ lead })), async () => ({ ok: true as const, agentId: `agent-${++next}` }));
    const queued: { agentId: string; text: string; link: { crew: string; n: number } }[] = [];
    const enqueue = (agentId: string, text: string, link: { crew: string; n: number }) => {
      queued.push({ agentId, text, link });
      const command: QueuedCommand = { id: `cmd-${queued.length}`, kind: 'request', arg: text, request: link, status: 'in-coda', createdAt: 0 };
      return { ok: true as const, command };
    };
    crews.enqueue = enqueue;
    return { crews, crewId: result.crewId!, queued, enqueue, dir };
  };
  const member = (id: string, crew: string): Agent => ({ ...newAgent({ id, control: { kind: 'tmux', session: `fk-${id}` } }, 0), team: { crew } });

  it('numbers the requests of a team, and goes to all the members when nobody is chosen', async () => {
    const { crews, crewId, queued, enqueue } = await started();
    expect(crews.request(crewId, [], '  Add a test for the parser.  ', 'the user', 10)).toEqual({ ok: true, n: 1, to: ['tester', 'formatter'] });
    expect(queued.map((item) => item.agentId)).toEqual(['agent-2', 'agent-3']);
    expect(queued[0]!.text).toBe('Request #1 from the user:\nAdd a test for the parser.');
    expect(queued[0]!.link).toEqual({ crew: crewId, n: 1 });
    // To the lead only, the next number.
    expect(crews.request(crewId, ['lead'], 'Plan the release.')).toEqual({ ok: true, n: 2, to: ['lead'] });
    expect(queued.at(-1)).toMatchObject({ agentId: 'agent-1', text: 'Request #2 from the user:\nPlan the release.' });
    const summary = crews.summaries()[0]!;
    expect(summary.recipients).toEqual([
      { name: 'lead', agentId: 'agent-1', lead: true },
      { name: 'tester', agentId: 'agent-2', talk: 'twoway' },
      { name: 'formatter', agentId: 'agent-3', talk: 'oneway' },
    ]);
    expect(summary.requests?.map((request) => [request.n, request.deliveries.map((d) => `${d.to}:${d.status}`)])).toEqual([
      [1, ['tester:queued', 'formatter:queued']],
      [2, ['lead:queued']],
    ]);
  });

  it('refuses an empty request, nobody to send it to, an unknown team', async () => {
    const { crews, crewId, enqueue } = await started();
    expect(crews.request(crewId, [], '   ')).toEqual({ ok: false, error: 'write the request first' });
    expect(crews.request(crewId, ['nobody'], 'Go.')).toEqual({ ok: false, error: 'nobody to send it to: the members are tester, formatter' });
    expect(crews.request('nope', [], 'Go.')).toEqual({ ok: false, error: 'unknown team' });
  });

  it('follows the queue of each recipient, and the Stop after the request ends it with the last message', async () => {
    const { crews, crewId, queued, enqueue, dir } = await started();
    let changes = 0;
    crews.onChange = () => changes++;
    crews.request(crewId, ['tester', 'formatter'], 'Run the tests.');
    const delivery = (to: string) => crews.get(crewId)!.requests![0]!.deliveries.find((d) => d.to === to)!;
    const command = (index: number, status: QueuedCommand['status'], reason?: string): QueuedCommand => ({
      id: `cmd-${index + 1}`,
      kind: 'request',
      arg: queued[index]!.text,
      request: queued[index]!.link,
      status,
      reason,
      createdAt: 0,
    });
    crews.commandChanged(command(0, 'bloccato', 'a dialog is open'));
    expect(delivery('tester')).toMatchObject({ status: 'blocked', reason: 'a dialog is open' });
    crews.commandChanged(command(0, 'confermato', 'delivered'));
    expect(delivery('tester')).toMatchObject({ status: 'working' });
    expect(delivery('tester').reason).toBeUndefined();
    // A Stop of another session ends nothing; the Stop of the tester ends its request.
    crews.hook(member('agent-3', crewId), { hook_event_name: 'Stop', session_id: 's' });
    expect(delivery('formatter').status).toBe('queued');
    crews.hook(member('agent-2', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'All 12 tests pass.' });
    expect(delivery('tester')).toMatchObject({ status: 'done', answer: 'All 12 tests pass.' });
    // Done stays done, whatever the queue says after.
    crews.commandChanged(command(0, 'non-confermato'));
    expect(delivery('tester').status).toBe('done');
    // The formatter: taken, then its turn fails.
    crews.commandChanged(command(1, 'confermato'));
    crews.hook(member('agent-3', crewId), { hook_event_name: 'StopFailure', session_id: 's' });
    expect(delivery('formatter')).toMatchObject({ status: 'failed', reason: 'the turn ended with an error' });
    expect(changes).toBeGreaterThan(4);
    // All of it is in the file of the team, for the next start of the daemon.
    const again = new Crews(dir).get(crewId)!.requests![0]!.deliveries;
    expect(again.map((d) => `${d.to}:${d.status}`)).toEqual(['tester:done', 'formatter:failed']);
  });

  it('a recipient with no session gets a failed delivery, so that you see it', async () => {
    const { crews, crewId } = await started();
    crews.enqueue = () => ({ ok: false, error: 'the session is read only or ended' });
    const result = crews.request(crewId, ['tester'], 'Go.');
    expect(result).toEqual({ ok: true, n: 1, to: ['tester'] });
    expect(crews.get(crewId)!.requests![0]!.deliveries[0]).toMatchObject({ to: 'tester', status: 'failed', reason: 'the session is read only or ended' });
  });

  it('in the panel, a recipient shows how it talks, and a lead called "lead" is not "lead · lead"', () => {
    expect(recipientText({ name: 'lead', lead: true })).toBe('lead');
    expect(recipientText({ name: 'anna', lead: true })).toBe('anna · lead');
    expect(recipientText({ name: 'tester', talk: 'twoway' })).toBe('⇄ tester');
    expect(recipientText({ name: 'formatter', talk: 'oneway' })).toBe('→ formatter');
  });

  it('in the panel, every member chosen is "all the members"', () => {
    const members = ['tester', 'formatter'];
    expect(toggleRecipient([], 'tester', members)).toEqual(['tester']);
    expect(toggleRecipient(['tester'], 'formatter', members)).toEqual([]);
    expect(toggleRecipient(['tester'], 'tester', members)).toEqual([]);
    expect(toggleRecipient([], 'lead', members)).toEqual(['lead']);
    expect(toggleRecipient(['lead', 'tester'], 'formatter', members)).toEqual(['lead', 'tester', 'formatter']);
  });
});

describe('a Claude lead and its members', () => {
  // Lead agent-1, tester agent-2 (answers), formatter agent-3 (executes only).
  const started = async (lead: unknown = { kind: 'claude', name: 'lead', role: 'Split.' }) => {
    const crews = new Crews(join(temp.dir, `lead-${Math.random()}`));
    let next = 0;
    const result = await crews.create(checked(spec({ lead })), async () => ({ ok: true as const, agentId: `agent-${++next}` }));
    const queued: { agentId: string; text: string; id: string }[] = [];
    crews.enqueue = (agentId, text, link) => {
      const command: QueuedCommand = { id: `cmd-${queued.length + 1}`, kind: 'request', arg: text, request: link, status: 'in-coda', createdAt: 0 };
      queued.push({ agentId, text, id: command.id });
      return { ok: true, command };
    };
    const states: Record<string, Agent['state']> = { 'agent-1': 'working', 'agent-2': 'idle', 'agent-3': 'working' };
    crews.agent = (id) => (states[id] ? ({ ...newAgent({ id, control: { kind: 'tmux', session: 'x' } }, 0), state: states[id] } as Agent) : undefined);
    return { crews, crewId: result.crewId!, queued };
  };
  const agentIn = (id: string, crew: string): Agent => ({ ...newAgent({ id, control: { kind: 'tmux', session: `fk-${id}` } }, 0), team: { crew } });
  const command = (item: { id: string; text: string }, crew: string, n: number, status: QueuedCommand['status']): QueuedCommand => ({
    id: item.id,
    kind: 'request',
    arg: item.text,
    request: { crew, n },
    status,
    createdAt: 0,
  });

  it('gives the tools of the team to the lead and to the members that answer, none to a member →', () => {
    const crew = checked(spec());
    expect(teamToolsFor(crew, 'lead')).toEqual(['team', 'send_request', 'wait_for_answers']);
    expect(teamToolsFor(crew, crew.members[0]!)).toEqual(['team', 'ask_lead']);
    expect(teamToolsFor(crew, crew.members[1]!)).toEqual([]);
  });

  it('starts each session with the tools it has', async () => {
    const tools: (readonly string[] | undefined)[] = [];
    await new Crews(undefined).create(checked(spec()), async (_choices, extras) => {
      tools.push(extras.teamTools);
      return { ok: true, agentId: `a${tools.length}` };
    });
    expect(tools).toEqual([['team', 'send_request', 'wait_for_answers'], ['team', 'ask_lead'], []]);
  });

  it('the lead sends requests to its members, never to itself; a member cannot send any', async () => {
    const { crews, crewId, queued } = await started();
    expect(crews.toolsOf('agent-1')).toEqual(['team', 'send_request', 'wait_for_answers']);
    expect(crews.requestFromLead('agent-1', ['all'], 'Write the parser.')).toEqual({ ok: true, n: 1, to: ['tester', 'formatter'] });
    expect(queued.map((item) => item.agentId)).toEqual(['agent-2', 'agent-3']);
    expect(queued[0]!.text).toBe('Request #1 from lead:\nWrite the parser.');
    expect(crews.requestFromLead('agent-1', ['Tester'], 'Test it.')).toMatchObject({ ok: true, to: ['tester'] });
    expect(crews.requestFromLead('agent-1', ['lead'], 'Do it yourself.')).toMatchObject({ ok: false });
    expect(crews.requestFromLead('agent-2', ['formatter'], 'Format.')).toEqual({ ok: false, error: 'only the lead of a team can send requests' });
    expect(crews.get(crewId)!.requests!.map((request) => request.from)).toEqual(['lead', 'lead']);
  });

  it('the answer of a member ⇄ goes back to the lead that asked; a member → sends nothing back', async () => {
    const { crews, crewId, queued } = await started();
    crews.requestFromLead('agent-1', ['all'], 'Write the parser.');
    for (const item of queued.slice(0, 2)) crews.commandChanged(command(item, crewId, 1, 'confermato'));
    crews.hook(agentIn('agent-2', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'Parser written, 8 tests pass.' });
    crews.hook(agentIn('agent-3', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'Formatted.' });
    expect(queued.slice(2).map(({ agentId, text }) => ({ agentId, text }))).toEqual([{ agentId: 'agent-1', text: 'Answer from tester to request #1:\nParser written, 8 tests pass.' }]);
    const deliveries = crews.get(crewId)!.requests![0]!.deliveries;
    expect(deliveries[0]!.reply).toEqual({ status: 'queued', commandId: queued[2]!.id });
    expect(deliveries[1]!.reply).toBeUndefined();
    // The answer reaches the lead: delivered.
    crews.commandChanged(command(queued[2]!, crewId, 1, 'confermato'));
    expect(deliveries[0]!.reply?.status).toBe('delivered');
  });

  it('a request you send gets its answer in the panel, not in the queue of the lead', async () => {
    const { crews, crewId, queued } = await started();
    crews.request(crewId, ['tester'], 'How many tests are there?');
    crews.commandChanged(command(queued[0]!, crewId, 1, 'confermato'));
    crews.hook(agentIn('agent-2', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: '42.' });
    expect(queued).toHaveLength(1);
    expect(crews.summaries()[0]!.requests![0]!.deliveries[0]).toMatchObject({ status: 'done', answer: '42.' });
  });

  it('a member ⇄ asks the lead about its request; a member → cannot ask', async () => {
    const { crews, crewId, queued } = await started();
    expect(crews.question('agent-2', 'Which parser?')).toEqual({ ok: false, error: 'you have had no request yet: there is nothing to ask about' });
    crews.requestFromLead('agent-1', ['tester'], 'Write the parser.');
    expect(crews.question('agent-2', 'JSON or YAML?')).toEqual({ ok: true, n: 1, to: 'lead' });
    expect(queued.at(-1)).toMatchObject({ agentId: 'agent-1', text: 'Question from tester about request #1:\nJSON or YAML?' });
    expect(crews.get(crewId)!.requests![0]!.deliveries[0]!.questions).toEqual([{ text: 'JSON or YAML?', at: expect.any(Number), status: 'queued', commandId: queued.at(-1)!.id }]);
    expect(crews.question('agent-3', 'Why?')).toEqual({ ok: false, error: 'only a member that answers its lead can ask it' });
    expect(crews.question('agent-1', 'Why?')).toMatchObject({ ok: false });
  });

  it('a member that asked ends its turn waiting: that message does not go back, the answer comes with the next request', async () => {
    const { crews, crewId, queued } = await started();
    crews.requestFromLead('agent-1', ['tester'], 'Count the words of a file.', 1000);
    crews.commandChanged(command(queued[0]!, crewId, 1, 'confermato'), 2000);
    crews.question('agent-2', 'Which file?', 3000);
    crews.hook(agentIn('agent-2', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'I asked the lead which file.' }, 4000);
    // The question went to the lead; the message of the end of the turn did not.
    expect(queued.map((item) => item.text.split('\n')[0])).toEqual(['Request #1 from lead:', 'Question from tester about request #1:']);
    expect(crews.get(crewId)!.requests![0]!.deliveries[0]).toMatchObject({ status: 'done', answer: 'I asked the lead which file.' });
    expect(crews.get(crewId)!.requests![0]!.deliveries[0]!.reply).toBeUndefined();
    // The next request, with the answer: its end goes back as usual.
    crews.requestFromLead('agent-1', ['tester'], 'The file is data.txt.', 5000);
    crews.commandChanged(command(queued[2]!, crewId, 2, 'confermato'), 6000);
    crews.hook(agentIn('agent-2', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: '8 words.' }, 7000);
    expect(queued.at(-1)!.text).toBe('Answer from tester to request #2:\n8 words.');
  });

  it('when you lead, a question waits for you in the panel', async () => {
    const { crews, crewId, queued } = await started({ kind: 'you' });
    crews.request(crewId, ['tester'], 'Write the parser.');
    expect(crews.question('agent-1', 'JSON or YAML?')).toEqual({ ok: true, n: 1, to: 'the user' });
    expect(queued).toHaveLength(1);
    expect(crews.get(crewId)!.requests![0]!.deliveries[0]!.questions?.[0]).toMatchObject({ status: 'shown' });
  });

  it('tells a session its team, and what each one is doing', async () => {
    const { crews } = await started();
    crews.requestFromLead('agent-1', ['tester'], 'Write the parser.');
    const text = crews.teamText('agent-1')!;
    expect(text).toContain('You are lead, the lead.');
    expect(text).toContain('Lead: lead — working');
    expect(text).toContain('- tester (answers): Write and run the tests. — works in the folder of the team — now: free; requests: #1 waiting for its turn');
    expect(text).toContain('- formatter (executes only): Format the code. — works in the folder of the team — now: working');
    expect(crews.teamText('agent-2')).toContain('You are tester, a member that answers its lead.');
    expect(crews.teamText('stranger')).toBeUndefined();
  });

  it('stops a lead that sends more than the team can hold', async () => {
    const { crews } = await started();
    for (let round = 0; round < MAX_OPEN_DELIVERIES / 2; round++) expect(crews.requestFromLead('agent-1', ['all'], `Step ${round}.`).ok).toBe(true);
    expect(crews.requestFromLead('agent-1', ['tester'], 'One more.')).toEqual({ ok: false, error: '20 requests of the team are still open (at most 20): wait for some answers first' });
  });

  it('answers the MCP server of the team on its routes', async () => {
    const { crews } = await started();
    expect(await crewApi(crews, 'me', { agent: 'agent-2' })).toEqual({ status: 200, body: { ok: true, name: 'tester', role: 'member', talk: 'twoway', team: 'checkout', tools: ['team', 'ask_lead'] } });
    expect(await crewApi(crews, 'request', { agent: 'agent-1', to: ['all'], text: 'Go.' })).toMatchObject({ status: 200, body: { ok: true, n: 1 } });
    expect(await crewApi(crews, 'request', { agent: 'agent-2', to: ['all'], text: 'Go.' })).toMatchObject({ status: 400, body: { ok: false } });
    expect(await crewApi(crews, 'question', { agent: 'agent-2', text: 'Why?' })).toMatchObject({ status: 200 });
    expect(await crewApi(crews, 'team', { agent: 'nobody' })).toMatchObject({ status: 400 });
    expect(await crewApi(crews, 'nope', {})).toMatchObject({ status: 404 });
    // A wait of another lead, or no wait at all, is not this one's.
    expect(await crewApi(crews, 'wait-poll', { agent: 'agent-1', id: 'nope' })).toMatchObject({ status: 400, body: { ok: false, error: 'unknown wait' } });
  });
});

describe('the thread of a team', () => {
  // You → lead #1; lead → tester ⇄ and formatter → #2; tester asks, then answers #3 back to the lead.
  const requests: CrewRequest[] = [
    { n: 1, from: 'the user', text: 'Ship the parser.', createdAt: 100, deliveries: [{ to: 'lead', agentId: 'a1', status: 'done', at: 400, answer: 'Sent #2 to both.' }] },
    {
      n: 2,
      from: 'lead',
      text: 'Write the parser.\nWith tests.',
      createdAt: 200,
      deliveries: [
        { to: 'tester', agentId: 'a2', status: 'done', at: 600, answer: 'Asked which format.', questions: [{ text: 'JSON or YAML?', at: 500, status: 'delivered', commandId: 'q' }] },
        { to: 'formatter', agentId: 'a3', status: 'done', at: 300, answer: 'Formatted.' },
      ],
    },
    { n: 3, from: 'lead', text: 'JSON.', createdAt: 700, deliveries: [{ to: 'tester', agentId: 'a2', status: 'done', at: 900, answer: 'Done, 8 tests.', reply: { status: 'delivered', commandId: 'r' } }] },
    { n: 4, from: 'lead', text: 'Lint it.', createdAt: 950, deliveries: [{ to: 'formatter', agentId: 'a3', status: 'working', at: 960 }] },
  ];

  it('tells every step in the order it happened, and where each answer went', () => {
    const steps = threadOf(requests).map((entry) => `${entry.at} ${entryHead(entry)}${entryTag(entry) ? ` [${entryTag(entry)}]` : ''}`);
    expect(steps).toEqual([
      '100 you → lead',
      '200 lead → tester, formatter',
      '300 formatter · finished #2 [not sent back]',
      '400 lead → you · answer to #1 [for you]',
      '500 tester → lead · question on #2 [delivered to lead]',
      '600 tester · finished #2 [not sent back]',
      '700 lead → tester',
      '900 tester → lead · answer to #3 [delivered to lead]',
      '950 lead → formatter',
    ]);
  });

  it('is kept whole in the file of the team, and found again', async () => {
    const dir = join(temp.dir, 'thread');
    const crews = new Crews(dir);
    let next = 0;
    const result = await crews.create(checked(spec()), async () => ({ ok: true as const, agentId: `agent-${++next}` }));
    crews.enqueue = (_agentId, text, link) => ({ ok: true, command: { id: `c${++next}`, kind: 'request', arg: text, request: link, status: 'in-coda', createdAt: 0 } });
    const long = `Write the parser.\n${'with care '.repeat(200)}`;
    crews.request(result.crewId!, ['tester'], long);
    expect(new Crews(dir).thread(result.crewId!)![0]!.text).toBe(long.trim());
    expect(crews.thread('nope')).toBeUndefined();
  });

  it('the box of a member says the request it works on; the box of the lead, what it waits on', () => {
    const crews: CrewSummary[] = [
      {
        id: 'c',
        name: 'checkout',
        lead: 'lead',
        recipients: [
          { name: 'lead', agentId: 'a1', lead: true },
          { name: 'tester', agentId: 'a2', talk: 'twoway' },
          { name: 'formatter', agentId: 'a3', talk: 'oneway' },
        ],
        requests: [
          ...requests,
          { n: 5, from: 'the user', text: 'And the docs.', createdAt: 990, deliveries: [{ to: 'formatter', agentId: 'a3', status: 'queued', at: 990 }] },
        ],
      },
    ];
    expect(crewLineOf('a3', crews)).toBe('#4 from lead: Lint it. · 1 more waiting');
    expect(crewLineOf('a2', crews)).toBeUndefined();
    expect(crewLineOf('a1', crews)).toBe('waits on #4 formatter');
    expect(crewLineOf('stranger', crews)).toBeUndefined();
    // Only in the queue: the line of the queue of the box says it, with its cancel.
    crews[0]!.requests![3]!.deliveries[0]!.status = 'done';
    expect(crewLineOf('a3', crews)).toBeUndefined();
    // The lead at work on a request of yours says that one.
    crews[0]!.requests!.push({ n: 6, from: 'the user', text: 'Plan the next step.', createdAt: 999, deliveries: [{ to: 'lead', agentId: 'a1', status: 'working', at: 999 }] });
    expect(crewLineOf('a1', crews)).toBe('#6 from you: Plan the next step.');
  });
});

describe('templates of teams', () => {
  it('the templates of Forchetta are teams the daemon accepts', () => {
    for (const template of BUILTIN_TEMPLATES) expect('error' in cleanCrewSpec({ ...template, cwd: '/x' })).toBe(false);
    expect(BUILTIN_TEMPLATES.map((template) => template.name)).toEqual(['developer + reviewer', 'feature squad', 'research + writing']);
  });

  it('a template saved from a team starts the same team again: lead, members, roles, → / ⇄, models', async () => {
    const original = checked(spec({ members: [{ name: 'tester', role: 'Tests.', model: 'haiku', mode: 'acceptEdits' }, { name: 'formatter', role: 'Format.', talk: 'oneway', worktree: true }] }));
    const store = new CrewTemplates(join(temp.dir, 'templates.json'));
    expect(store.save(templateOf({ ...original, members: original.members.map((m, i) => (i === 0 ? { ...m, talkNote: true } : m)) }))).toEqual({ ok: true, name: 'checkout' });
    // Read back by a new daemon, put in the panel, created in another folder.
    const template = new CrewTemplates(join(temp.dir, 'templates.json')).list().find((item) => item.name === 'checkout')!;
    expect(template.members[0]).not.toHaveProperty('talkNote');
    const again = checked(
      specOf({
        name: template.name,
        folder: '/Users/dev/other',
        leadKind: template.lead.kind,
        leadName: template.lead.kind === 'claude' ? template.lead.name : '',
        leadRole: template.lead.kind === 'claude' ? template.lead.role : '',
        leadModel: '',
        leadMode: '',
        talk: template.talk,
        members: draftsOf(template),
      }),
    );
    expect({ ...again, cwd: original.cwd }).toEqual(original);
    const started: SpawnExtras[] = [];
    await new Crews(undefined).create(again, async (_choices, extras) => {
      started.push(extras);
      return { ok: true, agentId: `a${started.length}` };
    });
    expect(started.map((extras) => [extras.name, extras.team?.talk, extras.teamTools])).toEqual([
      ['lead', undefined, ['team', 'send_request', 'wait_for_answers']],
      ['tester', 'twoway', ['team', 'ask_lead']],
      ['formatter', 'oneway', []],
    ]);
  });

  it('saving with the name of one of yours replaces it; the names of Forchetta are taken; deleting takes one of yours away', () => {
    const file = join(temp.dir, 'templates-2.json');
    const store = new CrewTemplates(file);
    const base = { lead: { kind: 'you' }, talk: 'twoway', members: [{ name: 'a' }] };
    expect(store.save({ ...base, name: 'Mine' }).ok).toBe(true);
    expect(store.save({ ...base, name: 'mine', members: [{ name: 'b' }] }).ok).toBe(true);
    expect(store.list().filter((template) => !template.builtin).map((template) => [template.name, template.members[0]!.name])).toEqual([['mine', 'b']]);
    expect(store.save({ ...base, name: 'Feature squad' })).toMatchObject({ ok: false });
    expect(store.save({ ...base, name: 'x', members: [] })).toMatchObject({ ok: false, error: 'add at least one member' });
    expect(store.delete('MINE')).toEqual({ ok: true });
    expect(store.delete('feature squad')).toMatchObject({ ok: false });
    expect(new CrewTemplates(file).list().filter((template) => !template.builtin)).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect('error' in cleanTemplate({ name: '', lead: { kind: 'you' }, members: [{ name: 'a' }] })).toBe(true);
  });
});

describe('changing a team', () => {
  const started = async () => {
    const crews = new Crews(join(temp.dir, `edit-${Math.random()}`));
    let next = 0;
    const result = await crews.create(checked(spec()), async () => ({ ok: true as const, agentId: `agent-${++next}` }));
    const queued: { agentId: string; text: string; id: string }[] = [];
    crews.enqueue = (agentId, text, link) => {
      const command: QueuedCommand = { id: `cmd-${queued.length + 1}`, kind: 'request', arg: text, request: link, status: 'in-coda', createdAt: 0 };
      queued.push({ agentId, text, id: command.id });
      return { ok: true, command };
    };
    return { crews, crewId: result.crewId!, queued };
  };
  const agentIn = (id: string, crew: string): Agent => ({ ...newAgent({ id, control: { kind: 'tmux', session: `fk-${id}` } }, 0), team: { crew } });
  const confirm = (crews: Crews, item: { id: string; text: string }, crewId: string, n: number) =>
    crews.commandChanged({ id: item.id, kind: 'request', arg: item.text, request: { crew: crewId, n }, status: 'confermato', createdAt: 0 });

  it('⇄ to → counts from the next request: the one in progress still answers, the next tells the member and does not', async () => {
    const { crews, crewId, queued } = await started();
    crews.requestFromLead('agent-1', ['tester'], 'Write the parser.');
    confirm(crews, queued[0]!, crewId, 1);
    // Changed while #1 is in progress.
    expect(crews.setTalk(crewId, 'tester', 'oneway')).toEqual({ ok: true, changes: [{ agentId: 'agent-2', talk: 'oneway' }] });
    crews.hook(agentIn('agent-2', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'Done.' });
    // The answer of #1 goes back, and tells the lead the news.
    expect(queued.at(-1)!.text).toBe('Answer from tester to request #1:\nDone.\n\n(The team changed: tester now executes only: it will not answer.)');
    // The next request carries the news to the member, once.
    crews.requestFromLead('agent-1', ['tester'], 'Now the docs.');
    expect(queued.at(-1)!.text).toBe('Request #2 from lead:\nNow the docs.\n\n(From now on you execute only: your final message is not sent to your lead, you do not need to report back.)');
    confirm(crews, queued.at(-1)!, crewId, 2);
    const before = queued.length;
    crews.hook(agentIn('agent-2', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'Docs done.' });
    expect(queued).toHaveLength(before);
    crews.requestFromLead('agent-1', ['tester'], 'And the changelog.');
    expect(queued.at(-1)!.text).toBe('Request #3 from lead:\nAnd the changelog.');
    // It cannot ask any more either; back to ⇄ it may.
    expect(crews.question('agent-2', 'Which one?')).toMatchObject({ ok: false });
    expect(crews.setTalk(crewId, 'tester', 'oneway')).toEqual({ ok: true, changes: [] });
    expect(crews.setTalk(crewId, 'tester', 'twoway').ok).toBe(true);
    expect(crews.question('agent-2', 'Which one?')).toMatchObject({ ok: true });
  });

  it('the Claude lead is told what changed with the next text that reaches it, once', async () => {
    const { crews, crewId, queued } = await started();
    crews.setTalk(crewId, 'formatter', 'twoway');
    crews.removeMember(crewId, 'tester', () => {});
    await crews.addMember(crewId, { name: 'docs', role: 'Write the docs.', talk: 'oneway' }, async () => ({ ok: true as const, agentId: 'agent-9' }));
    crews.request(crewId, ['lead'], 'What now?');
    expect(queued.at(-1)!.text).toBe(
      'Request #1 from the user:\nWhat now?\n\n(The team changed: formatter now answers you; tester is no longer in the team; docs joined the team (it executes only): Write the docs..)',
    );
    crews.request(crewId, ['lead'], 'And then?');
    expect(queued.at(-1)!.text).toBe('Request #2 from the user:\nAnd then?');
  });

  it('a member taken out loses its queued requests and gets no more; its session goes on; the last member stays', async () => {
    const { crews, crewId, queued } = await started();
    crews.requestFromLead('agent-1', ['all'], 'Go.');
    const cancelled: string[] = [];
    expect(crews.removeMember(crewId, 'formatter', (agentId, commandId) => cancelled.push(`${agentId}:${commandId}`))).toEqual({ ok: true, agentId: 'agent-3' });
    expect(cancelled).toEqual([`agent-3:${queued[1]!.id}`]);
    expect(crews.get(crewId)!.requests![0]!.deliveries.map((d) => `${d.to}:${d.status}`)).toEqual(['tester:queued', 'formatter:cancelled']);
    expect(crews.requestFromLead('agent-1', ['formatter'], 'Again.')).toMatchObject({ ok: false });
    expect(crews.whoami('agent-3')).toBeUndefined();
    expect(crews.removeMember(crewId, 'tester', () => {})).toEqual({ ok: false, error: 'a team needs at least one member' });
  });

  it('a member added starts like the others, and the lead sees it with the tool team', async () => {
    const { crews, crewId } = await started();
    const extras: SpawnExtras[] = [];
    const start = async (_choices: unknown, more: SpawnExtras) => {
      extras.push(more);
      return { ok: true as const, agentId: 'agent-9' };
    };
    expect(await crews.addMember(crewId, { name: 'docs', role: 'Write the docs.', talk: 'twoway', model: 'haiku' }, start)).toEqual({ ok: true, agentId: 'agent-9' });
    expect(extras[0]).toMatchObject({ name: 'docs', teamTools: ['team', 'ask_lead'], team: { label: 'docs', group: 'checkout', crew: crewId, talk: 'twoway' } });
    expect(extras[0]!.system).toContain('You are docs, a member of the team "checkout"');
    expect(crews.teamText('agent-1')).toContain('- docs (answers): Write the docs.');
    expect(await crews.addMember(crewId, { name: 'Tester' }, start)).toMatchObject({ ok: false, error: expect.stringContaining('two members') });
    expect(await crews.addMember(crewId, { name: 'x' }, async () => ({ ok: false as const, error: 'tmux said no' }))).toEqual({ ok: false, error: 'tmux said no' });
    expect(crews.get(crewId)!.members.map((m) => m.name)).toEqual(['tester', 'formatter', 'docs']);
  });
});

describe('members in worktrees of their own', () => {
  it('names each worktree after its team and member, short enough, never the same for two teams', () => {
    expect(worktreeName('abcdef12-0000', 'T3 Team', 'Checker')).toBe('t3-team-checker-abcdef');
    expect(worktreeName('123456ff', 'a very long name of a team, really long', 'reviewer')).toMatch(/^[a-z0-9-]{1,33}-123456$/);
    expect(worktreeName('123456ff', 'a very long name of a team, really long', 'reviewer').length).toBeLessThanOrEqual(40);
    expect(worktreeName('aaaaaa00', 'x', 'y')).not.toBe(worktreeName('bbbbbb00', 'x', 'y'));
  });

  it('keeps the choice of the team, and a member that says no', () => {
    const crew = checked(spec({ worktrees: true, members: [{ name: 'a' }, { name: 'b', worktree: false }] }));
    expect(crew.worktrees).toBe(true);
    expect(crew.members[1]!.worktree).toBe(false);
  });

  it('tells the lead and the members how they work: own worktree, commit, merge; and how to wait for answers', () => {
    const crew = checked(spec({ worktrees: true, members: [{ name: 'dev', role: 'Code.' }, { name: 'doc', role: 'Docs.', worktree: false }] }));
    const lead = leadPrompt(crew);
    expect(lead).toContain('- dev (answers you, own worktree): Code.');
    expect(lead).toContain('- doc (answers you): Docs.');
    expect(lead).toContain('merge its branch into the folder of the team');
    expect(lead).toContain('call the tool wait_for_answers');
    expect(memberPrompt(crew, crew.members[0]!)).toContain('Commit your work at the end of each request');
    expect(memberPrompt(crew, crew.members[1]!)).not.toContain('worktree');
    expect(leadPrompt(checked(spec()))).not.toContain('own worktree');
  });

  it('outside a git repository the members share the folder, and the result says so', async () => {
    const crews = new Crews(undefined);
    const choices: unknown[] = [];
    const result = await crews.create(checked(spec({ worktrees: true })), async (input) => {
      choices.push(input.worktree);
      return { ok: true, agentId: `a${choices.length}` };
    });
    expect(choices).toEqual([undefined, undefined, undefined]);
    expect(result).toMatchObject({ ok: true, error: 'the folder is not in a git repository: the members share it, with no worktree' });
    expect(crews.get(result.crewId!)!.worktrees).toBe(false);
  });

  it('in a folder not trusted yet only the lead starts; the others start when its trust dialog is answered, in their worktrees', async () => {
    const crews = new Crews(undefined);
    crews.inGit = () => true;
    let trusted = false;
    crews.trusted = () => trusted;
    const started: { name?: string; worktree?: unknown }[] = [];
    crews.spawn = async (input, extras) => {
      started.push({ name: extras.name, worktree: input.worktree });
      return { ok: true, agentId: `agent-${started.length}` };
    };
    const result = await crews.create(checked(spec({ worktrees: true })));
    expect(started).toEqual([{ name: 'lead', worktree: undefined }]);
    expect(result).toMatchObject({ ok: true, agentIds: ['agent-1'], error: expect.stringContaining('in the terminal of lead') });
    expect(crews.get(result.crewId!)!.waitingTrust).toBe('lead');
    // Another session saying hello changes nothing; the lead does: you answered yes.
    const hello = (id: string) => crews.hook({ ...newAgent({ id, control: { kind: 'tmux', session: 'x' } }, 0), team: { crew: result.crewId! } }, { hook_event_name: 'SessionStart', session_id: 's' });
    hello('stranger');
    expect(started).toHaveLength(1);
    trusted = true;
    hello('agent-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const id = result.crewId!.slice(0, 6);
    expect(started.slice(1)).toEqual([
      { name: 'tester', worktree: `checkout-tester-${id}` },
      { name: 'formatter', worktree: `checkout-formatter-${id}` },
    ]);
    expect(crews.get(result.crewId!)!.waitingTrust).toBeUndefined();
    expect(crews.get(result.crewId!)!.agents).toEqual({ lead: 'agent-1', tester: 'agent-2', formatter: 'agent-3' });
  });

  it('a lead that said hello while the team was being created does not leave the others waiting', async () => {
    const crews = new Crews(undefined);
    crews.inGit = () => true;
    crews.trusted = () => false;
    const hello = new Set<string>();
    crews.agent = (id) => (hello.has(id) ? ({ ...newAgent({ id, control: { kind: 'tmux', session: 'x' } }, 0), sessionId: 's' } as Agent) : undefined);
    const started: (string | undefined)[] = [];
    crews.spawn = async (_input, extras) => {
      started.push(extras.name);
      const id = `agent-${started.length}`;
      // No dialog after all: it says hello before the team is kept.
      hello.add(id);
      return { ok: true, agentId: id };
    };
    await crews.create(checked(spec()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(['lead', 'tester', 'formatter']);
  });

  it('when you lead, the first member opens the folder (in it), and the others follow', async () => {
    const crews = new Crews(undefined);
    crews.inGit = () => true;
    let trusted = false;
    crews.trusted = () => trusted;
    const started: { name?: string; worktree?: unknown }[] = [];
    crews.spawn = async (input, extras) => {
      started.push({ name: extras.name, worktree: input.worktree });
      return { ok: true, agentId: `agent-${started.length}` };
    };
    const result = await crews.create(checked(spec({ worktrees: true, lead: { kind: 'you' } })));
    expect(started).toEqual([{ name: 'tester', worktree: undefined }]);
    expect(result.error).toContain('in the terminal of tester');
    trusted = true;
    crews.hook({ ...newAgent({ id: 'agent-1', control: { kind: 'tmux', session: 'x' } }, 0), team: { crew: result.crewId! } }, { hook_event_name: 'SessionStart', session_id: 's' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started.slice(1)).toEqual([{ name: 'formatter', worktree: `checkout-formatter-${result.crewId!.slice(0, 6)}` }]);
  });

  it('the tool team says the worktree and the branch of each member', async () => {
    const crews = new Crews(undefined);
    crews.inGit = () => true;
    crews.trusted = () => true;
    crews.gitInfo = (dir) => (dir === '/Users/dev/shop' ? { root: '/Users/dev/shop', branch: 'main' } : { branch: `worktree-${dir.split('/').at(-1)}` });
    let next = 0;
    const result = await crews.create(checked(spec({ worktrees: true })), async () => ({ ok: true, agentId: `agent-${++next}` }));
    const name = `checkout-tester-${result.crewId!.slice(0, 6)}`;
    expect(crews.teamText('agent-1')).toContain(`- tester (answers): Write and run the tests. — works own worktree /Users/dev/shop/.claude/worktrees/${name}, branch worktree-${name}`);
  });
});

describe('the lead waits for its answers', () => {
  // Lead agent-1, tester agent-2 (answers), formatter agent-3 (executes only).
  const started = async () => {
    const crews = new Crews(join(temp.dir, `wait-${Math.random()}`));
    let next = 0;
    const result = await crews.create(checked(spec()), async () => ({ ok: true as const, agentId: `agent-${++next}` }));
    const queued: { agentId: string; text: string; id: string }[] = [];
    crews.enqueue = (agentId, text, link) => {
      const command: QueuedCommand = { id: `cmd-${queued.length + 1}`, kind: 'request', arg: text, request: link, status: 'in-coda', createdAt: 0 };
      queued.push({ agentId, text, id: command.id });
      return { ok: true, command };
    };
    return { crews, crewId: result.crewId!, queued };
  };
  const agentIn = (id: string, crew: string): Agent => ({ ...newAgent({ id, control: { kind: 'tmux', session: `fk-${id}` } }, 0), team: { crew } });
  const working = (crews: Crews, crewId: string, queued: { id: string; text: string }[], index: number, n: number) =>
    crews.commandChanged({ id: queued[index]!.id, kind: 'request', arg: queued[index]!.text, request: { crew: crewId, n }, status: 'confermato', createdAt: 0 });

  it('holds the answers while the lead waits, and gives them all at once, not again as prompts', async () => {
    const { crews, crewId, queued } = await started();
    crews.requestFromLead('agent-1', ['all'], 'Do your part.');
    working(crews, crewId, queued, 0, 1);
    working(crews, crewId, queued, 1, 1);
    const wait = crews.startWait('agent-1', undefined, 5);
    expect(wait).toMatchObject({ ok: true, requests: [1] });
    const id = (wait as { id: string }).id;
    // Not over yet: a poll returns after its time with nothing.
    expect(await crews.pollWait(id, 20)).toEqual({ ok: true, done: false, answers: [], open: ['#1 tester', '#1 formatter'] });
    // A poll in progress wakes up when the last member finishes.
    const poll = crews.pollWait(id, 5000);
    crews.hook(agentIn('agent-2', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: '8 tests pass.' });
    expect(crews.get(crewId)!.requests![0]!.deliveries[0]!.reply).toEqual({ status: 'held' });
    crews.hook(agentIn('agent-3', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'Formatted.' });
    expect(await poll).toEqual({
      ok: true,
      done: true,
      open: [],
      answers: [
        { n: 1, from: 'tester', status: 'done', talk: 'twoway', answer: '8 tests pass.' },
        { n: 1, from: 'formatter', status: 'done', talk: 'oneway' },
      ],
    });
    // Nothing went into the queue of the lead: it got them in its wait.
    expect(queued.map((item) => item.agentId)).toEqual(['agent-2', 'agent-3']);
    expect(crews.get(crewId)!.requests![0]!.deliveries[0]!.reply).toEqual({ status: 'delivered', byWait: true });
    expect(threadOf(crews.thread(crewId)!).find((entry) => entry.kind === 'answer' && entry.from === 'tester')).toMatchObject({ status: 'delivered', byWait: true });
    expect(await crews.pollWait(id, 10)).toMatchObject({ ok: false });
  });

  it('when the time is up it gives what came, and the rest reaches the lead as prompts', async () => {
    const { crews, crewId, queued } = await started();
    crews.requestFromLead('agent-1', ['all'], 'Do your part.');
    working(crews, crewId, queued, 0, 1);
    working(crews, crewId, queued, 1, 1);
    let clock = Date.now();
    const id = (crews.startWait('agent-1', [1], 1, clock) as { id: string }).id;
    crews.hook(agentIn('agent-2', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'Done.' });
    clock += 61_000;
    expect(await crews.pollWait(id, 10, () => clock)).toEqual({ ok: true, done: true, answers: [{ n: 1, from: 'tester', status: 'done', talk: 'twoway', answer: 'Done.' }], open: ['#1 formatter'] });
  });

  it('a wait nobody collects gives its held answers to the lead as prompts', async () => {
    vi.useFakeTimers();
    try {
      const { crews, crewId, queued } = await started();
      crews.requestFromLead('agent-1', ['tester'], 'Test it.');
      working(crews, crewId, queued, 0, 1);
      crews.startWait('agent-1', undefined, 1);
      crews.hook(agentIn('agent-2', crewId), { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'Tested.' });
      expect(queued).toHaveLength(1);
      vi.advanceTimersByTime(91_000);
      expect(queued.at(-1)).toMatchObject({ agentId: 'agent-1', text: 'Answer from tester to request #1:\nTested.' });
      expect(crews.get(crewId)!.requests![0]!.deliveries[0]!.reply).toMatchObject({ status: 'queued' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('only the lead waits; with nothing open there is nothing to wait for', async () => {
    const { crews } = await started();
    expect(crews.startWait('agent-2', undefined, 5)).toEqual({ ok: false, error: 'only the lead of a team can wait for answers' });
    expect(crews.startWait('agent-1', undefined, 5)).toMatchObject({ ok: true, requests: [] });
    expect(crews.startWait('agent-1', [7], 5)).toMatchObject({ ok: false, error: expect.stringContaining('none yet') });
  });
});
