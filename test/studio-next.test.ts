import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Crews } from '../src/daemon/crews.ts';
import { describeArgs, describeEnv, describeTeam, readOutput } from '../src/daemon/describe.ts';
import type { LedgerEntry } from '../src/daemon/ledger.ts';
import type { SpawnExtras } from '../src/daemon/spawn.ts';
import { newAgent } from '../src/daemon/state.ts';
import { demoDescribe } from '../src/demo/describe.ts';
import { takeValues } from '../src/cli/team.ts';
import { createHandler } from '../src/mcp/team.ts';
import type { Agent, QueuedCommand } from '../src/shared/agent.ts';
import { cleanTools, sessionTools, toolsPrompt, toolsText } from '../src/shared/agent-tools.ts';
import {
  BUILTIN_ROLES,
  BUILTIN_TEMPLATES,
  cleanCrewSpec,
  cleanRolePreset,
  cleanTemplate,
  type CrewSpec,
  crewLineOf,
  fillParams,
  leadPrompt,
  memberPrompt,
  missingParams,
  paramsIn,
  paramsUsed,
  teamToolsFor,
  templateOf,
  threadOf,
} from '../src/shared/crew.ts';
import { describeChatPrompt, describePrompt, templateOfAnswer } from '../src/shared/describe.ts';
import { teamMcpConfig } from '../src/shared/mcp-config.ts';
import { eventLine, replayAt, replayOf } from '../src/shared/replay.ts';
import { TEMPLATE_SCHEMA } from '../src/shared/team-schema.ts';
import { linkStates } from '../src/ui/org-lines.ts';
import { addTool, docOfTemplate, problems, specOfDoc, templateOfDoc, updateLink, updateParam } from '../src/ui/studio-model.ts';
import { entryHead, entryTag } from '../src/ui/TeamRequests.tsx';
import { ROOT } from '../src/shared/paths.ts';
import { tempDir } from './helpers.ts';

// The studio, next steps: the tools of each agent, a point of approval on an arrow, the parameters and the
// deliverable of a team, the replay of a run, and a team drawn from a description.

const temp = tempDir('studio-next');
afterAll(() => temp.cleanup());

const checked = (input: unknown): CrewSpec => {
  const result = cleanCrewSpec(input);
  if ('error' in result) throw new Error(result.error);
  return result.spec;
};

/** A team started with fake sessions: lead agent-1, then the members in order; the queue and the hooks by hand. */
async function started(input: unknown) {
  const crews = new Crews(join(temp.dir, `crews-${Math.random()}`));
  let next = 0;
  const extras: SpawnExtras[] = [];
  const result = await crews.create(checked(input), async (_choices, more) => {
    extras.push(more);
    return { ok: true as const, agentId: `agent-${++next}` };
  });
  if (!result.ok) throw new Error(result.error);
  const queued: { agentId: string; text: string; id: string; n: number }[] = [];
  crews.enqueue = (agentId, text, link) => {
    const command: QueuedCommand = { id: `cmd-${queued.length + 1}`, kind: 'request', arg: text, request: link, status: 'in-coda', createdAt: 0 };
    queued.push({ agentId, text, id: command.id, n: link.n });
    return { ok: true, command };
  };
  crews.agent = (id) => ({ ...newAgent({ id, control: { kind: 'tmux', session: 'x' } }, 0), state: 'idle' }) as Agent;
  const crewId = result.crewId!;
  const confirm = (item: { id: string; text: string; n: number }) =>
    crews.commandChanged({ id: item.id, kind: 'request', arg: item.text, request: { crew: crewId, n: item.n }, status: 'confermato', createdAt: 0 });
  const stop = (id: string, message: string) => crews.hook({ ...newAgent({ id, control: { kind: 'tmux', session: `fk-${id}` } }, 0), team: { crew: crewId } }, { hook_event_name: 'Stop', session_id: 's', last_assistant_message: message });
  const delivery = (n: number, to: string) => crews.get(crewId)!.requests!.find((request) => request.n === n)!.deliveries.find((d) => d.to === to)!;
  return { crews, crewId, queued, confirm, stop, delivery, extras };
}

