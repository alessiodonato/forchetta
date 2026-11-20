import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { daemonEnv } from '../cli/pane-env.ts';
import { ensurePrivateDir, paths } from './paths.ts';
import { kickstartLaunchAgent } from '../daemon/launch-agent.ts';

// How the CLI finds and starts the daemon. The daemon writes var/daemon.json (port and token, readable by this
// user only) when it listens.

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  version: string;
}

export function readDaemonInfo(file = paths.daemonInfo): DaemonInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as Partial<DaemonInfo>;
    if (typeof info.port === 'number' && typeof info.token === 'string' && typeof info.pid === 'number') return info as DaemonInfo;
  } catch {
    // No daemon, or a file from one that stopped badly.
  }
  return undefined;
}

export async function api<T>(info: DaemonInfo, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 3000): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`daemon: ${method} ${path} → ${response.status}`);
  return (await response.json()) as T;
}

/** Like api(), but the answer of the daemon also when it says no (400, 404): what it says is in the body. */
export async function apiAnswer<T>(info: DaemonInfo, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 3000): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new Error(`daemon: ${method} ${path} → ${response.status}`);
  return (await response.json()) as T;
}

/** The daemon, when it runs and answers. */
export async function runningDaemon(): Promise<DaemonInfo | undefined> {
  const info = readDaemonInfo();
  if (!info) return undefined;
  try {
    await api(info, 'GET', '/api/health', undefined, 1000);
    return info;
  } catch {
    return undefined;
  }
}

/** Starts the daemon in the background, detached from this terminal, and waits until it answers. */
export async function ensureDaemon(node: string, waitMs = 5000): Promise<DaemonInfo | undefined> {
  const running = await runningDaemon();
  if (running) return running;
  if (!existsSync(paths.daemonJs)) throw new Error(`${paths.daemonJs} is missing: run "pnpm build" first`);
  ensurePrivateDir(paths.varDir);
  // Kept alive by macOS (`forchetta daemon keepalive on`): launchd starts it, so that it starts it again if it stops.
  if (kickstartLaunchAgent()) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const info = await runningDaemon();
      if (info) return info;
    }
  }
  // The daemon writes and rotates its log itself (daemon/log.ts); what a crash prints on stderr goes there too.
  const out = openSync(paths.log, 'a', 0o600);
  const child = spawn(node, [paths.daemonJs], { detached: true, stdio: ['ignore', 'ignore', out], env: daemonEnv(process.env), cwd: paths.varDir });
  child.unref();
  closeSync(out);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const info = await runningDaemon();
    if (info) return info;
  }
  return undefined;
}
