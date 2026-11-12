import type { Agent, ClaudeUpdateInfo, FileChange, RecallMatch, TodayInfo } from '../shared/agent.ts';
import type { ClientMessage, ServerMessage, UiSettings } from '../daemon/hub.ts';
import type { CrewMemberSpec, CrewRequest, CrewSpec, CrewSummary, CrewTemplate, Talk } from '../shared/crew.ts';
import type { QuickPrompt } from '../shared/prompts.ts';
import { cleanSelection } from '../shared/selection.ts';
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
  /** A failed automatic update of Claude Code, and the `claude update` started from the top line. */
  claudeUpdate?: ClaudeUpdateInfo;
  /** The panel of the changes of a session: list undefined while the daemon reads them. */
  files?: { agentId: string; list?: FileChange[] };
  /** The search in earlier sessions: the one asked last, and its answer once it came. */
  recall?: { id: number; project: string; query: string; busy: boolean; sessions?: number; matches?: RecallMatch[]; error?: string };
  /** A panel asked from outside the page (the menu of the icon, the menu of a selection), with when: the app opens it. */
  panelRequest?: { which: 'new' | 'prompts'; at: number };
  /** The menu of a selection in a pane: what you selected, and where you let go of the mouse in the pane. */
  selection?: SelectionMenuState;
  /** The last question or text sent from the menu of a selection: while the daemon answers, then why it did not go. */
  selectionSend?: { action: 'ask' | 'insert'; busy: boolean; error?: string };
  /** Text just put into the prompt of a session: its pane takes the keyboard, to finish it. */
  inserted?: { agentId: string; at: number };
  /** The quick prompts of the menu of a selection. */
  prompts: readonly QuickPrompt[];
  /** Saving the quick prompts from their panel. */
  promptsSave?: { busy: boolean; ok?: boolean; error?: string; at: number };
  /** A new session being started from the panel, or the reason it did not start. */
  spawn?: { busy: boolean; error?: string; startedId?: string };
  /** The teams of agents. */
  crews: readonly CrewSummary[];
  /** A team being started from its panel; when it started, its id; what did not start, if anything. */
  crewSpawn?: { busy: boolean; error?: string; createdId?: string };
  /** The templates of teams: the ones of Forchetta, then yours. */
  templates: readonly CrewTemplate[];
  /** The last change of a team or of the templates asked from a panel, and how it went. */
  crewEdit?: { action: string; busy: boolean; ok?: boolean; error?: string; at: number };
  /** The whole thread of the team the panel shows: asked again each time the teams change. */
  crewThread?: { crewId: string; requests?: CrewRequest[] };
  /** The last request sent from the panel of a team: its number once it is in the queues, or why not. */
  crewRequest?: { crewId: string; busy: boolean; n?: number; error?: string };
}

