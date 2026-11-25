import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import type { WebSocket } from 'ws';
import { daemonEnv } from '../cli/pane-env.ts';
import { type Agent, displayName } from '../shared/agent.ts';
import type { ShellInfo, ShellKind } from '../shared/shells.ts';
import type { Pty, PtyModule } from './pty.ts';

// The plain terminals of the page: a shell in the folder of a session, in a pseudo-terminal of the daemon. Each lives as
// long as its pane, as a window of a terminal does: closing the pane ends it (the page asks first when something runs in
// it), and so does stopping the daemon. A page that reloads finds it again: without a page it waits a minute. It is not
// a session: no tmux, no hook, no box; a `claude` started in one is a session as any other you type in a terminal.

/** How many at once, in all the windows. */
export const MAX_SHELLS = 8;
/** How long one waits for its page to come back, and how much of what it drew comes back with it. */
const WAIT_MS = 60_000;
const KEPT_BYTES = 256 * 1024;
/** A burst of output waits in the shell while the page catches up. */
const BUFFER_HIGH = 1 << 20;
const BUFFER_LOW = 1 << 18;
export const SHELL_ENDED = 4000;
/** Another window, or the same one again, took the terminal. */
const TAKEN = 4001;

export interface ShellProgram extends ShellKind {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

export interface ShellsOptions {
  pty: () => PtyModule;
  programs: () => ShellProgram[];
  env?: NodeJS.ProcessEnv;
  log: Log;
  waitMs?: number;
  /** What runs in a shell now, besides the shell; undefined when nothing does. */
  running?: (pty: Pty, program: ShellProgram) => Promise<string | undefined> | string | undefined;
}

interface Open {
  info: ShellInfo;
  program: ShellProgram;
  pty: Pty;
  kept: Buffer[];
  keptBytes: number;
  ws?: WebSocket;
  timer?: NodeJS.Timeout;
  /** A page showed it already. */
  shown: boolean;
  paused: boolean;
  ended: boolean;
}

/** The shell of the user, as a new window of the Terminal starts it. */
export function userShell(): ShellProgram[] {
  const file = userInfo().shell || '/bin/sh';
  return [{ id: 'shell', label: basename(file), file, args: ['-l'] }];
}

/** The environment of a plain terminal: the one of the daemon, less what is of Forchetta, of a session, of tmux. */
export function shellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(daemonEnv(env))) if (value !== undefined && !name.startsWith('FORCHETTA_')) out[name] = value;
  if (process.platform !== 'win32' && !/UTF-?8/i.test(out.LC_ALL ?? out.LC_CTYPE ?? out.LANG ?? '')) out.LANG = 'en_US.UTF-8';
  return { ...out, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Forchetta' };
}

/** The program in front in a shell, by the terminal: "npm" while npm runs, nothing at the prompt. */
export function inFront(pty: Pty, program: ShellProgram): string | undefined {
  const name = pty.process ? basename(pty.process).replace(/^-/, '') : undefined;
  return name && name !== basename(program.file) ? name : undefined;
}

export class Shells {
  private readonly open = new Map<string, Open>();

  constructor(private readonly options: ShellsOptions) {}

  get size(): number {
    return this.open.size;
  }

  has(id: string): boolean {
    return this.open.has(id);
  }

  kinds(): ShellKind[] {
    return this.options.programs().map(({ id, label }) => ({ id, label }));
  }

  /** Those whose page went away a moment ago: the page that comes now shows them again. */
  waiting(): ShellInfo[] {
    return [...this.open.values()].filter((one) => !one.ws && !one.ended).map((one) => one.info);
  }

