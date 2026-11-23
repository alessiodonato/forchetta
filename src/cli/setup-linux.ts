import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { which } from '../shared/config.ts';
import { UserError } from '../shared/errors.ts';
import { paths, ROOT } from '../shared/paths.ts';
import { installHint, onWindowsDrive, PLATFORM, systemTool } from '../shared/platform.ts';
import { compareVersions } from '../shared/system.ts';
import { ptyProblem } from '../daemon/pty.ts';
import { tildify } from './style.ts';

// What `forchetta setup` looks at on Linux, and in WSL: no app to build, the page opens in a browser (`forchetta
// open`). In WSL the mistakes are others than on a Mac: the Claude Code of Windows in place of one in WSL, Forchetta
// in a folder of Windows, where there are no sockets nor private folders.

/** tmux 3.2 has the copy-command and the extended keys of config/tmux.conf. */
export const MIN_TMUX = '3.2';
const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

export interface LinuxFacts {
  platform: 'linux' | 'wsl';
  node: string;
  kernel: string;
  root: string;
  varDir: string;
  tmux?: string;
  /** What `tmux -V` printed. */
  tmuxVersion?: string;
  /** The hooks send their events with /usr/bin/curl. */
  curl: boolean;
  claude?: string;
  /** A claude on a drive of Windows, when there is none in WSL. */
  windowsClaude?: string;
  /** Why the terminals of the page cannot open. */
  pty?: string;
  lsof: boolean;
  /** A clone, where node-pty is compiled, rather than an installed copy. */
  clone: boolean;
}

export interface SetupStep {
  label: string;
  detail: string;
  mark: '✓' | '▲';
}

/** tmux 3.4, tmux 3.3a, tmux next-3.5: "3.4", "3.3", "3.5". */
export const tmuxVersionOf = (text: string | undefined): string | undefined => /(\d+\.\d+)/.exec(text ?? '')?.[1];

/** The steps of the setup, in order; or what stops it. `install` says how to install a package here. */
export function linuxSteps(facts: LinuxFacts, install: (name: string) => string): { steps: SetupStep[] } | { steps: SetupStep[]; error: string; hint: string } {
  const steps: SetupStep[] = [];
  const stop = (error: string, hint: string) => ({ steps, error, hint: `${hint}, then run \`forchetta setup\` again` });
  if (facts.platform === 'wsl') {
    const there = [facts.root, facts.varDir].find(onWindowsDrive);
    if (there) return stop(`${there} is a folder of Windows: it cannot hold the sockets and the private data of Forchetta`, 'put Forchetta in your home of WSL (~)');
    // "4.4.0-19041-Microsoft" is WSL1, "5.15.153.1-microsoft-standard-WSL2" WSL2.
    if (/Microsoft/.test(facts.kernel) && !/WSL2/i.test(facts.kernel)) steps.push({ label: 'WSL', detail: 'version 1: Forchetta is made for WSL 2 (`wsl --set-version <distro> 2` in PowerShell)', mark: '▲' });
    else steps.push({ label: 'WSL', detail: 'version 2', mark: '✓' });
  }
  if (compareVersions(facts.node, '22.0.0') < 0) return stop(`Node.js ${facts.node} is too old: Forchetta needs 22 or later`, 'install it from https://nodejs.org');
  steps.push({ label: 'Node.js', detail: facts.node, mark: '✓' });
  if (!facts.tmux) return stop('tmux is missing', `install it with \`${install('tmux')}\``);
  const tmux = tmuxVersionOf(facts.tmuxVersion);
  if (tmux && compareVersions(`${tmux}.0`, `${MIN_TMUX}.0`) < 0) return stop(`tmux ${tmux} is too old: Forchetta needs ${MIN_TMUX} or later`, 'update it (Ubuntu 22.04 and later have one)');
  steps.push({ label: 'tmux', detail: `${tildify(facts.tmux)}${tmux ? ` · ${tmux}` : ''}`, mark: '✓' });
  if (!facts.curl) return stop('/usr/bin/curl is missing: the hooks send their events with it', `install it with \`${install('curl')}\``);
  if (facts.pty) {
    return stop(
      `the terminals of the page cannot open: ${facts.pty}`,
      facts.clone ? `compile node-pty with \`pnpm rebuild node-pty\` (it needs \`${install('build-essential python3')}\`)` : 'this copy has no terminals for this computer: install Forchetta again',
    );
  }
  steps.push({ label: 'Terminals', detail: 'node-pty loads', mark: '✓' });
  if (facts.claude) steps.push({ label: 'claude', detail: tildify(facts.claude), mark: '✓' });
  else if (facts.windowsClaude) steps.push({ label: 'claude', detail: `only the one of Windows (${facts.windowsClaude}): Forchetta needs Claude Code inside WSL, \`${CLAUDE_INSTALL}\``, mark: '▲' });
  else steps.push({ label: 'claude', detail: `not in the PATH: install it with \`${CLAUDE_INSTALL}\`, then run \`forchetta setup\` again`, mark: '▲' });
  if (!facts.lsof) steps.push({ label: 'lsof', detail: `missing: the guard does not see the dev servers that run (\`${install('lsof')}\`)`, mark: '▲' });
  return { steps };
}

/** What is on this computer. */
export function linuxFacts(): LinuxFacts {
  const tmux = which('tmux');
  const version = tmux ? spawnSync(tmux, ['-V'], { encoding: 'utf8', timeout: 5000 }) : undefined;
  const claude = which('claude');
  return {
    platform: PLATFORM === 'wsl' ? 'wsl' : 'linux',
    node: process.versions.node,
    kernel: release(),
    root: ROOT,
    varDir: paths.varDir,
    ...(tmux ? { tmux } : {}),
    ...(version?.status === 0 ? { tmuxVersion: version.stdout.trim() } : {}),
    curl: existsSync('/usr/bin/curl'),
    ...(claude ? { claude } : PLATFORM === 'wsl' ? { windowsClaude: which('claude', process.env, 'linux') } : {}),
    ...(ptyProblem() ? { pty: ptyProblem() } : {}),
    lsof: existsSync(systemTool('lsof')),
    clone: existsSync(join(ROOT, '.git')),
  };
}

/** Looks, and says each step; stops with what to do when something Forchetta cannot do without is missing. */
export function checkLinux(say: (step: SetupStep) => void, facts = linuxFacts(), install: (name: string) => string = (name) => installHint(name, (program) => which(program))): void {
  const result = linuxSteps(facts, install);
  for (const step of result.steps) say(step);
  if ('error' in result) throw new UserError(result.error, result.hint);
}
