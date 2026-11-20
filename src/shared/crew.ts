// A team of agents that work together (in the code: a crew, to tell it from TeamInfo, the name, group and role of
// one session set from its box). A lead, Claude or you, sends requests to the members; each member either
// executes them (→, one way) or also answers (⇄, both ways). A member can report to another member instead of the
// lead (reportsTo): that one leads it, so the chart has more levels, a junior under a senior under the lead. Each
// relation, a member and the one it reports to, has its → / ⇄ and can have a prompt of its own, which both read.
// The daemon starts the sessions and keeps the crew in var/crews/<id>.json; the panel «New team» of the app writes
// the spec. No Node module here: the page uses it too.

import { cleanSkills } from './skills.ts';

/** How a member talks with the one it reports to: it executes and that is all, or its final answer goes back. */
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
  /**
   * The files it works on, relative to the folder of the team: folders ("src/ui/"), files, or patterns ("*.test.ts",
   * "docs/**"). The guard stops its edits elsewhere, and the edits of the other members here. None: any file no
   * other member has.
   */
  paths?: string[];
  /** Its files changed after it started: the next request tells it, since its system prompt says the old ones. */
  pathsNote?: boolean;
  /** It reviews the work of the others: it records its verdicts with the tool review, and the lead merges only what it approved. */
  reviews?: boolean;
  /** Skills of Claude Code from the catalog of Forchetta (shared/skills.ts), for its session only. */
  skills?: string[];
  /**
   * The member it reports to: that one leads it, gives it requests, and gets its answers and its questions.
   * Undefined: the lead of the team.
   */
  reportsTo?: string;
  /**
   * The prompt of its relation with the one it reports to: how the two work together (what is asked, what comes
   * back, when to ask). Both read it in their system prompts.
   */
  relation?: string;
  /** The one it reports to changed after it started (the one above it left the team): the next request tells it. */
  reportsToNote?: boolean;
  /** Changes among the members that report to it, not told yet: the next text that reaches it carries them. */
  notes?: string[];
  /** Its session started with the tools to lead others (send_request, wait_for_answers): a new member can go under it. */
  canLead?: boolean;
}

/** What a member is told while it works, and what its session started with: not part of a template. */
type MemberState = 'talkNote' | 'pathsNote' | 'reportsToNote' | 'notes' | 'canLead';

export type CrewLeadSpec = { kind: 'you' } | ({ kind: 'claude' } & Omit<CrewMemberSpec, 'talk' | 'paths' | 'pathsNote' | 'reviews' | 'reportsTo' | 'relation' | MemberState>);

/** A member as a template keeps it: without what it was told while it worked. */
export function memberOfTemplate(member: CrewMemberSpec): CrewMemberSpec {
  const { talkNote: _talk, pathsNote: _paths, reportsToNote: _reports, notes: _notes, canLead: _lead, ...kept } = member;
  return kept;
}

/** A verdict of a member that reviews, on one commit (the tool review): what it covers is that commit and those before it. */
export interface ReviewRecord {
  /** The full hash of the commit. */
  sha: string;
  short: string;
  /** The first line of its message. */
  subject?: string;
  /** The member that reviewed it. */
  by: string;
  verdict: 'approved' | 'changes';
  /** What it found, or what to fix. */
  note?: string;
  at: number;
}

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
  /**
   * What every agent of the team follows, whatever its role: the conventions of the project, how to commit, what
   * never to do. In the system prompt of each session, so nothing is written in the folder of the project.
   */
  rules?: string;
  /**
   * What the team may cost, in dollars at API prices: past it, you are told (once), and its panel shows it in amber.
   * Nothing stops: it is a warning, not a limit.
   */
  budgetUsd?: number;
}

/** The largest budget a team takes, in dollars. */
export const BUDGET_MAX = 100_000;

/** A budget as written: a positive number of dollars, rounded to the cent; undefined for none or a wrong one. */
export function cleanBudget(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number(value.replace(/^\$/, '').trim()) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return undefined;
  return Math.min(BUDGET_MAX, Math.round(number * 100) / 100);
}

/**
 * Where a request stands for one of its recipients: waiting in the queue of the session, blocked by something on
 * its screen, pasted, taken by Claude Code (working on it), passed on (its turn ended, but the work it passed to the
 * members that report to it is still going: it is done when theirs is), done (its turn ended), or failed / cancelled.
 */
export type DeliveryStatus = 'queued' | 'blocked' | 'sent' | 'working' | 'delegated' | 'done' | 'failed' | 'cancelled';

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
  /** Its last message when the turn ended: what goes back to whoever asked, from a member ⇄. */
  answer?: string;
  /**
   * The answer of a member ⇄ on its way back to the session that asked (the Claude lead, or a member it reports
   * to): in the queue of that session, or held for it while it waits for it (wait_for_answers), then given to it there.
   */
  reply?: { status: 'queued' | 'sent' | 'delivered' | 'failed' | 'held'; commandId?: string; reason?: string; byWait?: boolean };
  /** The questions it asked its lead while working on this request (ask_lead). */
  questions?: { text: string; at: number; status: 'queued' | 'sent' | 'delivered' | 'failed' | 'shown'; commandId?: string }[];
}

/** A request of a team: one number, the same text for each recipient. */
export interface CrewRequest {
  n: number;
  /** "the user", the name of the lead, or the name of a member others report to. */
  from: string;
  text: string;
  createdAt: number;
  deliveries: Delivery[];
  /** The request its sender was working on when it sent this one: this one is part of that work. */
  parent?: number;
}

