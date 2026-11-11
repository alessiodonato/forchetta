import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Agent, type QueuedCommand, TEAM_TEXT_MAX, type TeamInfo } from '../shared/agent.ts';
import {
  ANSWER_HEADER,
  BUILTIN_TEMPLATES,
  cleanCrewSpec,
  cleanTemplate,
  type Crew,
  type CrewMemberSpec,
  type CrewTemplate,
  type Talk,
  talkNote,
  type CrewRequest,
  type CrewSpec,
  type CrewSummary,
  type Delivery,
  type DeliveryStatus,
  effectiveTalk,
  effectiveWorktree,
  type TeamTool,
  teamToolsFor,
  leadPrompt,
  MAX_OPEN_DELIVERIES,
  memberPrompt,
  QUESTION_HEADER,
  REQUEST_HEADER,
  worktreeName,
} from '../shared/crew.ts';
import { ensurePrivateDir } from '../shared/paths.ts';
import type { EnqueueResult } from './commands.ts';
import type { SpawnChoices, SpawnExtras, SpawnResult } from './spawn.ts';
import type { HookPayload } from './state.ts';

// The teams of agents (shared/crew.ts): one file each in var/crews, written when a team is created, read when
// the daemon starts. Creating one starts its sessions: the lead first when it is Claude, then the members, each
// with its name, its system prompt, its place in the chart and, for the lead and the members that answer, the
// tools of the team (mcp/team.ts).
//
// A request (from you, or from the Claude lead with send_request) gets the next number of its team and goes, with
// its header ("Request #3 from lead:"), into the queue of each recipient (daemon/commands.ts), which pastes it when
// the session is ready. The queue tells how it goes; the Stop of the recipient after it took the request says the
// work is done, with its last message. A member that answers (⇄) has that message go back to whoever asked: the
// Claude lead gets it in its own queue ("Answer from tester to request #3:"), you see it in the panel of the team.
// A member → gets no tools and sends nothing back.

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
const OPEN: DeliveryStatus[] = ['queued', 'blocked', 'sent', 'working'];

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

/** A lead waiting for the answers of some of its requests (wait_for_answers): its answers are held for it. */
interface Waiter {
  id: string;
  crewId: string;
  lead: string;
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

