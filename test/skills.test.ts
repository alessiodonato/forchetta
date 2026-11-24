import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Crews } from '../src/daemon/crews.ts';
import type { SpawnExtras } from '../src/daemon/spawn.ts';
import { gitRunner, SkillCache } from '../src/daemon/skills.ts';
import { BUILTIN_ROLES, BUILTIN_TEMPLATES, cleanCrewSpec, cleanTemplate, type CrewSpec } from '../src/shared/crew.ts';
import { cleanSkills, type SkillInfo, SKILLS, skillUrl } from '../src/shared/skills.ts';
import { tempDir } from './helpers.ts';

// The skills of the agents: the catalog, the skills of a team, the cache that fetches only their folders at a commit,
// and the plugin each session gets.

const temp = tempDir('skills');
afterAll(() => temp.cleanup());

describe('the catalog of skills', () => {
  it('names each skill once, pinned to a commit, with an open-source license and a line on what it does', () => {
    expect(new Set(SKILLS.map((skill) => skill.id)).size).toBe(SKILLS.length);
    for (const skill of SKILLS) {
      expect(skill.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(skill.path.endsWith(`/${skill.id}`)).toBe(true);
      expect(['MIT', 'Apache-2.0', 'CC-BY-SA-4.0']).toContain(skill.license);
      expect(skill.summary.length).toBeLessThan(110);
    }
    expect(skillUrl(SKILLS[0]!)).toBe(`https://github.com/obra/superpowers/tree/${SKILLS[0]!.commit}/skills/brainstorming`);
  });

  it('the presets of Forchetta use only skills of the catalog', () => {
    for (const role of BUILTIN_ROLES) expect(cleanSkills(role.skills)).not.toHaveProperty('error');
  });

  it('a team of Forchetta gives each agent the skills of the preset of its role', () => {
    const skillsOf = (name: string) => BUILTIN_ROLES.find((role) => role.name === name)?.skills;
    let given = 0;
    for (const template of BUILTIN_TEMPLATES) {
      expect(cleanTemplate(template)).not.toHaveProperty('error');
      for (const agent of [...(template.lead.kind === 'claude' ? [template.lead] : []), ...template.members]) {
        expect(agent.skills).toEqual(skillsOf(agent.name));
        if (agent.skills) given++;
      }
    }
    expect(given).toBe(8);
    const chain = BUILTIN_TEMPLATES.find((template) => template.name === 'manager › senior › junior')!;
    expect(chain.lead.kind === 'claude' && chain.lead.skills).toEqual(['brainstorming', 'planning-and-task-breakdown']);
    expect(chain.members.find((member) => member.name === 'junior')?.skills).toEqual(['test-driven-development', 'verification-before-completion', 'karpathy-guidelines']);
  });

  it('checks the skills of an agent: known ones, each once, at most 8', () => {
    expect(cleanSkills([' TDD-x '])).toEqual({ error: 'the skill " TDD-x " is not in the catalog of Forchetta, nor among the skills the user added' });
    expect(cleanSkills(['pdf', 'PDF', 'docx'])).toEqual({ skills: ['pdf', 'docx'] });
    expect(cleanSkills(SKILLS.slice(0, 9).map((skill) => skill.id))).toEqual({ error: '8 skills at most for one agent' });
    expect(cleanSkills('pdf')).toEqual({ error: 'skills: a list of names' });
    expect(cleanSkills([])).toEqual({});
    const spec = cleanCrewSpec({ name: 't', cwd: '/x', talk: 'twoway', lead: { kind: 'claude', name: 'lead', skills: ['brainstorming'] }, members: [{ name: 'dev', skills: ['test-driven-development'] }] });
    expect('spec' in spec && spec.spec.lead).toMatchObject({ skills: ['brainstorming'] });
    expect('spec' in spec && spec.spec.members[0]!.skills).toEqual(['test-driven-development']);
  });
});

describe('the cache of skills', () => {
  /** A repository with two skills and a file that is not theirs; its commit. */
  function repository(): { url: string; commit: string; catalog: (id: string) => SkillInfo | undefined } {
    const dir = join(temp.dir, `repo-${Math.random().toString(36).slice(2)}`);
    for (const [path, text] of [
      ['skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha.\n---\n'],
      ['skills/alpha/reference.md', 'more'],
      ['skills/beta/SKILL.md', '---\nname: beta\ndescription: Beta.\n---\n'],
      ['big/other.txt', 'x'.repeat(50_000)],
      ['skills/linky/SKILL.md', '---\nname: linky\ndescription: Linky.\n---\n'],
    ] as const) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    // A skill with a link to a file outside it.
    symlinkSync('/etc/hosts', join(dir, 'skills', 'linky', 'hosts'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'skills');
    const commit = git('rev-parse', 'HEAD');
    const base = { repo: 'local/skills', commit, license: 'MIT' as const, kb: 1, files: 1, group: 'build' as const, summary: 's' };
    const catalog: Record<string, SkillInfo> = {
      alpha: { ...base, id: 'alpha', path: 'skills/alpha' },
      beta: { ...base, id: 'beta', path: 'skills/beta' },
      ghost: { ...base, id: 'ghost', path: 'skills/ghost' },
      linky: { ...base, id: 'linky', path: 'skills/linky' },
      climber: { ...base, id: 'climber', path: 'skills/../big' },
    };
    return { url: `file://${dir}`, commit, catalog: (id) => catalog[id] };
  }

  it('fetches only the folders of the skills asked, at their commit, once', async () => {
    const source = repository();
    const runs: string[][] = [];
    const real = gitRunner();
    const cache = new SkillCache(join(temp.dir, 'cache-one'), async (args, cwd) => (runs.push(args), real(args, cwd)), () => {}, () => source.url, source.catalog);
    expect(cache.has('alpha')).toBe(false);
    expect(await cache.ensure(['alpha', 'beta', 'alpha'])).toEqual({ failed: [] });
    const alpha = cache.folderOf(source.catalog('alpha')!);
    expect(readFileSync(join(alpha, 'SKILL.md'), 'utf8')).toContain('name: alpha');
    expect(existsSync(join(alpha, 'reference.md'))).toBe(true);
    // Nothing else of the repository, and no work folder left.
    expect(existsSync(join(alpha, '..', 'big'))).toBe(false);
    expect(existsSync(join(temp.dir, 'cache-one', 'tmp')) ? execFileSync('ls', [join(temp.dir, 'cache-one', 'tmp')], { encoding: 'utf8' }) : '').toBe('');
    expect(runs.filter((args) => args[0] === 'fetch')).toHaveLength(1);
    expect(runs.find((args) => args[0] === 'fetch')).toContain(source.commit);
    // Already there: nothing fetched again.
    expect(await cache.ensure(['beta'])).toEqual({ failed: [] });
    expect(runs.filter((args) => args[0] === 'fetch')).toHaveLength(1);
  });

  it('says what it could not fetch: a folder with no SKILL.md, a repository that does not answer, a name it does not know', async () => {
    const source = repository();
    const cache = new SkillCache(join(temp.dir, 'cache-two'), gitRunner(), () => {}, () => source.url, source.catalog);
    expect(await cache.ensure(['ghost'])).toEqual({ failed: [{ id: 'ghost', error: 'ghost: no SKILL.md in skills/ghost' }] });
    expect(await cache.ensure(['nobody'])).toEqual({ failed: [{ id: 'nobody', error: 'not in the catalog' }] });
    // A link inside a skill, or a folder that climbs out of where it should be, is not taken.
    expect(await cache.ensure(['linky'])).toEqual({ failed: [{ id: 'linky', error: 'linky: it holds symbolic links, which a skill does not need' }] });
    expect(await cache.ensure(['climber'])).toEqual({ failed: [{ id: 'climber', error: 'climber: the folder skills/../big is not a plain folder of the repository' }] });
    expect(cache.has('linky')).toBe(false);
    const offline = new SkillCache(join(temp.dir, 'cache-three'), gitRunner(), () => {}, () => `file://${join(temp.dir, 'no-such-repo')}`, source.catalog);
    const result = await offline.ensure(['alpha']);
    expect(result.failed).toEqual([{ id: 'alpha', error: expect.stringMatching(/^git fetch: /) }]);
  });

  it('gives each session a plugin of its own with links to its skills, made again each time', async () => {
    const source = repository();
    const cache = new SkillCache(join(temp.dir, 'cache-four'), gitRunner(), () => {}, () => source.url, source.catalog);
    await cache.ensure(['alpha', 'beta']);
    const root = cache.plugin('crew-1/Senior Dev', ['alpha', 'beta', 'ghost'])!;
    expect(root).toBe(join(temp.dir, 'cache-four', 'agents', 'crew-1', 'senior-dev'));
    expect(JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'forchetta-skills' });
    expect(cache.linked(root).sort()).toEqual(['alpha', 'beta']);
    expect(readlinkSync(join(root, 'skills', 'alpha')).replaceAll('\\', '/')).toBe(cache.folderOf(source.catalog('alpha')!));
    expect(cache.plugin('crew-1/Senior Dev', ['beta'])).toBe(root);
    expect(cache.linked(root)).toEqual(['beta']);
    expect(cache.plugin('crew-1/Senior Dev', [])).toBeUndefined();
    expect(existsSync(root)).toBe(false);
  });
});

describe('a team with skills', () => {
  it('fetches the skills of everyone before the sessions start, and gives each one its own plugin', async () => {
    const crews = new Crews(undefined);
    const asked: string[][] = [];
    crews.skills = {
      ensure: async (ids) => (asked.push([...ids]), { failed: [{ id: 'docx', error: 'git fetch: offline' }] }),
      plugin: (key, ids) => `/skills/${key}:${ids.join(',')}`,
    };
    const extras: SpawnExtras[] = [];
    const spec = cleanCrewSpec({
      name: 'docs team',
      cwd: '/x',
      talk: 'twoway',
      lead: { kind: 'claude', name: 'lead', skills: ['brainstorming'] },
      members: [{ name: 'writer', skills: ['docx', 'pdf'] }, { name: 'plain' }],
    }) as { spec: CrewSpec };
    const result = await crews.create(spec.spec, async (_choices, more) => (extras.push(more), { ok: true as const, agentId: `a${extras.length}` }));
    expect(asked).toEqual([['brainstorming', 'docx', 'pdf']]);
    expect(extras.map((more) => more.pluginDir)).toEqual([`/skills/${result.crewId}/lead:brainstorming`, `/skills/${result.crewId}/writer:docx,pdf`, undefined]);
    expect(result).toMatchObject({ ok: true, error: 'skills not downloaded, the agents started without them: docx (git: fetch: offline)'.replace('git: fetch', 'git fetch') });
  });
});
