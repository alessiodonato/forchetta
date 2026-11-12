import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import type { Agent, ClaudeUpdateInfo, FileChange, RecallMatch, TodayInfo } from '../shared/agent.ts';
import type { CrewRequest, CrewSummary, CrewTemplate } from '../shared/crew.ts';

// The WebSocket of the app, on /ws. On connection it sends every agent; then, at most once per tick, the agents
// that changed and the ids of those that went away. The page tells whether its window can be seen, so that the
// daemon reads arricurdAI only while someone looks.
//
// Only the page of the daemon may connect: the Origin must be the daemon itself and the token must match.

export type ServerMessage =
  | { type: 'hello'; now: number; agents: Agent[]; settings: UiSettings; today?: TodayInfo; crews?: CrewSummary[]; templates?: CrewTemplate[]; claudeUpdate?: ClaudeUpdateInfo }
  /** A failed automatic update of Claude Code, and the `claude update` started from the app. */
  | { type: 'claudeUpdate'; now: number; update: ClaudeUpdateInfo }
  /** The templates of teams, after one was saved or deleted. */
  | { type: 'crewTemplates'; now: number; templates: CrewTemplate[] }
  /** How a change of a team went (a member added, taken away, → / ⇄), or a template saved: for the window that asked. */
  | { type: 'crewEdited'; now: number; ok: boolean; crewId?: string; action: string; error?: string }
  /** The teams of agents, after one was created. */
  | { type: 'crews'; now: number; crews: CrewSummary[] }
  /** How the start of a team went, for the window that asked. */
  | { type: 'crewCreated'; now: number; ok: boolean; crewId?: string; agentIds?: string[]; error?: string }
  /** The whole thread of a team, for the window that shows it. */
  | { type: 'crewThread'; now: number; crewId: string; requests: CrewRequest[] }
  /** How a request to a team went, for the window that asked: its number, or why it did not go. */
  | { type: 'crewRequested'; now: number; ok: boolean; crewId: string; n?: number; error?: string }
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
  | { type: 'scrollEnd'; agentId: string }
  | { type: 'command'; agentId: string; kind: string; arg?: string; confirmed?: boolean }
  | { type: 'cancel'; agentId: string; commandId: string }
  | { type: 'permission'; agentId: string; ticket: string; behavior: 'allow' | 'deny'; always?: number }
  | { type: 'files'; agentId: string }
  | { type: 'spawn'; cwd: string; prompt?: string; model?: string; mode?: string; worktree?: string | boolean }
  | { type: 'team'; agentId: string; team: unknown }
  /** A new team of agents, as the panel writes it (shared/crew.ts checks it). */
  | { type: 'createCrew'; spec: unknown }
  /** A request from you to some recipients of a team; none means all its members. */
  | { type: 'crewRequest'; crewId: string; to: string[]; text: string }
  /** The whole thread of a team. */
  | { type: 'crewThread'; crewId: string }
  /** A change of a team: a member added (member), taken away (name), or its → / ⇄ (name, talk). */
  | { type: 'editCrew'; crewId: string; action: 'add' | 'remove' | 'talk'; name?: string; talk?: string; member?: unknown }
  /** A template: from the panel of a new team (template), or from an existing team (crewId, with its name). */
  | { type: 'saveCrewTemplate'; template?: unknown; crewId?: string }
  | { type: 'deleteCrewTemplate'; name: string }
  | { type: 'recall'; id: number; project: string; query: string }
  /** Run `claude update`, or hide the line of the last one. */
  | { type: 'claudeUpdate'; action: 'run' | 'dismiss' };

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
  /** A new team of agents: its sessions start, then it is kept. */
  onCreateCrew?: (spec: unknown) => Promise<{ ok: boolean; crewId?: string; agentIds?: string[]; error?: string }>;
  /** The teams of agents, for the page. */
  crews?: () => CrewSummary[];
  /** The whole thread of a team. */
  crewThread?: (crewId: string) => CrewRequest[] | undefined;
  /** A change of a team. */
  onEditCrew?: (message: Extract<ClientMessage, { type: 'editCrew' }>) => Promise<{ ok: boolean; error?: string }>;
  /** The templates of teams, and saving or deleting one. */
  templates?: () => CrewTemplate[];
  onTemplate?: (message: Extract<ClientMessage, { type: 'saveCrewTemplate' | 'deleteCrewTemplate' }>) => { ok: boolean; error?: string };
  /** A request from you to a team. */
  onCrewRequest?: (crewId: string, to: string[], text: string) => { ok: true; n: number } | { ok: false; error: string };
  /** The changes of a session, read when its panel opens. */
  onFiles?: (agentId: string) => Promise<FileChange[]>;
  /** "back to the end" in a pane scrolled back in tmux. */
  onScrollEnd?: (agentId: string) => void;
  /** The answer of a box to a permission dialog. */
  onPermission?: (message: Extract<ClientMessage, { type: 'permission' }>) => void;
  /** The updates of Claude Code, for the top line. */
  claudeUpdate?: () => ClaudeUpdateInfo;
  /** `claude update` from the top line, or its line hidden. */
  onClaudeUpdate?: (action: 'run' | 'dismiss') => void;
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
  // A request to a team can be 20000 characters, up to 80 KB in UTF-8.
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
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
    this.send(ws, {
      type: 'hello',
      now: Date.now(),
      agents: this.options.snapshot(),
      settings: this.options.settings?.() ?? { replace: 'lru', arricurdaiNotes: false },
      today: this.today,
      crews: this.options.crews?.(),
      templates: this.options.templates?.(),
      claudeUpdate: this.options.claudeUpdate?.(),
    });
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
        } else if (message.type === 'createCrew' && this.options.onCreateCrew) {
          void this.options.onCreateCrew(message.spec).then(
            (result) => {
              this.send(ws, { type: 'crewCreated', now: Date.now(), ...result });
              if (result.ok) this.broadcast({ type: 'crews', now: Date.now(), crews: this.options.crews?.() ?? [] });
            },
            (error: unknown) => this.send(ws, { type: 'crewCreated', now: Date.now(), ok: false, error: String(error) }),
          );
        } else if (message.type === 'crewRequest' && typeof message.crewId === 'string' && typeof message.text === 'string' && this.options.onCrewRequest) {
          const to = Array.isArray(message.to) ? message.to.filter((name): name is string => typeof name === 'string') : [];
          const result = this.options.onCrewRequest(message.crewId, to, message.text);
          this.send(ws, { type: 'crewRequested', now: Date.now(), crewId: message.crewId, ...result });
        } else if (message.type === 'editCrew' && typeof message.crewId === 'string' && typeof message.action === 'string' && this.options.onEditCrew) {
          const edit = { type: 'editCrew' as const, crewId: message.crewId, action: message.action as 'add' | 'remove' | 'talk', name: typeof message.name === 'string' ? message.name : undefined, talk: typeof message.talk === 'string' ? message.talk : undefined, member: message.member };
          void this.options.onEditCrew(edit).then(
            (result) => this.send(ws, { type: 'crewEdited', now: Date.now(), crewId: edit.crewId, action: edit.action, ...result }),
            (error: unknown) => this.send(ws, { type: 'crewEdited', now: Date.now(), crewId: edit.crewId, action: edit.action, ok: false, error: String(error) }),
          );
        } else if ((message.type === 'saveCrewTemplate' || message.type === 'deleteCrewTemplate') && this.options.onTemplate) {
          const result =
            message.type === 'saveCrewTemplate'
              ? this.options.onTemplate({ type: 'saveCrewTemplate', template: message.template, crewId: typeof message.crewId === 'string' ? message.crewId : undefined })
              : this.options.onTemplate({ type: 'deleteCrewTemplate', name: String(message.name ?? '') });
          this.send(ws, { type: 'crewEdited', now: Date.now(), action: message.type, ...result });
          if (result.ok) this.broadcast({ type: 'crewTemplates', now: Date.now(), templates: this.options.templates?.() ?? [] });
        } else if (message.type === 'crewThread' && typeof message.crewId === 'string' && this.options.crewThread) {
          const requests = this.options.crewThread(message.crewId);
          if (requests) this.send(ws, { type: 'crewThread', now: Date.now(), crewId: message.crewId, requests });
        } else if (message.type === 'claudeUpdate' && (message.action === 'run' || message.action === 'dismiss')) {
          this.options.onClaudeUpdate?.(message.action);
        } else if (message.type === 'scrollEnd' && typeof message.agentId === 'string') {
          this.options.onScrollEnd?.(message.agentId);
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

  private crewsPending = false;

  /** A team or one of its requests changed: every window gets the teams again, once per tick. */
  crewsChanged(): void {
    if (this.crewsPending) return;
    this.crewsPending = true;
    setImmediate(() => {
      this.crewsPending = false;
      this.broadcast({ type: 'crews', now: Date.now(), crews: this.options.crews?.() ?? [] });
    });
  }

  setToday(today: TodayInfo): void {
    if (JSON.stringify(today) === JSON.stringify(this.today)) return;
    this.today = today;
    this.broadcast({ type: 'today', now: Date.now(), today });
  }

  setClaudeUpdate(update: ClaudeUpdateInfo): void {
    this.broadcast({ type: 'claudeUpdate', now: Date.now(), update });
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
