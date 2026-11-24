import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { backslashes, dirname, homedir, join, slashes, WINDOWS } from './fspath.ts';
import { UserError } from './errors.ts';
import { PLATFORM, type Platform } from './platform.ts';

// Where Forchetta keeps its files. Everything it writes at run time stays in one private folder: the daemon token,
// the tmux socket, the snapshot of the sessions, the log, the backups. In a git checkout it is `var/` inside the
// folder, as it always was; installed (by Homebrew, say), it is ~/Library/Application Support/Forchetta on a Mac, and
// ~/.local/share/forchetta on Linux (WSL too) and on Windows, next to the one of Claude Code.

/** A path of the environment, as the others: on Windows with forward slashes. */
const slashesOnWindows = (path: string): string => (WINDOWS ? slashes(path) : path);

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
    if (parent === dir) throw new Error('forchetta: the Forchetta folder was not found');
    dir = parent;
  }
}

/**
 * A path that stays the same across upgrades. Homebrew keeps each version in a folder of its own,
 * `<prefix>/Cellar/forchetta/0.7.0/libexec`, and points `<prefix>/opt/forchetta` at the current one; node gives
 * the first, since it follows links. What Forchetta writes down for later (the hooks in the settings of Claude Code,
 * the folder the app runs, the path of node) uses the second, so that `brew upgrade` does not break it.
 */
export function stablePath(path: string, exists: (path: string) => boolean = existsSync): string {
  const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+(\/.*)?$/.exec(path);
  if (!match) return path;
  const candidate = `${match[1]}/opt/${match[2]}${match[3] ?? ''}`;
  return exists(candidate) ? candidate : path;
}

export const ROOT = process.env.FORCHETTA_ROOT ? slashesOnWindows(process.env.FORCHETTA_ROOT) : stablePath(findRoot());

/**
 * The private folder of Forchetta: FORCHETTA_VAR when set; `var/` inside the folder when it is a git checkout;
 * otherwise ~/Library/Application Support/Forchetta on a Mac, ~/.local/share/forchetta on Linux: not XDG_DATA_HOME,
 * which a hook may not have while the daemon does. The app (native/main.swift) and the scripts of the hooks (bin/)
 * follow the same rule.
 */
export function defaultVarDir(
  root = ROOT,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  home = homedir(),
  platform: Platform | undefined = PLATFORM,
): string {
  if (env.FORCHETTA_VAR) return slashesOnWindows(env.FORCHETTA_VAR);
  if (exists(join(root, '.git'))) return join(root, 'var');
  return platform === 'macos' ? join(home, 'Library', 'Application Support', 'Forchetta') : join(home, '.local', 'share', 'forchetta');
}

export interface Paths {
  varDir: string;
  daemonInfo: string;
  /**
   * The socket the hooks of Claude Code talk to the daemon on (bin/forchetta-hook and the others find it the same way).
   * On Windows a file with the name of the pipe and its key (shared/pipe.ts): the hooks of there read it.
   */
  hooksSocket: string;
  config: string;
  state: string;
  teams: string;
  /** The teams of agents, one file each (daemon/crews.ts). */
  crews: string;
  /** The MCP configuration of each session of a team that has its tools, one file per agent. */
  crewMcp: string;
  /** The templates of teams you saved. */
  crewTemplates: string;
  /** The presets of agents of the studio you saved or changed. */
  crewRoles: string;
  /** The teams that start by themselves, with their queues and last runs (daemon/automations.ts). */
  automations: string;
  /** The sessions that ended with the Mac, to reopen (daemon/reopen.ts). */
  reopen: string;
  /** What the guard did, counted by day (daemon/guard-stats.ts). */
  guardStats: string;
  /** The MCP server of the tools of a team (mcp/team.ts). */
  teamMcpJs: string;
  patches: string;
  /** The failed update of Claude Code that a `claude update` from the app took care of (daemon/claude-update.ts). */
  claudeUpdate: string;
  /** The quick prompts of the menu of a selection (daemon/prompts.ts). */
  prompts: string;
  log: string;
  tmuxSocket: string;
  runDir: string;
  tmpDir: string;
  backups: string;
  payloads: string;
  tmuxConf: string;
  hookScript: string;
  permissionScript: string;
  guardScript: string;
  statusScript: string;
  startScript: string;
  /** The status line command you had, run by bin/forchetta-statusline. */
  statusCommand: string;
  execScript: string;
  /** Windows: the program of the hooks and of the status line (src/hook/main.ts), in place of the scripts of bin/. */
  hookJs: string;
  /** Windows: what holds a session, in place of tmux (src/host/main.ts). */
  hostJs: string;
  /** Windows: the sessions that run, one file each, with the pipe of their host. */
  sessionsDir: string;
  daemonJs: string;
}