const team = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'shop',
  cwd: '/Users/dev/shop',
  lead: { kind: 'claude', name: 'lead', role: 'Plans the work.' },
  talk: 'twoway',
  members: [
    { name: 'developer', role: 'Writes the code.', approve: true },
    { name: 'tester', role: 'Tests the pages.', tools: { mcp: ['playwright'] } },
  ],
  ...patch,
});

describe('the tools of an agent', () => {
  it('are checked: known limits and servers, each once, in the order of the catalog', () => {
    expect(cleanTools({ limits: ['no-push', 'read-only', 'no-push'], mcp: ['context7', 'playwright'], strictMcp: true })).toEqual({ tools: { limits: ['read-only', 'no-push'], mcp: ['playwright', 'context7'], strictMcp: true } });
    expect(cleanTools({ limits: [], mcp: [] })).toEqual({});
    expect(cleanTools(undefined)).toEqual({});
    expect(cleanTools({ mcp: ['github'] })).toEqual({ error: 'unknown MCP server "github": the catalog has playwright, chrome-devtools, context7' });
    expect(cleanTools({ limits: ['root'] })).toMatchObject({ error: expect.stringContaining('unknown tool limit "root"') });
  });

  it('become the arguments of its session: rules denied, its own MCP servers at their version, allowed without asking', () => {
    const tools = sessionTools({ limits: ['read-only', 'no-push'], mcp: ['playwright', 'chrome-devtools'], strictMcp: true });
    expect(tools.disallowed).toEqual(['Edit', 'Write', 'NotebookEdit', 'Bash(git push:*)']);
    expect(tools.servers.playwright).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@0.0.84', '--headless', '--isolated'] });
    expect(tools.servers['chrome-devtools']!.args).toContain('--no-usage-statistics');
    expect(tools.allowed).toEqual(['mcp__playwright', 'mcp__chrome-devtools']);
    expect(tools.strict).toBe(true);
    expect(sessionTools(undefined)).toEqual({ disallowed: [], servers: {}, allowed: [], strict: false });
    // One MCP configuration: its servers and, for a session of a team, the one of Forchetta.
    const config = teamMcpConfig({ command: '/n/node', args: ['/F/team-mcp.js'] }, 'a1', '/F/var', ['team'], tools.servers) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(config.mcpServers)).toEqual(['playwright', 'chrome-devtools', 'forchetta']);
    expect(Object.keys((teamMcpConfig(undefined, 'a1', '/F/var', [], tools.servers) as { mcpServers: object }).mcpServers)).toEqual(['playwright', 'chrome-devtools']);
  });

  it.skipIf(process.platform === 'win32')('forchetta-start gives each rule as an argument of its own, globs untouched, and the strict MCP option', () => {
    const fake = join(temp.dir, 'claude-args');
    spawnSync('/bin/sh', ['-c', `printf '#!/bin/sh\\nfor a in "$@"; do printf "[%%s]\\\\n" "$a"; done\\n' > '${fake}' && chmod +x '${fake}'`]);
    const run = spawnSync('/bin/sh', [join(ROOT, 'bin', 'forchetta-start'), fake], {
      cwd: temp.dir,
      env: { PATH: '/usr/bin:/bin', FORCHETTA_MCP_CONFIG: '/F/m.json', FORCHETTA_STRICT_MCP: '1', FORCHETTA_ALLOWED_TOOLS: 'mcp__forchetta\nmcp__playwright', FORCHETTA_DISALLOWED_TOOLS: 'Edit\nBash(git push:*)', FORCHETTA_PROMPT: 'go' },
      encoding: 'utf8',
    });
    expect(run.stdout.trim().split('\n')).toEqual(['[--mcp-config]', '[/F/m.json]', '[--strict-mcp-config]', '[--allowedTools]', '[mcp__forchetta]', '[mcp__playwright]', '[--disallowedTools]', '[Edit]', '[Bash(git push:*)]', '[--]', '[go]']);
  });

  it('go with the agent: in the spec, the presets, the prompts and its session', async () => {
    const spec = checked(team({ lead: { kind: 'claude', name: 'lead', role: 'Plans.', tools: { mcp: ['context7'] } } }));
    expect(spec.members[1]!.tools).toEqual({ mcp: ['playwright'] });
    expect(cleanRolePreset({ name: 'qa', role: 'Tests.', tools: { limits: ['no-web'] } })).toEqual({ preset: { name: 'qa', role: 'Tests.', tools: { limits: ['no-web'] } } });
    expect(memberPrompt(spec, spec.members[1]!)).toContain('Your tools in the team, for you only: browser (the MCP server "playwright", its tools mcp__playwright__*).');
    expect(leadPrompt(spec)).toContain('- tester (answers you, browser): Tests the pages.');
    expect(leadPrompt(spec)).toContain('library docs (the MCP server "context7"');
    expect(toolsPrompt({ limits: ['read-only'] })).toContain('Your limits in the team: you do not edit files');
    expect(toolsText({ limits: ['read-only', 'no-push'], mcp: ['playwright'] })).toBe('read only, no git push, browser');
    const { extras } = await started(team());
    expect(extras.map((more) => more.tools)).toEqual([undefined, undefined, { mcp: ['playwright'] }]);
  });

  it('the presets of Forchetta give the reviewer read only and no push, the tester a browser, also in its templates', () => {
    expect(BUILTIN_ROLES.find((role) => role.name === 'reviewer')!.tools).toEqual({ limits: ['read-only', 'no-push'] });
    expect(BUILTIN_TEMPLATES.find((template) => template.name === 'feature squad')!.members.find((member) => member.name === 'tester')!.tools).toEqual({ mcp: ['playwright'] });
    for (const template of BUILTIN_TEMPLATES) expect('template' in cleanTemplate(template)).toBe(true);
  });
});

