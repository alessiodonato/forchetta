import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { Pty } from '../daemon/pty.ts';
import { type HostIdentity, type HostMessage, type HostRecord, type HostRequest, type HostSpec, SESSION_NAME } from '../host/protocol.ts';
import { join } from './fspath.ts';
import { ensurePrivateDir, paths } from './paths.ts';
import { connectPipe, newPipe, type PipeInfo } from './pipe.ts';
import { Tmux, type TmuxCommand, type TmuxResult, TMUX_ALLOWED, TmuxRefused } from './tmux.ts';

// The sessions on Windows, where there is no tmux: each has a host of its own (src/host/main.ts), found by its record in
// the private folder. Here its answers have the form of those of tmux, for the commands Forchetta uses (shared/tmux.ts), so
// that the rest of Forchetta asks the same way everywhere. As there, nothing ends a session.

/** How long a host may take to start: the first time, the antivirus looks at it. */
const START_MS = 20_000;
/** The command line of a program of Windows is 32767 characters at most. */
export const MAX_COMMAND_LINE = 32_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function parseRecord(text: string): HostRecord | undefined {
  try {
    const raw = JSON.parse(text) as Partial<HostRecord>;
    if (typeof raw.session !== 'string' || !SESSION_NAME.test(raw.session) || typeof raw.pipe !== 'string' || typeof raw.key !== 'string' || typeof raw.hostPid !== 'number' || typeof raw.pid !== 'number') return undefined;
    return { session: raw.session, agentId: String(raw.agentId ?? ''), pipe: raw.pipe, key: raw.key, hostPid: raw.hostPid, pid: raw.pid, startedAt: Number(raw.startedAt) || 0 };
  } catch {
    return undefined;
  }
}

/** The lines of JSON that come on a connection to a host. */
function onMessages(socket: Socket, listener: (message: HostMessage) => void): void {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  socket.on('data', (chunk: Buffer) => {
    pending += decoder.write(chunk);
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        listener(JSON.parse(line) as HostMessage);
      } catch {
        socket.destroy();
        return;
      }
    }
  });
  socket.resume();
}

type Answer = Extract<HostMessage, { ok: boolean }>;
type Question = Exclude<HostRequest, { op: 'attach' | 'input' | 'resize' }>;
type QuestionOf<Q> = Q extends { id: number } ? Omit<Q, 'id'> : never;

/** A connection that asks: one for each session, kept open. */
class HostClient {
  private next = 1;
  private readonly waiting = new Map<number, (answer: Answer | undefined) => void>();
  closed = false;

  constructor(private readonly socket: Socket) {
    const end = (): void => {
      this.closed = true;
      for (const done of this.waiting.values()) done(undefined);
      this.waiting.clear();
    };
    socket.on('close', end);
    socket.on('error', end);
    // A connection left open does not keep the program that made it running.
    socket.unref();
    onMessages(socket, (message) => {
      if (!('id' in message)) return;
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
    });
  }

  ask(question: QuestionOf<Question>, timeoutMs: number): Promise<Answer | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(undefined);
      }, timeoutMs);
      this.waiting.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.socket.write(`${JSON.stringify({ id, ...question })}\n`);
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

/** The keys of tmux that Forchetta presses by name, as a terminal sends them. */
const KEYS: Record<string, string> = {
  Enter: '\r',
  Escape: '\u001b',
  Tab: '\t',
  BSpace: '\u007f',
  Space: ' ',
  Up: '\u001b[A',
  Down: '\u001b[B',
  Right: '\u001b[C',
  Left: '\u001b[D',
};

/** What `send-keys` would type: names (Enter, C-u), or bytes in hex with -H. Undefined for a key not known. */
export function keysOf(args: readonly string[], hex: boolean): string | undefined {
  if (hex) return Buffer.from(args.join(''), 'hex').toString('utf8');
  let out = '';
  for (const name of args) {
    const control = /^C-([a-z])$/.exec(name)?.[1];
    const key = control ? String.fromCharCode(control.charCodeAt(0) - 96) : KEYS[name];
    if (key === undefined) return undefined;
    out += key;
  }
  return out;
}

/** The options of a command of tmux (those with a value in `valued`) and its other words. */
function read(args: readonly string[], valued: string): { options: Map<string, string | true>; words: string[] } {
  const options = new Map<string, string | true>();
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const letter = /^-([A-Za-z])$/.exec(arg)?.[1];
    if (!letter) words.push(arg);
    else if (valued.includes(letter)) options.set(letter, args[++i] ?? '');
    else options.set(letter, true);
  }
  return { options, words };
}

const ok = (stdout = ''): TmuxResult => ({ code: 0, stdout, stderr: '' });
const no = (stderr: string): TmuxResult => ({ code: 1, stdout: '', stderr });

