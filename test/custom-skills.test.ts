import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CustomSkills, describeSkill, githubLink, skillUsers } from '../src/daemon/custom-skills.ts';
import { gitRunner, SkillCache } from '../src/daemon/skills.ts';
import { cleanSkills, customSkills, setCustomSkills, skillById } from '../src/shared/skills.ts';
import { tempDir } from './helpers.ts';

// The skills you add in the studio: from a link of GitHub, at the commit of now, or from a folder of this Mac.

const temp = tempDir('custom-skills');
afterAll(() => temp.cleanup());
afterEach(() => setCustomSkills([]));

const dir = (name: string) => join(temp.dir, `${name}-${Math.random().toString(36).slice(2)}`);

/** A repository on "GitHub" (a local one): a skill on main, another on a branch with a slash in its name. */
function repository(): { url: string; main: string } {
  const root = dir('repo');
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  write('skills/release-notes/SKILL.md', '---\nname: release-notes\ndescription: "Writes the notes of a release from the commits."\n---\nBody.\n');
  write('skills/release-notes/template.md', '# Notes');
  write('skills/other/SKILL.md', '---\nname: other\ndescription: Other.\n---\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'skills');
  const main = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feature/new');
  write('skills/fresh/SKILL.md', '---\nname: fresh\ndescription: >\n  A skill on a branch,\n  on two lines.\n---\n');
  git('add', '.');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'fresh');
  git('checkout', '-q', 'main');
  return { url: `file://${root}`, main };
}

const make = (url: string) => {
  const base = dir('var');
  const cache = new SkillCache(join(base, 'skills'), gitRunner(), () => {}, () => url);
  const file = join(base, 'skills', 'yours.json');
  return { cache, file, skills: new CustomSkills(file, cache, gitRunner(), () => {}, () => url, temp.dir) };
};

describe('a link of GitHub', () => {
  it('gives the repository and the rest of the path; the link of a SKILL.md means its folder', () => {
    expect(githubLink('https://github.com/owner/repo/tree/main/skills/pdf')).toEqual({ repo: 'owner/repo', rest: ['main', 'skills', 'pdf'] });
    expect(githubLink('github.com/owner/repo/blob/v2/skills/pdf/SKILL.md')).toEqual({ repo: 'owner/repo', rest: ['v2', 'skills', 'pdf'] });
    expect(githubLink('https://github.com/owner/repo/tree/feature/x/skills/pdf/?tab=readme')).toEqual({ repo: 'owner/repo', rest: ['feature', 'x', 'skills', 'pdf'] });
    expect(githubLink('https://github.com/owner/repo')).toEqual({ error: expect.stringContaining('not of the whole repository') });
    // A link that leads out of its folder is refused, also written with %2e or %2f.
    for (const link of ['https://github.com/owner/repo/tree/main/../../x', 'https://github.com/owner/repo/tree/main/skills/%2e%2e/x', 'https://github.com/owner/repo/tree/main/a%2f..%2fb', 'https://github.com/owner/repo/tree/main/skills/%zz']) {
      expect(githubLink(link)).toMatchObject({ error: expect.any(String) });
    }
    expect(githubLink('https://gitlab.com/owner/repo/tree/main/x')).toBeUndefined();
    expect(githubLink('~/skills/pdf')).toBeUndefined();
  });

  it('a SKILL.md says what the skill does in its description, on one line or in a block', () => {
    expect(describeSkill('---\nname: a\ndescription: Does a thing.\n---\n')).toBe('Does a thing.');
    expect(describeSkill("---\ndescription: 'Quoted, with: a colon.'\n---")).toBe('Quoted, with: a colon.');
    expect(describeSkill('---\ndescription: >\n  Two\n  lines.\nname: x\n---')).toBe('Two lines.');
    expect(describeSkill('No front matter.')).toBe('');
    expect(describeSkill(`---\ndescription: ${'x'.repeat(300)}\n---`)).toHaveLength(200);
  });
});

