import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// The panel of macOS for a folder, when the page runs in a browser: the app has its own (native/main.swift). The
// daemon is on the same Mac as the page, so the panel opens in front of you, from osascript. One at a time.

/** Runs osascript with a script and its arguments: what it printed, or undefined when it failed. */
export type Osascript = (lines: readonly string[], args: readonly string[]) => Promise<string | undefined>;

export const osascript: Osascript = (lines, args) =>
  new Promise((resolve) => {
    execFile('osascript', [...lines.flatMap((line) => ['-e', line]), ...args], { timeout: 15 * 60_000 }, (error, stdout) => resolve(error ? undefined : stdout));
  });

const SCRIPT = [
  'on run argv',
  'activate',
  'try',
  'set chosen to choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))',
  'on error number -128',
  'return ""',
  'end try',
  'return POSIX path of chosen',
  'end run',
];

/** The folder the panel opens on: the one written, if it exists, or the nearest folder above it; else your home. */
export function startFolder(folder: string | undefined, home = homedir()): string {
  let path = (folder ?? '').trim();
  if (path === '~' || path.startsWith('~/')) path = join(home, path.slice(1));
  if (!path.startsWith('/')) return home;
  for (let at = path; at !== dirname(at); at = dirname(at)) {
    try {
      if (existsSync(at) && statSync(at).isDirectory()) return at;
    } catch {
      // Not readable: one level up.
    }
  }
  return home;
}

export class FolderChooser {
  private open = false;

  constructor(private readonly run: Osascript = osascript) {}

  /** The folder you chose; undefined if you cancelled, or a panel is open already. */
  async choose(folder?: string, prompt = 'The folder for Forchetta'): Promise<string | undefined> {
    if (this.open) return undefined;
    this.open = true;
    try {
      const out = (await this.run(SCRIPT, [prompt, startFolder(folder)]))?.trim();
      if (!out) return undefined;
      return out.length > 1 ? out.replace(/\/+$/, '') : out;
    } finally {
      this.open = false;
    }
  }
}
