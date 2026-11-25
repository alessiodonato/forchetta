import { isNewer } from '../shared/updates.ts';
import { VERSION } from '../shared/version.ts';

// After an update the daemon is newer than the page that is open: the page loads again, once for that version, with the
// terminals it had open. What is kept is of this window only, and only for that.

const PANES_KEY = 'forchetta.panesAfter';
const DONE_KEY = 'forchetta.reloadedFor';

const read = (key: string): string | null => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string): boolean => {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

/** Whether the daemon is of a newer version than this page, and the page did not load again for it yet. */
export const isBehind = (daemon: string | undefined, page = VERSION): boolean => daemon !== undefined && isNewer(daemon, page) && read(DONE_KEY) !== daemon;

/** Loads the page again; the terminals open now open again. Not when it could not be known that it did: it would not stop. */
export function loadAgain(daemon: string, panes: readonly string[], active: string | undefined): void {
  if (!write(DONE_KEY, daemon)) return;
  // The one in front last: it ends up in front.
  write(PANES_KEY, JSON.stringify([...panes.filter((id) => id !== active), ...(active && panes.includes(active) ? [active] : [])]));
  location.reload();
}

/** The terminals the page had before it loaded again, once. */
export function panesBefore(): string[] {
  const raw = read(PANES_KEY);
  if (raw === null) return [];
  try {
    sessionStorage.removeItem(PANES_KEY);
    const ids = JSON.parse(raw) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, 4) : [];
  } catch {
    return [];
  }
}
