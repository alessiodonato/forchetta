// A team of agents that work together (in the code: a crew, to tell it from TeamInfo, the name, group and role of
// one session set from its box). A lead, Claude or you, sends requests to the members; each member either
// executes them (→, one way) or also answers (⇄, both ways). The daemon starts the sessions and keeps the crew in
// var/crews/<id>.json; the panel «New team» of the app writes the spec. No Node module here: the page uses it too.

/** How a member talks with its lead: it executes and that is all, or its final answer goes back to the lead. */
export type Talk = 'oneway' | 'twoway';

export interface CrewMemberSpec {
  /** Also its name in Claude Code (--name) and in the requests: "Request #3 from lead". */
  name: string;
  /** Its → / ⇄ changed after it started: the next request tells it, since its system prompt says the old one. */
  talkNote?: boolean;
  /** What it does, in a sentence or a few: it goes into its system prompt. */
  role: string;
  /** Undefined: the default of the crew. */
  talk?: Talk;
  model?: string;
  mode?: string;
  /** A git worktree of its own, so that it does not touch the files of the others; undefined: the choice of the team. */
  worktree?: boolean;
}

export type CrewLeadSpec = { kind: 'you' } | ({ kind: 'claude' } & Omit<CrewMemberSpec, 'talk'>);

export interface CrewSpec {
  name: string;
  /** The folder of every session of the crew. */
  cwd: string;
  lead: CrewLeadSpec;
  /** For the members with no choice of their own. */
  talk: Talk;
  /** Each member in a git worktree of its own, unless it says otherwise (the lead stays in the folder). */
  worktrees?: boolean;
  members: CrewMemberSpec[];
}

/**
 * Where a request stands for one of its recipients: waiting in the queue of the session, blocked by something on
 * its screen, pasted, taken by Claude Code (working on it), done (its turn ended), or failed / cancelled.
 */
export type DeliveryStatus = 'queued' | 'blocked' | 'sent' | 'working' | 'done' | 'failed' | 'cancelled';

export interface Delivery {
  /** The name of the recipient: a member, or the lead. */
  to: string;
  agentId?: string;
  status: DeliveryStatus;
  reason?: string;
  /** The command of its session that carries it (daemon/commands.ts). */
  commandId?: string;
  at: number;
  /** How the recipient talked when the request left: a change of → / ⇄ counts from the next request. */
  talk?: Talk;
  /** Its last message when the turn ended: what goes back to the lead of a member ⇄. */
  answer?: string;
  /**
   * The answer of a member ⇄ on its way back to a Claude lead: in the queue of the lead, or held for the lead
   * while it waits for it (wait_for_answers), then given to it there.
   */
  reply?: { status: 'queued' | 'sent' | 'delivered' | 'failed' | 'held'; commandId?: string; reason?: string; byWait?: boolean };
  /** The questions it asked its lead while working on this request (ask_lead). */
  questions?: { text: string; at: number; status: 'queued' | 'sent' | 'delivered' | 'failed' | 'shown'; commandId?: string }[];
}

/** A request of a team: one number, the same text for each recipient. */
export interface CrewRequest {
  n: number;
  /** "the user", or the name of the lead. */
  from: string;
  text: string;
  createdAt: number;
  deliveries: Delivery[];
}

export interface Crew extends CrewSpec {
  id: string;
  createdAt: number;
  /** The sessions started for it: "lead" and the name of each member → the id of its agent. */
  agents: Record<string, string>;
  requests?: CrewRequest[];
  /** Changes of the team the Claude lead has not been told yet: the next text that reaches it carries them. */
  leadNotes?: string[];
  /**
   * The session that opens a folder Claude Code does not trust yet: the rest of the team starts when it said
   * hello (its trust dialog answered).
   */
  waitingTrust?: string;
}

/** What the page shows of a crew. */
export interface CrewSummary {
  id: string;
  name: string;
  /** The name of the lead when it is a Claude session; undefined when the lead is you. */
  lead?: string;
  /** Who can get a request: the lead when it is Claude, then the members. */
  recipients?: { name: string; agentId?: string; talk?: Talk; lead?: boolean }[];
  /** The last requests, the newest last. */
  requests?: CrewRequest[];
}

export const REQUEST_HEADER = (n: number, from: string): string => `Request #${n} from ${from}:`;
export const ANSWER_HEADER = (n: number, from: string): string => `Answer from ${from} to request #${n}:`;
export const QUESTION_HEADER = (n: number | undefined, from: string): string => (n === undefined ? `Question from ${from}:` : `Question from ${from} about request #${n}:`);

