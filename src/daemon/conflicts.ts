import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Agent, Conflict } from '../shared/agent.ts';
import type { HookPayload } from './state.ts';

// Two sessions that write the same file, or in the same repository, at the same time. The writes are those the
// hooks see: Edit, Write, MultiEdit and NotebookEdit that went through (PostToolUse). What a Bash command
// changes (sed -i, git checkout, a formatter) is invisible to them. A repository is a working tree: the folder
// with .git in it, so two worktrees of the same repository are two different places.

/** Writes older than this do not count: the two sessions are no longer working on it at the same time. */
export const CONFLICT_WINDOW_MS = 60 * 60_000;
/** The most recent files kept for each session. */
const MAX_FILES = 300;

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** The file a write tool changed, absolute; undefined for any other event. */
export function writtenFile(payload: HookPayload, cwd: string | undefined): string | undefined {
  if (payload.hook_event_name !== 'PostToolUse' || !payload.tool_name || !WRITE_TOOLS.has(payload.tool_name)) return undefined;
  const input = (payload.tool_input ?? {}) as Record<string, unknown>;
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
  if (!path) return undefined;
  if (isAbsolute(path)) return resolve(path);
  const base = cwd ?? payload.cwd;
  return base ? resolve(base, path) : undefined;
}

interface Write {
  at: number;
  /** The working tree the file is in, if any. */
  repo?: string;
}

export interface ConflictsOptions {
  /** Whether a folder holds .git (a folder, or a file in a worktree). */
  hasGit?: (dir: string) => boolean;
  now?: () => number;
  windowMs?: number;
}

export class Conflicts {
  /** For each agent: the files it wrote, with when and in which working tree. */
  private readonly writes = new Map<string, Map<string, Write>>();
  private readonly repoOfDir = new Map<string, string | null>();
  private readonly hasGit: (dir: string) => boolean;
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(options: ConflictsOptions = {}) {
    this.hasGit = options.hasGit ?? ((dir) => existsSync(join(dir, '.git')));
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? CONFLICT_WINDOW_MS;
  }

  /** The working tree of a folder: the closest folder above it with .git. Read once per folder. */
  repoOf(dir: string): string | undefined {
    const known = this.repoOfDir.get(dir);
    if (known !== undefined) return known ?? undefined;
    let found: string | undefined;
    if (this.hasGit(dir)) found = dir;
    else {
      const parent = dirname(dir);
      if (parent !== dir) found = this.repoOf(parent);
    }
    this.repoOfDir.set(dir, found ?? null);
    return found;
  }

  /** A write of an agent: the file, now. */
  wrote(agentId: string, file: string): void {
    let files = this.writes.get(agentId);
    if (!files) {
      files = new Map();
      this.writes.set(agentId, files);
    }
    files.delete(file);
    files.set(file, { at: this.now(), repo: this.repoOf(dirname(file)) });
    while (files.size > MAX_FILES) files.delete(files.keys().next().value!);
  }

  forget(agentId: string): void {
    this.writes.delete(agentId);
  }

  /** The files an agent wrote, the latest first: for the panel of its changes. */
  filesOf(agentId: string): Array<{ path: string; at: number; repo?: string }> {
    return [...(this.writes.get(agentId) ?? new Map<string, Write>())].map(([path, write]) => ({ path, ...write })).reverse();
  }

  count(agentId: string): number {
    return this.writes.get(agentId)?.size ?? 0;
  }

  /** For the snapshot of the daemon: what each agent wrote, so that a restart keeps it. */
  dump(): Record<string, Array<[string, number]>> {
    const out: Record<string, Array<[string, number]>> = {};
    for (const [agentId, files] of this.writes) out[agentId] = [...files].map(([path, write]) => [path, write.at]);
    return out;
  }

  load(saved: unknown): void {
    if (!saved || typeof saved !== 'object') return;
    for (const [agentId, files] of Object.entries(saved as Record<string, unknown>)) {
      if (!Array.isArray(files)) continue;
      const map = new Map<string, Write>();
      for (const item of files) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || typeof item[1] !== 'number') continue;
        map.set(item[0], { at: item[1], repo: this.repoOf(dirname(item[0])) });
      }
      if (map.size > 0) this.writes.set(agentId, map);
    }
  }

  /**
   * The conflicts of every live agent, worked out again. Returns the agents whose list changed: the caller
   * saves them and tells the windows.
   */
  update(agents: Iterable<Agent>): Agent[] {
    const now = this.now();
    const all = [...agents];
    const live = all.filter((agent) => agent.state !== 'ended');
    const recent = new Map<string, Map<string, Write>>();
    for (const agent of live) {
      const files = this.writes.get(agent.id);
      if (!files) continue;
      const kept = new Map([...files].filter(([, write]) => now - write.at < this.windowMs));
      if (kept.size > 0) recent.set(agent.id, kept);
    }
    const changed: Agent[] = [];
    for (const agent of all) {
      const mine = agent.state === 'ended' ? undefined : recent.get(agent.id);
      const found: Conflict[] = [];
      if (mine) {
        for (const other of live) {
          if (other.id === agent.id) continue;
          const theirs = recent.get(other.id);
          if (!theirs) continue;
          const shared = [...mine.keys()].filter((file) => theirs.has(file));
          const name = other.team?.label ?? (other.name && other.project === agent.project ? other.name : other.project);
          if (shared.length > 0) {
            const repo = mine.get(shared[0]!)?.repo;
            found.push({ kind: 'file', with: other.id, withName: name, files: shared.map((file) => (repo ? relative(repo, file) : file)).sort(), repo: repo ? basename(repo) : undefined });
            continue;
          }
          const myRepos = new Set([...mine.values()].map((write) => write.repo).filter((repo): repo is string => repo !== undefined));
          const sameRepo = [...theirs.values()].find((write) => write.repo !== undefined && myRepos.has(write.repo))?.repo;
          if (sameRepo) found.push({ kind: 'repo', with: other.id, withName: name, files: [], repo: basename(sameRepo) });
        }
      }
      // Files first: they are the real danger.
      found.sort((a, b) => (a.kind === b.kind ? a.withName.localeCompare(b.withName) : a.kind === 'file' ? -1 : 1));
      const next = found.length > 0 ? found : undefined;
      if (JSON.stringify(next) === JSON.stringify(agent.conflicts)) continue;
      agent.conflicts = next;
      changed.push(agent);
    }
    return changed;
  }
}
