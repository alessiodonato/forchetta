import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Hub, type ServerMessage } from '../src/daemon/hub.ts';
import { Registry } from '../src/daemon/registry.ts';
import { createDaemonServer } from '../src/daemon/server.ts';
import { http, sleep, tempDir } from './helpers.ts';

const TOKEN = 'c'.repeat(64);
const temp = tempDir('hub');
const uiDir = join(temp.dir, 'ui');
let server: Server;
let port = 0;
let registry: Registry;
let hub: Hub;
const watched: boolean[] = [];
const updateActions: string[] = [];
const menuCalls: string[] = [];
let savedPrompts: unknown = [{ name: 'Explain', text: 'Explain:\n{selection}', mode: 'ask' }];
const FAILED_UPDATE = { failed: { at: 1_794_000_000_000, from: '2.1.322', status: 'install_failed' } };

beforeAll(async () => {
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Forchetta</title>');
  writeFileSync(join(uiDir, 'app.js'), 'console.log(1)');
  writeFileSync(join(temp.dir, 'secret.txt'), 'no');
  hub = new Hub({
    token: TOKEN,
    port: () => port,
    snapshot: () => registry.list(),
    log: () => {},
    onWatched: (value) => watched.push(value),
    claudeUpdate: () => FAILED_UPDATE,
    onClaudeUpdate: (action) => updateActions.push(action),
    onSelection: async (agentId, phase) => {
      menuCalls.push(`${phase} ${agentId}`);
      return phase === 'end' ? 'Expected 200' : undefined;
    },
    onAsk: (agentId, text, fromSelection) => {
      menuCalls.push(`ask ${agentId} ${fromSelection} ${text}`);
      return agentId === 'gone' ? { ok: false, error: 'unknown session' } : { ok: true };
    },
    onInsert: async (agentId, text) => {
      menuCalls.push(`insert ${agentId} ${text}`);
      return { ok: true };
    },
    prompts: () => savedPrompts as never,
    onSavePrompts: (prompts) => {
      if (!Array.isArray(prompts)) return { ok: false, error: 'not a list of prompts' };
      savedPrompts = prompts;
      return { ok: true };
    },
  });
  registry = new Registry({ onChange: (agent) => hub.agentChanged(agent), onRemove: (ids) => hub.agentsRemoved(ids) });
  server = createDaemonServer({ registry, token: TOKEN, uiDir, hub, port: () => port, log: () => {}, info: () => ({}), onShutdown: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  hub.close();
  registry.dispose();
  await new Promise((resolve) => server.close(resolve));
  temp.cleanup();
});

function connect(token: string, origin: string): Promise<{ socket: WebSocket; messages: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin });
    const messages: ServerMessage[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
    socket.on('open', () => resolve({ socket, messages }));
    socket.on('error', reject);
  });
}

describe('the page', () => {
  it('is served with a strict Content-Security-Policy, and nothing outside its folder', async () => {
    const page = await http(port, { path: '/' });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['content-security-policy']).toContain(`connect-src ws://127.0.0.1:${port}`);
    expect((await http(port, { path: '/app.js' })).headers['content-type']).toContain('text/javascript');
    expect((await http(port, { path: '/../secret.txt' })).status).toBe(404);
    expect((await http(port, { path: '/%2e%2e/secret.txt' })).status).toBe(404);
    expect((await http(port, { path: '/missing.js' })).status).toBe(404);
  });
});

