import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import type { Agent, FileChange, RecallMatch, TodayInfo } from '../shared/agent.ts';

// The WebSocket of the app, on /ws. On connection it sends every agent; then, at most once per tick, the agents
// that changed and the ids of those that went away. The page tells whether its window can be seen, so that the
// daemon reads arricurdAI only while someone looks.
//
// Only the page of the daemon may connect: the Origin must be the daemon itself and the token must match.

export type ServerMessage =
  | { type: 'hello'; now: number; agents: Agent[]; settings: UiSettings; today?: TodayInfo }
  /** What every session cost since midnight, read again from arricurdAI. */
  | { type: 'today'; now: number; today: TodayInfo }
  | { type: 'agents'; now: number; agents: Agent[] }
  | { type: 'removed'; now: number; ids: string[] }
  /** What `arricurdai recall` found, for the window that asked. */
  | { type: 'recalled'; now: number; id: number; ok: boolean; sessions?: number; matches?: RecallMatch[]; error?: string }
  /** How the start of a new session went, for the window that asked. */
  | { type: 'spawned'; now: number; ok: boolean; agentId?: string; error?: string }
  /** The changes of a session, for the window that asked. */
  | { type: 'files'; now: number; agentId: string; files: FileChange[] }
  /** A session waits for you, seems stuck or ended with an error: the app shows a notification of macOS. */
  | { type: 'notify'; now: number; agentId: string; kind: 'waiting' | 'stall' | 'error'; title: string; body: string };

/** What the page needs to know of the configuration. */
export interface UiSettings {
  /** A fifth pane replaces the least recently used one, or asks which one. */
  replace: 'lru' | 'chiedi';
  /** arricurdAI can keep a note of a session before /clear (`handoff --prepare`). */
  arricurdaiNotes: boolean;
  /** Minutes with no event after which a session at work is shown as stalled. */
  stallMin?: number;
}

/** What the page asks of the daemon. */
export type ClientMessage =
  | { type: 'visibility'; visible: boolean }
  | { type: 'command'; agentId: string; kind: string; arg?: string; confirmed?: boolean }
  | { type: 'cancel'; agentId: string; commandId: string }
  | { type: 'permission'; agentId: string; ticket: string; behavior: 'allow' | 'deny'; always?: number }
  | { type: 'files'; agentId: string }
  | { type: 'spawn'; cwd: string; prompt?: string; model?: string; mode?: string; worktree?: string | boolean }
  | { type: 'team'; agentId: string; team: unknown }
  | { type: 'recall'; id: number; project: string; query: string };

export interface HubOptions {
  token: string;
  port: () => number;
  snapshot: () => Agent[];
  settings?: () => UiSettings;
  /** A command from a box, or the cancel of one still waiting. */
  onCommand?: (message: Extract<ClientMessage, { type: 'command' | 'cancel' }>) => void;
  /** A search in the earlier sessions of a project. */
  onRecall?: (project: string, query: string) => Promise<{ ok: boolean; sessions?: number; matches?: RecallMatch[]; error?: string }>;
  /** Name, group and role of a session, from its box. */
  onTeam?: (agentId: string, team: unknown) => void;
  /** A new session from the app: a folder and a first prompt. */
  onSpawn?: (input: { cwd: string; prompt?: string; model?: unknown; mode?: unknown; worktree?: unknown }) => Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
  /** The changes of a session, read when its panel opens. */
  onFiles?: (agentId: string) => Promise<FileChange[]>;
  /** The answer of a box to a permission dialog. */
  onPermission?: (message: Extract<ClientMessage, { type: 'permission' }>) => void;
  /** Called when the number of windows that can be seen goes from 0 to more, or back. */
  onWatched?: (watched: boolean) => void;
  log: (message: string) => void;
}

