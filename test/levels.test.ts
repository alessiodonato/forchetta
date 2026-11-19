import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Crews } from '../src/daemon/crews.ts';
import type { SpawnExtras } from '../src/daemon/spawn.ts';
import { newAgent } from '../src/daemon/state.ts';
import type { Agent, QueuedCommand } from '../src/shared/agent.ts';
import {
  BUILTIN_TEMPLATES,
  cleanCrewSpec,
  cleanTemplate,
  type CrewSpec,
  type CrewSummary,
  crewLineOf,
  leadPrompt,
  memberPrompt,
  teamToolsFor,
  templateOf,
  threadOf,
  treeOrder,
} from '../src/shared/crew.ts';
import { draftsOf, draftTree, isUnder, specOf, withoutDraft } from '../src/ui/NewTeam.tsx';
import { arrivalsBetween, linkPath, linkStates, snapshotOf } from '../src/ui/org-lines.ts';
import { crewTree } from '../src/ui/Team.tsx';
import { entryHead } from '../src/ui/TeamRequests.tsx';
import { tempDir } from './helpers.ts';

// A team with levels: a member reports to another member instead of the lead, which leads it; each relation has
// its → / ⇄ and its own prompt. Manager (the Claude lead) → senior → junior.

const temp = tempDir('levels');
afterAll(() => temp.cleanup());

const spec = (patch: Record<string, unknown> = {}): unknown => ({
  name: 'shop',
  cwd: '/Users/dev/shop',
  lead: { kind: 'claude', name: 'manager', role: 'Turn goals into tasks.' },
  talk: 'twoway',
  members: [
    { name: 'senior', role: 'Plans and reviews.', relation: 'The manager says what and why; the senior decides how.' },
    { name: 'junior', role: 'Writes the code.', reportsTo: 'Senior', relation: 'One step at a time.\nReports what changed and how it was tested.' },
    { name: 'designer', role: 'Draws the screens.', talk: 'oneway' },
  ],
  ...patch,
});

const checked = (input: unknown): CrewSpec => {
  const result = cleanCrewSpec(input);
  if ('error' in result) throw new Error(result.error);
  return result.spec;
};
const error = (input: unknown): string => (cleanCrewSpec(input) as { error: string }).error;

describe('who reports to whom', () => {
  it('a member reports to another member by its name, in any case; the lead by its name, "lead", "you" or nothing', () => {
    const crew = checked(spec());
    expect(crew.members.map((member) => [member.name, member.reportsTo])).toEqual([
      ['senior', undefined],
      ['junior', 'senior'],
      ['designer', undefined],
    ]);
    expect(crew.members[1]!.relation).toBe('One step at a time.\nReports what changed and how it was tested.');
    for (const top of ['manager', 'lead', 'you', 'The Lead']) expect(checked(spec({ members: [{ name: 'a', reportsTo: top }] })).members[0]!.reportsTo).toBeUndefined();
    // A member called like a word of the lead is that member.
    expect(checked(spec({ lead: { kind: 'you' }, members: [{ name: 'lead' }, { name: 'b', reportsTo: 'lead' }] })).members[1]!.reportsTo).toBe('lead');
  });

  it('refuses a name that is not in the team, a member above itself, and a circle', () => {
    expect(error(spec({ members: [{ name: 'a', reportsTo: 'nobody' }] }))).toBe('a: it reports to "nobody", who is not in the team');
    expect(error(spec({ members: [{ name: 'a', reportsTo: 'a' }] }))).toBe('a cannot report to itself');
    expect(error(spec({ members: [{ name: 'a', reportsTo: 'b' }, { name: 'b', reportsTo: 'c' }, { name: 'c', reportsTo: 'a' }] }))).toContain('a reports, through b, c, to itself');
  });

  it('a template keeps who reports to whom and the prompt of each relation, not what a member was told', async () => {
    const template = templateOf({ ...checked(spec()), members: checked(spec()).members.map((member) => ({ ...member, canLead: true, notes: ['x'], reportsToNote: true })) });
    expect(template.members[1]).toEqual({ name: 'junior', role: 'Writes the code.', reportsTo: 'senior', relation: 'One step at a time.\nReports what changed and how it was tested.' });
    const again = cleanTemplate(template);
    expect('template' in again && again.template.members[1]!.reportsTo).toBe('senior');
  });

  it('the template of Forchetta with three levels is a team the daemon accepts', () => {
    const chain = BUILTIN_TEMPLATES.find((template) => template.name === 'manager › senior › junior')!;
    const crew = checked({ ...chain, cwd: '/x' });
    expect(crew.members.map((member) => `${member.name}<${member.reportsTo ?? 'lead'}`)).toEqual(['senior<lead', 'junior<senior']);
    expect(crew.members.every((member) => member.relation)).toBe(true);
  });

  it('puts things in the order of a chart, each one after the one above it', () => {
    const items = [
      { id: 'd', up: 'b' },
      { id: 'a', up: undefined },
      { id: 'b', up: 'a' },
      { id: 'c', up: undefined },
      { id: 'x', up: 'gone' },
    ];
    expect(treeOrder(items, (item) => item.id, (item) => item.up).map(({ item, depth }) => `${item.id}${depth}`)).toEqual(['a0', 'b1', 'd2', 'c0', 'x0']);
  });
});

