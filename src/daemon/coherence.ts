import type { SessionEdit } from '../shared/agent.ts';
import { MACHINE } from '../shared/machine.ts';

// What each session knows of the files of its folder, and what the others changed since. A session that read a file
// keeps what it read in its context; when another session changes that file, what it knows is out of date, and it
// may go on writing code against a function that is no longer there. Forchetta remembers when each session read each
// file, and the changes every session made in the last hour, line by line (the patches of Claude Code). With the next
// answer of the guard, the session is told which files changed since it read them, by whom, and how.
//
// The same changes tell when a session is about to take away lines that another session added: the guard stops it
// once, with the lines, so that it does not undo the work of the other one without knowing.

/** Changes older than this say nothing more: the same hour as the conflicts between sessions. */
export const RECENT_MS = 60 * 60_000;
/** Changes kept for one file. */
const MAX_EDITS = 40;

/** One change of one session to one file, as the note shows it. */
export interface FileChangeNote {
  agentId: string;
  at: number;
  /** The lines taken away and added, with their - and +; the lines around them are left out. */
  lines: string[];
}

interface Known {
  /** When the session last read the file, or wrote it: what it knows of it dates from then. */
  at: number;
}

/** The text of a line for comparing: no spaces around it. */
const plain = (line: string): string => line.trim();

/** A line worth noticing: some letters or digits, not a lone brace or a blank. */
export const meaningful = (line: string): boolean => plain(line).length >= 10 && /[A-Za-z0-9]/.test(line);

/** The words of a line, to tell a line changed from a line taken away. */
const words = (line: string): Set<string> => new Set(plain(line).split(/[^A-Za-z0-9_$]+/).filter((word) => word.length > 1));

/** Whether two lines are the same line, changed: half of their words in common. */
function sameLine(a: string, b: string): boolean {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return false;
  let common = 0;
  for (const word of left) if (right.has(word)) common++;
  return common / Math.max(left.size, right.size) >= 0.5;
}

/**
 * The lines a change takes away for good: in the old text and not in the new one, not even changed (a line with half
 * of its words still there was changed, not taken away).
 */
export function removedLines(before: string, after: string): string[] {
  const kept = new Map<string, number>();
  const afterLines = after.split('\n');
  for (const line of afterLines) kept.set(plain(line), (kept.get(plain(line)) ?? 0) + 1);
  const removed: string[] = [];
  for (const line of before.split('\n')) {
    const key = plain(line);
    const left = kept.get(key) ?? 0;
    if (left > 0) {
      kept.set(key, left - 1);
      continue;
    }
    if (afterLines.some((other) => sameLine(line, other))) continue;
    removed.push(line);
  }
  return removed;
}

export class Coherence {
  /** For each session: the files it read or wrote, and when. */
  private readonly known = new Map<string, Map<string, Known>>();
  /** For each file: the changes of the last hour, oldest first. */
  private readonly edits = new Map<string, FileChangeNote[]>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** A session read a file (PostToolUse of Read): what it knows of it is current. */
  read(agentId: string, file: string): void {
    this.knows(agentId, file);
  }

  /** A session wrote a file: the change is kept for the others, and it knows the file as it left it. */
  wrote(agentId: string, file: string, edit?: SessionEdit): void {
    this.knows(agentId, file);
    const lines = (edit?.hunks ?? []).flatMap((hunk) => hunk.lines.filter((line) => line.startsWith('+') || line.startsWith('-')));
    if (lines.length === 0) return;
    const list = this.recent(file);
    list.push({ agentId, at: this.now(), lines });
    this.edits.set(file, list.slice(-MAX_EDITS));
  }

  forget(agentIds: readonly string[]): void {
    for (const id of agentIds) this.known.delete(id);
  }

  /**
   * The files this session read that other sessions changed since, with those changes; each is told once: after
   * this, the session counts as knowing them.
   */
  changedSinceRead(agentId: string): Array<{ file: string; changes: FileChangeNote[] }> {
    const files = this.known.get(agentId);
    if (!files) return [];
    const found: Array<{ file: string; changes: FileChangeNote[] }> = [];
    for (const [file, known] of files) {
      const changes = this.recent(file).filter((change) => change.agentId !== agentId && change.at > known.at);
      if (changes.length === 0) continue;
      found.push({ file, changes });
      known.at = Math.max(...changes.map((change) => change.at));
    }
    return found;
  }

