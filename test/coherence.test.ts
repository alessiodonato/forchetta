import { describe, expect, it } from 'vitest';
import { changedNote, Coherence, RECENT_MS, removedLines } from '../src/daemon/coherence.ts';
import type { SessionEdit } from '../src/shared/agent.ts';

// What each session read, and what the others changed since: the note of the files out of date, and the lines of
// another session about to be taken away.

const FILE = '/p/shop/src/api.ts';
const MIN = 60_000;

/** A change as Claude Code reports it: one block, with the lines around it. */
const change = (lines: string[]): SessionEdit => ({ at: 0, tool: 'Edit', file: FILE, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines }] });

function setup() {
  let now = 1_000_000;
  const coherence = new Coherence({ now: () => now });
  return { coherence, advance: (ms: number) => (now += ms), now: () => now };
}

describe('lines taken away', () => {
  it('are those of the old text gone from the new one, not those only changed', () => {
    const before = ['import { a } from "./a";', 'export async function fetchUser(id: string) {', '  return get(`/users/${id}`);', '}'].join('\n');
    const after = ['import { a } from "./a";', 'export async function fetchUser(id: string, retries = 3) {', '}'].join('\n');
    // The signature changed (most of its words are still there); the body line is gone.
    expect(removedLines(before, after)).toEqual(['  return get(`/users/${id}`);']);
    expect(removedLines('a\nb', 'a\nb\nc')).toEqual([]);
  });
});

describe('files read and changed since', () => {
  it('are told once to the session that read them, with the lines and who changed them', () => {
    const t = setup();
    t.coherence.read('beta', FILE);
    t.advance(MIN);
    t.coherence.wrote('alpha', FILE, change([' import x;', '-export function fetchUser(id: string) {', '+export function getUser(id: string, options: Options = {}) {']));
    const found = t.coherence.changedSinceRead('beta');
    expect(found).toEqual([{ file: FILE, changes: [{ agentId: 'alpha', at: t.now(), lines: ['-export function fetchUser(id: string) {', '+export function getUser(id: string, options: Options = {}) {'] }] }]);
    expect(t.coherence.changedSinceRead('beta')).toEqual([]);
    // The one that changed it knows it.
    expect(t.coherence.changedSinceRead('alpha')).toEqual([]);
  });

  it('says nothing of a change made before the read, or of a file read again since', () => {
    const t = setup();
    t.coherence.wrote('alpha', FILE, change(['+one more line of code here']));
    t.advance(MIN);
    t.coherence.read('beta', FILE);
    expect(t.coherence.changedSinceRead('beta')).toEqual([]);
    t.advance(MIN);
    t.coherence.wrote('alpha', FILE, change(['+and another line of code here']));
    t.advance(MIN);
    t.coherence.read('beta', FILE);
    expect(t.coherence.changedSinceRead('beta')).toEqual([]);
  });

  it('says nothing of a change older than an hour, nor to a session forgotten', () => {
    const t = setup();
    t.coherence.read('beta', FILE);
    t.coherence.read('gamma', FILE);
    t.advance(MIN);
    t.coherence.wrote('alpha', FILE, change(['+one more line of code here']));
    t.advance(RECENT_MS);
    expect(t.coherence.changedSinceRead('beta')).toEqual([]);
    t.coherence.forget(['gamma']);
    expect(t.coherence.changedSinceRead('gamma')).toEqual([]);
  });

  it('reads as a note for Claude: the file, who, when, and the lines; long changes are cut', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `+line ${i}`);
    const note = changedNote([{ file: FILE, changes: [{ agentId: 'alpha', at: 1_000_000 - 3 * MIN, lines }] }], () => '"retries"', () => 'src/api.ts', 1_000_000);
    expect(note).toContain('Forchetta: other Claude Code sessions on this Mac changed files you read earlier.');
    expect(note).toContain('- src/api.ts, by "retries" 3 min ago:\n    +line 0');
    expect(note).toContain('    … and 3 more changed lines');
    expect(note).toContain('Read them again before you write code that relies on them.');
    expect(changedNote([], () => '', () => '', 0)).toBeUndefined();
  });
});

describe('lines of another session', () => {
  it('are found when a session takes away lines another one added in the last hour', () => {
    const t = setup();
    t.coherence.wrote('alpha', FILE, change(['+  const delay = 2 ** attempt * 100;', '+  await sleep(delay);', ' }']));
    t.advance(6 * MIN);
    expect(t.coherence.addedByOthers('beta', FILE, ['  const delay = 2 ** attempt * 100;', '  await sleep(delay);'])).toEqual({
      agentId: 'alpha',
      at: t.now() - 6 * MIN,
      lines: ['  const delay = 2 ** attempt * 100;', '  await sleep(delay);'],
    });
  });

  it('are not one short line, nor its own lines, nor lines older than an hour', () => {
    const t = setup();
    t.coherence.wrote('alpha', FILE, change(['+  await sleep(delay);', '+  return response.json() as Promise<User>;']));
    expect(t.coherence.addedByOthers('beta', FILE, ['  await sleep(delay);'])).toBeUndefined();
    expect(t.coherence.addedByOthers('alpha', FILE, ['  await sleep(delay);', '  return response.json() as Promise<User>;'])).toBeUndefined();
    // One long line is enough.
    expect(t.coherence.addedByOthers('beta', FILE, ['  return response.json() as Promise<User>;'])?.agentId).toBe('alpha');
    t.advance(RECENT_MS);
    expect(t.coherence.addedByOthers('beta', FILE, ['  return response.json() as Promise<User>;'])).toBeUndefined();
  });
});
