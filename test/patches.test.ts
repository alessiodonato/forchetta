import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { editOf, Patches } from '../src/daemon/patches.ts';
import { slimPayload } from '../src/daemon/server.ts';
import { countEdits, tailOf } from '../src/ui/Files.tsx';
import { tempDir } from './helpers.ts';

// What a session itself wrote, change by change, from the responses of its write tools.

const temp = tempDir('patches');
afterAll(() => temp.cleanup());

const post = (tool: string, input: Record<string, unknown>, response: Record<string, unknown>) => ({
  hook_event_name: 'PostToolUse',
  session_id: 's',
  cwd: '/p/app',
  tool_name: tool,
  tool_input: input,
  tool_response: response,
});

/** As Claude Code 2.1.322 reports them. */
const EDIT = post(
  'Edit',
  { file_path: '/p/app/a.txt', old_string: 'ok', new_string: 'ok, modificato' },
  {
    filePath: '/p/app/a.txt',
    oldString: 'ok',
    newString: 'ok, modificato',
    originalFile: 'ok',
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-ok', '\\ No newline at end of file', '+ok, modificato', '\\ No newline at end of file'] }],
    userModified: false,
    replaceAll: false,
  },
);
const CREATE = post('Write', { file_path: 'b.txt', content: 'uno\ndue\n' }, { type: 'create', filePath: '/p/app/b.txt', content: 'uno\ndue\n', structuredPatch: [], originalFile: null });

describe('a change of the session', () => {
  it('an Edit: its blocks, as Claude Code reported them', () => {
    expect(editOf(EDIT, '/p/app', 5)).toEqual({ at: 5, tool: 'Edit', file: '/p/app/a.txt', hunks: EDIT.tool_response.structuredPatch });
  });

  it('a Write that creates a file: all of it added', () => {
    expect(editOf(CREATE, '/p/app', 5)).toEqual({
      at: 5,
      tool: 'Write',
      file: '/p/app/b.txt',
      created: true,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+uno', '+due'] }],
    });
  });

  it('nothing for the other tools, for PreToolUse, or with no patch', () => {
    expect(editOf({ ...EDIT, tool_name: 'Read' }, '/p/app', 5)).toBeUndefined();
    expect(editOf({ ...EDIT, hook_event_name: 'PreToolUse' }, '/p/app', 5)).toBeUndefined();
    expect(editOf(post('Edit', { file_path: '/p/app/a.txt' }, { structuredPatch: [] }), '/p/app', 5)).toBeUndefined();
  });

  it('a very large change is cut', () => {
    const lines = Array.from({ length: 2500 }, (_, index) => `+riga ${index}`);
    const edit = editOf(post('Write', { file_path: '/p/app/c.txt' }, { type: 'update', filePath: '/p/app/c.txt', structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2500, lines }] }), '/p/app', 5);
    expect(edit?.truncated).toBe(true);
    expect(edit?.hunks[0]!.lines).toHaveLength(2000);
  });

  it('the panel shows the end of a long path, from a whole folder', () => {
    expect(tailOf('src/a.ts')).toBe('src/a.ts');
    expect(tailOf('~/Desktop/Forchetta/var/e2e/alpha/nuovo2.txt')).toBe('…/var/e2e/alpha/nuovo2.txt');
    expect(tailOf('x'.repeat(50))).toBe('…/' + 'x'.repeat(50));
  });

  it('counts the lines it added and removed', () => {
    expect(countEdits([editOf(EDIT, '/p/app', 5)!, editOf(CREATE, '/p/app', 6)!])).toEqual({ added: 3, removed: 1 });
  });
});

describe('the daemon keeps the response of write tools only', () => {
  it('drops the output of commands and of files read', () => {
    expect(slimPayload(EDIT)?.tool_response).toEqual(EDIT.tool_response);
    expect(slimPayload({ ...EDIT, tool_name: 'Bash', tool_response: { stdout: 'segreto' } })?.tool_response).toBeUndefined();
    expect(slimPayload({ ...EDIT, hook_event_name: 'PreToolUse' })?.tool_response).toBeUndefined();
  });
});

describe('the record of the changes', () => {
  it('keeps them per session and per file, private to the user, and forgets them with the session', () => {
    const dir = join(temp.dir, 'patches');
    const patches = new Patches(dir);
    const id = '3f2b8c1e-1111-4222-8333-444455556666';
    patches.add(id, editOf(EDIT, '/p/app', 1)!);
    patches.add(id, editOf(CREATE, '/p/app', 2)!);
    patches.add(id, editOf(EDIT, '/p/app', 3)!);
    const byFile = new Patches(dir).byFile(id);
    expect([...byFile.keys()]).toEqual(['/p/app/a.txt', '/p/app/b.txt']);
    expect(byFile.get('/p/app/a.txt')!.map((edit) => edit.at)).toEqual([1, 3]);
    expect(statSync(join(dir, `${id}.jsonl`)).mode & 0o777).toBe(0o600);
    patches.forget([id]);
    expect(existsSync(join(dir, `${id}.jsonl`))).toBe(false);
    // A name that is not an agent id writes nothing.
    patches.add('../fuori', editOf(EDIT, '/p/app', 1)!);
    expect(existsSync(join(temp.dir, 'fuori.jsonl'))).toBe(false);
  });
});
