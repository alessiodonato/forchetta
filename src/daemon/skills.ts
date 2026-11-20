import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { safeRepoPath } from '../shared/skill-links.ts';
import { type SkillInfo, skillById } from '../shared/skills.ts';

// The skills of the agents of a team (shared/skills.ts), on this Mac. The first time a team uses a skill, its folder
// is fetched from GitHub at the commit of the catalog, and only that folder: git with a sparse checkout, one commit,
// no history, no other file of the repository. It is kept in var/skills/cache/<owner>-<repo>-<commit>/<skill>, for
// every team after. Each session of a team gets a plugin of its own, var/skills/agents/<team>/<agent>, whose skills
// are links to the cache: claude starts with --plugin-dir on it, so the skills are for that session only, and
// nothing is written in the folder of the project.

/** git, in a folder: what it printed, or why it failed. */
export type Git = (args: string[], cwd: string) => Promise<{ ok: true; out: string } | { ok: false; error: string }>;

/** The largest skill folder the cache takes: the largest of the catalog is about 1 MB. */
const MAX_BYTES = 10 * 1024 * 1024;
const PLUGIN = 'forchetta-skills';

export const gitRunner =
  (git = 'git', timeoutMs = 90_000): Git =>
  (args, cwd) =>
    new Promise((resolve) => {
      // core.fsmonitor=false: the configuration of a repository cannot make git run a program of its own.
      execFile(git, ['-c', 'core.fsmonitor=false', ...args], { cwd, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
        resolve(error ? { ok: false, error: (stderr || error.message).trim().split('\n').at(-1) ?? 'git failed' } : { ok: true, out: stdout });
      });
    });

export const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Whether a folder holds a symbolic link, at any depth. */
export function hasLinks(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && hasLinks(join(dir, entry.name))) return true;
  }
  return false;
}

