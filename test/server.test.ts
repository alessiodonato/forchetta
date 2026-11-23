import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/daemon/registry.ts';
import { OpenCodes } from '../src/daemon/open-codes.ts';
import { createDaemonServer, GUARD_PATH, HOOK_PATH, hookMeta, OPEN_PATH } from '../src/daemon/server.ts';
import { join } from 'node:path';
import { http, tempDir } from './helpers.ts';

const TOKEN = 'a'.repeat(64);
let server: ReturnType<typeof createDaemonServer>;
let port = 0;
const temp = tempDir('server');
/** The socket of the hooks, as the daemon opens it in its private folder. */
const hooks = join(temp.dir, 'hooks.sock');
let registry: Registry;
let shutdowns = 0;

beforeAll(async () => {
  registry = new Registry({ settleMs: 5 });
  server = createDaemonServer({
    registry,
    token: TOKEN,
    port: () => port,
    log: () => {},
    info: () => ({ pid: 1 }),
    onShutdown: () => shutdowns++,
    browser: { codes: new OpenCodes(), localhost: true },
    guard: (agent, payload) => (payload.tool_name === 'Edit' ? { decided: agent.sessionId } : undefined),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.hooks.listen(hooks, resolve));
});

afterAll(async () => {
  registry.dispose();
  await new Promise((resolve) => server.hooks.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  temp.cleanup();
});

const json = { 'content-type': 'application/json' };
const event = (extra: Record<string, unknown>): string =>
  JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: '/tmp/p', prompt: 'ciao', tool_response: { huge: 'x'.repeat(1000) }, ...extra });

describe('hook endpoint', () => {
  it('answers 200 with an empty body, so it never decides, blocks or adds context', async () => {
    const reply = await http(hooks, { method: 'POST', path: HOOK_PATH, headers: json, body: event({}) });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('');
    expect(registry.list().find((agent) => agent.sessionId === 's-1')?.state).toBe('working');
  });

  it('answers empty also to input it cannot read', async () => {
    for (const body of ['{not json', '{"session_id":"x"}', '[]']) {
      const reply = await http(hooks, { method: 'POST', path: HOOK_PATH, headers: json, body });
      expect(reply).toMatchObject({ status: 200, body: '' });
    }
  });

  it('refuses web pages: Origin header, form types, wrong Host', async () => {
    expect((await http(hooks, { method: 'POST', path: HOOK_PATH, headers: { ...json, origin: 'https://evil.example' }, body: event({}) })).status).toBe(403);
    expect((await http(hooks, { method: 'POST', path: HOOK_PATH, headers: { 'content-type': 'text/plain' }, body: event({}) })).status).toBe(415);
    // On the port of the daemon, where any process or user of this Mac can talk, the hooks are refused.
    expect((await http(port, { method: 'POST', path: HOOK_PATH, headers: json, body: event({}) })).status).toBe(403);
    expect((await http(port, { method: 'POST', path: GUARD_PATH, headers: json, body: event({}) })).status).toBe(403);
    // And the socket of the hooks is for the hooks only.
    expect((await http(hooks, { path: '/api/health', headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await http(hooks, { method: 'GET', path: HOOK_PATH })).status).toBe(405);
  });

  it('reads pid, pane and agent from the headers of the hook script', async () => {
    const agentId = '3f2b8c1e-1111-4222-8333-444455556666';
    const reply = await http(hooks, {
      method: 'POST',
      path: HOOK_PATH,
      headers: { ...json, 'x-forchetta-pid': '700', 'x-forchetta-claude-pid': '4242', 'x-forchetta-pane': '%3', 'x-forchetta-agent': agentId },
      body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-2', cwd: '/tmp/q', source: 'startup' }),
    });
    expect(reply).toMatchObject({ status: 200, body: '' });
    expect(registry.agents.get(agentId)).toMatchObject({ pid: 4242, sessionId: 's-2', control: { kind: 'tmux', paneId: '%3' } });
  });

  it('ignores malformed meta headers', () => {
    expect(hookMeta({ 'x-forchetta-pid': '1', 'x-forchetta-pane': 'bad', 'x-forchetta-agent': 'nope' })).toEqual({});
    expect(hookMeta({ 'x-forchetta-pid': '700', 'x-forchetta-claude-pid': '' })).toEqual({ pid: 700 });
  });
});

describe('guard endpoint', () => {
  const pre = (session: string, tool: string): string => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, tool_name: tool, tool_input: { file_path: '/tmp/p/a.ts' } });

  it('answers with the decision of the guard for a known session, and applies nothing', async () => {
    await http(hooks, { method: 'POST', path: HOOK_PATH, headers: json, body: event({ session_id: 's-guard' }) });
    const agent = registry.list().find((candidate) => candidate.sessionId === 's-guard')!;
    const before = JSON.stringify(agent);
    const reply = await http(hooks, { method: 'POST', path: GUARD_PATH, headers: json, body: pre('s-guard', 'Edit') });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ decided: 's-guard' });
    // The event comes through the hook endpoint too: here it changes nothing.
    expect(JSON.stringify(agent)).toBe(before);
  });

  it('answers empty when the guard has nothing to say, for a session it does not know, and for input it cannot read', async () => {
    for (const body of [pre('s-guard', 'Bash'), pre('unknown', 'Edit'), '{not json', '[]']) {
      expect(await http(hooks, { method: 'POST', path: GUARD_PATH, headers: json, body })).toMatchObject({ status: 200, body: '' });
    }
    expect(registry.list().some((agent) => agent.sessionId === 'unknown')).toBe(false);
  });

  it('refuses web pages', async () => {
    expect((await http(hooks, { method: 'POST', path: GUARD_PATH, headers: { ...json, origin: 'https://evil.example' }, body: pre('s-guard', 'Edit') })).status).toBe(403);
    expect((await http(hooks, { method: 'GET', path: GUARD_PATH })).status).toBe(405);
  });
});