export interface HostStart {
  session: string;
  agentId: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface HostSessionsOptions {
  /** Where the records of the sessions are. */
  dir?: string;
  node?: string;
  hostJs?: string;
  /** A pipe for a new session. */
  pipe?: () => PipeInfo;
}

export class HostSessions extends Tmux {
  private readonly clients = new Map<string, { record: string; client: HostClient }>();
  private readonly opening = new Map<string, Promise<HostClient | undefined>>();
  private readonly buffers = new Map<string, string>();
  private readonly dir: string;

  constructor(private readonly options: HostSessionsOptions = {}) {
    super('', '', '');
    this.dir = options.dir ?? paths.sessionsDir;
  }

  private recordFile(session: string): string {
    return join(this.dir, `${session}.json`);
  }

  /** The record of a session that runs: one of a host that is gone is taken away. */
  record(session: string): HostRecord | undefined {
    if (!SESSION_NAME.test(session)) return undefined;
    const file = this.recordFile(session);
    let found: HostRecord | undefined;
    try {
      found = parseRecord(readFileSync(file, 'utf8'));
    } catch {
      return undefined;
    }
    if (!found || found.session !== session) return undefined;
    if (alive(found.hostPid)) return found;
    rmSync(file, { force: true });
    return undefined;
  }

  records(): HostRecord[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      // No session yet.
    }
    return names.flatMap((name) => {
      const session = /^(fk-[0-9a-f]{8})\.json$/.exec(name)?.[1];
      const record = session ? this.record(session) : undefined;
      return record ? [record] : [];
    });
  }

  private async client(session: string): Promise<HostClient | undefined> {
    const record = this.record(session);
    if (!record) return undefined;
    const known = this.clients.get(session);
    if (known && known.record === record.pipe && !known.client.closed) return known.client;
    // Two questions at once open one connection.
    const pending = this.opening.get(session);
    if (pending) return pending;
    const opening = connectPipe(record).then(
      (socket) => {
        const client = new HostClient(socket);
        this.clients.set(session, { record: record.pipe, client });
        return client;
      },
      () => undefined,
    );
    this.opening.set(session, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(session);
    }
  }

  private async ask(session: string, question: QuestionOf<Question>, timeoutMs: number): Promise<Answer | undefined> {
    return (await this.client(session))?.ask(question, timeoutMs);
  }

  private async identity(session: string, timeoutMs: number): Promise<HostIdentity | undefined> {
    const answer = await this.ask(session, { op: 'identity' }, timeoutMs);
    return answer?.ok ? answer.identity : undefined;
  }

  override async run(command: TmuxCommand, args: readonly string[], timeoutMs = 5000): Promise<TmuxResult> {
    if (!(TMUX_ALLOWED as readonly string[]).includes(command)) throw new TmuxRefused(`tmux command not allowed: ${String(command)}`);
    switch (command) {
      case 'has-session': {
        const { options } = read(args, 't');
        return this.record(String(options.get('t') ?? '')) ? ok() : no("can't find session");
      }
      case 'list-panes': {
        const { options } = read(args, 'F');
        const format = String(options.get('F') ?? '');
        return ok(
          this.records()
            .map((record) => `${fill(format, { session_name: record.session, pane_id: record.session, pane_pid: String(record.pid), pane_in_mode: '0' })}\n`)
            .join(''),
        );
      }
      case 'display-message': {
        const { options, words } = read(args, 't');
        const session = String(options.get('t') ?? '');
        const found = await this.identity(session, timeoutMs);
        if (!found) return no("can't find pane");
        return ok(`${fill(words[0] ?? '', { session_name: found.session, pane_id: found.session, pane_pid: String(found.pid), pane_in_mode: '0', session_activity: String(found.activity) })}\n`);
      }
      case 'capture-pane': {
        const { options } = read(args, 'tS');
        const answer = await this.ask(String(options.get('t') ?? ''), { op: 'capture', history: Math.abs(Number(options.get('S') ?? 0)) || 0 }, timeoutMs);
        return answer?.ok && answer.text !== undefined ? ok(answer.text) : no("can't find pane");
      }
      case 'send-keys': {
        const { options, words } = read(args, 't');
        // Out of the copy mode of tmux (-X cancel): here there is none.
        if (options.has('X')) return ok();
        const data = keysOf(words, options.has('H'));
        if (data === undefined) return no(`unknown key: ${words.join(' ')}`);
        const answer = await this.ask(String(options.get('t') ?? ''), { op: 'keys', data }, timeoutMs);
        return answer?.ok ? ok() : no("can't find pane");
      }
      case 'load-buffer': {
        const { options, words } = read(args, 'b');
        this.buffers.set(String(options.get('b') ?? ''), readFileSync(words[0] ?? '', 'utf8'));
        return ok();
      }
      case 'paste-buffer': {
        const { options } = read(args, 'bt');
        const name = String(options.get('b') ?? '');
        const text = this.buffers.get(name);
        if (options.has('d')) this.buffers.delete(name);
        if (text === undefined) return no('no buffer');
        const answer = await this.ask(String(options.get('t') ?? ''), { op: 'paste', text }, timeoutMs);
        return answer?.ok ? ok() : no("can't find pane");
      }
      // What you select with the mouse is selected by the page: no buffer of tmux has it.
      case 'list-buffers':
        return ok();
      case 'show-buffer':
        return no('no buffer');
      default:
        return no(`not a command of the hosts: ${command}`);
    }
  }

