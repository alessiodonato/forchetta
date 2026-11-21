import type { Agent, ClaudeUpdateInfo, FileChange, RecallMatch, SessionColor, SubagentStep, TodayInfo, UsageLimits } from '../shared/agent.ts';
import { resultAt } from '../shared/present.ts';
import { subagentActive, subagentKey } from '../shared/present.ts';
import type { ClientMessage, ServerMessage, UiSettings } from '../daemon/hub.ts';
import type { AutomationView } from '../shared/automation.ts';
import type { LostSession } from '../shared/reopen.ts';
import type { CrewMemberSpec, CrewRequest, CrewSpec, CrewSummary, CrewTemplate, Delivered, ReviewRecord, RolePreset, Talk } from '../shared/crew.ts';
import type { ReplayData } from '../shared/replay.ts';
import type { GuardStatsInfo } from '../shared/guard-stats.ts';
import type { QuickPrompt } from '../shared/prompts.ts';
import { cleanSelection } from '../shared/selection.ts';
import { setCustomSkills, type SkillInfo } from '../shared/skills.ts';
import type { EditableSettings, SystemInfo } from '../shared/system.ts';
import { teamFileName, teamFileOf } from '../shared/team-file.ts';
import { shell } from './connection.ts';
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
  /** The limits of the Claude plan, from the status line of any session. */
  limits?: UsageLimits;
  /** What the guard did in the last days (daemon/guard-stats.ts). */
  guardStats?: GuardStatsInfo;
  /** A failed automatic update of Claude Code, and the `claude update` started from the top line. */
  claudeUpdate?: ClaudeUpdateInfo;
  /** The panel of the changes of a session: list undefined while the daemon reads them. */
  files?: { agentId: string; list?: FileChange[] };
  /** The panel of the subagents of a session: the one chosen, and its transcript once the daemon read it. */
  subagents?: { agentId: string; key?: string; thread?: SubagentThreadView };
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
  /** The teams that start by themselves (shared/automation.ts): their queues, runs, why the next one waits. */
  automations: readonly AutomationView[];
  /** The sessions that ended with the Mac, to reopen; undefined with a daemon that cannot (the demo, an older one). */
  reopen?: readonly LostSession[];
  /** Reopening sessions: under way, then which reopened and why the others did not. */
  reopening?: { busy: boolean; agentIds: string[]; reopened?: { agentId: string; newAgentId: string; name: string }[]; failed?: { agentId: string; name: string; error: string }[]; at: number };
  /** The last change of an automation asked from its panel, and how it went. */
  autoEdit?: { action: string; busy: boolean; ok?: boolean; error?: string; id?: string; added?: number; at: number };
  /** A team being started from its panel; when it started, its id; what did not start, if anything. */
  crewSpawn?: { busy: boolean; error?: string; createdId?: string };
  /** The templates of teams: the ones of Forchetta, then yours. */
  templates: readonly CrewTemplate[];
  /** The presets of agents of the studio: the ones of Forchetta (or your version of them), then yours. */
  roles: readonly RolePreset[];
  /** The skills you added (shared/skills.ts keeps them too, for the checks of the page). */
  customSkills: readonly SkillInfo[];
  /** A running team in full, as the studio asked for it (requestCrewTemplate). */
  liveTeam?: { crewId: string; template?: CrewTemplate; cwd?: string; at: number };
  /** A team saved as a file, or opened from one: under way, or how it went. */
  teamFile?: {
    action: 'save' | 'import';
    busy: boolean;
    ok?: boolean;
    error?: string;
    path?: string;
    template?: CrewTemplate;
    notes?: string[];
    /** The skills of GitHub the team brings, waiting for you to say whether to fetch them (answerImport). */
    ask?: { id: string; repo: string; path: string; commit: string }[];
    at: number;
  };
  /** Adding or taking away a skill of yours: under way, or how it went. */
  skillEdit?: { action: 'add' | 'remove'; busy: boolean; ok?: boolean; error?: string; id?: string; at: number };
  /** The last change of a team or of the templates asked from a panel, and how it went. */
  crewEdit?: { action: string; busy: boolean; ok?: boolean; error?: string; at: number };
  /** The whole thread of the team the panel shows: asked again each time the teams change. */
  crewThread?: { crewId: string; requests?: CrewRequest[]; reviews?: ReviewRecord[]; delivered?: Delivered[] };
  /** The run of a team, for the replay of the studio (requestReplay). */
  crewReplay?: { crewId: string; replay?: ReplayData; at: number };
  /** A team drawn from a description (describeTeam): under way, or its template, or why there is none. */
  describe?: { busy: boolean; ok?: boolean; error?: string; template?: CrewTemplate; usd?: number; note?: string; at: number };
  /** The last request sent from the panel of a team: its number once it is in the queues, or why not. */
  crewRequest?: { crewId: string; busy: boolean; n?: number; error?: string };
  /** The installation, from the daemon: checks, optional features, settings (shared/system.ts). */
  system?: SystemInfo;
  /** Saving the settings from their panel: under way, or how it went (and what waits for a restart). */
  settingsSave?: { busy: boolean; ok?: boolean; error?: string; restart?: string[]; at: number };
}

