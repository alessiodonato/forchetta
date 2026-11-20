import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { keepRejected, readDataJson, writeDataJson } from '../shared/data-file.ts';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ensurePrivateDir } from '../shared/paths.ts';
import { customSkills, setCustomSkills, type SkillInfo, skillById, skillUsers } from '../shared/skills.ts';
import { describeSkill, githubLink, safeRepoPath } from '../shared/skill-links.ts';
import { bytesOf, type Git, gitRunner, type SkillCache, slug } from './skills.ts';

export { describeSkill, githubLink, skillUsers };

// The skills you add in the studio, next to the catalog (shared/skills.ts). From GitHub: the link of the folder of a
// skill; Forchetta finds the commit the link points at now, keeps it (so the skill does not change by itself), and
// fetches only that folder into its cache, as for the catalog. From a folder of this Mac: used where it is, never
// copied. They are kept in var/skills/yours.json; the presets and templates that use one are checked against it,
// so it is read before them.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function filesOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (entry.isDirectory()) total += filesOf(join(dir, entry.name));
    else if (entry.isFile()) total++;
  }
  return total;
}

const clean = (raw: unknown): SkillInfo | undefined => {
  const item = raw as Partial<SkillInfo> | undefined;
  if (!item || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id)) return undefined;
  if (item.local !== undefined && (typeof item.local !== 'string' || !isAbsolute(item.local))) return undefined;
  if (item.local === undefined && (typeof item.repo !== 'string' || typeof item.path !== 'string' || !safeRepoPath(item.path) || typeof item.commit !== 'string' || !/^[0-9a-f]{40}$/.test(item.commit))) return undefined;
  return {
    id: item.id,
    group: 'yours',
    repo: typeof item.repo === 'string' ? item.repo : '',
    path: typeof item.path === 'string' ? item.path : '',
    commit: typeof item.commit === 'string' ? item.commit : '',
    license: 'unknown',
    kb: typeof item.kb === 'number' ? item.kb : 0,
    files: typeof item.files === 'number' ? item.files : 0,
    summary: typeof item.summary === 'string' ? item.summary.slice(0, 200) : '',
    ...(item.local ? { local: item.local } : {}),
  };
};

export class CustomSkills {
  constructor(
    private readonly file: string | undefined,
    private readonly cache: Pick<SkillCache, 'fetchOne' | 'folderOf'>,
    private readonly git: Git = gitRunner(),
    private readonly log: (message: string) => void = () => {},
    /** Where a repository is asked for its branches: GitHub; a local repository in the tests. */
    private readonly remote: (repo: string) => string = (repo) => `https://github.com/${repo}.git`,
    private readonly home: string = homedir(),
  ) {
    if (!file) return;
    const raw = readDataJson(file, 'skill aggiunte', log);
    const items = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    setCustomSkills(items.flatMap((item) => clean(item) ?? []));
    keepRejected(file, items.filter((item) => !clean(item)), 'skill aggiunte', log);
  }

  list(): readonly SkillInfo[] {
    return customSkills();
  }

  /** The commit a branch, a tag or a commit of a repository is at now. */
  private async commitOf(repo: string, ref: string, cwd: string): Promise<string | undefined> {
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
    const out = await this.git(['ls-remote', this.remote(repo), `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`], cwd);
    if (!out.ok) throw new Error(`git ls-remote: ${out.error}`);
    const lines = out.out.split('\n').filter(Boolean).map((line) => line.split('\t') as [string, string]);
    // An annotated tag: the commit it points at.
    const peeled = lines.find(([, name]) => name.endsWith('^{}'));
    return (peeled ?? lines[0])?.[0];
  }

