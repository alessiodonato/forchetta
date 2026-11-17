// What the guard did, counted by day on this Mac only (daemon/guard-stats.ts keeps them in var/guard-stats.json),
// for the top line of the app and `forchetta stats`. No Node module here: the page uses it too.

/** One kind of thing the guard did. */
export type GuardStatKind =
  /** An edit stopped: another session was changing the file in its turn. */
  | 'held'
  /** A session that waited for a file was told it is free, to go on by itself. */
  | 'freed'
  /** An edit stopped: the file is outside the files of the member of a team. */
  | 'lane'
  /** An edit stopped once: it took away lines another session had added. */
  | 'undo'
  /** A git command that would change the files under another session: asked to you. */
  | 'git'
  /** A git add -A or commit -a stopped once: it would take the changes of other sessions. */
  | 'commit'
  /** A git merge of commits the reviewer of the team did not approve: asked to you. */
  | 'merge'
  /** A second dev server in a folder that has one: stopped, with the address of the first. */
  | 'server'
  /** A kill of a process another session started: asked to you. */
  | 'kill'
  /** A note before tests or a build: other sessions are halfway through some files. */
  | 'tests'
  /** A note that a file the session read was changed by another session since. */
  | 'changed'
  /** A note at the first step of a session: who else is halfway through which files in its folder. */
  | 'arrival'
  /** A session going in circles: the same call failing the same way again and again. */
  | 'loop'
  /** You let a session through from its box. */
  | 'letThrough';

export type GuardCounts = Partial<Record<GuardStatKind, number>>;

/** What the page and the CLI get: the counts of the last days, and of today. */
export interface GuardStatsInfo {
  /** How many days the counts cover, today included. */
  days: number;
  counts: GuardCounts;
  today: GuardCounts;
  /** The first day with a count (YYYY-MM-DD), when it is within those days: the counts started then. */
  since?: string;
}

/** The kinds, in the order they are listed, with what one and many of them are. */
const PHRASES: Array<[GuardStatKind, string, string]> = [
  ['held', 'edit stopped while another session was changing the file', 'edits stopped while another session was changing the file'],
  ['freed', 'session went on by itself when the file was free', 'sessions went on by themselves when the file was free'],
  ['lane', 'edit stopped outside the files of a team member', 'edits stopped outside the files of a team member'],
  ['undo', "edit stopped that took away another session's lines", "edits stopped that took away another session's lines"],
  ['commit', "git add -A or commit -a kept from taking other sessions' changes", "git add -A or commit -a kept from taking other sessions' changes"],
  ['git', 'git command asked to you: it would change files under another session', 'git commands asked to you: they would change files under another session'],
  ['merge', 'merge asked to you: commits the reviewer had not approved', 'merges asked to you: commits the reviewer had not approved'],
  ['server', 'second dev server stopped, with the address of the first', 'second dev servers stopped, with the address of the first'],
  ['kill', "kill of another session's process asked to you", "kills of another session's processes asked to you"],
  ['tests', 'note before tests: other sessions halfway through files', 'notes before tests: other sessions halfway through files'],
  ['changed', 'note of a file another session changed after it was read', 'notes of files another session changed after they were read'],
  ['arrival', 'note at the start of a session: who was halfway through what', 'notes at the start of a session: who was halfway through what'],
  ['loop', 'session going in circles, flagged', 'sessions going in circles, flagged'],
  ['letThrough', 'time you let a session through', 'times you let a session through'],
];

/** What the guard stopped or asked: it acted. */
const STOPS: readonly GuardStatKind[] = ['held', 'lane', 'undo', 'commit', 'git', 'merge', 'server', 'kill'];
/** What it told Claude without stopping anything. */
const NOTES: readonly GuardStatKind[] = ['tests', 'changed', 'arrival'];

const sum = (counts: GuardCounts, kinds: readonly GuardStatKind[]): number => kinds.reduce((total, kind) => total + (counts[kind] ?? 0), 0);

/** Stops and notes together: what the top line counts. */
export const guardTotal = (counts: GuardCounts): number => sum(counts, STOPS) + sum(counts, NOTES);

/** One line for each kind with a count, the most important first: "12 edits stopped while…". */
export function statLines(counts: GuardCounts): Array<{ kind: GuardStatKind; count: number; text: string }> {
  return PHRASES.filter(([kind]) => (counts[kind] ?? 0) > 0).map(([kind, one, many]) => {
    const count = counts[kind]!;
    return { kind, count, text: count === 1 ? one : many };
  });
}

/** "12 stops, 5 notes": a short summary. */
export function shortSummary(counts: GuardCounts): string {
  const stops = sum(counts, STOPS);
  const notes = sum(counts, NOTES);
  const parts = [stops > 0 ? `${stops} ${stops === 1 ? 'stop' : 'stops'}` : '', notes > 0 ? `${notes} ${notes === 1 ? 'note' : 'notes'}` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

/** The tooltip of the top line: every count of the last days, and today. */
export function statsTitle(info: GuardStatsInfo): string {
  const lines = statLines(info.counts).map((line) => `${line.count} ${line.text}`);
  const span = info.days === 1 ? 'today' : `in the last ${info.days} days`;
  return [`What the guard did ${span}${info.since ? ` (counted since ${info.since})` : ''}:`, ...lines, '', `Today: ${shortSummary(info.today)}.`, 'Counted on this Mac only. forchetta stats lists them.'].join('\n');
}

/** The day of a time, in local time: YYYY-MM-DD. */
export function dayOf(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