describe('a point of approval on an arrow', () => {
  it('a request of the lead waits for your yes; yours goes at once', async () => {
    const { crews, crewId, queued, delivery } = await started(team());
    const told: string[] = [];
    crews.onApproval = (_crew, request, item) => told.push(`#${request.n} ${item.to}`);
    expect(crews.requestFrom('agent-1', ['developer', 'tester'], 'Add the cart.')).toMatchObject({ ok: true, n: 1 });
    expect(delivery(1, 'developer').status).toBe('approval');
    expect(delivery(1, 'tester').status).toBe('queued');
    expect(queued.map((item) => item.agentId)).toEqual(['agent-3']);
    expect(told).toEqual(['#1 developer']);
    expect(crewLineOf('agent-1', crews.summaries())).toBe('waits on #1 developer (your approval), #1 tester');
    expect(linkStates(crews.summaries()[0]!).get('agent-2')).toBe('approval');
    crews.request(crewId, ['developer'], 'From you.');
    expect(delivery(2, 'developer').status).toBe('queued');
  });

  it('approved, as it was or changed: it reaches the member with its header; the thread says what you did', async () => {
    const { crews, crewId, queued, delivery } = await started(team());
    crews.requestFrom('agent-1', ['developer'], 'Add the cart.');
    expect(crews.decide(crewId, 1, 'Developer', true, { text: 'Add the cart, with tests.' })).toEqual({ ok: true, status: 'queued' });
    expect(queued.at(-1)).toMatchObject({ agentId: 'agent-2', text: 'Request #1 from lead:\nAdd the cart, with tests.' });
    expect(delivery(1, 'developer').approval).toMatchObject({ decision: 'approved', edited: true });
    const entry = threadOf(crews.thread(crewId)!).find((item) => item.kind === 'approval')!;
    expect([entryHead(entry), entryTag(entry)]).toEqual(['you · approved #1 for developer', 'changed by you']);
    expect(crews.decide(crewId, 1, 'developer', true)).toEqual({ ok: false, error: 'request #1 to developer does not wait for your approval' });
    expect(crews.decide(crewId, 9, 'developer', true)).toEqual({ ok: false, error: 'no request #9 to developer' });
  });

  it('sent back: cancelled, and the lead learns why; the request it was part of can end', async () => {
    const { crews, crewId, queued, confirm, stop, delivery } = await started(team());
    crews.request(crewId, ['lead'], 'Build the cart.');
    confirm(queued[0]!);
    crews.requestFrom('agent-1', ['developer'], 'Rewrite everything.');
    stop('agent-1', 'Sent to the developer.');
    expect(delivery(1, 'lead').status).toBe('delegated');
    expect(crews.decide(crewId, 2, 'developer', false, { note: 'Too big: only the cart.' })).toEqual({ ok: true, status: 'cancelled' });
    expect(delivery(2, 'developer')).toMatchObject({ status: 'cancelled', reason: 'sent back by the user: Too big: only the cart.' });
    expect(queued.at(-1)).toMatchObject({ agentId: 'agent-1', text: expect.stringContaining('The user sent back request #2 to developer:\nToo big: only the cart.') });
    // The lead reads it and ends its turn: its request is over.
    confirm(queued.at(-1)!);
    stop('agent-1', 'I will ask for the cart only.');
    expect(delivery(1, 'lead').status).toBe('done');
  });

  it('can change on a running team: the lead is told with its next text', async () => {
    const { crews, crewId, queued, delivery } = await started(team());
    expect(crews.setApprove(crewId, 'tester', true)).toEqual({ ok: true });
    crews.request(crewId, ['lead'], 'Go.');
    expect(queued.at(-1)!.text).toContain('your requests to tester now wait for the approval of the user first');
    crews.requestFrom('agent-1', ['tester'], 'Test it.');
    expect(delivery(2, 'tester').status).toBe('approval');
    expect(leadPrompt(checked(team()))).toContain('If the user sends one back, you get a prompt that starts with "The user sent back request #<n> to <name>:"');
  });
});

