import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { paths } from '../shared/paths.ts';
import { connectPipe, parsePipe } from '../shared/pipe.ts';
import { gitBash, windowsPowerShell } from '../shared/windows.ts';

// The hooks of Forchetta and its status line on Windows, where Claude Code starts them as a program, with no shell: what
// bin/forchetta-hook, -guard, -permission and -statusline are elsewhere (see there for what each one does and promises).
//
//   node forchetta-hooks.js hook|guard|permission|status <port> [seconds]
//
// The input of Claude Code goes to the daemon on its pipe, which proves to be the one of Forchetta before anything is sent
// (shared/pipe.ts). With the daemon off, slow, or with nothing to say, it prints nothing and exits 0.

const [kind = '', , limit] = process.argv.slice(2);

/**
 * How long the daemon has for an answer. The guard looks at the processes of Windows before a kill, and a permission at
 * the command line of the session: that takes a second or two, more on a slow PC. The dialog of a permission is on screen
 * meanwhile.
 */
const ANSWER_MS: Record<string, number> = { hook: 1500, guard: 2500, permission: 15_000, status: 1500 };
const answerMs = ANSWER_MS[kind];

const HEADERS = {
  'X-Forchetta-Pid': String(process.ppid),
  'X-Forchetta-Claude-Pid': process.env.CLAUDE_PID ?? '',
  'X-Forchetta-Pane': process.env.FORCHETTA_PANE ?? '',
  'X-Forchetta-Agent': process.env.FORCHETTA_AGENT ?? '',
};

function readInput(): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

async function connect(): Promise<Socket | undefined> {
  try {
    const info = parsePipe(readFileSync(paths.hooksSocket, 'utf8'));
    return info ? await connectPipe(info, 1000) : undefined;
  } catch {
    // The daemon is off: no file, or a pipe that is no longer there.
    return undefined;
  }
}

/** One request to the daemon: what it answered, or undefined. With no time given, it waits. */
async function ask(method: 'GET' | 'POST', path: string, body: Buffer | undefined, headers: Record<string, string>, timeoutMs: number): Promise<string | undefined> {
  const socket = await connect();
  if (!socket) return undefined;
  return new Promise((resolve) => {
    const done = (text: string | undefined): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(text);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    socket.on('error', () => done(undefined));
    socket.on('close', () => done(undefined));
    // With no agent: one would open a connection of its own.
    const req = request(
      { method, path, headers: { Host: 'localhost', ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}) }, createConnection: () => socket },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(res.statusCode === 200 ? Buffer.concat(chunks).toString('utf8') : undefined));
        res.on('error', () => done(undefined));
      },
    );
    req.on('error', () => done(undefined));
    req.on('socket', (used) => used.resume());
    req.end(body);
  });
}

/** What Claude Code reads: written whole before the end. */
const print = (text: string): Promise<void> => new Promise((resolve) => process.stdout.write(text, () => resolve()));

/** The daemon is off: no live pid in daemon.json. Said only where Forchetta has run. */
function daemonOff(): boolean {
  if (!existsSync(`${paths.varDir}/data-version`)) return false;
  try {
    const { pid } = JSON.parse(readFileSync(paths.daemonInfo, 'utf8')) as { pid?: unknown };
    if (typeof pid !== 'number') return true;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'EPERM';
  }
}

/** The status line you had, run with the same input in the shell Claude Code would have used. */
function yours(command: string, input: Buffer): Promise<string> {
  const bash = gitBash();
  const [file, args] = bash ? [bash, ['-c', command]] : [windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]];
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function status(input: Buffer): Promise<void> {
  const sent = ask('POST', '/forchetta/status', input, HEADERS, answerMs!);
  let saved = '';
  try {
    saved = readFileSync(paths.statusCommand, 'utf8');
  } catch {
    // There was none.
  }
  const line = saved.trim() ? await yours(saved, input) : '';
  if (daemonOff()) {
    const mark = '\u001b[2m◌ Forchetta is off · forchetta daemon start\u001b[22m\n';
    await print(line ? `${line.replace(/\n+$/, '')}\n${mark}` : mark);
  } else if (line) await print(line);
  await sent;
}

async function permission(input: Buffer): Promise<void> {
  const seconds = Number(limit) > 0 ? Number(limit) : 3540;
  const ticket = await ask('POST', '/forchetta/permission', input, { ...HEADERS, 'X-Forchetta-Wait': String(seconds) }, answerMs!);
  if (!ticket || !/^[0-9a-f]+$/.test(ticket)) return;
  const decision = await ask('GET', `/forchetta/permission/${ticket}`, undefined, {}, seconds * 1000);
  if (decision) await print(decision);
}

async function main(): Promise<void> {
  if (answerMs === undefined) return;
  const input = await readInput();
  switch (kind) {
    case 'hook':
      await ask('POST', '/forchetta/hook', input, HEADERS, answerMs);
      return;
    case 'guard': {
      const decision = await ask('POST', '/forchetta/guard', input, HEADERS, answerMs);
      if (decision) await print(decision);
      return;
    }
    case 'permission':
      return permission(input);
    default:
      return status(input);
  }
}

// Whatever goes wrong, Claude Code goes on as usual.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
main().then(
  () => process.exit(0),
  () => process.exit(0),
);