/** Where the mouse was let go in a pane, and the size of the pane: the menu of the selection opens there. */
export interface SelectionPlace {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionMenuState extends SelectionPlace {
  agentId: string;
  /** Cleaned of what Claude Code draws around its text (shared/selection.ts). */
  text: string;
  at: number;
}

/** At most 4 panes: the lead and the first members of a new team open, the lead last, in the large pane. */
export const panesToOpen = (agentIds: readonly string[]): string[] => agentIds.slice(0, 4).reverse();

/** A session whose terminal can be shown: run in the tmux of Forchetta, and not ended. */
export const canOpen = (agent: Agent | undefined): boolean => agent !== undefined && agent.control.kind === 'tmux' && agent.state !== 'ended';

export class Store {
  state: UiState = { agents: new Map(), connected: false, ready: false, visible: true, panes: emptyPanes(), settings: { replace: 'lru', arricurdaiNotes: false }, crews: [], templates: [], prompts: [] };
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
    if (message.type === 'claudeUpdate') {
      this.set({ claudeUpdate: message.update });
      return;
    }
    if (message.type === 'selection') {
      // The answer to the end of a drag in a pane: only the last one, and only soon after.
      const place = this.pendingSelection;
      if (!place || place.agentId !== message.agentId || Date.now() - place.at > 5000) return;
      this.pendingSelection = undefined;
      this.showSelection(message.agentId, message.text, place);
      return;
    }
    if (message.type === 'selectionSent') {
      if (!message.ok) {
        this.set({ selectionSend: { action: message.action, busy: false, error: message.error ?? 'not sent' } });
        return;
      }
      this.set({
        selection: undefined,
        selectionSend: undefined,
        ...(message.action === 'insert' ? { inserted: { agentId: message.agentId, at: Date.now() } } : {}),
      });
      return;
    }
    if (message.type === 'prompts') {
      this.set({ prompts: message.prompts });
      return;
    }
    if (message.type === 'promptsSaved') {
      this.set({ promptsSave: { busy: false, ok: message.ok, ...(message.error ? { error: message.error } : {}), at: Date.now() } });
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
      } else this.set({ spawn: { busy: false, error: message.error ?? 'the session did not start' } });
      return;
    }
    if (message.type === 'crews') {
      this.set({ crews: message.crews });
      // The thread on screen follows: a step of its team moved.
      if (this.state.crewThread) this.send({ type: 'crewThread', crewId: this.state.crewThread.crewId });
      return;
    }
    if (message.type === 'crewTemplates') {
      this.set({ templates: message.templates });
      return;
    }
    if (message.type === 'crewEdited') {
      this.set({ crewEdit: { action: message.action, busy: false, ok: message.ok, ...(message.error ? { error: message.error } : {}), at: Date.now() } });
      return;
    }
    if (message.type === 'crewThread') {
      if (this.state.crewThread?.crewId === message.crewId) this.set({ crewThread: { crewId: message.crewId, requests: message.requests } });
      return;
    }
    if (message.type === 'crewRequested') {
      this.set({ crewRequest: { crewId: message.crewId, busy: false, ...(message.ok ? { n: message.n } : { error: message.error ?? 'the request did not go' }) } });
      return;
    }
    if (message.type === 'crewCreated') {
      if (message.ok && message.crewId) {
        this.set({ crewSpawn: { busy: false, createdId: message.crewId, ...(message.error ? { error: message.error } : {}) } });
        this.openWhenThere(...panesToOpen(message.agentIds ?? []));
      } else this.set({ crewSpawn: { busy: false, error: message.error ?? 'the team did not start' } });
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
        extra.claudeUpdate = message.claudeUpdate;
        extra.prompts = message.prompts ?? [];
        extra.crews = message.crews ?? [];
        extra.templates = message.templates ?? [];
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
    if (this.pendingOpen.some((id) => agents.has(id))) {
      const waiting = this.pendingOpen;
      this.pendingOpen = [];
      this.openWhenThere(...waiting);
    }
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
    this.set({ panes: closePane(this.state.panes, id), ...(this.state.selection?.agentId === id ? { selection: undefined, selectionSend: undefined } : {}) });
  }

  /** A command of a box. /clear goes only with confirmed: the box asked first. */
  command(agentId: string, kind: 'btw' | 'compact' | 'clear', arg?: string, confirmed = false): void {
    this.send({ type: 'command', agentId, kind, arg, confirmed });
  }

  cancelCommand(agentId: string, commandId: string): void {
    this.send({ type: 'cancel', agentId, commandId });
  }

  private pendingOpen: string[] = [];

  /** Opens the panes of sessions as soon as the daemon has told about them, in this order. */
  private openWhenThere(...agentIds: string[]): void {
    for (const id of agentIds) {
      if (this.state.agents.has(id)) this.open(id);
      else if (!this.pendingOpen.includes(id)) this.pendingOpen.push(id);
    }
  }

