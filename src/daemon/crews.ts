import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { keepRejected, readDataJson, writeDataJson } from '../shared/data-file.ts';
import { isAbsolute, join, relative } from 'node:path';
import { type Agent, type QueuedCommand, TEAM_TEXT_MAX, type TeamInfo } from '../shared/agent.ts';
import {
  ANSWER_HEADER,
  BUILTIN_ROLES,
  BUILTIN_TEMPLATES,
  cleanCrewSpec,
  cleanRolePreset,
  cleanPaths,
  cleanTemplate,
  KEPT_REVIEWS,
  ownsPath,
  pathsNote,
  pathsText,
  REVIEW_NOTE_MAX,
  type ReviewRecord,
  type Crew,
  type CrewMemberSpec,
  type CrewTemplate,
  type RolePreset,
  type Talk,
  talkNote,
  type CrewRequest,
  type CrewSpec,
  type CrewSummary,
  type Delivered,
  type Delivery,
  type DeliveryStatus,
  effectiveTalk,
  fillParams,
  filledSpec,
  missingParams,
  paramsText,
  SENT_BACK_HEADER,
  valuesOf,
  effectiveWorktree,
  hasLevels,
  managerName,
  reportsOf,
  reportsToNote,
  type TeamTool,
  teamToolsFor,
  tooLong,
  leadPrompt,
  MAX_OPEN_DELIVERIES,
  memberPrompt,
  QUESTION_HEADER,
  REQUEST_HEADER,
  worktreeName,
} from '../shared/crew.ts';
import { ensurePrivateDir } from '../shared/paths.ts';
import { toolsText } from '../shared/agent-tools.ts';
import { customSkills } from '../shared/skills.ts';
import { type ReplayData, replayOf, type ReplayUsage } from '../shared/replay.ts';
import type { LedgerEntry } from './ledger.ts';
import type { EnqueueResult } from './commands.ts';
import { gitCommands, type LaneCheck } from './guard.ts';
import type { SpawnChoices, SpawnExtras, SpawnResult } from './spawn.ts';
import type { HookPayload } from './state.ts';

// The teams of agents (shared/crew.ts): one file each in var/crews, written when a team is created, read when
// the daemon starts. Creating one starts its sessions: the lead first when it is Claude, then the members, each
// with its name, its system prompt, its place in the chart and, for the lead and the members that answer, the
// tools of the team (mcp/team.ts).
//
// A request (from you, or with send_request from the Claude lead or from a member others report to) gets the next
// number of its team and goes, with its header ("Request #3 from lead:"), into the queue of each recipient
// (daemon/commands.ts), which pastes it when the session is ready. A session sends only to the members that report
// to it; you write to anyone. The queue tells how it goes; the Stop of the recipient after it took the request says
// the work is done, with its last message. A member that answers (⇄) has that message go back to whoever asked:
// the session that sent the request gets it in its own queue ("Answer from tester to request #3:"), you see it in
// the panel of the team. A member → gets no tools and sends nothing back, unless others report to it.
//
// A request a session passes on to its own members (sent while it worked on it: their requests have it as parent)
// stays open, "delegated", when its turn ends: it is done, and its answer goes back, when their work is done too and
// their answers were read (settle). So the answer of a senior reaches the lead after the work of its junior.
//
// A member can have files of its own (shared/crew.ts): the guard asks laneCheck before each of its edits. A member
// that reviews records its verdicts with the tool review; before a git merge of the branch of a member, decideMerge
// finds the commits no approval covers, and the guard asks you.

export interface CreateResult {
  ok: boolean;
  crewId?: string;
  /** The sessions started, the lead first. */
  agentIds?: string[];
  /** What did not start; with ok true when at least one session did. */
  error?: string;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** A role as the chart shows it: the first words, within the 40 characters of the box. */
export function shortRole(role: string): string {
  const flat = role.replace(/\s+/g, ' ').trim();
  return flat.length <= TEAM_TEXT_MAX ? flat : `${flat.slice(0, TEAM_TEXT_MAX - 1).trimEnd()}…`;
}

/** The requests the page gets for each team, and how much of their texts. */
const SHOWN_REQUESTS = 12;
const SHOWN_TEXT = 600;
/** The requests kept in the file of a team. */
const KEPT_REQUESTS = 200;
const ANSWER_MAX = 8000;
const QUESTION_MAX = 4000;

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const OPEN: DeliveryStatus[] = ['approval', 'queued', 'blocked', 'sent', 'working', 'delegated'];

/** What a session of a stopped team is told when it tries to go on. */
const stoppedText = (crew: Pick<Crew, 'stopReason'>): string =>
  `the team was stopped${crew.stopReason ? ` (${crew.stopReason})` : ''}: nothing more goes to its sessions. Do not send anything else: end your turn.`;
/** The longest request, as a request of the panel. */
const REQUEST_MAX = 20_000;
/** What a team keeps of what its lead delivered. */
const KEPT_DELIVERED = 20;

/** The status of a delivery for the status of the command that carries it. */
function deliveryStatus(command: QueuedCommand): DeliveryStatus {
  switch (command.status) {
    case 'in-coda':
      return 'queued';
    case 'bloccato':
      return 'blocked';
    case 'inviato':
      return 'sent';
    case 'confermato':
      return 'working';
    case 'annullato':
      return 'cancelled';
    case 'non-confermato':
      // Pasted and sent, with no UserPromptSubmit in time: it may still be there. The Stop decides.
      return 'sent';
    default:
      return 'failed';
  }
}

/** The status of an answer or a question on its way to the lead, for the status of its command. */
function passageStatus(command: QueuedCommand): 'queued' | 'sent' | 'delivered' | 'failed' {
  switch (command.status) {
    case 'in-coda':
    case 'bloccato':
      return 'queued';
    case 'inviato':
    case 'non-confermato':
      return 'sent';
    case 'confermato':
      return 'delivered';
    default:
      return 'failed';
  }
}

/** What a session of the team is doing, in a few words, for the tool team. */
function stateText(agent: Agent | undefined): string {
  if (!agent) return 'no session';
  switch (agent.state) {
    case 'idle':
      return 'free';
    case 'working':
      return 'working';
    case 'waiting':
      return 'waiting for the user (a dialog in its terminal)';
    case 'compacting':
      return 'compacting its context';
    case 'starting':
      return 'starting';
    case 'error':
      return 'stopped by an error';
    case 'ended':
      return 'session ended';
  }
}

/** The longest wait of a lead for its answers. */
export const MAX_WAIT_MS = 10 * 60_000;

/**
 * A wait found in the file of a team when the daemon starts: its session gets this long to ask for it again (its
 * MCP server tries again while the daemon restarts) before the answers it holds go to it as prompts.
 */
export const RESTORED_WAIT_GRACE_MS = 60_000;

/** A session waiting for the answers of some of its requests (wait_for_answers): its answers are held for it. */
interface Waiter {
  id: string;
  crewId: string;
  /** The session that waits: the Claude lead, or a member others report to. */
  by: string;
  requests: Set<number>;
  until: number;
  timer: ReturnType<typeof setTimeout>;
  /** The polls waiting for news. */
  listeners: (() => void)[];
}

/** How a session of a team starts: spawnSession, with the choices of the panel and what a team adds. */
export type Starter = (input: { cwd: string } & SpawnChoices, extras: SpawnExtras) => Promise<SpawnResult>;

export type WaitAnswer = { n: number; from: string; status: DeliveryStatus; talk?: Talk; answer?: string; reason?: string };

export class Crews {
  private readonly crews = new Map<string, Crew>();
  private readonly waiters = new Map<string, Waiter>();
  /** The root of the git repository of a folder, and its branch: set by the daemon (git), for the tool team. */
  gitInfo: (dir: string) => { root?: string; branch?: string } = () => ({});
  /** Whether a folder is in a git repository: a worktree needs one. */
  inGit: (dir: string) => boolean = () => false;
  /**
   * Whether Claude Code trusts this very folder (its trust dialog was accepted there): `claude --worktree` refuses
   * a folder that is trusted only through a folder above it ("Workspace trust not yet accepted"). Set by the daemon.
   */
  trusted: (dir: string) => boolean = () => true;

  /** Why the members of a team in this folder cannot have worktrees; undefined when they can. */
  private noWorktrees(dir: string): string | undefined {
    if (!this.inGit(dir)) return 'the folder is not in a git repository: the members share it, with no worktree';
    if (!this.trusted(dir)) {
      return 'Claude Code does not trust this folder yet, and a worktree needs it: the members share the folder. Open the folder once with claude, accept its trust dialog, and the next team there gets its worktrees';
    }
    return undefined;
  }
  /** Called when a team or one of its requests changed: the page gets the teams again. */
  onChange: () => void = () => {};
  /** Puts a text in the queue of a session (Commander.enqueueRequest); set by the daemon. */
  enqueue: (agentId: string, text: string, link: { crew: string; n: number }) => EnqueueResult = () => ({ ok: false, error: 'no queue' });
  /** The agent of a session, for what the tool team says of it; set by the daemon. */
  agent: (agentId: string) => Agent | undefined = () => undefined;
  /** git in a folder: its output, or undefined when it fails. Set by the daemon, for the verdicts and the merges. */
  git: (dir: string, args: string[]) => Promise<string | undefined> = async () => undefined;
  /** The ledger (daemon/ledger.ts): each request and each verdict of a reviewer, set by the daemon. */
  record: (entry: Extract<LedgerEntry, { kind: 'request' | 'review' | 'approval' | 'delivered' }>) => void = () => {};
  /** A request of a session now waits for your approval: the daemon tells you (a notification). */
  onApproval: (crew: Crew, request: CrewRequest, delivery: Delivery) => void = () => {};
  /** The lead of a team said its work is delivered: the daemon tells you. */
  onDelivered: (crew: Crew, item: Delivered) => void = () => {};
  /** The root of the git repository of the folder of each team, read once: where its worktrees are. */
  private readonly roots = new Map<string, string | null>();
  /**
   * The skills of the agents (daemon/skills.ts), set by the daemon: fetched into the cache of Forchetta when a team
   * uses them, then given to each session as a plugin of its own. By default nothing is fetched and no one has any.
   */
  skills: { ensure: (ids: readonly string[]) => Promise<{ failed: { id: string; error: string }[] }>; plugin: (key: string, ids: readonly string[]) => string | undefined } = {
    ensure: async () => ({ failed: [] }),
    plugin: () => undefined,
  };

  /** The skills of some agents in the cache; what could not be fetched, in a line for the panel. */
  private async fetchSkills(people: readonly { skills?: string[] }[]): Promise<string | undefined> {
    const ids = people.flatMap((person) => person.skills ?? []);
    if (ids.length === 0) return undefined;
    const { failed } = await this.skills.ensure(ids);
    if (failed.length === 0) return undefined;
    this.log(`skills not fetched: ${failed.map((item) => `${item.id} (${item.error})`).join('; ')}`, 'warn');
    return `skills not downloaded, the agents started without them: ${failed.map((item) => `${item.id} (${item.error})`).join('; ')}`;
  }

  /** The plugin with the skills of one session of a team, for claude --plugin-dir. */
  private pluginOf(crew: Crew, name: string, skills: readonly string[] | undefined): string | undefined {
    return skills && skills.length > 0 ? this.skills.plugin(`${crew.id}/${name}`, skills) : undefined;
  }