describe('parameters and what a team delivers', () => {
  it('{name} in the texts; ${name} of a shell is not one', () => {
    expect(paramsIn('Fix {ticket} on {branch}, not ${HOME} nor ${x}; {ticket} again; {Upper}')).toEqual(['ticket', 'branch']);
    expect(fillParams('Fix {ticket}, keep ${ticket}', { ticket: 'APP-1' })).toBe('Fix APP-1, keep ${ticket}');
    const spec = checked(
      team({
        rules: 'Work on {branch}.',
        deliverable: 'A pull request for {ticket}.',
        params: [{ name: 'ticket', hint: 'the ticket, like APP-123' }, { name: 'branch', default: 'main' }, { name: 'unused' }],
        values: { ticket: ' APP-7 ', other: 'x' },
      }),
    );
    expect(paramsUsed(spec)).toEqual(['branch', 'ticket']);
    expect(spec.params).toEqual([{ name: 'ticket', hint: 'the ticket, like APP-123' }, { name: 'branch', default: 'main' }]);
    expect(spec.values).toEqual({ ticket: 'APP-7' });
    expect(missingParams({ ...spec, values: {} })).toEqual([{ name: 'ticket', hint: 'the ticket, like APP-123' }]);
    expect(cleanCrewSpec(team({ params: [{ name: 'Bad Name' }] }))).toMatchObject({ error: expect.stringContaining('the parameter "Bad Name"') });
  });

  it('a team starts only with a value for each; its sessions read them filled, its template keeps the parameters', async () => {
    const base = team({ members: [{ name: 'developer', role: 'Fixes {ticket}.' }], deliverable: 'A pull request for {ticket}.' });
    const crews = new Crews(undefined);
    expect(await crews.create(checked(base), async () => ({ ok: true, agentId: 'x' }))).toEqual({ ok: false, error: 'fill the parameter of the team first: {ticket}' });
    const { crews: running, crewId, queued, extras } = await started({ ...base, values: { ticket: 'APP-9' } });
    expect(extras[1]!.system).toContain('Your role: Fixes APP-9.');
    expect(extras[1]!.system).toContain('The values this team started with: ticket = APP-9.');
    expect(extras[0]!.system).toContain('What the team delivers when its work is done: A pull request for APP-9.');
    expect(extras[1]!.team?.role).toBe('Fixes APP-9.');
    running.request(crewId, ['lead'], 'Start on {ticket}.');
    expect(queued.at(-1)!.text).toBe('Request #1 from the user:\nStart on APP-9.');
    const crew = running.get(crewId)!;
    expect(templateOf(crew).members[0]!.role).toBe('Fixes {ticket}.');
    expect(templateOf(crew)).not.toHaveProperty('values');
    expect(running.summaries()[0]).toMatchObject({ deliverable: 'A pull request for APP-9.', values: { ticket: 'APP-9' } });
  });

  it('the lead says it delivered with deliver: you are told, the thread says it; a member cannot', async () => {
    const { crews, crewId } = await started(team({ deliverable: 'A pull request.' }));
    expect(teamToolsFor(checked(team({ deliverable: 'x' })), 'lead')).toContain('deliver');
    expect(teamToolsFor(checked(team()), 'lead')).not.toContain('deliver');
    const told: string[] = [];
    crews.onDelivered = (_crew, item) => told.push(`${item.by}: ${item.where}`);
    expect(crews.deliver('agent-2', 'Done.', undefined)).toEqual({ ok: false, error: 'only the lead of a team says that its work is delivered' });
    expect(crews.deliver('agent-1', 'Cart, 12 tests green.', 'https://github.com/o/r/pull/3', 5)).toEqual({ ok: true, at: 5 });
    expect(told).toEqual(['lead: https://github.com/o/r/pull/3']);
    expect(crews.summaries()[0]!.delivered).toMatchObject({ by: 'lead', summary: 'Cart, 12 tests green.' });
    const entry = threadOf([], [], crews.deliveredOf(crewId))[0]!;
    expect([entryHead(entry), entryTag(entry)]).toEqual(['lead · delivered https://github.com/o/r/pull/3', 'done']);
    expect(crews.teamText('agent-1')).toContain('It delivers: A pull request. Delivered by lead (https://github.com/o/r/pull/3): Cart, 12 tests green.');
  });

  it('the tool deliver calls the daemon', async () => {
    const calls: unknown[] = [];
    const handle = createHandler({ agent: 'a1', tools: ['team', 'deliver'], call: async (route, body) => (calls.push([route, body]), { ok: true }) });
    const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deliver', arguments: { summary: 'Done', where: 'main' } } });
    expect(calls).toEqual([['deliver', { agent: 'a1', summary: 'Done', where: 'main' }]]);
    expect(JSON.stringify(reply)).toContain('the user is told');
  });

  it('forchetta team start takes --set for each value', () => {
    expect(takeValues(['bugfix', '--set', 'ticket=APP-1', '--set={area}=billing', '--goal', 'x=y'])).toEqual({ rest: ['bugfix', '--goal', 'x=y'], values: { ticket: 'APP-1', area: 'billing' } });
    expect(() => takeValues(['--set', 'ticket'])).toThrow('--set takes a parameter and its value');
  });
});