/** The MCP server of a team, as Claude Code names it: its tools are mcp__forchetta__<tool>. */
export const TEAM_MCP = 'forchetta';
/** At most this many deliveries open at once in a team: a lead does not spend the plan before you see it. */
export const MAX_OPEN_DELIVERIES = 20;

export type TeamTool = 'team' | 'send_request' | 'wait_for_answers' | 'ask_lead';

/** The tools of the team a session gets: the Claude lead sends requests, a member that answers can ask; a member → gets none. */
export const teamToolsFor = (crew: Pick<CrewSpec, 'talk'>, member: Pick<CrewMemberSpec, 'talk'> | 'lead'): TeamTool[] =>
  member === 'lead' ? ['team', 'send_request', 'wait_for_answers'] : effectiveTalk(crew, member) === 'twoway' ? ['team', 'ask_lead'] : [];

export const CREW_MAX_MEMBERS = 6;
export const CREW_NAME_MAX = 40;
export const MEMBER_NAME_MAX = 24;
export const ROLE_MAX = 1000;
/** Names: what reads well in a request and in Claude Code. A letter or a digit first, then also spaces, ".", "_", "-". */
const MEMBER_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

/** The models a session can start with: aliases of Claude Code, valid for that session only (unlike /model). */
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
/** The permission modes the app offers. bypassPermissions and dontAsk stay in the terminal. */
export const MODES = ['manual', 'acceptEdits', 'auto', 'plan'] as const;

export const effectiveTalk = (crew: Pick<CrewSpec, 'talk'>, member: Pick<CrewMemberSpec, 'talk'>): Talk => member.talk ?? crew.talk;

/** Whether a member works in a git worktree of its own: its choice, else the one of the team. */
export const effectiveWorktree = (crew: Pick<CrewSpec, 'worktrees'>, member: Pick<CrewMemberSpec, 'worktree'>): boolean => member.worktree ?? crew.worktrees === true;

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The name of the worktree of a member, for `claude --worktree <name>` (letters, digits, ".", "_", "-", 40 at most):
 * the team, the member and the start of the id of the team, so that two teams never share one.
 */
export function worktreeName(crewId: string, team: string, member: string): string {
  const tail = `-${crewId.slice(0, 6)}`;
  return `${`${slug(team) || 'team'}-${slug(member) || 'member'}`.slice(0, 40 - tail.length).replace(/-+$/, '')}${tail}`;
}

export const DEFAULT_LEAD_ROLE = 'Lead the team: split the goal into requests for the members, follow their work and check it.';
const DEFAULT_MEMBER_ROLE = 'Help the team with what the lead asks.';

const oneLine = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const block = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');

function cleanChoices(raw: Record<string, unknown>): { model?: string; mode?: string; worktree?: boolean } | { error: string } {
  const out: { model?: string; mode?: string; worktree?: boolean } = {};
  if (raw.model !== undefined && raw.model !== '') {
    if (!(MODELS as readonly unknown[]).includes(raw.model)) return { error: 'invalid model' };
    out.model = raw.model as string;
  }
  if (raw.mode !== undefined && raw.mode !== '') {
    if (!(MODES as readonly unknown[]).includes(raw.mode)) return { error: 'invalid permission mode' };
    out.mode = raw.mode as string;
  }
  if (raw.worktree === true || raw.worktree === false) out.worktree = raw.worktree;
  return out;
}