/**
 * Where a drag ended in a pane: the point where the mouse was let go (x), the band of lines it went over (top and
 * bottom), and the size of the pane. The menu of the selection opens there, without covering the selection.
 */
export interface SelectionPlace {
  x: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SelectionMenuState extends SelectionPlace {
  agentId: string;
  /** Cleaned of what Claude Code draws around its text (shared/selection.ts). */
  text: string;
  at: number;
}

/** The transcript of a subagent as the daemon sent it. */
export interface SubagentThreadView {
  key: string;
  steps: SubagentStep[];
  model?: string;
  skipped?: number;
  note?: string;
}

/** The subagent a panel opens on: the last one started that is still at work or waiting, else the last one started. */
export function defaultSubagent(agent: Agent | undefined): string | undefined {
  const list = agent?.subagents ?? [];
  const pick = [...list].reverse().find(subagentActive) ?? list.at(-1);
  return pick ? subagentKey(pick) : undefined;
}

/** At most 4 panes: the lead and the first members of a new team open, the lead last, in the large pane. */
export const panesToOpen = (agentIds: readonly string[]): string[] => agentIds.slice(0, 4).reverse();

const SEEN_KEY = 'forchetta.seen';

/** The results you saw, by session: when the turn or the error you looked at happened. Undefined: never kept yet. */
function loadSeen(): Record<string, number> | undefined {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return undefined;
  }
}

/** A session whose terminal can be shown: run in the tmux of Forchetta, and not ended. */
export const canOpen = (agent: Agent | undefined): boolean => agent !== undefined && agent.control.kind === 'tmux' && agent.state !== 'ended';

/** The actions of the page that wait for an answer of the daemon, each with its busy flag. */
const BUSY_KEYS = ['recall', 'selectionSend', 'promptsSave', 'spawn', 'crewSpawn', 'crewEdit', 'skillEdit', 'teamFile', 'crewRequest', 'settingsSave', 'describe', 'autoEdit', 'reopening'] as const satisfies readonly (keyof UiState)[];

/** What an action says when the daemon was not there to take it. */
export const NOT_SENT = 'not sent: the daemon of Forchetta is not connected (the page reconnects by itself; try again in a moment)';

