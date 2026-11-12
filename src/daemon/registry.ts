import { randomUUID } from 'node:crypto';
import { tmuxSessionName, type PaneInfo } from '../shared/tmux.ts';
import type { ArricurdaiSession } from './arricurdai.ts';
import {
  type Agent,
  type AgentsEntry,
  applyHook,
  applyStatus,
  type HookPayload,
  markEnded,
  newAgent,
  stateFromStatus,
} from './state.ts';
import { forgetEndedSubagents } from './subagents.ts';

// The agents the daemon knows, and where each event belongs. An agent is one Claude Code process: it is found
// by the Forchetta id that `forchetta run` gave it, by session id, or by pid, in that order.

/** What the SessionStart hook adds to the hook input. */
export interface HookMeta {
  pid?: number;
  pane?: string;
  agentId?: string;
}

export interface RegistryOptions {
  now?: () => number;
  /** Called after any change, with the agent that changed. */
  onChange?: (agent: Agent) => void;
  /** An event came from a session with no known pid: `claude agents --json` can tell it. */
  onUnknownPid?: () => void;
  /** Agents forgotten after their retention time. */
  onRemove?: (ids: string[]) => void;
  /** How long a new session stays in "avvio" after its SessionStart. */
  settleMs?: number;
}

/** How long the hooks of a session must be quiet before `claude agents --json` may correct its state. */
export const QUIET_MS = 20_000;
const SWITCH_WINDOW_MS = 30_000;

