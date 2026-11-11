import { describe, expect, it } from 'vitest';
import { teamMcpConfig } from '../src/daemon/spawn.ts';
import { answersText, type Call, createHandler, TOOLS } from '../src/mcp/team.ts';

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