  requestPanel(which: 'new' | 'prompts'): void {
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

  /** A new team of agents: the daemon checks it, starts its sessions and keeps it. */
  createCrew(spec: CrewSpec): void {
    this.set({ crewSpawn: { busy: true } });
    this.send({ type: 'createCrew', spec });
  }

  endCrewSpawn(): void {
    if (this.state.crewSpawn) this.set({ crewSpawn: undefined });
  }

  /** A change of a team: a member added, taken away, or its → / ⇄. */
  editCrew(crewId: string, change: { action: 'add'; member: CrewMemberSpec } | { action: 'remove'; name: string } | { action: 'talk'; name: string; talk: Talk }): void {
    this.set({ crewEdit: { action: change.action, busy: true, at: Date.now() } });
    this.send({ type: 'editCrew', crewId, ...change });
  }

  /** Saves a template: what the panel of a new team holds, or an existing team. */
  saveTemplate(source: { template: Omit<CrewTemplate, 'builtin'> } | { crewId: string }): void {
    this.set({ crewEdit: { action: 'saveCrewTemplate', busy: true, at: Date.now() } });
    this.send({ type: 'saveCrewTemplate', ...source });
  }

  deleteTemplate(name: string): void {
    this.send({ type: 'deleteCrewTemplate', name });
  }

  /** Shows the thread of a team: the daemon sends it whole, then again at every change of the team. */
  showThread(crewId: string): void {
    if (this.state.crewThread?.crewId !== crewId) this.set({ crewThread: { crewId } });
    this.send({ type: 'crewThread', crewId });
  }

  closeThread(): void {
    if (this.state.crewThread) this.set({ crewThread: undefined });
  }

  /** A request from you to some recipients of a team; none means all its members. */
  sendCrewRequest(crewId: string, to: string[], text: string): void {
    this.set({ crewRequest: { crewId, busy: true } });
    this.send({ type: 'crewRequest', crewId, to, text });
  }

  /** Name, group and role of a session; undefined takes them away. */
  setTeam(agentId: string, team: { label: string; group: string; role: string; lead: boolean } | undefined): void {
    this.send({ type: 'team', agentId, team: team ?? null });
  }

  private pendingSelection: (SelectionPlace & { agentId: string; at: number }) | undefined;

  /** A drag started in a pane: the daemon notes where tmux stands, and an open menu of a selection goes away. */
  selectionStart(agentId: string): void {
    this.pendingSelection = undefined;
    if (this.state.selection) this.closeSelection();
    this.send({ type: 'selection', agentId, phase: 'start' });
  }

  /** The drag ended here: the daemon reads what tmux copied, and the menu opens where the mouse was let go. */
  selectionEnd(agentId: string, place: SelectionPlace): void {
    this.pendingSelection = { ...place, agentId, at: Date.now() };
    this.send({ type: 'selection', agentId, phase: 'end' });
  }

  /** The menu of a selection, for text selected by tmux or by the terminal of the page (Option-drag). */
  showSelection(agentId: string, text: string, place: SelectionPlace): void {
    const clean = cleanSelection(text);
    if (!clean) return;
    this.set({ selection: { ...place, agentId, text: clean, at: Date.now() }, selectionSend: undefined });
  }

  closeSelection(): void {
    if (this.state.selection || this.state.selectionSend) this.set({ selection: undefined, selectionSend: undefined });
  }

  /** A question from the menu of a selection: to its own session (fromSelection), or to another one. */
  askAbout(agentId: string, text: string, fromSelection: boolean): void {
    this.set({ selectionSend: { action: 'ask', busy: true } });
    this.send({ type: 'ask', agentId, text, fromSelection });
  }

  /** /btw from the menu of a selection, in its own session: the box shows how it goes, the menu closes. */
  btwAbout(agentId: string, question: string): void {
    this.send({ type: 'command', agentId, kind: 'btw', arg: question, fromSelection: true });
    this.closeSelection();
  }

  /** Text into the prompt of a session, not sent. */
  insertText(agentId: string, text: string): void {
    this.set({ selectionSend: { action: 'insert', busy: true } });
    this.send({ type: 'insert', agentId, text });
  }

  savePrompts(prompts: readonly QuickPrompt[]): void {
    this.set({ promptsSave: { busy: true, at: Date.now() } });
    this.send({ type: 'savePrompts', prompts });
  }

  /** `claude update` from the top line: it shows as running at once, the daemon says how it went. */
  updateClaude(): void {
    if (this.state.claudeUpdate?.run?.state === 'running') return;
    this.set({ claudeUpdate: { ...this.state.claudeUpdate, run: { state: 'running', at: Date.now() } } });
    this.send({ type: 'claudeUpdate', action: 'run' });
  }

  /** Hides the line of the last `claude update`. */
  dismissClaudeUpdate(): void {
    this.send({ type: 'claudeUpdate', action: 'dismiss' });
  }

  /** A pane scrolled back in tmux (copy mode) back to the end: the keys go to Claude Code again. */
  scrollEnd(agentId: string): void {
    this.send({ type: 'scrollEnd', agentId });
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