describe('the tools and the prompts of a team with levels', () => {
  const crew = checked(spec());
  const [senior, junior, designer] = crew.members as [CrewSpec['members'][0], CrewSpec['members'][0], CrewSpec['members'][0]];

  it('a member others report to gets the tools to send requests and wait for them', () => {
    expect(teamToolsFor(crew, senior)).toEqual(['team', 'send_request', 'wait_for_answers', 'ask_lead']);
    expect(teamToolsFor(crew, junior)).toEqual(['team', 'ask_lead']);
    expect(teamToolsFor(crew, designer)).toEqual([]);
    expect(teamToolsFor(checked(spec({ members: [{ name: 's', talk: 'oneway' }, { name: 'j', reportsTo: 's' }] })), { name: 's', talk: 'oneway' })).toEqual(['team', 'send_request', 'wait_for_answers']);
  });

  it('the lead knows its reports and the prompt of each relation, and that the others go through them', () => {
    const text = leadPrompt(crew);
    expect(text).toContain('Your reports, the members you give requests to:\n- senior (answers you): Plans and reviews.\n  How you work together: The manager says what and why; the senior decides how.\n- designer (executes only, no answer): Draws the screens.');
    expect(text).toContain('You do not write to them: the one they report to does.\n- junior (reports to senior, answers it): Writes the code.');
    expect(text).toContain('("all": all your reports)');
    expect(text).toContain('its answer reaches you when their work is done too');
  });

  it('a member in the middle knows who it reports to, who reports to it, and that its request waits for their work', () => {
    const text = memberPrompt(crew, senior);
    expect(text).toContain('Your lead is manager, another Claude Code session.');
    expect(text).toContain('How you work with manager: The manager says what and why; the senior decides how.');
    expect(text).toContain('You lead members of the team too');
    expect(text).toContain('- junior (answers you): Writes the code.\n  How you work together: One step at a time.\n    Reports what changed and how it was tested.');
    expect(text).toContain('your final message goes back to manager only when the work you passed to them is done');
    // Its own report is not among "the other members".
    expect(text).toContain('The other members of the team:\n- designer (reports to manager): Draws the screens.');
  });

  it('a member at the bottom knows it reports to a member, and how the two work', () => {
    const text = memberPrompt(crew, junior);
    expect(text).toContain('Your lead is senior, another Claude Code session: a member of the team, who reports to manager, the lead of the team.');
    expect(text).toContain('How you work with senior: One step at a time.');
    expect(text).toContain('"Request #<n> from senior:"');
    expect(text).not.toContain('You lead members');
  });

  it('a team with no levels keeps its prompts as they were', () => {
    const flat = checked(spec({ members: [{ name: 'tester', role: 'Tests.' }] }));
    expect(leadPrompt(flat)).toContain('Your team: each member is another Claude Code session, in its own terminal.\n- tester (answers you): Tests.\n\nGive work to the members with the tool send_request');
    expect(memberPrompt(flat, flat.members[0]!)).toContain('Your lead is manager, another Claude Code session.\n\n');
  });
});