describe('a skill of yours', () => {
  it('from a folder: used where it is, never copied, and given to a session like the others', async () => {
    const folder = join(dir('mine'), 'my-review');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), '---\nname: my-review\ndescription: Reviews like I do.\n---\n');
    const { skills, cache } = make('unused');
    const added = await skills.add(folder);
    expect(added).toEqual({ ok: true, skill: expect.objectContaining({ id: 'my-review', group: 'yours', local: folder, summary: 'Reviews like I do.', files: 1, license: 'unknown' }) });
    expect(skillById('my-review')?.local).toBe(folder);
    expect(cleanSkills(['my-review', 'pdf'])).toEqual({ skills: ['my-review', 'pdf'] });
    expect(await cache.ensure(['my-review'])).toEqual({ failed: [] });
    const plugin = cache.plugin('team/agent', ['my-review'])!;
    expect(readlinkSync(join(plugin, 'skills', 'my-review'))).toBe(folder);
    // The same name again, a folder with no SKILL.md, nothing at all.
    expect(await skills.add(folder)).toEqual({ ok: false, error: 'there is a skill called my-review already' });
    mkdirSync(join(folder, '..', 'empty'));
    expect(await skills.add(join(folder, '..', 'empty'))).toMatchObject({ ok: false, error: expect.stringContaining('has no SKILL.md') });
    expect(await skills.add('  ')).toMatchObject({ ok: false });
    expect(await skills.add('/no/such/folder')).toMatchObject({ ok: false, error: '/no/such/folder is not a folder' });
  });

  it('from GitHub: at the commit the link points at now, only its folder, outside the projects', async () => {
    const source = repository();
    const { skills, cache, file } = make(source.url);
    const added = await skills.add('https://github.com/someone/skills/tree/main/skills/release-notes');
    expect(added).toMatchObject({ ok: true, skill: { id: 'release-notes', repo: 'someone/skills', path: 'skills/release-notes', commit: source.main, summary: 'Writes the notes of a release from the commits.', files: 2 } });
    const folder = cache.folderOf(skillById('release-notes')!);
    expect(existsSync(join(folder, 'template.md'))).toBe(true);
    expect(existsSync(join(folder, '..', 'other'))).toBe(false);
    // A branch with a slash in its name.
    expect(await skills.add('github.com/someone/skills/tree/feature/new/skills/fresh')).toMatchObject({ ok: true, skill: { id: 'fresh', summary: 'A skill on a branch, on two lines.' } });
    expect(await skills.add('https://github.com/someone/skills/tree/nope/skills/x')).toMatchObject({ ok: false, error: 'someone/skills has no branch or tag nope' });
    // Kept: the next daemon finds them, and the catalog checks know them.
    setCustomSkills([]);
    new CustomSkills(file, cache, gitRunner(), () => {}, () => source.url);
    expect(customSkills().map((skill) => skill.id)).toEqual(['release-notes', 'fresh']);
    expect(cleanSkills(['fresh'])).toEqual({ skills: ['fresh'] });
  });

  it('is taken away only when no agent, template or team uses it', async () => {
    const folder = join(dir('mine'), 'house-style');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), '---\ndescription: Our style.\n---\n');
    const { skills } = make('unused');
    await skills.add(folder);
    const users = skillUsers(
      'house-style',
      [{ name: 'writer', skills: ['house-style'] }, { name: 'senior' }],
      [{ name: 'docs team', lead: { kind: 'you' }, members: [{ skills: ['pdf', 'house-style'] }] }],
      [{ name: 'checkout', lead: { kind: 'claude', skills: [] }, members: [] }],
    );
    expect(users).toEqual(['the agent writer', 'the template docs team']);
    expect(skills.remove('house-style', users)).toEqual({ ok: false, error: 'house-style is used by the agent writer, the template docs team: take it away from them first' });
    expect(skills.remove('house-style', [])).toEqual({ ok: true });
    expect(skillById('house-style')).toBeUndefined();
    expect(skills.remove('pdf', [])).toEqual({ ok: false, error: 'not one of your skills' });
  });
});
