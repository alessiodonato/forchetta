import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPromptBox } from '../src/daemon/screen.ts';
import { PANE_MODES_FORMAT, paneModes } from '../src/daemon/scrollback.ts';
import type { Pty } from '../src/daemon/pty.ts';
import { Screen } from '../src/host/screen.ts';
import { FOCUS_REPORT, TERMINAL_REPLY } from '../src/host/protocol.ts';
import { HostSessions, keysOf, MAX_COMMAND_LINE, parseRecord } from '../src/shared/host-sessions.ts';
import { ROOT } from '../src/shared/paths.ts';
import { acceptPipe, connectPipe, newPipe, type PipeInfo } from '../src/shared/pipe.ts';
import { listPanes, TmuxRefused } from '../src/shared/tmux.ts';
import { sleep, tempDir } from './helpers.ts';

// The hosts of the sessions of Windows (src/host): real ones, with a real pseudo-terminal, on any system. Off Windows the
// pipe is a socket.

const temp = tempDir('host');
const WINDOWS = process.platform === 'win32';
// The path of a socket is 104 bytes at most on a Mac.
const pipe = (): PipeInfo => newPipe('test', WINDOWS ? undefined : join(tmpdir(), `fk-${randomUUID().slice(0, 8)}.sock`));
const hostJs = join(temp.dir, 'host.mjs');
const dir = join(temp.dir, 'sessions');
const sessions = new HostSessions({ dir, hostJs, pipe });
let count = 0;
const session = (): string => `fk-${(0xa0000000 + count++).toString(16)}`;