describe('requests down the levels', () => {
  // manager agent-1 (lead), senior agent-2, junior agent-3, designer agent-4.
  const started = async (patch: Record<string, unknown> = {}) => {
    const crews = new Crews(join(temp.dir, `levels-${Math.random()}`));
    let next = 0;
    const extras: SpawnExtras[] = [];
    const result = await crews.create(checked(spec(patch)), async (_choices, more) => {
      extras.push(more);
      return { ok: true as const, agentId: `agent-${++next}` };
    });
    const queued: { agentId: string; text: string; id: string; n: number }[] = [];
    crews.enqueue = (agentId, text, link) => {
      const command: QueuedCommand = { id: `cmd-${queued.length + 1}`, kind: 'request', arg: text, request: link, status: 'in-coda', createdAt: 0 };
      queued.push({ agentId, text, id: command.id, n: link.n });
      return { ok: true, command };
    };
    const states: Record<string, Agent['state']> = { 'agent-1': 'idle', 'agent-2': 'idle', 'agent-3': 'idle', 'agent-4': 'idle' };
    crews.agent = (id) => (states[id] ? ({ ...newAgent({ id, control: { kind: 'tmux', session: 'x' } }, 0), state: states[id] } as Agent) : undefined);
    const crewId = result.crewId!;
    const confirm = (item: { id: string; text: string; n: number }) =>
      crews.commandChanged({ id: item.id, kind: 'request', arg: item.text, request: { crew: crewId, n: item.n }, status: 'confermato', createdAt: 0 });
    const stop = (id: string, message: string) => crews.hook({ ...newAgent({ id, control: { kind: 'tmux', session: `fk-${id}` } }, 0), team: { crew: crewId } }, { hook_event_name: 'Stop', session_id: 's', last_assistant_message: message });
    const delivery = (n: number, to: string) => crews.get(crewId)!.requests!.find((request) => request.n === n)!.deliveries.find((d) => d.to === to)!;
    return { crews, crewId, queued, states, confirm, stop, delivery, extras };
  };

  it('starts each one with its tools, and remembers who can lead a member added later', async () => {
    const { crews, extras } = await started();
    expect(extras.map((more) => [more.name, more.teamTools])).toEqual([
      ['manager', ['team', 'send_request', 'wait_for_answers']],
      ['senior', ['team', 'send_request', 'wait_for_answers', 'ask_lead']],
      ['junior', ['team', 'ask_lead']],
      ['designer', []],
    ]);
    expect(crews.summaries()[0]!.recipients).toEqual([
      { name: 'manager', agentId: 'agent-1', lead: true },
      { name: 'senior', agentId: 'agent-2', talk: 'twoway', canLead: true },
      { name: 'junior', agentId: 'agent-3', talk: 'twoway', reportsTo: 'senior' },
      { name: 'designer', agentId: 'agent-4', talk: 'oneway' },
    ]);
  });

  it('each one sends only to the members that report to it; "all" is all of them; you write to anyone', async () => {
    const { crews, crewId } = await started();
    expect(crews.requestFrom('agent-1', ['junior'], 'Write it.')).toEqual({
      ok: false,
      error: 'junior reports to senior. You send requests only to the members that report to you (senior, designer): the work of the others goes through the one they report to.',
    });
    expect(crews.requestFrom('agent-1', ['all'], 'Plan it.')).toMatchObject({ ok: true, to: ['senior', 'designer'] });
    expect(crews.requestFrom('agent-2', ['all'], 'Write it.')).toMatchObject({ ok: true, to: ['junior'] });
    expect(crews.requestFrom('agent-2', ['designer'], 'Draw it.')).toMatchObject({ ok: false, error: expect.stringContaining('designer reports to manager') });
    expect(crews.requestFrom('agent-3', ['senior'], 'Help.')).toEqual({ ok: false, error: 'only the lead of a team, or a member others report to, can send requests' });
    expect(crews.request(crewId, ['junior'], 'From you.')).toMatchObject({ ok: true, to: ['junior'] });
  });

  it('the answer of the senior reaches the manager after the work of the junior, with what the senior made of it', async () => {
    const { crews, crewId, queued, states, confirm, stop, delivery } = await started();
    crews.requestFrom('agent-1', ['senior'], 'Add a cart.');
    confirm(queued[0]!);
    states['agent-2'] = 'working';
    // The senior passes a step to the junior, then ends its turn: #1 waits for #2.
    expect(crews.requestFrom('agent-2', ['junior'], 'Write the cart model.')).toMatchObject({ ok: true, n: 2 });
    expect(crews.get(crewId)!.requests![1]!.parent).toBe(1);
    expect(queued[1]).toMatchObject({ agentId: 'agent-3', text: 'Request #2 from senior:\nWrite the cart model.' });
    states['agent-2'] = 'idle';
    stop('agent-2', 'I gave the model to the junior.');
    expect(delivery(1, 'senior')).toMatchObject({ status: 'delegated', answer: 'I gave the model to the junior.' });
    expect(queued).toHaveLength(2);
    // The junior finishes: its answer goes to the senior, not to the manager.
    confirm(queued[1]!);
    stop('agent-3', 'Model written, 4 tests.');
    expect(queued[2]).toMatchObject({ agentId: 'agent-2', text: 'Answer from junior to request #2:\nModel written, 4 tests.' });
    expect(delivery(1, 'senior').status).toBe('delegated');
    // The senior reads it (delivered, at work on it), checks, and ends: now #1 is done and goes up.
    states['agent-2'] = 'working';
    confirm(queued[2]!);
    expect(delivery(1, 'senior').status).toBe('delegated');
    states['agent-2'] = 'idle';
    stop('agent-2', 'Cart done and reviewed: model, 4 tests.');
    expect(delivery(1, 'senior')).toMatchObject({ status: 'done', answer: 'Cart done and reviewed: model, 4 tests.' });
    expect(queued[3]).toMatchObject({ agentId: 'agent-1', text: 'Answer from senior to request #1:\nCart done and reviewed: model, 4 tests.' });
  });

  it('a request passed to a member that executes only ends when that member does, if the one above is free', async () => {
    const { crews, queued, confirm, stop, delivery } = await started({
      members: [
        { name: 'senior', role: 'Plans.' },
        { name: 'junior', role: 'Formats.', reportsTo: 'senior', talk: 'oneway' },
      ],
    });
    crews.requestFrom('agent-1', ['senior'], 'Format the code.');
    confirm(queued[0]!);
    crews.requestFrom('agent-2', ['junior'], 'Run the formatter.');
    stop('agent-2', 'The junior formats it.');
    expect(delivery(1, 'senior').status).toBe('delegated');
    confirm(queued[1]!);
    stop('agent-3', 'Formatted.');
    expect(delivery(2, 'junior').reply).toBeUndefined();
    expect(delivery(1, 'senior').status).toBe('done');
    expect(queued.at(-1)).toMatchObject({ agentId: 'agent-1', text: 'Answer from senior to request #1:\nThe junior formats it.' });
  });

  it('a request of yours to the lead waits for the whole team, and its answer is the last word of the lead', async () => {
    const { crews, crewId, queued, confirm, stop, delivery, states } = await started();
    crews.request(crewId, ['manager'], 'Build the cart.');
    confirm(queued[0]!);
    crews.requestFrom('agent-1', ['designer'], 'Draw the cart.');
    stop('agent-1', 'Sent to the designer.');
    expect(delivery(1, 'manager').status).toBe('delegated');
    confirm(queued[1]!);
    states['agent-1'] = 'idle';
    stop('agent-4', 'Drawn.');
    expect(delivery(1, 'manager')).toMatchObject({ status: 'done', answer: 'Sent to the designer.' });
    const heads = threadOf(crews.thread(crewId)!).map((entry) => entryHead(entry));
    expect(heads).toHaveLength(4);
    expect(heads).toEqual(expect.arrayContaining(['you → manager', 'manager → designer · for #1', 'designer · finished #2', 'manager → you · answer to #1']));
  });

  it('a question of the junior goes to the senior, which answers it within the same request', async () => {
    const { crews, crewId, queued, confirm, stop, delivery, states } = await started();
    crews.requestFrom('agent-1', ['senior'], 'Add a cart.');
    confirm(queued[0]!);
    crews.requestFrom('agent-2', ['junior'], 'Write the model.');
    stop('agent-2', 'Passed on.');
    confirm(queued[1]!);
    expect(crews.question('agent-3', 'Prices in cents?')).toEqual({ ok: true, n: 2, to: 'senior' });
    expect(queued[2]).toMatchObject({ agentId: 'agent-2', text: 'Question from junior about request #2:\nPrices in cents?' });
    stop('agent-3', 'I asked the senior.');
    // The question is on its way to the senior: its request is still open.
    expect(delivery(1, 'senior').status).toBe('delegated');
    // The question reaches the senior: its prompt starts a turn (the daemon marks it at work before the delivery).
    states['agent-2'] = 'working';
    confirm(queued[2]!);
    expect(delivery(1, 'senior').status).toBe('delegated');
    // The senior answers with a new request, part of #1.
    expect(crews.requestFrom('agent-2', ['junior'], 'Yes, cents.')).toMatchObject({ ok: true, n: 3 });
    states['agent-2'] = 'idle';
    stop('agent-2', 'Answered the junior.');
    expect(crews.get(crewId)!.requests!.at(-1)!.parent).toBe(1);
    expect(delivery(1, 'senior').status).toBe('delegated');
  });

  it('the senior can wait for the answers of the junior in its own turn', async () => {
    const { crews } = await started();
    crews.requestFrom('agent-2', ['junior'], 'Write it.');
    expect(crews.startWait('agent-2', undefined, 5)).toMatchObject({ ok: true, requests: [1] });
    expect(crews.startWait('agent-3', undefined, 5)).toMatchObject({ ok: false });
  });

  it('a member in the middle taken out: the ones below go up to the one above it, and are told', async () => {
    const { crews, crewId, queued } = await started();
    expect(crews.removeMember(crewId, 'senior', () => {})).toEqual({ ok: true, agentId: 'agent-2' });
    expect(crews.get(crewId)!.members.find((member) => member.name === 'junior')!.reportsTo).toBeUndefined();
    expect(crews.requestFrom('agent-1', ['junior'], 'Write it.')).toMatchObject({ ok: true });
    expect(queued.at(-1)!.text).toBe(
      'Request #1 from manager:\nWrite it.\n\n(The one you report to changed: from now on your lead is manager. Your answers and your questions go to manager.)',
    );
    crews.request(crewId, ['manager'], 'Status?');
    expect(queued.at(-1)!.text).toContain('(The team changed: senior is no longer in the team; junior now reports to you.)');
  });

  it('a member added under a member that leads others; not under one that started without the tools', async () => {
    const { crews, crewId, queued, extras } = await started();
    expect(await crews.addMember(crewId, { name: 'intern', role: 'Fixes typos.', reportsTo: 'senior' }, async (_c, more) => (extras.push(more), { ok: true as const, agentId: 'agent-9' }))).toEqual({
      ok: true,
      agentId: 'agent-9',
    });
    expect(extras.at(-1)!.system).toContain('Your lead is senior');
    expect(await crews.addMember(crewId, { name: 'trainee', role: 'Learns.', reportsTo: 'junior' }, async () => ({ ok: true as const, agentId: 'agent-10' }))).toEqual({
      ok: false,
      error: 'junior started without the tools to give requests: put trainee under manager or under senior',
    });
    // The senior hears of it with its next request; the manager too.
    crews.requestFrom('agent-1', ['senior'], 'Go on.');
    expect(queued.at(-1)!.text).toContain('(The team changed: intern joined the team and reports to you (it answers you): Fixes typos..)');
  });

  it('the tool team and the box say who reports to whom and what waits', async () => {
    const { crews, crewId, queued, confirm, stop } = await started();
    expect(crews.teamText('agent-2')).toContain('You are senior, a member that answers its lead. Members that report to you: junior.');
    expect(crews.teamText('agent-3')).toContain('You are junior, a member that reports to senior and answers it.');
    expect(crews.teamText('agent-1')).toContain('- junior (reports to senior, answers): Writes the code.');
    crews.requestFrom('agent-1', ['senior'], 'Add a cart.');
    confirm(queued[0]!);
    crews.requestFrom('agent-2', ['junior'], 'Write the model.');
    stop('agent-2', 'Passed on.');
    expect(crews.teamText('agent-1')).toContain('#1 passed to its members, waiting for their work');
    expect(crewLineOf('agent-2', crews.summaries())).toBe('#1 from manager: Add a cart. · waits on #2 junior');
    // Its session ends: what it passed on fails with it.
    crews.hook({ ...newAgent({ id: 'agent-2', control: { kind: 'tmux', session: 'x' } }, 0), team: { crew: crewId } }, { hook_event_name: 'SessionEnd', session_id: 's' });
    expect(crews.get(crewId)!.requests![0]!.deliveries[0]).toMatchObject({ status: 'failed', reason: 'the session ended' });
  });
});

