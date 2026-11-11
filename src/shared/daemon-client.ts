import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync } from 'node:fs';
import { ensurePrivateDir, paths } from './paths.ts';

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

const LOG_LIMIT = 5 * 1024 * 1024;

/** Starts the daemon in the background, detached from this terminal, and waits until it answers. */
export async function ensureDaemon(node: string, waitMs = 5000): Promise<DaemonInfo | undefined> {
  const running = await runningDaemon();
  if (running) return running;
  if (!existsSync(paths.daemonJs)) throw new Error(`manca ${paths.daemonJs}: esegui prima "pnpm build"`);
  ensurePrivateDir(paths.varDir);
  try {
    if (existsSync(paths.log) && statSync(paths.log).size > LOG_LIMIT) renameSync(paths.log, `${paths.log}.1`);
  } catch {
    // The log stays as it is.
  }
  const out = openSync(paths.log, 'a', 0o600);
  const env = { ...process.env };
  delete env.FORCHETTA_AGENT;
  const child = spawn(node, [paths.daemonJs], { detached: true, stdio: ['ignore', out, out], env, cwd: paths.varDir });
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
