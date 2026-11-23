import type { Agent, AgentState } from '../shared/agent.ts';

// What the marks of the top line are (Counts.tsx), in whole pixels: on a screen with one dot per pixel a mark of
// 3.7 would blur. No DOM here, so that the tests can look at it.

/** How tall the band of the marks is: the columns of the guard and the sessions that need you take all of it. */
export const BAND = 8;

/**
 * The columns of the days, the tallest as tall as the band. A day with a count is at least 2 px, so it never looks
 * like one with none, which is a 1 px stub: seven days stay seven.
 */
export function dayHeights(values: readonly number[], band = BAND): number[] {
  const most = Math.max(0, ...values);
  return values.map((value) => (value > 0 && most > 0 ? Math.max(2, Math.round((band * value) / most)) : 1));
}

/** What a mark of the sessions says: it needs you, it stopped on an error, it is at work, it is quiet. */
export type MarkKind = 'waiting' | 'error' | 'busy' | 'idle';

export const MARK_WORDS: Record<MarkKind, [one: string, many: string]> = {
  waiting: ['waits for you', 'wait for you'],
  error: ['stopped on an error', 'stopped on an error'],
  busy: ['at work', 'at work'],
  idle: ['idle', 'idle'],
};

/** What needs you comes first. */
const ORDER: readonly MarkKind[] = ['waiting', 'error', 'busy', 'idle'];

function kindOf(state: AgentState): MarkKind | undefined {
  if (state === 'ended') return undefined;
  if (state === 'waiting' || state === 'error' || state === 'idle') return state;
  return 'busy';
}

/** How many sessions of each kind, those that need you first; the ended ones are out. */
export function sessionKinds(agents: ReadonlyArray<Pick<Agent, 'state'>>): Array<{ kind: MarkKind; count: number }> {
  const counts = new Map<MarkKind, number>();
  for (const agent of agents) {
    const kind = kindOf(agent.state);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return ORDER.filter((kind) => counts.has(kind)).map((kind) => ({ kind, count: counts.get(kind)! }));
}

/** "2 wait for you, 4 at work, 7 idle": what the marks say, in words. */
export const sessionsTitle = (kinds: ReturnType<typeof sessionKinds>): string => kinds.map(({ kind, count }) => `${count} ${MARK_WORDS[kind][count === 1 ? 0 : 1]}`).join(', ');

/** Past this many sessions a mark for each is too thin to tell from the next: one per kind instead. */
export const MARKS_MOST = 24;

/** No mark is wider than this: one session as wide as the band would read as a bar that is full. */
export const MARK_WIDEST = 8;

/**
 * The marks of the sessions over `width` pixels: one each, the pixels that do not divide going one by one to the
 * first; past MARKS_MOST one per kind, as wide as its share.
 */
export function sessionMarks(kinds: ReturnType<typeof sessionKinds>, width: number): Array<{ kind: MarkKind; width: number }> {
  const total = kinds.reduce((sum, { count }) => sum + count, 0);
  if (total === 0) return [];
  if (total > MARKS_MOST) {
    const room = width - 2 * (kinds.length - 1);
    const widths = kinds.map(({ count }) => Math.max(3, Math.floor((room * count) / total)));
    // What is left, or too much, is of the widest.
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest] = widths[widest]! + room - widths.reduce((sum, value) => sum + value, 0);
    return kinds.map(({ kind }, index) => ({ kind, width: widths[index]! }));
  }
  const room = width - markGap(total) * (total - 1);
  const each = Math.min(MARK_WIDEST, Math.floor(room / total));
  const extra = each === MARK_WIDEST ? 0 : room - each * total;
  return kinds.flatMap(({ kind, count }) => Array.from({ length: count }, () => kind)).map((kind, index) => ({ kind, width: each + (index < extra ? 1 : 0) }));
}

/** The space between two marks: thinner when there are many. */
export const markGap = (total: number): number => (total > 14 && total <= MARKS_MOST ? 1 : 2);
