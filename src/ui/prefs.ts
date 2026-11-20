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

export function onTerminalFontSize(listener: (size: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
