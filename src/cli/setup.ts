import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { which } from '../shared/config.ts';
import { UserError } from '../shared/errors.ts';
import { ensurePrivateDir, paths, ROOT } from '../shared/paths.ts';
import { VERSION } from '../shared/version.ts';
import { hooksCommand } from './hooks.ts';
import type { RunIO } from './run.ts';

// `forchetta setup`: what makes an installed Forchetta ready, in one command. It checks tmux, claude and the
// Command Line Tools, builds the app on this Mac and puts it in ~/Applications, then installs the hooks, with the
// diff and the question of `forchetta hooks install`. The app is built here, not downloaded: macOS does not
// quarantine it, so it opens with no warning even without a signature of Apple. After an upgrade it is run again,
// and builds the app only when its version or the Forchetta folder it runs changed.

export interface SetupOptions {
  /** Install the hooks without asking. */
  yes: boolean;
  /** Build the app even when the installed one is up to date. */
  force: boolean;
  /** Where the app goes: ~/Applications unless told otherwise. */
  appDir: string;
}

export const defaultAppDir = (): string => join(homedir(), 'Applications');

/** Version and Forchetta folder of an app built by build-app.sh, from its Info.plist; undefined when there is none. */
export function installedApp(app: string): { version?: string; root?: string } | undefined {
  const plist = join(app, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return undefined;
  const text = readFileSync(plist, 'utf8');
  const value = (key: string): string | undefined => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1];
  return { version: value('CFBundleShortVersionString'), root: value('ForchettaRoot') };
}

/** Whether the app must be built: missing, of another version, or running another Forchetta folder. */
export function needsBuild(installed: { version?: string; root?: string } | undefined, version: string, root: string, force: boolean): boolean {
  return force || !installed || installed.version !== version || installed.root !== root;
}

/** The Swift compiler of the Command Line Tools (or of Xcode), asked without opening the dialog that installs them. */
function hasSwiftCompiler(): boolean {
  if (spawnSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' }).status !== 0) return false;
  return spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }).status === 0;
}

/** Builds the app in the private folder, then puts it in place of the old one in a single rename. */
function buildApp(target: string): void {
  ensurePrivateDir(paths.tmpDir);
  const work = join(paths.tmpDir, `setup-${process.pid}`);
  const staging = join(work, 'Forchetta.app');
  mkdirSync(work, { recursive: true });
  try {
    const built = spawnSync('/bin/sh', [join(ROOT, 'scripts', 'build-app.sh'), staging], {
      encoding: 'utf8',
      env: { ...process.env, FORCHETTA_ROOT: ROOT, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` },
    });
    if (built.status !== 0) throw new UserError(`l'app non è stata compilata:\n${(built.stderr || built.stdout).trim()}`);
    mkdirSync(dirname(target), { recursive: true });
    const old = `${target}.old-${process.pid}`;
    if (existsSync(target)) renameSync(target, old);
    try {
      renameSync(staging, target);
    } catch (error) {
      // Another volume: a copy instead.
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      cpSync(staging, target, { recursive: true, verbatimSymlinks: true });
    }
    rmSync(old, { recursive: true, force: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const running = (app: string): boolean => spawnSync('/usr/bin/pgrep', ['-f', join(app, 'Contents', 'MacOS', 'Forchetta')], { stdio: 'ignore' }).status === 0;

export async function setupCommand(options: SetupOptions, io: RunIO): Promise<number> {
  if (process.platform !== 'darwin') throw new UserError('Forchetta funziona solo su macOS.');
  if (!existsSync(paths.daemonJs) || !existsSync(join(ROOT, 'dist', 'ui', 'index.html'))) throw new UserError(`manca ${join(ROOT, 'dist')}: esegui prima pnpm build`);
  if (!which('tmux')) throw new UserError('manca tmux: installalo con brew install tmux, poi riesegui forchetta setup');
  if (!hasSwiftCompiler()) throw new UserError("per compilare l'app servono i Command Line Tools di Xcode: xcode-select --install, poi riesegui forchetta setup");
  if (!which('claude')) io.stdout('Nota: claude non è nel PATH. Forchetta lo troverà quando installerai Claude Code (rilancia allora forchetta setup).\n');

  const app = join(options.appDir, 'Forchetta.app');
  if (needsBuild(installedApp(app), VERSION, ROOT, options.force)) {
    io.stdout(`Compilo l'app (circa 10 secondi)…\n`);
    buildApp(app);
    io.stdout(`App installata: ${app}\n`);
    if (running(app)) io.stdout('Forchetta è aperta con la versione di prima: chiudila (⌘Q) e riaprila.\n');
  } else {
    io.stdout(`L'app è già aggiornata: ${app}\n`);
  }
  io.stdout(`I dati di Forchetta stanno in ${paths.varDir}\n\n`);

  const code = await hooksCommand('install', { yes: options.yes }, io);
  if (code !== 0) return code;
  io.stdout(
    `\nPronto. Apri l'app con: open ${JSON.stringify(app)}\n` +
      'Le sessioni avviate con forchetta run claude, o dall\'app, si aprono anche nei suoi terminali.\n',
  );
  return 0;
}
