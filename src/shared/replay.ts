import type { CrewRequest, Delivered, DeliveryStatus, ReviewRecord } from './crew.ts';

// The replay of a team: what happened in it, in order of time, from its file (requests, your approvals, questions,
// answers, the verdicts of its reviewers, what it delivered) and from the ledger (what each session cost, the files
// each turn wrote). The studio plays it on the canvas: the arrows light up as the requests went along them, and each
// box shows what its agent had cost and written until then. No Node module here: the page uses it too.

/** What the ledger says of a session of a team, by the name of its agent: a cost, or a turn with the files it wrote. */
export type ReplayUsage = { t: number; who: string; usd: number } | { t: number; who: string; files: string[]; ms?: number };

export type ReplayEvent =
  | { t: number; kind: 'request'; n: number; from: string; to: string[]; text: string }
  | { t: number; kind: 'approval'; n: number; to: string; decision: 'approved' | 'rejected' }
  | { t: number; kind: 'question'; n: number; from: string; to: string; text: string }
  /** The end of a request for one member, with its last message: `back` when it went to whoever asked. */
  | { t: number; kind: 'answer'; n: number; from: string; to: string; text?: string; back: boolean }
  | { t: number; kind: 'review'; from: string; short: string; verdict: 'approved' | 'changes'; text?: string }
  | { t: number; kind: 'turn'; who: string; files: string[]; ms?: number }
  | { t: number; kind: 'delivered'; from: string; text: string; where?: string };

/** A request to one member, from when it left until it was over: the arrow into that member is lit meanwhile. */
export interface ReplaySpan {
  n: number;
  from: string;
  to: string;
  start: number;
  /** When it was over; undefined while it is still open. */
  end?: number;
  status: DeliveryStatus;
  /** It waited for your approval first: until then (or until now, if you have not decided). */
  approvalUntil?: number;
}

export interface ReplayData {
  start: number;
  end: number;
  events: ReplayEvent[];
  spans: ReplaySpan[];
  costs: { t: number; who: string; usd: number }[];
}

const CLOSED: readonly DeliveryStatus[] = ['done', 'failed', 'cancelled'];

/** The run of a team, from its file and what the ledger says of its sessions; `now` ends what is still open. */
export function replayOf(
  crew: { createdAt: number; requests?: readonly CrewRequest[]; reviews?: readonly ReviewRecord[]; delivered?: readonly Delivered[] },
  usage: readonly ReplayUsage[] = [],
  now = Date.now(),
): ReplayData {
  const events: ReplayEvent[] = [];
  const spans: ReplaySpan[] = [];
  for (const request of crew.requests ?? []) {
    events.push({ t: request.createdAt, kind: 'request', n: request.n, from: request.from, to: request.deliveries.map((delivery) => delivery.to), text: request.text });
    for (const delivery of request.deliveries) {
      const closed = CLOSED.includes(delivery.status);
      spans.push({
        n: request.n,
        from: request.from,
        to: delivery.to,
        start: request.createdAt,
        ...(closed ? { end: Math.max(request.createdAt, delivery.at) } : {}),
        status: delivery.status,
        ...(delivery.approval ? { approvalUntil: delivery.approval.at } : delivery.status === 'approval' ? { approvalUntil: now } : {}),
      });
      if (delivery.approval) events.push({ t: delivery.approval.at, kind: 'approval', n: request.n, to: delivery.to, decision: delivery.approval.decision });
      for (const question of delivery.questions ?? []) events.push({ t: question.at, kind: 'question', n: request.n, from: delivery.to, to: request.from, text: question.text });
      if (delivery.status === 'done' || (delivery.status === 'failed' && delivery.answer)) {
        const back = request.from === 'the user' ? delivery.talk !== 'oneway' : delivery.reply !== undefined;
        events.push({ t: delivery.at, kind: 'answer', n: request.n, from: delivery.to, to: request.from, ...(delivery.answer ? { text: delivery.answer } : {}), back });
      }
    }
  }
  for (const review of crew.reviews ?? []) events.push({ t: review.at, kind: 'review', from: review.by, short: review.short, verdict: review.verdict, ...(review.note ? { text: review.note } : {}) });
  for (const item of crew.delivered ?? []) events.push({ t: item.at, kind: 'delivered', from: item.by, text: item.summary, ...(item.where ? { where: item.where } : {}) });
  const costs: ReplayData['costs'] = [];
  for (const entry of usage) {
    if (entry.t < crew.createdAt) continue;
    if ('usd' in entry) costs.push({ t: entry.t, who: entry.who, usd: entry.usd });
    else if (entry.files.length > 0) events.push({ t: entry.t, kind: 'turn', who: entry.who, files: [...entry.files], ...(entry.ms !== undefined ? { ms: entry.ms } : {}) });
  }
  const order: Record<ReplayEvent['kind'], number> = { request: 0, approval: 1, question: 2, turn: 3, answer: 4, review: 5, delivered: 6 };
  events.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind]);
  costs.sort((a, b) => a.t - b.t);
  const last = Math.max(crew.createdAt, ...events.map((event) => event.t), ...costs.map((cost) => cost.t));
  const open = spans.some((span) => span.end === undefined);
  return { start: crew.createdAt, end: open ? Math.max(last, now) : last, events, spans, costs };
}

