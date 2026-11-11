import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where Forchetta keeps its files. Everything it writes at run time stays in `var/` inside its own
// folder: the daemon token, the tmux socket, the snapshot of the sessions, the log, the backups.

/** The Forchetta folder: the nearest folder above this file that holds the package.json of forchetta. */
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name === 'forchetta') return dir;
      } catch {
        // Not ours: keep going up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('forchetta: cartella del progetto non trovata');
    dir = parent;
  }
}

export const ROOT = process.env.FORCHETTA_ROOT ?? findRoot();

export interface Paths {
  varDir: string;
  daemonInfo: string;
  config: string;
  state: string;
  teams: string;
  patches: string;
  log: string;
  tmuxSocket: string;
  runDir: string;
  tmpDir: string;
  backups: string;
  payloads: string;
  tmuxConf: string;
  hookScript: string;
  permissionScript: string;
  statusScript: string;
  startScript: string;
  /** The status line command you had, run by bin/forchetta-statusline. */
  statusCommand: string;
  execScript: string;
  daemonJs: string;
}

export function pathsFor(varDir: string, root = ROOT): Paths {
  return {
    varDir,
    daemonInfo: join(varDir, 'daemon.json'),
    config: join(varDir, 'config.json'),
    state: join(varDir, 'state.json'),
    teams: join(varDir, 'teams.json'),
    patches: join(varDir, 'patches'),
    log: join(varDir, 'daemon.log'),
    tmuxSocket: join(varDir, 'tmux.sock'),
    runDir: join(varDir, 'run'),
    tmpDir: join(varDir, 'tmp'),
    backups: join(varDir, 'backups'),
    payloads: join(varDir, 'payloads.jsonl'),
    tmuxConf: join(root, 'config', 'tmux.conf'),
    hookScript: join(root, 'bin', 'forchetta-hook'),
    permissionScript: join(root, 'bin', 'forchetta-permission'),
    statusScript: join(root, 'bin', 'forchetta-statusline'),
    startScript: join(root, 'bin', 'forchetta-start'),
    statusCommand: join(varDir, 'statusline-command'),
    execScript: join(root, 'bin', 'forchetta-exec'),
    daemonJs: join(root, 'dist', 'daemon.js'),
  };
}

export const paths = pathsFor(process.env.FORCHETTA_VAR ?? join(ROOT, 'var'));

/** The folder of Claude Code: ~/.claude, or CLAUDE_CONFIG_DIR. */
export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env): string => env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

/** Makes a folder that only this user can open: it holds the daemon token and the text of the sessions. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  if (!stats.isDirectory()) throw new Error(`forchetta: ${dir} non è una cartella`);
  if ((stats.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}
