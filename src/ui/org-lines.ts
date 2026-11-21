import type { CrewRequest, CrewSummary, Delivery } from '../shared/crew.ts';

// What the lines of a team of agents say in the org chart (OrgLinks.tsx draws them): what goes on along each one,
// what just arrived, and where each one runs. Each member has one line, up to the one it reports to: the lead, or
// another member. No DOM here: the tests use it.

/** What goes on along the line of a member now. */
export type LinkKind = 'approval' | 'queued' | 'working' | 'answer' | 'question';
/** What just arrived along it: a request at the member; an answer or a question at the one above it. */
export type ArrivalKind = 'request' | 'answer' | 'question';

export interface Arrival {
  id: string;
  agentId: string;
  kind: ArrivalKind;
}

/** How long the flash of an arrival lasts (the CSS animation link-flash). */
export const FLASH_MS = 1300;

const QUEUED = new Set(['queued', 'blocked']);
/** At work: on it, or waiting for the work it passed to the members below it. */
const AT_WORK = new Set(['sent', 'working', 'delegated']);
const ON_ITS_WAY = new Set(['queued', 'sent']);
const ARRIVED = new Set(['sent', 'delivered', 'held']);
const ASKED = new Set(['sent', 'delivered', 'shown']);
export const RANK: Record<LinkKind, number> = { queued: 1, working: 2, answer: 3, question: 4, approval: 5 };

export const leadAgent = (crew: CrewSummary): string | undefined => crew.recipients?.find((recipient) => recipient.lead)?.agentId;

type Recipient = NonNullable<CrewSummary['recipients']>[number];

/** The one a member reports to, by name: another member, or the lead (its name, or "the user" when you lead). */
export const managerOf = (crew: CrewSummary, recipient: Pick<Recipient, 'reportsTo'>): string => recipient.reportsTo ?? crew.lead ?? 'the user';

/**
 * The member whose line a delivery went along: its recipient, when the request came from the one it reports to.
 * A request you write to a member below the top, or to the lead, goes along no line.
 */
function along(crew: CrewSummary, request: CrewRequest, delivery: Delivery): Recipient | undefined {
  const recipient = crew.recipients?.find((candidate) => !candidate.lead && candidate.name === delivery.to);
  return recipient && request.from === managerOf(crew, recipient) ? recipient : undefined;
}

/** The line of each member that has something going on, by the id of its session; the others are quiet. */
export function linkStates(crew: CrewSummary): Map<string, LinkKind> {
  const out = new Map<string, LinkKind>();
  const mark = (agentId: string | undefined, kind: LinkKind): void => {
    if (!agentId) return;
    const now = out.get(agentId);
    if (!now || RANK[kind] > RANK[now]) out.set(agentId, kind);
  };
  for (const request of crew.requests ?? []) {
    for (const delivery of request.deliveries) {
      if (!along(crew, request, delivery)) continue;
      if (delivery.status === 'approval') mark(delivery.agentId, 'approval');
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
 * that reached the one above it (the lead, a member, or you), a question that reached it. Nothing the first time:
 * a page that opens does not flash what happened before.
 */
export function arrivalsBetween(before: Snapshot | undefined, crew: CrewSummary, stamp = Date.now()): Arrival[] {
  if (!before) return [];
  const out: Arrival[] = [];
  for (const request of crew.requests ?? []) {
    for (const delivery of request.deliveries) {
      const agentId = delivery.agentId;
      if (!agentId || !along(crew, request, delivery)) continue;
      const key = `${request.n}:${delivery.to}`;
      const was = before.get(key);
      const add = (kind: ArrivalKind): void => {
        out.push({ id: `${crew.id}:${key}:${kind}:${stamp}`, agentId, kind });
      };
      if (AT_WORK.has(delivery.status) && (!was || QUEUED.has(was.status))) add('request');
      const answered = delivery.reply
        ? ARRIVED.has(delivery.reply.status) && !(was?.reply && ARRIVED.has(was.reply))
        : // Asked by you: the answer is yours the moment the member finishes.
          request.from === 'the user' && delivery.status === 'done' && delivery.answer !== undefined && was !== undefined && was.status !== 'done';
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
 * The line from the one above (the lead, or the member it reports to) to a member: down from the one above to the
 * middle of the gap, across, then down into the member. `firstTop` is the top of the first row of the members
 * under the same one. A member below that row, in a grid, is reached along the gutter on its left, into its side
 * near the top. In a tree (`lane`: the x just left of the row of its brothers) the boxes do not line up in columns:
 * the line goes down that lane, then across the gap above its row and down into it. So no line crosses a box.
 */
export function linkPath(lead: Box | undefined, member: Box, firstTop: number, width: number, lane?: number): string {
  const x = lead ? lead.left + lead.width / 2 : width / 2;
  const from = lead ? lead.top + lead.height : firstTop - 36;
  const bus = from + (firstTop - from) / 2;
  const round = (value: number): number => Math.round(value) + 0.5;
  const middle = member.left + member.width / 2;
  if (Math.abs(member.top - firstTop) < 4) return `M${round(x)} ${round(from)} V${round(bus)} H${round(middle)} V${Math.round(member.top)}`;
  if (lane !== undefined) return `M${round(x)} ${round(from)} V${round(bus)} H${round(lane)} V${round(member.top - 8)} H${round(middle)} V${Math.round(member.top)}`;
  const gutter = member.left - 8;
  return `M${round(x)} ${round(from)} V${round(bus)} H${round(gutter)} V${round(member.top + 24)} H${Math.round(member.left)}`;
}
