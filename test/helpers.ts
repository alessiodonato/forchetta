import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { ROOT } from '../src/shared/paths.ts';

/** A temporary folder inside var/test of the project: the tests write nothing outside the Forchetta folder. */
export function tempDir(name: string): { dir: string; cleanup: () => void } {
  const dir = join(ROOT, 'var', 'test', `${name}-${process.pid}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** An HTTP request with full control of the headers, Host and Origin included. */
export function http(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: { host: `127.0.0.1:${port}`, ...options.headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
