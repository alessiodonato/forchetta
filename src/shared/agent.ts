// The shape of an agent as the daemon keeps it and as the CLI and the page receive it. No Node module here: the
// page imports this file too.
import type { ArtifactLink } from './artifacts.ts';

export type AgentState = 'starting' | 'working' | 'waiting' | 'idle' | 'compacting' | 'error' | 'ended';

export const STATE_LABEL: Record<AgentState, string> = {
  starting: 'starting',
  working: 'working',
  waiting: 'waiting',
  idle: 'idle',
  compacting: 'compacting',
  error: 'error',
  ended: 'ended',
};

export type ToolFamily = 'edit' | 'shell' | 'read' | 'web' | 'agent' | 'other';

export type Control =
  | { kind: 'tmux'; session: string; paneId?: string }
  | { kind: 'readonly'; reason: 'fuori-tmux' | 'background' };

export interface Waiting {
  kind: 'permesso' | 'domanda' | 'dialogo';
  tool?: string;
  detail?: string;
  /** The tool call that asked for permission: its PostToolUse closes the dialog. */
  key?: string;
  since: number;
  /**
   * Seen by `claude agents --json`, not told by a hook (the answer of /btw, for one): no hook says when it ends,
   * so only another reading can.
   */
  fromAgentView?: boolean;
}

/**
 * A permission dialog the box can answer: bin/forchetta-permission keeps it open and waits (daemon/permissions.ts).
 * The terminal shows the same dialog; whichever answers first wins.
 */
export interface PermissionAsk {
  /** What the box sends back with the answer: the request it answers, and no other. */
  ticket: string;
  tool: string;
  /** What is asked, in full: the command, the file, the address. */
  detail: string;
  /** The type of the subagent that asks, when it is not the main agent. */
  subagent?: string;
  since: number;
  /** After this the hook stops waiting: the dialog stays in the terminal only. */
  until: number;
  /** The "always" choices the box offers, by index (daemon/suggestions.ts). */
  always?: Array<{ label: string; where: string }>;
}

/** How the last answer from the box went: shown for a while under the summary. */
export interface PermissionOutcome {
  text: string;
  tone: 'done' | 'muted';
  at: number;
}

export interface Action {
  tool: string;
  label: string;
  family: ToolFamily;
  /** The type of the subagent that runs the tool, when it is not the main agent. */
  subagent?: string;
  at: number;
}

/**
 * The tokens the next prompt sends again, and the share of the window they fill. From the status line of Claude
 * Code when it gives them (`source: 'statusline'`): its own numbers, window included. Otherwise from `arricurdai status`, with the window from the table in the configuration: an estimate.
 */
export interface ContextInfo {
  tokens: number;
  window: number;
  percent: number;
  /** Absent: from arricurdAI. */
  source?: 'statusline';
  /** The last call, as arricurdAI read it. */
  lastCallAt?: number;
  at: number;
}

/** From `arricurdai status`: when the prompt cache of the session expires. */
export interface CacheInfo {
  expiresAt: number;
  live: boolean;
  /** The cache expired on a large context: the guard of arricurdAI stops the next prompt. */
  guardWillStop: boolean;
}

/**
 * From the status line of Claude Code: what the session cost at API prices since the process started, as Claude
 * Code computes it for /cost. The tokens of the status line are those of the last call only, not a total: they
 * become the context (ContextInfo), not a count of the session.
 */
export interface UsageInfo {
  usd: number;
  at: number;
}

/** One passage of an earlier session that `arricurdai recall` found. */
export interface RecallMatch {
  sessionId: string;
  at?: number;
  /** The request of the user that passage answers. */
  request?: string;
  excerpt: string;
}

/** From `arricurdai status`, when it gives it: what this session (with its subagents) used since midnight. */
export interface SessionTodayInfo {
  calls: number;
  /** Tokens of every kind: input, cache writes, cache reads, output. */
  tokens: number;
  usd: number;
}

/** From `arricurdai status`: every call of every session since midnight, at API prices. */
export interface TodayInfo {
  since: number;
  calls: number;
  tokens: number;
  usd: number;
  /** Calls of models with no known price, left out of usd. */
  unpricedCalls: number;
}

/** The updates of Claude Code, for the top line of the app (daemon/claude-update.ts). */
export interface ClaudeUpdateInfo {
  /** The last automatic update failed: when, from which version, and how Claude Code calls it (install_failed…). */
  failed?: { at: number; from?: string; status?: string };
  /** The `claude update` started from the app: while it runs, then what it did or why it failed. */
  run?: { state: 'running' | 'done' | 'error'; text?: string; at: number };
}

