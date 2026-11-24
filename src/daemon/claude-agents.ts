import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeConfigDir } from '../shared/paths.ts';
import type { AgentsEntry } from './state.ts';

// `claude agents --json`: the documented way to read the sessions of Claude Code from outside (Agent View,
// research preview). It lists interactive and background sessions with pid, session id and status. It costs
// about half a second of CPU, so the daemon reads it at start, every few minutes, and when hooks fall quiet.

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
      cwd: text(item.cwd),
      kind: text(item.kind),
      name: text(item.name),
      status: text(item.status),
      waitingFor: text(item.waitingFor),
      startedAt: num(item.startedAt),
    }));
}

/**
 * Tells the sessions at work from those at rest with a shell still running in the background (a dev server, a
 * command that outlived its time). `claude agents --json` calls both "busy"; the file Claude Code keeps for each
 * process, sessions/<pid>.json, calls the second "shell" (seen with 2.1.328 and 2.1.331). The file is not
 * documented: without it, or without that word in it, "busy" stays.
 */
export async function withShells(entries: readonly AgentsEntry[], sessionsDir: string): Promise<AgentsEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.status !== 'busy' || entry.pid === undefined) return entry;
      try {
        const file: unknown = JSON.parse(await readFile(join(sessionsDir, `${entry.pid}.json`), 'utf8'));
        const { pid, status } = (file ?? {}) as { pid?: unknown; status?: unknown };
        return pid === entry.pid && status === 'shell' ? { ...entry, status: 'shell' } : entry;
      } catch {
        return entry;
      }
    }),
  );
}

/** The sessions of Claude Code now, with the ones that only have a shell running told apart. */
export async function readClaudeAgents(claude: string, sessionsDir = join(claudeConfigDir(), 'sessions')): Promise<AgentsEntry[]> {
  return withShells(await listClaudeAgents(claude), sessionsDir);
}

function listClaudeAgents(claude: string): Promise<AgentsEntry[]> {
  return new Promise((resolve, reject) => {
    execFile(claude, ['agents', '--json'], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
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
