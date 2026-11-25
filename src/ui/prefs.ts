// What you choose for this window only, kept in localStorage (a convenience, so it may be missing): the size of the
// text of the terminals. The zoom of the whole page is the one of the app (View → Zoom In, ⌘+), which it keeps.

const FONT_KEY = 'forchetta.terminalFont';
export const FONT_MIN = 10;
export const FONT_MAX = 22;
export const FONT_DEFAULT = 13;

const clampFont = (value: number): number => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(value)));

let font = FONT_DEFAULT;
try {
  const stored = Number(localStorage.getItem(FONT_KEY));
  if (Number.isFinite(stored) && stored > 0) font = clampFont(stored);
} catch {
  // The default.
}
const listeners = new Set<(size: number) => void>();

export const terminalFontSize = (): number => font;

/** A new size for the text of every terminal of this window, open or to come. */
export function setTerminalFontSize(size: number): void {
  const next = clampFont(size);
  if (next === font) return;
  font = next;
  try {
    localStorage.setItem(FONT_KEY, String(next));
  } catch {
    // For this time only.
  }
  for (const listener of listeners) listener(next);
}

const LATER_KEY = 'forchetta.restartsLater';
let later: string | undefined;
try {
  later = localStorage.getItem(LATER_KEY) ?? undefined;
} catch {
  // Offered again.
}

/** The version of Claude Code for which this window does not offer to restart the sessions: "not now". */
export const restartsLater = (): string | undefined => later;

export function setRestartsLater(version: string): void {
  later = version;
  try {
    localStorage.setItem(LATER_KEY, version);
  } catch {
    // For this time only.
  }
}

const MARKS_KEY = 'forchetta.messageMarks';
let marks = true;
try {
  marks = localStorage.getItem(MARKS_KEY) !== 'off';
} catch {
  // On.
}
const markListeners = new Set<() => void>();

/** Whether your messages are marked in the terminals of this window (marks.ts). */
export const messageMarks = (): boolean => marks;

export function setMessageMarks(on: boolean): void {
  if (on === marks) return;
  marks = on;
  try {
    localStorage.setItem(MARKS_KEY, on ? 'on' : 'off');
  } catch {
    // For this time only.
  }
  for (const listener of markListeners) listener();
}

export function onMessageMarks(listener: () => void): () => void {
  markListeners.add(listener);
  return () => markListeners.delete(listener);
}

export function onTerminalFontSize(listener: (size: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