describe('the studio keeps them', () => {
  it('tools, approvals, deliverable and parameters go to the team and back through a template', () => {
    let doc = docOfTemplate({ ...cleanTemplateOrThrow(team({ deliverable: 'A PR for {ticket}.' })), name: 'shop' }, '/Users/dev/shop');
    expect(doc.links.find((link) => doc.nodes.find((node) => node.key === link.to)?.name === 'developer')?.approve).toBe(true);
    const tester = doc.nodes.find((node) => node.name === 'tester')!;
    const added = addTool(doc, tester.key, 'context7');
    if ('error' in added) throw new Error(added.error);
    doc = added.doc;
    expect(addTool(doc, tester.key, 'context7')).toEqual({ error: 'tester has the library docs already.' });
    doc = updateParam(doc, 'ticket', { hint: 'the ticket' });
    expect(problems(doc, true)).toEqual(['Give a value to {ticket} (the ticket): the team needs it to start.']);
    expect(problems(doc)).toEqual([]);
    doc = { ...doc, values: { ticket: 'APP-3' } };
    expect(problems(doc, true)).toEqual([]);
    const spec = specOfDoc(doc);
    if ('error' in spec) throw new Error(spec.error);
    expect(spec.spec.members.find((member) => member.name === 'tester')!.tools).toEqual({ mcp: ['playwright', 'context7'] });
    expect(spec.spec).toMatchObject({ deliverable: 'A PR for {ticket}.', params: [{ name: 'ticket', hint: 'the ticket' }], values: { ticket: 'APP-3' } });
    const template = templateOfDoc(doc);
    if ('error' in template) throw new Error(template.error);
    expect(template.template).not.toHaveProperty('values');
    expect(template.template.params).toEqual([{ name: 'ticket', hint: 'the ticket' }]);
    // An arrow from You has no approval: your requests are yours.
    const top = doc.links.find((link) => link.from === 'you')!;
    const fromYou = specOfDoc(updateLink(doc, top.to, { approve: true }));
    expect('spec' in fromYou && fromYou.spec.lead.kind).toBe('claude');
  });
});

