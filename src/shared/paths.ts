import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where Forchetta keeps its files. Everything it writes at run time stays in one private folder: the daemon token,
// the tmux socket, the snapshot of the sessions, the log, the backups. In a git checkout it is `var/` inside the
// folder, as it always was; installed (by Homebrew, say), it is ~/Library/Application Support/Forchetta.

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

export const ROOT = process.env.FORCHETTA_ROOT ?? stablePath(findRoot());

/**
 * The private folder of Forchetta: FORCHETTA_VAR when set; `var/` inside the folder when it is a git checkout;
 * otherwise ~/Library/Application Support/Forchetta. The app (native/main.swift) and bin/forchetta-statusline
 * follow the same rule.
 */
export function defaultVarDir(root = ROOT, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync, home = homedir()): string {
  if (env.FORCHETTA_VAR) return env.FORCHETTA_VAR;
  if (exists(join(root, '.git'))) return join(root, 'var');
  return join(home, 'Library', 'Application Support', 'Forchetta');
}

export interface Paths {
  varDir: string;
  daemonInfo: string;
  config: string;
  state: string;
  teams: string;
  /** The teams of agents, one file each (daemon/crews.ts). */
  crews: string;
  /** The MCP configuration of each session of a team that has its tools, one file per agent. */
  crewMcp: string;
  /** The templates of teams you saved. */
  crewTemplates: string;
  /** The MCP server of the tools of a team (mcp/team.ts). */
  teamMcpJs: string;
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
    crews: join(varDir, 'crews'),
    crewMcp: join(varDir, 'crews', 'mcp'),
    crewTemplates: join(varDir, 'crew-templates.json'),
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
    teamMcpJs: join(root, 'dist', 'team-mcp.js'),
    daemonJs: join(root, 'dist', 'daemon.js'),
  };
}

export const paths = pathsFor(defaultVarDir());

/** The folder of Claude Code: ~/.claude, or CLAUDE_CONFIG_DIR. */
export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env): string => env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

/** Makes a folder that only this user can open: it holds the daemon token and the text of the sessions. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  if (!stats.isDirectory()) throw new Error(`forchetta: ${dir} is not a folder`);
  if ((stats.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}
