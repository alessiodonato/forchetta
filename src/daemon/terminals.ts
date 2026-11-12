import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import type { Tmux } from '../shared/tmux.ts';
import type { Registry } from './registry.ts';

// The terminals of the app: one WebSocket per open pane, on /term. Each runs `tmux attach` for the session of its
// agent inside a pseudo-terminal: what tmux draws goes to xterm.js in the page as bytes, what you type comes back.
//
// Closing the pane closes the WebSocket, and the daemon sends SIGHUP to that tmux *client*, the `attach` it
// started: tmux detaches it, and the session, with Claude in it, goes on. Nothing here, nor anywhere in
// Forchetta, can end a session (see shared/tmux.ts).

interface Pty {
  readonly pid: number;
  onData(listener: (data: Buffer | string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string | Buffer): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

interface PtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): Pty;
}

let ptyModule: PtyModule | undefined;
/** node-pty is native and loaded from node_modules, the first time a pane opens. */
function loadPty(): PtyModule {
  ptyModule ??= createRequire(import.meta.url)('node-pty') as PtyModule;
  return ptyModule;
}

export interface TerminalsOptions {
  token: string;
  port: () => number;
  registry: Registry;
  tmux: Tmux;
  log: (message: string) => void;
  /** Panes open at once, across windows: the app shows 4. */
  max?: number;
}

/** What the page sends as text: the size of the pane, or what was typed. */
type ClientMessage = { type: 'resize'; cols: number; rows: number } | { type: 'input'; data: string; binary?: boolean };

const BUFFER_HIGH = 1 << 20;
const BUFFER_LOW = 1 << 18;
export const SESSION_ENDED = 4000;

const clamp = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;

function sameToken(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The environment of the tmux client: a terminal that speaks UTF-8 and 256 colors, outside any other tmux. */
function clientEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' };
  if (!/UTF-?8/i.test(env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? '')) env.LANG = 'en_US.UTF-8';
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

export class Terminals {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  private readonly open = new Map<WebSocket, Pty>();
  /** The session of each open terminal. */
  private readonly sessionOf = new Map<WebSocket, string>();

  constructor(private readonly options: TerminalsOptions) {}

  get size(): number {
    return this.open.size;
  }

  /** The tmux sessions with a terminal open in a window. */
  openSessions(): Set<string> {
    return new Set(this.sessionOf.values());
  }

  private refuse(socket: Duplex, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  /** For the 'upgrade' event on /term. Only the page of this daemon, for an agent it runs in tmux. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const port = this.options.port();
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const hostOk = req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
    if (!hostOk || req.headers.origin !== `http://127.0.0.1:${port}` || !sameToken(url.searchParams.get('token'), this.options.token)) {
      return this.refuse(socket, '403 Forbidden');
    }
    const agent = this.options.registry.agents.get(url.searchParams.get('agent') ?? '');
    if (!agent || agent.state === 'ended' || agent.control.kind !== 'tmux') return this.refuse(socket, '404 Not Found');
    if (this.open.size >= (this.options.max ?? 8)) return this.refuse(socket, '429 Too Many Requests');
    const session = agent.control.session;
    const columns = clamp(Number(url.searchParams.get('cols')), 20, 500, 100);
    const rows = clamp(Number(url.searchParams.get('rows')), 5, 200, 30);
    this.server.handleUpgrade(req, socket, head, (ws) => this.attach(ws, session, columns, rows));
  }

  private attach(ws: WebSocket, session: string, columns: number, rows: number): void {
    let pty: Pty;
    try {
      pty = loadPty().spawn(this.options.tmux.bin, this.options.tmux.argv('attach-session', ['-t', session]), {
        name: 'xterm-256color',
        cols: columns,
        rows,
        cwd: process.env.HOME ?? '/',
        env: clientEnv(),
        encoding: null,
      });
    } catch (error) {
      this.options.log(`terminale per ${session} non aperto: ${String(error)}`);
      ws.close(1011, 'tmux non avviato');
      return;
    }
    this.open.set(ws, pty);
    this.sessionOf.set(ws, session);
    this.options.log(`terminale aperto: ${session} (client tmux ${pty.pid})`);

    // A burst of output (a long diff, a redraw) waits in the pty while the page catches up.
    let paused = false;
    const resumeWhenDrained = (): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount < BUFFER_LOW) {
        paused = false;
        pty.resume();
      } else {
        setTimeout(resumeWhenDrained, 50);
      }
    };
    pty.onData((data) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(data, { binary: true });
      if (!paused && ws.bufferedAmount > BUFFER_HIGH) {
        paused = true;
        pty.pause();
        setTimeout(resumeWhenDrained, 50);
      }
    });
    pty.onExit(() => {
      this.open.delete(ws);
      this.sessionOf.delete(ws);
      // tmux ended the client: the session is over (Claude exited), or the server is gone.
      if (ws.readyState === ws.OPEN) ws.close(SESSION_ENDED, 'sessione terminata');
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let message: ClientMessage;
      try {
        message = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      if (message.type === 'input' && typeof message.data === 'string') {
        pty.write(message.binary ? Buffer.from(message.data, 'latin1') : message.data);
      } else if (message.type === 'resize') {
        pty.resize(clamp(message.cols, 20, 500, columns), clamp(message.rows, 5, 200, rows));
      }
    });
    ws.on('close', () => {
      this.sessionOf.delete(ws);
      if (!this.open.has(ws)) return;
      this.open.delete(ws);
      this.detach(pty, session);
    });
    ws.on('error', (error) => this.options.log(`terminale ${session}: ${String(error)}`));
  }

  /** SIGHUP to the tmux client started for this pane: it detaches; the session stays. */
  private detach(pty: Pty, session: string): void {
    try {
      pty.kill('SIGHUP');
      this.options.log(`terminale chiuso: ${session} (client tmux ${pty.pid} scollegato, sessione intatta)`);
    } catch {
      // Already gone.
    }
  }

  close(): void {
    for (const ws of this.open.keys()) ws.close(1001, 'daemon fermato');
    this.server.close();
  }
}