/** The spec as the panel sends it, checked and trimmed; or what is wrong with it, in a line for the panel. */
export function cleanCrewSpec(input: unknown): { spec: CrewSpec } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'no team' };
  const raw = input as Record<string, unknown>;
  const name = oneLine(raw.name, CREW_NAME_MAX);
  if (!name) return { error: 'give the team a name' };
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
  if (!cwd) return { error: 'choose the folder of the team' };
  const talk: Talk = raw.talk === 'oneway' ? 'oneway' : 'twoway';
  const worktrees = raw.worktrees === true;

  const taken = new Set<string>();
  const memberName = (value: unknown, what: string): string | { error: string } => {
    const text = oneLine(value, MEMBER_NAME_MAX);
    if (!text) return { error: `${what}: a name is needed` };
    if (!MEMBER_NAME.test(text)) return { error: `${what}: the name "${text}" may hold letters, digits, spaces, ".", "_" and "-", and start with a letter or a digit` };
    const key = text.toLowerCase();
    if (taken.has(key)) return { error: `two members are called "${text}": each name must be different` };
    taken.add(key);
    return text;
  };

  const rawLead = (raw.lead ?? {}) as Record<string, unknown>;
  let lead: CrewLeadSpec;
  if (rawLead.kind === 'you') {
    lead = { kind: 'you' };
    taken.add('you');
  } else {
    const leadName = memberName(rawLead.name ?? 'lead', 'the lead');
    if (typeof leadName !== 'string') return leadName;
    const choices = cleanChoices(rawLead);
    if ('error' in choices) return { error: `the lead: ${choices.error}` };
    lead = { kind: 'claude', name: leadName, role: block(rawLead.role, ROLE_MAX) || DEFAULT_LEAD_ROLE, ...choices };
  }

  if (!Array.isArray(raw.members) || raw.members.length === 0) return { error: 'add at least one member' };
  if (raw.members.length > CREW_MAX_MEMBERS) return { error: `${CREW_MAX_MEMBERS} members at most` };
  const members: CrewMemberSpec[] = [];
  for (const [index, item] of raw.members.entries()) {
    const member = (item ?? {}) as Record<string, unknown>;
    const what = `member ${index + 1}`;
    const memberNameOrError = memberName(member.name, what);
    if (typeof memberNameOrError !== 'string') return memberNameOrError;
    const choices = cleanChoices(member);
    if ('error' in choices) return { error: `${memberNameOrError}: ${choices.error}` };
    members.push({
      name: memberNameOrError,
      role: block(member.role, ROLE_MAX) || DEFAULT_MEMBER_ROLE,
      ...(member.talk === 'oneway' || member.talk === 'twoway' ? { talk: member.talk } : {}),
      ...choices,
    });
  }
  return { spec: { name, cwd, lead, talk, ...(worktrees ? { worktrees } : {}), members } };
}

/** The name the members use for their lead. */
export const leadName = (crew: Pick<CrewSpec, 'lead'>): string => (crew.lead.kind === 'claude' ? crew.lead.name : 'the user');

const memberLine = (crew: CrewSpec, member: CrewMemberSpec): string =>
  `- ${member.name} (${effectiveTalk(crew, member) === 'twoway' ? 'answers you' : 'executes only, no answer'}${effectiveWorktree(crew, member) ? ', own worktree' : ''}): ${member.role.replace(/\s+/g, ' ')}`;

const WORKTREE_LEAD =
  'A member with "own worktree" works in a git worktree of its own (a copy of the repository, on a branch of its own): you and the others do not see its changes until it commits them and they are merged. Ask it to commit its work at the end of each request. When its work is good, merge its branch into the folder of the team with git, or tell the user it is ready; the tool team shows the folder and the branch of each member.';

/** The system prompt of the lead, when it is a Claude session: who it is, and its team. */
export function leadPrompt(crew: CrewSpec): string {
  if (crew.lead.kind !== 'claude') return '';
  return [
    `You are ${crew.lead.name}, the lead of the team "${crew.name}" in Forchetta, a control center for parallel Claude Code sessions on this Mac.`,
    `Your role: ${crew.lead.role}`,
    '',
    'Your team: each member is another Claude Code session, in its own terminal.',
    ...crew.members.map((member) => memberLine(crew, member)),
    '',
    'Give work to the members with the tool send_request of the server "forchetta": one request to one, some or all of them ("all"). Write each request complete: the member sees only that. It waits in the queue of the member while the member works, so you never need to wait for a member to be free.',
    'A member that "answers you" sends you its final message when it finishes a request: it reaches you as a new prompt that starts with "Answer from <name> to request #<n>:". A member that "executes only" does not answer: the tool team tells you when it is done.',
    'A question of a member reaches you as "Question from <name> about request #<n>:": answer it with send_request to that member.',
    'The tool team shows every member, what it does and what it is working on; the team can change while you work (a member added or taken away), and the tool team always shows it as it is now. Send requests that can run at the same time to different members.',
    'When you need the answers of the requests you sent before you can go on, call the tool wait_for_answers: it waits (up to 10 minutes) and gives you all of them at once, in this same turn. Otherwise end your turn: answers that arrive later, or while you do not wait, reach you as new prompts.',
    ...(crew.members.some((member) => effectiveWorktree(crew, member)) ? [WORKTREE_LEAD] : []),
    'The user sees every session of the team in Forchetta and can also write to the members.'
  ].join('\n');
}

