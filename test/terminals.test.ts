import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Registry } from '../src/daemon/registry.ts';
import { createDaemonServer } from '../src/daemon/server.ts';
import { Terminals } from '../src/daemon/terminals.ts';
import { which } from '../src/shared/config.ts';
import { ROOT } from '../src/shared/paths.ts';
import { Tmux } from '../src/shared/tmux.ts';
import { sleep, tempDir } from './helpers.ts';

// A real tmux server in var/test, with one session whose program ends by itself after a few seconds: the test
// never ends a session, it only checks that closing a terminal leaves it running.

const TOKEN = 'e'.repeat(64);
const AGENT = '7a7a7a7a-1111-4222-8333-444455556666';
const SESSION = 'fk-7a7a7a7a';
const temp = tempDir('terminals');
const tmuxBin = which('tmux');
const tmux = new Tmux(tmuxBin ?? 'tmux', join(temp.dir, 'tmux.sock'), join(ROOT, 'config', 'tmux.conf'));
let server: Server;
let port = 0;
let registry: Registry;
let terminals: Terminals;

beforeAll(async () => {
  // The program reads one line, says what it read, and ends 8 s later.
  const created = await tmux.run('new-session', ['-d', '-s', SESSION, '-x', '100', '-y', '30', '--', '/bin/sh', '-c', 'echo PRONTO; read riga; echo "LETTO:$riga"; sleep 8']);
  expect(created.code).toBe(0);
  registry = new Registry();
  registry.register({ id: AGENT, cwd: temp.dir, tmuxSession: SESSION });
  registry.hook({ hook_event_name: 'SessionStart', session_id: 's-readonly', cwd: '/x', source: 'startup' });
  terminals = new Terminals({ token: TOKEN, port: () => port, registry, tmux, log: () => {} });
  server = createDaemonServer({ registry, token: TOKEN, terminals, port: () => port, log: () => {}, info: () => ({}), onShutdown: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  terminals.close();
  registry.dispose();
  await new Promise((resolve) => server.close(resolve));
  // The session ends by itself (its program sleeps 8 s): its server goes with it, unreachable already.
  temp.cleanup();
});

function connect(agent: string, origin = `http://127.0.0.1:${port}`, token = TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/term?token=${token}&agent=${agent}&cols=100&rows=30`, { origin });
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

const attached = async (): Promise<string> => (await tmux.run('display-message', ['-p', '-t', SESSION, '#{session_attached}'])).stdout.trim();

describe('terminals', () => {
  it.skipIf(!tmuxBin)('refuses another origin, a wrong token, and sessions that are not in tmux', async () => {
    await expect(connect(AGENT, 'https://evil.example')).rejects.toThrow(/403/);
    await expect(connect(AGENT, undefined, 'f'.repeat(64))).rejects.toThrow(/403/);
    const readonly = registry.list().find((agent) => agent.control.kind === 'readonly')!;
    await expect(connect(readonly.id)).rejects.toThrow(/404/);
  });

  it.skipIf(!tmuxBin)('shows the session, types into it, follows the size, and on close only detaches', async () => {
    const socket = await connect(AGENT);
    let screen = '';
    socket.on('message', (data, binary) => {
      if (binary) screen += Buffer.from(data as Buffer).toString('utf8');
    });
    await sleep(600);
    expect(screen).toContain('PRONTO');
    expect(await attached()).toBe('1');

    socket.send(JSON.stringify({ type: 'input', data: 'ciao forchetta\r' }));
    await sleep(500);
    expect(screen).toContain('LETTO:ciao forchetta');

    socket.send(JSON.stringify({ type: 'resize', cols: 84, rows: 22 }));
    await sleep(400);
    expect((await tmux.run('display-message', ['-p', '-t', SESSION, '#{window_width}x#{window_height}'])).stdout.trim()).toBe('84x22');

    socket.close();
    await sleep(500);
    expect(await attached()).toBe('0');
    expect((await tmux.run('has-session', ['-t', SESSION])).code).toBe(0);
  });

  it.skipIf(!tmuxBin)('opens and closes twenty times without touching the session', async () => {
    for (let round = 0; round < 20; round++) {
      const socket = await connect(AGENT);
      await sleep(30);
      socket.close();
    }
    await sleep(600);
    expect(await attached()).toBe('0');
    expect((await tmux.run('has-session', ['-t', SESSION])).code).toBe(0);
    expect(terminals.size).toBe(0);
  });
});
