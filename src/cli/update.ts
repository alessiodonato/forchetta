import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { writeDataJson } from '../shared/data-file.ts';
import { UserError } from '../shared/errors.ts';
import { backslashes, dirname, homedir, join, WINDOWS } from '../shared/fspath.ts';
import { brewPrefix, installerName, installKind, isIntact, latestRelease, latestVersion, readBytes, TAP } from '../shared/install.ts';
import { ensurePrivateDir, paths, ROOT } from '../shared/paths.ts';
import { isNewer, type UpdateRun } from '../shared/updates.ts';
import { VERSION } from '../shared/version.ts';
import { windowsPowerShell } from '../shared/windows.ts';
import { code } from './help.ts';
import { NOT_APPLIED } from './hooks.ts';
import type { RunIO } from './run.ts';
import { defaultAppDir, installedApp } from './setup.ts';

// `forchetta update`: the last version, installed as you installed this one, then its setup: the app, the hooks, the daemon on
// the new version. In a terminal the setup asks before it changes the hooks. From the page (--page, started by the daemon) it
// asks nothing and applies nothing: it says what would change, and the page asks.

const STEP_MS = 30 * 60_000;

interface Step {
  text: string;
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** A program, shown as it goes in a terminal; from the page, its output is kept. */
function run(step: Step, page: boolean): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(step.file, step.args, { env: { ...process.env, ...step.env }, stdio: page ? ['ignore', 'pipe', 'pipe'] : 'inherit', timeout: STEP_MS, windowsHide: true });
    let output = '';
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-40_000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (error) => resolve({ status: null, output: String(error) }));
    child.on('close', (status) => resolve({ status, output }));
  });
}

const ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The last lines of what a program wrote, for a line of the page. */
export const lastWords = (output: string): string =>
  output
    .replace(ESCAPES, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' · ')
    .slice(-400);

/** The lines of a setup that say what changes in the hooks: "+ Stop: command …". */
export const hookChanges = (output: string): string[] =>
  output
    .replace(ESCAPES, '')
    .split(/\r?\n/)
    .filter((line) => /^ {2}[+~-] \S/.test(line))
    .map((line) => line.trim());

/** Where the app of this Forchetta is: a setup without it would build another one. */
function appDir(): string[] {
  for (const dir of [defaultAppDir(), '/Applications']) if (installedApp(join(dir, 'Forchetta.app'))?.root === ROOT) return ['--app-dir', dir];
  return [];
}

/** The version this one is taken for: another one, only in the tests. */
const current = (): string => process.env.FORCHETTA_UPDATE_FROM ?? VERSION;

/** How a Forchetta of one kind is updated: what to run, and the command of the new one. */
interface Plan {
  steps: () => Promise<Step[]>;
  forchetta: { file: string; args: string[]; env?: NodeJS.ProcessEnv };
  setup: string[];
  who: string;
  done?: () => void;
}

/** With Homebrew, on a Mac. */
function brewPlan(prefix: string, latest: string): Plan {
  const brew = join(prefix, 'bin', 'brew');
  if (!existsSync(brew)) throw new UserError(`${brew} is not there`);
  // A daemon started by the app has the short PATH of the Finder.
  const env: NodeJS.ProcessEnv = { PATH: `${join(prefix, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`, HOME: homedir(), HOMEBREW_NO_ENV_HINTS: '1' };
  return {
    steps: async () => [
      { text: 'Homebrew looks for new versions', file: brew, args: ['update'], env },
      { text: `Homebrew installs Forchetta ${latest}`, file: brew, args: ['upgrade', TAP], env: { ...env, HOMEBREW_NO_AUTO_UPDATE: '1' } },
    ],
    forchetta: { file: join(prefix, 'bin', 'forchetta'), args: [], env },
    setup: ['setup', ...appDir()],
    who: 'Homebrew',
  };
}