/** The system prompt of a member: who it is, who its lead is, how requests reach it and whether it answers. */
export function memberPrompt(crew: CrewSpec, member: CrewMemberSpec): string {
  const lead = crew.lead.kind === 'claude' ? `${crew.lead.name}, another Claude Code session` : 'the user, from the Forchetta app';
  const from = crew.lead.kind === 'claude' ? crew.lead.name : 'the user';
  const others = crew.members.filter((other) => other !== member);
  return [
    `You are ${member.name}, a member of the team "${crew.name}" in Forchetta, a control center for parallel Claude Code sessions on this Mac.`,
    `Your role: ${member.role}`,
    `Your lead is ${lead}.`,
    '',
    `Requests reach you as prompts that start with "Request #<n> from ${from}:" (or "from the user", when the user writes to you directly). Do what they ask, within your role.`,
    effectiveTalk(crew, member) === 'twoway'
      ? `When you finish a request, your final message goes back to your lead by itself: end with a short report of what you did, what you found and what is left. If you cannot go on without an answer, ask with the tool ask_lead of the server "forchetta", then end your turn: the answer comes as a new request.`
      : 'You execute: your final message is not sent to your lead, so you do not need to report back. Just do the work well.',
    ...(effectiveWorktree(crew, member)
      ? [
          'You work in a git worktree of your own (a copy of the repository, on a branch of your own): the other members and your lead do not see your changes until you commit them. Commit your work at the end of each request, with a clear message, so that your lead can see it and merge it.',
        ]
      : []),
    ...(others.length > 0 ? ['', 'The other members of the team:', ...others.map((other) => `- ${other.name}: ${other.role.replace(/\s+/g, ' ')}`)] : []),
  ].join('\n');
}

/**
 * One step of the thread of a team, in the order things happened: a request (from you or the lead, to some
 * recipients, with how it goes for each), a question of a member, the end of a request with its last message and
 * where that message went: to the lead (queued, sent, delivered), to you (shown), or nowhere (kept: the member
 * executes only, or it asked a question and its answer comes with the next request).
 */
export type ThreadEntry =
  | { kind: 'request'; at: number; n: number; from: string; text: string; deliveries: Delivery[] }
  | { kind: 'question'; at: number; n: number; from: string; to: string; text: string; status: NonNullable<Delivery['questions']>[number]['status'] }
  | { kind: 'answer'; at: number; n: number; from: string; to: string; text?: string; status: 'shown' | 'kept' | 'queued' | 'sent' | 'delivered' | 'failed' | 'held'; byWait?: boolean };

const ORDER: Record<ThreadEntry['kind'], number> = { request: 0, question: 1, answer: 2 };

/** The thread of a team, oldest first, from its requests. */
export function threadOf(requests: readonly CrewRequest[]): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  for (const request of requests) {
    entries.push({ kind: 'request', at: request.createdAt, n: request.n, from: request.from, text: request.text, deliveries: request.deliveries });
    for (const delivery of request.deliveries) {
      for (const question of delivery.questions ?? []) {
        entries.push({ kind: 'question', at: question.at, n: request.n, from: delivery.to, to: request.from, text: question.text, status: question.status });
      }
      if (delivery.status === 'done' || (delivery.status === 'failed' && delivery.answer)) {
        const status = delivery.reply?.status ?? (request.from === 'the user' ? 'shown' : 'kept');
        entries.push({
          kind: 'answer',
          at: delivery.at,
          n: request.n,
          from: delivery.to,
          to: request.from,
          ...(delivery.answer ? { text: delivery.answer } : {}),
          status,
          ...(delivery.reply?.byWait ? { byWait: true } : {}),
        });
      }
    }
  }
  return entries.sort((a, b) => a.at - b.at || ORDER[a.kind] - ORDER[b.kind] || a.n - b.n);
}

const OPEN_STATUSES: readonly DeliveryStatus[] = ['queued', 'blocked', 'sent', 'working'];

/**
 * What the box of a session of a team says of its requests: the one it works on ("#3 from lead: write the
 * parser"); for the Claude lead not at work on one, the requests it sent that are still open. A request still in
 * the queue is said by the line of the queue of the box, which can also cancel it.
 */
