import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadPty } from '../src/daemon/pty.ts';
import { Registry } from '../src/daemon/registry.ts';
import { inFront, MAX_SHELLS, SHELL_ENDED, shellEnv, Shells, type ShellProgram } from '../src/daemon/shells.ts';
import { Terminals } from '../src/daemon/terminals.ts';
import type { Agent } from '../src/shared/agent.ts';
import { isShellId } from '../src/shared/shells.ts';
import type { Tmux } from '../src/shared/tmux.ts';
import { emptyPanes, leastRecentlyUsed, openPane, type PaneState } from '../src/ui/layout.ts';
import { sleep, tempDir } from './helpers.ts';

// The plain terminals, with a real pseudo-terminal and a real shell, through the real WebSocket of the daemon.

const temp = tempDir('shells');
afterAll(() => temp.cleanup());

const program: ShellProgram = { id: 'sh', label: 'sh', file: '/bin/sh', args: [], env: { PS1: 'ready> ', ENV: '' } };
const folder = realpathSync(temp.dir);
const agent = (cwd: string | undefined = folder): Agent => ({ id: 'a1', cwd, project: 'shop', state: 'idle' }) as Agent;

async function until<T>(test: () => T | undefined | false, ms = 8000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(30)) {
    const value = test();
    if (value) return value;
  }
  return undefined;
}

function shells(more: Partial<ConstructorParameters<typeof Shells>[0]> = {}): Shells {
  return new Shells({ pty: loadPty, programs: () => [program], log: () => {}, env: { PATH: process.env.PATH, HOME: folder, FORCHETTA_ANTHROPIC_API_KEY: 'secret', CLAUDECODE: '1', TMUX: 'x' }, ...more });
}

async function serve(all: Shells) {
  const token = 'a'.repeat(64);
  let port = 0;
  const terminals = new Terminals({ token, port: () => port, registry: new Registry({ settleMs: 5 }), tmux: {} as Tmux, shells: all, log: () => {} });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => terminals.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  const open = (id: string, origin?: string, given = token) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term?token=${given}&shell=${id}&cols=90&rows=25`, { origin: origin ?? `http://127.0.0.1:${port}` });
    const seen = { text: '', ready: false, code: 0, refused: false, ws, type: (data: string) => ws.send(JSON.stringify({ type: 'input', data })) };
    ws.on('message', (data, binary) => {
      if (binary) seen.text += String(data);
      else seen.ready = true;
    });
    ws.on('close', (code) => (seen.code = code));
    ws.on('error', () => (seen.refused = true));
    return seen;
  };
  return { open, stop: () => new Promise((resolve) => { terminals.close(); server.close(resolve); }) };
}

