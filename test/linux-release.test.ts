import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../src/shared/paths.ts';
import { VERSION } from '../src/shared/version.ts';

// The workflows that make and publish the archive for Linux and Windows: what keeps them from publishing something else.

const FOLDER = join(ROOT, '.github', 'workflows');
const workflow = (name: string): string => readFileSync(join(FOLDER, name), 'utf8');
/** Without the comments, which are not of it. */
const code = (text: string): string => text.replace(/^\s*#.*\n/gm, '').replace(/\n{2,}/g, '\n');
const archive = code(workflow('linux-archive.yml'));
const release = code(workflow('linux-release.yml'));

/** The parts of a text at an indentation, by the key that begins them; every line is of one. */
function parts(text: string, indent: number): Record<string, string> {
  const found: Record<string, string> = {};
  let key: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const begins = new RegExp(`^ {${indent}}([^\\s:][^:]*):(.*)$`).exec(line);
    if (begins) {
      key = begins[1]!;
      expect(found).not.toHaveProperty([key]);
      found[key] = begins[2]!.trim();
    } else {
      expect(line).toMatch(new RegExp(`^ {${indent + 1},}`));
      if (key === undefined) throw new Error(`a line of no part: ${line}`);
      found[key] += `\n${line}`;
    }
  }
  return found;
}
const jobs = (text: string): Record<string, string> => parts(parts(text, 0).jobs!.slice(1), 2);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

describe('the archive for Linux and Windows', () => {
  it('is made by actions at a fixed commit, with no cache and no password left around', () => {
    for (const text of [archive, release]) {
      const uses = [...text.matchAll(/\buses: *(.+)$/gm)].map((match) => match[1]!);
      expect(uses.length).toBeGreaterThan(0);
      for (const action of uses) expect(action).toMatch(/^(?:\.\/\.github\/workflows\/linux-archive\.yml|[\w-]+\/[\w-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+)$/);
      expect(text).not.toMatch(/^ *cache: |actions\/cache/m);
      expect(text.match(/actions\/checkout@/g)?.length).toBe(text.match(/persist-credentials: false/g)?.length);
      expect(text.match(/actions\/setup-node@/g)?.length).toBe(text.match(/package-manager-cache: false/g)?.length);
    }
  });

  it('only one job can sign and publish; the rest only reads', () => {
    expect(Object.keys(parts(archive, 0))).toEqual(['name', 'on', 'permissions', 'defaults', 'jobs']);
    expect(Object.keys(parts(release, 0))).toEqual(['name', 'on', 'permissions', 'defaults', 'concurrency', 'jobs']);
    for (const text of [archive, release]) expect(parts(text, 0).permissions).toBe('\n  contents: read');
    expect(Object.keys(jobs(archive))).toEqual(['terminals', 'archive', 'install']);
    expect(Object.keys(jobs(release))).toEqual(['check', 'test', 'build', 'publish']);
    expect(archive).not.toMatch(/write|permissions:[^]*permissions:|secrets/);
    for (const name of ['check', 'test', 'build']) expect(jobs(release)[name]).not.toMatch(/permissions|write|secrets|environment/);
    // No job goes on when another failed, nor does a step.
    for (const text of [archive, release]) expect(text).not.toMatch(/^ *(?:- )?(?:if|continue-on-error): /m);
  });

  it('only for a tag of a version', () => {
    expect(parts(release, 0).on).toBe("\n  push:\n    tags: ['v*']");
    expect(Object.keys(parts(parts(archive, 0).on!.slice(1), 2))).toEqual(['workflow_call']);
    expect(parts(jobs(release).publish!.slice(1), 4).needs).toBe('[test, build]');
    for (const name of ['test', 'build']) expect(parts(jobs(release)[name]!.slice(1), 4).needs).toBe('check');
  });

  // The two jobs that decide what gets out, word for word: to change one, read it again, then change its sum here.
  it('the jobs that check the tag, sign and publish are those that were reviewed', () => {
    expect({ check: sha(jobs(release).check!), publish: sha(jobs(release).publish!) }).toEqual({ check: '8753fef882cb72fe', publish: '476c24e2f0c096b0' });
  });

  it('the one that publishes takes only the files that were made, runs nothing of theirs, and writes over none', () => {
    const publish = jobs(release).publish!;
    expect([...publish.matchAll(/uses: ([\w/-]+)@/g)].map((match) => match[1])).toEqual(['actions/download-artifact', 'actions/attest']);
    expect(publish.indexOf('sha256sum -c')).toBeGreaterThan(publish.indexOf('actions/download-artifact'));
    expect(publish.indexOf('actions/attest')).toBeGreaterThan(publish.lastIndexOf('sha256sum -c'));
    for (const name of ['ARCHIVE', 'INSTALLER']) expect(publish).toContain(`echo "$${name}  release/`);
    expect(publish).not.toMatch(/working-directory|\bcd |--clobber|delete|pnpm|npm |npx|node |python|\bsh |\bbash (?!$)|GH_REPO|run-id/m);
    // gh asks git about the folder it is in, unless it is told the repository.
    for (const line of publish.match(/gh release .*/g)!) expect(line).toContain('-R "$GITHUB_REPOSITORY"');
    expect(publish).toContain('--draft');
  });

  it('a pipe that fails stops the step, and nothing of the outside is written into a script', () => {
    for (const text of [archive, release]) {
      expect(parts(text, 0).defaults).toBe('\n  run:\n    shell: bash');
      expect(text.match(/shell:/g)).toHaveLength(1);
      const known = ['matrix.arch', 'matrix.os', 'github.ref', 'github.token', 'steps.sums.outputs.archive', 'steps.sums.outputs.installer', 'jobs.archive.outputs.archive', 'jobs.archive.outputs.installer', 'needs.build.outputs.archive', 'needs.build.outputs.installer'];
      for (const [, expression] of text.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)) expect(known).toContain(expression);
      // Only where a value goes, never in the lines of a script.
      for (const line of text.split('\n').filter((line) => line.includes('${{'))) expect(line).toMatch(/^ *(?:- )?(?:name|group|value|archive|installer|runs-on|ARCHIVE|INSTALLER|GH_TOKEN): /);
      for (const line of text.match(/run: .*/g) ?? []) expect(line).not.toContain('${{');
    }
  });

  it('the installer checks that workflow, which is the one that signs', () => {
    expect(readdirSync(FOLDER).sort()).toEqual(['ci.yml', 'linux-archive.yml', 'linux-release.yml']);
    expect(readFileSync(join(ROOT, 'docs', 'install.sh'), 'utf8')).toContain('--signer-workflow "$REPO/.github/workflows/linux-release.yml" --source-ref "refs/tags/v$version"');
    expect(jobs(release).publish).toContain('actions/attest@');
    // CI reads only, and has no job that signs.
    expect(code(workflow('ci.yml'))).not.toMatch(/write|attest|secrets/);
  });

  it('has one version', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))).toMatchObject({ version: VERSION });
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
  });
});