function sameToken(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Hub {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly clients = new Map<WebSocket, { visible: boolean }>();
  private readonly pending = new Map<string, Agent>();
  private readonly removed = new Set<string>();
  private flushing = false;
  private watched = false;
  private today: TodayInfo | undefined;

  constructor(private readonly options: HubOptions) {}

  /** For the 'upgrade' event of the HTTP server. Refuses anything that is not the page of this daemon. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const port = this.options.port();
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const own = `http://127.0.0.1:${port}`;
    const hostOk = req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
    if (url.pathname !== '/ws' || !hostOk || req.headers.origin !== own || !sameToken(url.searchParams.get('token'), this.options.token)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.server.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  }

  private accept(ws: WebSocket): void {
    this.clients.set(ws, { visible: true });
    this.send(ws, { type: 'hello', now: Date.now(), agents: this.options.snapshot(), settings: this.options.settings?.() ?? { replace: 'lru', arricurdaiNotes: false }, today: this.today });
    this.updateWatched();
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        if (message.type === 'visibility' && typeof message.visible === 'boolean') {
          const client = this.clients.get(ws);
          if (client) client.visible = message.visible;
          this.updateWatched();
        } else if (message.type === 'command' && typeof message.agentId === 'string' && typeof message.kind === 'string') {
          this.options.onCommand?.({
            type: 'command',
            agentId: message.agentId,
            kind: message.kind,
            arg: typeof message.arg === 'string' ? message.arg : undefined,
            confirmed: message.confirmed === true,
          });
        } else if (message.type === 'cancel' && typeof message.agentId === 'string' && typeof message.commandId === 'string') {
          this.options.onCommand?.({ type: 'cancel', agentId: message.agentId, commandId: message.commandId });
        } else if (
          message.type === 'permission' &&
          typeof message.agentId === 'string' &&
          typeof message.ticket === 'string' &&
          (message.behavior === 'allow' || message.behavior === 'deny')
        ) {
          this.options.onPermission?.({
            type: 'permission',
            agentId: message.agentId,
            ticket: message.ticket,
            behavior: message.behavior,
            always: Number.isInteger(message.always) && (message.always as number) >= 0 ? (message.always as number) : undefined,
          });
        } else if (message.type === 'recall' && typeof message.id === 'number' && this.options.onRecall) {
          const id = message.id;
          void this.options.onRecall(String(message.project), String(message.query)).then(
            (result) => this.send(ws, { type: 'recalled', now: Date.now(), id, ...result }),
            (error: unknown) => this.send(ws, { type: 'recalled', now: Date.now(), id, ok: false, error: String(error) }),
          );
        } else if (message.type === 'team' && typeof message.agentId === 'string') {
          this.options.onTeam?.(message.agentId, message.team);
        } else if (message.type === 'spawn' && typeof message.cwd === 'string' && this.options.onSpawn) {
          void this.options.onSpawn({
            cwd: message.cwd,
            prompt: typeof message.prompt === 'string' ? message.prompt : undefined,
            model: message.model,
            mode: message.mode,
            worktree: message.worktree,
          }).then(
            (result) => this.send(ws, { type: 'spawned', now: Date.now(), ...result }),
            (error: unknown) => this.send(ws, { type: 'spawned', now: Date.now(), ok: false, error: String(error) }),
          );
        } else if (message.type === 'files' && typeof message.agentId === 'string' && this.options.onFiles) {
          const agentId = message.agentId;
          void this.options.onFiles(agentId).then(
            (files) => this.send(ws, { type: 'files', now: Date.now(), agentId, files }),
            (error: unknown) => this.options.log(`modifiche di ${agentId}: ${String(error)}`),
          );
        }
      } catch {
        // Not for us.
      }
    });
    ws.on('close', () => {
      this.clients.delete(ws);
      this.updateWatched();
    });
    ws.on('error', (error) => this.options.log(`websocket: ${String(error)}`));
  }

  private updateWatched(): void {
    const watched = [...this.clients.values()].some((client) => client.visible);
    if (watched === this.watched) return;
    this.watched = watched;
    this.options.onWatched?.(watched);
  }

  /** Whether a window shows the boxes now. */
  isWatched(): boolean {
    return this.watched;
  }

  get size(): number {
    return this.clients.size;
  }

  agentChanged(agent: Agent): void {
    this.pending.set(agent.id, agent);
    this.removed.delete(agent.id);
    this.flushSoon();
  }

  agentsRemoved(ids: readonly string[]): void {
    for (const id of ids) {
      this.pending.delete(id);
      this.removed.add(id);
    }
    this.flushSoon();
  }

  /** Changes of the same tick go out together: a burst of events is one message. */
  private flushSoon(): void {
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      const now = Date.now();
      if (this.pending.size > 0) this.broadcast({ type: 'agents', now, agents: [...this.pending.values()] });
      if (this.removed.size > 0) this.broadcast({ type: 'removed', now, ids: [...this.removed] });
      this.pending.clear();
      this.removed.clear();
    });
  }

  setToday(today: TodayInfo): void {
    if (JSON.stringify(today) === JSON.stringify(this.today)) return;
    this.today = today;
    this.broadcast({ type: 'today', now: Date.now(), today });
  }

  notify(notice: { agentId: string; kind: 'waiting' | 'stall' | 'error'; title: string; body: string }): void {
    this.broadcast({ type: 'notify', now: Date.now(), ...notice });
  }

  private broadcast(message: ServerMessage): void {
    if (this.clients.size === 0) return;
    const text = JSON.stringify(message);
    for (const ws of this.clients.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  close(): void {
    for (const ws of this.clients.keys()) ws.close(1001, 'daemon fermato');
    this.server.close();
  }
}
