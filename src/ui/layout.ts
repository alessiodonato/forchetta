// The panes of the work area: which sessions are open, which one is large, which one goes when a fifth opens.
// Pure functions, no DOM.
//
// "Activated" and "used" are two things. A pane is activated when you open it or click its box: in the layout of
// three, the activated one is the large one, and its terminal takes the keyboard. A pane is used whenever you type
// or click in it: that only counts for choosing which pane a fifth session replaces. Typing in a small pane must
// not make the layout jump, and using a pane must never move the keyboard to another one.

export const MAX_PANES = 4;

export type ReplacePolicy = 'lru' | 'chiedi';

export interface PaneState {
  /** Open agents, in the order they were opened: their order in the page, which stays while they stay open. */
  open: string[];
  /** The pane activated last. */
  active?: string;
  /** When it was activated: its terminal takes the keyboard when this changes, and only then. */
  activatedAt?: number;
  /** When each open pane was last used or activated. */
  used: Record<string, number>;
  /** A fifth session waiting for the choice of the pane it replaces (policy "chiedi"). */
  asking?: string;
}

export const emptyPanes = (): PaneState => ({ open: [], used: {} });

/** The open pane used longest ago. */
export function leastRecentlyUsed(state: PaneState): string | undefined {
  return [...state.open].sort((a, b) => (state.used[a] ?? 0) - (state.used[b] ?? 0))[0];
}

function mostRecentlyUsed(open: readonly string[], used: Record<string, number>): string | undefined {
  return [...open].sort((a, b) => (used[b] ?? 0) - (used[a] ?? 0))[0];
}

/** A pane takes the place of another: same position, the replaced one is closed. */
export function replacePane(state: PaneState, victim: string, id: string, now: number): PaneState {
  if (!state.open.includes(victim) || state.open.includes(id)) return state;
  const used = { ...state.used, [id]: now };
  delete used[victim];
  return { open: state.open.map((open) => (open === victim ? id : open)), active: id, activatedAt: now, used };
}

/** A click on a box: opens its pane, or activates it when it is already open. */
export function openPane(state: PaneState, id: string, now: number, policy: ReplacePolicy): PaneState {
  if (state.open.includes(id)) return { ...state, active: id, activatedAt: now, used: { ...state.used, [id]: now }, asking: undefined };
  if (state.open.length < MAX_PANES) return { open: [...state.open, id], active: id, activatedAt: now, used: { ...state.used, [id]: now } };
  if (policy === 'chiedi') return { ...state, asking: id };
  const victim = leastRecentlyUsed(state);
  return victim ? replacePane(state, victim, id, now) : state;
}

/** Typing or clicking in a pane: it becomes the most recently used, without moving. */
export function usePane(state: PaneState, id: string, now: number): PaneState {
  if (!state.open.includes(id)) return state;
  return { ...state, used: { ...state.used, [id]: now } };
}

export function closePane(state: PaneState, id: string): PaneState {
  if (!state.open.includes(id)) return state;
  const open = state.open.filter((open) => open !== id);
  const used = { ...state.used };
  delete used[id];
  return { open, used, active: state.active === id ? mostRecentlyUsed(open, used) : state.active, activatedAt: state.activatedAt, asking: state.asking };
}

/**
 * What makes the terminal of a pane take the keyboard: it changes only when the pane is activated (or becomes the
 * active one because the active one closed). -1 for the others, which never take it by themselves.
 */
export const focusKey = (state: PaneState, id: string): number => (id === state.active ? (state.activatedAt ?? 0) : -1);

export const cancelAsking = (state: PaneState): PaneState => ({ ...state, asking: undefined });

/** Closes the panes of agents that went away. */
export function prunePanes(state: PaneState, exists: (id: string) => boolean): PaneState {
  let next = state;
  for (const id of state.open) if (!exists(id)) next = closePane(next, id);
  if (next.asking && !exists(next.asking)) next = cancelAsking(next);
  return next;
}

export interface Layout {
  columns: string;
  rows: string;
  areas: string;
  /** The grid area of each open pane. */
  place: Record<string, string>;
}

/**
 * 1: the whole area. 2: side by side. 3: the activated one large on the left, the other two stacked on the right.
 * 4: two by two, in the order they were opened.
 */
export function layoutFor(state: PaneState): Layout {
  const open = state.open;
  switch (open.length) {
    case 0:
      return { columns: '1fr', rows: '1fr', areas: '"p0"', place: {} };
    case 1:
      return { columns: '1fr', rows: '1fr', areas: '"p0"', place: { [open[0]!]: 'p0' } };
    case 2:
      return { columns: '1fr 1fr', rows: '1fr', areas: '"p0 p1"', place: { [open[0]!]: 'p0', [open[1]!]: 'p1' } };
    case 3: {
      const big = state.active && open.includes(state.active) ? state.active : open[0]!;
      const [first, second] = open.filter((id) => id !== big);
      return { columns: '3fr 2fr', rows: '1fr 1fr', areas: '"big top" "big bottom"', place: { [big]: 'big', [first!]: 'top', [second!]: 'bottom' } };
    }
    default:
      return {
        columns: '1fr 1fr',
        rows: '1fr 1fr',
        areas: '"p0 p1" "p2 p3"',
        place: Object.fromEntries(open.slice(0, MAX_PANES).map((id, index) => [id, `p${index}`])),
      };
  }
}

/** Shift+Enter becomes a new line in the prompt of Claude Code (ESC and Enter, as Option+Enter in a terminal). */
export function keyInput(event: { type: string; key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): string | undefined {
  if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) return '\u001b\r';
  return undefined;
}

/**
 * What xterm.js sends by itself when its terminal gains or loses the keyboard (tmux asks for it: focus-events on).
 * It goes on to tmux, but it is not you using the pane: a pane that loses the keyboard was not used.
 */
export const isFocusReport = (data: string): boolean => data === '\u001b[I' || data === '\u001b[O';