export type ReplayArrow = 'approval' | 'queued' | 'working' | 'answer' | 'question';

/** The canvas at one moment of a run. */
export interface ReplayFrame {
  /** By the name of an agent: what it had cost until then, the files its turns had written, the request it was on. */
  agents: Map<string, { usd: number; files: string[]; on?: number }>;
  /** By the name of the agent an arrow goes into: what went along that arrow then. */
  arrows: Map<string, ReplayArrow>;
  /** The last event at that moment or before it, by its place in the events; -1 before the first. */
  index: number;
}

const RANK: Record<ReplayArrow, number> = { queued: 1, working: 2, answer: 3, question: 4, approval: 5 };

/** What the canvas shows at time t: the requests open then, what the last event carried, what each agent had used. */
export function replayAt(data: ReplayData, t: number): ReplayFrame {
  const agents = new Map<string, { usd: number; files: string[]; on?: number }>();
  const agent = (name: string): { usd: number; files: string[]; on?: number } => {
    let found = agents.get(name);
    if (!found) {
      found = { usd: 0, files: [] };
      agents.set(name, found);
    }
    return found;
  };
  for (const cost of data.costs) if (cost.t <= t) agent(cost.who).usd += cost.usd;
  const arrows = new Map<string, ReplayArrow>();
  const mark = (name: string, kind: ReplayArrow): void => {
    const now = arrows.get(name);
    if (!now || RANK[kind] > RANK[now]) arrows.set(name, kind);
  };
  for (const span of data.spans) {
    if (span.start > t || (span.end !== undefined && span.end <= t)) continue;
    if (span.approvalUntil !== undefined && t < span.approvalUntil) mark(span.to, 'approval');
    else {
      mark(span.to, 'working');
      const on = agent(span.to);
      on.on = Math.max(on.on ?? 0, span.n);
    }
  }
  let index = -1;
  for (let at = 0; at < data.events.length && data.events[at]!.t <= t; at++) {
    index = at;
    const event = data.events[at]!;
    if (event.kind === 'turn') {
      const files = agent(event.who).files;
      for (const file of event.files) if (!files.includes(file)) files.push(file);
    }
  }
  // What the last event carried, on its arrow: an answer or a question going up.
  const current = index >= 0 ? data.events[index] : undefined;
  if (current?.kind === 'answer' && current.back) mark(current.from, 'answer');
  if (current?.kind === 'question') mark(current.from, 'question');
  return { agents, arrows, index };
}

/** "#3 manager → senior, junior: Plan the parser": an event in a line, for the bar of the replay. */
export function eventLine(event: ReplayEvent): string {
  const who = (name: string): string => (name === 'the user' ? 'you' : name);
  const first = (text: string | undefined): string => (text ?? '').split('\n').find((line) => line.trim())?.trim() ?? '';
  switch (event.kind) {
    case 'request':
      return `#${event.n} ${who(event.from)} → ${event.to.join(', ')}: ${first(event.text)}`;
    case 'approval':
      return `#${event.n} ${event.decision === 'approved' ? 'approved by you' : 'sent back by you'} for ${event.to}`;
    case 'question':
      return `#${event.n} ${event.from} asks ${who(event.to)}: ${first(event.text)}`;
    case 'answer':
      return event.back ? `#${event.n} ${event.from} answers ${who(event.to)}: ${first(event.text)}` : `#${event.n} ${event.from} is done`;
    case 'review':
      return `${event.from} ${event.verdict === 'approved' ? 'approves' : 'asks for changes on'} ${event.short}`;
    case 'turn':
      return `${event.who} wrote ${event.files.length === 1 ? event.files[0] : `${event.files.length} files`}`;
    case 'delivered':
      return `${event.from} delivered${event.where ? ` ${event.where}` : ''}: ${first(event.text)}`;
  }
}