  /** Starts a session: a host apart from this program, with claude inside. Its pid, or why it did not start. */
  async start(start: HostStart): Promise<{ pid: number } | { error: string }> {
    const line = [start.file, ...start.args].reduce((length, arg) => length + arg.length + (arg.match(/["\\]/g)?.length ?? 0) + 3, 0);
    if (line > MAX_COMMAND_LINE) return { error: 'the first prompt and the instructions are too long for Windows together: start with a shorter prompt, and send the rest after' };
    ensurePrivateDir(paths.varDir);
    ensurePrivateDir(paths.runDir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const record = this.recordFile(start.session);
    const failed = `${record}.error`;
    rmSync(failed, { force: true });
    const spec: HostSpec = { ...start, ...(this.options.pipe?.() ?? newPipe('session')), record };
    const file = join(this.dir, `${start.session}-${randomUUID()}.spec`);
    writeFileSync(file, JSON.stringify(spec), { mode: 0o600 });
    const child = spawn(this.options.node ?? process.execPath, [this.options.hostJs ?? paths.hostJs, file], {
      // Apart from this program and from its terminal: it goes on when they end. In a folder of its own, so that the
      // folder of the project can be moved or deleted.
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: this.dir,
    });
    let ended: string | undefined;
    child.on('error', (error) => (ended = error.message));
    child.on('exit', (code) => (ended ??= `its host ended (${code})`));
    child.unref();
    for (const until = Date.now() + START_MS; Date.now() < until; ) {
      const found = this.record(start.session);
      if (found) return { pid: found.pid };
      if (ended !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // claude may have ended at once, with its record: whoever started it says so.
    const why = existsSync(failed) ? readFileSync(failed, 'utf8').split('\n')[0] : undefined;
    rmSync(failed, { force: true });
    rmSync(file, { force: true });
    return { error: why || ended || 'its host did not answer' };
  }

  /** A window on a session: what it draws, and what you type. Closing it leaves the session as it is. */
  override attach(session: string, cols: number, rows: number): Pty {
    const record = this.record(session);
    if (!record) throw new Error(`no session ${session}`);
    return new HostPty(record, cols, rows);
  }

  close(): void {
    for (const { client } of this.clients.values()) client.close();
    this.clients.clear();
  }
}

/** A format of tmux with its names filled in: "#{session_name}\t#{pane_pid}". */
const fill = (format: string, values: Readonly<Record<string, string>>): string => format.replace(/#\{(\w+)\}/g, (_all, name: string) => values[name] ?? '');

/** A window on a session, as a pseudo-terminal of `tmux attach` would be. */
class HostPty implements Pty {
  readonly pid: number;
  private socket: Socket | undefined;
  private readonly queue: HostRequest[] = [];
  private readonly data: Array<(data: string) => void> = [];
  private readonly exits: Array<(event: { exitCode: number }) => void> = [];
  private ended = false;
  private closed = false;

  constructor(record: HostRecord, cols: number, rows: number) {
    this.pid = record.hostPid;
    connectPipe(record).then(
      (socket) => {
        if (this.closed) return socket.destroy();
        this.socket = socket;
        socket.on('close', () => this.end(0));
        socket.on('error', () => this.end(1));
        onMessages(socket, (message) => {
          if ('id' in message) return;
          if (message.type === 'exit') return this.end(message.code);
          for (const listener of this.data) listener(message.data);
        });
        this.send({ op: 'attach', cols, rows });
        for (const request of this.queue.splice(0)) this.send(request);
        return undefined;
      },
      () => this.end(1),
    );
  }

  private send(request: HostRequest): void {
    if (!this.socket) this.queue.push(request);
    else if (!this.socket.destroyed) this.socket.write(`${JSON.stringify(request)}\n`);
  }

  private end(exitCode: number): void {
    if (this.ended) return;
    this.ended = true;
    this.socket?.destroy();
    if (!this.closed) for (const listener of this.exits) listener({ exitCode });
  }

  onData(listener: (data: Buffer | string) => void): void {
    this.data.push(listener);
  }

  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exits.push(listener);
  }

  write(data: string | Buffer): void {
    this.send({ op: 'input', data: typeof data === 'string' ? data : data.toString('latin1') });
  }

  resize(cols: number, rows: number): void {
    this.send({ op: 'resize', cols, rows });
  }

  /** Closes the window: the session goes on. */
  kill(): void {
    this.closed = true;
    this.socket?.destroy();
  }

  pause(): void {
    this.socket?.pause();
  }

  resume(): void {
    this.socket?.resume();
  }
}