export function bytesOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += bytesOf(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

export class SkillCache {
  /** The downloads under way, by repository and commit: two teams that start together fetch once. */
  private readonly fetching = new Map<string, Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly git: Git = gitRunner(),
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
    /** Where a repository is fetched from: GitHub; a local repository in the tests. */
    private readonly remote: (repo: string) => string = (repo) => `https://github.com/${repo}.git`,
    /** The skills it knows: the catalog; another one in the tests. */
    private readonly catalog: (id: string) => SkillInfo | undefined = skillById,
  ) {}

  /** Where a skill is kept: in the cache, at its commit; one of yours from a folder, in that folder. */
  folderOf(skill: Pick<SkillInfo, 'id' | 'repo' | 'commit' | 'local'>): string {
    if (skill.local) return skill.local;
    return join(this.dir, 'cache', `${slug(skill.repo)}-${skill.commit.slice(0, 12)}`, skill.id);
  }

  /** Fetches one skill that is not in the catalog yet (one you add): into the cache, at its commit. */
  async fetchOne(skill: SkillInfo): Promise<void> {
    if (skill.local || existsSync(join(this.folderOf(skill), 'SKILL.md'))) return;
    await this.fetch([skill]);
  }

  has(id: string): boolean {
    const skill = this.catalog(id);
    return !!skill && existsSync(join(this.folderOf(skill), 'SKILL.md'));
  }

  /** Makes sure these skills are in the cache, fetching what is missing; what could not be fetched, and why. */
  async ensure(ids: readonly string[]): Promise<{ failed: { id: string; error: string }[] }> {
    const failed: { id: string; error: string }[] = [];
    const missing: SkillInfo[] = [];
    for (const id of new Set(ids)) {
      const skill = this.catalog(id);
      if (!skill) failed.push({ id, error: 'not in the catalog' });
      else if (skill.local && !this.has(id)) failed.push({ id, error: `its folder has no SKILL.md any more: ${skill.local}` });
      else if (!this.has(id)) missing.push(skill);
    }
    const byRepo = new Map<string, SkillInfo[]>();
    for (const skill of missing) byRepo.set(`${skill.repo}@${skill.commit}`, [...(byRepo.get(`${skill.repo}@${skill.commit}`) ?? []), skill]);
    await Promise.all(
      [...byRepo.entries()].map(async ([key, skills]) => {
        try {
          // Another team is fetching from this repository: wait for it, then fetch what it did not bring.
          await this.fetching.get(key)?.catch(() => {});
          const left = skills.filter((skill) => !this.has(skill.id));
          if (left.length > 0) {
            const work = this.fetch(left).finally(() => this.fetching.delete(key));
            this.fetching.set(key, work);
            await work;
          }
        } catch (error) {
          for (const skill of skills) if (!this.has(skill.id)) failed.push({ id: skill.id, error: error instanceof Error ? error.message : String(error) });
        }
      }),
    );
    return { failed };
  }

  /** Fetches the folders of some skills of one repository, at their commit, and moves them into the cache. */
  private async fetch(skills: readonly SkillInfo[]): Promise<void> {
    const { repo, commit } = skills[0]!;
    const work = join(this.dir, 'tmp', `${slug(repo)}-${commit.slice(0, 12)}-${process.pid}-${Date.now()}`);
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const run = async (args: string[]): Promise<void> => {
      const result = await this.git(args, work);
      if (!result.ok) throw new Error(`git ${args[0]}: ${result.error}`);
    };
    try {
      this.log(`skills: fetching ${skills.map((skill) => skill.id).join(', ')} from ${repo}@${commit.slice(0, 7)}`);
      await run(['init', '-q']);
      await run(['remote', 'add', 'origin', this.remote(repo)]);
      await run(['sparse-checkout', 'set', '--no-cone', ...skills.map((skill) => `/${skill.path}/`)]);
      await run(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit]);
      await run(['checkout', '-q', 'FETCH_HEAD']);
      for (const skill of skills) {
        // The folder must be inside the work folder, and hold no link: a link could make Claude read any file.
        if (!safeRepoPath(skill.path)) throw new Error(`${skill.id}: the folder ${skill.path} is not a plain folder of the repository`);
        const from = join(work, skill.path);
        if (!resolve(from).startsWith(`${resolve(work)}/`)) throw new Error(`${skill.id}: the folder ${skill.path} is outside the repository`);
        if (!existsSync(join(from, 'SKILL.md'))) throw new Error(`${skill.id}: no SKILL.md in ${skill.path}`);
        if (hasLinks(from)) throw new Error(`${skill.id}: it holds symbolic links, which a skill does not need`);
        if (bytesOf(from) > MAX_BYTES) throw new Error(`${skill.id}: more than ${MAX_BYTES / 1024 / 1024} MB`);
        const to = this.folderOf(skill);
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        rmSync(to, { recursive: true, force: true });
        renameSync(from, to);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * The plugin of one session with these skills (those in the cache): its folder, for claude --plugin-dir, made
   * again each time; undefined with none.
   */
  plugin(key: string, ids: readonly string[]): string | undefined {
    const ready = [...new Set(ids)].filter((id) => this.has(id));
    const root = join(this.dir, 'agents', ...key.split('/').map(slug));
    rmSync(root, { recursive: true, force: true });
    if (ready.length === 0) return undefined;
    mkdirSync(join(root, '.claude-plugin'), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'skills'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({ name: PLUGIN, version: '1.0.0', description: 'The skills Forchetta gave this agent of a team, from its catalog of open-source skills.' }, null, 2)}\n`,
    );
    for (const id of ready) symlinkSync(this.folderOf(this.catalog(id)!), join(root, 'skills', id));
    return root;
  }

  /** The skills a plugin of a session links, by name: for the tests and the log. */
  linked(root: string): string[] {
    const skills = join(root, 'skills');
    if (!existsSync(skills)) return [];
    return readdirSync(skills).filter((name) => lstatSync(join(skills, name)).isSymbolicLink() && existsSync(readlinkSync(join(skills, name))));
  }
}
