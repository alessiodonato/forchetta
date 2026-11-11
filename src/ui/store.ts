import type { Agent, FileChange, RecallMatch, TodayInfo } from '../shared/agent.ts';
import type { ClientMessage, ServerMessage, UiSettings } from '../daemon/hub.ts';
import { cancelAsking, closePane, emptyPanes, openPane, type PaneState, prunePanes, replacePane, usePane } from './layout.ts';

// What the page knows: the agents sent by the daemon, the open panes, whether the connection is up, whether the
// window can be seen. Changes replace only the agents that changed, so unchanged boxes keep their object and
// skip rendering.

export interface UiState {
  agents: ReadonlyMap<string, Agent>;
  connected: boolean;
  /** The first list arrived. */
  ready: boolean;
  visible: boolean;
  panes: PaneState;
  settings: UiSettings;
  /** Every call since midnight, from arricurdAI. */
  today?: TodayInfo;
  /** The panel of the changes of a session: list undefined while the daemon reads them. */
  files?: { agentId: string; list?: FileChange[] };
  /** The search in earlier sessions: the one asked last, and its answer once it came. */
  recall?: { id: number; project: string; query: string; busy: boolean; sessions?: number; matches?: RecallMatch[]; error?: string };
  /** A panel asked from outside the page (the menu of the icon), with when: the app opens it. */
  panelRequest?: { which: 'new'; at: number };
  /** A new session being started from the panel, or the reason it did not start. */
  spawn?: { busy: boolean; error?: string; startedId?: string };
}

/** A session whose terminal can be shown: run in the tmux of Forchetta, and not ended. */
export const canOpen = (agent: Agent | undefined): boolean => agent !== undefined && agent.control.kind === 'tmux' && agent.state !== 'ended';

export class Store {
  state: UiState = { agents: new Map(), connected: false, ready: false, visible: true, panes: emptyPanes(), settings: { replace: 'lru', arricurdaiNotes: false } };
  /** Sends a message to the daemon (set by the connection). */
  send: (message: ClientMessage) => void = () => {};
  /** A notification asked by the daemon (see attention.ts). */
  onNotify: (message: Extract<ServerMessage, { type: 'notify' }>) => void = () => {};
  /** Agents that arrived after the first list: their box enters with an animation, once. */
  readonly entering = new Set<string>();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(next: Partial<UiState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  apply(message: ServerMessage): void {
    if (message.type === 'notify') {
      this.onNotify(message);
      return;
    }
    if (message.type === 'today') {
      this.set({ today: message.today });
      return;
    }
    if (message.type === 'recalled') {
      // An answer to an older search is left out: only the last one counts.
      const current = this.state.recall;
      if (current && current.id === message.id) this.set({ recall: { ...current, busy: false, sessions: message.sessions, matches: message.matches, error: message.ok ? undefined : message.error } });
      return;
    }
    if (message.type === 'spawned') {
      if (message.ok && message.agentId) {
        this.set({ spawn: { busy: false, startedId: message.agentId } });
        this.openWhenThere(message.agentId);
      } else this.set({ spawn: { busy: false, error: message.error ?? 'la sessione non è partita' } });
      return;
    }
    if (message.type === 'files') {
      if (this.state.files?.agentId === message.agentId) this.set({ files: { agentId: message.agentId, list: message.files } });
      return;
    }
    const agents = new Map(this.state.agents);
    const extra: Partial<UiState> = {};
    switch (message.type) {
      case 'hello':
        agents.clear();
        for (const agent of message.agents) agents.set(agent.id, agent);
        extra.settings = message.settings;
        extra.today = message.today;
        break;
      case 'agents':
        for (const agent of message.agents) {
          if (!agents.has(agent.id) && this.state.ready) this.entering.add(agent.id);
          agents.set(agent.id, agent);
        }
        break;
      case 'removed':
        for (const id of message.ids) agents.delete(id);
        break;
    }
    // A pane whose agent went away closes; one whose session ended stays, showing its last screen.
    extra.panes = prunePanes(this.state.panes, (id) => agents.has(id));
    this.set({ ...extra, agents, ready: true });
    if (this.pendingOpen && agents.has(this.pendingOpen)) this.openWhenThere(this.pendingOpen);
  }

  setConnected(connected: boolean): void {
    if (connected !== this.state.connected) this.set({ connected });
  }

  setVisible(visible: boolean): void {
    if (visible !== this.state.visible) this.set({ visible });
  }

  /** A click on a box. Sessions outside the tmux of Forchetta, and ended ones, have no terminal to show. */
  open(id: string): void {
    if (!canOpen(this.state.agents.get(id))) return;
    this.set({ panes: openPane(this.state.panes, id, Date.now(), this.state.settings.replace) });
  }

  /** The answer to "which pane do I replace?". */
  replace(victim: string): void {
    const asking = this.state.panes.asking;
    if (!asking) return;
    this.set({ panes: replacePane(cancelAsking(this.state.panes), victim, asking, Date.now()) });
  }

  cancelAsking(): void {
    this.set({ panes: cancelAsking(this.state.panes) });
  }

  close(id: string): void {
    this.set({ panes: closePane(this.state.panes, id) });
  }

  /** A command of a box. /clear goes only with confirmed: the box asked first. */
  command(agentId: string, kind: 'btw' | 'compact' | 'clear', arg?: string, confirmed = false): void {
    this.send({ type: 'command', agentId, kind, arg, confirmed });
  }

  cancelCommand(agentId: string, commandId: string): void {
    this.send({ type: 'cancel', agentId, commandId });
  }

  private pendingOpen: string | undefined;

  /** Opens the pane of a session as soon as the daemon has told about it. */
  private openWhenThere(agentId: string): void {
    if (!this.state.agents.has(agentId)) {
      this.pendingOpen = agentId;
      return;
    }
    this.pendingOpen = undefined;
    this.open(agentId);
  }

  requestPanel(which: 'new'): void {
    this.set({ panelRequest: { which, at: Date.now() } });
  }

  private recallId = 0;

  /** Searches the earlier sessions of a project with arricurdAI. */
  search(project: string, query: string): void {
    const id = ++this.recallId;
    this.set({ recall: { id, project, query, busy: true } });
    this.send({ type: 'recall', id, project, query });
  }

  /** A new session in a folder, with a first prompt if there is one. */
  spawn(cwd: string, prompt: string, choices: { model?: string; mode?: string; worktree?: string | boolean } = {}): void {
    this.set({ spawn: { busy: true } });
    this.send({ type: 'spawn', cwd, prompt, ...choices });
  }

  endSpawn(): void {
    if (this.state.spawn) this.set({ spawn: undefined });
  }

  /** Name, group and role of a session; undefined takes them away. */
  setTeam(agentId: string, team: { label: string; group: string; role: string; lead: boolean } | undefined): void {
    this.send({ type: 'team', agentId, team: team ?? null });
  }

  /** Opens the panel of the changes of a session, or reads them again. */
  showFiles(agentId: string): void {
    this.set({ files: { agentId } });
    this.send({ type: 'files', agentId });
  }

  closeFiles(): void {
    if (this.state.files) this.set({ files: undefined });
  }

  /** The answer of a box to the permission dialog with this ticket. */
  permission(agentId: string, ticket: string, behavior: 'allow' | 'deny', always?: number): void {
    this.send({ type: 'permission', agentId, ticket, behavior, always });
  }

  /** Typing or clicking in a pane: nothing changes on screen, so nobody is told. */
  use(id: string): void {
    this.state = { ...this.state, panes: usePane(this.state.panes, id, Date.now()) };
  }
}
