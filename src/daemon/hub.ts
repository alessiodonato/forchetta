import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import type { Agent, ClaudeUpdateInfo, FileChange, RecallMatch, SubagentStep, TodayInfo, UsageLimits } from '../shared/agent.ts';
import type { AutomationView } from '../shared/automation.ts';
import type { LostSession } from '../shared/reopen.ts';
import type { RestartsInfo } from '../shared/restarts.ts';
import type { GuardStatsInfo } from '../shared/guard-stats.ts';
import type { CrewRequest, CrewSummary, CrewTemplate, Delivered, ReviewRecord, RolePreset } from '../shared/crew.ts';
import type { ReplayData } from '../shared/replay.ts';
import type { QuickPrompt } from '../shared/prompts.ts';
import type { SkillInfo } from '../shared/skills.ts';
import type { SystemInfo } from '../shared/system.ts';

// The WebSocket of the app, on /ws. On connection it sends every agent; then, at most once per tick, the agents
// that changed and the ids of those that went away. The page tells whether its window can be seen, so that the
// daemon reads arricurdAI only while someone looks.
//
// Only the page of the daemon may connect: the Origin must be the daemon itself and the token must match.

export type ServerMessage =
  | { type: 'hello'; now: number; agents: Agent[]; settings: UiSettings; today?: TodayInfo; crews?: CrewSummary[]; templates?: CrewTemplate[]; roles?: RolePreset[]; skills?: SkillInfo[]; claudeUpdate?: ClaudeUpdateInfo; prompts?: QuickPrompt[]; limits?: UsageLimits; guardStats?: GuardStatsInfo; system?: SystemInfo; automations?: AutomationView[]; reopen?: LostSession[]; restarts?: RestartsInfo }
  /** The installation (checks, optional features, settings), when it changed. */
  | { type: 'system'; now: number; system: SystemInfo }
  /** How saving the settings went, for the window that asked; what takes effect only after a restart. */
  | { type: 'settingsSaved'; now: number; ok: boolean; error?: string; restart?: string[] }
  /** What you selected with the mouse in a pane, for the window where you did it. */
  | { type: 'selection'; now: number; agentId: string; text: string }
  /** How a question or a text from the menu of a selection went: queued, put in the prompt, or why not. */
  | { type: 'selectionSent'; now: number; agentId: string; action: 'ask' | 'insert'; ok: boolean; error?: string }
  /** The quick prompts of the menu of a selection, after they were saved. */
  | { type: 'prompts'; now: number; prompts: QuickPrompt[] }
  /** How saving the quick prompts went, for the window that asked. */
  | { type: 'promptsSaved'; now: number; ok: boolean; error?: string }
  /** A failed automatic update of Claude Code, and the `claude update` started from the app. */
  | { type: 'claudeUpdate'; now: number; update: ClaudeUpdateInfo }
  /** The templates of teams, after one was saved or deleted. */
  | { type: 'crewTemplates'; now: number; templates: CrewTemplate[] }
  /** The presets of agents of the studio, after one was saved or deleted. */
  | { type: 'crewRoles'; now: number; roles: RolePreset[] }
  /** A running team in full, for the studio: its template (roles, relations, rules) and its folder. */
  | { type: 'crewTemplate'; now: number; crewId: string; template?: CrewTemplate; cwd?: string }
  /** A team saved as a file (its path), or opened from one (its template, and what changed on the way). */
  | { type: 'teamFile'; now: number; action: 'save' | 'import'; ok: boolean; error?: string; path?: string; template?: CrewTemplate; notes?: string[]; ask?: { id: string; repo: string; path: string; commit: string }[] }
  /** The skills you added, after a change: next to the catalog. */
  | { type: 'customSkills'; now: number; skills: SkillInfo[] }
  /** How adding or taking away a skill of yours went, for the window that asked. */
  | { type: 'skillEdited'; now: number; action: 'add' | 'remove'; ok: boolean; error?: string; id?: string }
  /** The folder chosen in the panel of macOS, for the window that asked (chooseFolder). */
  | { type: 'folderChosen'; now: number; path: string }
  /** How a change of a team went (a member added, taken away, → / ⇄), or a template saved: for the window that asked. */
  | { type: 'crewEdited'; now: number; ok: boolean; crewId?: string; action: string; error?: string }
  /** The teams of agents, after one was created. */
  | { type: 'crews'; now: number; crews: CrewSummary[] }
  /** The teams that start by themselves, after any change: their queues, runs, why the next one waits. */
  | { type: 'automations'; now: number; automations: AutomationView[] }
  /** The sessions that ended with the Mac, to reopen, after any change. */
  | { type: 'reopenList'; now: number; sessions: LostSession[] }
  /** The restarts of the sessions on an older Claude Code, after any change. */
  | { type: 'restarts'; now: number; restarts: RestartsInfo }
  /** How reopening went, for the window that asked: the sessions that reopened, and why the others did not. */
  | { type: 'reopened'; now: number; reopened: { agentId: string; newAgentId: string; name: string }[]; failed: { agentId: string; name: string; error: string }[] }
  /** How a change of an automation went, for the window that asked. */
  | { type: 'autoEdited'; now: number; action: string; ok: boolean; id?: string; error?: string; added?: number }
  /** How the start of a team went, for the window that asked. */
  | { type: 'crewCreated'; now: number; ok: boolean; crewId?: string; agentIds?: string[]; error?: string }
  /** The whole thread of a team, for the window that shows it. */
  | { type: 'crewThread'; now: number; crewId: string; requests: CrewRequest[]; reviews?: ReviewRecord[]; delivered?: Delivered[] }
  /** A run of a team, step by step, for the replay of the studio. */
  | { type: 'crewReplay'; now: number; crewId: string; replay?: ReplayData }
  /** A team drawn from a description: its template, or why there is none. */
  | { type: 'teamDescribed'; now: number; ok: boolean; template?: CrewTemplate; error?: string; usd?: number; note?: string }
  /** How a request to a team went, for the window that asked: its number, or why it did not go. */
  | { type: 'crewRequested'; now: number; ok: boolean; crewId: string; n?: number; error?: string }
  /** What every session cost since midnight, read again from arricurdAI. */
  | { type: 'today'; now: number; today: TodayInfo }
  /** The limits of the Claude plan, when a status line says something new about them. */
  | { type: 'limits'; now: number; limits: UsageLimits }
  /** What the guard did in the last days (daemon/guard-stats.ts), when a count changes. */
  | { type: 'guardStats'; now: number; stats: GuardStatsInfo }
  | { type: 'agents'; now: number; agents: Agent[] }
  | { type: 'removed'; now: number; ids: string[] }
  /** What `arricurdai recall` found, for the window that asked. */
  | { type: 'recalled'; now: number; id: number; ok: boolean; sessions?: number; matches?: RecallMatch[]; error?: string }
  /** How the start of a new session went, for the window that asked. */
  | { type: 'spawned'; now: number; ok: boolean; agentId?: string; error?: string }
  /** The changes of a session, for the window that asked. */
  | { type: 'files'; now: number; agentId: string; files: FileChange[] }
  /** The transcript of a subagent, for the window that asked: its steps, or why there are none. */
  | { type: 'subagent'; now: number; agentId: string; key: string; steps: SubagentStep[]; model?: string; skipped?: number; note?: string }
  /** A session waits for you, seems stuck or ended with an error: the app shows a notification of macOS. */
  | { type: 'notify'; now: number; agentId: string; kind: 'waiting' | 'stall' | 'error' | 'free' | 'loop' | 'budget' | 'approval' | 'delivered' | 'auto'; title: string; body: string };

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
  | { type: 'letThrough'; agentId: string; path: string }
  /** fromSelection: asked from the menu of a selection in the pane of this session (see daemon/commands.ts). */
  | { type: 'command'; agentId: string; kind: string; arg?: string; confirmed?: boolean; fromSelection?: boolean }
  /** A drag in a pane started or ended: at the end, the daemon reads what tmux copied. */
  | { type: 'selection'; agentId: string; phase: 'start' | 'end' }
  /** From the menu of a selection: a question to a session (ask), or text into its prompt, not sent (insert). */
  | { type: 'ask'; agentId: string; text: string; fromSelection?: boolean }
  | { type: 'insert'; agentId: string; text: string }
  | { type: 'savePrompts'; prompts: unknown }
  | { type: 'saveSettings'; settings: unknown }
  | { type: 'system' }
  | { type: 'cancel'; agentId: string; commandId: string }
  | { type: 'permission'; agentId: string; ticket: string; behavior: 'allow' | 'deny'; always?: number }
  | { type: 'files'; agentId: string }
  /** The transcript of a subagent of a session, by its key (shared/present.ts, subagentKey). */
  | { type: 'subagent'; agentId: string; key: string }
  | { type: 'spawn'; cwd: string; prompt?: string; model?: string; mode?: string; worktree?: string | boolean }
  | { type: 'team'; agentId: string; team: unknown }
  /** A new team of agents, as the panel writes it (shared/crew.ts checks it). */
  | { type: 'createCrew'; spec: unknown }
  /** Sessions that ended, each on its conversation again; or not now (all of them, or these). */
  | { type: 'reopen'; agentIds: string[] }
  | { type: 'dismissReopen'; agentIds?: string[] }
  /** These sessions restart on the Claude Code installed; or the others go on, after one that stopped them. */
  | { type: 'restart'; agentIds: string[] }
  | { type: 'restartsGoOn'; goOn: boolean }
  /** A team that starts by itself, new or changed (id), as the panel writes it (shared/automation.ts checks it). */
  | { type: 'saveAutomation'; id?: string; automation: unknown }
  | { type: 'deleteAutomation'; id: string }
  /** pause, resume, add (items; a run now; a look at GitHub now), cancel an item, stop the run, retry a run. */
  | { type: 'autoAction'; id: string; action: string; text?: string; itemId?: string }
  /** A request from you to some recipients of a team; none means all its members. */
  | { type: 'crewRequest'; crewId: string; to: string[]; text: string }
  /** The whole thread of a team. */
  | { type: 'crewThread'; crewId: string }
  /** Your decision on a request that waits for your approval: let it go (its text maybe changed), or send it back. */
  | { type: 'crewDecide'; crewId: string; n: number; to: string; approve: boolean; note?: string; text?: string }
  /** A run of a team, to replay on the canvas. */
  | { type: 'crewReplay'; crewId: string }
  /** A team to draw from a sentence: Claude writes its template. */
  | { type: 'describeTeam'; text: string }
  /** A change of a team: a member added (member), taken away (name), its → / ⇄ (name, talk), or its files (name, paths). */
  | { type: 'editCrew'; crewId: string; action: 'add' | 'remove' | 'talk' | 'paths' | 'approve'; name?: string; talk?: string; member?: unknown; paths?: unknown; approve?: boolean }
  /** A template: from the panel of a new team (template), or from an existing team (crewId, with its name). */
  | { type: 'saveCrewTemplate'; template?: unknown; crewId?: string }
  | { type: 'deleteCrewTemplate'; name: string }
  /** A preset of agent of the studio: saved (in place of `previous`, when renamed), or deleted (restored, for one of Forchetta). */
  | { type: 'saveRolePreset'; preset: unknown; previous?: string }
  | { type: 'deleteRolePreset'; name: string }
  | { type: 'recall'; id: number; project: string; query: string }
  /** A running team in full, for the studio. */
  | { type: 'crewTemplate'; crewId: string }
  /** A team as a file: saved in your Downloads (the app cannot save a file itself), or opened from its text. */
  | { type: 'saveTeamFile'; name: string; text: string }
  | { type: 'importTeam'; text: string; choice?: 'ask' | 'fetch' | 'skip' }
  /** A skill of yours, from a link of GitHub or a folder of this Mac; or taken away. */
  | { type: 'addSkill'; source: string }
  | { type: 'removeSkill'; id: string }
  /** The panel of macOS for a folder, from a page in a browser (the app has its own), starting at `folder`. */
  | { type: 'chooseFolder'; folder?: string }
  /** Run `claude update`, or hide the line of the last one. */
  | { type: 'claudeUpdate'; action: 'run' | 'dismiss' };

