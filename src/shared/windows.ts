import { existsSync } from 'node:fs';
import { delimiter, dirname, homedir, join, slashes, WINDOWS } from './fspath.ts';

// The programs of Windows that Forchetta runs or looks for, by their full paths.

type Exists = (path: string) => boolean;

const systemRoot = (env: NodeJS.ProcessEnv): string => slashes(env.SystemRoot ?? env.windir ?? 'C:/Windows');

/** A program of C:\Windows\System32. */
export const system32 = (name: string, env: NodeJS.ProcessEnv = process.env): string => join(systemRoot(env), 'System32', name);

/** Windows PowerShell 5.1, which every Windows has. */
export const windowsPowerShell = (env: NodeJS.ProcessEnv = process.env): string => system32('WindowsPowerShell/v1.0/powershell.exe', env);

/** The folders of the PATH, as Forchetta writes paths. */
export const pathDirs = (env: NodeJS.ProcessEnv = process.env): string[] => (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map(slashes);

/** A program of Windows by its name: with .exe, from the PATH and then from `more`. */
export function findExe(name: string, more: readonly string[] = [], env: NodeJS.ProcessEnv = process.env, exists: Exists = existsSync): string | undefined {
  for (const dir of [...pathDirs(env), ...more]) {
    const candidate = join(dir, `${name}.exe`);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** git.exe: in the PATH, or where Git for Windows puts it. */
export function windowsGit(env: NodeJS.ProcessEnv = process.env, exists: Exists = existsSync): string | undefined {
  const places = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA ? `${env.LOCALAPPDATA}/Programs` : undefined].filter((dir): dir is string => Boolean(dir)).map((dir) => join(slashes(dir), 'Git', 'cmd'));
  return findExe('git', places, env, exists);
}

/** Git Bash, which Claude Code uses when it is there: the path it was told, or next to git. */
export function gitBash(env: NodeJS.ProcessEnv = process.env, exists: Exists = existsSync): string | undefined {
  const told = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (told && exists(told)) return slashes(told);
  const git = windowsGit(env, exists);
  if (!git) return undefined;
  // …/Git/cmd/git.exe, …/Git/bin/git.exe or …/Git/mingw64/bin/git.exe: bash is in …/Git/bin.
  for (let dir = dirname(git), up = 0; up < 3; dir = dirname(dir), up++) {
    const bash = join(dir, 'bin', 'bash.exe');
    if (exists(bash)) return bash;
  }
  return undefined;
}

/**
 * claude.exe: in the PATH, where its installer puts it, or inside the package of npm, whose claude.cmd cannot be started
 * without a shell.
 */
export function windowsClaude(env: NodeJS.ProcessEnv = process.env, exists: Exists = existsSync, home = homedir()): string | undefined {
  const local = env.LOCALAPPDATA ? slashes(env.LOCALAPPDATA) : join(home, 'AppData', 'Local');
  const found = findExe('claude', [join(home, '.local', 'bin'), join(local, 'Microsoft', 'WinGet', 'Links')], env, exists);
  if (found) return found;
  const prefixes = [...pathDirs(env).filter((dir) => exists(join(dir, 'claude.cmd'))), ...(env.APPDATA ? [join(slashes(env.APPDATA), 'npm')] : [])];
  for (const prefix of prefixes) {
    const inside = join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (exists(inside)) return inside;
  }
  return undefined;
}

/** git on Windows by its full path (a daemon may have an older PATH); elsewhere the one named. */
export const gitProgram = (elsewhere: string): string => (WINDOWS ? (windowsGit() ?? 'git.exe') : elsewhere);
