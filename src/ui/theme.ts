// The theme of the page: dark (as Forchetta always was), light, or as the system is. The choice is kept in this
// window (localStorage: a convenience, so it may be missing); the page says to the app whether it is dark, so that
// the window around it follows. The CSS reads data-theme on <html>, always "dark" or "light"; the terminals hear
// the change through onThemeChange.

export type Theme = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

const KEY = 'forchetta.theme';
const THEMES: readonly Theme[] = ['system', 'dark', 'light'];

let chosen: Theme = 'dark';
let resolved: ResolvedTheme = 'dark';
let media: MediaQueryList | undefined;
const listeners = new Set<(theme: ResolvedTheme) => void>();

/** What a choice is on a system that prefers light (or not). */
export const resolveTheme = (theme: Theme, systemLight: boolean): ResolvedTheme => (theme === 'system' ? (systemLight ? 'light' : 'dark') : theme);

/** A stored value, if it is one of the themes; dark otherwise. */
export const parseTheme = (value: unknown): Theme => (THEMES.includes(value as Theme) ? (value as Theme) : 'dark');

/** The theme chosen in this window before, or dark. */
export function savedTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(KEY));
  } catch {
    return 'dark';
  }
}

/** The theme chosen: system, dark or light. */
export const currentTheme = (): Theme => chosen;

/** What the page shows now: dark or light. */
export const resolvedTheme = (): ResolvedTheme => resolved;

/** Called when the page goes from dark to light or back; the function to stop listening. */
export function onThemeChange(listener: (theme: ResolvedTheme) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function systemLight(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

function show(next: ResolvedTheme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = next;
  // The window of the app: its title bar and what shows behind the page while it scrolls.
  const bridge = (globalThis as { webkit?: { messageHandlers?: { forchetta?: { postMessage: (message: unknown) => void } } } }).webkit?.messageHandlers?.forchetta;
  try {
    bridge?.postMessage({ type: 'theme', theme: chosen, dark: next === 'dark' });
  } catch {
    // Not in the app.
  }
  if (next === resolved) return;
  resolved = next;
  for (const listener of listeners) listener(next);
}

/** Shows a theme and keeps the choice; "system" follows the system as it changes. */
export function applyTheme(theme: Theme, save = true): void {
  chosen = parseTheme(theme);
  if (save) {
    try {
      localStorage.setItem(KEY, chosen);
    } catch {
      // Kept for this time only.
    }
  }
  if (!media && typeof matchMedia === 'function') {
    try {
      media = matchMedia('(prefers-color-scheme: light)');
      media.addEventListener('change', () => {
        if (chosen === 'system') show(resolveTheme(chosen, systemLight()));
      });
    } catch {
      media = undefined;
    }
  }
  show(resolveTheme(chosen, systemLight()));
}
