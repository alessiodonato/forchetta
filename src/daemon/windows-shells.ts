import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { backslashes, join, slashes } from '../shared/fspath.ts';
import { findExe, gitBash, windowsPowerShell } from '../shared/windows.ts';
import type { Pty } from './pty.ts';
import type { ShellProgram } from './shells.ts';
import { LIST_ARGS, parseProcesses, type WindowsProcess } from './windows-processes.ts';

// What a plain terminal runs on Windows, and what runs in one: Windows does not say which program is in front.

/** PowerShell (7, when it is there; else the one every Windows has), and Git Bash when it is there. */
export function windowsShells(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): ShellProgram[] {
  const programs = env.ProgramFiles ? [join(slashes(env.ProgramFiles), 'PowerShell', '7')] : [];
  const bash = gitBash(env, exists);
  return [
    { id: 'powershell', label: 'PowerShell', file: backslashes(findExe('pwsh', programs, env, exists) ?? windowsPowerShell(env)), args: ['-NoLogo'] },
    // CHERE_INVOKING: a login shell of Git Bash would go to the home.
    ...(bash ? [{ id: 'bash', label: 'Git Bash', file: backslashes(bash), args: ['--login', '-i'], env: { CHERE_INVOKING: '1', MSYSTEM: 'MINGW64' } }] : []),
  ];
}

/** What a shell starts for itself: its window, and Git Bash once more. */
const OF_THE_SHELL = /^(?:conhost|openconsole|bash|sh|pwsh|powershell)\.exe$/i;

/** The first program started under a process, by its name without .exe; undefined when there is none. */
export function childOf(pid: number, processes: ReadonlyMap<number, Pick<WindowsProcess, 'ppid' | 'name'>>): string | undefined {
  const under = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, row] of processes) {
      if (under.has(id) || !under.has(row.ppid)) continue;
      under.add(id);
      grew = true;
    }
  }
  under.delete(pid);
  for (const id of under) {
    const name = processes.get(id)?.name ?? '';
    if (name && !OF_THE_SHELL.test(name)) return name.replace(/\.exe$/i, '');
  }
  return undefined;
}

/** What runs in a shell: half a second of PowerShell, only when you close one. Nothing when Windows does not answer. */
export const runningUnder = (pty: Pty): Promise<string | undefined> =>
  new Promise((done) => {
    execFile(windowsPowerShell(), LIST_ARGS, { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => done(error ? undefined : childOf(pty.pid, parseProcesses(stdout))));
  });
