import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAgents, readClaudeAgents, readSessionFile, withFiles } from '../src/daemon/claude-agents.ts';
import { tempDir } from './helpers.ts';

// `claude agents --json` says "busy" both for a session at work and for one at rest with a shell in the background:
// the file of the process, sessions/<pid>.json, tells them apart.

let dir: string;
let cleanup: () => void;
let sessions: string;

beforeEach(() => {
  ({ dir, cleanup } = tempDir('claude-agents'));
  sessions = join(dir, 'sessions');
  mkdirSync(sessions);
});
afterEach(() => cleanup());

const file = (pid: number, content: unknown): void => writeFileSync(join(sessions, `${pid}.json`), typeof content === 'string' ? content : JSON.stringify(content));
const statusOf = async (status: string, pid: number | undefined = 11): Promise<string | undefined> => (await withFiles([{ pid, status }], sessions))[0]!.status;

describe('a session that only has a shell running', () => {
  it('is told from one at work', async () => {
    file(11, { pid: 11, status: 'shell' });
    expect(await statusOf('busy')).toBe('shell');
    file(11, { pid: 11, status: 'busy' });
    expect(await statusOf('busy')).toBe('busy');
  });

  it('stays busy when the file says nothing: missing, not JSON, of another process, with a new word', async () => {
    expect(await statusOf('busy')).toBe('busy');
    file(11, '{"pid":11,"sta');
    expect(await statusOf('busy')).toBe('busy');
    file(11, 'null');
    expect(await statusOf('busy')).toBe('busy');
    file(11, { pid: 12, status: 'shell' });
    expect(await statusOf('busy')).toBe('busy');
    file(11, { pid: 11, status: 'something' });
    expect(await statusOf('busy')).toBe('busy');
  });

  it('is looked for only when claude agents says busy', async () => {
    file(11, { pid: 11, status: 'shell' });
    expect(await statusOf('idle')).toBe('idle');
    expect(await statusOf('waiting')).toBe('waiting');
    expect((await withFiles([{ status: 'busy', sessionId: 's' }], sessions))[0]).toEqual({ status: 'busy', sessionId: 's' });
  });

  it('says the version of the process, and whether Remote Control is connected', async () => {
    file(11, { pid: 11, status: 'idle', version: '2.1.328', bridgeSessionId: 'session_1' });
    expect(await readSessionFile(11, sessions)).toEqual({ status: 'idle', version: '2.1.328', remoteControl: true });
    expect((await withFiles([{ pid: 11, status: 'idle' }], sessions))[0]).toEqual({ pid: 11, status: 'idle', version: '2.1.328', remoteControl: true });
    // Disconnected: an empty id, or none.
    file(11, { pid: 11, status: 'idle', version: '2.1.331', bridgeSessionId: '' });
    expect(await readSessionFile(11, sessions)).toEqual({ status: 'idle', version: '2.1.331', remoteControl: false });
    expect(await readSessionFile(12, sessions)).toBeUndefined();
  });

  // A claude made of a script of sh, which Windows does not run.
  it.skipIf(process.platform === 'win32')('comes out of readClaudeAgents, with the other sessions as they are', async () => {
    const claude = join(dir, 'claude');
    const list = [
      { pid: 11, sessionId: 'a', cwd: '/p', kind: 'interactive', status: 'busy' },
      { pid: 12, sessionId: 'b', cwd: '/p', kind: 'interactive', status: 'busy' },
      { pid: 13, sessionId: 'c', cwd: '/p', kind: 'interactive', status: 'idle' },
    ];
    writeFileSync(claude, `#!/bin/sh\n[ "$1 $2" = "agents --json" ] && echo '${JSON.stringify(list)}'\n`, { mode: 0o755 });
    file(11, { pid: 11, status: 'shell' });
    file(12, { pid: 12, status: 'busy' });
    expect((await readClaudeAgents(claude, sessions)).map((entry) => entry.status)).toEqual(['shell', 'busy', 'idle']);
    expect(() => parseAgents('{}')).toThrow('not a list');
  });
});