  /** Adds a skill from a link of GitHub or a folder of this Mac; the one added. */
  async add(source: string): Promise<Result<{ skill: SkillInfo }>> {
    const text = source.trim();
    if (!text) return { ok: false, error: 'paste the link of a skill on GitHub, or choose its folder' };
    try {
      const skill = text.startsWith('/') || text === '~' || text.startsWith('~/') ? this.fromFolder(text) : await this.fromGitHub(text);
      if ('error' in skill) return { ok: false, error: skill.error };
      if (skillById(skill.id)) return { ok: false, error: `there is a skill called ${skill.id} already` };
      setCustomSkills([...customSkills(), skill]);
      this.write();
      this.log(`skill aggiunta: ${skill.id} (${skill.local ?? `${skill.repo}@${skill.commit.slice(0, 7)}`})`);
      return { ok: true, skill };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private fromFolder(text: string): SkillInfo | { error: string } {
    const folder = resolve(text === '~' || text.startsWith('~/') ? join(this.home, text.slice(1)) : text);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) return { error: `${text} is not a folder` };
    const manifest = join(folder, 'SKILL.md');
    if (!existsSync(manifest)) return { error: `${text} has no SKILL.md: a skill is a folder with its SKILL.md` };
    const id = slug(basename(folder)).slice(0, 64);
    if (!id) return { error: 'the name of the folder makes no name for a skill' };
    return { id, group: 'yours', repo: '', path: '', commit: '', license: 'unknown', kb: Math.max(1, Math.round(bytesOf(folder) / 1024)), files: filesOf(folder), summary: describeSkill(readFileSync(manifest, 'utf8')), local: folder };
  }

  private async fromGitHub(text: string): Promise<SkillInfo | { error: string }> {
    const link = githubLink(text);
    if (!link) return { error: 'that is neither a link of GitHub nor a folder: paste https://github.com/<owner>/<repo>/tree/<branch>/<folder>, or choose a folder' };
    if ('error' in link) return link;
    const cwd = this.file ? dirname(this.file) : this.home;
    if (this.file) ensurePrivateDir(cwd);
    // A branch may have slashes in its name: the first parts that are a branch, a tag or a commit.
    for (let parts = 1; parts < link.rest.length; parts++) {
      const ref = link.rest.slice(0, parts).join('/');
      const commit = await this.commitOf(link.repo, ref, cwd);
      if (!commit) continue;
      const path = link.rest.slice(parts).join('/');
      if (!safeRepoPath(path)) return { error: 'Forchetta takes folders named with letters, digits, ".", "_" and "-" only: that folder of the skill has other characters' };
      const id = slug(basename(path)).slice(0, 64);
      if (!id) return { error: 'the name of the folder makes no name for a skill' };
      if (skillById(id)) return { error: `there is a skill called ${id} already` };
      const skill: SkillInfo = { id, group: 'yours', repo: link.repo, path, commit, license: 'unknown', kb: 0, files: 0, summary: '' };
      await this.cache.fetchOne(skill);
      const folder = this.cache.folderOf(skill);
      return { ...skill, kb: Math.max(1, Math.round(bytesOf(folder) / 1024)), files: filesOf(folder), summary: describeSkill(readFileSync(join(folder, 'SKILL.md'), 'utf8')) };
    }
    return { error: `${link.repo} has no branch or tag ${link.rest[0]}` };
  }

  /** Takes away one of yours, if no preset, template or team uses it (they would not be valid any more). */
  remove(id: string, usedBy: readonly string[]): Result {
    if (!customSkills().some((skill) => skill.id === id)) return { ok: false, error: 'not one of your skills' };
    if (usedBy.length > 0) return { ok: false, error: `${id} is used by ${usedBy.join(', ')}: take it away from them first` };
    setCustomSkills(customSkills().filter((skill) => skill.id !== id));
    this.write();
    this.log(`skill tolta: ${id}`);
    return { ok: true };
  }

  private write(): void {
    if (!this.file) return;
    try {
      ensurePrivateDir(dirname(this.file));
      writeDataJson(this.file, customSkills());
    } catch (error) {
      this.log(`skill aggiunte non salvate: ${String(error)}`);
    }
  }
}