describe('websocket', () => {
  it('refuses a wrong token or another origin', async () => {
    await expect(connect('d'.repeat(64), `http://127.0.0.1:${port}`)).rejects.toThrow(/403/);
    await expect(connect(TOKEN, 'https://evil.example')).rejects.toThrow(/403/);
  });

  it('sends every agent, then the changes of a tick together, then what went away', async () => {
    registry.hook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/p/uno', source: 'startup' });
    const { socket, messages } = await connect(TOKEN, `http://127.0.0.1:${port}`);
    await sleep(30);
    expect(messages[0]).toMatchObject({ type: 'hello', agents: [{ project: 'uno' }] });
    expect(watched.at(-1)).toBe(true);

    registry.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'vai' });
    registry.hook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await sleep(30);
    const updates = messages.filter((message) => message.type === 'agents');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ agents: [{ state: 'working', action: { label: 'Bash ls' } }] });

    socket.send(JSON.stringify({ type: 'visibility', visible: false }));
    await sleep(30);
    expect(watched.at(-1)).toBe(false);

    registry.hook({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' });
    for (const agent of registry.agents.values()) agent.endedAt = 0;
    registry.sweep(1);
    await sleep(30);
    expect(messages.at(-1)).toMatchObject({ type: 'removed' });
    socket.close();
  });
});

describe('the updates of Claude Code', () => {
  it('are in the first message, and the page can run claude update or hide its line', async () => {
    const { socket, messages } = await connect(TOKEN, `http://127.0.0.1:${port}`);
    await sleep(30);
    expect(messages[0]).toMatchObject({ type: 'hello', claudeUpdate: FAILED_UPDATE });

    socket.send(JSON.stringify({ type: 'claudeUpdate', action: 'run' }));
    socket.send(JSON.stringify({ type: 'claudeUpdate', action: 'rm -rf' }));
    socket.send(JSON.stringify({ type: 'claudeUpdate', action: 'dismiss' }));
    await sleep(30);
    expect(updateActions).toEqual(['run', 'dismiss']);

    hub.setClaudeUpdate({ run: { state: 'running', at: 1 } });
    await sleep(30);
    expect(messages.at(-1)).toMatchObject({ type: 'claudeUpdate', update: { run: { state: 'running' } } });
    socket.close();
  });
});

describe('the menu of a selection', () => {
  it('reads the selection of a drag, sends questions and text, and keeps the quick prompts', async () => {
    const { socket, messages } = await connect(TOKEN, `http://127.0.0.1:${port}`);
    await sleep(30);
    expect(messages[0]).toMatchObject({ type: 'hello', prompts: [{ name: 'Explain' }] });

    socket.send(JSON.stringify({ type: 'selection', agentId: 'a1', phase: 'start' }));
    socket.send(JSON.stringify({ type: 'selection', agentId: 'a1', phase: 'end' }));
    socket.send(JSON.stringify({ type: 'selection', agentId: 'a1', phase: 'middle' }));
    await sleep(30);
    expect(messages.filter((message) => message.type === 'selection')).toEqual([{ type: 'selection', now: expect.any(Number), agentId: 'a1', text: 'Expected 200' }]);

    socket.send(JSON.stringify({ type: 'ask', agentId: 'a1', text: 'perché?', fromSelection: true }));
    socket.send(JSON.stringify({ type: 'ask', agentId: 'gone', text: 'perché?' }));
    socket.send(JSON.stringify({ type: 'insert', agentId: 'a1', text: '> riga' }));
    await sleep(30);
    expect(menuCalls).toEqual(['start a1', 'end a1', 'ask a1 true perché?', 'ask gone false perché?', 'insert a1 > riga']);
    expect(messages.filter((message) => message.type === 'selectionSent')).toEqual([
      { type: 'selectionSent', now: expect.any(Number), agentId: 'a1', action: 'ask', ok: true },
      { type: 'selectionSent', now: expect.any(Number), agentId: 'gone', action: 'ask', ok: false, error: 'unknown session' },
      { type: 'selectionSent', now: expect.any(Number), agentId: 'a1', action: 'insert', ok: true },
    ]);

    socket.send(JSON.stringify({ type: 'savePrompts', prompts: 'no' }));
    socket.send(JSON.stringify({ type: 'savePrompts', prompts: [{ name: 'Fix', text: 'Fix it', mode: 'ask' }] }));
    await sleep(30);
    expect(messages.filter((message) => message.type === 'promptsSaved').map((message) => (message as { ok: boolean }).ok)).toEqual([false, true]);
    expect(messages.at(-1)).toMatchObject({ type: 'prompts', prompts: [{ name: 'Fix' }] });
    socket.close();
  });
});
