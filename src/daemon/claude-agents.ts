import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeConfigDir } from '../shared/paths.ts';
import type { AgentsEntry } from './state.ts';
import { fromOutside } from '../shared/fspath.ts';

// `claude agents --json`: the documented way to read the sessions of Claude Code from outside (Agent View,
// research preview). It lists interactive and background sessions with pid, session id and status. It costs
// about half a second of CPU, so the daemon reads it at start, every few minutes, and when hooks fall quiet.

/** The folder of a session, as Forchetta keeps it. */
const cwdOf = (cwd: string | undefined): string | undefined => (cwd ? fromOutside(cwd) : cwd);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function parseAgents(stdout: string): AgentsEntry[] {
  const data: unknown = JSON.parse(stdout);
  if (!Array.isArray(data)) throw new Error('claude agents --json: not a list');
  return data
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      pid: num(item.pid),
      sessionId: text(item.sessionId),
      cwd: cwdOf(text(item.cwd)),
      kind: text(item.kind),
      name: text(item.name),
      status: text(item.status),
      waitingFor: text(item.waitingFor),
      startedAt: num(item.startedAt),
    }));
}

const sessionsFolder = (): string => join(claudeConfigDir(), 'sessions');

/**
 * What the file Claude Code keeps for each process, sessions/<pid>.json, adds to `claude agents --json` (seen with
 * 2.1.328 and 2.1.331). It is not documented: without it, or without a field, nothing changes.
 */
export interface SessionFile {
  status?: string;
  /** The Claude Code the process runs. */
  version?: string;
  /** Remote Control is connected: the file has the id of its session on claude.ai. */
  remoteControl: boolean;
}

export async function readSessionFile(pid: number, sessionsDir = sessionsFolder()): Promise<SessionFile | undefined> {
  try {
    const file: unknown = JSON.parse(await readFile(join(sessionsDir, `${pid}.json`), 'utf8'));
    if (!file || typeof file !== 'object' || (file as { pid?: unknown }).pid !== pid) return undefined;
    const { status, version, bridgeSessionId } = file as Record<string, unknown>;
    return { status: text(status), version: text(version), remoteControl: text(bridgeSessionId) !== undefined };
  } catch {
    return undefined;
  }
}

/**
 * The entries with what their files add: the version of each, Remote Control, and "shell" for a session at rest with
 * a command still running in the background (a dev server, one that outlived its time), which `claude agents --json`
 * calls "busy" as one at work.
 */
export async function withFiles(entries: readonly AgentsEntry[], sessionsDir: string): Promise<AgentsEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const file = entry.pid === undefined ? undefined : await readSessionFile(entry.pid, sessionsDir);
      if (!file) return entry;
      return {
        ...entry,
        ...(entry.status === 'busy' && file.status === 'shell' ? { status: 'shell' } : {}),
        ...(file.version ? { version: file.version } : {}),
        remoteControl: file.remoteControl,
      };
    }),
  );
}

/** The sessions of Claude Code now, with what their files add. */
export async function readClaudeAgents(claude: string, sessionsDir = sessionsFolder()): Promise<AgentsEntry[]> {
  return withFiles(await listClaudeAgents(claude), sessionsDir);
}

function listClaudeAgents(claude: string): Promise<AgentsEntry[]> {
  return new Promise((resolve, reject) => {
    execFile(claude, ['agents', '--json'], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(parseAgents(String(stdout)));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

/** Whether a process still runs: signal 0 checks without sending anything. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