  constructor(
    private readonly dir: string | undefined,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {
    if (!dir || !existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const crew = readDataJson(join(dir, file), `team ${file}`, this.log) as Crew | undefined;
      if (crew && typeof crew.id === 'string' && typeof crew.name === 'string' && Array.isArray(crew.members)) this.crews.set(crew.id, crew);
      else if (crew !== undefined) this.log(`team ${file}: not a team, ignored (the file stays as it is)`, 'warn');
    }
    for (const crew of this.crews.values()) this.restoreWaits(crew);
  }

  /** The waits a team had when the daemon stopped: the same again, for their sessions to collect. */
  private restoreWaits(crew: Crew, now = Date.now()): void {
    for (const wait of Array.isArray(crew.waits) ? crew.waits : []) {
      if (typeof wait?.id !== 'string' || typeof wait.by !== 'string' || !Array.isArray(wait.requests) || typeof wait.until !== 'number') continue;
      const waiter: Waiter = {
        id: wait.id,
        crewId: crew.id,
        by: wait.by,
        requests: new Set(wait.requests.filter((n) => typeof n === 'number')),
        until: wait.until,
        listeners: [],
        timer: setTimeout(() => this.release(wait.id), Math.max(wait.until + 30_000 - now, RESTORED_WAIT_GRACE_MS)),
      };
      waiter.timer.unref?.();
      this.waiters.set(wait.id, waiter);
      this.log(`team "${crew.name}": waiting again for the answers to ${[...waiter.requests].map((n) => `#${n}`).join(', ')}`);
    }
  }

  get(id: string): Crew | undefined {
    return this.crews.get(id);
  }

  /**
   * The teams whose sessions now cost more than their budget, and were not said yet: each is marked, so that it is
   * said once. `costOf` is what a session cost (its status line).
   */
  overBudget(costOf: (agentId: string) => number, now = Date.now()): { crew: Crew; usd: number }[] {
    const over: { crew: Crew; usd: number }[] = [];
    for (const crew of this.crews.values()) {
      if (!crew.budgetUsd || crew.budgetSaidAt) continue;
      const usd = Object.values(crew.agents).reduce((sum, agentId) => sum + costOf(agentId), 0);
      if (usd < crew.budgetUsd) continue;
      crew.budgetSaidAt = now;
      this.changed(crew);
      over.push({ crew, usd });
    }
    return over;
  }

  list(): Crew[] {
    return [...this.crews.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  summaries(): CrewSummary[] {
    return this.list().map((crew) => ({
      id: crew.id,
      name: crew.name,
      ...(crew.budgetUsd ? { budgetUsd: crew.budgetUsd } : {}),
      ...(crew.lead.kind === 'claude' ? { lead: crew.lead.name } : {}),
      ...(crew.deliverable ? { deliverable: fillParams(crew.deliverable, crew.values) } : {}),
      ...(crew.delivered?.length ? { delivered: crew.delivered.at(-1) } : {}),
      ...(crew.values ? { values: { ...crew.values } } : {}),
      ...(crew.auto ? { auto: crew.auto.name } : {}),
      ...(crew.stoppedAt ? { stoppedAt: crew.stoppedAt, ...(crew.stopReason ? { stopReason: crew.stopReason } : {}) } : {}),
      ...(crew.endedAt ? { endedAt: crew.endedAt } : {}),
      recipients: [
        ...(crew.lead.kind === 'claude' ? [{ name: crew.lead.name, agentId: crew.agents.lead, lead: true }] : []),
        ...crew.members.map((member) => ({
          name: member.name,
          agentId: crew.agents[member.name],
          talk: effectiveTalk(crew, member),
          ...(member.paths ? { paths: member.paths } : {}),
          ...(member.reviews ? { reviews: true } : {}),
          ...(member.reportsTo !== undefined ? { reportsTo: member.reportsTo } : {}),
          ...(member.canLead ? { canLead: true } : {}),
          ...(member.approve ? { approve: true } : {}),
        })),
      ],
      requests: (crew.requests ?? []).slice(-SHOWN_REQUESTS).map((request) => ({
        ...request,
        text: clip(request.text, SHOWN_TEXT),
        deliveries: request.deliveries.map((delivery) => ({
          ...delivery,
          ...(delivery.answer ? { answer: clip(delivery.answer, SHOWN_TEXT) } : {}),
          ...(delivery.questions ? { questions: delivery.questions.map((question) => ({ ...question, text: clip(question.text, SHOWN_TEXT) })) } : {}),
        })),
      })),
    }));
  }

  /** Every request of a team that is kept (the last 200), whole: the thread of the panel. */
  thread(crewId: string): CrewRequest[] | undefined {
    return this.crews.get(crewId)?.requests ?? (this.crews.has(crewId) ? [] : undefined);
  }

  /** The verdicts of the reviewers of a team, for its thread. */
  reviewsOf(crewId: string): ReviewRecord[] {
    return this.crews.get(crewId)?.reviews ?? [];
  }

  /**
   * The run of a team for its replay: its file, and what the ledger says of its sessions (their costs, the files of
   * their turns), each by the name of its agent.
   */
  replay(crewId: string, entries: readonly LedgerEntry[], now = Date.now()): ReplayData | undefined {
    const crew = this.crews.get(crewId);
    if (!crew) return undefined;
    const names = new Map(Object.entries(crew.agents).map(([key, agentId]) => [agentId, key === 'lead' && crew.lead.kind === 'claude' ? crew.lead.name : key]));
    const usage: ReplayUsage[] = [];
    for (const entry of entries) {
      if ((entry.kind !== 'cost' && entry.kind !== 'turn') || !names.has(entry.agent)) continue;
      const who = names.get(entry.agent)!;
      usage.push(entry.kind === 'cost' ? { t: entry.t, who, usd: entry.usd } : { t: entry.t, who, files: entry.files ?? [], ...(entry.ms !== undefined ? { ms: entry.ms } : {}) });
    }
    return replayOf(crew, usage, now);
  }

  /** What the lead of a team delivered, for its thread. */
  deliveredOf(crewId: string): Delivered[] {
    return this.crews.get(crewId)?.delivered ?? [];
  }

  /**
   * A text for a session that leads others (the Claude lead, or a member others report to), with the changes of
   * its members it has not been told yet: its system prompt lists them as they were when it started. `done` is
   * called once the text is in its queue, to forget them.
   */
  private forManager(crew: Crew, name: string, text: string): { text: string; done: () => void } {
    const lead = crew.lead.kind === 'claude' && crew.lead.name === name;
    const member = lead ? undefined : crew.members.find((candidate) => candidate.name === name);
    const notes = (lead ? crew.leadNotes : member?.notes) ?? [];
    if (notes.length === 0) return { text, done: () => {} };
    return {
      text: `${text}\n\n(The team changed: ${notes.join('; ')}.)`,
      done: () => {
        if (lead) delete crew.leadNotes;
        else if (member) delete member.notes;
      },
    };
  }

  /** A change of the team, for the next text that reaches a session that leads: a member by its name, the lead with undefined. */
  private noteFor(crew: Crew, manager: string | undefined, note: string): void {
    if (manager === undefined) {
      if (crew.lead.kind === 'claude') crew.leadNotes = [...(crew.leadNotes ?? []), note];
      return;
    }
    const member = crew.members.find((candidate) => candidate.name === manager);
    if (member) member.notes = [...(member.notes ?? []), note];
  }

  /** A change of a member, for the one it reports to, and for the Claude lead when that is someone else. */
  private noteAbove(crew: Crew, member: Pick<CrewMemberSpec, 'reportsTo'>, note: string, forLead = note): void {
    this.noteFor(crew, member.reportsTo, note);
    if (member.reportsTo !== undefined) this.noteFor(crew, undefined, forLead);
  }

  /** The name of the worktree of a member, when it has one (and the folder of the team is in git). */
  private worktreeOf(crew: Crew, member: CrewMemberSpec): string | undefined {
    return effectiveWorktree(crew, member) ? worktreeName(crew.id, crew.name, member.name) : undefined;
  }

  /** Where a member works, for the tool team: its worktree and branch, or the folder of the team. */
  private placeText(crew: Crew, member: CrewMemberSpec): string {
    const name = this.worktreeOf(crew, member);
    if (!name) return 'in the folder of the team';
    const root = this.gitInfo(crew.cwd).root ?? crew.cwd;
    const dir = join(root, '.claude', 'worktrees', name);
    const branch = this.gitInfo(dir).branch;
    return `own worktree ${dir}${branch ? `, branch ${branch}` : ''}`;
  }

  /** The agent of a recipient: "lead" is the key of a Claude lead, every member its name. */
  private agentOf(crew: Crew, name: string): string | undefined {
    if (crew.lead.kind === 'claude' && crew.lead.name === name) return crew.agents.lead;
    return crew.agents[name];
  }

  /** Who a session is in its team: the lead or a member, by name. */
  whoami(agentId: string): { crew: Crew; name: string; role: 'lead' | 'member'; talk?: 'oneway' | 'twoway'; member?: CrewMemberSpec } | undefined {
    for (const crew of this.crews.values()) {
      if (crew.lead.kind === 'claude' && crew.agents.lead === agentId) return { crew, name: crew.lead.name, role: 'lead' };
      const member = crew.members.find((candidate) => crew.agents[candidate.name] === agentId);
      if (member) return { crew, name: member.name, role: 'member', talk: effectiveTalk(crew, member), member };
    }
    return undefined;
  }

  /** The tools of the team a session has: the lead, the members others report to, the members that answer. */
  toolsOf(agentId: string): TeamTool[] {
    const me = this.whoami(agentId);
    if (!me) return [];
    return teamToolsFor(me.crew, me.member ?? 'lead');
  }

  /** The names of the members a session gives requests to: those that report to it (the lead: those with no one else above). */
  private reportsNames(crew: Crew, name: string): string[] {
    const lead = crew.lead.kind === 'claude' && crew.lead.name === name;
    return reportsOf(crew.members, lead ? undefined : name).map((member) => member.name);
  }

  /**
   * The request a session works on now, the one its new requests are part of: the one it took (sent, working), else
   * the last one it passed on and still waits on.
   */
  private workingOn(crew: Crew, agentId: string): number | undefined {
    let passed: number | undefined;
    for (const request of [...(crew.requests ?? [])].reverse()) {
      for (const delivery of request.deliveries) {
        if (delivery.agentId !== agentId) continue;
        if (delivery.status === 'working' || delivery.status === 'sent') return request.n;
        if (delivery.status === 'delegated') passed ??= request.n;
      }
    }
    return passed;
  }

  /** Why some names are not members a session can send to: who they report to, and who reports to it. */
  private notYours(crew: Crew, names: readonly string[], reports: readonly string[]): string {
    const said = names.map((name) => {
      const member = crew.members.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      return member ? `${member.name} reports to ${managerName(crew, member)}` : `"${name}" is not a member of the team`;
    });
    return `${said.join('; ')}. You send requests only to the members that report to you (${reports.join(', ') || 'none'}): the work of the others goes through the one they report to.`;
  }

  /**
   * A request to some recipients of a team: from you (anyone; all the members when `to` is empty), or from its
   * Claude lead or a member others report to (only to the members that report to it; "all" is all of them). Each
   * one gets it in its queue; a recipient with no session gets a failed delivery. `parent`: the request the sender
   * works on, which this one is part of.
   */
  request(crewId: string, to: readonly string[], text: string, from = 'the user', now = Date.now(), parent?: number): Result<{ n: number; to: string[] }> {
    const crew = this.crews.get(crewId);
    if (!crew) return { ok: false, error: 'unknown team' };
    if (crew.stoppedAt) return { ok: false, error: stoppedText(crew) };
    const user = from === 'the user';
    // Yours with the values of the team in place of its parameters: "Fix {ticket}" as the team started.
    const written = text.replace(/\r\n?/g, '\n').trim();
    const body = user ? fillParams(written, crew.values) : written;
    if (!body) return { ok: false, error: 'write the request first' };
    const members = crew.members.map((member) => member.name);
    const reports = user ? members : this.reportsNames(crew, from);
    const names = user && crew.lead.kind === 'claude' ? [crew.lead.name, ...members] : reports;
    const all = to.length === 0 || to.some((name) => name.toLowerCase() === 'all');
    const wanted = to.map((name) => name.toLowerCase());
    if (!user && !all) {
      const strangers = to.filter((name) => !reports.some((report) => report.toLowerCase() === name.toLowerCase()));
      if (strangers.length > 0) return { ok: false, error: this.notYours(crew, strangers, reports) };
    }
    const targets = all ? reports : names.filter((name) => wanted.includes(name.toLowerCase()));
    if (targets.length === 0) return { ok: false, error: user ? `nobody to send it to: the members are ${members.join(', ')}` : 'nobody reports to you: there is nobody to send it to' };
    const open = (crew.requests ?? []).flatMap((request) => request.deliveries).filter((delivery) => OPEN.includes(delivery.status)).length;
    if (open + targets.length > MAX_OPEN_DELIVERIES) {
      return { ok: false, error: `${open} requests of the team are still open (at most ${MAX_OPEN_DELIVERIES}): wait for some answers first` };
    }
    const n = Math.max(0, ...(crew.requests ?? []).map((request) => request.n)) + 1;
    const request: CrewRequest = { n, from, text: body, createdAt: now, deliveries: [], ...(parent !== undefined ? { parent } : {}) };
    const held: Delivery[] = [];
    for (const name of targets) {
      const agentId = this.agentOf(crew, name);
      const member = crew.members.find((candidate) => candidate.name === name);
      // A member keeps, for this request, the → / ⇄ it has now; one whose → / ⇄ changed is told so when it gets it.
      const talk = member ? effectiveTalk(crew, member) : undefined;
      const delivery: Delivery = { to: name, agentId, status: 'queued', at: now, ...(talk ? { talk } : {}) };
      if (!agentId) Object.assign(delivery, { status: 'failed', reason: 'no session' });
      // A request of a session to a member whose arrow asks for your approval waits for it; yours goes.
      else if (!user && member?.approve) {
        delivery.status = 'approval';
        held.push(delivery);
      } else this.dispatch(crew, request, delivery);
      request.deliveries.push(delivery);
    }
    crew.requests = [...(crew.requests ?? []), request].slice(-KEPT_REQUESTS);
    for (const delivery of held) this.onApproval(crew, request, delivery);
    this.record({ t: now, kind: 'request', team: crew.name, n, from, to: targets });
    this.log(`team "${crew.name}": request #${n} from ${from} to ${targets.join(', ')}${parent !== undefined ? ` (for #${parent})` : ''}`);
    this.changed(crew);
    return { ok: true, n, to: targets };
  }

  /**
   * A request into the queue of one recipient, with its header and what changed for it since its system prompt (how
   * it talks, its files, who it reports to) and, for a session that leads others, what changed among them.
   */
  private dispatch(crew: Crew, request: CrewRequest, delivery: Delivery): void {
    if (crew.stoppedAt) {
      Object.assign(delivery, { status: 'cancelled', reason: stoppedText(crew) });
      return;
    }
    const member = crew.members.find((candidate) => candidate.name === delivery.to);
    const notes = [
      member?.talkNote && delivery.talk ? talkNote(delivery.talk) : '',
      member?.pathsNote ? pathsNote(member.paths) : '',
      member?.reportsToNote ? reportsToNote(managerName(crew, member)) : '',
    ].filter(Boolean);
    const full = this.forManager(crew, delivery.to, `${REQUEST_HEADER(request.n, request.from)}\n${delivery.text ?? request.text}${notes.length > 0 ? `\n\n${notes.join('\n')}` : ''}`);
    const queued = delivery.agentId ? this.enqueue(delivery.agentId, full.text, { crew: crew.id, n: request.n }) : ({ ok: false, error: 'no session' } as const);
    if (queued.ok) {
      delivery.commandId = queued.command.id;
      if (member?.talkNote) delete member.talkNote;
      if (member?.pathsNote) delete member.pathsNote;
      if (member?.reportsToNote) delete member.reportsToNote;
      full.done();
    } else Object.assign(delivery, { status: 'failed', reason: queued.error });
  }

  /**
   * Your decision on a request that waits for your approval: it goes (with the text you changed, if you did), or it
   * is sent back to the session that sent it, with your note, which gets it as a new prompt (or in its wait).
   */
  decide(crewId: string, n: number, to: string, approve: boolean, options: { note?: string; text?: string } = {}, now = Date.now()): Result<{ status: DeliveryStatus }> {
    const crew = this.crews.get(crewId);
    if (!crew) return { ok: false, error: 'unknown team' };
    const request = (crew.requests ?? []).find((candidate) => candidate.n === n);
    const delivery = request?.deliveries.find((candidate) => candidate.to.toLowerCase() === to.trim().toLowerCase());
    if (!request || !delivery) return { ok: false, error: `no request #${n} to ${to}` };
    if (delivery.status !== 'approval') return { ok: false, error: `request #${n} to ${delivery.to} does not wait for your approval` };
    if (crew.stoppedAt) return { ok: false, error: stoppedText(crew) };
    const note = (options.note ?? '').replace(/\r\n?/g, '\n').trim().slice(0, QUESTION_MAX);
    if (approve) {
      const text = (options.text ?? '').replace(/\r\n?/g, '\n').trim();
      if (text.length > REQUEST_MAX) return { ok: false, error: `the request is too long: ${REQUEST_MAX} characters at most` };
      const edited = text !== '' && text !== request.text;
      if (edited) delivery.text = text;
      delivery.approval = { decision: 'approved', at: now, ...(note ? { note } : {}), ...(edited ? { edited: true } : {}) };
      Object.assign(delivery, { status: 'queued', at: now });
      this.dispatch(crew, request, delivery);
    } else {
      delivery.approval = { decision: 'rejected', at: now, ...(note ? { note } : {}) };
      Object.assign(delivery, { status: 'cancelled', reason: `sent back by the user${note ? `: ${flat(note)}` : ''}`, at: now });
      this.sendBack(crew, request, delivery, note);
      this.settle(crew, undefined, now);
    }
    this.record({ t: now, kind: 'approval', team: crew.name, n, to: delivery.to, decision: approve ? 'approved' : 'rejected' });
    this.log(`team "${crew.name}": request #${n} to ${delivery.to} ${approve ? `approved${delivery.approval.edited ? ', changed' : ''}` : 'sent back'} by the user`);
    this.changed(crew);
    return { ok: true, status: delivery.status };
  }

  /** A request you sent back: the session that sent it learns why, unless it waits for its answers (the wait says it). */
  private sendBack(crew: Crew, request: CrewRequest, delivery: Delivery, note: string): void {
    const asker = this.agentOf(crew, request.from);
    if (!asker || crew.stoppedAt || this.waiterFor(crew.id, request.n)) return;
    const text = this.forManager(crew, request.from, `${SENT_BACK_HEADER(request.n, delivery.to)}\n${note || '(no reason given)'}\n\nChange the request and send it again with send_request, or go on without it.`);
    const queued = this.enqueue(asker, text.text, { crew: crew.id, n: request.n });
    if (queued.ok) text.done();
    // Tracked as what comes back of this delivery: the request it was part of is not over until it is read.
    delivery.reply = queued.ok ? { status: 'queued', commandId: queued.command.id } : { status: 'failed', reason: queued.error };
  }

  /** deliver of the Claude lead: the work of the team is handed over, and you are told. */
  deliver(agentId: string, summary: string, where: string | undefined, now = Date.now()): Result<{ at: number }> {
    const me = this.whoami(agentId);
    if (!me || me.role !== 'lead') return { ok: false, error: 'only the lead of a team says that its work is delivered' };
    const text = summary.replace(/\r\n?/g, '\n').trim();
    if (!text) return { ok: false, error: 'say what the team delivered' };
    const place = (where ?? '').trim();
    const crew = me.crew;
    const item: Delivered = { at: now, by: me.name, summary: clip(text, QUESTION_MAX), ...(place ? { where: clip(flat(place), 500) } : {}) };
    crew.delivered = [...(crew.delivered ?? []), item].slice(-KEPT_DELIVERED);
    this.record({ t: now, kind: 'delivered', team: crew.name, by: me.name, ...(item.where ? { where: item.where } : {}) });
    this.log(`team "${crew.name}": ${me.name} delivered${item.where ? ` (${item.where})` : ''}`);
    this.onDelivered(crew, item);
    this.changed(crew);
    return { ok: true, at: now };
  }

  /**
   * send_request of a session of a team: the Claude lead, or a member others report to, to the members that report
   * to it. The request is part of the one the session works on.
   */
  requestFrom(agentId: string, to: readonly string[], text: string, now = Date.now()): Result<{ n: number; to: string[] }> {
    const me = this.whoami(agentId);
    if (!me || (me.role === 'member' && this.reportsNames(me.crew, me.name).length === 0)) {
      return { ok: false, error: 'only the lead of a team, or a member others report to, can send requests' };
    }
    return this.request(me.crew.id, to, text, me.name, now, this.workingOn(me.crew, agentId));
  }

  /**
   * ask_lead of a member that answers: a question about the request it is working on (the last one it got), to
   * whoever sent it. A session (the Claude lead, or a member it reports to) gets it in its queue; a request of yours
   * has it wait for you in the panel of the team.
   */
  question(agentId: string, text: string, now = Date.now()): Result<{ n?: number; to: string }> {
    const me = this.whoami(agentId);
    if (!me || me.role !== 'member' || me.talk !== 'twoway') return { ok: false, error: 'only a member that answers its lead can ask it' };
    if (me.crew.stoppedAt) return { ok: false, error: stoppedText(me.crew) };
    const body = text.replace(/\r\n?/g, '\n').trim();
    if (!body) return { ok: false, error: 'write the question first' };
    const crew = me.crew;
    const found = [...(crew.requests ?? [])].reverse().flatMap((request) => request.deliveries.filter((delivery) => delivery.agentId === agentId).map((delivery) => ({ request, delivery })))[0];
    if (!found) return { ok: false, error: 'you have had no request yet: there is nothing to ask about' };
    const { request, delivery } = found;
    const question: NonNullable<Delivery['questions']>[number] = { text: clip(body, QUESTION_MAX), at: now, status: 'shown' };
    // The question goes back to whoever sent the request: a session of the team, or you.
    const asker = request.from === 'the user' ? undefined : this.agentOf(crew, request.from);
    const to = asker ? request.from : 'the user';
    if (asker) {
      const text = this.forManager(crew, request.from, `${QUESTION_HEADER(request.n, me.name)}\n${body}`);
      const queued = this.enqueue(asker, text.text, { crew: crew.id, n: request.n });
      if (!queued.ok) return { ok: false, error: `the question did not reach ${request.from}: ${queued.error}` };
      text.done();
      Object.assign(question, { status: 'queued', commandId: queued.command.id });
    }
    delivery.questions = [...(delivery.questions ?? []), question];
    this.log(`team "${crew.name}": question of ${me.name} about request #${request.n}`);
    this.changed(crew);
    return { ok: true, n: request.n, to };
  }

  /** What the tool team says: the team, who you are in it, and what each one is doing. */
  teamText(agentId: string): string | undefined {
    const me = this.whoami(agentId);
    if (!me) return undefined;
    const crew = filledSpec(me.crew);
    const open = (crew.requests ?? []).flatMap((request) => request.deliveries.filter((delivery) => OPEN.includes(delivery.status)).map((delivery) => ({ n: request.n, delivery })));
    const doing = (name: string, id: string | undefined): string => {
      const mine = open.filter((item) => item.delivery.to === name);
      const status = (delivery: Delivery): string =>
        delivery.status === 'working'
          ? 'in progress'
          : delivery.status === 'delegated'
            ? 'passed to its members, waiting for their work'
            : delivery.status === 'approval'
              ? 'waiting for the approval of the user'
              : 'waiting for its turn';
      const requests = mine.length ? `; requests: ${mine.map((item) => `#${item.n} ${status(item.delivery)}`).join(', ')}` : '';
      return `${stateText(id ? this.agent(id) : undefined)}${requests}`;
    };
    const up = me.member?.reportsTo;
    const who =
      me.role === 'lead'
        ? 'the lead'
        : up !== undefined
          ? `a member that reports to ${up}${me.talk === 'twoway' ? ' and answers it' : ''}`
          : `a member${me.talk === 'twoway' ? ' that answers its lead' : ''}`;
    const mine = this.reportsNames(crew, me.name);
    const levels = hasLevels(crew);
    const lines = [
      `Team "${crew.name}", in ${crew.cwd}. You are ${me.name}, ${who}.${mine.length > 0 && (levels || me.role === 'member') ? ` Members that report to you: ${mine.join(', ')}.` : ''}`,
      crew.lead.kind === 'claude' ? `Lead: ${crew.lead.name} — ${doing(crew.lead.name, crew.agents.lead)}` : 'Lead: the user, from the Forchetta app.',
      'Members:',
      ...crew.members.map((member) => {
        const talk = `${member.reportsTo !== undefined ? `reports to ${member.reportsTo}, ` : ''}${effectiveTalk(crew, member) === 'twoway' ? 'answers' : 'executes only'}${member.reviews ? ', reviews' : ''}${toolsText(member.tools) ? `, ${toolsText(member.tools)}` : ''}${member.approve ? ', the user approves requests to it' : ''}`;
        const files = member.paths ? ` — files: ${pathsText(member.paths)}` : '';
        return `- ${member.name} (${talk}): ${flat(member.role)}${files} — works ${this.placeText(crew, member)} — now: ${doing(member.name, crew.agents[member.name])}`;
      }),
    ];
    if (crew.deliverable) {
      const last = crew.delivered?.at(-1);
      lines.push(`It delivers: ${flat(crew.deliverable).replace(/\.$/, '')}.${last ? ` Delivered by ${last.by}${last.where ? ` (${last.where})` : ''}: ${flat(last.summary)}` : ' Not delivered yet.'}`);
    }
    const reviews = (crew.reviews ?? []).slice(-6);
    if (crew.members.some((member) => member.reviews)) {
      lines.push(
        reviews.length > 0 ? 'Last verdicts of the reviewers, newest last:' : 'No verdict of a reviewer yet.',
        ...reviews.map((review) => `- ${reviewLine(review)}`),
      );
    }
    return lines.join('\n');
  }

  /**
   * Whether a session may write a file, as a member of a team whose members have files: undefined when it may (not
   * a member, a file outside the folder of the team, one of its own files, or a file no other member has). `tree` is
   * the working tree of the file: in a worktree the folder of the team is the same place under its root.
   */
  laneCheck(agentId: string, file: string, tree: string | undefined): LaneCheck | undefined {
    const me = this.whoami(agentId);
    if (!me || me.role !== 'member') return undefined;
    const crew = me.crew;
    if (!crew.members.some((member) => member.paths)) return undefined;
    const member = crew.members.find((candidate) => candidate.name === me.name);
    if (!member) return undefined;
    // The working tree of the file is the repository of the team, or one of the worktrees Claude Code makes in it:
    // there the folder of the team is the same place under its root. Any other one is not of the team.
    const root = this.rootOf(crew);
    const ours = tree !== undefined && root !== undefined && (tree === root || tree.startsWith(`${join(root, '.claude', 'worktrees')}/`));
    const base = ours ? join(tree, relative(root, crew.cwd)) : crew.cwd;
    const rel = relative(base, file);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    if (ownsPath(member.paths, rel)) return undefined;
    const owner = crew.members.find((other) => other !== member && ownsPath(other.paths, rel));
    if (!member.paths && !owner) return undefined;
    return {
      team: crew.name,
      rel,
      ...(member.paths ? { mine: member.paths } : {}),
      ...(owner?.paths ? { owner: { name: owner.name, ...(crew.agents[owner.name] ? { agentId: crew.agents[owner.name] } : {}), paths: owner.paths } } : {}),
    };
  }

  private rootOf(crew: Crew): string | undefined {
    if (!this.roots.has(crew.id)) this.roots.set(crew.id, this.gitInfo(crew.cwd).root ?? null);
    return this.roots.get(crew.id) ?? undefined;
  }

  /**
   * The files of a member, from the panel: the guard follows them at once, the member learns them with its next
   * request (its system prompt has the old ones), the Claude lead with the next text that reaches it.
   */
  setPaths(crewId: string, name: string, input: unknown): Result<{ paths?: string[] }> {
    const crew = this.crews.get(crewId);
    const member = crew?.members.find((candidate) => candidate.name === name);
    if (!crew || !member) return { ok: false, error: 'unknown member' };
    const checked = cleanPaths(input);
    if ('error' in checked) return { ok: false, error: checked.error };
    if (JSON.stringify(member.paths ?? []) === JSON.stringify(checked.paths ?? [])) return { ok: true, ...(member.paths ? { paths: member.paths } : {}) };
    if (checked.paths) member.paths = checked.paths;
    else delete member.paths;
    member.pathsNote = true;
    this.noteAbove(crew, member, checked.paths ? `${name} now works only on ${pathsText(checked.paths)}` : `${name} no longer has files of its own`);
    this.log(`team "${crew.name}": files of ${name} ${checked.paths ? `now ${pathsText(checked.paths)}` : 'taken away'}`);
    this.changed(crew);
    return { ok: true, ...(checked.paths ? { paths: checked.paths } : {}) };
  }

  /**
   * The tool review of a member that reviews: its verdict on one commit, found by git in its own folder (its worktree
   * sees the commits of the others: one repository). An approval covers that commit and those before it.
   */
  async review(agentId: string, commit: string, verdict: string, note: string, now = Date.now()): Promise<Result<{ short: string; subject?: string; verdict: ReviewRecord['verdict'] }>> {
    const me = this.whoami(agentId);
    const member = me?.crew.members.find((candidate) => candidate.name === me.name);
    if (!me || me.role !== 'member' || !member?.reviews) return { ok: false, error: 'only a member that reviews can record a verdict' };
    const crew = me.crew;
    const wanted = commit.trim();
    if (!wanted || wanted.startsWith('-') || !/^[\w./@^~{}-]{1,200}$/.test(wanted)) return { ok: false, error: 'give the hash of the commit you reviewed' };
    const value: ReviewRecord['verdict'] | undefined = verdict === 'approve' || verdict === 'approved' ? 'approved' : verdict === 'changes' ? 'changes' : undefined;
    if (!value) return { ok: false, error: 'the verdict is "approve" or "changes"' };
    const text = note.replace(/\r\n?/g, '\n').trim();
    if (value === 'changes' && !text) return { ok: false, error: 'say in the note what to fix' };
    const dir = this.agent(agentId)?.cwd ?? crew.cwd;
    const found = await this.git(dir, ['show', '-s', '--format=%H%n%h%n%s', `${wanted}^{commit}`]);
    const [sha, short, subject] = (found ?? '').split('\n');
    if (!sha || !short || !/^[0-9a-f]{7,64}$/.test(sha)) return { ok: false, error: `git does not know the commit "${wanted}" in ${dir}` };
    const record: ReviewRecord = { sha, short, ...(subject ? { subject: clip(subject, 120) } : {}), by: me.name, verdict: value, ...(text ? { note: clip(text, REVIEW_NOTE_MAX) } : {}), at: now };
    crew.reviews = [...(crew.reviews ?? []), record].slice(-KEPT_REVIEWS);
    this.record({ t: now, kind: 'review', team: crew.name, by: me.name, verdict: value, commit: short });
    this.log(`team "${crew.name}": ${me.name} ${value === 'approved' ? 'approves' : 'asks for changes to'} ${short}`);
    this.changed(crew);
    return { ok: true, short, ...(record.subject ? { subject: record.subject } : {}), verdict: value };
  }

  /**
   * Before a git merge by a session of a team with a member that reviews: the commits of the branch of a member that
   * no approval covers. "ask", with them, so that you decide; undefined when all of them are approved, and for any
   * other command.
   */
  async decideMerge(agentId: string, line: string, cwd: string): Promise<{ decision: 'ask'; reason: string } | undefined> {
    const me = this.whoami(agentId);
    if (!me) return undefined;
    const crew = me.crew;
    const reviewers = crew.members.filter((member) => member.reviews).map((member) => member.name);
    if (reviewers.length === 0) return undefined;
    for (const command of gitCommands(line, cwd)) {
      if (command.sub !== 'merge') continue;
      const refs = mergeRefs(command.args);
      if (refs.length === 0) continue;
      const branches = await this.memberBranches(crew, command.dir);
      for (const ref of refs) {
        const owner = branches.get(ref.replace(/^refs\/heads\//, ''));
        if (!owner) continue;
        const approved = (crew.reviews ?? []).filter((review) => review.verdict === 'approved');
        const out = await this.git(command.dir, ['log', '--ignore-missing', '--format=%H %h %s', '-n', '6', ref, '^HEAD', ...approved.map((review) => `^${review.sha}`), '--']);
        if (out === undefined) continue;
        const commits = out
          .split('\n')
          .map((row) => row.trim())
          .filter(Boolean)
          .map((row) => {
            const [sha = '', short = '', ...subject] = row.split(' ');
            return { sha, short, subject: subject.join(' ') };
          });
        if (commits.length === 0) continue;
        const who = reviewers.length === 1 ? reviewers[0]! : `${reviewers.slice(0, -1).join(', ')} and ${reviewers.at(-1)!}`;
        const listed = commits.slice(0, 5).map((commit) => `${commit.short} ${clip(commit.subject, 60)}`.trim());
        const last = [...approved].reverse()[0];
        const asked = [...(crew.reviews ?? [])].reverse().find((review) => review.sha === commits[0]!.sha && review.verdict === 'changes');
        return {
          decision: 'ask',
          reason: [
            `Forchetta: "${command.text}" would bring in commits of ${owner} that ${who}, who reviews in the team "${crew.name}", has not approved: ${listed.join('; ')}${commits.length > 5 ? '; and more' : ''}.`,
            asked ? `${asked.by} asked for changes on ${asked.short}${asked.note ? `: ${clip(asked.note, 160)}` : ''}.` : '',
            last ? `The last approval is of ${last.short}${last.subject ? ` (${clip(last.subject, 60)})` : ''}.` : `${who} has approved nothing yet.`,
            'Allow it only if you want them merged without that review.',
          ]
            .filter(Boolean)
            .join(' '),
        };
      }
    }
    return undefined;
  }

  /** The branches of the worktrees of the members of a team (those that do not review): branch → member. */
  private async memberBranches(crew: Crew, dir: string): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const out = await this.git(dir, ['worktree', 'list', '--porcelain']);
    if (!out) return found;
    const byFolder = new Map(crew.members.filter((member) => !member.reviews).map((member) => [`/.claude/worktrees/${worktreeName(crew.id, crew.name, member.name)}`, member.name]));
    for (const block of out.split('\n\n')) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      if (!path || !branch) continue;
      for (const [tail, name] of byFolder) if (path.endsWith(tail)) found.set(branch, name);
    }
    return found;
  }

  /** A command of the team changed status in the queue of its session: a request, an answer or a question. */
  commandChanged(command: QueuedCommand, now = Date.now()): void {
    if (!command.request) return;
    const crew = this.crews.get(command.request.crew);
    if (!crew) return;
    for (const request of crew.requests ?? []) {
      for (const delivery of request.deliveries) {
        if (delivery.commandId === command.id) {
          if (delivery.status === 'done' || delivery.status === 'delegated') return;
          const status = deliveryStatus(command);
          if (delivery.status === status && delivery.reason === command.reason) return;
          delivery.status = status;
          delivery.reason = status === 'working' ? undefined : command.reason;
          delivery.at = now;
          // Cancelled or failed: a request passed on that waited only on this one may be over.
          this.settle(crew, undefined, now);
          return this.changed(crew);
        }
        if (delivery.reply?.commandId === command.id) {
          const status = passageStatus(command);
          if (delivery.reply.status === status) return;
          delivery.reply = { ...delivery.reply, status, ...(status === 'failed' ? { reason: command.reason } : {}) };
          this.settle(crew, undefined, now);
          return this.changed(crew);
        }
        const question = delivery.questions?.find((candidate) => candidate.commandId === command.id);
        if (question) {
          const status = passageStatus(command);
          if (question.status === status) return;
          question.status = status;
          this.settle(crew, undefined, now);
          return this.changed(crew);
        }
      }
    }
  }

  /**
   * The hooks of a session of a team: the Stop after it took a request ends that request, with its last message,
   * which goes back to the session that asked when the member answers; a request it passed on to its own members
   * waits for their work instead (delegated). A StopFailure fails the request it was working on, the end of the
   * session every request it had open.
   */
  hook(agent: Agent, payload: HookPayload, now = Date.now()): void {
    const crewId = agent.team?.crew;
    const crew = crewId ? this.crews.get(crewId) : undefined;
    const event = payload.hook_event_name;
    // The session that opened the folder said hello: the trust dialog was answered, the others can start.
    if (crew?.waitingTrust && event === 'SessionStart' && this.agentOf(crew, crew.waitingTrust) === agent.id) {
      void this.afterTrust(crew);
      return;
    }
    if (!crew?.requests) return;
    if (event !== 'Stop' && event !== 'StopFailure' && event !== 'SessionEnd') return;
    let changed = false;
    let ended = false;
    const message = payload.last_assistant_message ? clip(payload.last_assistant_message, ANSWER_MAX) : undefined;
    for (const request of crew.requests) {
      for (const delivery of request.deliveries) {
        if (delivery.agentId !== agent.id) continue;
        const taken = delivery.status === 'working' || delivery.status === 'sent';
        if (!taken && !(delivery.status === 'delegated' && event === 'SessionEnd')) continue;
        if (event === 'Stop') {
          // Since it took the request (delivery.at), did it ask its lead something? Then its turn ends waiting for
          // the answer, and that message would tell the lead nothing new: the answer comes with the next request.
          const asked = (delivery.questions ?? []).some((question) => question.at >= delivery.at);
          delivery.reason = undefined;
          if (message) delivery.answer = message;
          ended = true;
          // It passed part of the work to its own members: done when their work is.
          if (this.pending(crew, request.n, delivery.to, true)) delivery.status = 'delegated';
          else {
            delivery.status = 'done';
            if (!asked) this.answerBack(crew, request, delivery);
          }
        } else {
          delivery.status = 'failed';
          delivery.reason = event === 'SessionEnd' ? 'the session ended' : 'the turn ended with an error';
        }
        delivery.at = now;
        changed = true;
      }
    }
    if (event === 'Stop') {
      // A turn that took no request worked on what came back (an answer, a question): its message is the latest
      // word on the requests it passed on.
      if (!ended && message) {
        for (const request of crew.requests) for (const delivery of request.deliveries) if (delivery.agentId === agent.id && delivery.status === 'delegated') delivery.answer = message;
      }
      if (this.settle(crew, agent.id, now)) changed = true;
    }
    if (changed) {
      this.changed(crew);
      this.wake(crew.id);
    }
  }

  /**
   * Whether the work a session passed on, while it worked on request n, is still going: a request of its own with n
   * as parent still open, or an answer or a question on its way to it. `own`: at its own Stop, what was pasted in
   * its terminal before it (sent) has been read.
   */
  private pending(crew: Crew, n: number, name: string, own: boolean): boolean {
    const coming = (status: string | undefined): boolean => status === 'queued' || status === 'held' || (status === 'sent' && !own);
    for (const request of crew.requests ?? []) {
      if (request.parent !== n || request.from !== name) continue;
      for (const delivery of request.deliveries) {
        if (OPEN.includes(delivery.status) || coming(delivery.reply?.status)) return true;
        if (delivery.questions?.some((question) => coming(question.status))) return true;
      }
    }
    return false;
  }

  /** Whether a session is in the middle of a turn: it will finish what it passed on at its own Stop. */
  private busy(agentId: string | undefined): boolean {
    const state = agentId ? this.agent(agentId)?.state : undefined;
    return state === 'working' || state === 'compacting' || state === 'waiting';
  }

  /**
   * Ends the requests passed on whose work is over: their answer (the last message of the session about them) goes
   * back like any other. Again, until nothing changes: a senior done can end the request of the lead above it.
   * `stopped`: the session whose Stop this is. Whether anything ended.
   */
  private settle(crew: Crew, stopped: string | undefined, now = Date.now()): boolean {
    let changed = false;
    for (let again = true; again; ) {
      again = false;
      for (const request of crew.requests ?? []) {
        for (const delivery of request.deliveries) {
          if (delivery.status !== 'delegated') continue;
          const own = delivery.agentId === stopped;
          if (this.pending(crew, request.n, delivery.to, own) || (!own && this.busy(delivery.agentId))) continue;
          delivery.status = 'done';
          delivery.at = now;
          this.answerBack(crew, request, delivery);
          this.log(`team "${crew.name}": ${delivery.to} is done with #${request.n}, with the work it passed on`);
          again = changed = true;
        }
      }
    }
    return changed;
  }

  /** The answer of a member ⇄ to a request of a session of the team goes into the queue of that session. */
  private answerBack(crew: Crew, request: CrewRequest, delivery: Delivery): void {
    if (request.from === 'the user' || crew.stoppedAt) return;
    const member = crew.members.find((candidate) => candidate.name === delivery.to);
    // The → / ⇄ of when the request left: a change counts from the next request.
    if (!member || (delivery.talk ?? effectiveTalk(crew, member)) !== 'twoway') return;
    const asker = this.agentOf(crew, request.from);
    if (!asker) return;
    // The session waits for this answer (wait_for_answers): it is held for it, and given there.
    if (this.waiterFor(crew.id, request.n)) {
      delivery.reply = { status: 'held' };
      return;
    }
    this.sendAnswer(crew, request, delivery, asker);
  }

  /** The answer of a member into the queue of the session that asked, as a new prompt. */
  private sendAnswer(crew: Crew, request: CrewRequest, delivery: Delivery, asker: string): void {
    if (crew.stoppedAt) return;
    const text = this.forManager(crew, request.from, `${ANSWER_HEADER(request.n, delivery.to)}\n${delivery.answer?.trim() || '(it ended its turn with no message)'}`);
    const queued = this.enqueue(asker, text.text, { crew: crew.id, n: request.n });
    if (queued.ok) text.done();
    delivery.reply = queued.ok ? { status: 'queued', commandId: queued.command.id } : { status: 'failed', reason: queued.error };
    this.log(`team "${crew.name}": answer of ${delivery.to} to #${request.n} ${queued.ok ? `queued for ${request.from}` : `not delivered: ${queued.error}`}`);
  }

  /** Whether a wait is of this session. */
  waitOf(id: string, agentId: string): boolean {
    return this.waiters.get(id)?.by === agentId;
  }

  /** The wait that holds the answers of this request, if any. */
  private waiterFor(crewId: string, n: number, now = Date.now()): Waiter | undefined {
    return [...this.waiters.values()].find((waiter) => waiter.crewId === crewId && waiter.requests.has(n) && now < waiter.until);
  }

  /** Something moved in a team: the polls of its waits look again. */
  private wake(crewId: string): void {
    for (const waiter of this.waiters.values()) {
      if (waiter.crewId !== crewId) continue;
      const listeners = waiter.listeners;
      waiter.listeners = [];
      for (const listener of listeners) listener();
    }
  }

  /**
   * wait_for_answers of the Claude lead, or of a member others report to: from now until `minutes` pass, the
   * answers of these requests (all its requests still open, when none is given) are held for it instead of going
   * into its queue.
   */
  startWait(agentId: string, requests: readonly number[] | undefined, minutes: number | undefined, now = Date.now()): Result<{ id: string; requests: number[] }> {
    const me = this.whoami(agentId);
    if (!me || (me.role === 'member' && this.reportsNames(me.crew, me.name).length === 0 && !(me.crew.requests ?? []).some((request) => request.from === me.name))) {
      return { ok: false, error: 'only the lead of a team, or a member others report to, can wait for answers' };
    }
    const crew = me.crew;
    const mine = (crew.requests ?? []).filter((request) => request.from === me.name);
    const chosen = requests?.length
      ? mine.filter((request) => requests.includes(request.n))
      : mine.filter((request) => request.deliveries.some((delivery) => OPEN.includes(delivery.status) || delivery.reply?.status === 'held'));
    if (requests?.length && chosen.length === 0) return { ok: false, error: `no request of yours has those numbers: yours are ${mine.map((request) => `#${request.n}`).join(', ') || 'none yet'}` };
    const id = randomUUID();
    const span = Math.min(MAX_WAIT_MS, Math.max(60_000, Math.round((minutes ?? 5) * 60_000)));
    const waiter: Waiter = {
      id,
      crewId: crew.id,
      by: agentId,
      requests: new Set(chosen.map((request) => request.n)),
      until: now + span,
      listeners: [],
      // A wait nobody collects (the call was cut): what it held goes to the lead as prompts, as without it.
      timer: setTimeout(() => this.release(id), span + 30_000),
    };
    waiter.timer.unref?.();
    this.waiters.set(id, waiter);
    this.save(crew);
    this.log(`team "${crew.name}": ${me.name} waits for the answers to ${[...waiter.requests].map((n) => `#${n}`).join(', ') || 'no request'}`);
    return { ok: true, id, requests: [...waiter.requests] };
  }

  /**
   * A poll of a wait: as soon as every delivery of its requests is over, or its time is up, the answers (and the
   * end of the members that execute only); else, after `maxMs`, not done yet. The answers given here are not
   * sent again as prompts.
   */
  async pollWait(id: string, maxMs: number, now: () => number = Date.now): Promise<Result<{ done: boolean; answers: WaitAnswer[]; open: string[] }>> {
    const first = this.waiters.get(id);
    if (!first) return { ok: false, error: 'this wait is over: the answers that came after it reach you as prompts' };
    if (!this.waitOver(first, now()) && !this.crews.get(first.crewId)?.stoppedAt) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, Math.min(maxMs, first.until - now())));
        first.listeners.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const waiter = this.waiters.get(id);
    if (!waiter) return { ok: false, error: 'this wait is over' };
    const crew = this.crews.get(waiter.crewId);
    if (!crew) return { ok: false, error: 'unknown team' };
    const deliveries = (crew.requests ?? []).filter((request) => waiter.requests.has(request.n)).flatMap((request) => request.deliveries.map((delivery) => ({ request, delivery })));
    const open = deliveries.filter(({ delivery }) => OPEN.includes(delivery.status)).map(({ request, delivery }) => `#${request.n} ${delivery.to}`);
    if (open.length > 0 && now() < waiter.until && !crew.stoppedAt) return { ok: true, done: false, answers: [], open };
    // Over: what is held goes to the lead here; what is still open will reach it as prompts.
    const answers: WaitAnswer[] = deliveries
      .filter(({ delivery }) => !OPEN.includes(delivery.status))
      .map(({ request, delivery }) => {
        const held = delivery.reply?.status === 'held';
        if (held) delivery.reply = { status: 'delivered', byWait: true };
        return {
          n: request.n,
          from: delivery.to,
          status: delivery.status,
          ...(delivery.talk ? { talk: delivery.talk } : {}),
          ...(held && delivery.answer ? { answer: delivery.answer } : {}),
          ...(delivery.reason ? { reason: delivery.reason } : {}),
        };
      });
    clearTimeout(waiter.timer);
    this.waiters.delete(id);
    this.log(`team "${crew.name}": wait over, ${answers.filter((answer) => answer.answer).length} answers${open.length ? `, ${open.length} still open` : ''}`);
    this.changed(crew);
    return { ok: true, done: true, answers, open };
  }

  private waitOver(waiter: Waiter, now: number): boolean {
    const crew = this.crews.get(waiter.crewId);
    const deliveries = (crew?.requests ?? []).filter((request) => waiter.requests.has(request.n)).flatMap((request) => request.deliveries);
    return now >= waiter.until || deliveries.every((delivery) => !OPEN.includes(delivery.status));
  }

  /** A wait that nobody collected: its held answers go to the session that waited, as prompts. */
  private release(id: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    const crew = this.crews.get(waiter.crewId);
    if (!crew) return;
    for (const request of crew.requests ?? []) {
      if (!waiter.requests.has(request.n)) continue;
      for (const delivery of request.deliveries) if (delivery.reply?.status === 'held') this.sendAnswer(crew, request, delivery, waiter.by);
    }
    this.changed(crew);
  }

  private changed(crew: Crew): void {
    this.save(crew);
    this.onChange();
    // A wait of the lead looks again: a delivery may be over (done, failed, cancelled).
    this.wake(crew.id);
  }

  /** What the sessions of a team cost so far, at API prices: `costOf` is what a session cost (its status line). */
  costOf(crewId: string, costOf: (agentId: string) => number): number {
    const crew = this.crews.get(crewId);
    return crew ? Object.values(crew.agents).reduce((sum, agentId) => sum + costOf(agentId), 0) : 0;
  }

  /** The automation a team is a run of (shared/automation.ts). */
  markAuto(crewId: string, auto: { id: string; name: string }): void {
    const crew = this.crews.get(crewId);
    if (!crew) return;
    crew.auto = auto;
    this.changed(crew);
  }

  /**
   * Stops a team: it takes no new request, and nothing more goes into the queues of its sessions. What was not taken
   * yet is cancelled (taken back from the queues: requests, answers, questions, and those waiting for your approval);
   * what a session is working on it finishes, and its answer stays in the thread. The waits of its sessions end now.
   * Its sessions go on: the caller ends them (/exit) if it wants.
   */
  stop(crewId: string, reason: string, cancel: (agentId: string, commandId: string) => void, now = Date.now()): Result {
    const crew = this.crews.get(crewId);
    if (!crew) return { ok: false, error: 'unknown team' };
    if (crew.stoppedAt) return { ok: true };
    crew.stoppedAt = now;
    crew.stopReason = reason;
    const why = stoppedText(crew);
    for (const request of crew.requests ?? []) {
      const asker = request.from === 'the user' ? undefined : this.agentOf(crew, request.from);
      for (const delivery of request.deliveries) {
        if (delivery.status === 'approval' || delivery.status === 'queued' || delivery.status === 'blocked') {
          if (delivery.agentId && delivery.commandId) cancel(delivery.agentId, delivery.commandId);
          Object.assign(delivery, { status: 'cancelled', reason: why, at: now });
        }
        if (asker && delivery.reply?.status === 'queued' && delivery.reply.commandId) cancel(asker, delivery.reply.commandId);
        for (const question of delivery.questions ?? []) if (asker && question.status === 'queued' && question.commandId) cancel(asker, question.commandId);
      }
    }
    this.log(`team "${crew.name}" stopped: ${reason}`);
    this.changed(crew);
    return { ok: true };
  }

  /** A stopped team whose sessions all ended: it leaves the list of the teams (its file stays, for its thread). */
  setEnded(crewId: string, now = Date.now()): void {
    const crew = this.crews.get(crewId);
    if (!crew || crew.endedAt) return;
    crew.endedAt = now;
    this.changed(crew);
  }

  /** A team taken out of the daemon: its file goes into archive/, where nothing reads it. */
  archive(crewId: string): void {
    const crew = this.crews.get(crewId);
    if (!crew) return;
    for (const [id, waiter] of this.waiters) {
      if (waiter.crewId !== crewId) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
    }
    this.crews.delete(crewId);
    if (this.dir) {
      const file = join(this.dir, `${crewId}.json`);
      try {
        ensurePrivateDir(join(this.dir, 'archive'));
        if (existsSync(file)) renameSync(file, join(this.dir, 'archive', `${crewId}.json`));
      } catch (error) {
        this.log(`team "${crew.name}": not archived (${String(error)})`, 'warn');
      }
    }
    this.onChange();
  }

  /**
   * → / ⇄ of a member, from the next request: the requests already sent keep theirs, and the next one tells the
   * member, whose system prompt says the old one. The box and the chart follow (`changes`).
   */
  setTalk(crewId: string, name: string, talk: Talk): Result<{ changes: { agentId: string; talk: Talk }[] }> {
    const crew = this.crews.get(crewId);
    const member = crew?.members.find((candidate) => candidate.name === name);
    if (!crew || !member) return { ok: false, error: 'unknown member' };
    if (effectiveTalk(crew, member) === talk) return { ok: true, changes: [] };
    member.talk = talk;
    member.talkNote = true;
    this.noteAbove(
      crew,
      member,
      talk === 'twoway' ? `${name} now answers you` : `${name} now executes only: it will not answer`,
      talk === 'twoway' ? `${name} now answers ${member.reportsTo}` : `${name} now executes only`,
    );
    this.log(`team "${crew.name}": ${name} now ${talk === 'twoway' ? 'answers' : 'only executes'}, from the next request`);
    this.changed(crew);
    const agentId = crew.agents[name];
    return { ok: true, changes: agentId ? [{ agentId, talk }] : [] };
  }

  /**
   * Whether the requests a session sends to a member wait for your approval, from the next one: the one that sends
   * them is told with the next text that reaches it.
   */
  setApprove(crewId: string, name: string, approve: boolean): Result {
    const crew = this.crews.get(crewId);
    const member = crew?.members.find((candidate) => candidate.name === name);
    if (!crew || !member) return { ok: false, error: 'unknown member' };
    if ((member.approve === true) === approve) return { ok: true };
    if (approve) member.approve = true;
    else delete member.approve;
    this.noteFor(crew, member.reportsTo, approve ? `your requests to ${name} now wait for the approval of the user first` : `your requests to ${name} no longer wait for the approval of the user`);
    this.log(`team "${crew.name}": the requests to ${name} ${approve ? 'now wait' : 'no longer wait'} for your approval`);
    this.changed(crew);
    return { ok: true };
  }

  /**
   * A member out of the team: no more requests, the ones still in its queue cancelled (`cancel`), its box out of
   * the group; the members that reported to it now report to the one above it, and their next request tells them.
   * Its session goes on: Forchetta never ends a session, /exit does.
   */
  removeMember(crewId: string, name: string, cancel: (agentId: string, commandId: string) => void): Result<{ agentId?: string }> {
    const crew = this.crews.get(crewId);
    const member = crew?.members.find((candidate) => candidate.name === name);
    if (!crew || !member) return { ok: false, error: 'unknown member' };
    if (crew.members.length === 1) return { ok: false, error: 'a team needs at least one member' };
    const agentId = crew.agents[name];
    for (const request of crew.requests ?? []) {
      for (const delivery of request.deliveries) {
        if (delivery.to !== name || !OPEN.includes(delivery.status)) continue;
        if (agentId && delivery.commandId && (delivery.status === 'queued' || delivery.status === 'blocked')) cancel(agentId, delivery.commandId);
        delivery.status = 'cancelled';
        delivery.reason = 'taken out of the team';
      }
    }
    crew.members = crew.members.filter((candidate) => candidate !== member);
    delete crew.agents[name];
    const moved = reportsOf(crew.members, name);
    for (const report of moved) {
      if (member.reportsTo !== undefined) report.reportsTo = member.reportsTo;
      else delete report.reportsTo;
      report.reportsToNote = true;
    }
    const names = moved.map((report) => report.name).join(', ');
    this.noteAbove(
      crew,
      member,
      `${name} is no longer in the team${moved.length > 0 ? `; ${names} now report${moved.length === 1 ? 's' : ''} to you` : ''}`,
      `${name} is no longer in the team${moved.length > 0 ? `; ${names} now report${moved.length === 1 ? 's' : ''} to ${member.reportsTo}` : ''}`,
    );
    this.settle(crew, undefined);
    this.log(`team "${crew.name}": ${name} taken out of the team (the session stays)${moved.length > 0 ? `; ${names} now under ${managerName(crew, member)}` : ''}`);
    this.changed(crew);
    return { ok: true, ...(agentId ? { agentId } : {}) };
  }

  /**
   * A new member: checked with the rest of the team (names, the ceiling of members), then started like the others. It can report
   * to the lead, or to a member whose session started with the tools to lead (the tools of a session are fixed when
   * it starts).
   */
  async addMember(crewId: string, input: unknown, start: Starter = this.spawn): Promise<Result<{ agentId: string; error?: string }>> {
    const crew = this.crews.get(crewId);
    if (!crew) return { ok: false, error: 'unknown team' };
    const checked = cleanCrewSpec({ ...crew, members: [...crew.members, input] });
    if ('error' in checked) return { ok: false, error: checked.error };
    const member: CrewMemberSpec = checked.spec.members.at(-1)!;
    const manager = member.reportsTo !== undefined ? crew.members.find((candidate) => candidate.name === member.reportsTo) : undefined;
    if (manager && !manager.canLead) {
      const able = crew.members.filter((candidate) => candidate.canLead).map((candidate) => candidate.name);
      return {
        ok: false,
        error: `${manager.name} started without the tools to give requests: put ${member.name} under ${crew.lead.kind === 'claude' ? crew.lead.name : 'you'}${able.length > 0 ? ` or under ${able.join(', ')}` : ''}`,
      };
    }
    // No worktree where Claude Code could not make one: the new member shares the folder.
    if (effectiveWorktree(crew, member) && this.noWorktrees(crew.cwd)) member.worktree = false;
    const spec: CrewSpec = { ...crew, members: [...crew.members, member] };
    const skillsNote = await this.fetchSkills([member]);
    const result = await start(
      { cwd: crew.cwd, model: member.model, mode: member.mode, worktree: this.worktreeOf(crew, member) },
      {
        system: memberPrompt(spec, member),
        name: member.name,
        team: { label: member.name, role: shortRole(fillParams(member.role, crew.values)), talk: effectiveTalk(spec, member), group: crew.name, crew: crew.id },
        teamTools: teamToolsFor(spec, member),
        pluginDir: this.pluginOf(crew, member.name, member.skills),
        tools: member.tools,
      },
    );
    if (!result.ok) return { ok: false, error: result.error };
    crew.members.push(member);
    crew.agents[member.name] = result.agentId;
    const how = effectiveTalk(crew, member) === 'twoway' ? 'it answers you' : 'it executes only';
    this.noteAbove(
      crew,
      member,
      `${member.name} joined the team${hasLevels(crew) ? ' and reports to you' : ''} (${how}): ${flat(member.role)}${member.relation ? ` — how you work together: ${flat(member.relation)}` : ''}`,
      `${member.name} joined the team under ${member.reportsTo}: ${flat(member.role)}`,
    );
    this.log(`team "${crew.name}": ${member.name} added`);
    this.changed(crew);
    return { ok: true, agentId: result.agentId, ...(skillsNote ? { error: skillsNote } : {}) };
  }

  /** How a session of a team starts (spawnSession): set by the daemon, for the members that start later. */
  spawn: Starter = async () => ({ ok: false, error: 'no way to start a session' });

  /**
   * Starts the sessions of a team, then keeps it: the lead first, then the members, one after the other. In a
   * folder Claude Code does not trust yet its dialog would show in every session, and a worktree cannot be made
   * there: only the first session starts, and the others when its dialog is answered (its SessionStart), each in
   * its worktree. Elsewhere, no git repository means no worktree: the members share the folder.
   */
  async create(spec: CrewSpec, start: Starter = this.spawn, now = Date.now()): Promise<CreateResult> {
    // The name is the group of the chart: two teams with one name would be one group.
    if (this.list().some((other) => other.name.toLowerCase() === spec.name.toLowerCase())) {
      return { ok: false, error: `a team called "${spec.name}" already exists: give this one another name` };
    }
    // Its parameters: each one needs a value, given or by default, before any session reads its texts.
    const missing = missingParams(spec);
    if (missing.length > 0) return { ok: false, error: `fill the ${missing.length === 1 ? 'parameter' : 'parameters'} of the team first: ${paramsText(missing)}` };
    this.spawn = start;
    const values = valuesOf(spec);
    const crew: Crew = { ...spec, ...(Object.keys(values).length > 0 ? { values } : {}), id: randomUUID(), createdAt: now, agents: {} };
    if (Object.keys(values).length === 0) delete crew.values;
    const wantsWorktrees = spec.members.some((member) => effectiveWorktree(spec, member)) || (spec.lead.kind === 'claude' && spec.lead.worktree === true);
    const noGit = wantsWorktrees && !this.inGit(spec.cwd);
    if (noGit) this.dropWorktrees(crew);
    const waitTrust = !this.trusted(spec.cwd);
    const agentIds: string[] = [];
    const errors: string[] = [];
    let first: string | undefined;
    // The skills of everyone, fetched once before anyone starts: a session gets its plugin when it starts.
    const skillsNote = await this.fetchSkills([...(crew.lead.kind === 'claude' ? [crew.lead] : []), ...crew.members]);

    if (crew.lead.kind === 'claude') {
      const lead = crew.lead;
      first = lead.name;
      const result = await start(
        { cwd: crew.cwd, model: lead.model, mode: lead.mode, worktree: lead.worktree && !noGit && !waitTrust ? worktreeName(crew.id, crew.name, lead.name) : undefined },
        {
          system: leadPrompt(crew),
          name: lead.name,
          team: this.place(crew, { label: lead.name, role: shortRole(fillParams(lead.role, crew.values)), lead: true }),
          teamTools: teamToolsFor(crew, 'lead'),
          pluginDir: this.pluginOf(crew, lead.name, lead.skills),
          tools: lead.tools,
        },
      );
      if (result.ok) {
        crew.agents.lead = result.agentId;
        agentIds.push(result.agentId);
      } else errors.push(`${lead.name}: ${result.error}`);
    }
    if (waitTrust && errors.length === 0) {
      // Only the first: when you lead, the first member opens the folder, in the folder (no worktree yet).
      if (!first) {
        const opener = crew.members[0]!;
        first = opener.name;
        opener.worktree = false;
        const started = await this.startMembers(crew, start, { names: [opener.name], opener: true });
        agentIds.push(...started.agentIds);
        errors.push(...started.errors);
      }
      if (agentIds.length === 0) return { ok: false, error: errors[0] ?? 'no session started' };
      crew.waitingTrust = first;
      this.crews.set(crew.id, crew);
      this.save(crew);
      // It may have said hello already, while it was starting (no dialog after all): the others go now.
      const firstId = this.agentOf(crew, first);
      if (firstId && this.agent(firstId)?.sessionId) void this.afterTrust(crew);
      this.log(`team "${crew.name}" created: ${first} waits for your answer to the trust dialog of Claude Code, then the others start`);
      return {
        ok: true,
        crewId: crew.id,
        agentIds,
        error: `Claude Code asks, in the terminal of ${first}, whether you trust this folder: answer "Yes, I trust this folder" there, and the rest of the team starts${wantsWorktrees && !noGit ? ', each member in its worktree' : ''}${skillsNote ? `. ${skillsNote}` : ''}`,
      };
    }
    if (agentIds.length === 0 && errors.length > 0) return { ok: false, error: errors[0]! };
    const started = await this.startMembers(crew, start, { startedBefore: agentIds.length });
    agentIds.push(...started.agentIds);
    errors.push(...started.errors);
    if (agentIds.length === 0) return { ok: false, error: errors[0] ?? 'no session started' };
    this.crews.set(crew.id, crew);
    this.save(crew);
    const why = noGit ? 'the folder is not in a git repository: the members share it, with no worktree' : undefined;
    this.log(`team "${crew.name}" created: ${agentIds.length} sessions${errors.length ? `, ${errors.length} did not start` : ''}${why ? ', without worktrees (not a git repository)' : ''}`);
    const notes = [...(errors.length ? [`not started: ${errors.join('; ')}`] : []), ...(why ? [why] : []), ...(skillsNote ? [skillsNote] : [])];
    return { ok: true, crewId: crew.id, agentIds, ...(notes.length ? { error: notes.join('. ') } : {}) };
  }

  private place(crew: Crew, team: Omit<TeamInfo, 'group' | 'crew'>): TeamInfo {
    return { ...team, group: crew.name, crew: crew.id };
  }

  /** No worktree for anyone of the team: they share its folder. */
  private dropWorktrees(crew: Crew): void {
    crew.worktrees = false;
    for (const member of crew.members) delete member.worktree;
    if (crew.lead.kind === 'claude') delete crew.lead.worktree;
  }

  /**
   * Starts the members of a team that have no session yet (or only `names`), one after the other. Where a worktree
   * cannot be made (no git, no trust) they share the folder; `opener` is the one that opens a folder not trusted
   * yet, and changes nothing for the others.
   */
  private async startMembers(crew: Crew, start: Starter, options: { names?: readonly string[]; startedBefore?: number; opener?: boolean } = {}): Promise<{ agentIds: string[]; errors: string[] }> {
    const agentIds: string[] = [];
    const errors: string[] = [];
    if (!options.opener && crew.members.some((member) => effectiveWorktree(crew, member)) && this.noWorktrees(crew.cwd)) this.dropWorktrees(crew);
    for (const member of crew.members) {
      if (crew.agents[member.name] || (options.names && !options.names.includes(member.name))) continue;
      // A folder that does not exist, or no claude: the first error says it, no point trying the others.
      if (agentIds.length + (options.startedBefore ?? 0) === 0 && errors.length > 0) break;
      const result = await start(
        { cwd: crew.cwd, model: member.model, mode: member.mode, worktree: this.worktreeOf(crew, member) },
        {
          system: memberPrompt(crew, member),
          name: member.name,
          team: this.place(crew, { label: member.name, role: shortRole(fillParams(member.role, crew.values)), talk: effectiveTalk(crew, member) }),
          teamTools: teamToolsFor(crew, member),
          pluginDir: this.pluginOf(crew, member.name, member.skills),
          tools: member.tools,
        },
      );
      if (result.ok) {
        crew.agents[member.name] = result.agentId;
        // The members that report to it later need it to have started with the tools to lead.
        if (teamToolsFor(crew, member).includes('send_request')) member.canLead = true;
        agentIds.push(result.agentId);
      } else errors.push(`${member.name}: ${result.error}`);
    }
    return { agentIds, errors };
  }

  /** The first session of a team in a folder not trusted yet said hello: its dialog was answered, the rest starts. */
  private async afterTrust(crew: Crew): Promise<void> {
    delete crew.waitingTrust;
    this.save(crew);
    const started = await this.startMembers(crew, this.spawn, { startedBefore: 1 });
    this.log(`team "${crew.name}": trusted, ${started.agentIds.length} sessions started${started.errors.length ? `; not started: ${started.errors.join('; ')}` : ''}`);
    this.changed(crew);
  }

  private save(crew: Crew): void {
    // The waits of its sessions, as they are now: a restart takes them up again (restoreWaits).
    const waits = [...this.waiters.values()].filter((waiter) => waiter.crewId === crew.id).map((waiter) => ({ id: waiter.id, by: waiter.by, requests: [...waiter.requests], until: waiter.until }));
    if (waits.length > 0) crew.waits = waits;
    else delete crew.waits;
    if (!this.dir) return;
    try {
      ensurePrivateDir(this.dir);
      writeDataJson(join(this.dir, `${crew.id}.json`), crew);
    } catch (error) {
      this.log(`team "${crew.name}" not saved: ${String(error)}`, 'error');
    }
  }
}

/** "3f2a1bc add retries: approved by reviewer, 12:40 — looks good": a verdict, in a line. */
export function reviewLine(review: ReviewRecord): string {
  const time = new Date(review.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `${review.short}${review.subject ? ` ${clip(review.subject, 60)}` : ''}: ${review.verdict === 'approved' ? 'approved' : 'changes asked'} by ${review.by}, ${time}${review.note ? ` — ${clip(flat(review.note), 160)}` : ''}`;
}

/** The options of git merge that take the next word as their value. */
const MERGE_VALUE_OPTIONS = new Set(['-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option', '--into-name', '--cleanup']);

/** What a git merge merges: its arguments that are not options (nor their values). */
export function mergeRefs(args: readonly string[]): string[] {
  const refs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      refs.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('-')) {
      if (MERGE_VALUE_OPTIONS.has(arg)) i++;
      continue;
    }
    refs.push(arg);
  }
  return refs;
}

/**
 * The routes of the MCP server of a team (mcp/team.ts), on /api/crew/<route> with the token of the daemon. The
 * caller is the session in `agent`: what it may do follows from its place in its team.
 */
export async function crewApi(crews: Crews, route: string, input: Record<string, unknown>, pollMs = 50_000): Promise<{ status: number; body: unknown }> {
  const agentId = typeof input.agent === 'string' ? input.agent : '';
  const answer = (result: Result<object>) => ({ status: result.ok ? 200 : 400, body: result });
  switch (route) {
    case 'me': {
      const me = crews.whoami(agentId);
      return { status: 200, body: me ? { ok: true, name: me.name, role: me.role, talk: me.talk, team: me.crew.name, tools: crews.toolsOf(agentId) } : { ok: true, tools: [] } };
    }
    case 'team': {
      const text = crews.teamText(agentId);
      return text ? { status: 200, body: { ok: true, text } } : { status: 400, body: { ok: false, error: 'this session is not in a team' } };
    }
    case 'request': {
      const to = Array.isArray(input.to) ? input.to.filter((name): name is string => typeof name === 'string') : typeof input.to === 'string' ? [input.to] : [];
      return answer(crews.requestFrom(agentId, to, typeof input.text === 'string' ? input.text : ''));
    }
    case 'question':
      return answer(crews.question(agentId, typeof input.text === 'string' ? input.text : ''));
    case 'wait': {
      const requests = Array.isArray(input.requests) ? input.requests.filter((n): n is number => Number.isInteger(n)) : undefined;
      return answer(crews.startWait(agentId, requests, typeof input.minutes === 'number' ? input.minutes : undefined));
    }
    case 'deliver':
      return answer(crews.deliver(agentId, typeof input.summary === 'string' ? input.summary : '', typeof input.where === 'string' ? input.where : undefined));
    case 'review':
      return answer(
        await crews.review(agentId, typeof input.commit === 'string' ? input.commit : '', typeof input.verdict === 'string' ? input.verdict : '', typeof input.note === 'string' ? input.note : ''),
      );
    case 'wait-poll': {
      // The wait must be of this lead: an id alone is not enough.
      if (typeof input.id !== 'string' || !crews.waitOf(input.id, agentId)) return answer({ ok: false, error: 'unknown wait' });
      return answer(await crews.pollWait(input.id, pollMs));
    }
    default:
      return { status: 404, body: { ok: false, error: 'unknown route' } };
  }
}

/**
 * The templates of teams you saved (var/crew-templates.json), after the ones that come with Forchetta. Saving one
 * with the name of another replaces it. From the app (`override`), one with the name of a template of Forchetta is
 * your version of it, shown in its place until you delete it; a session cannot do that.
 */
export class CrewTemplates {
  private saved: CrewTemplate[] = [];

  constructor(
    private readonly file: string | undefined,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {
    if (!file) return;
    const raw = readDataJson(file, 'team templates', log);
    const rejected: unknown[] = [];
    for (const item of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
      const checked = cleanTemplate(item);
      if ('template' in checked) this.saved.push(checked.template);
      else rejected.push(item);
    }
    keepRejected(file, rejected, 'team templates', log);
  }

  list(): CrewTemplate[] {
    const mine = (name: string): CrewTemplate | undefined => this.saved.find((other) => other.name.toLowerCase() === name.toLowerCase());
    return [
      ...BUILTIN_TEMPLATES.map((builtin) => {
        const changed = mine(builtin.name);
        return changed ? { ...changed, builtin: true, modified: true } : builtin;
      }),
      ...this.saved.filter((template) => !BUILTIN_TEMPLATES.some((builtin) => builtin.name.toLowerCase() === template.name.toLowerCase())),
    ];
  }

  /**
   * Saves a template; one of yours with the same name is replaced, unless `replace` is false (a session that saves
   * one must say it means to replace it).
   */
  save(input: unknown, options: { replace?: boolean; override?: boolean } = {}): Result<{ name: string; replaced: boolean }> {
    const checked = cleanTemplate(input);
    if ('error' in checked) return { ok: false, error: checked.error };
    const template = checked.template;
    const key = template.name.toLowerCase();
    if (!options.override && BUILTIN_TEMPLATES.some((builtin) => builtin.name.toLowerCase() === key)) return { ok: false, error: `"${template.name}" is a template of Forchetta: give yours another name` };
    const replaced = this.saved.some((other) => other.name.toLowerCase() === key);
    if (replaced && options.replace === false) {
      return { ok: false, error: `a template "${template.name}" already exists: give this one another name, or replace that one with replace: true if the user asked to change it` };
    }
    this.saved = [...this.saved.filter((other) => other.name.toLowerCase() !== key), template];
    this.write();
    return { ok: true, name: template.name, replaced };
  }

  /** One template by its name, any case. */
  find(name: string): CrewTemplate | undefined {
    const key = name.trim().toLowerCase();
    return this.list().find((template) => template.name.toLowerCase() === key);
  }

  delete(name: string): Result {
    const before = this.saved.length;
    this.saved = this.saved.filter((other) => other.name.toLowerCase() !== name.toLowerCase());
    if (this.saved.length === before) return { ok: false, error: 'unknown template' };
    this.write();
    return { ok: true };
  }

  private write(): void {
    if (!this.file) return;
    try {
      writeDataJson(this.file, this.saved);
    } catch (error) {
      this.log(`team templates not saved: ${String(error)}`, 'error');
    }
  }
}

/**
 * The presets of agents of the studio: the ones of Forchetta, each replaced by your version when you changed it,
 * then yours (var/crew-roles.json). Deleting your version of one of Forchetta restores it.
 */
export class RolePresets {
  private saved: RolePreset[] = [];

  constructor(
    private readonly file: string | undefined,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {
    if (!file) return;
    const raw = readDataJson(file, 'presets of the studio', log);
    const rejected: unknown[] = [];
    for (const item of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
      const checked = cleanRolePreset(item);
      if ('preset' in checked) this.saved.push(checked.preset);
      else rejected.push(item);
    }
    keepRejected(file, rejected, 'presets of the studio', log);
  }

  private static same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  list(): RolePreset[] {
    const builtin = (name: string): boolean => BUILTIN_ROLES.some((role) => RolePresets.same(role.name, name));
    return [
      ...BUILTIN_ROLES.map((role) => {
        const changed = this.saved.find((preset) => RolePresets.same(preset.name, role.name));
        return changed ? { ...changed, builtin: true, modified: true } : role;
      }),
      ...this.saved.filter((preset) => !builtin(preset.name)),
    ];
  }

  /** Saves a preset, in place of one with its name; `previous`: the name it had, when it was renamed. */
  save(input: unknown, previous?: string): Result<{ name: string }> {
    const checked = cleanRolePreset(input);
    if ('error' in checked) return { ok: false, error: checked.error };
    const preset = checked.preset;
    const gone = (name: string): boolean => RolePresets.same(name, preset.name) || (previous !== undefined && RolePresets.same(name, previous) && !BUILTIN_ROLES.some((role) => RolePresets.same(role.name, previous)));
    this.saved = [...this.saved.filter((other) => !gone(other.name)), preset];
    this.write();
    return { ok: true, name: preset.name };
  }

  /** Deletes one of yours; for one of Forchetta you changed, brings back theirs. */
  delete(name: string): Result {
    const before = this.saved.length;
    this.saved = this.saved.filter((other) => !RolePresets.same(other.name, name));
    if (this.saved.length === before) return { ok: false, error: 'unknown preset' };
    this.write();
    return { ok: true };
  }

  private write(): void {
    if (!this.file) return;
    try {
      writeDataJson(this.file, this.saved);
    } catch (error) {
      this.log(`presets of the studio not saved: ${String(error)}`, 'error');
    }
  }
}

/** A person of a template in a line: its name, then its model, its permissions and how it works in the team. */
function personLine(crew: Pick<CrewTemplate, 'talk' | 'worktrees'>, person: CrewMemberSpec | Extract<CrewTemplate['lead'], { kind: 'claude' }>, member: boolean): string {
  const traits = [
    person.model,
    person.mode,
    ...(member ? [effectiveTalk(crew, person as CrewMemberSpec) === 'oneway' ? 'executes only' : undefined] : []),
    ...(member && effectiveWorktree(crew, person as CrewMemberSpec) ? ['own worktree'] : []),
    ...(member && (person as CrewMemberSpec).reviews ? ['reviews'] : []),
    ...(member && (person as CrewMemberSpec).paths ? [`files: ${pathsText((person as CrewMemberSpec).paths!)}`] : []),
    ...(member && (person as CrewMemberSpec).reportsTo ? [`reports to ${(person as CrewMemberSpec).reportsTo}`] : []),
    ...(person.skills ? [`skills: ${person.skills.join(', ')}`] : []),
  ].filter(Boolean);
  return `${person.name}${traits.length > 0 ? ` (${traits.join(', ')})` : ''}`;
}

/** The templates as a session reads them (the tool list_team_templates): one line each. */
export function templatesText(templates: readonly CrewTemplate[]): string {
  return [
    'The templates of teams in Forchetta. The user starts one from the app: "new team", Start from, then the folder of the team and "Create team".',
    ...templates.map((template) => {
      const lead = template.lead.kind === 'claude' ? `lead ${personLine(template, template.lead, false)}` : 'led by the user, from the app';
      const members = template.members.map((member) => personLine(template, member, true)).join(', ');
      return `- "${template.name}"${template.builtin ? ' (comes with Forchetta)' : ''}: ${lead}; members: ${members}`;
    }),
    ...(customSkills().length > 0 ? [`Skills the user added, usable like those of the catalog: ${customSkills().map((skill) => `${skill.id}${skill.summary ? ` (${skill.summary.replace(/\.$/, '')})` : ''}`).join('; ')}.`] : []),
    'Ask for one by its name to get it in full, in the shape save_team_template takes.',
  ].join('\n');
}

/**
 * The routes of the tools of templates (mcp/team.ts), for a session of Forchetta: the templates, one in full, and
 * saving one. Saving starts nothing: the user starts the team from the app, where they see roles and permissions.
 * Undefined for another route (crewApi has those).
 */
export function templateApi(templates: CrewTemplates, route: string, input: Record<string, unknown>, onSaved?: (name: string, replaced: boolean) => void): { status: number; body: unknown } | undefined {
  switch (route) {
    case 'templates': {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) return { status: 200, body: { ok: true, text: templatesText(templates.list()) } };
      const found = templates.find(name);
      if (!found) return { status: 400, body: { ok: false, error: `no template is called "${name}": list_team_templates without a name lists them` } };
      const { builtin: _builtin, ...template } = found;
      return { status: 200, body: { ok: true, text: `The template "${found.name}"${found.builtin ? ' (comes with Forchetta: save a copy under another name to change it)' : ''}:\n${JSON.stringify(template, null, 2)}` } };
    }
    case 'template-save': {
      // Names and roles too long would be cut short in silence, as in the panel: the session must hear it.
      const long = tooLong(input.template);
      if (long) return { status: 400, body: { ok: false, error: long } };
      const result = templates.save(input.template, { replace: input.replace === true });
      if (!result.ok) return { status: 400, body: result };
      onSaved?.(result.name, result.replaced);
      const saved = templates.find(result.name)!;
      const lead = saved.lead.kind === 'claude' ? `the lead ${saved.lead.name} and ` : '';
      return {
        status: 200,
        body: {
          ok: true,
          name: result.name,
          replaced: result.replaced,
          text: `${result.replaced ? 'Replaced' : 'Saved'} the template "${result.name}": ${lead}${saved.members.length} member${saved.members.length === 1 ? '' : 's'}. Nothing has started. The user starts the team from the Forchetta app: "new team" (or "teams" → "+ new team"), Start from "${result.name}", then the folder of the team and "Create team".`,
        },
      };
    }
    default:
      return undefined;
  }
}
