import type { CrewRequest, CrewSummary } from '../shared/crew.ts';

// What the lines of a team of agents say in the org chart (OrgLinks.tsx draws them): what goes on along each one,
// what just arrived, and where each one runs. No DOM here: the tests use it.

/** What goes on along the line of a member now. */
export type LinkKind = 'queued' | 'working' | 'answer' | 'question';
/** What just arrived along it: a request at the member; an answer or a question at the lead. */
export type ArrivalKind = 'request' | 'answer' | 'question';

export interface Arrival {
  id: string;
  agentId: string;
  kind: ArrivalKind;
}

/** How long the flash of an arrival lasts (the CSS animation link-flash). */
export const FLASH_MS = 1300;

const QUEUED = new Set(['queued', 'blocked']);
const AT_WORK = new Set(['sent', 'working']);
const ON_ITS_WAY = new Set(['queued', 'sent']);
const ARRIVED = new Set(['sent', 'delivered', 'held']);
const ASKED = new Set(['sent', 'delivered', 'shown']);
export const RANK: Record<LinkKind, number> = { queued: 1, working: 2, answer: 3, question: 4 };

/** Whether a request came down the lines: from the Claude lead, or from you when you lead the team. */
const fromLead = (crew: CrewSummary, request: CrewRequest): boolean => (crew.lead === undefined ? request.from === 'the user' : request.from === crew.lead);

export const leadAgent = (crew: CrewSummary): string | undefined => crew.recipients?.find((recipient) => recipient.lead)?.agentId;

/** The line of each member that has something going on, by the id of its session; the others are quiet. */
export function linkStates(crew: CrewSummary): Map<string, LinkKind> {
  const lead = leadAgent(crew);
  const out = new Map<string, LinkKind>();
  const mark = (agentId: string | undefined, kind: LinkKind): void => {
    if (!agentId || agentId === lead) return;
    const now = out.get(agentId);
    if (!now || RANK[kind] > RANK[now]) out.set(agentId, kind);
  };
  for (const request of crew.requests ?? []) {
    if (!fromLead(crew, request)) continue;
    for (const delivery of request.deliveries) {
      if (QUEUED.has(delivery.status)) mark(delivery.agentId, 'queued');
      if (AT_WORK.has(delivery.status)) mark(delivery.agentId, 'working');
      if (delivery.reply && ON_ITS_WAY.has(delivery.reply.status)) mark(delivery.agentId, 'answer');
      if (delivery.questions?.some((question) => ON_ITS_WAY.has(question.status))) mark(delivery.agentId, 'question');
    }
  }
  return out;
}

/** What the page knew of each delivery of a team, to tell what arrived since. */
export type Snapshot = Map<string, { status: string; reply?: string; asked: number }>;

export function snapshotOf(crew: CrewSummary): Snapshot {
  const out: Snapshot = new Map();
  for (const request of crew.requests ?? []) {
    for (const delivery of request.deliveries) {
      out.set(`${request.n}:${delivery.to}`, {
        status: delivery.status,
        ...(delivery.reply ? { reply: delivery.reply.status } : {}),
        asked: (delivery.questions ?? []).filter((question) => ASKED.has(question.status)).length,
      });
    }
  }
  return out;
}

/**
 * What arrived between two states of a team: a request that reached its member (it left the queue), an answer
 * that reached the lead (or you, when you lead), a question that reached the lead. Nothing the first time: a page
 * that opens does not flash what happened before.
 */
export function arrivalsBetween(before: Snapshot | undefined, crew: CrewSummary, stamp = Date.now()): Arrival[] {
  if (!before) return [];
  const lead = leadAgent(crew);
  const out: Arrival[] = [];
  for (const request of crew.requests ?? []) {
    if (!fromLead(crew, request)) continue;
    for (const delivery of request.deliveries) {
      const agentId = delivery.agentId;
      if (!agentId || agentId === lead) continue;
      const key = `${request.n}:${delivery.to}`;
      const was = before.get(key);
      const add = (kind: ArrivalKind): void => {
        out.push({ id: `${crew.id}:${key}:${kind}:${stamp}`, agentId, kind });
      };
      if (AT_WORK.has(delivery.status) && (!was || QUEUED.has(was.status))) add('request');
      const answered = delivery.reply
        ? ARRIVED.has(delivery.reply.status) && !(was?.reply && ARRIVED.has(was.reply))
        : // Led by you: the answer is yours the moment the member finishes.
          crew.lead === undefined && delivery.status === 'done' && delivery.answer !== undefined && was !== undefined && was.status !== 'done';
      if (answered) add('answer');
      const asked = (delivery.questions ?? []).filter((question) => ASKED.has(question.status)).length;
      if (asked > (was?.asked ?? 0)) add('question');
    }
  }
  return out;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The line from the lead to a member: down from the lead to the middle of the gap, across, then down into the
 * member. A member below the first row is reached along the gutter on its left, into its side near the top, so
 * that no line crosses a box.
 */
export function linkPath(lead: Box | undefined, member: Box, firstTop: number, width: number): string {
  const x = lead ? lead.left + lead.width / 2 : width / 2;
  const from = lead ? lead.top + lead.height : firstTop - 36;
  const bus = from + (firstTop - from) / 2;
  const round = (value: number): number => Math.round(value) + 0.5;
  if (Math.abs(member.top - firstTop) < 4) return `M${round(x)} ${round(from)} V${round(bus)} H${round(member.left + member.width / 2)} V${Math.round(member.top)}`;
  const gutter = member.left - 8;
  return `M${round(x)} ${round(from)} V${round(bus)} H${round(gutter)} V${round(member.top + 24)} H${Math.round(member.left)}`;
}
