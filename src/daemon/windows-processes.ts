import { slashes } from '../shared/fspath.ts';
import { system32, windowsPowerShell } from '../shared/windows.ts';
import type { Look, ProcessRow, ServersOptions } from './servers.ts';

// The processes of Windows, for the guard: who listens on a port (netstat), and who started whom (PowerShell, about half a
// second: only before a kill or a new dev server). Windows does not say the folder a process works in: the one its command
// line names stands for it, which is where the programs of a project are (node_modules\vite\bin\vite.js).

export interface WindowsProcess extends ProcessRow {
  command: string;
  /** When it started: a parent that started after its child is another process with the same number. */
  started: number;
}

/** `netstat -ano -p TCP`: who listens. The state is in the language of Windows; a listener is one connected to port 0. */
export function parseNetstat(text: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const line of text.split('\n')) {
    const match = /^\s*TCP\s+\S+:(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s+\S.*?\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[2]);
    const ports = out.get(pid) ?? [];
    if (!ports.includes(Number(match[1]))) ports.push(Number(match[1]));
    out.set(pid, ports);
  }
  return out;
}

const LIST =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId,$_.ParentProcessId,$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }),$_.Name,(\"$($_.CommandLine)\" -replace '[\\r\\n]+',' ') }";

export const LIST_ARGS = ['-NoProfile', '-NonInteractive', '-Command', LIST];

export function parseProcesses(text: string): Map<number, WindowsProcess> {
  const out = new Map<number, WindowsProcess>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^﻿?(\d+)\|(\d+)\|(\d+)\|([^|]*)\|(.*)$/.exec(line);
    if (match) out.set(Number(match[1]), { ppid: Number(match[2]), started: Number(match[3]), name: match[4]!, command: match[5]! });
  }
  for (const row of out.values()) {
    const parent = out.get(row.ppid);
    if (parent && row.started > 0 && parent.started > row.started) row.ppid = 0;
  }
  return out;
}

/** Whether a command line names a folder, or something in it, with either slash and in any case. */
export const namesFolder = (command: string, folder: string): boolean => {
  const line = slashes(command).toLowerCase();
  const dir = folder.toLowerCase().replace(/\/$/, '');
  for (let at = line.indexOf(dir); at >= 0; at = line.indexOf(dir, at + 1)) {
    const next = line[at + dir.length];
    if (next === undefined || next === '/' || next === '"' || next === "'" || next === ' ') return true;
  }
  return false;
};

/** The processes a kill by name stops: node.exe, node, or with -f what is anywhere in the command line. */
export function matchingProcesses(pattern: readonly string[], processes: ReadonlyMap<number, WindowsProcess>): number[] {
  const full = pattern[0] === '-f';
  const exact = pattern[0] === '-x';
  const wanted = (pattern.at(-1) ?? '').toLowerCase();
  const bare = (name: string): string => name.toLowerCase().replace(/\.exe$/, '');
  return [...processes]
    .filter(([, row]) => {
      if (full) return row.command.toLowerCase().includes(wanted);
      if (!exact) return row.name.toLowerCase().includes(wanted);
      // node*: taskkill and Stop-Process take a pattern.
      const name = bare(wanted);
      return name.includes('*') ? new RegExp(`^${name.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(bare(row.name)) : bare(row.name) === name;
    })
    .map(([pid]) => pid);
}

/** The process list is asked once for the questions of one command. */
const KEEP_MS = 1500;

export function windowsLook(run: ServersOptions['run'], now: () => number = Date.now): Look {
  let kept: { at: number; rows: Promise<Map<number, WindowsProcess>> } | undefined;
  const processes = (): Promise<Map<number, WindowsProcess>> => {
    if (!kept || now() - kept.at > KEEP_MS) kept = { at: now(), rows: run(windowsPowerShell(), LIST_ARGS).then((text) => parseProcesses(text ?? '')) };
    return kept.rows;
  };
  return {
    listening: async () => parseNetstat((await run(system32('netstat.exe'), ['-ano', '-p', 'TCP'])) ?? ''),
    processes,
    table: processes,
    folders: async (pids, scope) => {
      const rows = await processes();
      // npm, pnpm and cmd hold the line of the server: the one that listens, or who started it, names the folder.
      const names = (pid: number): boolean => {
        for (let current: number | undefined = pid, steps = 0; current && steps < 4; current = rows.get(current)?.ppid, steps++) {
          const row = rows.get(current);
          if (row && namesFolder(row.command, scope)) return true;
        }
        return false;
      };
      return new Map(pids.filter(names).map((pid) => [pid, scope]));
    },
    matching: async (pattern) => matchingProcesses(pattern, await processes()),
  };
}