export interface HubOptions {
  token: string;
  port: () => number;
  snapshot: () => Agent[];
  settings?: () => UiSettings;
  /** A drag in a pane: its start, and at its end the text tmux copied, if any. */
  onSelection?: (agentId: string, phase: 'start' | 'end') => Promise<string | undefined>;
  /** A question from the menu of a selection. */
  onAsk?: (agentId: string, text: string, fromSelection: boolean) => { ok: boolean; error?: string };
  /** Text into the prompt of a session, not sent. */
  onInsert?: (agentId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  /** The quick prompts, and saving them. */
  prompts?: () => QuickPrompt[];
  onSavePrompts?: (prompts: unknown) => { ok: boolean; error?: string };
  /** The installation, for the page: the checklist, the optional features, the settings. */
  system?: () => SystemInfo;
  /** The settings of the panel Settings, checked and saved in var/config.json. */
  onSaveSettings?: (settings: unknown) => { ok: true; restart: string[] } | { ok: false; error: string };
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
  /** The sessions that ended with the Mac (daemon/reopen.ts), reopening them, not now. */
  reopenList?: () => LostSession[];
  onReopen?: (agentIds: string[]) => Promise<{ reopened: { agentId: string; newAgentId: string; name: string }[]; failed: { agentId: string; name: string; error: string }[] }>;
  onDismissReopen?: (agentIds?: string[]) => void;
  /** The teams that start by themselves (daemon/automations.ts), and their changes. */
  automations?: () => AutomationView[];
  onSaveAutomation?: (automation: unknown, id?: string) => { ok: boolean; id?: string; error?: string };
  onDeleteAutomation?: (id: string) => { ok: boolean; error?: string };
  onAutoAction?: (id: string, action: string, arg: { text?: string; itemId?: string }) => { ok: boolean; error?: string; added?: number };
  /** The whole thread of a team. */
  crewThread?: (crewId: string) => CrewRequest[] | undefined;
  /** The verdicts of the reviewers of a team, with its thread. */
  crewReviews?: (crewId: string) => ReviewRecord[];
  /** What the lead of a team delivered, with its thread. */
  crewDelivered?: (crewId: string) => Delivered[];
  /** Your decision on a request that waits for your approval. */
  onCrewDecide?: (crewId: string, n: number, to: string, approve: boolean, options: { note?: string; text?: string }) => { ok: boolean; error?: string };
  /** A run of a team: its file and the ledger, step by step. */
  crewReplay?: (crewId: string) => ReplayData | undefined;
  /** A team drawn from a description, by Claude. */
  onDescribeTeam?: (text: string) => Promise<{ ok: boolean; template?: CrewTemplate; error?: string; usd?: number; note?: string }>;
  /** A change of a team. */
  onEditCrew?: (message: Extract<ClientMessage, { type: 'editCrew' }>) => Promise<{ ok: boolean; error?: string }>;
  /** The templates of teams, and saving or deleting one. */
  templates?: () => CrewTemplate[];
  onTemplate?: (message: Extract<ClientMessage, { type: 'saveCrewTemplate' | 'deleteCrewTemplate' }>) => { ok: boolean; error?: string };
  /** The presets of agents of the studio, and saving or deleting one. */
  roles?: () => RolePreset[];
  onRole?: (message: Extract<ClientMessage, { type: 'saveRolePreset' | 'deleteRolePreset' }>) => { ok: boolean; error?: string };
  /** A running team in full: its template and its folder. */
  crewTemplate?: (crewId: string) => { template: CrewTemplate; cwd: string } | undefined;
  /** A team as a file: saved, or opened. */
  onSaveTeamFile?: (name: string, text: string) => { ok: boolean; error?: string; path?: string };
  onImportTeam?: (text: string, choice: 'ask' | 'fetch' | 'skip') => Promise<{ ok: boolean; error?: string; template?: CrewTemplate; notes?: string[]; ask?: { id: string; repo: string; path: string; commit: string }[] }>;
  /** The skills you added, and adding or taking one away. */
  customSkills?: () => readonly SkillInfo[];
  onAddSkill?: (source: string) => Promise<{ ok: boolean; error?: string; id?: string }>;
  onRemoveSkill?: (id: string) => { ok: boolean; error?: string };
  /** The folder chosen in the panel of macOS; undefined if cancelled. */
  onChooseFolder?: (folder: string | undefined) => Promise<string | undefined>;
  /** A request from you to a team. */
  onCrewRequest?: (crewId: string, to: string[], text: string) => { ok: true; n: number } | { ok: false; error: string };
  /** The changes of a session, read when its panel opens. */
  onFiles?: (agentId: string) => Promise<FileChange[]>;
  /** The transcript of a subagent, read when its panel shows it and again as it works. */
  onSubagent?: (agentId: string, key: string) => Promise<{ steps: SubagentStep[]; model?: string; skipped?: number; note?: string }>;
  /** "back to the end" in a pane scrolled back in tmux. */
  onScrollEnd?: (agentId: string) => void;
  /** You let a session through on a file the guard held back (daemon/guard.ts). */
  onLetThrough?: (agentId: string, path: string) => void;
  /** The answer of a box to a permission dialog. */
  onPermission?: (message: Extract<ClientMessage, { type: 'permission' }>) => void;
  /** The updates of Claude Code, for the top line. */
  claudeUpdate?: () => ClaudeUpdateInfo;
  /** `claude update` from the top line, or its line hidden. */
  onClaudeUpdate?: (action: 'run' | 'dismiss') => void;
  /** The restarts of the sessions on an older Claude Code (daemon/restarts.ts). */
  restarts?: () => RestartsInfo;
  onRestart?: (agentIds: string[]) => void;
  onRestartsGoOn?: (goOn: boolean) => void;
  /** Called when the number of windows that can be seen goes from 0 to more, or back. */
  onWatched?: (watched: boolean) => void;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
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
  private limits: UsageLimits | undefined;
  private guardStats: GuardStatsInfo | undefined;

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
      roles: this.options.roles?.(),
      skills: this.options.customSkills ? [...this.options.customSkills()] : undefined,
      claudeUpdate: this.options.claudeUpdate?.(),
      prompts: this.options.prompts?.(),
      limits: this.limits,
      guardStats: this.guardStats,
      system: this.options.system?.(),
      automations: this.options.automations?.(),
      reopen: this.options.reopenList?.(),
      restarts: this.options.restarts?.(),
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
            fromSelection: message.fromSelection === true,
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
        } else if (message.type === 'reopen' && Array.isArray(message.agentIds) && this.options.onReopen) {
          const ids = message.agentIds.filter((id): id is string => typeof id === 'string').slice(0, 200);
          void this.options.onReopen(ids).then(
            (outcome) => this.send(ws, { type: 'reopened', now: Date.now(), ...outcome }),
            (error: unknown) => this.send(ws, { type: 'reopened', now: Date.now(), reopened: [], failed: ids.map((agentId) => ({ agentId, name: agentId.slice(0, 8), error: String(error) })) }),
          );
        } else if (message.type === 'dismissReopen' && this.options.onDismissReopen) {
          this.options.onDismissReopen(Array.isArray(message.agentIds) ? message.agentIds.filter((id): id is string => typeof id === 'string') : undefined);
        } else if (message.type === 'saveAutomation' && this.options.onSaveAutomation) {
          const result = this.options.onSaveAutomation(message.automation, typeof message.id === 'string' ? message.id : undefined);
          this.send(ws, { type: 'autoEdited', now: Date.now(), action: 'save', ...result });
        } else if (message.type === 'deleteAutomation' && typeof message.id === 'string' && this.options.onDeleteAutomation) {
          const result = this.options.onDeleteAutomation(message.id);
          this.send(ws, { type: 'autoEdited', now: Date.now(), action: 'delete', id: message.id, ...result });
        } else if (message.type === 'autoAction' && typeof message.id === 'string' && typeof message.action === 'string' && this.options.onAutoAction) {
          const result = this.options.onAutoAction(message.id, message.action, {
            ...(typeof message.text === 'string' ? { text: message.text.slice(0, 200_000) } : {}),
            ...(typeof message.itemId === 'string' ? { itemId: message.itemId } : {}),
          });
          this.send(ws, { type: 'autoEdited', now: Date.now(), action: message.action, id: message.id, ...result });
        } else if (message.type === 'crewRequest' && typeof message.crewId === 'string' && typeof message.text === 'string' && this.options.onCrewRequest) {
          const to = Array.isArray(message.to) ? message.to.filter((name): name is string => typeof name === 'string') : [];
          const result = this.options.onCrewRequest(message.crewId, to, message.text);
          this.send(ws, { type: 'crewRequested', now: Date.now(), crewId: message.crewId, ...result });
        } else if (message.type === 'editCrew' && typeof message.crewId === 'string' && typeof message.action === 'string' && this.options.onEditCrew) {
          const edit = {
            type: 'editCrew' as const,
            crewId: message.crewId,
            action: message.action as 'add' | 'remove' | 'talk' | 'paths' | 'approve',
            name: typeof message.name === 'string' ? message.name : undefined,
            talk: typeof message.talk === 'string' ? message.talk : undefined,
            member: message.member,
            paths: message.paths,
            approve: message.approve === true,
          };
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
        } else if ((message.type === 'saveRolePreset' || message.type === 'deleteRolePreset') && this.options.onRole) {
          const result =
            message.type === 'saveRolePreset'
              ? this.options.onRole({ type: 'saveRolePreset', preset: message.preset, ...(typeof message.previous === 'string' ? { previous: message.previous } : {}) })
              : this.options.onRole({ type: 'deleteRolePreset', name: String(message.name ?? '') });
          this.send(ws, { type: 'crewEdited', now: Date.now(), action: message.type, ...result });
          if (result.ok) this.broadcast({ type: 'crewRoles', now: Date.now(), roles: this.options.roles?.() ?? [] });
        } else if (message.type === 'crewTemplate' && typeof message.crewId === 'string' && this.options.crewTemplate) {
          const found = this.options.crewTemplate(message.crewId);
          this.send(ws, { type: 'crewTemplate', now: Date.now(), crewId: message.crewId, ...(found ? { template: found.template, cwd: found.cwd } : {}) });
        } else if (message.type === 'saveTeamFile' && this.options.onSaveTeamFile) {
          const result = this.options.onSaveTeamFile(String(message.name ?? 'team').slice(0, 80), String(message.text ?? ''));
          this.send(ws, { type: 'teamFile', now: Date.now(), action: 'save', ok: result.ok, ...(result.error ? { error: result.error } : {}), ...(result.path ? { path: result.path } : {}) });
        } else if (message.type === 'importTeam' && this.options.onImportTeam) {
          const choice = message.choice === 'fetch' || message.choice === 'skip' ? message.choice : 'ask';
          void this.options.onImportTeam(String(message.text ?? ''), choice).then(
            (result) => {
              this.send(ws, {
                type: 'teamFile',
                now: Date.now(),
                action: 'import',
                ok: result.ok,
                ...(result.error ? { error: result.error } : {}),
                ...(result.template ? { template: result.template } : {}),
                ...(result.notes ? { notes: result.notes } : {}),
                ...(result.ask ? { ask: result.ask } : {}),
              });
              if (result.ok) this.broadcast({ type: 'customSkills', now: Date.now(), skills: [...(this.options.customSkills?.() ?? [])] });
            },
            (error: unknown) => this.send(ws, { type: 'teamFile', now: Date.now(), action: 'import', ok: false, error: String(error) }),
          );
        } else if (message.type === 'addSkill' && this.options.onAddSkill) {
          void this.options.onAddSkill(String(message.source ?? '').slice(0, 2048)).then(
            (result) => {
              this.send(ws, { type: 'skillEdited', now: Date.now(), action: 'add', ok: result.ok, ...(result.error ? { error: result.error } : {}), ...(result.id ? { id: result.id } : {}) });
              if (result.ok) this.broadcast({ type: 'customSkills', now: Date.now(), skills: [...(this.options.customSkills?.() ?? [])] });
            },
            (error: unknown) => this.send(ws, { type: 'skillEdited', now: Date.now(), action: 'add', ok: false, error: String(error) }),
          );
        } else if (message.type === 'removeSkill' && this.options.onRemoveSkill) {
          const result = this.options.onRemoveSkill(String(message.id ?? ''));
          this.send(ws, { type: 'skillEdited', now: Date.now(), action: 'remove', ok: result.ok, ...(result.error ? { error: result.error } : {}) });
          if (result.ok) this.broadcast({ type: 'customSkills', now: Date.now(), skills: [...(this.options.customSkills?.() ?? [])] });
        } else if (message.type === 'chooseFolder' && this.options.onChooseFolder) {
          void this.options.onChooseFolder(typeof message.folder === 'string' ? message.folder.slice(0, 4096) : undefined).then(
            (path) => {
              if (path) this.send(ws, { type: 'folderChosen', now: Date.now(), path });
            },
            (error: unknown) => this.options.log(`choice of a folder: ${String(error)}`, 'warn'),
          );
        } else if (message.type === 'crewThread' && typeof message.crewId === 'string' && this.options.crewThread) {
          const requests = this.options.crewThread(message.crewId);
          const reviews = this.options.crewReviews?.(message.crewId);
          const delivered = this.options.crewDelivered?.(message.crewId);
          if (requests) {
            this.send(ws, {
              type: 'crewThread',
              now: Date.now(),
              crewId: message.crewId,
              requests,
              ...(reviews && reviews.length > 0 ? { reviews } : {}),
              ...(delivered && delivered.length > 0 ? { delivered } : {}),
            });
          }
        } else if (message.type === 'crewDecide' && typeof message.crewId === 'string' && Number.isInteger(message.n) && typeof message.to === 'string' && this.options.onCrewDecide) {
          const result = this.options.onCrewDecide(message.crewId, message.n as number, message.to, message.approve === true, {
            ...(typeof message.note === 'string' ? { note: message.note } : {}),
            ...(typeof message.text === 'string' ? { text: message.text } : {}),
          });
          this.send(ws, { type: 'crewEdited', now: Date.now(), crewId: message.crewId, action: 'decide', ...result });
        } else if (message.type === 'crewReplay' && typeof message.crewId === 'string' && this.options.crewReplay) {
          const replay = this.options.crewReplay(message.crewId);
          this.send(ws, { type: 'crewReplay', now: Date.now(), crewId: message.crewId, ...(replay ? { replay } : {}) });
        } else if (message.type === 'describeTeam' && typeof message.text === 'string' && this.options.onDescribeTeam) {
          void this.options.onDescribeTeam(message.text).then(
            (result) => this.send(ws, { type: 'teamDescribed', now: Date.now(), ...result }),
            (error: unknown) => this.send(ws, { type: 'teamDescribed', now: Date.now(), ok: false, error: String(error) }),
          );
        } else if (message.type === 'selection' && typeof message.agentId === 'string' && (message.phase === 'start' || message.phase === 'end') && this.options.onSelection) {
          const agentId = message.agentId;
          void this.options.onSelection(agentId, message.phase).then(
            (text) => {
              if (text) this.send(ws, { type: 'selection', now: Date.now(), agentId, text });
            },
            (error: unknown) => this.options.log(`selection in ${agentId}: ${String(error)}`, 'warn'),
          );
        } else if (message.type === 'ask' && typeof message.agentId === 'string' && typeof message.text === 'string' && this.options.onAsk) {
          const result = this.options.onAsk(message.agentId, message.text, message.fromSelection === true);
          this.send(ws, { type: 'selectionSent', now: Date.now(), agentId: message.agentId, action: 'ask', ...result });
        } else if (message.type === 'insert' && typeof message.agentId === 'string' && typeof message.text === 'string' && this.options.onInsert) {
          const agentId = message.agentId;
          void this.options.onInsert(agentId, message.text).then(
            (result) => this.send(ws, { type: 'selectionSent', now: Date.now(), agentId, action: 'insert', ...result }),
            (error: unknown) => this.send(ws, { type: 'selectionSent', now: Date.now(), agentId, action: 'insert', ok: false, error: String(error) }),
          );
        } else if (message.type === 'system') {
          const system = this.options.system?.();
          if (system) this.send(ws, { type: 'system', now: Date.now(), system });
        } else if (message.type === 'saveSettings' && this.options.onSaveSettings) {
          const result = this.options.onSaveSettings(message.settings);
          this.send(ws, { type: 'settingsSaved', now: Date.now(), ...result });
          if (result.ok) this.systemChanged();
        } else if (message.type === 'savePrompts' && this.options.onSavePrompts) {
          const result = this.options.onSavePrompts(message.prompts);
          this.send(ws, { type: 'promptsSaved', now: Date.now(), ...result });
          if (result.ok) this.broadcast({ type: 'prompts', now: Date.now(), prompts: this.options.prompts?.() ?? [] });
        } else if (message.type === 'restart' && Array.isArray(message.agentIds)) {
          this.options.onRestart?.(message.agentIds.filter((id): id is string => typeof id === 'string').slice(0, 200));
        } else if (message.type === 'restartsGoOn') {
          this.options.onRestartsGoOn?.(message.goOn !== false);
        } else if (message.type === 'claudeUpdate' && (message.action === 'run' || message.action === 'dismiss')) {
          this.options.onClaudeUpdate?.(message.action);
        } else if (message.type === 'scrollEnd' && typeof message.agentId === 'string') {
          this.options.onScrollEnd?.(message.agentId);
        } else if (message.type === 'letThrough' && typeof message.agentId === 'string' && typeof message.path === 'string') {
          this.options.onLetThrough?.(message.agentId, message.path);
        } else if (message.type === 'files' && typeof message.agentId === 'string' && this.options.onFiles) {
          const agentId = message.agentId;
          void this.options.onFiles(agentId).then(
            (files) => this.send(ws, { type: 'files', now: Date.now(), agentId, files }),
            (error: unknown) => this.options.log(`changes of ${agentId}: ${String(error)}`, 'warn'),
          );
        } else if (message.type === 'subagent' && typeof message.agentId === 'string' && typeof message.key === 'string' && this.options.onSubagent) {
          const agentId = message.agentId;
          const key = message.key;
          void this.options.onSubagent(agentId, key).then(
            (thread) => this.send(ws, { type: 'subagent', now: Date.now(), agentId, key, ...thread }),
            (error: unknown) => this.send(ws, { type: 'subagent', now: Date.now(), agentId, key, steps: [], note: `The transcript could not be read: ${String(error)}` }),
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
    ws.on('error', (error) => this.options.log(`websocket: ${String(error)}`, 'warn'));
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

  /** The templates of teams changed outside the page (a session saved one): every window gets them again. */
  templatesChanged(): void {
    this.broadcast({ type: 'crewTemplates', now: Date.now(), templates: this.options.templates?.() ?? [] });
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
  private automationsPending = false;

  /** The sessions to reopen changed: the page gets them again. */
  reopenChanged(): void {
    this.broadcast({ type: 'reopenList', now: Date.now(), sessions: this.options.reopenList?.() ?? [] });
  }

  /** The automations changed: the page gets them again, once for changes close together. */
  automationsChanged(): void {
    if (this.automationsPending) return;
    this.automationsPending = true;
    setImmediate(() => {
      this.automationsPending = false;
      this.broadcast({ type: 'automations', now: Date.now(), automations: this.options.automations?.() ?? [] });
    });
  }

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

  setLimits(limits: UsageLimits): void {
    this.limits = limits;
    this.broadcast({ type: 'limits', now: Date.now(), limits });
  }

  /** The installation, as the page gets it. */
  system(): SystemInfo | undefined {
    return this.options.system?.();
  }

  /** The installation changed (a setting, the version of Claude Code, hooks installed): every window gets it. */
  systemChanged(): void {
    const system = this.options.system?.();
    if (system) this.broadcast({ type: 'system', now: Date.now(), system });
  }

  setGuardStats(stats: GuardStatsInfo): void {
    if (JSON.stringify(stats) === JSON.stringify(this.guardStats)) return;
    this.guardStats = stats;
    this.broadcast({ type: 'guardStats', now: Date.now(), stats });
  }

  setRestarts(restarts: RestartsInfo): void {
    this.broadcast({ type: 'restarts', now: Date.now(), restarts });
  }

  setClaudeUpdate(update: ClaudeUpdateInfo): void {
    this.broadcast({ type: 'claudeUpdate', now: Date.now(), update });
  }

  notify(notice: { agentId: string; kind: 'waiting' | 'stall' | 'error' | 'free' | 'loop' | 'budget' | 'approval' | 'delivered' | 'auto'; title: string; body: string }): void {
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