describe('a plain terminal', () => {
  it('is a shell in the folder of a session, with nothing of Forchetta or of Claude in its environment', async () => {
    const all = shells();
    const { open, stop } = await serve(all);
    const started = all.start(agent(), undefined);
    if (!started.ok) throw new Error(started.error);
    expect(isShellId(started.shell.id)).toBe(true);
    expect(started.shell).toMatchObject({ agentId: 'a1', name: 'shop', cwd: folder, label: 'sh' });
    const page = open(started.shell.id);
    expect(await until(() => page.ready)).toBe(true);
    page.type('pwd; echo "[$FORCHETTA_ANTHROPIC_API_KEY$CLAUDECODE$TMUX]" $TERM; stty size\r');
    expect(await until(() => /\[\] xterm-256color\s+25 90/.test(page.text))).toBe(true);
    expect(page.text).toContain(folder);
    await stop();
    // The daemon stops: so does the shell.
    expect(all.size).toBe(0);
  });

  it('ends with `exit`, and its page is told', async () => {
    const all = shells();
    const { open, stop } = await serve(all);
    const started = all.start(agent(), 'sh');
    if (!started.ok) throw new Error(started.error);
    const page = open(started.shell.id);
    await until(() => page.ready);
    page.type('exit\r');
    expect(await until(() => page.code)).toBe(SHELL_ENDED);
    expect(all.size).toBe(0);
    await stop();
  });

  it('is asked about before it closes while something runs in it', async () => {
    const all = shells();
    const { open, stop } = await serve(all);
    const started = all.start(agent(), undefined);
    if (!started.ok) throw new Error(started.error);
    const page = open(started.shell.id);
    await until(() => page.ready);
    page.type("echo g''o; sleep 30\r");
    await until(() => /^go\r?$/m.test(page.text));
    await sleep(300);
    expect(await all.close(started.shell.id, false)).toEqual({ ok: false, running: 'sleep' });
    expect(all.size).toBe(1);
    expect(await all.close(started.shell.id, true)).toEqual({ ok: true });
    expect(await until(() => page.code)).toBe(SHELL_ENDED);
    await stop();
  });

  it('waits for a page that reloads, and shows again what it drew; not for ever', async () => {
    const all = shells({ waitMs: 1500 });
    const { open, stop } = await serve(all);
    const started = all.start(agent(), undefined);
    if (!started.ok) throw new Error(started.error);
    const first = open(started.shell.id);
    await until(() => first.ready);
    first.type('echo one-$((40+2))\r');
    await until(() => first.text.includes('one-42'));
    first.ws.close();
    expect(await until(() => all.waiting().length === 1)).toBe(true);
    const second = open(started.shell.id);
    expect(await until(() => second.ready && second.text.includes('one-42'))).toBe(true);
    expect(all.waiting()).toEqual([]);
    // Shown by another window: the first one is told.
    const third = open(started.shell.id);
    await until(() => third.ready);
    expect(await until(() => second.code)).toBe(4001);
    third.ws.close();
    expect(await until(() => all.size === 0, 5000)).toBe(true);
    await stop();
  });

  it('opens only for the page of this daemon, and only if it is there', async () => {
    const all = shells();
    const { open, stop } = await serve(all);
    const started = all.start(agent(), undefined);
    if (!started.ok) throw new Error(started.error);
    const wrongToken = open(started.shell.id, undefined, 'b'.repeat(64));
    const wrongOrigin = open(started.shell.id, 'http://evil.example');
    const none = open('shell-00000000-0000-0000-0000-000000000000');
    for (const page of [wrongToken, wrongOrigin, none]) expect(await until(() => page.refused)).toBe(true);
    expect(all.waiting()).toHaveLength(1);
    await stop();
  });

  it('does not open in a folder that is gone, nor without end', () => {
    const all = shells();
    expect(all.start(agent(join(temp.dir, 'gone')), undefined)).toMatchObject({ ok: false, error: expect.stringContaining('gone') });
    writeFileSync(join(temp.dir, 'file'), '');
    expect(all.start(agent(join(temp.dir, 'file')), undefined)).toMatchObject({ ok: false });
    expect(shells({ programs: () => [] }).start(agent(), undefined)).toMatchObject({ ok: false });
    mkdirSync(join(temp.dir, 'sub'), { recursive: true });
    for (let n = 0; n < MAX_SHELLS; n++) expect(all.start(agent(join(temp.dir, 'sub')), undefined)).toMatchObject({ ok: true });
    expect(all.start(agent(), undefined)).toMatchObject({ ok: false, error: expect.stringContaining(String(MAX_SHELLS)) });
    all.closeAll();
    expect(all.size).toBe(0);
  });

  it('has the environment of the daemon, less what is not for it', () => {
    const env = shellEnv({ PATH: '/bin', HOME: '/h', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_PID: '3', FORCHETTA_VAR: '/v', FORCHETTA_AGENT: 'x', TMUX_PANE: '%1', LANG: 'it_IT.UTF-8' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CLAUDE_CODE_USE_BEDROCK: '1', LANG: 'it_IT.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Forchetta' });
  });

  it('knows what is in front of it', () => {
    const pty = (process: string | undefined) => ({ process }) as Parameters<typeof inFront>[0];
    expect(inFront(pty('-sh'), program)).toBeUndefined();
    expect(inFront(pty('/usr/bin/npm'), program)).toBe('npm');
    expect(inFront(pty(undefined), program)).toBeUndefined();
  });
});

describe('its pane', () => {
  const shell = 'shell-00000000-0000-0000-0000-000000000001';
  const at = (open: string[]): PaneState => open.reduce((state, id, index) => openPane(state, id, index + 1, 'lru'), emptyPanes());
  it('is not the one a fifth session replaces: it would end', () => {
    expect(leastRecentlyUsed(at([shell, 'a', 'b', 'c']))).toBe('a');
    expect(openPane(at([shell, 'a', 'b', 'c']), 'd', 9, 'lru').open).toEqual([shell, 'd', 'b', 'c']);
  });
  it('with four of them, you say which one goes', () => {
    const four = at([1, 2, 3, 4].map((n) => `${shell.slice(0, -1)}${n}`));
    expect(openPane(four, 'd', 9, 'lru')).toMatchObject({ open: four.open, asking: 'd' });
  });
});