export function crewLineOf(agentId: string, crews: readonly CrewSummary[]): string | undefined {
  for (const crew of crews) {
    const me = crew.recipients?.find((recipient) => recipient.agentId === agentId);
    if (!me) continue;
    const requests = crew.requests ?? [];
    const mine = requests.flatMap((request) => request.deliveries.filter((d) => d.agentId === agentId && OPEN_STATUSES.includes(d.status)).map((d) => ({ request, d })));
    const working = mine.find((item) => item.d.status === 'working' || item.d.status === 'sent');
    const waiting = mine.filter((item) => item !== working).length;
    const from = (request: CrewRequest): string => (request.from === 'the user' ? 'you' : request.from);
    const first = (text: string): string => text.split('\n').find((line) => line.trim())?.trim() ?? '';
    if (working) return `#${working.request.n} from ${from(working.request)}: ${first(working.request.text)}${waiting > 0 ? ` · ${waiting} more waiting` : ''}`;
    if (me.lead) {
      const open = requests.filter((request) => request.from === me.name).flatMap((request) => request.deliveries.filter((d) => OPEN_STATUSES.includes(d.status)).map((d) => `#${request.n} ${d.to}`));
      return open.length > 0 ? `waits on ${open.join(', ')}` : undefined;
    }
    return undefined;
  }
  return undefined;
}

/** The line the next request brings to a member whose → / ⇄ changed: its system prompt still says the old one. */
export const talkNote = (talk: Talk): string =>
  talk === 'twoway'
    ? '(From now on your final message goes back to your lead: end each request with a short report of what you did, what you found and what is left.)'
    : '(From now on you execute only: your final message is not sent to your lead, you do not need to report back.)';

/** A team to start again: everything but the folder, which you choose each time. */
export interface CrewTemplate {
  /** Also the name the new team gets, unless you write another. */
  name: string;
  lead: CrewLeadSpec;
  talk: Talk;
  worktrees?: boolean;
  members: CrewMemberSpec[];
  /** One of the templates that come with Forchetta: it cannot be deleted. */
  builtin?: boolean;
}

/** The templates that come with Forchetta. */
export const BUILTIN_TEMPLATES: readonly CrewTemplate[] = [
  {
    name: 'developer + reviewer',
    builtin: true,
    lead: { kind: 'claude', name: 'lead', role: 'Split the goal into small steps: the developer writes each one, the reviewer checks it; send the fixes back until the reviewer is happy, then merge the branch of the developer.' },
    talk: 'twoway',
    worktrees: true,
    members: [
      { name: 'developer', role: 'Write the code you are asked for, in small steps, with a test for each step, and commit it.' },
      { name: 'reviewer', role: 'Review the commits of the developer on its branch (git log and git diff against the main branch): bugs, risks, missing tests. Do not change the code yourself: report what to fix.' },
    ],
  },
  {
    name: 'feature squad',
    builtin: true,
    lead: { kind: 'claude', name: 'lead', role: 'Plan the feature, split it between frontend and backend, have the tester check it, keep the pieces consistent, and merge the branches when they are ready.' },
    talk: 'twoway',
    worktrees: true,
    members: [
      { name: 'frontend', role: 'Build the user interface of the feature, following the conventions of the project.' },
      { name: 'backend', role: 'Build the server side of the feature: data, logic and API, with tests.' },
      { name: 'tester', role: 'Write and run the tests of what you are asked, end to end where it matters. Report what fails, with how to reproduce it.' },
    ],
  },
  {
    name: 'research + writing',
    builtin: true,
    lead: { kind: 'claude', name: 'lead', role: 'Split the topic into questions for the researcher, then have the writer turn what came back into the text asked.' },
    talk: 'twoway',
    members: [
      { name: 'researcher', role: 'Find the facts you are asked for, check them against the sources, and report them with where they come from.' },
      { name: 'writer', role: 'Write the text you are asked for, clear and short, from what the request gives you.', talk: 'oneway' },
    ],
  },
];

/** A template as the panel sends it, checked like a team (the folder aside); or what is wrong with it. */
export function cleanTemplate(input: unknown): { template: CrewTemplate } | { error: string } {
  const checked = cleanCrewSpec({ ...((input ?? {}) as object), cwd: '/' });
  if ('error' in checked) return checked;
  const { cwd: _cwd, ...rest } = checked.spec;
  return { template: { ...rest, members: rest.members.map(({ talkNote: _note, ...member }) => member) } };
}

/** A team as a template: what is needed to start it again, without its folder, its sessions and its requests. */
export const templateOf = (spec: CrewSpec, name = spec.name): CrewTemplate => ({
  name,
  lead: spec.lead,
  talk: spec.talk,
  ...(spec.worktrees ? { worktrees: true } : {}),
  members: spec.members.map(({ talkNote: _note, ...member }) => member),
});
