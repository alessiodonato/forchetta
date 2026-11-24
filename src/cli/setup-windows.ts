import { release } from 'node:os';
import { ptyProblem } from '../daemon/pty.ts';
import { which } from '../shared/config.ts';
import { UserError } from '../shared/errors.ts';
import { paths } from '../shared/paths.ts';
import { compareVersions } from '../shared/system.ts';
import { gitBash, windowsGit } from '../shared/windows.ts';
import type { SetupStep } from './setup-linux.ts';
import { tildify } from './style.ts';

// What `forchetta setup` looks at on Windows: no tmux and no app to build. Each session has a host of its own, and the page
// opens in a window of Edge or Chrome (`forchetta open`).

/** Windows 10 1809: the first with the pseudo-terminals, and the first Claude Code runs on. */
const MIN_BUILD = 17763;
export const CLAUDE_INSTALL_WINDOWS = 'irm https://claude.ai/install.ps1 | iex';

export interface WindowsFacts {
  /** 10.0.22631 */
  release: string;
  node: string;
  claude?: string;
  git?: string;
  bash?: string;
  /** Why the terminals of the page cannot open. */
  pty?: string;
}

/** Windows 11 calls itself 10.0 too: its builds start at 22000. */
export const windowsName = (text: string): string => `Windows ${(Number(text.split('.')[2]) || 0) >= 22000 ? '11' : '10'} (${text})`;

export function windowsSteps(facts: WindowsFacts): { steps: SetupStep[] } | { steps: SetupStep[]; error: string; hint: string } {
  const steps: SetupStep[] = [];
  const stop = (error: string, hint: string) => ({ steps, error, hint: `${hint}, then run \`forchetta setup\` again` });
  if ((Number(facts.release.split('.')[2]) || MIN_BUILD) < MIN_BUILD) return stop(`${windowsName(facts.release)} is too old: Forchetta needs Windows 10 1809 or later`, 'update Windows');
  steps.push({ label: 'Windows', detail: windowsName(facts.release), mark: '✓' });
  if (compareVersions(facts.node, '22.0.0') < 0) return stop(`Node.js ${facts.node} is too old: Forchetta needs 22 or later`, 'install it from https://nodejs.org');
  steps.push({ label: 'Node.js', detail: facts.node, mark: '✓' });
  if (facts.pty) steps.push({ label: 'Terminals', detail: `they cannot open: ${facts.pty}. The sessions you start in a terminal show up all the same, and so do the guard and the permissions`, mark: '▲' });
  else steps.push({ label: 'Terminals', detail: 'they open', mark: '✓' });
  if (facts.claude) steps.push({ label: 'claude', detail: tildify(facts.claude), mark: '✓' });
  else steps.push({ label: 'claude', detail: `not found: install it with \`${CLAUDE_INSTALL_WINDOWS}\`, then run \`forchetta setup\` again`, mark: '▲' });
  if (facts.git) steps.push({ label: 'git', detail: tildify(facts.git), mark: '✓' });
  else steps.push({ label: 'git', detail: 'not found: no diffs, no worktrees, and the guard does not look at git (`winget install Git.Git`)', mark: '▲' });
  steps.push({ label: 'Shell of Claude', detail: facts.bash ? 'Git Bash and PowerShell' : 'PowerShell', mark: '✓' });
  return { steps };
}

export function windowsFacts(): WindowsFacts {
  const claude = which('claude');
  const git = windowsGit();
  const bash = gitBash();
  const pty = ptyProblem();
  return { release: release(), node: process.versions.node, ...(claude ? { claude } : {}), ...(git ? { git } : {}), ...(bash ? { bash } : {}), ...(pty ? { pty } : {}) };
}

/** Looks, and says each step; stops with what to do when something Forchetta cannot do without is missing. */
export function checkWindows(say: (step: SetupStep) => void, facts = windowsFacts()): void {
  const result = windowsSteps(facts);
  for (const step of result.steps) say(step);
  if ('error' in result) throw new UserError(result.error, result.hint);
  if (/[^\x20-\x7e]/.test(paths.hookJs)) say({ label: 'Folder', detail: 'its path has accented letters: if a hook does not start, say so in an issue', mark: '▲' });
}
