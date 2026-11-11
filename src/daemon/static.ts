import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

// The files of the page, from dist/ui. Only files inside that folder, with a Content-Security-Policy that lets
// the page load its own scripts and styles and talk to this daemon, and nothing else.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function contentSecurityPolicy(port: number): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    // xterm.js writes some of its styles into <style> elements: inline styles yes, inline scripts never.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ws://127.0.0.1:${port}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Serves a file of the page. Returns false when the path is not one of them. */
export function serveStatic(uiDir: string, pathname: string, port: number, res: ServerResponse): boolean {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!name || name.includes('\0')) return false;
  const root = resolve(uiDir);
  const file = resolve(join(root, name));
  if (!file.startsWith(root + sep)) return false;
  const type = TYPES[extname(file)];
  if (!type || !existsSync(file) || !statSync(file).isFile()) return false;
  const body = readFileSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...(type.startsWith('text/html') ? { 'Content-Security-Policy': contentSecurityPolicy(port), 'Referrer-Policy': 'no-referrer' } : {}),
  });
  res.end(body);
  return true;
}