export interface Crew extends CrewSpec {
  id: string;
  createdAt: number;
  /** The sessions started for it: "lead" and the name of each member → the id of its agent. */
  agents: Record<string, string>;
  requests?: CrewRequest[];
  /**
   * The sessions of the team waiting for their answers (wait_for_answers), with the answers held for them: kept in
   * its file, so that a restart of the daemon does not lose a wait, nor the answers it holds.
   */
  waits?: { id: string; by: string; requests: number[]; until: number }[];
  /** Changes of the team the Claude lead has not been told yet: the next text that reaches it carries them. */
  leadNotes?: string[];
  /**
   * The session that opens a folder Claude Code does not trust yet: the rest of the team starts when it said
   * hello (its trust dialog answered).
   */
  waitingTrust?: string;
  /** When you were told that its sessions cost more than its budget: once. */
  budgetSaidAt?: number;
  /** The verdicts of its members that review, oldest first: the last ones only. */
  reviews?: ReviewRecord[];
}

/** What the page shows of a crew. */
export interface CrewSummary {
  id: string;
  name: string;
  /** What it may cost before you are told (CrewSpec). */
  budgetUsd?: number;
  /** The name of the lead when it is a Claude session; undefined when the lead is you. */
  lead?: string;
  /**
   * Who can get a request: the lead when it is Claude, then the members, with their files, whether they review, the
   * member they report to (none: the lead), and whether they can lead a member added under them.
   */
  recipients?: { name: string; agentId?: string; talk?: Talk; lead?: boolean; paths?: string[]; reviews?: boolean; reportsTo?: string; canLead?: boolean }[];
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

export type TeamTool = 'team' | 'send_request' | 'wait_for_answers' | 'ask_lead' | 'review' | 'list_team_templates' | 'save_team_template';

/**
 * The tools of the templates of teams, for a session of Forchetta that is not in a team: it reads them, and saves
 * one, say from a document that describes the roles. A template starts nothing: the user starts it from the app.
 */
export const TEMPLATE_TOOLS: readonly TeamTool[] = ['list_team_templates', 'save_team_template'];
/** Of those, the one a session uses without asking: reading. Saving asks the user, as Claude Code asks for a tool. */
export const TEMPLATE_TOOLS_ALLOWED = `mcp__${TEAM_MCP}__list_team_templates`;

/**
 * The tools of the team a session gets: the Claude lead, and a member others report to, send requests and wait for
 * the answers; a member that answers can ask; a member that reviews records its verdicts; a member → that does not
 * review and leads nobody gets none.
 */
export function teamToolsFor(crew: Pick<CrewSpec, 'talk' | 'members'>, member: Pick<CrewMemberSpec, 'name' | 'talk' | 'reviews'> | 'lead'): TeamTool[] {
  if (member === 'lead') return ['team', 'send_request', 'wait_for_answers'];
  const answers = effectiveTalk(crew, member) === 'twoway';
  const leads = crew.members.some((other) => other.reportsTo === member.name);
  const tools: TeamTool[] = [...(leads ? (['send_request', 'wait_for_answers'] as const) : []), ...(answers ? (['ask_lead'] as const) : []), ...(member.reviews ? (['review'] as const) : [])];
  return tools.length > 0 ? ['team', ...tools] : [];
}

// ── who reports to whom ────────────────────────────────────────────────────────────────────────────────────

/** Whether some member reports to another member: the chart has more than two levels. */
export const hasLevels = (crew: Pick<CrewSpec, 'members'>): boolean => crew.members.some((member) => member.reportsTo !== undefined);

/** The members that report to one: a member by its name, the lead with undefined. */
export const reportsOf = <M extends Pick<CrewMemberSpec, 'reportsTo'>>(members: readonly M[], name: string | undefined): M[] => members.filter((member) => member.reportsTo === name);

/** The name of the one a member reports to: another member, or the lead (its name, or "the user"). */
export const managerName = (crew: Pick<CrewSpec, 'lead'>, member: Pick<CrewMemberSpec, 'reportsTo'>): string => member.reportsTo ?? leadName(crew);

/**
 * Things in the order of a chart: each one followed by the ones under it, depth first, the order kept among
 * brothers. One whose parent is not there (or that is in a circle) goes on top.
 */
export function treeOrder<T, K>(items: readonly T[], key: (item: T) => K, parent: (item: T) => K | undefined): { item: T; depth: number }[] {
  const out: { item: T; depth: number }[] = [];
  const seen = new Set<K>();
  const visit = (above: K | undefined, depth: number): void => {
    for (const item of items) {
      const id = key(item);
      if (seen.has(id) || parent(item) !== above) continue;
      seen.add(id);
      out.push({ item, depth });
      visit(id, depth + 1);
    }
  };
  visit(undefined, 0);
  for (const item of items) {
    if (seen.has(key(item))) continue;
    seen.add(key(item));
    out.push({ item, depth: 0 });
    visit(key(item), 1);
  }
  return out;
}

/** The verdicts a team keeps. */
export const KEPT_REVIEWS = 100;
export const REVIEW_NOTE_MAX = 4000;

// ── the files of a member ───────────────────────────────────────────────────────────────────────────────────

export const PATHS_MAX = 12;
export const PATH_MAX = 200;

/**
 * The files of a member as the panel sends them (a list, or one text with commas or new lines), checked: relative to
 * the folder of the team, without "./" in front, never above it. Undefined for none.
 */
export function cleanPaths(raw: unknown): { paths?: string[] } | { error: string } {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\n]/) : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    let path = item.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    while (path.startsWith('./')) path = path.slice(2);
    if (!path || path === '.') continue;
    if (path.length > PATH_MAX) return { error: `the path "${path.slice(0, 40)}…" is too long` };
    if (path.startsWith('/') || path.startsWith('~')) return { error: `"${path}": write the files relative to the folder of the team` };
    if (path.split('/').includes('..')) return { error: `"${path}": the files must be inside the folder of the team` };
    if (!out.includes(path)) out.push(path);
  }
  if (out.length > PATHS_MAX) return { error: `${PATHS_MAX} paths at most for a member` };
  return out.length > 0 ? { paths: out } : {};
}

