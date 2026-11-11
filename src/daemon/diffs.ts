import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, relative } from 'node:path';
import type { FileChange, SessionEdit } from '../shared/agent.ts';

// The changes of a session, for the panel of its box: the files it wrote (daemon/conflicts.ts) and what git says
// changed in each since the last commit. git only reads here, and with what could run a program turned off
// (external diff, textconv, fsmonitor). Run only when the panel asks.

const MAX_FILE_BYTES = 120 * 1024;
const MAX_TOTAL_BYTES = 600 * 1024;
const MAX_FILES = 100;
/** The changes of the session sent for one file, the latest ones, and in all. */
const MAX_EDITS_PER_FILE = 30;
const MAX_EDIT_BYTES = 1536 * 1024;

function git(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args],
      { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : -1) : 0;
        resolve({ code, stdout: String(stdout) });
      },
    );
  });
}

const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];

/** Lines added and removed in a unified diff. */
export function countLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

function shortPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** What changed in one file since the last commit of its working tree. */
async function change(path: string, at: number, repo: string | undefined): Promise<FileChange> {
  const name = repo ? relative(repo, path) : shortPath(path);
  const base: FileChange = { path, name, repo: repo ? basename(repo) : undefined, at, added: 0, removed: 0 };
  if (!repo) return { ...base, note: existsSync(path) ? 'fuori da git: nessun diff' : 'fuori da git, e non c’è più' };
  let diff = (await git([...DIFF, 'HEAD', '--', name], repo)).stdout;
  if (!diff) {
    // Not in the last commit: a new file, or a repository with no commit yet.
    const tracked = (await git(['ls-files', '--error-unmatch', '--', name], repo)).code === 0;
    if (!tracked && existsSync(path)) diff = (await git([...DIFF, '--no-index', '--', '/dev/null', name], repo)).stdout;
  }
  if (!diff) return { ...base, note: existsSync(path) ? 'nessuna differenza dall’ultimo commit' : 'non c’è più' };
  const counted = countLines(diff);
  if (diff.length > MAX_FILE_BYTES) return { ...base, ...counted, diff: `${diff.slice(0, MAX_FILE_BYTES)}\n…`, note: 'diff troncato' };
  return { ...base, ...counted, diff };
}

/** The changes of the files an agent wrote, the latest first, each with what this session itself changed. */
export async function changesOf(files: ReadonlyArray<{ path: string; at: number; repo?: string }>, edits: ReadonlyMap<string, SessionEdit[]> = new Map()): Promise<FileChange[]> {
  const out: FileChange[] = [];
  let total = 0;
  let editBytes = 0;
  for (const file of files.slice(0, MAX_FILES)) {
    let own = edits.get(file.path)?.slice(-MAX_EDITS_PER_FILE);
    const size = own ? JSON.stringify(own).length : 0;
    if (own && editBytes + size > MAX_EDIT_BYTES) own = undefined;
    else editBytes += size;
    const item = { ...(await change(file.path, file.at, file.repo)), edits: own };
    total += item.diff?.length ?? 0;
    if (total > MAX_TOTAL_BYTES && item.diff) {
      out.push({ ...item, diff: undefined, note: 'diff non mostrato: troppo testo in tutto' });
      continue;
    }
    out.push(item);
  }
  return out;
}
