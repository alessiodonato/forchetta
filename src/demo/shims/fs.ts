// node:fs for the demo: files in memory. The project of the demo lives here (its files change as the sessions edit
// them, and the panel of the changes reads them), and so do the few files the daemon's modules write.

import { dirname, normalize } from './path.ts';

interface Entry {
  dir: boolean;
  text: string;
  mtimeMs: number;
}

const entries = new Map<string, Entry>([['/', { dir: true, text: '', mtimeMs: Date.now() }]]);
const listeners = new Set<(path: string) => void>();

function errno(code: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

const key = (path: unknown): string => normalize(String(path));

function ensureDir(path: string): void {
  const at = key(path);
  if (entries.get(at)?.dir) return;
  if (at !== '/') ensureDir(dirname(at));
  entries.set(at, { dir: true, text: '', mtimeMs: Date.now() });
}

function textOf(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return String(data);
}

// ---- What the demo uses itself ----

/** Puts a file in place, with its folders. */
export function putFile(path: string, text: string): void {
  ensureDir(dirname(path));
  entries.set(key(path), { dir: false, text, mtimeMs: Date.now() });
  for (const listener of listeners) listener(key(path));
}

export function readText(path: string): string | undefined {
  const entry = entries.get(key(path));
  return entry && !entry.dir ? entry.text : undefined;
}

export const isDir = (path: string): boolean => entries.get(key(path))?.dir === true;

export function onWrite(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every file under a folder, sorted. */
export function filesUnder(dir: string): string[] {
  const prefix = `${key(dir)}/`;
  return [...entries.entries()].filter(([path, entry]) => !entry.dir && path.startsWith(prefix)).map(([path]) => path).sort();
}

// ---- node:fs ----

export function existsSync(path: unknown): boolean {
  return entries.has(key(path));
}

export function readFileSync(path: unknown, _options?: unknown): string {
  const entry = entries.get(key(path));
  if (!entry) throw errno('ENOENT', key(path));
  if (entry.dir) throw errno('EISDIR', key(path));
  return entry.text;
}

export function writeFileSync(path: unknown, data: unknown, _options?: unknown): void {
  if (!entries.get(dirname(key(path)))?.dir) throw errno('ENOENT', key(path));
  putFile(key(path), textOf(data));
}

export function appendFileSync(path: unknown, data: unknown, _options?: unknown): void {
  putFile(key(path), (readText(key(path)) ?? '') + textOf(data));
}

export function mkdirSync(path: unknown, options?: { recursive?: boolean }): void {
  const at = key(path);
  if (entries.has(at) && !options?.recursive) throw errno('EEXIST', at);
  if (!options?.recursive && !entries.get(dirname(at))?.dir) throw errno('ENOENT', at);
  ensureDir(at);
}

export function rmSync(path: unknown, options?: { force?: boolean; recursive?: boolean }): void {
  const at = key(path);
  if (!entries.has(at)) {
    if (options?.force) return;
    throw errno('ENOENT', at);
  }
  for (const other of [...entries.keys()]) if (other === at || other.startsWith(`${at}/`)) entries.delete(other);
}

export const unlinkSync = (path: unknown): void => rmSync(path);

export function renameSync(from: unknown, to: unknown): void {
  const entry = entries.get(key(from));
  if (!entry) throw errno('ENOENT', key(from));
  entries.delete(key(from));
  if (entry.dir) entries.set(key(to), entry);
  else putFile(key(to), entry.text);
}

export function readdirSync(path: unknown, options?: { withFileTypes?: boolean }): unknown[] {
  const at = key(path);
  if (!entries.get(at)?.dir) throw errno('ENOENT', at);
  const prefix = at === '/' ? '/' : `${at}/`;
  const names = [...entries.keys()].filter((other) => other.startsWith(prefix) && other !== at && !other.slice(prefix.length).includes('/')).map((other) => other.slice(prefix.length)).sort();
  if (!options?.withFileTypes) return names;
  return names.map((name) => {
    const dir = entries.get(prefix + name)?.dir === true;
    return { name, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false };
  });
}

export function statSync(path: unknown, options?: { throwIfNoEntry?: boolean }): unknown {
  const entry = entries.get(key(path));
  if (!entry) {
    if (options?.throwIfNoEntry === false) return undefined;
    throw errno('ENOENT', key(path));
  }
  return { isDirectory: () => entry.dir, isFile: () => !entry.dir, isSymbolicLink: () => false, size: entry.text.length, mtimeMs: entry.mtimeMs, mtime: new Date(entry.mtimeMs), mode: entry.dir ? 0o40700 : 0o100600 };
}

export const lstatSync = statSync;
export const chmodSync = (): void => {};
export const realpathSync = (path: unknown): string => key(path);

export function createReadStream(): never {
  throw errno('ENOENT', 'stream');
}

export const promises = {
  readFile: async (path: unknown) => readFileSync(path),
  writeFile: async (path: unknown, data: unknown) => writeFileSync(path, data),
};

export default { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, unlinkSync, renameSync, readdirSync, statSync, lstatSync, chmodSync, realpathSync, createReadStream, promises };