export function pathsFor(varDir: string, root = ROOT, windows = WINDOWS): Paths {
  return {
    varDir,
    daemonInfo: join(varDir, 'daemon.json'),
    hooksSocket: join(varDir, windows ? 'hooks-pipe.json' : 'hooks.sock'),
    config: join(varDir, 'config.json'),
    state: join(varDir, 'state.json'),
    teams: join(varDir, 'teams.json'),
    crews: join(varDir, 'crews'),
    crewMcp: join(varDir, 'crews', 'mcp'),
    crewTemplates: join(varDir, 'crew-templates.json'),
    crewRoles: join(varDir, 'crew-roles.json'),
    automations: join(varDir, 'automations.json'),
    reopen: join(varDir, 'reopen.json'),
    guardStats: join(varDir, 'guard-stats.json'),
    patches: join(varDir, 'patches'),
    claudeUpdate: join(varDir, 'claude-update.json'),
    prompts: join(varDir, 'prompts.json'),
    log: join(varDir, 'daemon.log'),
    tmuxSocket: join(varDir, 'tmux.sock'),
    runDir: join(varDir, 'run'),
    tmpDir: join(varDir, 'tmp'),
    backups: join(varDir, 'backups'),
    payloads: join(varDir, 'payloads.jsonl'),
    tmuxConf: join(root, 'config', 'tmux.conf'),
    hookScript: join(root, 'bin', 'forchetta-hook'),
    permissionScript: join(root, 'bin', 'forchetta-permission'),
    guardScript: join(root, 'bin', 'forchetta-guard'),
    statusScript: join(root, 'bin', 'forchetta-statusline'),
    startScript: join(root, 'bin', 'forchetta-start'),
    statusCommand: join(varDir, 'statusline-command'),
    execScript: join(root, 'bin', 'forchetta-exec'),
    hookJs: join(root, 'dist', 'windows', 'forchetta-hooks.js'),
    hostJs: join(root, 'dist', 'windows', 'host.js'),
    sessionsDir: join(varDir, 'run', 'sessions'),
    teamMcpJs: join(root, 'dist', 'team-mcp.js'),
    daemonJs: join(root, 'dist', 'daemon.js'),
  };
}

export const paths = pathsFor(defaultVarDir());

/** The folder of Claude Code: ~/.claude, or CLAUDE_CONFIG_DIR. */
export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env): string => (env.CLAUDE_CONFIG_DIR ? slashesOnWindows(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude'));

/** The system account of Windows, which the folders of a user keep too (backups, the antivirus). */
const SYSTEM_SID = '*S-1-5-18';

/**
 * A folder of Windows that only this user can open. Inside the home it is so already: the folders of a user are of that
 * user, of the system and of the administrators. Elsewhere (FORCHETTA_VAR on another drive) it is closed when it is made.
 */
function privateOnWindows(dir: string, made: boolean, home = homedir()): void {
  const inHome = `${slashes(dir)}/`.toLowerCase().startsWith(`${home}/`.toLowerCase());
  if (inHome || !made) return;
  const icacls = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'icacls.exe');
  const result = spawnSync(icacls, [backslashes(dir), '/inheritance:r', '/grant:r', `${userInfo().username}:(OI)(CI)F`, '/grant:r', `${SYSTEM_SID}:(OI)(CI)F`], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (result.status !== 0) throw new UserError(`${dir} cannot be made private`, 'put the data of Forchetta in your home, where no one else can read them');
}

/**
 * Makes a folder that only this user can open: it holds the daemon token and the text of the sessions. Off a Mac it
 * looks again: a drive of Windows in WSL, or a disk with no permissions, takes a chmod and changes nothing, and the
 * files in it would be of anyone.
 */
export function ensurePrivateDir(dir: string, platform: Platform | undefined = PLATFORM, look: (path: string) => { mode: number; uid: number } = lstatSync, own = process.getuid?.()): void {
  const made = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  if (!stats.isDirectory()) throw new Error(`forchetta: ${dir} is not a folder`);
  if (platform === 'windows') return privateOnWindows(dir, made);
  if ((stats.mode & 0o077) !== 0) {
    try {
      chmodSync(dir, 0o700);
    } catch (error) {
      // Off a Mac, what follows says why.
      if (platform === 'macos') throw error;
    }
  }
  if (platform === 'macos') return;
  const now = look(dir);
  if (own !== undefined && now.uid !== own) throw new UserError(`${dir} is of another user: Forchetta keeps its private data there`, 'run forchetta as the user it belongs to, without sudo');
  if ((now.mode & 0o077) !== 0) throw new UserError(`${dir} cannot be made private: it is on a drive of Windows, or on a disk with no permissions`, 'put Forchetta in your home of Linux (~)');
}
