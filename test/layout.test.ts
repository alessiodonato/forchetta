import { describe, expect, it } from 'vitest';
import { closePane, emptyPanes, keyInput, layoutFor, leastRecentlyUsed, openPane, type PaneState, prunePanes, replacePane, usePane } from '../src/ui/layout.ts';

const openAll = (ids: string[], policy: 'lru' | 'chiedi' = 'lru'): PaneState =>
  ids.reduce((state, id, index) => openPane(state, id, 1000 + index, policy), emptyPanes());

describe('panes', () => {
  it('opens up to four, the last one activated', () => {
    const state = openAll(['a', 'b', 'c', 'd']);
    expect(state.open).toEqual(['a', 'b', 'c', 'd']);
    expect(state.active).toBe('d');
  });

  it('activates a pane already open instead of opening it twice', () => {
    const state = openPane(openAll(['a', 'b']), 'a', 5000, 'lru');
    expect(state.open).toEqual(['a', 'b']);
    expect(state.active).toBe('a');
  });

  it('gives the fifth the place of the least recently used one', () => {
    let state = openAll(['a', 'b', 'c', 'd']);
    // a was opened first but used since; b is now the least recently used.
    state = usePane(state, 'a', 2000);
    expect(leastRecentlyUsed(state)).toBe('b');
    state = openPane(state, 'e', 3000, 'lru');
    expect(state.open).toEqual(['a', 'e', 'c', 'd']);
    expect(state.active).toBe('e');
    expect(state.used.b).toBeUndefined();
  });

  it('asks which one to replace with the policy "chiedi"', () => {
    let state = openPane(openAll(['a', 'b', 'c', 'd'], 'chiedi'), 'e', 3000, 'chiedi');
    expect(state.open).toEqual(['a', 'b', 'c', 'd']);
    expect(state.asking).toBe('e');
    state = replacePane({ ...state, asking: undefined }, 'c', 'e', 3001);
    expect(state.open).toEqual(['a', 'b', 'e', 'd']);
  });

  it('does not move a pane when you type in it', () => {
    const state = openAll(['a', 'b', 'c']);
    const after = usePane(state, 'b', 9000);
    expect(after.active).toBe('c');
    expect(layoutFor(after)).toEqual(layoutFor(state));
  });

  it('closes a pane and activates the one used most recently', () => {
    let state = openAll(['a', 'b', 'c']);
    state = usePane(state, 'a', 9000);
    state = closePane(state, 'c');
    expect(state.open).toEqual(['a', 'b']);
    expect(state.active).toBe('a');
  });

  it('forgets the panes of agents that went away', () => {
    const state = prunePanes(openAll(['a', 'b']), (id) => id !== 'a');
    expect(state.open).toEqual(['b']);
  });
});

describe('layouts', () => {
  it('1: the whole area; 2: side by side', () => {
    expect(layoutFor(openAll(['a']))).toEqual({ columns: '1fr', rows: '1fr', areas: '"p0"', place: { a: 'p0' } });
    expect(layoutFor(openAll(['a', 'b']))).toMatchObject({ columns: '1fr 1fr', areas: '"p0 p1"', place: { a: 'p0', b: 'p1' } });
  });

  it('3: the activated one large on the left, the other two stacked', () => {
    const three = openAll(['a', 'b', 'c']);
    expect(layoutFor(three)).toMatchObject({ columns: '3fr 2fr', areas: '"big top" "big bottom"', place: { c: 'big', a: 'top', b: 'bottom' } });
    expect(layoutFor(openPane(three, 'a', 9000, 'lru')).place).toEqual({ a: 'big', b: 'top', c: 'bottom' });
  });

  it('4: two by two in the order they were opened', () => {
    expect(layoutFor(openAll(['a', 'b', 'c', 'd']))).toMatchObject({ areas: '"p0 p1" "p2 p3"', place: { a: 'p0', b: 'p1', c: 'p2', d: 'p3' } });
  });
});

describe('keys', () => {
  const key = (init: Partial<Parameters<typeof keyInput>[0]>) => keyInput({ type: 'keydown', key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...init });
  it('turns Shift+Enter into a new line for Claude Code, and leaves the rest to xterm.js', () => {
    expect(key({ shiftKey: true })).toBe('\u001b\r');
    expect(key({})).toBeUndefined();
    expect(key({ shiftKey: true, metaKey: true })).toBeUndefined();
    expect(key({ shiftKey: true, type: 'keyup' })).toBeUndefined();
    expect(key({ key: 'a', shiftKey: true })).toBeUndefined();
  });
});