function cleanTemplateOrThrow(input: unknown) {
  const result = cleanTemplate(input);
  if ('error' in result) throw new Error(result.error);
  return result.template;
}

describe('the replay of a run', () => {
  it('lights each arrow while its request is open, and counts what each agent cost and wrote until then', async () => {
    const { crews, crewId, queued, confirm } = await started(team());
    const t0 = crews.get(crewId)!.createdAt;
    crews.request(crewId, ['lead'], 'Build the cart.', 'the user', t0 + 1000);
    confirm(queued[0]!);
    crews.requestFrom('agent-1', ['tester'], 'Test the cart.', t0 + 2000);
    confirm(queued[1]!);
    crews.hook({ ...newAgent({ id: 'agent-3', control: { kind: 'tmux', session: 'fk' } }, 0), team: { crew: crewId } }, { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'All green.' }, t0 + 3000);
    const entries: LedgerEntry[] = [
      { t: t0 - 5, kind: 'cost', agent: 'agent-3', project: 'shop', usd: 4 },
      { t: t0 + 2500, kind: 'cost', agent: 'agent-3', project: 'shop', usd: 0.25 },
      { t: t0 + 2600, kind: 'turn', agent: 'agent-3', project: 'shop', files: ['tests/cart.spec.ts'] },
      { t: t0 + 2700, kind: 'cost', agent: 'someone-else', project: 'other', usd: 9 },
    ];
    const data = crews.replay(crewId, entries, t0 + 3010)!;
    expect(data.events.map((event) => event.kind)).toEqual(['request', 'request', 'turn', 'answer']);
    expect(data.costs).toEqual([{ t: t0 + 2500, who: 'tester', usd: 0.25 }]);
    const middle = replayAt(data, t0 + 2650);
    expect(middle.arrows.get('lead')).toBe('working');
    expect(middle.arrows.get('tester')).toBe('working');
    expect(middle.agents.get('tester')).toEqual({ usd: 0.25, files: ['tests/cart.spec.ts'], on: 2 });
    expect(eventLine(data.events[2]!)).toBe('tester wrote tests/cart.spec.ts');
    const end = replayAt(data, t0 + 3000);
    expect(end.arrows.get('tester')).toBe('answer');
    expect(eventLine(data.events[3]!)).toBe('#2 tester answers lead: All green.');
  });

  it('a request that waits for your approval is amber until you decide', () => {
    const data = replayOf({
      createdAt: 0,
      requests: [{ n: 1, from: 'lead', text: 'Go', createdAt: 10, deliveries: [{ to: 'developer', status: 'queued', at: 50, approval: { decision: 'approved', at: 40 } }] }],
    }, [], 100);
    expect(replayAt(data, 20).arrows.get('developer')).toBe('approval');
    expect(replayAt(data, 45).arrows.get('developer')).toBe('working');
    expect(data.events.map((event) => eventLine(event))).toEqual(['#1 lead → developer: Go', '#1 approved by you for developer']);
    expect(data.end).toBe(100);
  });
});