describe('api', () => {
  const auth = { authorization: `Bearer ${TOKEN}` };

  it('needs the token', async () => {
    expect((await http(port, { path: '/api/agents' })).status).toBe(401);
    expect((await http(port, { path: '/api/agents', headers: { authorization: `Bearer ${'b'.repeat(64)}` } })).status).toBe(401);
    expect((await http(port, { path: '/api/agents', headers: auth })).status).toBe(200);
  });

  it('accepts its own origin only, at localhost too in WSL', async () => {
    expect((await http(port, { path: '/api/health', headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await http(port, { path: '/api/health', headers: { ...auth, origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
    // localhost too: how a browser of Windows reaches a daemon inside WSL2. Not another port of it.
    expect((await http(port, { path: '/api/health', headers: { ...auth, origin: `http://localhost:${port}` } })).status).toBe(200);
    expect((await http(port, { path: '/api/health', headers: { ...auth, origin: `http://localhost:${port + 1}` } })).status).toBe(403);
  });

  it('registers a session of forchetta run', async () => {
    const id = '9a9a9a9a-1111-4222-8333-444455556666';
    const ok = await http(port, { method: 'POST', path: '/api/agents', headers: { ...auth, ...json }, body: JSON.stringify({ id, cwd: '/tmp/r', tmuxSession: 'fk-9a9a9a9a' }) });
    expect(ok.status).toBe(200);
    expect(registry.agents.get(id)).toMatchObject({ state: 'starting', control: { kind: 'tmux', session: 'fk-9a9a9a9a' } });
    const bad = await http(port, { method: 'POST', path: '/api/agents', headers: { ...auth, ...json }, body: JSON.stringify({ id, cwd: 'relative', tmuxSession: 'x;kill' }) });
    expect(bad.status).toBe(400);
  });

  it('gives the token to its page for a code of forchetta open, once', async () => {
    const origin = `http://localhost:${port}`;
    const trade = (code: unknown, headers: Record<string, string> = { ...json, origin }) => http(port, { method: 'POST', path: OPEN_PATH, headers, body: JSON.stringify({ code }) });
    // Only who has the token makes a code.
    expect((await http(port, { method: 'POST', path: '/api/open' })).status).toBe(401);
    const { code } = JSON.parse((await http(port, { method: 'POST', path: '/api/open', headers: auth })).body) as { code: string };
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    // Not for another page, nor for what is not a page, nor as a form; and the code is still good.
    expect((await trade(code, { ...json, origin: 'https://evil.example' })).status).toBe(403);
    expect((await trade(code, json)).status).toBe(403);
    expect((await trade(code, { origin, 'content-type': 'text/plain' })).status).toBe(415);
    expect((await trade('0'.repeat(32))).status).toBe(403);
    expect((await http(port, { path: OPEN_PATH, headers: { origin } })).status).toBe(404);
    const given = await trade(code);
    expect(given).toMatchObject({ status: 200, body: JSON.stringify({ token: TOKEN }) });
    expect(given.headers['cache-control']).toBe('no-store');
    expect((await trade(code)).status).toBe(403);
  });

  it('shuts down on request', async () => {
    const reply = await http(port, { method: 'POST', path: '/api/shutdown', headers: auth });
    expect(reply.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdowns).toBe(1);
  });
});
