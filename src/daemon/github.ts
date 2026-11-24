import { execFile } from 'node:child_process';
import { delimiter, dirname } from '../shared/fspath.ts';
import type { AutoTrigger } from '../shared/automation.ts';

// GitHub for the automations (shared/automation.ts): the open issues with a label, or the pull requests, of a
// repository, read with the GitHub CLI of this Mac (`gh`), logged in as you. Forchetta only reads: it never writes
// on GitHub; a team writes there if its goal says so, with your gh, as any session would.

export interface GithubItem {
  number: number;
  title: string;
  url: string;
  /** The branch of a pull request. */
  branch?: string;
  createdAt?: number;
}

export type GithubResult = { ok: true; repo: string; items: GithubItem[] } | { ok: false; error: string };

/** One run of gh: its output, or why there is none. */
export type GhRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const GH_TIMEOUT_MS = 30_000;
const LIMIT = '100';

/** gh run as a program of its own, not through a shell, with no prompt and no color. */
export function ghRunner(gh: string): GhRun {
  return (args, cwd) =>
    new Promise((resolve) => {
      execFile(
        gh,
        args,
        {
          cwd,
          timeout: GH_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, PATH: [dirname(gh), process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(delimiter), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat' },
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: error && !stderr ? String(error.message) : String(stderr) });
        },
      );
    });
}

/** The last line gh wrote on stderr, with what to do when it says how. */
function ghError(stderr: string): string {
  const line =
    stderr
      .trim()
      .split('\n')
      .map((text) => text.trim())
      .filter(Boolean)
      .at(-1) ?? 'gh failed';
  if (/auth login|not logged|authentication/i.test(stderr)) return 'gh is not logged in: run gh auth login in a terminal';
  if (/none of the git remotes|no git remotes|not a git repository/i.test(stderr)) return 'the folder has no GitHub remote: write the repository as owner/name';
  return `gh: ${line.slice(0, 200)}`;
}

/** The repository of a folder, as owner/name, from its git remote. */
async function repoOf(run: GhRun, cwd: string): Promise<{ repo: string } | { error: string }> {
  const result = await run(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd);
  const repo = result.stdout.trim();
  if (result.code !== 0 || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return { error: result.code !== 0 ? ghError(result.stderr) : 'gh did not say the repository of the folder' };
  return { repo };
}

/** The items gh listed, as JSON: those well formed. */
export function parseItems(stdout: string): GithubItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const items: GithubItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (!Number.isInteger(item.number) || (item.number as number) <= 0 || typeof item.title !== 'string' || typeof item.url !== 'string') continue;
    const created = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : Number.NaN;
    items.push({
      number: item.number as number,
      title: item.title.replace(/\s+/g, ' ').trim().slice(0, 160),
      url: item.url.slice(0, 500),
      ...(typeof item.headRefName === 'string' ? { branch: item.headRefName.slice(0, 200) } : {}),
      ...(Number.isFinite(created) ? { createdAt: created } : {}),
    });
  }
  return items.sort((a, b) => a.number - b.number);
}

/** The open issues with the label, or the pull requests, of the repository of a trigger (or of its folder). */
export async function githubItems(run: GhRun, cwd: string, trigger: Extract<AutoTrigger, { kind: 'github' }>): Promise<GithubResult> {
  let repo = trigger.repo;
  if (!repo) {
    const found = await repoOf(run, cwd);
    if ('error' in found) return { ok: false, error: found.error };
    repo = found.repo;
  }
  const args =
    trigger.what === 'issues'
      ? ['issue', 'list', '--repo', repo, '--state', 'open', '--label', trigger.label ?? '', '--json', 'number,title,url,createdAt', '--limit', LIMIT]
      : ['pr', 'list', '--repo', repo, '--state', 'open', ...(trigger.label ? ['--label', trigger.label] : []), '--json', 'number,title,url,headRefName,createdAt', '--limit', LIMIT];
  const result = await run(args, cwd);
  if (result.code !== 0) return { ok: false, error: ghError(result.stderr) };
  return { ok: true, repo, items: parseItems(result.stdout) };
}