/** With the installer of the release, on Windows and on Linux: the same you ran, and it checks its archive itself. */
function installerPlan(latest: string): Plan {
  const file = join(paths.tmpDir, `update-${process.pid}-${installerName()}`);
  // The Node.js of Forchetta alone, when there is one, else the one that runs this: the file of the command is not a program.
  const own = join(dirname(ROOT), 'forchetta-node', ...(WINDOWS ? ['node.exe'] : ['bin', 'node']));
  return {
    steps: async () => {
      const release = await latestRelease(undefined, current());
      if (!release || release.version !== latest) throw new UserError(`the installer of ${latest} is not there`);
      const bytes = await readBytes(release.installer);
      if (!isIntact(bytes, release.sha256)) throw new UserError('the installer is not the one of the release: nothing was installed');
      ensurePrivateDir(paths.tmpDir);
      writeFileSync(file, bytes, { mode: 0o600 });
      const env = { FORCHETTA_NO_SETUP: '1', FORCHETTA_EXIT: '1' };
      const text = `The installer puts Forchetta ${latest} in place`;
      // As `irm … | iex`: a file would need a policy of scripts that many PCs do not have.
      if (WINDOWS) return [{ text, file: windowsPowerShell(), args: ['-NoProfile', '-NonInteractive', '-Command', `Get-Content -Raw -LiteralPath '${backslashes(file).replaceAll("'", "''")}' | Invoke-Expression`], env }];
      return [{ text, file: '/bin/sh', args: [file], env }];
    },
    forchetta: { file: existsSync(own) ? own : process.execPath, args: [join(ROOT, 'dist', 'cli.js')] },
    setup: ['setup'],
    who: 'the installer',
    done: () => rmSync(file, { force: true }),
  };
}

export async function updateCommand(options: { check: boolean; page: boolean }, io: RunIO): Promise<number> {
  const s = io.style;
  const kind = installKind();
  const prefix = brewPrefix();
  if (kind !== 'installer' && (kind !== 'brew' || !prefix)) {
    throw new UserError('this Forchetta does not update by itself', kind === 'clone' ? 'in a clone: `git pull && pnpm install && pnpm build`, then `bin/forchetta setup`' : 'see https://forchetta.dev/manual.html#update');
  }
  const from = current();
  const latest = await latestVersion().catch((error: unknown) => {
    throw new UserError(`the last version could not be read: ${error instanceof Error ? error.message : String(error)}`, 'is this computer online?');
  });
  if (!latest) throw new UserError('the last version could not be read', 'see https://forchetta.dev/changelog/');
  if (!isNewer(latest, from)) {
    io.stdout(`${s.mark('✓', 'green', `Forchetta ${from} is the last version.`)}\n`);
    return 0;
  }
  if (options.check) {
    io.stdout(`${s.mark('▲', 'amber', `Forchetta ${latest} is out: this is ${from}.`)} ${code('To update: `forchetta update`', s)}\n`);
    return 0;
  }

  const report = (state: UpdateRun['state'], more: Partial<UpdateRun> = {}): void => {
    if (!options.page) return;
    ensurePrivateDir(paths.varDir);
    writeDataJson(paths.updateRun, { state, from, to: latest, at: Date.now(), pid: process.pid, ...more });
  };
  const failed = (text: string): number => {
    report('failed', { text });
    if (options.page) return 1;
    throw new UserError(text);
  };
  let plan: Plan | undefined;
  try {
    plan = kind === 'installer' ? installerPlan(latest) : brewPlan(prefix!, latest);
    report('running', { text: 'Getting it' });
    for (const step of await plan.steps()) {
      report('running', { text: step.text });
      io.stdout(`${s.bold(step.text)}\n`);
      const result = await run(step, options.page);
      if (result.status !== 0) return failed(`${step.text}: ${lastWords(result.output) || `it ended with ${result.status ?? 'an error'}`}`);
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    plan?.done?.();
  }
  const { file, args, env } = plan.forchetta;
  const there = (await run({ text: '', file, args: [...args, '--version'], env }, true)).output.trim();
  if (!isNewer(there, from)) return failed(`${plan.who} did not install it: forchetta is still ${there || 'not there'}`);

  // Its own setup: the app, the hooks, the daemon on the new version.
  report('running', { text: `Setting up ${there}`, to: there });
  io.stdout(`${s.bold(`Setting up ${there}`)}\n`);
  const setup = await run({ text: '', file, args: [...args, ...plan.setup], env }, options.page);
  if (!options.page) return setup.status ?? 1;
  if (setup.status === NOT_APPLIED) {
    report('hooks', { to: there, changes: hookChanges(setup.output), pid: undefined });
    return 0;
  }
  if (setup.status !== 0) return failed(`Setting up ${there}: ${lastWords(setup.output)}`);
  report('done', { to: there, pid: undefined });
  return 0;
}