export class Store {
  state: UiState = { agents: new Map(), connected: false, ready: false, visible: true, panes: emptyPanes(), settings: { replace: 'lru', arricurdaiNotes: false }, crews: [], automations: [], templates: [], roles: [], customSkills: [], prompts: [] };
  /** Sends a message to the daemon (set by the connection). */
  /** Sends a message to the daemon (connection.ts); false when it could not go. */
  send: (message: ClientMessage) => boolean = () => false;
  /** A notification asked by the daemon (see attention.ts). */
  onNotify: (message: Extract<ServerMessage, { type: 'notify' }>) => void = () => {};
  /** Agents that arrived after the first list: their box enters with an animation, once. */
  readonly entering = new Set<string>();
  /**
   * The results you saw, by session (localStorage, for this window only). A session whose turn ended or that stopped on
   * an error after it shows a dot until you click its box or open its pane; with its pane open you see it come.
   */
  private seen = loadSeen();
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
    if (message.type === 'guardStats') {
      this.set({ guardStats: message.stats });
      return;
    }
    if (message.type === 'limits') {
      this.set({ limits: message.limits });
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
    if (message.type === 'system') {
      this.set({ system: message.system });
      return;
    }
    if (message.type === 'settingsSaved') {
      // The app reads the shortcut again from the configuration.
      if (message.ok) shell()?.postMessage({ type: 'settingsSaved' });
      this.set({ settingsSave: { busy: false, ok: message.ok, ...(message.error ? { error: message.error } : {}), ...(message.restart?.length ? { restart: message.restart } : {}), at: Date.now() } });
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
    if (message.type === 'reopenList') {
      this.set({ reopen: message.sessions });
      return;
    }
    if (message.type === 'reopened') {
      this.set({ reopening: { busy: false, agentIds: this.state.reopening?.agentIds ?? [], reopened: message.reopened, failed: message.failed, at: Date.now() } });
      return;
    }
    if (message.type === 'automations') {
      this.set({ automations: message.automations });
      return;
    }
    if (message.type === 'autoEdited') {
      this.set({ autoEdit: { action: message.action, busy: false, ok: message.ok, ...(message.error ? { error: message.error } : {}), ...(message.id ? { id: message.id } : {}), ...(message.added !== undefined ? { added: message.added } : {}), at: Date.now() } });
      return;
    }
    if (message.type === 'crews') {
      this.set({ crews: message.crews });
      // The thread on screen follows: a step of its team moved.
      if (this.state.crewThread) this.send({ type: 'crewThread', crewId: this.state.crewThread.crewId });
      return;
    }
    if (message.type === 'crewRoles') {
      this.set({ roles: message.roles });
      return;
    }
    if (message.type === 'customSkills') {
      setCustomSkills(message.skills);
      this.set({ customSkills: message.skills });
      return;
    }
    if (message.type === 'crewTemplate') {
      this.set({ liveTeam: { crewId: message.crewId, ...(message.template ? { template: message.template, cwd: message.cwd } : {}), at: Date.now() } });
      return;
    }
    if (message.type === 'teamFile') {
      this.set({
        teamFile: {
          action: message.action,
          busy: false,
          ok: message.ok,
          ...(message.error ? { error: message.error } : {}),
          ...(message.path ? { path: message.path } : {}),
          ...(message.template ? { template: message.template } : {}),
          ...(message.notes ? { notes: message.notes } : {}),
          ...(message.ask ? { ask: message.ask } : {}),
          at: Date.now(),
        },
      });
      if (!message.ask) this.importing = undefined;
      return;
    }
    if (message.type === 'skillEdited') {
      this.set({ skillEdit: { action: message.action, busy: false, ok: message.ok, ...(message.error ? { error: message.error } : {}), ...(message.id ? { id: message.id } : {}), at: Date.now() } });
      return;
    }
    if (message.type === 'folderChosen') {
      // As the panel of the app does: the field of the panel that asked takes it.
      window.forchettaFolder?.(message.path);
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
      if (this.state.crewThread?.crewId === message.crewId) {
        this.set({ crewThread: { crewId: message.crewId, requests: message.requests, ...(message.reviews ? { reviews: message.reviews } : {}), ...(message.delivered ? { delivered: message.delivered } : {}) } });
      }
      return;
    }
    if (message.type === 'crewReplay') {
      this.set({ crewReplay: { crewId: message.crewId, ...(message.replay ? { replay: message.replay } : {}), at: Date.now() } });
      return;
    }
    if (message.type === 'teamDescribed') {
      this.set({
        describe: { busy: false, ok: message.ok, ...(message.template ? { template: message.template } : {}), ...(message.error ? { error: message.error } : {}), ...(message.usd ? { usd: message.usd } : {}), ...(message.note ? { note: message.note } : {}), at: Date.now() },
      });
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
        // Its first goal, from the studio: to the lead, or to every member when you lead. It waits in their queues.
        const goal = this.goal;
        this.goal = undefined;
        if (goal) this.sendCrewRequest(message.crewId, goal.to, goal.text);
      } else this.set({ crewSpawn: { busy: false, error: message.error ?? 'the team did not start' } });
      return;
    }
    if (message.type === 'files') {
      if (this.state.files?.agentId === message.agentId) this.set({ files: { agentId: message.agentId, list: message.files } });
      return;
    }
    if (message.type === 'subagent') {
      const reading = `${message.agentId} ${message.key}`;
      const again = this.readAgain.has(reading);
      this.reading.delete(reading);
      this.readAgain.delete(reading);
      const panel = this.state.subagents;
      if (panel?.agentId !== message.agentId || panel.key !== message.key) return;
      const { key, steps, model, skipped, note } = message;
      this.set({ subagents: { ...panel, thread: { key, steps, model, skipped, note } } });
      // It moved while it was read: once more.
      if (again) this.readSubagent(message.agentId, message.key);
      return;
    }
    const agents = new Map(this.state.agents);
    const extra: Partial<UiState> = {};
    switch (message.type) {
      case 'hello':
        // A new connection: the reads asked on the old one get no answer.
        this.reading.clear();
        this.readAgain.clear();
        agents.clear();
        for (const agent of message.agents) agents.set(agent.id, agent);
        extra.settings = message.settings;
        extra.today = message.today;
        extra.limits = message.limits;
        extra.guardStats = message.guardStats;
        extra.claudeUpdate = message.claudeUpdate;
        extra.system = message.system;
        extra.prompts = message.prompts ?? [];
        extra.crews = message.crews ?? [];
        extra.automations = message.automations ?? [];
        extra.reopen = message.reopen;
        extra.templates = message.templates ?? [];
        extra.roles = message.roles ?? [];
        setCustomSkills(message.skills ?? []);
        extra.customSkills = message.skills ?? [];
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
    this.noteSeen(agents, message.type === 'hello', extra.panes.open);
    this.set({ ...extra, agents, ready: true });
    if (this.pendingOpen.some((id) => agents.has(id))) {
      const waiting = this.pendingOpen;
      this.pendingOpen = [];
      this.openWhenThere(...waiting);
    }
  }

  setConnected(connected: boolean): void {
    if (connected !== this.state.connected) this.set({ connected });
    // An answer that was coming will not: whatever waited for it says so.
    if (!connected) this.dropBusy();
  }

  /** A message did not go (the daemon is not connected): what set itself busy for it is told, once it has. */
  notSent(): void {
    queueMicrotask(() => this.dropBusy());
  }

  /** Every action that waits for an answer of the daemon, now told that none will come. */
  private dropBusy(): void {
    const patch: Record<string, unknown> = {};
    for (const key of BUSY_KEYS) {
      const value = this.state[key] as { busy?: boolean; at?: number } | undefined;
      if (!value?.busy) continue;
      patch[key] = { ...value, busy: false, ok: false, error: NOT_SENT, ...(value.at !== undefined ? { at: Date.now() } : {}) };
    }
    if (Object.keys(patch).length > 0) this.set(patch as Partial<UiState>);
  }

  setVisible(visible: boolean): void {
    if (visible !== this.state.visible) this.set({ visible });
  }

  /** Whether a session has a result you have not seen: a turn that ended, or an error, since you last looked. */
  unseen(agent: Agent): boolean {
    const at = resultAt(agent);
    return at !== undefined && this.seen !== undefined && at > (this.seen[agent.id] ?? 0);
  }

  /** You looked at a session: a click on its box. */
  markSeen(id: string): void {
    const agent = this.state.agents.get(id);
    const at = agent ? resultAt(agent) : undefined;
    if (at === undefined || !this.seen || (this.seen[id] ?? 0) >= at) return;
    this.seen = { ...this.seen, [id]: at };
    this.saveSeen();
    this.set({});
  }

  /**
   * The first time ever, every result there is counts as seen: nothing new to look at yet. Then the results of the
   * open panes are seen as they come, and the sessions that went away are forgotten.
   */
  private noteSeen(agents: ReadonlyMap<string, Agent>, hello: boolean, open: readonly string[]): void {
    let next = this.seen;
    if (next === undefined) {
      if (!hello) return;
      next = {};
      for (const agent of agents.values()) {
        const at = resultAt(agent);
        if (at !== undefined) next[agent.id] = at;
      }
    }
    let changed = next !== this.seen;
    for (const id of open) {
      const agent = agents.get(id);
      const at = agent ? resultAt(agent) : undefined;
      if (at !== undefined && this.state.visible && (next[id] ?? 0) < at) {
        next = { ...next, [id]: at };
        changed = true;
      }
    }
    for (const id of Object.keys(next)) {
      if (!agents.has(id)) {
        const { [id]: _gone, ...rest } = next;
        next = rest;
        changed = true;
      }
    }
    if (!changed) return;
    this.seen = next;
    this.saveSeen();
  }

  private saveSeen(): void {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(this.seen ?? {}));
    } catch {
      // Storage off: the dots last as long as this page.
    }
  }

  /** A click on a box. Sessions outside the tmux of Forchetta, and ended ones, have no terminal to show. */
  open(id: string): void {
    this.markSeen(id);
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
  /** The first goal of the team being created: it goes once the team is there. */
  private goal: { to: string[]; text: string } | undefined;

  createCrew(spec: CrewSpec, goal?: string): void {
    this.goal = goal?.trim() ? { to: spec.lead.kind === 'claude' ? [spec.lead.name] : [], text: goal.trim() } : undefined;
    this.set({ crewSpawn: { busy: true } });
    this.send({ type: 'createCrew', spec });
  }

  /** Your decision on a request that waits for your approval: let it go (with its text changed, if `text`), or send it back with a note. */
  decideRequest(crewId: string, n: number, to: string, approve: boolean, options: { note?: string; text?: string } = {}): void {
    this.set({ crewEdit: { action: 'decide', busy: true, at: Date.now() } });
    this.send({ type: 'crewDecide', crewId, n, to, approve, ...options });
  }

  /** The run of a team, for its replay on the canvas. */
  requestReplay(crewId: string): void {
    this.send({ type: 'crewReplay', crewId });
  }

  /** A team drawn by Claude from a description; the studio opens it when it comes (describe). */
  describeTeam(text: string): void {
    this.set({ describe: { busy: true, at: Date.now() } });
    this.send({ type: 'describeTeam', text });
  }

  endCrewSpawn(): void {
    if (this.state.crewSpawn) this.set({ crewSpawn: undefined });
  }

  /** A change of a team: a member added, taken away, or its → / ⇄. */
  editCrew(
    crewId: string,
    change:
      | { action: 'add'; member: CrewMemberSpec }
      | { action: 'remove'; name: string }
      | { action: 'talk'; name: string; talk: Talk }
      | { action: 'paths'; name: string; paths: string }
      | { action: 'approve'; name: string; approve: boolean },
  ): void {
    this.set({ crewEdit: { action: change.action, busy: true, at: Date.now() } });
    this.send({ type: 'editCrew', crewId, ...change });
  }

  /** Sessions that ended, each on its conversation again: the daemon answers with what reopened. */
  reopen(agentIds: readonly string[]): void {
    if (agentIds.length === 0 || this.state.reopening?.busy) return;
    this.set({ reopening: { busy: true, agentIds: [...agentIds], at: Date.now() } });
    this.send({ type: 'reopen', agentIds: [...agentIds] });
  }

  /** Not now: the sessions ended with the Mac (all, or these) are offered no more. */
  dismissReopen(agentIds?: readonly string[]): void {
    this.send({ type: 'dismissReopen', ...(agentIds ? { agentIds: [...agentIds] } : {}) });
  }

  /** A team that starts by itself, new or changed (id): the daemon checks it and answers with autoEdited. */
  saveAutomation(automation: Record<string, unknown>, id?: string): void {
    this.set({ autoEdit: { action: 'save', busy: true, at: Date.now() } });
    this.send({ type: 'saveAutomation', automation, ...(id ? { id } : {}) });
  }

  deleteAutomation(id: string): void {
    this.set({ autoEdit: { action: 'delete', busy: true, id, at: Date.now() } });
    this.send({ type: 'deleteAutomation', id });
  }

  /** pause, resume, add (items, a run now, GitHub now), cancel an item, stop the run, retry a run. */
  autoAction(id: string, action: 'pause' | 'resume' | 'add' | 'cancel' | 'stop' | 'retry' | 'close', arg: { text?: string; itemId?: string } = {}): void {
    this.set({ autoEdit: { action, busy: true, id, at: Date.now() } });
    this.send({ type: 'autoAction', id, action, ...arg });
  }

  /** Saves a template: what the panel of a new team holds, or an existing team. */
  saveTemplate(source: { template: Omit<CrewTemplate, 'builtin' | 'modified'> } | { crewId: string }): void {
    this.set({ crewEdit: { action: 'saveCrewTemplate', busy: true, at: Date.now() } });
    this.send({ type: 'saveCrewTemplate', ...source });
  }

  deleteTemplate(name: string): void {
    this.send({ type: 'deleteCrewTemplate', name });
  }

  /** Saves a preset of agent of the studio, in place of `previous` when it was renamed. */
  saveRole(preset: Omit<RolePreset, 'builtin' | 'modified'>, previous?: string): void {
    this.set({ crewEdit: { action: 'saveRolePreset', busy: true, at: Date.now() } });
    this.send({ type: 'saveRolePreset', preset, ...(previous !== undefined ? { previous } : {}) });
  }

  /**
   * The panel of macOS for a folder, starting at `folder`: the app's own, or, in a browser, one the daemon opens on
   * this Mac. The choice goes to window.forchettaFolder, the field of the panel open.
   */
  chooseFolder(folder: string): void {
    const app = shell();
    if (app) app.postMessage({ type: 'chooseFolder', folder });
    else this.send({ type: 'chooseFolder', folder });
  }

  /**
   * A team as a file, to give to someone else. The app cannot save a file itself: the daemon puts it in your
   * Downloads. In a browser the page downloads it.
   */
  exportTeam(template: CrewTemplate): void {
    const text = `${JSON.stringify(teamFileOf(template), null, 2)}\n`;
    if (shell()) {
      this.set({ teamFile: { action: 'save', busy: true, at: Date.now() } });
      this.send({ type: 'saveTeamFile', name: template.name, text });
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    link.download = teamFileName(template.name);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    this.set({ teamFile: { action: 'save', busy: false, ok: true, path: `your Downloads, as ${link.download}`, at: Date.now() } });
  }

  /** A running team in full, for the studio (liveTeam). */
  requestCrewTemplate(crewId: string): void {
    this.send({ type: 'crewTemplate', crewId });
  }

  /** The text of the team file being opened, while its skills wait for your answer. */
  private importing: string | undefined;

  /**
   * Opens the text of a team file: the daemon checks it. When it brings skills of GitHub this Mac does not have,
   * nothing is fetched yet: teamFile.ask lists them, and answerImport says what to do.
   */
  importTeam(text: string): void {
    this.importing = text;
    this.set({ teamFile: { action: 'import', busy: true, at: Date.now() } });
    this.send({ type: 'importTeam', text, choice: 'ask' });
  }

  /** The answer about the skills of a team file: fetch them at their commit, open the team without them, or neither. */
  answerImport(choice: 'fetch' | 'skip' | 'cancel'): void {
    const text = this.importing;
    if (choice === 'cancel' || text === undefined) {
      this.importing = undefined;
      this.set({ teamFile: undefined });
      return;
    }
    this.set({ teamFile: { action: 'import', busy: true, at: Date.now() } });
    this.send({ type: 'importTeam', text, choice });
  }

  /** A skill of yours from a link of GitHub or a folder; the daemon fetches it, and says how it went (skillEdit). */
  addSkill(source: string): void {
    this.set({ skillEdit: { action: 'add', busy: true, at: Date.now() } });
    this.send({ type: 'addSkill', source });
  }

  removeSkill(id: string): void {
    this.set({ skillEdit: { action: 'remove', busy: true, at: Date.now() } });
    this.send({ type: 'removeSkill', id });
  }

  /** Deletes a preset of yours; for one of Forchetta you changed, brings back theirs. */
  deleteRole(name: string): void {
    this.send({ type: 'deleteRolePreset', name });
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
  setTeam(agentId: string, team: { label: string; color?: SessionColor; group: string; role: string; lead: boolean } | undefined): void {
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

  /** The settings of the panel Settings: the daemon checks them, saves them and says what waits for a restart. */
  saveSettings(settings: EditableSettings): void {
    this.set({ settingsSave: { busy: true, at: Date.now() } });
    this.send({ type: 'saveSettings', settings });
  }

  /** The checks of the installation again (after `forchetta hooks install` in a terminal, say). */
  refreshSystem(): void {
    this.send({ type: 'system' });
  }

  /** The next session that waits for you, after the one shown last (in the order of the boxes); undefined if none. */
  nextWaiting(): string | undefined {
    const waiting = [...this.state.agents.values()].filter((agent) => agent.state === 'waiting').sort((a, b) => a.createdAt - b.createdAt);
    if (waiting.length === 0) return undefined;
    const current = waiting.findIndex((agent) => agent.id === this.state.panes.active);
    return waiting[(current + 1) % waiting.length]!.id;
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

  /** Lets a session write a file the guard held back for it: another session changes it too, until its turn ends. */
  letThrough(agentId: string, path: string): void {
    this.send({ type: 'letThrough', agentId, path });
  }

  /** Opens the panel of the changes of a session, or reads them again. */
  showFiles(agentId: string): void {
    this.set({ files: { agentId } });
    this.send({ type: 'files', agentId });
  }

  closeFiles(): void {
    if (this.state.files) this.set({ files: undefined });
  }

  /** Opens the panel of the subagents of a session, on one of them or on the one at work. */
  showSubagents(agentId: string, key?: string): void {
    // The panel asks for the transcript of the chosen one as it shows it, and again as it works.
    this.set({ subagents: { agentId, key: key ?? defaultSubagent(this.state.agents.get(agentId)) } });
  }

  selectSubagent(key: string): void {
    const panel = this.state.subagents;
    if (!panel || panel.key === key) return;
    this.set({ subagents: { agentId: panel.agentId, key, thread: undefined } });
  }

  closeSubagents(): void {
    if (this.state.subagents) this.set({ subagents: undefined });
  }

  private readonly reading = new Set<string>();
  private readonly readAgain = new Set<string>();

  /** Asks the daemon for the transcript of a subagent: one request at a time, and one more if it moved meanwhile. */
  readSubagent(agentId: string, key: string): void {
    const reading = `${agentId} ${key}`;
    if (this.reading.has(reading)) {
      this.readAgain.add(reading);
      return;
    }
    this.reading.add(reading);
    this.send({ type: 'subagent', agentId, key });
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