export class Registry {
  readonly agents = new Map<string, Agent>();
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly options: RegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.settleMs = options.settleMs ?? 2000;
  }

  list(): Agent[] {
    return [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  private changed(agent: Agent): void {
    this.options.onChange?.(agent);
  }

  private live(): Agent[] {
    return [...this.agents.values()].filter((agent) => agent.state !== 'ended');
  }

  /** `forchetta run` announces a session before Claude starts, so that its box shows up at once. */
  register(input: { id: string; cwd: string; tmuxSession: string }): Agent {
    const existing = this.agents.get(input.id);
    if (existing) return existing;
    const agent = newAgent({ id: input.id, cwd: input.cwd, control: { kind: 'tmux', session: input.tmuxSession } }, this.now());
    this.agents.set(agent.id, agent);
    this.changed(agent);
    return agent;
  }

  private find(payload: HookPayload, meta: HookMeta): Agent | undefined {
    if (meta.agentId) {
      const byId = this.agents.get(meta.agentId);
      if (byId) return byId;
    }
    const session = payload.session_id;
    if (session) {
      const live = this.live();
      const bySession =
        live.find((agent) => agent.sessionId === session) ??
        live.find((agent) => agent.pastSessionIds.includes(session)) ??
        [...this.agents.values()].find((agent) => agent.sessionId === session);
      if (bySession) return bySession;
    }
    if (meta.pid) {
      const byPid = this.live().find((agent) => agent.pid === meta.pid);
      if (byPid) return byPid;
    }
    if (payload.hook_event_name === 'SessionStart' && (payload.source === 'clear' || payload.source === 'resume')) {
      // The SessionStart that follows a /clear, when the hook could not say its pid.
      const now = this.now();
      return this.live()
        .filter((agent) => agent.pendingSwitchAt !== undefined && now - agent.pendingSwitchAt < SWITCH_WINDOW_MS && (!payload.cwd || agent.cwd === payload.cwd))
        .sort((a, b) => (b.pendingSwitchAt ?? 0) - (a.pendingSwitchAt ?? 0))[0];
    }
    return undefined;
  }

  /** Applies a hook event, creating the agent when it is the first event of a session. */
  hook(payload: HookPayload, meta: HookMeta = {}): Agent {
    const now = this.now();
    let agent = this.find(payload, meta);
    // A new process that resumes a session whose process ended: a new box.
    if (agent && agent.state === 'ended' && payload.hook_event_name === 'SessionStart') agent = undefined;
    if (!agent) {
      const id = meta.agentId ?? randomUUID();
      agent = newAgent(
        {
          id,
          cwd: payload.cwd,
          // An agent of `forchetta run` that the daemon did not hear about: its tmux session has a known name.
          control: meta.agentId ? { kind: 'tmux', session: tmuxSessionName(meta.agentId) } : { kind: 'readonly', reason: 'fuori-tmux' },
          state: payload.hook_event_name === 'SessionStart' ? 'starting' : 'idle',
          sessionId: payload.session_id || undefined,
        },
        now,
      );
      this.agents.set(id, agent);
    }
    if (meta.pid && (!agent.pid || meta.agentId)) agent.pid = meta.pid;
    if (meta.pane && agent.control.kind === 'tmux') agent.control.paneId = meta.pane;
    applyHook(agent, payload, now);
    if (!agent.pid) this.options.onUnknownPid?.();
    if (agent.state === 'starting') this.settleLater(agent);
    this.changed(agent);
    return agent;
  }

  /** A session that started and sent nothing more is ready for input: "avvio" becomes "inattiva". */
  private settleLater(agent: Agent): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (agent.state === 'starting' && agent.sessionId && this.agents.get(agent.id) === agent) {
        agent.state = 'idle';
        this.changed(agent);
      }
    }, this.settleMs);
    timer.unref();
    this.timers.add(timer);
  }

  /**
   * Merges what `claude agents --json` and the private tmux server report: finds sessions that sent no hook,
   * fills in pids and panes, corrects states the hooks left stale, and ends processes that are gone.
   */
  reconcile(entries: readonly AgentsEntry[], panes: readonly PaneInfo[], alive: (pid: number) => boolean): boolean {
    const now = this.now();
    const touched = new Set<Agent>();

    for (const agent of this.live()) {
      if (agent.control.kind !== 'tmux') continue;
      const session = agent.control.session;
      const pane = panes.find((candidate) => candidate.session === session);
      if (!pane) continue;
      if (agent.control.paneId !== pane.paneId) {
        agent.control.paneId = pane.paneId;
        touched.add(agent);
      }
      if (!agent.pid) {
        agent.pid = pane.panePid;
        touched.add(agent);
      }
    }

    for (const entry of entries) {
      if (!entry.sessionId && !entry.pid) continue;
      const live = this.live();
      let agent =
        (entry.sessionId ? live.find((candidate) => candidate.sessionId === entry.sessionId) : undefined) ??
        (entry.pid ? live.find((candidate) => candidate.pid === entry.pid) : undefined);
      if (!agent) {
        const pane = entry.pid ? panes.find((candidate) => candidate.panePid === entry.pid) : undefined;
        agent = newAgent(
          {
            id: randomUUID(),
            pid: entry.pid,
            sessionId: entry.sessionId,
            cwd: entry.cwd,
            name: entry.name,
            kind: entry.kind === 'background' ? 'background' : 'interactive',
            control: pane
              ? { kind: 'tmux', session: pane.session, paneId: pane.paneId }
              : { kind: 'readonly', reason: entry.kind === 'background' ? 'background' : 'fuori-tmux' },
            state: stateFromStatus(entry.status),
          },
          now,
        );
        agent.lastEvent = { name: 'rilevata', at: now };
        if (agent.state === 'waiting') agent.waiting = { kind: 'dialogo', detail: entry.waitingFor, since: now, fromAgentView: true };
        this.agents.set(agent.id, agent);
        touched.add(agent);
        continue;
      }
      if (entry.pid && !agent.pid) {
        agent.pid = entry.pid;
        touched.add(agent);
      }
      if (entry.sessionId && agent.sessionId !== entry.sessionId && entry.pid !== undefined && agent.pid === entry.pid) {
        // A /clear the hooks did not report.
        if (agent.sessionId) agent.pastSessionIds.push(agent.sessionId);
        agent.sessionId = entry.sessionId;
        forgetEndedSubagents(agent);
        touched.add(agent);
      }
      if (!agent.name && entry.name) agent.name = entry.name;
      if (!agent.kind && entry.kind) agent.kind = entry.kind === 'background' ? 'background' : 'interactive';
      if (applyStatus(agent, entry, now, QUIET_MS)) touched.add(agent);
    }

    for (const agent of this.live()) {
      if (agent.pid && !alive(agent.pid)) {
        markEnded(agent, 'process ended', now);
        touched.add(agent);
      } else if (!agent.pid && agent.control.kind === 'tmux' && now - agent.createdAt > 30_000) {
        const session = agent.control.session;
        if (!panes.some((pane) => pane.session === session)) {
          markEnded(agent, 'never started', now);
          touched.add(agent);
        }
      }
    }

    for (const agent of touched) this.changed(agent);
    return touched.size > 0;
  }

  /**
   * Context and cache from `arricurdai status`, matched by session id. A session it does not list keeps what it
   * had: arricurdAI lists only the sessions of the last 24 hours.
   */
  applyArricurdai(sessions: ReadonlyMap<string, ArricurdaiSession>, windowOf: (model: string | undefined) => number): Agent[] {
    const now = this.now();
    const changed: Agent[] = [];
    for (const agent of this.agents.values()) {
      const entry = agent.sessionId ? sessions.get(agent.sessionId) : undefined;
      if (!entry) continue;
      // The model of the last call, as arricurdAI read it: /model can change it during a session.
      const model = entry.model ?? agent.model;
      const window = windowOf(model);
      const context = { tokens: entry.context, window, percent: Math.min(100, Math.round((entry.context / window) * 100)), lastCallAt: entry.lastCallAt, at: now };
      const cache = { expiresAt: entry.cacheExpiresAt, live: entry.cacheLive, guardWillStop: entry.guardWillStop };
      const same =
        agent.context?.tokens === context.tokens &&
        agent.context.window === context.window &&
        agent.context.lastCallAt === context.lastCallAt &&
        JSON.stringify(agent.cache) === JSON.stringify(cache) &&
        JSON.stringify(agent.today) === JSON.stringify(entry.today);
      if (entry.model) agent.model = entry.model;
      if (same) continue;
      agent.context = context;
      agent.cache = cache;
      agent.today = entry.today;
      changed.push(agent);
      this.changed(agent);
    }
    return changed;
  }

  /** The cost of a session, from its status line. A session it does not know stays unknown. */
  usage(sessionId: string, meta: HookMeta, usd: number): Agent | undefined {
    const live = this.live();
    const agent =
      (meta.agentId ? live.find((candidate) => candidate.id === meta.agentId) : undefined) ??
      live.find((candidate) => candidate.sessionId === sessionId) ??
      (meta.pid ? live.find((candidate) => candidate.pid === meta.pid) : undefined);
    if (!agent) return undefined;
    if (agent.usage?.usd === usd) return agent;
    agent.usage = { usd, at: this.now() };
    this.changed(agent);
    return agent;
  }

  /** Something outside the hooks changed an agent (its commands): save it and tell the windows. */
  touch(agent: Agent): void {
    this.changed(agent);
  }

  /** The one-line summary of the optional Haiku model; the next event replaces it with its own. */
  setModelSummary(agentId: string, text: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.state === 'ended') return;
    agent.summary = { text, source: 'haiku', at: this.now() };
    this.changed(agent);
  }

  /** Ends the agents whose process is gone. Cheap: one signal 0 for each pid. */
  checkAlive(alive: (pid: number) => boolean): boolean {
    const now = this.now();
    let any = false;
    for (const agent of this.live()) {
      if (agent.pid && !alive(agent.pid)) {
        markEnded(agent, 'process ended', now);
        this.changed(agent);
        any = true;
      }
    }
    return any;
  }

  /** Agents of `forchetta run` that still have no pid: their tmux session tells whether Claude started. */
  waitingForPid(): Agent[] {
    return this.live().filter((agent) => !agent.pid && agent.control.kind === 'tmux');
  }

  /** Forgets the agents that ended more than `retentionMs` ago, and returns their ids. */
  sweep(retentionMs: number): string[] {
    const now = this.now();
    const removed: string[] = [];
    for (const [id, agent] of this.agents) {
      if (agent.state === 'ended' && agent.endedAt !== undefined && now - agent.endedAt > retentionMs) {
        this.agents.delete(id);
        removed.push(id);
      }
    }
    if (removed.length > 0) this.options.onRemove?.(removed);
    return removed;
  }

  /** True when some session works: context and cache change at every call. */
  isBusy(): boolean {
    return this.live().some((agent) => agent.state === 'working' || agent.state === 'compacting');
  }

  /** True when some agent seems busy but its hooks have been quiet: the moment to ask `claude agents`. */
  hasQuietActivity(): boolean {
    const now = this.now();
    return this.live().some(
      (agent) => (agent.state === 'working' || agent.state === 'waiting' || agent.state === 'starting' || agent.state === 'compacting') && now - agent.lastEvent.at >= QUIET_MS,
    );
  }

  restore(agents: readonly Agent[]): void {
    for (const agent of agents) {
      if (!agent || typeof agent.id !== 'string' || agent.state === 'ended') continue;
      // The hooks that waited on the old daemon are gone with it: their dialogs are answered in the terminal.
      agent.permission = undefined;
      // The writes behind them were not saved: they come back with the next ones.
      agent.conflicts = undefined;
      // Seen again within a second, if its pane is open and still scrolled back.
      agent.scrolledBack = undefined;
      this.agents.set(agent.id, agent);
    }
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
