import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Conflicts } from '../src/daemon/conflicts.ts';
import { changesOf, countLines } from '../src/daemon/diffs.ts';
import { outsideGitDir, tempDir } from './helpers.ts';

// The panel of the changes of a session: git diff from the last commit of the files it wrote.

const temp = tempDir('diffs');
const plain = outsideGitDir('diffs');
afterAll(() => {
  temp.cleanup();
  plain.cleanup();
});

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });

function repo(): string {
  const dir = join(temp.dir, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'src', 'a.ts'), 'uno\ndue\ntre\n');
  writeFileSync(join(dir, 'src', 'fermo.ts'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'primo');
  return dir;
}

describe('changes of a session', () => {
  it('a changed file, a new one, one already committed, one gone, one outside git', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'src', 'a.ts'), 'uno\nDUE\ntre\nquattro\n');
    writeFileSync(join(dir, 'src', 'nuovo.ts'), 'ciao\n');
    const outside = join(plain.dir, 'fuori.txt');
    writeFileSync(outside, 'x');
    const conflicts = new Conflicts();
    for (const file of ['src/fermo.ts', 'src/a.ts', 'src/nuovo.ts', 'src/sparito.ts']) conflicts.wrote('s', join(dir, file));
    conflicts.wrote('s', outside);
    const changes = await changesOf(conflicts.filesOf('s'));
    const byName = Object.fromEntries(changes.map((change) => [change.name, change]));

    expect(changes[0]!.path).toBe(outside);
    expect(byName['src/a.ts']).toMatchObject({ added: 2, removed: 1, repo: expect.any(String) });
    expect(byName['src/a.ts']!.diff).toContain('+DUE');
    expect(byName['src/nuovo.ts']).toMatchObject({ added: 1, removed: 0 });
    const noDiff = (change: { diff?: string; note?: string } | undefined) => [change?.diff, change?.note];
    expect(noDiff(byName['src/fermo.ts'])).toEqual([undefined, 'no difference since the last commit']);
    expect(noDiff(byName['src/sparito.ts'])).toEqual([undefined, 'gone']);
    expect(noDiff(changes.find((change) => change.path === outside))).toEqual([undefined, 'outside git: no diff']);
  });

  it('a repository with no commit yet: new files show whole', async () => {
    const dir = join(temp.dir, 'vuoto');
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'b.txt'), 'una\ndue\n');
    const conflicts = new Conflicts();
    conflicts.wrote('s', join(dir, 'b.txt'));
    const [change] = await changesOf(conflicts.filesOf('s'));
    expect(change).toMatchObject({ name: 'b.txt', added: 2, removed: 0 });
  });

  it('git runs no program of the repository: an external diff in its config is ignored', async () => {
    const dir = repo();
    const marker = join(temp.dir, 'eseguito');
    rmSync(marker, { force: true });
    git(dir, 'config', 'diff.external', `/bin/sh -c 'touch ${marker}'`);
    git(dir, 'config', 'core.fsmonitor', `/bin/sh -c 'touch ${marker}'`);
    writeFileSync(join(dir, 'src', 'a.ts'), 'altro\n');
    const conflicts = new Conflicts();
    conflicts.wrote('s', join(dir, 'src', 'a.ts'));
    const [change] = await changesOf(conflicts.filesOf('s'));
    expect(change!.diff).toContain('+altro');
    expect(() => execFileSync('test', ['-e', marker])).toThrow();
  });

  it('counts lines without the file headers', () => {
    expect(countLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+c\n')).toEqual({ added: 2, removed: 1 });
  });

  it('keeps what each session wrote across a restart of the daemon', () => {
    const conflicts = new Conflicts({ hasGit: () => false });
    conflicts.wrote('s', '/x/a.ts');
    conflicts.wrote('s', '/x/b.ts');
    const again = new Conflicts({ hasGit: () => false });
    again.load(JSON.parse(JSON.stringify(conflicts.dump())));
    expect(again.filesOf('s').map((file) => file.path)).toEqual(['/x/b.ts', '/x/a.ts']);
    expect(again.count('s')).toBe(2);
  });
});