beforeAll(async () => {
  await build({
    entryPoints: [join(ROOT, 'src', 'host', 'main.ts')],
    outfile: hostJs,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node-pty'],
    logLevel: 'error',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
});

afterAll(async () => {
  sessions.close();
  await sleep(500);
  temp.cleanup();
});

const start = (name: string, more: { args?: string[]; env?: Record<string, string> } = {}) =>
  sessions.start({
    session: name,
    agentId: randomUUID(),
    file: process.execPath,
    args: more.args ?? [join(ROOT, 'test', 'fixtures', 'tui.mjs')],
    cwd: temp.dir,
    env: { ...(process.env as Record<string, string>), FORCHETTA_PANE: name, ...more.env },
    cols: 120,
    rows: 36,
  });

const capture = async (name: string): Promise<string> => (await sessions.run('capture-pane', ['-p', '-e', '-S', '-60', '-t', name])).stdout;

async function until(check: () => Promise<boolean> | boolean, ms = 8000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await check()) return true;
  return check();
}

const keys = (name: string, ...args: string[]) => sessions.run('send-keys', ['-t', name, ...args]);

describe('a session in its host', () => {
  const name = session();
  let pid = 0;

  it('starts, and leaves nothing of its environment on the disk', async () => {
    const started = await start(name, { env: { SECRET_OF_THE_TEST: 'one-two-three' } });
    expect(started).toMatchObject({ pid: expect.any(Number) });
    pid = (started as { pid: number }).pid;
    expect(await until(async () => (await capture(name)).includes('120x36'))).toBe(true);
    for (const file of readdirSync(dir)) expect(readFileSync(join(dir, file), 'utf8')).not.toContain('one-two-three');
  });

  it('answers as tmux does', async () => {
    expect((await sessions.run('has-session', ['-t', name])).code).toBe(0);
    expect((await sessions.run('display-message', ['-p', '-t', name, '#{session_name}\t#{pane_pid}'])).stdout).toBe(`${name}\t${pid}\n`);
    expect((await sessions.run('display-message', ['-p', '-t', name, '#{pane_in_mode}'])).stdout).toBe('0\n');
    expect(await listPanes(sessions)).toContainEqual({ paneId: name, panePid: pid, session: name });
    expect(paneModes((await sessions.run('list-panes', ['-a', '-F', PANE_MODES_FORMAT])).stdout).get(name)).toBe(false);
    expect((await sessions.run('list-buffers', ['-F', '#{buffer_name}'])).stdout).toBe('');
  });

  it('gives the screen with its styles, and wide characters', async () => {
    const screen = await capture(name);
    expect(screen).toContain('\u001b[1mTUI\u001b[0m');
    expect(screen).toContain('\u001b[2m> \u001b[0m');
    expect(screen).toContain('è € 漢 ✻');
    expect(screen).toContain(name);
  });

  it('takes the keys of the daemon, which are not yours', async () => {
    await keys(name, '-H', ...[...Buffer.from('ciao è')].map((byte) => byte.toString(16).padStart(2, '0')));
    expect(await until(async () => (await capture(name)).includes('ciao è'))).toBe(true);
    for (const [key, shown] of [['Enter', '\\r'], ['C-u', '\\u0015'], ['Escape', '\\u001b']] as const) {
      await keys(name, key);
      expect(await until(async () => (await capture(name)).includes(`got "${shown}"`)), key).toBe(true);
    }
    expect((await keys(name, 'F19')).code).toBe(1);
    expect((await sessions.run('display-message', ['-p', '-t', name, '#{session_activity}'])).stdout).toBe('0\n');
  });

  it('pastes as one block', async () => {
    const file = join(temp.dir, 'request.txt');
    writeFileSync(file, 'uno\ndue');
    expect((await sessions.run('load-buffer', ['-b', 'forchetta-1', file])).code).toBe(0);
    expect((await sessions.run('paste-buffer', ['-p', '-d', '-b', 'forchetta-1', '-t', name])).code).toBe(0);
    expect(await until(async () => (await capture(name)).includes('[200~uno\\rdue\\u001b[201~'))).toBe(true);
    expect((await sessions.run('paste-buffer', ['-p', '-d', '-b', 'forchetta-1', '-t', name])).code).toBe(1);
  });

  it('a window gets the screen, then what comes; its size is the one of the session; closing it changes nothing', async () => {
    let seen = '';
    const window = sessions.attach(name, 90, 20) as Pty;
    window.onData((data) => (seen += String(data)));
    expect(await until(() => seen.includes('TUI'))).toBe(true);
    expect(await until(async () => (await capture(name)).includes('90x20'))).toBe(true);
    seen = '';
    window.write('live');
    expect(await until(() => seen.includes('live'))).toBe(true);
    // You typed: the daemon waits before it types.
    expect(Number((await sessions.run('display-message', ['-p', '-t', name, '#{session_activity}'])).stdout)).toBeGreaterThan(Date.now() / 1000 - 30);
    window.resize(100, 24);
    expect(await until(async () => (await capture(name)).includes('100x24'))).toBe(true);
    // What a terminal answers by itself does not reach the program.
    window.write('\u001b[?1;2c');
    window.write('typed');
    expect(await until(async () => (await capture(name)).includes('typed'))).toBe(true);
    expect(await capture(name)).not.toContain('[?1;2c');
    window.kill();
    await sleep(300);
    expect((await sessions.run('has-session', ['-t', name])).code).toBe(0);
  });

  it('two windows see the same, and hear its end', async () => {
    const ends: number[] = [];
    const seen = ['', ''];
    const windows = [0, 1].map((index) => {
      const window = sessions.attach(name, 100, 24);
      window.onData((data) => (seen[index] += String(data)));
      window.onExit(({ exitCode }) => ends.push(exitCode));
      return window;
    });
    expect(await until(() => seen.every((text) => text.includes('TUI')))).toBe(true);
    windows[0]!.write('\u0003');
    expect(await until(() => ends.length === 2)).toBe(true);
    expect(ends).toEqual([7, 7]);
    expect(await until(async () => (await sessions.run('has-session', ['-t', name])).code === 1)).toBe(true);
    expect(await until(() => !existsSync(join(dir, `${name}.json`)))).toBe(true);
    expect(await listPanes(sessions)).not.toContainEqual(expect.objectContaining({ session: name }));
  });
});

describe('what does not start', () => {
  it('says why', async () => {
    const result = await sessions.start({ session: session(), agentId: randomUUID(), file: join(temp.dir, 'no-such-program'), args: [], cwd: temp.dir, env: {}, cols: 80, rows: 24 });
    expect(result).toHaveProperty('error');
  });

  it('a command line longer than Windows takes', async () => {
    const result = await sessions.start({ session: session(), agentId: randomUUID(), file: process.execPath, args: ['x'.repeat(MAX_COMMAND_LINE)], cwd: temp.dir, env: {}, cols: 80, rows: 24 });
    expect(result).toEqual({ error: expect.stringContaining('too long') });
  });

  it('nothing ends a session: there is no such command', async () => {
    await expect(sessions.run('kill-session' as never, ['-t', 'fk-a0000000'])).rejects.toBeInstanceOf(TmuxRefused);
    expect((await sessions.run('has-session', ['-t', '../../config'])).code).toBe(1);
    expect((await sessions.run('capture-pane', ['-p', '-t', 'fk-00000000'])).code).toBe(1);
    expect(() => sessions.attach('fk-00000000', 80, 24)).toThrow();
  });
});

describe('the records of the sessions', () => {
  it('one that is not of a session is not read, one of a host that is gone is taken away', () => {
    expect(parseRecord('{')).toBeUndefined();
    expect(parseRecord(JSON.stringify({ session: '../x', pipe: 'p', key: 'k', hostPid: 1, pid: 2 }))).toBeUndefined();
    const name = session();
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify({ session: name, agentId: 'a', ...pipe(), hostPid: 2 ** 22 + 12345, pid: 4, startedAt: 1 }));
    expect(sessions.records().some((record) => record.session === name)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('the keys of tmux, as a terminal sends them', () => {
    expect(keysOf(['Enter'], false)).toBe('\r');
    expect(keysOf(['C-u', 'BSpace'], false)).toBe('\u0015\u007f');
    expect(keysOf(['Down', 'Enter'], false)).toBe('\u001b[B\r');
    expect(keysOf(['63', 'c3', 'a8'], true)).toBe('cè');
    expect(keysOf(['Nope'], false)).toBeUndefined();
  });

  it('the answers of a terminal are told from what you type', () => {
    for (const reply of ['\u001b[?1;2c', '\u001b[>0;276;0c', '\u001b[12;40R', '\u001b[0n', '\u001b[?2026;2$y', '\u001b]11;rgb:1a1a/1a1a/1a1a\u001b\\', '\u001b]4;1;rgb:ff/00/00\u0007', '\u001bP>|xterm.js(6.0.0)\u001b\\', '\u001b[?1;2c\u001b[12;40R']) expect(TERMINAL_REPLY.test(reply), JSON.stringify(reply)).toBe(true);
    for (const typed of ['a', '\r', '\u001b', '\u001b[A', '\u001b[1;5C', '\u001b\r', '\u001b[200~x\u001b[201~', '\u001b[<0;3;4M', '\u001b[I']) expect(TERMINAL_REPLY.test(typed), JSON.stringify(typed)).toBe(false);
    expect(FOCUS_REPORT.test('\u001b[I')).toBe(true);
  });
});

describe('the screen of a host', () => {
  it('is read by the reader of the input box of Claude Code', async () => {
    const screen = new Screen({ cols: 60, rows: 12 });
    const rule = '─'.repeat(60);
    screen.write(`hello\r\n\x1b[38;5;244m${rule}\x1b[0m\r\n❯ write \x1b[1mthis\x1b[0m\x1b[2m and not this\x1b[0m\r\n\x1b[38;5;244m${rule}\x1b[0m\r\n  ? for shortcuts`);
    await new Promise<void>((resolve) => screen.settled(resolve));
    expect(readPromptBox(screen.capture(60))).toEqual({ found: true, typed: 'write this' });
  });

  it('a window that opens draws the same', async () => {
    const first = new Screen({ cols: 40, rows: 8 });
    first.write('\x1b[?2004h\x1b[31mred\x1b[0m plain\r\n\x1b[1;4munder\x1b[0m');
    await new Promise<void>((resolve) => first.settled(resolve));
    const second = new Screen({ cols: 40, rows: 8 });
    second.write(first.snapshot());
    await new Promise<void>((resolve) => second.settled(resolve));
    expect(second.capture(0)).toBe(first.capture(0));
    expect(second.bracketedPaste).toBe(true);
  });
});

describe('the pipes', () => {
  const servers: Server[] = [];
  const listen = (info: PipeInfo, key = info.key, onReady: (text: string) => void = () => {}): Promise<Server> =>
    new Promise((resolve) => {
      const server = createServer((raw) =>
        acceptPipe(raw, key, (socket) => {
          socket.on('data', (chunk) => {
            onReady(String(chunk));
            socket.write(`echo ${String(chunk)}`);
          });
        }),
      );
      servers.push(server);
      server.listen(info.pipe, () => resolve(server));
    });
  afterAll(() => servers.forEach((server) => server.close()));

  it('talk once both ends proved they have the key', async () => {
    const info = pipe();
    await listen(info);
    const socket = await connectPipe(info);
    const answer = new Promise<string>((resolve) => socket.on('data', (chunk) => resolve(String(chunk))));
    socket.resume();
    socket.write('hello');
    expect(await answer).toBe('echo hello');
    socket.destroy();
  });

  it('refuse who has not the key, and tell it nothing', async () => {
    const info = pipe();
    const heard: string[] = [];
    await listen(info, info.key, (text) => heard.push(text));
    await expect(connectPipe({ ...info, key: 'a'.repeat(64) })).rejects.toThrow('not Forchetta');
    expect(heard).toEqual([]);
  });

  it('a program in the place of the daemon gets nothing of what was to be sent', async () => {
    const info = pipe();
    const heard: string[] = [];
    const impostor = createServer((socket) => {
      socket.on('data', (chunk) => {
        heard.push(String(chunk));
        socket.write(`${'0'.repeat(64)} ${'0'.repeat(32)}\n`);
      });
      socket.on('error', () => {});
    });
    servers.push(impostor);
    await new Promise<void>((resolve) => impostor.listen(info.pipe, resolve));
    await expect(connectPipe(info)).rejects.toThrow('not Forchetta');
    await sleep(100);
    // Only the greeting, with a number made at random.
    expect(heard.join('')).toMatch(/^fk1 [0-9a-f]{32}\n$/);
  });

  it('do not wait for long', async () => {
    const info = pipe();
    const silent = createServer((socket) => void socket.on('error', () => {}));
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(info.pipe, resolve));
    await expect(connectPipe(info, 300)).rejects.toThrow('no answer');
    const gone = pipe();
    await expect(connectPipe(gone, 300)).rejects.toThrow();
  });
});
