import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from '../shared/fspath.ts';
import { RULES_MAX } from '../shared/crew.ts';
import { TEAM_FILE_MAX } from '../shared/team-file.ts';

// The settings of Forchetta that live in a repository, next to its code, so that they are reviewed and shared like
// it: the folder .forchetta/ at the root of the repository (or of the folder, outside git).
//
//   .forchetta/teams/*.forchetta-team.json   teams to start (`forchetta team start <name>`), in the format of Export
//   .forchetta/rules.md                      rules every team started here follows, before its own
//   .forchetta/guard.json                    the parts of the guard on or off here: {"files": true, "git": false, …}
//
// Read when they are needed, and again only when they changed on disk.

export const REPO_DIR = '.forchetta';

export type GuardParts = { files: boolean; git: boolean; notes: boolean; servers: boolean };

const GUARD_KEYS = ['files', 'git', 'notes', 'servers'] as const;

/** What a repository says of the guard: only the parts it names, true or false. */
export function parseRepoGuard(text: string): Partial<GuardParts> | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'it is not JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'it is not an object like {"files": true, "git": false}' };
  const out: Partial<GuardParts> = {};
  for (const key of GUARD_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === true || value === false) out[key] = value;
  }
  return out;
}

/** The rules of a repository for its teams: the text of rules.md, trimmed to what a team keeps. */
export const repoRulesText = (text: string): string => text.replace(/\r\n?/g, '\n').trim().slice(0, RULES_MAX);

/**
 * The rules of the repository first, then those of the team, within what a team keeps; the same rules are not
 * written twice (a team started again from its own template already has them).
 */
export function withRepoRules(teamRules: string | undefined, repoRules: string | undefined): string | undefined {
  const own = teamRules?.trim() ?? '';
  const repo = repoRules?.trim() ?? '';
  if (!repo || own.includes(repo)) return own || undefined;
  if (!own) return repo.slice(0, RULES_MAX);
  return `${repo}\n\n${own}`.slice(0, RULES_MAX);
}

export interface RepoTeamFile {
  /** The file, absolute. */
  path: string;
  /** Its name without .forchetta-team.json: what `forchetta team start` takes. */
  key: string;
  text: string;
}

interface Cached<T> {
  mtimeMs: number;
  size: number;
  value: T;
}

/** The files of .forchetta/ of the repositories, read again only when they change. */
export class RepoConfig {
  private readonly guards = new Map<string, Cached<Partial<GuardParts>>>();
  private readonly rules = new Map<string, Cached<string | undefined>>();
  private readonly warned = new Set<string>();

  constructor(private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {}) {}

  private cached<T>(cache: Map<string, Cached<T>>, file: string, read: (text: string) => T, missing: T): T {
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(file);
    } catch {
      cache.delete(file);
      return missing;
    }
    const known = cache.get(file);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.value;
    let value = missing;
    try {
      value = stat.size > TEAM_FILE_MAX ? missing : read(readFileSync(file, 'utf8'));
    } catch {
      // Not readable: as if it were not there.
    }
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }

  /** The parts of the guard a repository turns on or off; nothing for a folder without .forchetta/guard.json. */
  guard(root: string | undefined): Partial<GuardParts> {
    if (!root) return {};
    const file = join(root, REPO_DIR, 'guard.json');
    return this.cached(
      this.guards,
      file,
      (text) => {
        const parsed = parseRepoGuard(text);
        if ('error' in parsed) {
          if (!this.warned.has(file)) this.log(`${file} ignored: ${parsed.error}`, 'warn');
          this.warned.add(file);
          return {};
        }
        this.warned.delete(file);
        return parsed;
      },
      {},
    );
  }

  /** The rules of .forchetta/rules.md, or undefined. */
  rulesOf(root: string | undefined): string | undefined {
    if (!root) return undefined;
    return this.cached(this.rules, join(root, REPO_DIR, 'rules.md'), (text) => repoRulesText(text) || undefined, undefined);
  }
}

/** The team files of a repository, by name, sorted; none when it has no .forchetta/teams. */
export function repoTeamFiles(root: string): RepoTeamFile[] {
  const dir = join(root, REPO_DIR, 'teams');
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.forchetta-team.json')).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    try {
      if (statSync(path).size > TEAM_FILE_MAX) return [];
      return [{ path, key: name.slice(0, -'.forchetta-team.json'.length), text: readFileSync(path, 'utf8') }];
    } catch {
      return [];
    }
  });
}
