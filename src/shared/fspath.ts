import { realpathSync } from 'node:fs';
// By these names: in the tests on Windows node:path and node:os are this module (vitest.config.ts).
import * as os from 'os';
import * as path from 'path';

// node:path and the folders of node:os, as Forchetta uses them. On a Mac and on Linux they are those of Node, untouched.
// On Windows the paths inside Forchetta are always written with forward slashes and an upper case drive (C:/Users/me/shop):
// Windows takes them, git writes them so, and the code that reads a path as text (the guard, the teams, the page) is the
// same everywhere. What comes in (a hook, a folder typed) goes through `fromWindows`.

export const WINDOWS: boolean = typeof process !== 'undefined' && process.platform === 'win32';

/** A path of Windows with forward slashes, and an upper case drive; the \\?\ of long paths goes. */
export const slashes = (text: string): string =>
  text
    .replace(/^\\\\\?\\(?:UNC\\)?(?=[A-Za-z]:|[^\\])/, (prefix) => (/UNC/i.test(prefix) ? '\\\\' : ''))
    .replace(/\\/g, '/')
    .replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase());

/** A path as the programs of Windows write it, for those that want it so. */
export const backslashes = (text: string): string => text.replace(/\//g, '\\');

const out = (text: string): string => (WINDOWS ? slashes(text) : text);

export const sep: string = WINDOWS ? '/' : path.sep;
export const delimiter: string = path.delimiter;
export const isAbsolute: (text: string) => boolean = path.isAbsolute;
export const extname: (text: string) => string = path.extname;
export const basename: (text: string, suffix?: string) => string = path.basename;
export const join: (...parts: string[]) => string = WINDOWS ? (...parts) => slashes(path.join(...parts)) : path.join;
export const resolve: (...parts: string[]) => string = WINDOWS ? (...parts) => slashes(path.resolve(...parts)) : path.resolve;
export const dirname: (text: string) => string = WINDOWS ? (text) => slashes(path.dirname(text)) : path.dirname;
export const relative: (from: string, to: string) => string = WINDOWS ? (from, to) => slashes(path.relative(from, to)) : path.relative;

export const homedir = (): string => out(os.homedir());
export const tmpdir = (): string => out(os.tmpdir());

/** The root of a path of Windows: "C:/", "//server/share/". */
const rootOf = (text: string): string => (/^[A-Za-z]:\//.exec(text) ?? /^\/\/[^/]+\/[^/]+(?:\/|$)/.exec(text) ?? [''])[0]!.toLowerCase();

/**
 * A path of Windows as the disk has it: the case of its names, and no 8.3 short names (RUNNER~1), so that one file has one
 * name. What is not there yet keeps the name it was given, in its real folder. A drive that stands for another place (a
 * network drive, subst) stays the drive: the other name is not the one the sessions use.
 */
export function realWindowsPath(text: string, real: (path: string) => string = realpathSync.native): string {
  const full = slashes(text);
  const rest: string[] = [];
  for (let current = full; ; ) {
    try {
      const found = slashes(real(current));
      if (rootOf(found) !== rootOf(full)) return full;
      return rest.length > 0 ? `${found.replace(/\/$/, '')}/${rest.join('/')}` : found;
    } catch {
      const cut = current.lastIndexOf('/');
      const above = current.slice(0, cut);
      if (cut <= 0 || /^[A-Za-z]:$/.test(above) || rootOf(`${above}/`) === '' || rootOf(`${above}/`) === `${above}/`.toLowerCase()) return full;
      rest.unshift(current.slice(cut + 1));
      current = above;
    }
  }
}

/**
 * A path that comes from outside (a hook, the command line, a folder typed), as Forchetta keeps it. Off Windows, as it is.
 * A path of Git Bash too (/c/Users/me is C:/Users/me).
 */
export function fromOutside(text: string): string {
  if (!WINDOWS || !text) return text;
  return realWindowsPath(path.resolve(fromGitBash(text)));
}

/** A path as Git Bash writes it (/c/Users/me, /cygdrive/c/Users/me), as Windows has it; any other one as it is. */
export const fromGitBash = (text: string): string => text.replace(/^\/(?:cygdrive\/)?([A-Za-z])(?=\/|$)/, (_all, drive: string) => `${drive.toUpperCase()}:`).replace(/^([A-Z]:)$/, '$1/');