/** A pattern with * or ? as a regular expression on a whole path: ** crosses folders, * and ? do not. */
function globRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') {
      // "**/" is any number of folders, none too; "**" at the end is anything.
      if (pattern[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether a path, relative to the folder of the team, is covered by one entry of the files of a member: a folder
 * covers what is under it, a file itself, a pattern what it matches (with no "/" in it, at any depth: "*.css").
 */
export function pathMatches(rel: string, entry: string): boolean {
  if (/[*?]/.test(entry)) {
    const target = entry.replace(/\/$/, '');
    return target.includes('/') ? globRegExp(target).test(rel) : globRegExp(target).test(rel.split('/').at(-1) ?? rel);
  }
  const base = entry.replace(/\/+$/, '');
  return rel === base || rel.startsWith(`${base}/`);
}

/** Whether a path is among the files of a member. */
export const ownsPath = (paths: readonly string[] | undefined, rel: string): boolean => (paths ?? []).some((entry) => pathMatches(rel, entry));

/** "src/ui/, docs/": the files of a member, in a line. */
export const pathsText = (paths: readonly string[]): string => paths.join(', ');

/**
 * Not a rule of how to organize a team (as many members and levels as you like): a ceiling against a team gone wrong,
 * say a template a session wrote with hundreds of members, that would start as many sessions on this Mac.
 */
export const CREW_MAX_MEMBERS = 50;
export const CREW_NAME_MAX = 40;
export const MEMBER_NAME_MAX = 24;
export const ROLE_MAX = 1000;
/** The rules of a whole team: longer than a role, they go to every session. */
export const RULES_MAX = 4000;
/** The notes on the canvas of the studio, kept with a template. */
export const NOTES_MAX = 30;
export const NOTE_MAX = 600;
/** The prompt of a relation, as long as a role. */
export const RELATION_MAX = ROLE_MAX;
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

function cleanChoices(raw: Record<string, unknown>): { model?: string; mode?: string; worktree?: boolean; skills?: string[] } | { error: string } {
  const out: { model?: string; mode?: string; worktree?: boolean; skills?: string[] } = {};
  const skills = cleanSkills(raw.skills);
  if ('error' in skills) return skills;
  if (skills.skills) out.skills = skills.skills;
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
  const rules = block(raw.rules, RULES_MAX);
  const budgetUsd = cleanBudget(raw.budgetUsd);

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
    const files = cleanPaths(member.paths);
    if ('error' in files) return { error: `${memberNameOrError}: ${files.error}` };
    const relation = block(member.relation, RELATION_MAX);
    members.push({
      name: memberNameOrError,
      role: block(member.role, ROLE_MAX) || DEFAULT_MEMBER_ROLE,
      ...(member.talk === 'oneway' || member.talk === 'twoway' ? { talk: member.talk } : {}),
      ...choices,
      ...(files.paths ? { paths: files.paths } : {}),
      ...(member.reviews === true ? { reviews: true } : {}),
      ...(relation ? { relation } : {}),
    });
  }
  const levels = cleanReportsTo(raw.members as unknown[], members, lead);
  if (levels) return levels;
  return { spec: { name, cwd, lead, talk, ...(worktrees ? { worktrees } : {}), members, ...(rules ? { rules } : {}), ...(budgetUsd ? { budgetUsd } : {}) } };
}

/**
 * Who each member reports to, as written (any case): another member, or the lead ("lead", "you", its name, or
 * nothing). Written into the members, with the names as they are; an error for a name that is not in the team, and
 * for a circle (each chain must go up to the lead).
 */
function cleanReportsTo(raw: readonly unknown[], members: CrewMemberSpec[], lead: CrewLeadSpec): { error: string } | undefined {
  const byKey = new Map(members.map((member) => [member.name.toLowerCase(), member.name]));
  const leadKeys = new Set(['lead', 'you', 'the user', 'the lead', ...(lead.kind === 'claude' ? [lead.name.toLowerCase()] : [])]);
  for (const [index, item] of raw.entries()) {
    const member = members[index]!;
    const wanted = oneLine((item as Record<string, unknown> | undefined)?.reportsTo, MEMBER_NAME_MAX * 2);
    if (!wanted) continue;
    const name = byKey.get(wanted.toLowerCase());
    if (!name) {
      if (leadKeys.has(wanted.toLowerCase())) continue;
      return { error: `${member.name}: it reports to "${wanted}", who is not in the team` };
    }
    if (name === member.name) return { error: `${member.name} cannot report to itself` };
    member.reportsTo = name;
  }
  for (const member of members) {
    const seen = new Set([member.name]);
    for (let up = member.reportsTo; up !== undefined; up = members.find((other) => other.name === up)?.reportsTo) {
      if (seen.has(up)) return { error: `${member.name} reports, through ${[...seen].slice(1).join(', ') || 'others'}, to itself: someone in that chain must report to the lead` };
      seen.add(up);
    }
  }
  return undefined;
}

/** The name the members use for their lead. */
export const leadName = (crew: Pick<CrewSpec, 'lead'>): string => (crew.lead.kind === 'claude' ? crew.lead.name : 'the user');

const memberLine = (crew: CrewSpec, member: CrewMemberSpec): string =>
  `- ${member.name} (${effectiveTalk(crew, member) === 'twoway' ? 'answers you' : 'executes only, no answer'}${effectiveWorktree(crew, member) ? ', own worktree' : ''}${member.reviews ? ', reviews' : ''}): ${member.role.replace(/\s+/g, ' ')}${member.paths ? ` — files: ${pathsText(member.paths)}` : ''}`;

/** The prompt of the relation of a member with the one it reports to, under its line: kept on its own lines. */
const relationLines = (member: CrewMemberSpec): string[] =>
  member.relation ? [`  How you work together: ${member.relation.replace(/\n+/g, '\n    ')}`] : [];

/** A member that does not report to you, as you read it: who it reports to, and what it does. */
const otherLine = (crew: CrewSpec, member: CrewMemberSpec): string =>
  `- ${member.name} (reports to ${managerName(crew, member)}${effectiveTalk(crew, member) === 'twoway' ? ', answers it' : ', executes only'}${member.reviews ? ', reviews' : ''}): ${member.role.replace(/\s+/g, ' ')}${member.paths ? ` — files: ${pathsText(member.paths)}` : ''}`;

const WORKTREE_LEAD =
  'A member with "own worktree" works in a git worktree of its own (a copy of the repository, on a branch of its own): you and the others do not see its changes until it commits them and they are merged. Ask it to commit its work at the end of each request. When its work is good, merge its branch into the folder of the team with git, or tell the user it is ready; the tool team shows the folder and the branch of each member.';

const FILES_LEAD =
  'A member with "files" works only on those files (relative to the folder of the team), and the others stay off them: Forchetta stops its edits of other files, and the edits of the other members there. Give each one requests within its files; a change across them is yours to split between them.';

const REVIEW_LEAD =
  'A member that "reviews" checks the commits of the others and records a verdict with the tool review: approved, or changes to make, on one commit and those before it. Merge a branch only up to the last commit it approved: before a git merge of commits it did not approve, Forchetta asks the user. The tool team shows the last verdicts.';

/** The line the next request brings to a member whose files changed: its system prompt still says the old ones. */
export const pathsNote = (paths: readonly string[] | undefined): string =>
  paths && paths.length > 0
    ? `(Your files in the team changed: from now on change only ${pathsText(paths)}.)`
    : '(Your files in the team changed: from now on you may change any file that no other member has.)';

/** The system prompt of the lead, when it is a Claude session: who it is, and its team. */
export function leadPrompt(crew: CrewSpec): string {
  if (crew.lead.kind !== 'claude') return '';
  const levels = hasLevels(crew);
  return [
    `You are ${crew.lead.name}, the lead of the team "${crew.name}" in Forchetta, a control center for parallel Claude Code sessions on this Mac.`,
    `Your role: ${crew.lead.role}`,
    '',
    'Your team: each member is another Claude Code session, in its own terminal.',
    ...(levels
      ? [
          'Your reports, the members you give requests to:',
          ...reportsOf(crew.members, undefined).flatMap((member) => [memberLine(crew, member), ...relationLines(member)]),
          'The others report to one of your reports, which leads them: it gives them requests and gets their answers. You do not write to them: the one they report to does.',
          ...treeOrder(crew.members, (member) => member.name, (member) => member.reportsTo)
            .map(({ item }) => item)
            .filter((member) => member.reportsTo !== undefined)
            .map((member) => otherLine(crew, member)),
        ]
      : crew.members.flatMap((member) => [memberLine(crew, member), ...relationLines(member)])),
    '',
    levels
      ? 'Give work to your reports with the tool send_request of the server "forchetta": one request to one, some or all of them ("all": all your reports). Write each request complete: the member sees only that. It waits in the queue of the member while the member works, so you never need to wait for a member to be free. A report that leads others passes parts of your request to them: its answer reaches you when their work is done too.'
      : 'Give work to the members with the tool send_request of the server "forchetta": one request to one, some or all of them ("all"). Write each request complete: the member sees only that. It waits in the queue of the member while the member works, so you never need to wait for a member to be free.',
    'A member that "answers you" sends you its final message when it finishes a request: it reaches you as a new prompt that starts with "Answer from <name> to request #<n>:". A member that "executes only" does not answer: the tool team tells you when it is done.',
    'A question of a member reaches you as "Question from <name> about request #<n>:": answer it with send_request to that member.',
    'The tool team shows every member, what it does and what it is working on; the team can change while you work (a member added or taken away), and the tool team always shows it as it is now. Send requests that can run at the same time to different members.',
    'When you need the answers of the requests you sent before you can go on, call the tool wait_for_answers: it waits (up to 10 minutes) and gives you all of them at once, in this same turn. Otherwise end your turn: answers that arrive later, or while you do not wait, reach you as new prompts.',
    ...(crew.members.some((member) => effectiveWorktree(crew, member)) ? [WORKTREE_LEAD] : []),
    ...(crew.members.some((member) => member.paths) ? [FILES_LEAD] : []),
    ...(crew.members.some((member) => member.reviews) ? [REVIEW_LEAD] : []),
    'The user sees every session of the team in Forchetta and can also write to the members.',
    ...rulesLines(crew),
  ].join('\n');
}

/** The rules of the whole team, at the end of the system prompt of each session. */
const rulesLines = (crew: Pick<CrewSpec, 'rules'>): string[] => (crew.rules ? ['', 'The rules of the whole team, for you as for every other session of it:', crew.rules] : []);

/** What a member that reviews is told: how to record its verdicts, and what they are for. */
const REVIEW_MEMBER =
  'You review. When you have checked a commit, record your verdict with the tool review of the server "forchetta": the hash of the commit, "approve" or "changes", and a note with what you found or what to fix. An approval covers that commit and those before it: the lead merges only what you approved, and Forchetta asks the user before a merge of anything else. Review the exact commit you approve: one made after it is not covered.';

/** The system prompt of a member: who it is, who its lead is, how requests reach it and whether it answers. */
export function memberPrompt(crew: CrewSpec, member: CrewMemberSpec): string {
  const manager = member.reportsTo !== undefined ? crew.members.find((other) => other.name === member.reportsTo) : undefined;
  const lead = manager
    ? `${manager.name}, another Claude Code session: a member of the team, who reports to ${managerName(crew, manager)}${manager.reportsTo === undefined && crew.lead.kind === 'claude' ? ', the lead of the team' : ''}`
    : crew.lead.kind === 'claude'
      ? `${crew.lead.name}, another Claude Code session`
      : 'the user, from the Forchetta app';
  const from = manager ? manager.name : crew.lead.kind === 'claude' ? crew.lead.name : 'the user';
  const levels = hasLevels(crew);
  const mine = reportsOf(crew.members, member.name);
  const answers = effectiveTalk(crew, member) === 'twoway';
  const others = crew.members.filter((other) => other !== member && other.reportsTo !== member.name);
  return [
    `You are ${member.name}, a member of the team "${crew.name}" in Forchetta, a control center for parallel Claude Code sessions on this Mac.`,
    `Your role: ${member.role}`,
    `Your lead is ${lead}.`,
    ...(member.relation ? [`How you work with ${from}: ${member.relation}`] : []),
    '',
    `Requests reach you as prompts that start with "Request #<n> from ${from}:" (or "from the user", when the user writes to you directly). Do what they ask, within your role.`,
    effectiveTalk(crew, member) === 'twoway'
      ? `When you finish a request, your final message goes back to your lead by itself: end with a short report of what you did, what you found and what is left. If you cannot go on without an answer, ask with the tool ask_lead of the server "forchetta", then end your turn: the answer comes as a new request.`
      : 'You execute: your final message is not sent to your lead, so you do not need to report back. Just do the work well.',
    ...(effectiveWorktree(crew, member)
      ? [
          'You work in a git worktree of your own (a copy of the repository, on a branch of your own): the other members and your lead do not see your changes until you commit them. Commit your work at the end of each request, with a clear message, so that your lead can see it and merge it.',
        ]
      : [
          'You share the folder with other sessions. If Forchetta stops you from editing a file because another session is changing it, do not insist: work on another part of the request, or end your turn saying which file you are waiting for. You will be told when it is free.',
        ]),
    ...(member.paths
      ? [
          `Your files in the team, relative to its folder: ${pathsText(member.paths)}. Change only those: Forchetta stops your edits of any other file. When a request needs a change elsewhere, do your part and end your turn saying what is needed there.`,
        ]
      : others.some((other) => other.paths)
        ? ['The files of the other members are theirs (they are listed below): Forchetta stops your edits there. When a request needs a change in them, do your part and end your turn saying what is needed there.']
        : []),
    ...(member.reviews ? [REVIEW_MEMBER] : []),
    ...(mine.length > 0
      ? [
          '',
          'You lead members of the team too: they report to you, take requests from you, and their answers come back to you.',
          ...mine.flatMap((report) => [memberLine(crew, report), ...relationLines(report)]),
          'Give them work with the tool send_request of the server "forchetta": one request to one, some or all of them ("all": all of them). Write each request complete: the member sees only that. A member that "answers you" sends you its final message as a new prompt "Answer from <name> to request #<n>:"; its questions reach you as "Question from <name> about request #<n>:", and you answer them with send_request. To get the answers in this same turn, call the tool wait_for_answers (it waits up to 10 minutes).',
          answers
            ? `A request you pass on stays open: your final message goes back to ${from} only when the work you passed to them is done and you have read their answers. So pass the work, wait for the answers or end your turn, check what comes back, and end with your report on the whole request.`
            : 'A request you pass on stays open until the work you passed to them is done.',
        ]
      : []),
    ...(others.length > 0
      ? [
          '',
          'The other members of the team:',
          ...others.map(
            (other) =>
              `- ${other.name}${levels ? ` (reports to ${managerName(crew, other)})` : ''}: ${other.role.replace(/\s+/g, ' ')}${other.paths ? ` — files: ${pathsText(other.paths)}` : ''}`,
          ),
        ]
      : []),
    ...rulesLines(crew),
  ].join('\n');
}

/** The line the next request brings to a member whose lead changed (the one it reported to left the team). */
export const reportsToNote = (lead: string): string => `(The one you report to changed: from now on your lead is ${lead}. Your answers and your questions go to ${lead}.)`;

/**
 * One step of the thread of a team, in the order things happened: a request (from you or the lead, to some
 * recipients, with how it goes for each), a question of a member, the end of a request with its last message and
 * where that message went: to the lead (queued, sent, delivered), to you (shown), or nowhere (kept: the member
 * executes only, or it asked a question and its answer comes with the next request).
 */
export type ThreadEntry =
  | { kind: 'request'; at: number; n: number; from: string; text: string; deliveries: Delivery[]; parent?: number }
  | { kind: 'question'; at: number; n: number; from: string; to: string; text: string; status: NonNullable<Delivery['questions']>[number]['status'] }
  | { kind: 'answer'; at: number; n: number; from: string; to: string; text?: string; status: 'shown' | 'kept' | 'queued' | 'sent' | 'delivered' | 'failed' | 'held'; byWait?: boolean }
  /** A verdict of a member that reviews (the tool review): the commit, and its note. */
  | { kind: 'review'; at: number; n: number; from: string; short: string; subject?: string; verdict: ReviewRecord['verdict']; text?: string };

const ORDER: Record<ThreadEntry['kind'], number> = { request: 0, question: 1, answer: 2, review: 3 };

/** The thread of a team, oldest first, from its requests and the verdicts of its reviewers. */
export function threadOf(requests: readonly CrewRequest[], reviews: readonly ReviewRecord[] = []): ThreadEntry[] {
  const entries: ThreadEntry[] = reviews.map((review) => ({
    kind: 'review' as const,
    at: review.at,
    n: 0,
    from: review.by,
    short: review.short,
    ...(review.subject ? { subject: review.subject } : {}),
    verdict: review.verdict,
    ...(review.note ? { text: review.note } : {}),
  }));
  for (const request of requests) {
    entries.push({ kind: 'request', at: request.createdAt, n: request.n, from: request.from, text: request.text, deliveries: request.deliveries, ...(request.parent !== undefined ? { parent: request.parent } : {}) });
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

const OPEN_STATUSES: readonly DeliveryStatus[] = ['queued', 'blocked', 'sent', 'working', 'delegated'];

/**
 * What the box of a session of a team says of its requests: the one it works on ("#3 from lead: write the
 * parser"); the one it passed on to the members that report to it, with what it waits on; for a session not at
 * work on one, the requests it sent that are still open. A request still in the queue is said by the line of the
 * queue of the box, which can also cancel it.
 */
export function crewLineOf(agentId: string, crews: readonly CrewSummary[]): string | undefined {
  for (const crew of crews) {
    const me = crew.recipients?.find((recipient) => recipient.agentId === agentId);
    if (!me) continue;
    const requests = crew.requests ?? [];
    const mine = requests.flatMap((request) => request.deliveries.filter((d) => d.agentId === agentId && OPEN_STATUSES.includes(d.status)).map((d) => ({ request, d })));
    const working = mine.find((item) => item.d.status === 'working' || item.d.status === 'sent');
    const waiting = mine.filter((item) => item !== working && item.d.status !== 'delegated').length;
    const from = (request: CrewRequest): string => (request.from === 'the user' ? 'you' : request.from);
    const first = (text: string): string => text.split('\n').find((line) => line.trim())?.trim() ?? '';
    if (working) return `#${working.request.n} from ${from(working.request)}: ${first(working.request.text)}${waiting > 0 ? ` · ${waiting} more waiting` : ''}`;
    const open = requests.filter((request) => request.from === me.name).flatMap((request) => request.deliveries.filter((d) => OPEN_STATUSES.includes(d.status)).map((d) => `#${request.n} ${d.to}`));
    const passed = mine.find((item) => item.d.status === 'delegated');
    if (passed) return `#${passed.request.n} from ${from(passed.request)}: ${first(passed.request.text)} · waits on ${open.join(', ') || 'its members'}`;
    return open.length > 0 ? `waits on ${open.join(', ')}` : undefined;
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
  /** Where its boxes stand in the studio: by name ("you" for you), x and y. None: the studio lays them out. */
  layout?: Record<string, [number, number]>;
  /** The rules of the whole team (CrewSpec). */
  rules?: string;
  /** What the team may cost before you are told (CrewSpec). */
  budgetUsd?: number;
  /** The notes written on its canvas in the studio, where they stand. */
  notes?: { x: number; y: number; text: string }[];
  /** One of the templates that come with Forchetta: it cannot be deleted. */
  builtin?: boolean;
  /** One of those, changed by you: deleting your version brings back the one of Forchetta. */
  modified?: boolean;
}

/**
 * A preset of the studio: one agent ready to drop on a team, with its role, model, permissions and the rest. Some
 * come with Forchetta; you change them (your version replaces theirs until you restore it), duplicate them, or save
 * a box of the studio as one of yours.
 */
export interface RolePreset extends Omit<CrewMemberSpec, 'talk' | 'reportsTo' | 'relation' | MemberState> {
  builtin?: boolean;
  modified?: boolean;
}

/** A preset as the app sends it, checked like a member of a team; or what is wrong with it. */
export function cleanRolePreset(input: unknown): { preset: RolePreset } | { error: string } {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const checked = cleanCrewSpec({ name: 'preset', cwd: '/', lead: { kind: 'claude', name: 'the-lead-of-a-preset', role: '' }, members: [{ ...raw, talk: undefined, reportsTo: undefined, relation: undefined }] });
  if ('error' in checked) return { error: checked.error.replace(/^member 1: /, '') };
  return { preset: memberOfTemplate(checked.spec.members[0]!) };
}

/** The presets of agents that come with Forchetta. Their roles are in the third person: the others read them too. */
export const BUILTIN_ROLES: readonly RolePreset[] = [
  {
    name: 'manager',
    builtin: true,
    skills: ['brainstorming', 'planning-and-task-breakdown'],
    model: 'opus',
    role: 'Turns the goal into clear tasks for the members it leads, with the why and what done means; checks what comes back against the goal, and reports what is done and what is left. Leaves how to build it to them.',
  },
  {
    name: 'senior',
    builtin: true,
    skills: ['writing-plans', 'code-review-and-quality', 'systematic-debugging'],
    model: 'opus',
    role: 'Plans the technical work, gives the members it leads well-scoped steps, reviews every change they make (git diff), fixes or sends back what is wrong, and reports when the whole task is done and reviewed.',
  },
  {
    name: 'junior',
    builtin: true,
    skills: ['test-driven-development', 'verification-before-completion', 'karpathy-guidelines'],
    model: 'sonnet',
    role: 'Writes the code of the steps it is given, small, with a test for each, following the conventions of the project; asks before any change outside its step.',
  },
  { name: 'developer', builtin: true, model: 'sonnet', skills: ['test-driven-development', 'incremental-implementation', 'verification-before-completion'], role: 'Writes the code it is asked for, in small steps, with a test for each step, and commits it.' },
  {
    name: 'reviewer',
    builtin: true,
    model: 'opus',
    reviews: true,
    skills: ['code-review-and-quality', 'differential-review'],
    role: 'Reviews the commits of the others (git log and git diff against the main branch): bugs, risks, missing tests. Does not change the code: approves the commit it checked, or says what to fix.',
  },
  { name: 'tester', builtin: true, model: 'sonnet', skills: ['webapp-testing', 'property-based-testing'], role: 'Writes and runs the tests of what it is asked, end to end where it matters, and reports what fails with how to reproduce it.' },
  { name: 'frontend', builtin: true, model: 'sonnet', skills: ['frontend-design', 'accessibility-engineering'], role: 'Builds the user interface it is asked for, following the conventions of the project.' },
  { name: 'backend', builtin: true, model: 'sonnet', skills: ['test-driven-development', 'security-and-hardening', 'performance-optimization'], role: 'Builds the server side it is asked for: data, logic and API, with tests.' },
  { name: 'researcher', builtin: true, model: 'sonnet', role: 'Finds the facts it is asked for, checks them against the sources, and reports them with where they come from.' },
  { name: 'writer', builtin: true, model: 'sonnet', role: 'Writes the text it is asked for, clear and short, from what the request gives it.' },
];

/** At most this many boxes in the layout of a template: a lead, the members, you. */
const LAYOUT_MAX = CREW_MAX_MEMBERS + 2;

/** The layout of a template as it was sent: names of the team (and "you"), each with two numbers. */
function cleanLayout(raw: unknown, names: readonly string[]): Record<string, [number, number]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, [number, number]> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!names.includes(name) || !Array.isArray(value) || value.length !== 2) continue;
    const [x, y] = value as unknown[];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[name] = [Math.round(Math.min(Math.max(x, -10_000), 10_000)), Math.round(Math.min(Math.max(y, -10_000), 10_000))];
    if (Object.keys(out).length >= LAYOUT_MAX) break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The skills of an agent preset of Forchetta: a template of Forchetta gives the same to the agent of that role. */
const skillsOfRole = (name: string): { skills?: string[] } => {
  const skills = BUILTIN_ROLES.find((preset) => preset.name === name)?.skills;
  return skills ? { skills: [...skills] } : {};
};

/** The templates that come with Forchetta. */
export const BUILTIN_TEMPLATES: readonly CrewTemplate[] = [
  {
    name: 'developer + reviewer',
    builtin: true,
    lead: {
      kind: 'claude',
      name: 'lead',
      role: 'Split the goal into small steps: the developer writes each one, the reviewer checks it; send the fixes back until the reviewer approves, then merge the branch of the developer up to what it approved.',
    },
    talk: 'twoway',
    worktrees: true,
    members: [
      { name: 'developer', ...skillsOfRole('developer'), role: 'Write the code you are asked for, in small steps, with a test for each step, and commit it.' },
      {
        name: 'reviewer',
        ...skillsOfRole('reviewer'),
        role: 'Review the commits of the developer on its branch (git log and git diff against the main branch): bugs, risks, missing tests. Do not change the code yourself: approve the commit you checked, or say what to fix.',
        reviews: true,
      },
    ],
  },
  {
    name: 'feature squad',
    builtin: true,
    lead: { kind: 'claude', name: 'lead', role: 'Plan the feature, split it between frontend and backend, have the tester check it, keep the pieces consistent, and merge the branches when they are ready.' },
    talk: 'twoway',
    worktrees: true,
    members: [
      { name: 'frontend', ...skillsOfRole('frontend'), role: 'Build the user interface of the feature, following the conventions of the project.' },
      { name: 'backend', ...skillsOfRole('backend'), role: 'Build the server side of the feature: data, logic and API, with tests.' },
      { name: 'tester', ...skillsOfRole('tester'), role: 'Write and run the tests of what you are asked, end to end where it matters. Report what fails, with how to reproduce it.' },
    ],
  },
  {
    name: 'manager › senior › junior',
    builtin: true,
    lead: {
      kind: 'claude',
      name: 'manager',
      ...skillsOfRole('manager'),
      role: 'Turn the goal into clear tasks for the senior, with the why and what done means; check what comes back against the goal, and tell the user what is done and what is left. Leave how to build it to the senior.',
    },
    talk: 'twoway',
    members: [
      {
        name: 'senior',
        ...skillsOfRole('senior'),
        role: 'Plan the technical work of each task, give the junior well-scoped steps, review every change of the junior (git diff), fix or send back what is wrong, and report to the manager when the whole task is done and reviewed.',
        relation: 'The manager says what is needed and why; the senior decides how. The senior reports when the task is done and reviewed: what changed, how it was checked, what is left. It asks the manager only about the goal, never about the code.',
      },
      {
        name: 'junior',
        ...skillsOfRole('junior'),
        role: 'Write the code of the steps the senior gives, small, with a test for each, following the conventions of the project.',
        reportsTo: 'senior',
        relation: 'The senior gives one step at a time, with the files to touch and what done means. The junior reports what it changed and how it tested it, and asks the senior before any change outside its step.',
      },
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

/** The notes of a canvas as sent: a place and a text each, the empty ones left out. */
function cleanNotes(raw: unknown): { x: number; y: number; text: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: { x: number; y: number; text: string }[] = [];
  for (const item of raw) {
    const note = item as { x?: unknown; y?: unknown; text?: unknown } | undefined;
    const text = block(note?.text, NOTE_MAX);
    if (!text || typeof note?.x !== 'number' || typeof note.y !== 'number' || !Number.isFinite(note.x) || !Number.isFinite(note.y)) continue;
    out.push({ x: Math.round(Math.min(Math.max(note.x, -10_000), 10_000)), y: Math.round(Math.min(Math.max(note.y, -10_000), 10_000)), text });
    if (out.length >= NOTES_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

/** A template as the panel sends it, checked like a team (the folder aside); or what is wrong with it. */
export function cleanTemplate(input: unknown): { template: CrewTemplate } | { error: string } {
  const checked = cleanCrewSpec({ ...((input ?? {}) as object), cwd: '/' });
  if ('error' in checked) return checked;
  const { cwd: _cwd, ...rest } = checked.spec;
  const names = ['you', ...(rest.lead.kind === 'claude' ? [rest.lead.name] : []), ...rest.members.map((member) => member.name)];
  const layout = cleanLayout((input as Record<string, unknown> | undefined)?.layout, names);
  const notes = cleanNotes((input as Record<string, unknown> | undefined)?.notes);
  return { template: { ...rest, members: rest.members.map(memberOfTemplate), ...(layout ? { layout } : {}), ...(notes ? { notes } : {}) } };
}

/**
 * What cleanCrewSpec would cut short without a word (a name or a role too long), said for a caller that does not
 * see the panel: a session that saves a template. Undefined when nothing is too long.
 */
export function tooLong(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const lineLength = (value: unknown): number => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().length : 0);
  const blockLength = (value: unknown): number => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().length : 0);
  const name = lineLength(raw.name);
  if (name > CREW_NAME_MAX) return `the name of the team is ${name} characters: ${CREW_NAME_MAX} at most`;
  const rules = blockLength(raw.rules);
  if (rules > RULES_MAX) return `the rules of the team are ${rules} characters: ${RULES_MAX} at most`;
  const people: [string, unknown][] = [['the lead', raw.lead], ...(Array.isArray(raw.members) ? raw.members.map((member, index): [string, unknown] => [`member ${index + 1}`, member]) : [])];
  for (const [what, item] of people) {
    if (!item || typeof item !== 'object') continue;
    const person = item as Record<string, unknown>;
    const label = typeof person.name === 'string' && person.name.trim() ? `"${person.name.trim()}"` : what;
    const nameLength = lineLength(person.name);
    if (nameLength > MEMBER_NAME_MAX) return `${label}: the name is ${nameLength} characters, ${MEMBER_NAME_MAX} at most`;
    const roleLength = blockLength(person.role);
    if (roleLength > ROLE_MAX) {
      return `${label}: the role is ${roleLength} characters, ${ROLE_MAX} at most (what the whole team shares belongs in its rules)`;
    }
    const relationLength = blockLength(person.relation);
    if (relationLength > RELATION_MAX) {
      return `${label}: the prompt of its relation is ${relationLength} characters, ${RELATION_MAX} at most (what the whole team shares belongs in its rules)`;
    }
  }
  return undefined;
}

/** A team as a template: what is needed to start it again, without its folder, its sessions and its requests. */
export const templateOf = (spec: CrewSpec, name = spec.name): CrewTemplate => ({
  name,
  lead: spec.lead,
  talk: spec.talk,
  ...(spec.worktrees ? { worktrees: true } : {}),
  members: spec.members.map(memberOfTemplate),
  ...(spec.rules ? { rules: spec.rules } : {}),
  ...(spec.budgetUsd ? { budgetUsd: spec.budgetUsd } : {}),
});
