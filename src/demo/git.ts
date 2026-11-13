// A git for the demo: the project folder has a last commit (the files as the demo made them), and `git diff`
// compares the files in memory with it. Only what daemon/diffs.ts and the guard ask.

import { relative } from './shims/path.ts';
import { existsSync, readText } from './shims/fs.ts';
import { gitDiff } from './diff.ts';

/** The last commit of each repository of the demo: its root, and each file as committed. */
const commits = new Map<string, Map<string, string>>();

export function commit(root: string, files: Map<string, string>): void {
  commits.set(root, new Map(files));
}

/** The repository a folder is in, if any. */
export function repoRoot(dir: string): string | undefined {
  for (const root of commits.keys()) if (dir === root || dir.startsWith(`${root}/`)) return root;
  return undefined;
}

/** What `git <args>` prints in a folder: code and output. */
export function runGit(args: readonly string[], cwd: string): { code: number; stdout: string } {
  const root = repoRoot(cwd);
  if (!root) return { code: 128, stdout: '' };
  const files = commits.get(root)!;
  const plain = args.filter((arg, index) => !(arg === '-c' || args[index - 1] === '-c'));
  const name = plain.at(-1) ?? '';
  const path = `${root}/${name}`;
  if (plain[0] === 'ls-files') return files.has(name) ? { code: 0, stdout: `${name}\n` } : { code: 1, stdout: '' };
  if (plain[0] === 'rev-parse') return { code: 0, stdout: plain.includes('--abbrev-ref') ? 'main\n' : `${root}\n` };
  if (plain[0] === 'diff') {
    if (plain.includes('--no-index')) return { code: 1, stdout: gitDiff(name, undefined, readText(path)) };
    const before = files.get(name);
    const after = existsSync(path) ? readText(path) : undefined;
    if (before === undefined) return { code: 0, stdout: '' };
    return { code: 0, stdout: gitDiff(relative(root, path), before, after) };
  }
  return { code: 0, stdout: '' };
}