describe('a team drawn from a description', () => {
  it('claude runs alone: print mode, the schema of a template, no tools, no MCP of yours, no hooks, nothing kept', () => {
    const args = describeArgs();
    expect(args.slice(0, 3)).toEqual(['-p', '--model', 'sonnet']);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--no-session-persistence');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({ disableAllHooks: true });
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toEqual(TEMPLATE_SCHEMA);
    const env = describeEnv({ PATH: '/usr/bin', FORCHETTA_AGENT: 'a', CLAUDECODE: '1', HOME: '/h' });
    expect(env).toMatchObject({ HOME: '/h' });
    expect(env.FORCHETTA_AGENT).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  it('reads the structured answer, or the text, or the error, from the last JSON line', () => {
    expect(readOutput('hello from a profile\n{"type":"result","is_error":false,"result":"","structured_output":{"name":"x"},"total_cost_usd":0.02}\n')).toEqual({ answer: { name: 'x' }, usd: 0.02 });
    expect(readOutput('{"is_error":true,"result":"Not logged in","total_cost_usd":0}')).toEqual({ error: 'Not logged in', usd: 0 });
    expect(readOutput('nothing')).toEqual({ error: 'claude gave no answer' });
  });

  it('takes a template as an object, in a text, or in a team file; a wrong one is refused', () => {
    const template = { name: 'squad', lead: { kind: 'claude', name: 'lead', role: 'Leads.' }, talk: 'twoway', members: [{ name: 'dev', role: 'Builds.', tools: { mcp: ['playwright'] } }] };
    expect(templateOfAnswer(template)).toMatchObject({ template: { name: 'squad', members: [{ name: 'dev', tools: { mcp: ['playwright'] } }] } });
    expect(templateOfAnswer(`Here it is:\n\`\`\`json\n${JSON.stringify({ kind: 'forchetta-team', version: 1, template })}\n\`\`\``)).toMatchObject({ template: { name: 'squad' } });
    expect(templateOfAnswer({ ...template, members: [] })).toEqual({ error: 'add at least one member' });
    expect(templateOfAnswer('no team')).toEqual({ error: 'Claude did not write a team' });
    expect(describePrompt('A team for tests.')).toContain('- tester (sonnet); skills: webapp-testing, property-based-testing; tools: browser:');
    expect(describeChatPrompt('A team for tests.')).toContain('{"kind": "forchetta-team", "version": 1, "template": <the template>}');
  });

  it('asks once more when Forchetta refuses the team, and never takes the name of a template you have', async () => {
    const answers = [
      { name: 'squad', lead: { kind: 'claude', name: 'lead', role: 'x' }, talk: 'twoway', members: [] },
      { name: 'squad', lead: { kind: 'claude', name: 'lead', role: 'x' }, talk: 'twoway', members: [{ name: 'dev', role: 'Builds.' }] },
    ];
    const prompts: string[] = [];
    const result = await describeTeam('A small squad.', {
      claude: '/bin/claude',
      log: () => {},
      dir: join(temp.dir, 'describe'),
      templates: [{ name: 'Squad', lead: { kind: 'you' }, talk: 'twoway', members: [] }],
      run: async (args, input) => {
        expect(args[0]).toBe('-p');
        prompts.push(input);
        return { code: 0, stdout: JSON.stringify({ is_error: false, structured_output: answers[prompts.length - 1], total_cost_usd: 0.01 }), stderr: '' };
      },
    });
    expect(result).toMatchObject({ ok: true, usd: 0.02, template: { name: 'squad 2', members: [{ name: 'dev' }] } });
    expect(prompts[1]).toContain('Your last answer was refused by Forchetta: add at least one member.');
    expect(await describeTeam('  ', { claude: '/bin/claude', log: () => {} })).toMatchObject({ ok: false });
    const failed = await describeTeam('x', { claude: '/bin/claude', log: () => {}, dir: join(temp.dir, 'describe'), run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
    expect(failed).toEqual({ ok: false, error: 'Claude could not draw it: claude gave no answer' });
  });

  it('in the demo, the presets the words name', () => {
    const drawn = demoDescribe('A team with a senior, tests and a reviewer that approves, and a pull request');
    expect(drawn.ok).toBe(true);
    expect(drawn.template!.members.map((member) => [member.name, member.reportsTo, member.approve])).toEqual([
      ['senior', undefined, true],
      ['junior', 'senior', undefined],
      ['tester', undefined, true],
      ['reviewer', undefined, undefined],
    ]);
    expect(drawn.template!.deliverable).toContain('pull request');
  });
});
