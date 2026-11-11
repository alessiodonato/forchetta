import { afterEach, describe, expect, it, vi } from 'vitest';
import { Conflicts, writtenFile } from '../src/daemon/conflicts.ts';
import { newAgent } from '../src/daemon/state.ts';
import { conflictText } from '../src/shared/present.ts';

// Two live sessions that wrote the same file, or in the same working tree, in the last hour.

afterEach(() => vi.useRealTimers());

/** Working trees of the test: /r/app (with a worktree /r/app-wt) and /r/lib. */
const GIT = new Set(['/r/app', '/r/app-wt', '/r/lib']);

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(10_000_000);
  const conflicts = new Conflicts({ hasGit: (dir) => GIT.has(dir) });
  const make = (id: string, cwd: string) => ({ ...newAgent({ id, cwd, control: { kind: 'readonly', reason: 'fuori-tmux' } }, Date.now()), state: 'working' as const });
  return { conflicts, make };
}

const post = (tool: string, input: Record<string, unknown>) => ({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: tool, tool_input: input });

describe('writes', () => {
  it('are the file of Edit, Write, MultiEdit and NotebookEdit after they went through, made absolute', () => {
    expect(writtenFile(post('Edit', { file_path: '/r/app/src/a.ts' }), '/r/app')).toBe('/r/app/src/a.ts');
    expect(writtenFile(post('Write', { file_path: 'src/b.ts' }), '/r/app')).toBe('/r/app/src/b.ts');
    expect(writtenFile(post('NotebookEdit', { notebook_path: '/r/app/n.ipynb' }), undefined)).toBe('/r/app/n.ipynb');
    expect(writtenFile(post('Read', { file_path: '/r/app/src/a.ts' }), '/r/app')).toBeUndefined();
    expect(writtenFile(post('Bash', { command: 'sed -i s/a/b/ src/a.ts' }), '/r/app')).toBeUndefined();
    expect(writtenFile({ ...post('Edit', { file_path: '/r/app/src/a.ts' }), hook_event_name: 'PreToolUse' }, '/r/app')).toBeUndefined();
  });
});

describe('conflicts', () => {
  it('same file: both boxes say it, with the path inside the working tree', () => {
    const { conflicts, make } = setup();
    const a = make('a', '/r/app');
    const b = { ...make('b', '/r/app'), project: 'app-b' };
    conflicts.wrote('a', '/r/app/src/api.ts');
    conflicts.wrote('b', '/r/app/src/api.ts');
    conflicts.wrote('b', '/r/app/src/other.ts');
    expect(conflicts.update([a, b]).map((agent) => agent.id)).toEqual(['a', 'b']);
    expect(a.conflicts).toEqual([{ kind: 'file', with: 'b', withName: 'app-b', files: ['src/api.ts'], repo: 'app' }]);
    expect(conflictText(a.conflicts![0]!)).toBe('same file as app-b: src/api.ts');
    expect(b.conflicts![0]).toMatchObject({ kind: 'file', with: 'a' });
    // Nothing new: nothing changed.
    expect(conflicts.update([a, b])).toEqual([]);
  });

  it('works on the values of a map, as the daemon passes them', () => {
    const { conflicts, make } = setup();
    const agents = new Map([
      ['a', make('a', '/r/app')],
      ['b', make('b', '/r/app')],
    ]);
    conflicts.wrote('a', '/r/app/x.ts');
    conflicts.wrote('b', '/r/app/x.ts');
    expect(conflicts.update(agents.values())).toHaveLength(2);
  });

  it('same working tree, different files: the softer warning', () => {
    const { conflicts, make } = setup();
    const a = make('a', '/r/app');
    const b = make('b', '/r/app/packages/x');
    conflicts.wrote('a', '/r/app/src/a.ts');
    conflicts.wrote('b', '/r/app/packages/x/b.ts');
    conflicts.update([a, b]);
    expect(a.conflicts).toEqual([{ kind: 'repo', with: 'b', withName: 'x', files: [], repo: 'app' }]);
    expect(conflictText(a.conflicts![0]!)).toBe('same repo as x (app)');
  });

  it('none between two worktrees, two repositories, or a session that only read', () => {
    const { conflicts, make } = setup();
    const a = make('a', '/r/app');
    const b = make('b', '/r/app-wt');
    const c = make('c', '/r/lib');
    const d = make('d', '/r/app');
    conflicts.wrote('a', '/r/app/src/a.ts');
    conflicts.wrote('b', '/r/app-wt/src/a.ts');
    conflicts.wrote('c', '/r/lib/a.ts');
    conflicts.update([a, b, c, d]);
    expect([a, b, c, d].map((agent) => agent.conflicts)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('files outside any repository conflict only when they are the same file', () => {
    const { conflicts, make } = setup();
    const a = make('a', '/tmp/x');
    const b = make('b', '/tmp/y');
    conflicts.wrote('a', '/tmp/x/one.txt');
    conflicts.wrote('b', '/tmp/y/two.txt');
    conflicts.update([a, b]);
    expect(a.conflicts).toBeUndefined();
    conflicts.wrote('b', '/tmp/x/one.txt');
    conflicts.update([a, b]);
    expect(a.conflicts).toEqual([{ kind: 'file', with: 'b', withName: 'y', files: ['/tmp/x/one.txt'], repo: undefined }]);
  });

  it('go away after an hour without writes, and when the other session ends', () => {
    const { conflicts, make } = setup();
    const a = make('a', '/r/app');
    const b = make('b', '/r/app');
    conflicts.wrote('a', '/r/app/a.ts');
    conflicts.wrote('b', '/r/app/a.ts');
    conflicts.update([a, b]);
    expect(a.conflicts).toBeDefined();
    vi.advanceTimersByTime(61 * 60_000);
    conflicts.update([a, b]);
    expect(a.conflicts).toBeUndefined();

    conflicts.wrote('a', '/r/app/a.ts');
    conflicts.wrote('b', '/r/app/a.ts');
    conflicts.update([a, b]);
    const ended = { ...b, state: 'ended' as const };
    conflicts.update([a, ended]);
    expect(a.conflicts).toBeUndefined();
    expect(ended.conflicts).toBeUndefined();
  });

  it('a file conflict comes before a repository one, and more files read as "e altri"', () => {
    const { conflicts, make } = setup();
    const a = make('a', '/r/app');
    const b = { ...make('b', '/r/app'), project: 'zeta' };
    const c = { ...make('c', '/r/app'), project: 'alfa' };
    conflicts.wrote('a', '/r/app/1.ts');
    conflicts.wrote('a', '/r/app/2.ts');
    conflicts.wrote('a', '/r/app/3.ts');
    conflicts.wrote('b', '/r/app/1.ts');
    conflicts.wrote('b', '/r/app/2.ts');
    conflicts.wrote('b', '/r/app/3.ts');
    conflicts.wrote('c', '/r/app/9.ts');
    conflicts.update([a, b, c]);
    expect(a.conflicts!.map((conflict) => `${conflict.kind}:${conflict.withName}`)).toEqual(['file:zeta', 'repo:alfa']);
    expect(conflictText(a.conflicts![0]!)).toBe('same file as zeta: 1.ts and 2 more');
  });
});