/** Another live session wrote the same files, or in the same working tree, in the last hour. */
export interface Conflict {
  kind: 'file' | 'repo';
  /** The other agent, and how the box calls it. */
  with: string;
  withName: string;
  /** For 'file': the files both wrote, relative to the working tree when there is one. */
  files: string[];
  /** The name of the working tree. */
  repo?: string;
}

/**
 * A file the guard held back (daemon/guard.ts): another session is changing it in the turn it works on now. The
 * session that was stopped has it in `heldBack`, with the other one in `with`; the other one has it in `holding`,
 * with the session that waits in `with`.
 */
export interface GuardHold {
  /** The file, relative to its working tree when there is one. */
  file: string;
  /** The file, absolute: what the box sends back to let it through. */
  path: string;
  with: string;
  withName: string;
  since: number;
  /** You let it through from the box: its next write goes. */
  letThrough?: boolean;
}

/** One change a session made to a file, as Claude Code reported it (daemon/patches.ts). */
export interface SessionEdit {
  at: number;
  tool: string;
  file: string;
  /** The blocks of the change, as in a unified diff: lines that start with " ", "-" or "+". */
  hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>;
  /** The file did not exist: all of it is added. */
  created?: boolean;
  truncated?: boolean;
}

/** A file a session wrote, and what git says changed in it since the last commit (daemon/diffs.ts). */
export interface FileChange {
  path: string;
  /** Relative to its working tree, or the path with ~. */
  name: string;
  repo?: string;
  /** The last write of the session. */
  at: number;
  added: number;
  removed: number;
  diff?: string;
  /** Why there is no diff, or that it was cut. */
  note?: string;
  /** What this session itself changed, change by change, oldest first. */
  edits?: SessionEdit[];
}

/**
 * A subagent a session started with the Agent tool (daemon/subagents.ts): what it was started with, what it does,
 * how it ended. It runs inside the process of its session: no terminal, only its transcript.
 */
export interface Subagent {
  /** The id Claude Code gives it (subagents/agent-<id>.jsonl): known from its first event or from the result of its call. */
  id?: string;
  /** The Agent call that started it. */
  toolUseId?: string;
  /** Explore, general-purpose, Plan, or an agent of yours. */
  type: string;
  description?: string;
  /** The task it got, cut: the whole one is in its transcript. */
  prompt?: string;
  /** The model asked in the call (haiku, opus…) or the one Claude Code chose; undefined when it inherits it. */
  model?: string;
  /** Started in the background: the session goes on while it works. */
  background?: boolean;
  /** "worktree": it works in a git worktree of its own. */
  isolation?: string;
  /** Started by another subagent, of this type. */
  by?: string;
  /** waiting: it stopped to wait for work of its own in the background (a command, a subagent); it goes on after. */
  state: 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
  /** It started work of its own in the background since it last started: when it stops, it may only be waiting. */
  backgroundWork?: boolean;
  /** It sent its report to the session (SubagentHandback): when it stops, it is done. */
  reported?: boolean;
  /** Its last tool call. */
  action?: { label: string; family: ToolFamily; at: number };
  /** Tool calls seen so far. */
  tools?: number;
  /** From the result of its call, when it ran in the foreground. */
  tokens?: number;
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** Its transcript, for the panel (daemon side). */
  transcript?: string;
}

/** One step of the transcript of a subagent, as its panel shows it. */
export type SubagentStep =
  | { kind: 'prompt'; text: string; at?: number }
  /** A message sent to it later (SendMessage), after the first task. */
  | { kind: 'message'; text: string; at?: number }
  | { kind: 'text'; text: string; at?: number }
  | { kind: 'tool'; label: string; family: ToolFamily; result?: string; error?: boolean; at?: number }
  /** Its final report to the session. */
  | { kind: 'report'; text: string; at?: number }
  /** A notice of Claude Code to the subagent: work of its own in the background finished. */
  | { kind: 'notice'; text: string; at?: number };

/** Where a session stands in a team: set from its box, remembered for its folder (daemon/teams.ts). */
export interface TeamInfo {
  /** A name of your choice, shown in place of the folder. */
  label?: string;
  group?: string;
  role?: string;
  /** The head of its group: it sits above the others in the chart. */
  lead?: boolean;
  /** The team of agents it was started for (shared/crew.ts): set by the daemon, never by the box. */
  crew?: string;
  /** In a team of agents, how a member talks with its lead: → executes, ⇄ also answers. */
  talk?: 'oneway' | 'twoway';
}

export const TEAM_TEXT_MAX = 40;

