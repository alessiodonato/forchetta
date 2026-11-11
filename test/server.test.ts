import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/daemon/registry.ts';
import { createDaemonServer, HOOK_PATH, hookMeta } from '../src/daemon/server.ts';
import { http } from './helpers.ts';

const TOKEN = 'a'.repeat(64);
let server: Server;
let port = 0;
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
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  registry.dispose();
  await new Promise((resolve) => server.close(resolve));
});

const json = { 'content-type': 'application/json' };
const event = (extra: Record<string, unknown>): string =>
  JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: '/tmp/p', prompt: 'ciao', tool_response: { huge: 'x'.repeat(1000) }, ...extra });

describe('hook endpoint', () => {
  it('answers 200 with an empty body, so it never decides, blocks or adds context', async () => {
    const reply = await http(port, { method: 'POST', path: HOOK_PATH, headers: json, body: event({}) });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('');
    expect(registry.list().find((agent) => agent.sessionId === 's-1')?.state).toBe('working');
  });

  it('answers empty also to input it cannot read', async () => {
    for (const body of ['{not json', '{"session_id":"x"}', '[]']) {
      const reply = await http(port, { method: 'POST', path: HOOK_PATH, headers: json, body });
      expect(reply).toMatchObject({ status: 200, body: '' });
    }
  });

  it('refuses web pages: Origin header, form types, wrong Host', async () => {
    expect((await http(port, { method: 'POST', path: HOOK_PATH, headers: { ...json, origin: 'https://evil.example' }, body: event({}) })).status).toBe(403);
    expect((await http(port, { method: 'POST', path: HOOK_PATH, headers: { 'content-type': 'text/plain' }, body: event({}) })).status).toBe(415);
    expect((await http(port, { method: 'POST', path: HOOK_PATH, headers: { ...json, host: 'evil.example' }, body: event({}) })).status).toBe(403);
    expect((await http(port, { method: 'GET', path: HOOK_PATH })).status).toBe(405);
  });

  it('reads pid, pane and agent from the headers of the hook script', async () => {
    const agentId = '3f2b8c1e-1111-4222-8333-444455556666';
    const reply = await http(port, {
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

describe('api', () => {
  const auth = { authorization: `Bearer ${TOKEN}` };

  it('needs the token', async () => {
    expect((await http(port, { path: '/api/agents' })).status).toBe(401);
    expect((await http(port, { path: '/api/agents', headers: { authorization: `Bearer ${'b'.repeat(64)}` } })).status).toBe(401);
    expect((await http(port, { path: '/api/agents', headers: auth })).status).toBe(200);
  });

  it('accepts its own origin only', async () => {
    expect((await http(port, { path: '/api/health', headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await http(port, { path: '/api/health', headers: { ...auth, origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
  });

  it('registers a session of forchetta run', async () => {
    const id = '9a9a9a9a-1111-4222-8333-444455556666';
    const ok = await http(port, { method: 'POST', path: '/api/agents', headers: { ...auth, ...json }, body: JSON.stringify({ id, cwd: '/tmp/r', tmuxSession: 'fk-9a9a9a9a' }) });
    expect(ok.status).toBe(200);
    expect(registry.agents.get(id)).toMatchObject({ state: 'starting', control: { kind: 'tmux', session: 'fk-9a9a9a9a' } });
    const bad = await http(port, { method: 'POST', path: '/api/agents', headers: { ...auth, ...json }, body: JSON.stringify({ id, cwd: 'relative', tmuxSession: 'x;kill' }) });
    expect(bad.status).toBe(400);
  });

  it('shuts down on request', async () => {
    const reply = await http(port, { method: 'POST', path: '/api/shutdown', headers: auth });
    expect(reply.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdowns).toBe(1);
  });
});