  /** Whether another session changed this file in the last hour: before anything else is read. */
  changedByOthers(agentId: string, file: string): boolean {
    return this.recent(file).some((change) => change.agentId !== agentId);
  }

  /**
   * Of the lines a session is about to take away from a file, those another session added in the last hour, with
   * the session that added them last. Undefined when there are too few to count: one long line, or two.
   */
  addedByOthers(agentId: string, file: string, removed: readonly string[]): { agentId: string; at: number; lines: string[] } | undefined {
    const taken = removed.filter(meaningful);
    if (taken.length === 0) return undefined;
    const byAgent = new Map<string, { at: number; lines: Set<string> }>();
    for (const change of this.recent(file)) {
      if (change.agentId === agentId) continue;
      const added = new Set(change.lines.filter((line) => line.startsWith('+')).map((line) => plain(line.slice(1))));
      const lines = taken.filter((line) => added.has(plain(line)));
      if (lines.length === 0) continue;
      const entry = byAgent.get(change.agentId) ?? { at: 0, lines: new Set<string>() };
      entry.at = Math.max(entry.at, change.at);
      for (const line of lines) entry.lines.add(line);
      byAgent.set(change.agentId, entry);
    }
    // The session that added most of them; between two with as many, the latest.
    let found: { agentId: string; at: number; lines: string[] } | undefined;
    for (const [id, entry] of byAgent) {
      if (!found || entry.lines.size > found.lines.length || (entry.lines.size === found.lines.length && entry.at > found.at)) found = { agentId: id, at: entry.at, lines: [...entry.lines] };
    }
    if (!found) return undefined;
    const enough = found.lines.length >= 2 || found.lines.some((line) => plain(line).length >= 30);
    return enough ? found : undefined;
  }

  private knows(agentId: string, file: string): void {
    let files = this.known.get(agentId);
    if (!files) {
      files = new Map();
      this.known.set(agentId, files);
    }
    files.set(file, { at: this.now() });
  }

  /** The changes of the last hour to a file; older ones are dropped. */
  private recent(file: string): FileChangeNote[] {
    const now = this.now();
    const list = (this.edits.get(file) ?? []).filter((change) => now - change.at < RECENT_MS);
    if (list.length === 0) this.edits.delete(file);
    else this.edits.set(file, list);
    return list;
  }
}

const cut = (line: string, max = 160): string => (line.length > max ? `${line.slice(0, max - 1)}…` : line);

/**
 * The note for Claude: the files it read that changed since, by whom, and how. At most three files with their lines,
 * twelve lines each; the others by name only.
 */
export function changedNote(
  found: ReadonlyArray<{ file: string; changes: FileChangeNote[] }>,
  /** How Claude is told who changed it: "\"retries\"", or "another session in this folder". */
  nameOf: (agentId: string) => string,
  shown: (file: string) => string,
  now: number,
): string | undefined {
  if (found.length === 0) return undefined;
  const parts: string[] = [];
  for (const { file, changes } of found.slice(0, 3)) {
    const names = [...new Set(changes.map((change) => nameOf(change.agentId)))].join(' and ');
    const last = Math.max(...changes.map((change) => change.at));
    const minutes = Math.round((now - last) / 60_000);
    const when = minutes < 1 ? 'just now' : `${minutes} min ago`;
    const lines = changes.flatMap((change) => change.lines);
    const shownLines = lines.slice(0, 12).map((line) => `    ${cut(line)}`);
    const more = lines.length > 12 ? [`    … and ${lines.length - 12} more changed lines`] : [];
    parts.push(`- ${shown(file)}, by ${names} ${when}:`, ...shownLines, ...more);
  }
  if (found.length > 3) parts.push(`- and ${found.slice(3).map((item) => shown(item.file)).join(', ')}`);
  return [
    `Forchetta: other Claude Code sessions on this ${MACHINE} changed files you read earlier. What you read of them is out of date:`,
    ...parts,
    'Read them again before you write code that relies on them.',
  ].join('\n');
}