/** The fields as the box sends them: trimmed, cut, and left out when empty. Undefined when nothing is left. */
export function cleanTeam(input: unknown): TeamInfo | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const text = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, TEAM_TEXT_MAX);
    return trimmed || undefined;
  };
  const team: TeamInfo = { label: text(raw.label), group: text(raw.group), role: text(raw.role), lead: raw.lead === true && text(raw.group) !== undefined ? true : undefined };
  for (const key of Object.keys(team) as (keyof TeamInfo)[]) if (team[key] === undefined) delete team[key];
  return Object.keys(team).length > 0 ? team : undefined;
}

/** How a box calls its session: the name you gave it, or the folder. */
export const displayName = (agent: Pick<Agent, 'project' | 'team'>): string => agent.team?.label ?? agent.project;

/** The commands of the box, and the requests of a team of agents (pasted as a prompt). */
/**
 * request: of a team of agents; ask: a question about a selection, from the menu of a pane; free: the guard tells a
 * session that a file it was stopped on is free (daemon/guard.ts).
 */
export type CommandKind = 'btw' | 'compact' | 'clear' | 'request' | 'ask' | 'free';

export type CommandStatus =
  /** Waits for the session to be ready for input. */
  | 'in-coda'
  /** Something on screen stops it (text typed in the prompt, an open dialog): it is tried again. */
  | 'bloccato'
  | 'inviato'
  /** Claude Code took it: for /compact and /clear a hook said so; for /btw its answer box is on screen. */
  | 'confermato'
  | 'non-confermato'
  | 'fallito'
  | 'annullato';

/** A command sent from the box. */
export interface QueuedCommand {
  id: string;
  kind: CommandKind;
  /** The question of /btw; the whole text of a request. */
  arg?: string;
  /** A request of a team of agents: its team and its number. */
  request?: { crew: string; n: number };
  /**
   * Asked from the menu of a selection, at this time: the drag that made the selection counts for tmux as activity
   * in the session, and only activity after it means that you are typing there.
   */
  afterSelection?: number;
  status: CommandStatus;
  reason?: string;
  createdAt: number;
  sentAt?: number;
  doneAt?: number;
}

/** One Claude Code process. Its session id changes with /clear; the agent, and its box, stay. */
export interface Agent {
  id: string;
  pid?: number;
  sessionId?: string;
  pastSessionIds: string[];
  transcriptPath?: string;
  cwd?: string;
  project: string;
  name?: string;
  kind?: 'interactive' | 'background';
  model?: string;
  control: Control;
  state: AgentState;
  waiting?: Waiting;
  action?: Action;
  lastEvent: { name: string; at: number };
  summary?: { text: string; source: 'eventi' | 'haiku'; at: number };
  error?: { kind: string; message?: string; at: number };
  /** When the last turn ended: the box draws its check once. */
  completedAt?: number;
  compactTrigger?: string;
  beforeCompact?: AgentState;
  /** A SessionEnd with reason clear or resume: the SessionStart of the same process follows. */
  pendingSwitchAt?: number;
  context?: ContextInfo;
  cache?: CacheInfo;
  usage?: UsageInfo;
  today?: SessionTodayInfo;
  /** For the optional one-line summary: the last request, the recent actions and the last reply. */
  lastPrompt?: string;
  recentActions?: string[];
  lastReply?: string;
  /** The commands of the box: those waiting, the one sent, the last ones done. */
  commands?: QueuedCommand[];
  team?: TeamInfo;
  /** How many files the session wrote: the panel of its changes lists them. */
  filesChanged?: number;
  /** The artifacts of claude.ai it published or opened, the most recent first (shared/artifacts.ts). */
  artifacts?: ArtifactLink[];
  /** The subagents it started, oldest first: the last ones only (daemon/subagents.ts). */
  subagents?: Subagent[];
  /** Its pane, open in the app, is scrolled back in tmux (copy mode): the keys go to tmux (daemon/scrollback.ts). */
  scrolledBack?: boolean;
  /** Other sessions that write the same files or in the same working tree (daemon/conflicts.ts). */
  conflicts?: Conflict[];
  /** Files the guard stopped this session from writing: another session is changing them now (daemon/guard.ts). */
  heldBack?: GuardHold[];
  /** Files of its turn that the guard kept other sessions from writing. */
  holding?: GuardHold[];
  /** The permission dialog that the box can answer now. */
  permission?: PermissionAsk;
  permissionOutcome?: PermissionOutcome;
  createdAt: number;
  endedAt?: number;
  endReason?: string;
}

/** The last part of a path, without Node: the name of the project. */
export function projectOf(cwd: string | undefined): string {
  if (!cwd) return '?';
  const parts = cwd.split('/').filter(Boolean);
  return parts.at(-1) ?? cwd;
}