describe('a team with levels in the app', () => {
  const crew: CrewSummary = {
    id: 'c1',
    name: 'shop',
    lead: 'manager',
    recipients: [
      { name: 'manager', agentId: 'm', lead: true },
      { name: 'senior', agentId: 's', talk: 'twoway', canLead: true },
      { name: 'junior', agentId: 'j', talk: 'twoway', reportsTo: 'senior' },
      { name: 'designer', agentId: 'd', talk: 'oneway' },
    ],
    requests: [
      { n: 1, from: 'manager', text: 'Cart.', createdAt: 1, deliveries: [{ to: 'senior', agentId: 's', status: 'delegated', at: 2 }] },
      { n: 2, from: 'senior', text: 'Model.', createdAt: 3, parent: 1, deliveries: [{ to: 'junior', agentId: 'j', status: 'working', at: 4 }] },
      { n: 3, from: 'manager', text: 'Skip the senior.', createdAt: 5, deliveries: [{ to: 'junior', agentId: 'j', status: 'queued', at: 5 }] },
    ],
  };
  const agent = (id: string): Agent => ({ ...newAgent({ id, control: { kind: 'tmux', session: `fk-${id}` } }, 0), team: { crew: 'c1', group: 'shop' } });

  it('each line goes up to the one a member reports to: the junior to the senior, the senior to the manager', () => {
    expect(Object.fromEntries(linkStates(crew))).toEqual({ s: 'working', j: 'working' });
    const before = snapshotOf(crew);
    const after: CrewSummary = {
      ...crew,
      requests: [crew.requests![0]!, { ...crew.requests![1]!, deliveries: [{ to: 'junior', agentId: 'j', status: 'done', at: 6, answer: 'Done.', reply: { status: 'delivered' } }] }, crew.requests![2]!],
    };
    expect(arrivalsBetween(before, after, 9)).toEqual([{ id: 'c1:2:junior:answer:9', agentId: 'j', kind: 'answer' }]);
  });

  it('in a tree, a member that wraps to a row of its own is reached down the lane on the left of its brothers, then across the gap above it', () => {
    const lead = { left: 400, top: 0, width: 300, height: 100 };
    expect(linkPath(lead, { left: 400, top: 500, width: 300, height: 170 }, 136, 1000, 20)).toBe('M550.5 100.5 V118.5 H20.5 V492.5 H550.5 V500');
    // On the first row, or in a grid, as before.
    expect(linkPath(lead, { left: 100, top: 136, width: 300, height: 170 }, 136, 1000, 20)).toBe('M550.5 100.5 V118.5 H250.5 V136');
    expect(linkPath(lead, { left: 400, top: 500, width: 300, height: 170 }, 136, 1000)).toBe('M550.5 100.5 V118.5 H392.5 V524.5 H400');
  });

  it('draws the members as a tree, in the order of the team; a team with no levels keeps its grid', () => {
    const tree = crewTree([agent('d'), agent('j'), agent('s')], crew)!;
    expect(tree.map((node) => [node.agent.id, node.reports.map((report) => report.agent.id)])).toEqual([
      ['s', ['j']],
      ['d', []],
    ]);
    // The senior has no box here: the junior hangs from the lead, and there are no levels left.
    expect(crewTree([agent('d'), agent('j')], crew)).toBeUndefined();
    expect(crewTree([agent('s'), agent('d')], { ...crew, recipients: crew.recipients!.map(({ reportsTo: _r, ...rest }) => rest) })).toBeUndefined();
  });

  it('the panel keeps who reports to whom by key, and writes names for the daemon', () => {
    const drafts = draftsOf({ members: [{ name: 'junior', role: 'Code.', reportsTo: 'Senior', relation: 'Steps.' }, { name: 'senior', role: 'Plans.' }] });
    expect(drafts[0]!.reportsTo).toBe(drafts[1]!.key);
    expect(drafts[0]!.relation).toBe('Steps.');
    expect(draftTree(drafts).map(({ item, depth }) => `${item.name}${depth}`)).toEqual(['senior0', 'junior1']);
    expect(isUnder(drafts, drafts[0]!.key, drafts[1]!.key)).toBe(true);
    expect(isUnder(drafts, drafts[1]!.key, drafts[0]!.key)).toBe(false);
    const written = specOf({ name: 'shop', folder: '/x', leadKind: 'claude', leadName: 'manager', leadRole: '', leadModel: '', leadMode: '', talk: 'twoway', members: drafts });
    expect(written.members).toEqual([
      { name: 'junior', role: 'Code.', reportsTo: 'senior', relation: 'Steps.' },
      { name: 'senior', role: 'Plans.' },
    ]);
    expect('spec' in cleanCrewSpec(written)).toBe(true);
    // Taking out the senior moves the junior up to the lead.
    expect(withoutDraft(drafts, drafts[1]!.key).map((draft) => [draft.name, draft.reportsTo])).toEqual([['junior', undefined]]);
  });
});
