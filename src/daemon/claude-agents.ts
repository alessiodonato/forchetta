import { execFile } from 'node:child_process';
import type { AgentsEntry } from './state.ts';

// `claude agents --json`: the documented way to read the sessions of Claude Code from outside (Agent View,
// research preview). It lists interactive and background sessions with pid, session id and status. It costs
// about half a second of CPU, so the daemon reads it at start, every few minutes, and when hooks fall quiet.

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function parseAgents(stdout: string): AgentsEntry[] {
  const data: unknown = JSON.parse(stdout);
  if (!Array.isArray(data)) throw new Error('claude agents --json: non è una lista');
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

export function readClaudeAgents(claude: string): Promise<AgentsEntry[]> {
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
