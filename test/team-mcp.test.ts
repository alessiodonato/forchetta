import { describe, expect, it } from 'vitest';
import { teamMcpConfig } from '../src/daemon/spawn.ts';
import { answersText, type Call, createHandler, instructionsFor, setWaitClock, TOOLS, WAIT_RETRY_MS } from '../src/mcp/team.ts';
import { cleanTemplate, TEMPLATE_TOOLS } from '../src/shared/crew.ts';

// The MCP server of the tools of a team, as Claude Code talks to it: one JSON-RPC message, one answer.

const calls: { route: string; body: Record<string, unknown> }[] = [];
const call: Call = async (route, body) => {
  calls.push({ route, body });
  if (route === 'team') return { ok: true, text: 'Team "checkout". You are lead, the lead.' };
  if (route === 'request') return body.to && (body.to as string[]).includes('nobody') ? { ok: false, error: 'nobody to send it to' } : { ok: true, n: 3, to: ['tester', 'formatter'] };
  if (route === 'question') return { ok: true, n: 3, to: 'the user' };
  return { ok: false, error: 'unknown' };
};

describe('the MCP server of a team', () => {
  it('waits for the answers: starts a wait, asks again until it is over, gives them all', async () => {
    const asked: string[] = [];
    let polls = 0;
    const waiting: Call = async (route, body) => {
      asked.push(route);
      if (route === 'wait') return { ok: true, id: 'w1', requests: [3, 4] };
      if (route === 'wait-poll') {
        expect(body).toEqual({ agent: 'agent-1', id: 'w1' });
        return ++polls < 3 ? { ok: true, done: false, answers: [], open: ['#3 tester'] } : {
          ok: true,
          done: true,
          open: ['#4 docs'],
          answers: [
            { n: 3, from: 'tester', status: 'done', talk: 'twoway', answer: '8 tests pass.' },
            { n: 3, from: 'formatter', status: 'done', talk: 'oneway' },
          ],
        };
      }
      return { ok: false };
    };
    const handle = createHandler({ agent: 'agent-1', tools: ['wait_for_answers'], call: waiting });
    const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_answers', arguments: {} } });
    expect(asked).toEqual(['wait', 'wait-poll', 'wait-poll', 'wait-poll']);
    expect((reply?.result as { content: { text: string }[] }).content[0]!.text).toBe(
      'Answers:\n- tester, request #3:\n8 tests pass.\n- formatter, request #3: finished (it executes only: no answer)\n\nStill open, they will reach you as new prompts: #4 docs.',
    );
  });

  it('keeps waiting while the daemon restarts, and gives up only if it does not come back', async () => {
    let clock = 0;
    setWaitClock(
      () => clock,
      async (ms) => {
        clock += ms;
      },
    );
    try {
      let down = 3;
      const restarting: Call = async (route) => {
        if (route === 'wait') return { ok: true, id: 'w1', requests: [3] };
        if (down-- > 0) throw new Error('fetch failed');
        return { ok: true, done: true, open: [], answers: [{ n: 3, from: 'tester', status: 'done', talk: 'twoway', answer: 'Done.' }] };
      };
      const reply = await createHandler({ agent: 'agent-1', tools: ['wait_for_answers'], call: restarting })({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_answers', arguments: {} } });
      expect((reply?.result as { content: { text: string }[] }).content[0]!.text).toBe('Answers:\n- tester, request #3:\nDone.');

      const gone: Call = async (route) => {
        if (route === 'wait') return { ok: true, id: 'w2', requests: [3] };
        throw new Error('fetch failed');
      };
      clock = 0;
      const given = await createHandler({ agent: 'agent-1', tools: ['wait_for_answers'], call: gone })({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wait_for_answers', arguments: {} } });
      expect(clock).toBeGreaterThan(WAIT_RETRY_MS);
      expect((given?.result as { content: { text: string }[]; isError?: boolean }).content[0]!.text).toContain('Forchetta does not answer (fetch failed)');
    } finally {
      setWaitClock(Date.now, (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }
  });

  it('says what each answer is, failed ones too', () => {
    expect(answersText([{ n: 2, from: 'a', status: 'failed', reason: 'the session ended' }, { n: 2, from: 'b', status: 'done', talk: 'twoway' }], [])).toBe(
      'Answers:\n- a, request #2: failed (the session ended)\n- b, request #2: finished (its answer already reached you as a prompt)',
    );
    expect(answersText([], ['#5 x'])).toBe('No request finished in time.\n\nStill open, they will reach you as new prompts: #5 x.');
  });

  const lead = createHandler({ agent: 'agent-1', tools: ['team', 'send_request'], call });
  const member = createHandler({ agent: 'agent-2', tools: ['team', 'ask_lead'], call });

  it('says hello in the version the client asks, with tools only', async () => {
    const reply = await lead({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    expect(reply).toMatchObject({ id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'forchetta' } } });
    expect(await lead({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect(await lead({ jsonrpc: '2.0', id: 2, method: 'nope' })).toMatchObject({ error: { code: -32601 } });
  });

  it('lists the tools of the session, and only those', async () => {
    expect(await lead({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [TOOLS.team, TOOLS.send_request] } });
    expect(((await member({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(['team', 'ask_lead']);
  });

  it('sends a request for the lead, and says where it went', async () => {
    calls.length = 0;
    const reply = await lead({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'send_request', arguments: { to: ['all'], request: 'Write the parser.' } } });
    expect(calls).toEqual([{ route: 'request', body: { agent: 'agent-1', to: ['all'], text: 'Write the parser.' } }]);
    expect(reply?.result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('Request #3 is in the queue of tester, formatter.') }] });
    const refused = await lead({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'send_request', arguments: { to: ['nobody'], request: 'x' } } });
    expect(refused?.result).toEqual({ content: [{ type: 'text', text: 'nobody to send it to' }], isError: true });
  });

  it('a member asks; a tool the session does not have is refused without asking the daemon', async () => {
    calls.length = 0;
    const asked = await member({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask_lead', arguments: { question: 'JSON or YAML?' } } });
    expect(asked?.result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('the user, in the Forchetta app') }] });
    const refused = await member({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'send_request', arguments: { to: ['all'], request: 'x' } } });
    expect(refused?.result).toEqual({ content: [{ type: 'text', text: 'This session has no tool send_request.' }], isError: true });
    expect(calls.map((item) => item.route)).toEqual(['question']);
  });

  it('says so when Forchetta does not answer', async () => {
    const down = createHandler({ agent: 'a', tools: ['team'], call: async () => Promise.reject(new Error('ECONNREFUSED')) });
    const reply = await down({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'team', arguments: {} } });
    expect(reply?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Forchetta does not answer (ECONNREFUSED)') }] });
  });

  it('is configured for one session: its id, the folder of the daemon, its tools', () => {
    expect(teamMcpConfig({ command: '/usr/local/bin/node', args: ['/F/dist/team-mcp.js'] }, 'agent-1', '/F/var', ['team', 'send_request'])).toEqual({
      mcpServers: {
        forchetta: {
          type: 'stdio',
          command: '/usr/local/bin/node',
          args: ['/F/dist/team-mcp.js'],
          env: { FORCHETTA_AGENT: 'agent-1', FORCHETTA_VAR: '/F/var', FORCHETTA_TEAM_TOOLS: 'team,send_request' },
          timeout: 660_000,
        },
      },
    });
  });
});

describe('the tools of templates, for a session not in a team', () => {
  const asked: { route: string; body: Record<string, unknown> }[] = [];
  const templates: Call = async (route, body) => {
    asked.push({ route, body });
    if (route === 'templates') return { ok: true, text: body.name ? `The template "${String(body.name)}":\n{}` : 'The templates of teams in Forchetta.' };
    if (route === 'template-save') return (body.template as { name?: string }).name === 'taken' ? { ok: false, error: 'a template "taken" already exists' } : { ok: true, text: 'Saved the template "Bakery".' };
    return { ok: false, error: 'unknown route' };
  };
  const session = createHandler({ agent: 'agent-9', tools: TEMPLATE_TOOLS, call: templates });

  it('lists only those, and its instructions say when to use them', async () => {
    expect(((await session({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(['list_team_templates', 'save_team_template']);
    const hello = (await session({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }))?.result as { instructions: string };
    expect(hello.instructions).toContain('save it as a template with save_team_template: the user then starts it from the app');
    expect(hello.instructions).not.toContain('your team');
    expect(instructionsFor(['team', 'send_request'])).toBe('The tools of your team of agents in Forchetta.');
  });

  it('saves: the template goes to the daemon without replace, which goes on its own; a refusal says it was not saved', async () => {
    asked.length = 0;
    const template = { name: 'Bakery', lead: { kind: 'you' }, members: [{ name: 'a', role: 'Does a.' }] };
    const saved = await session({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'save_team_template', arguments: { ...template, replace: true } } });
    expect(asked).toEqual([{ route: 'template-save', body: { agent: 'agent-9', template, replace: true } }]);
    expect(saved?.result).toEqual({ content: [{ type: 'text', text: 'Saved the template "Bakery".' }] });
    const refused = await session({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'save_team_template', arguments: { ...template, name: 'taken' } } });
    expect(asked[1]!.body.replace).toBe(false);
    expect(refused?.result).toEqual({ content: [{ type: 'text', text: 'The template was not saved: a template "taken" already exists' }], isError: true });
  });

  it('lists all of them, or one by its name', async () => {
    asked.length = 0;
    await session({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_team_templates', arguments: {} } });
    const one = await session({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_team_templates', arguments: { name: 'Bakery' } } });
    expect(asked.map((item) => item.body)).toEqual([{ agent: 'agent-9' }, { agent: 'agent-9', name: 'Bakery' }]);
    expect(one?.result).toEqual({ content: [{ type: 'text', text: 'The template "Bakery":\n{}' }] });
  });

  it('a session of a team does not have them, and a session of templates has no tool of a team', async () => {
    const member = createHandler({ agent: 'agent-2', tools: ['team', 'ask_lead'], call: templates });
    expect((await member({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'save_team_template', arguments: {} } }))?.result).toMatchObject({ isError: true });
    expect((await session({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'send_request', arguments: {} } }))?.result).toMatchObject({ isError: true });
  });

  it('the schema of save_team_template takes what the daemon keeps of a template, and nothing else', () => {
    const schema = TOOLS.save_team_template.inputSchema as { properties: Record<string, { properties?: object; items?: { properties: object } }> };
    const checked = cleanTemplate({
      name: 'All',
      lead: { kind: 'claude', name: 'l', role: 'r', model: 'opus', mode: 'plan', skills: ['brainstorming'] },
      talk: 'oneway',
      worktrees: true,
      rules: 'Small commits.',
      members: [
        { name: 'boss', role: 'r' },
        { name: 'm', role: 'r', talk: 'twoway', model: 'haiku', mode: 'auto', worktree: false, paths: ['src/'], reviews: true, reportsTo: 'boss', relation: 'How the two work.', skills: ['pdf'] },
      ],
    });
    if ('error' in checked) throw new Error(checked.error);
    const { lead, members, ...team } = checked.template;
    expect(Object.keys(schema.properties).sort()).toEqual([...Object.keys(team), 'lead', 'members', 'replace'].sort());
    expect(Object.keys(schema.properties.lead!.properties!).sort()).toEqual(Object.keys(lead).sort());
    expect(Object.keys(schema.properties.members!.items!.properties).sort()).toEqual(Object.keys(members[1]!).sort());
  });
});