  constructor(
    private readonly dir: string | undefined,
    private readonly log: (message: string) => void = () => {},
  ) {
    if (!dir || !existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const crew = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Crew;
        if (typeof crew.id === 'string' && typeof crew.name === 'string' && Array.isArray(crew.members)) this.crews.set(crew.id, crew);
      } catch {
        this.log(`team ${file} illeggibile, ignorato`);
      }
    }
  }

  get(id: string): Crew | undefined {
    return this.crews.get(id);
  }

  list(): Crew[] {
    return [...this.crews.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  summaries(): CrewSummary[] {
    return this.list().map((crew) => ({
      id: crew.id,
      name: crew.name,
      ...(crew.lead.kind === 'claude' ? { lead: crew.lead.name } : {}),
      recipients: [
        ...(crew.lead.kind === 'claude' ? [{ name: crew.lead.name, agentId: crew.agents.lead, lead: true }] : []),
        ...crew.members.map((member) => ({ name: member.name, agentId: crew.agents[member.name], talk: effectiveTalk(crew, member) })),
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

  /**
   * A text for the Claude lead, with the changes of the team it has not been told yet: its system prompt lists
   * the team as it was when it started. `done` is called once the text is in its queue, to forget them.
   */
  private forLead(crew: Crew, text: string): { text: string; done: () => void } {
    const notes = crew.leadNotes ?? [];
    if (notes.length === 0) return { text, done: () => {} };
    return { text: `${text}\n\n(The team changed: ${notes.join('; ')}.)`, done: () => delete crew.leadNotes };
  }

  private noteForLead(crew: Crew, note: string): void {
    if (crew.lead.kind === 'claude') crew.leadNotes = [...(crew.leadNotes ?? []), note];
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
  whoami(agentId: string): { crew: Crew; name: string; role: 'lead' | 'member'; talk?: 'oneway' | 'twoway' } | undefined {
    for (const crew of this.crews.values()) {
      if (crew.lead.kind === 'claude' && crew.agents.lead === agentId) return { crew, name: crew.lead.name, role: 'lead' };
      const member = crew.members.find((candidate) => crew.agents[candidate.name] === agentId);
      if (member) return { crew, name: member.name, role: 'member', talk: effectiveTalk(crew, member) };
    }
    return undefined;
  }

  /** The tools of the team a session has: the lead and the members that answer. */
  toolsOf(agentId: string): TeamTool[] {
    const me = this.whoami(agentId);
    if (!me) return [];
    return teamToolsFor(me.crew, me.role === 'lead' ? 'lead' : { talk: me.talk });
  }

  /**
   * A request to some recipients of a team: from you (all the members when `to` is empty) or from its Claude lead
   * (to its members only). Each one gets it in its queue; a recipient with no session gets a failed delivery.
   */
  request(crewId: string, to: readonly string[], text: string, from = 'the user', now = Date.now()): Result<{ n: number; to: string[] }> {
    const crew = this.crews.get(crewId);
    if (!crew) return { ok: false, error: 'unknown team' };
    const body = text.replace(/\r\n?/g, '\n').trim();
    if (!body) return { ok: false, error: 'write the request first' };
    const members = crew.members.map((member) => member.name);
    const names = from === 'the user' && crew.lead.kind === 'claude' ? [crew.lead.name, ...members] : members;
    const all = to.length === 0 || to.some((name) => name.toLowerCase() === 'all');
    const wanted = to.map((name) => name.toLowerCase());
    const targets = all ? members : names.filter((name) => wanted.includes(name.toLowerCase()));
    if (targets.length === 0) return { ok: false, error: `nobody to send it to: the members are ${members.join(', ')}` };
    const open = (crew.requests ?? []).flatMap((request) => request.deliveries).filter((delivery) => OPEN.includes(delivery.status)).length;
    if (open + targets.length > MAX_OPEN_DELIVERIES) {
      return { ok: false, error: `${open} requests of the team are still open (at most ${MAX_OPEN_DELIVERIES}): wait for some answers first` };
    }
    const n = Math.max(0, ...(crew.requests ?? []).map((request) => request.n)) + 1;
    const request: CrewRequest = { n, from, text: body, createdAt: now, deliveries: [] };
    for (const name of targets) {
      const agentId = this.agentOf(crew, name);
      const member = crew.members.find((candidate) => candidate.name === name);
      // A member keeps, for this request, the → / ⇄ it has now; one whose → / ⇄ changed is told so here.
      const talk = member ? effectiveTalk(crew, member) : undefined;
      const toLead = crew.lead.kind === 'claude' && name === crew.lead.name ? this.forLead(crew, `${REQUEST_HEADER(n, from)}\n${body}`) : undefined;
      const full = toLead?.text ?? `${REQUEST_HEADER(n, from)}\n${body}${member?.talkNote && talk ? `\n\n${talkNote(talk)}` : ''}`;
      const delivery: Delivery = { to: name, agentId, status: 'queued', at: now, ...(talk ? { talk } : {}) };
      if (!agentId) Object.assign(delivery, { status: 'failed', reason: 'no session' });
      else {
        const queued = this.enqueue(agentId, full, { crew: crew.id, n });
        if (queued.ok) {
          delivery.commandId = queued.command.id;
          if (member?.talkNote) delete member.talkNote;
          toLead?.done();
        } else Object.assign(delivery, { status: 'failed', reason: queued.error });
      }
      request.deliveries.push(delivery);
    }
    crew.requests = [...(crew.requests ?? []), request].slice(-KEPT_REQUESTS);
    this.log(`team «${crew.name}»: richiesta #${n} da ${from} a ${targets.join(', ')}`);
    this.changed(crew);
    return { ok: true, n, to: targets };
  }

  /** send_request of the Claude lead. */
  requestFromLead(agentId: string, to: readonly string[], text: string, now = Date.now()): Result<{ n: number; to: string[] }> {
    const me = this.whoami(agentId);
    if (!me || me.role !== 'lead') return { ok: false, error: 'only the lead of a team can send requests' };
    return this.request(me.crew.id, to, text, me.name, now);
  }

  /**
   * ask_lead of a member that answers: a question about the request it is working on (the last one it got). A
   * Claude lead gets it in its queue; when you lead, it waits in the panel of the team.
   */
  question(agentId: string, text: string, now = Date.now()): Result<{ n?: number; to: string }> {
    const me = this.whoami(agentId);
    if (!me || me.role !== 'member' || me.talk !== 'twoway') return { ok: false, error: 'only a member that answers its lead can ask it' };
    const body = text.replace(/\r\n?/g, '\n').trim();
    if (!body) return { ok: false, error: 'write the question first' };
    const crew = me.crew;
    const found = [...(crew.requests ?? [])].reverse().flatMap((request) => request.deliveries.filter((delivery) => delivery.agentId === agentId).map((delivery) => ({ request, delivery })))[0];
    if (!found) return { ok: false, error: 'you have had no request yet: there is nothing to ask about' };
    const { request, delivery } = found;
    const question: NonNullable<Delivery['questions']>[number] = { text: clip(body, QUESTION_MAX), at: now, status: 'shown' };
    // The question goes back to whoever sent the request: the Claude lead, or you.
    const askedByLead = crew.lead.kind === 'claude' && request.from === crew.lead.name;
    const to = askedByLead ? request.from : 'the user';
    if (askedByLead) {
      const lead = crew.agents.lead;
      const text = this.forLead(crew, `${QUESTION_HEADER(request.n, me.name)}\n${body}`);
      const queued = lead ? this.enqueue(lead, text.text, { crew: crew.id, n: request.n }) : { ok: false as const, error: 'no session' };
      if (!queued.ok) return { ok: false, error: `the question did not reach the lead: ${queued.error}` };
      text.done();
      Object.assign(question, { status: 'queued', commandId: queued.command.id });
    }
    delivery.questions = [...(delivery.questions ?? []), question];
    this.log(`team «${crew.name}»: domanda di ${me.name} sulla richiesta #${request.n}`);
    this.changed(crew);
    return { ok: true, n: request.n, to };
  }

  /** What the tool team says: the team, who you are in it, and what each one is doing. */
  teamText(agentId: string): string | undefined {
    const me = this.whoami(agentId);
    if (!me) return undefined;
    const crew = me.crew;
    const open = (crew.requests ?? []).flatMap((request) => request.deliveries.filter((delivery) => OPEN.includes(delivery.status)).map((delivery) => ({ n: request.n, delivery })));
    const doing = (name: string, id: string | undefined): string => {
      const mine = open.filter((item) => item.delivery.to === name);
      const requests = mine.length ? `; requests: ${mine.map((item) => `#${item.n} ${item.delivery.status === 'working' ? 'in progress' : 'waiting for its turn'}`).join(', ')}` : '';
      return `${stateText(id ? this.agent(id) : undefined)}${requests}`;
    };
    const lines = [
      `Team "${crew.name}", in ${crew.cwd}. You are ${me.name}, ${me.role === 'lead' ? 'the lead' : `a member${me.talk === 'twoway' ? ' that answers its lead' : ''}`}.`,
      crew.lead.kind === 'claude' ? `Lead: ${crew.lead.name} — ${doing(crew.lead.name, crew.agents.lead)}` : 'Lead: the user, from the Forchetta app.',
      'Members:',
      ...crew.members.map((member) => {
        const talk = effectiveTalk(crew, member) === 'twoway' ? 'answers' : 'executes only';
        return `- ${member.name} (${talk}): ${flat(member.role)} — works ${this.placeText(crew, member)} — now: ${doing(member.name, crew.agents[member.name])}`;
      }),
    ];
    return lines.join('\n');
  }

  /** A command of the team changed status in the queue of its session: a request, an answer or a question. */
  commandChanged(command: QueuedCommand, now = Date.now()): void {
    if (!command.request) return;
    const crew = this.crews.get(command.request.crew);
    if (!crew) return;
    for (const request of crew.requests ?? []) {
      for (const delivery of request.deliveries) {
        if (delivery.commandId === command.id) {
          if (delivery.status === 'done') return;
          const status = deliveryStatus(command);
          if (delivery.status === status && delivery.reason === command.reason) return;
          delivery.status = status;
          delivery.reason = status === 'working' ? undefined : command.reason;
          delivery.at = now;
          return this.changed(crew);
        }
        if (delivery.reply?.commandId === command.id) {
          const status = passageStatus(command);
          if (delivery.reply.status === status) return;
          delivery.reply = { ...delivery.reply, status, ...(status === 'failed' ? { reason: command.reason } : {}) };
          return this.changed(crew);
        }
        const question = delivery.questions?.find((candidate) => candidate.commandId === command.id);
        if (question) {
          const status = passageStatus(command);
          if (question.status === status) return;
          question.status = status;
          return this.changed(crew);
        }
      }
    }
  }

  /**
   * The hooks of a session of a team: the Stop after it took a request ends that request, with its last message,
   * which goes back to a Claude lead that asked when the member answers; a StopFailure, or the end of the session,
   * fails it.
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
    for (const request of crew.requests) {
      for (const delivery of request.deliveries) {
        if (delivery.agentId !== agent.id || (delivery.status !== 'working' && delivery.status !== 'sent')) continue;
        if (event === 'Stop') {
          // Since it took the request (delivery.at), did it ask its lead something? Then its turn ends waiting for
          // the answer, and that message would tell the lead nothing new: the answer comes with the next request.
          const asked = (delivery.questions ?? []).some((question) => question.at >= delivery.at);
          delivery.status = 'done';
          delivery.reason = undefined;
          if (payload.last_assistant_message) delivery.answer = clip(payload.last_assistant_message, ANSWER_MAX);
          if (!asked) this.answerBack(crew, request, delivery);
        } else {
          delivery.status = 'failed';
          delivery.reason = event === 'SessionEnd' ? 'the session ended' : 'the turn ended with an error';
        }
        delivery.at = now;
        changed = true;
      }
    }
    if (changed) {
      this.changed(crew);
      this.wake(crew.id);
    }
  }

  /** The answer of a member ⇄ to a request of the Claude lead goes into the queue of the lead. */
  private answerBack(crew: Crew, request: CrewRequest, delivery: Delivery): void {
    if (crew.lead.kind !== 'claude' || request.from !== crew.lead.name) return;
    const member = crew.members.find((candidate) => candidate.name === delivery.to);
    // The → / ⇄ of when the request left: a change counts from the next request.
    if (!member || (delivery.talk ?? effectiveTalk(crew, member)) !== 'twoway') return;
    const lead = crew.agents.lead;
    if (!lead) return;
    // The lead waits for this answer (wait_for_answers): it is held for it, and given there.
    if (this.waiterFor(crew.id, request.n)) {
      delivery.reply = { status: 'held' };
      return;
    }
    this.sendAnswer(crew, request, delivery, lead);
  }

  /** The answer of a member into the queue of the lead, as a new prompt. */
  private sendAnswer(crew: Crew, request: CrewRequest, delivery: Delivery, lead: string): void {
    const text = this.forLead(crew, `${ANSWER_HEADER(request.n, delivery.to)}\n${delivery.answer?.trim() || '(it ended its turn with no message)'}`);
    const queued = this.enqueue(lead, text.text, { crew: crew.id, n: request.n });
    if (queued.ok) text.done();
    delivery.reply = queued.ok ? { status: 'queued', commandId: queued.command.id } : { status: 'failed', reason: queued.error };
    this.log(`team «${crew.name}»: risposta di ${delivery.to} alla #${request.n} ${queued.ok ? 'in coda per il capo' : `non consegnata: ${queued.error}`}`);
  }

  /** Whether a wait is of this lead. */
  waitOf(id: string, agentId: string): boolean {
    return this.waiters.get(id)?.lead === agentId;
  }

  /** The wait of the lead that holds the answers of this request, if any. */
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
   * wait_for_answers of the Claude lead: from now until `minutes` pass, the answers of these requests (all its
   * requests still open, when none is given) are held for it instead of going into its queue.
   */
  startWait(agentId: string, requests: readonly number[] | undefined, minutes: number | undefined, now = Date.now()): Result<{ id: string; requests: number[] }> {
    const me = this.whoami(agentId);
    if (!me || me.role !== 'lead') return { ok: false, error: 'only the lead of a team can wait for answers' };
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
      lead: agentId,
      requests: new Set(chosen.map((request) => request.n)),
      until: now + span,
      listeners: [],
      // A wait nobody collects (the call was cut): what it held goes to the lead as prompts, as without it.
      timer: setTimeout(() => this.release(id), span + 30_000),
    };
    waiter.timer.unref?.();
    this.waiters.set(id, waiter);
    this.log(`team «${crew.name}»: il capo aspetta le risposte di ${[...waiter.requests].map((n) => `#${n}`).join(', ') || 'nessuna richiesta'}`);
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
    if (!this.waitOver(first, now())) {
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
    if (open.length > 0 && now() < waiter.until) return { ok: true, done: false, answers: [], open };
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
    this.log(`team «${crew.name}»: attesa del capo finita, ${answers.filter((answer) => answer.answer).length} risposte${open.length ? `, ${open.length} ancora aperte` : ''}`);
    this.changed(crew);
    return { ok: true, done: true, answers, open };
  }

  private waitOver(waiter: Waiter, now: number): boolean {
    const crew = this.crews.get(waiter.crewId);
    const deliveries = (crew?.requests ?? []).filter((request) => waiter.requests.has(request.n)).flatMap((request) => request.deliveries);
    return now >= waiter.until || deliveries.every((delivery) => !OPEN.includes(delivery.status));
  }

  /** A wait that nobody collected: its held answers go to the lead as prompts. */
  private release(id: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    const crew = this.crews.get(waiter.crewId);
    if (!crew || crew.lead.kind !== 'claude' || !crew.agents.lead) return;
    for (const request of crew.requests ?? []) {
      if (!waiter.requests.has(request.n)) continue;
      for (const delivery of request.deliveries) if (delivery.reply?.status === 'held') this.sendAnswer(crew, request, delivery, crew.agents.lead);
    }
    this.changed(crew);
  }

  private changed(crew: Crew): void {
    this.save(crew);
    this.onChange();
    // A wait of the lead looks again: a delivery may be over (done, failed, cancelled).
    this.wake(crew.id);
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
    this.noteForLead(crew, talk === 'twoway' ? `${name} now answers you` : `${name} now executes only: it will not answer`);
    this.log(`team «${crew.name}»: ${name} ora ${talk === 'twoway' ? 'risponde' : 'esegue e basta'}, dalla prossima richiesta`);
    this.changed(crew);
    const agentId = crew.agents[name];
    return { ok: true, changes: agentId ? [{ agentId, talk }] : [] };
  }

  /**
   * A member out of the team: no more requests, the ones still in its queue cancelled (`cancel`), its box out of
   * the group. Its session goes on: Forchetta never ends a session, /exit does.
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
    this.noteForLead(crew, `${name} is no longer in the team`);
    this.log(`team «${crew.name}»: ${name} tolto dal team (la sessione resta)`);
    this.changed(crew);
    return { ok: true, ...(agentId ? { agentId } : {}) };
  }

  /** A new member: checked with the rest of the team (names, at most 6), then started like the others. */
  async addMember(crewId: string, input: unknown, start: Starter = this.spawn): Promise<Result<{ agentId: string }>> {
    const crew = this.crews.get(crewId);
    if (!crew) return { ok: false, error: 'unknown team' };
    const checked = cleanCrewSpec({ ...crew, members: [...crew.members, input] });
    if ('error' in checked) return { ok: false, error: checked.error };
    const member: CrewMemberSpec = checked.spec.members.at(-1)!;
    // No worktree where Claude Code could not make one: the new member shares the folder.
    if (effectiveWorktree(crew, member) && this.noWorktrees(crew.cwd)) member.worktree = false;
    const spec: CrewSpec = { ...crew, members: [...crew.members, member] };
    const result = await start(
      { cwd: crew.cwd, model: member.model, mode: member.mode, worktree: this.worktreeOf(crew, member) },
      {
        system: memberPrompt(spec, member),
        name: member.name,
        team: { label: member.name, role: shortRole(member.role), talk: effectiveTalk(spec, member), group: crew.name, crew: crew.id },
        teamTools: teamToolsFor(spec, member),
      },
    );
    if (!result.ok) return { ok: false, error: result.error };
    crew.members.push(member);
    crew.agents[member.name] = result.agentId;
    this.noteForLead(crew, `${member.name} joined the team (${effectiveTalk(crew, member) === 'twoway' ? 'it answers you' : 'it executes only'}): ${flat(member.role)}`);
    this.log(`team «${crew.name}»: ${member.name} aggiunto`);
    this.changed(crew);
    return { ok: true, agentId: result.agentId };
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
    this.spawn = start;
    const crew: Crew = { ...spec, id: randomUUID(), createdAt: now, agents: {} };
    const wantsWorktrees = spec.members.some((member) => effectiveWorktree(spec, member)) || (spec.lead.kind === 'claude' && spec.lead.worktree === true);
    const noGit = wantsWorktrees && !this.inGit(spec.cwd);
    if (noGit) this.dropWorktrees(crew);
    const waitTrust = !this.trusted(spec.cwd);
    const agentIds: string[] = [];
    const errors: string[] = [];
    let first: string | undefined;

    if (crew.lead.kind === 'claude') {
      const lead = crew.lead;
      first = lead.name;
      const result = await start(
        { cwd: crew.cwd, model: lead.model, mode: lead.mode, worktree: lead.worktree && !noGit && !waitTrust ? worktreeName(crew.id, crew.name, lead.name) : undefined },
        { system: leadPrompt(crew), name: lead.name, team: this.place(crew, { label: lead.name, role: shortRole(lead.role), lead: true }), teamTools: teamToolsFor(crew, 'lead') },
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
      this.log(`team «${crew.name}» creato: ${first} aspetta la tua risposta al dialogo di fiducia di Claude Code, poi partono gli altri`);
      return {
        ok: true,
        crewId: crew.id,
        agentIds,
        error: `Claude Code asks, in the terminal of ${first}, whether you trust this folder: answer "Yes, I trust this folder" there, and the rest of the team starts${wantsWorktrees && !noGit ? ', each member in its worktree' : ''}`,
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
    this.log(`team «${crew.name}» creato: ${agentIds.length} sessioni${errors.length ? `, ${errors.length} non partite` : ''}${why ? ', senza worktree (non è un repo git)' : ''}`);
    const notes = [...(errors.length ? [`not started: ${errors.join('; ')}`] : []), ...(why ? [why] : [])];
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
          team: this.place(crew, { label: member.name, role: shortRole(member.role), talk: effectiveTalk(crew, member) }),
          teamTools: teamToolsFor(crew, member),
        },
      );
      if (result.ok) {
        crew.agents[member.name] = result.agentId;
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
    this.log(`team «${crew.name}»: fiducia data, partite ${started.agentIds.length} sessioni${started.errors.length ? `; non partite: ${started.errors.join('; ')}` : ''}`);
    this.changed(crew);
  }

  private save(crew: Crew): void {
    if (!this.dir) return;
    try {
      ensurePrivateDir(this.dir);
      const file = join(this.dir, `${crew.id}.json`);
      const temporary = `${file}.${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(crew, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) {
      this.log(`team «${crew.name}» non salvato: ${String(error)}`);
    }
  }
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
      return answer(crews.requestFromLead(agentId, to, typeof input.text === 'string' ? input.text : ''));
    }
    case 'question':
      return answer(crews.question(agentId, typeof input.text === 'string' ? input.text : ''));
    case 'wait': {
      const requests = Array.isArray(input.requests) ? input.requests.filter((n): n is number => Number.isInteger(n)) : undefined;
      return answer(crews.startWait(agentId, requests, typeof input.minutes === 'number' ? input.minutes : undefined));
    }
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
 * with the name of another replaces it; the ones of Forchetta stay as they are.
 */
export class CrewTemplates {
  private saved: CrewTemplate[] = [];

  constructor(
    private readonly file: string | undefined,
    private readonly log: (message: string) => void = () => {},
  ) {
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      for (const item of Array.isArray(raw) ? raw : []) {
        const checked = cleanTemplate(item);
        if ('template' in checked) this.saved.push(checked.template);
      }
    } catch {
      this.log('modelli dei team illeggibili, ignorati');
    }
  }

  list(): CrewTemplate[] {
    return [...BUILTIN_TEMPLATES, ...this.saved];
  }

  save(input: unknown): Result<{ name: string }> {
    const checked = cleanTemplate(input);
    if ('error' in checked) return { ok: false, error: checked.error };
    const template = checked.template;
    const key = template.name.toLowerCase();
    if (BUILTIN_TEMPLATES.some((builtin) => builtin.name.toLowerCase() === key)) return { ok: false, error: `"${template.name}" is a template of Forchetta: give yours another name` };
    this.saved = [...this.saved.filter((other) => other.name.toLowerCase() !== key), template];
    this.write();
    return { ok: true, name: template.name };
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
      const temporary = `${this.file}.${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(this.saved, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      this.log(`modelli dei team non salvati: ${String(error)}`);
    }
  }
}
