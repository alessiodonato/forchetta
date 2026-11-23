import { describe, expect, it } from 'vitest';
import type { AgentState } from '../src/shared/agent.ts';
import { BAND, dayHeights, MARK_WIDEST, markGap, MARKS_MOST, sessionKinds, sessionMarks, sessionsTitle } from '../src/ui/counts-model.ts';

// The marks under the counts of the top line: the days of the guard and the sessions, in whole pixels.

const sessions = (counts: Partial<Record<AgentState, number>>): Array<{ state: AgentState }> => Object.entries(counts).flatMap(([state, count]) => Array.from({ length: count }, () => ({ state: state as AgentState })));

/** The room the marks take, their gaps included. */
const wide = (marks: Array<{ width: number }>, total: number): number => marks.reduce((sum, mark) => sum + mark.width, 0) + markGap(total) * (marks.length - 1);

describe('the days of the guard', () => {
  it('the tallest takes the band, a day with a little is seen, a day with nothing is a stub', () => {
    expect(dayHeights([2, 0, 9, 14, 3, 9, 3])).toEqual([2, 1, 5, 8, 2, 5, 2]);
    expect(dayHeights([1, 500])).toEqual([2, BAND]);
    expect(dayHeights([0, 0, 0])).toEqual([1, 1, 1]);
    expect(dayHeights([0, 1])).toEqual([1, BAND]);
    expect(dayHeights([])).toEqual([]);
  });
});

describe('the marks of the sessions', () => {
  it('puts those that need you first, and leaves the ended ones out', () => {
    const kinds = sessionKinds(sessions({ idle: 5, ended: 3, working: 4, compacting: 1, starting: 1, error: 1, waiting: 2 }));
    expect(kinds).toEqual([
      { kind: 'waiting', count: 2 },
      { kind: 'error', count: 1 },
      { kind: 'busy', count: 6 },
      { kind: 'idle', count: 5 },
    ]);
    expect(sessionsTitle(kinds)).toBe('2 wait for you, 1 stopped on an error, 6 at work, 5 idle');
    expect(sessionsTitle(sessionKinds(sessions({ waiting: 1 })))).toBe('1 waits for you');
    expect(sessionKinds(sessions({ ended: 2 }))).toEqual([]);
    expect(sessionMarks([], 74)).toEqual([]);
  });

  it('draws one each, in whole pixels, as wide as the room once they fill it', () => {
    for (let total = 1; total <= MARKS_MOST; total++) {
      const marks = sessionMarks(sessionKinds(sessions({ working: 1, idle: total - 1 })), 74);
      expect(marks).toHaveLength(total);
      expect(marks.every((mark) => Number.isInteger(mark.width) && mark.width >= 2 && mark.width <= MARK_WIDEST)).toBe(true);
      const full = total * MARK_WIDEST + markGap(total) * (total - 1);
      expect(wide(marks, total)).toBe(Math.min(74, full));
    }
  });

  it('does not draw one session as a bar that is full', () => {
    expect(sessionMarks(sessionKinds(sessions({ working: 1 })), 74)).toEqual([{ kind: 'busy', width: MARK_WIDEST }]);
  });

  it('past that many draws one per kind, and the only one that waits still shows', () => {
    const kinds = sessionKinds(sessions({ waiting: 1, working: 6, idle: 60 }));
    const marks = sessionMarks(kinds, 74);
    expect(marks.map((mark) => mark.kind)).toEqual(['waiting', 'busy', 'idle']);
    expect(marks[0]?.width).toBe(3);
    expect(wide(marks, 67)).toBe(74);
    expect(sessionMarks(sessionKinds(sessions({ idle: 30 })), 74)).toEqual([{ kind: 'idle', width: 74 }]);
  });
});