  start(agent: Agent, kind: string | undefined): { ok: true; shell: ShellInfo } | { ok: false; error: string } {
    const programs = this.options.programs();
    const program = programs.find((one) => one.id === kind) ?? programs[0];
    if (!program) return { ok: false, error: 'no shell was found on this computer' };
    if (this.open.size >= MAX_SHELLS) return { ok: false, error: `${MAX_SHELLS} terminals are open: close one first` };
    const cwd = agent.cwd;
    try {
      if (!cwd || !statSync(cwd).isDirectory()) return { ok: false, error: `${cwd ?? 'its folder'} is not a folder` };
    } catch {
      return { ok: false, error: `the folder ${cwd} is gone` };
    }
    let pty: Pty;
    try {
      pty = this.options.pty().spawn(program.file, program.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: { ...shellEnv(this.options.env ?? process.env), ...program.env }, encoding: null });
    } catch (error) {
      this.options.log(`terminal in ${cwd} not opened: ${String(error)}`, 'warn');
      return { ok: false, error: `${program.label} did not start: ${error instanceof Error ? error.message : String(error)}` };
    }
    const one: Open = { info: { id: `shell-${randomUUID()}`, agentId: agent.id, name: displayName(agent), cwd, kind: program.id, label: program.label }, program, pty, kept: [], keptBytes: 0, shown: false, paused: false, ended: false };
    this.open.set(one.info.id, one);
    pty.onData((data) => {
      const bytes = Buffer.from(data);
      one.kept.push(bytes);
      one.keptBytes += bytes.length;
      while (one.keptBytes > KEPT_BYTES && one.kept.length > 1) one.keptBytes -= one.kept.shift()!.length;
      const ws = one.ws;
      if (!ws || ws.readyState !== ws.OPEN) return;
      ws.send(bytes, { binary: true });
      if (!one.paused && ws.bufferedAmount > BUFFER_HIGH) {
        one.paused = true;
        pty.pause();
        this.resumeWhenDrained(one);
      }
    });
    pty.onExit(() => this.gone(one));
    this.wait(one);
    this.options.log(`terminal opened: ${program.label} in ${cwd} (${pty.pid})`);
    return { ok: true, shell: one.info };
  }

  /** The page shows it: what it drew so far, then what comes. `false` when there is none with this id. */
  attach(id: string, ws: WebSocket, columns: number, rows: number): boolean {
    const one = this.open.get(id);
    if (!one || one.ended) return false;
    clearTimeout(one.timer);
    if (one.ws) one.ws.close(TAKEN, 'shown elsewhere');
    one.ws = ws;
    // From this on, what the page answers by itself (where the cursor is, which terminal it is) is for the shell. Not to what
    // it draws again, which was answered then.
    if (!one.shown) ws.send('{"type":"ready"}');
    for (const bytes of one.kept) ws.send(bytes, { binary: true });
    if (one.shown) ws.send('{"type":"ready"}');
    one.shown = true;
    this.resize(one, columns, rows);
    return true;
  }

  input(id: string, ws: WebSocket, data: string | Buffer): void {
    const one = this.open.get(id);
    // ConPTY takes text only.
    if (one?.ws === ws && !one.ended) one.pty.write(typeof data !== 'string' && process.platform === 'win32' ? data.toString('latin1') : data);
  }

  resized(id: string, ws: WebSocket, columns: number, rows: number): void {
    const one = this.open.get(id);
    if (one?.ws === ws) this.resize(one, columns, rows);
  }

  private resumeWhenDrained(one: Open): void {
    setTimeout(() => {
      if (one.ended) return;
      if (one.ws && one.ws.bufferedAmount >= BUFFER_LOW) return this.resumeWhenDrained(one);
      one.paused = false;
      one.pty.resume();
    }, 50);
  }

  private resize(one: Open, columns: number, rows: number): void {
    try {
      one.pty.resize(columns, rows);
    } catch {
      // It ended meanwhile.
    }
  }

  /** Its page went away: it waits for it a little. */
  detached(id: string, ws: WebSocket): void {
    const one = this.open.get(id);
    if (!one || one.ws !== ws) return;
    one.ws = undefined;
    this.wait(one);
  }

  /** Closes one; not when something runs in it, unless `force`: then says what. */
  async close(id: string, force: boolean): Promise<{ ok: boolean; running?: string }> {
    const one = this.open.get(id);
    if (!one) return { ok: true };
    if (!force) {
      const running = await (this.options.running ?? inFront)(one.pty, one.program);
      if (running) return { ok: false, running };
    }
    this.end(one);
    return { ok: true };
  }

  closeAll(): void {
    for (const one of [...this.open.values()]) this.end(one);
  }

  private wait(one: Open): void {
    clearTimeout(one.timer);
    one.timer = setTimeout(() => this.end(one), this.options.waitMs ?? WAIT_MS);
    one.timer.unref?.();
  }

  private end(one: Open): void {
    if (one.ended) return;
    try {
      one.pty.kill(process.platform === 'win32' ? undefined : 'SIGHUP');
    } catch {
      // Already gone.
    }
    this.gone(one);
  }

  private gone(one: Open): void {
    if (one.ended) return;
    one.ended = true;
    clearTimeout(one.timer);
    this.open.delete(one.info.id);
    one.ws?.close(SHELL_ENDED, 'the shell ended');
    this.options.log(`terminal closed: ${one.info.label} in ${one.info.cwd}`);
  }
}
