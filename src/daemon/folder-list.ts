import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, homedir, join } from '../shared/fspath.ts';
import { fromWindowsPath, PLATFORM, type Platform } from '../shared/platform.ts';
import { startFolder } from './folder-chooser.ts';

// The folders inside a folder, for the panel of the page that chooses one (ui/FolderPicker.tsx), where there is no
// panel of macOS: on Linux, and in WSL, where the page is in a browser of Windows and the folders are those of Linux.
// Names only, and only of folders: what your user can see anyway.

export interface FolderList {
  /** The folder listed: the one asked, or the nearest above it that exists. */
  path: string;
  /** The folder above; undefined at the root. */
  parent?: string;
  /** The names of the folders inside, in order; hidden ones are left out. */
  folders: string[];
  /** There were more than these. */
  more?: boolean;
  /** Not readable: why, in a line. */
  error?: string;
  /** Where else to start: your home, and in WSL the folders of Windows. */
  places: { label: string; path: string }[];
}

export const MAX_FOLDERS = 500;

/** Your home, and in WSL your home of Windows (the only user in C:\Users that is not one of the system), or drive C. */
export function placesOf(home = homedir(), platform: Platform | undefined = PLATFORM, users = '/mnt/c/Users'): FolderList['places'] {
  const places = [{ label: 'home', path: home }];
  if (platform === 'windows') return [...places, ...drives().map((drive) => ({ label: drive.slice(0, 2), path: drive }))];
  if (platform !== 'wsl') return places;
  const own = folderNames(users).names.filter((name) => !/^(public|default|default user|all users|desktop\.ini)$/i.test(name));
  if (own.length === 1) places.push({ label: 'Windows', path: join(users, own[0]!) });
  else if (existsSync(users)) places.push({ label: 'Windows', path: users });
  return places;
}

/** The drives of Windows: C:/, D:/… */
const drives = (): string[] => [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:/`).filter((drive) => existsSync(drive));

function folderNames(path: string): { names: string[]; error?: string } {
  try {
    const names = readdirSync(path, { withFileTypes: true })
      .filter((entry) => {
        // $RECYCLE.BIN and the like, at the root of a drive of Windows.
        if (entry.name.startsWith('.') || entry.name.startsWith('$')) return false;
        if (entry.isDirectory()) return true;
        if (!entry.isSymbolicLink()) return false;
        try {
          return statSync(join(path, entry.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
    return { names };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { names: [], error: code === 'EACCES' || code === 'EPERM' ? 'this folder cannot be read' : 'this folder cannot be opened' };
  }
}

export function listFolders(asked: string | undefined, home = homedir(), platform: Platform | undefined = PLATFORM, max = MAX_FOLDERS): FolderList {
  const typed = (asked ?? '').trim();
  const folder = (platform === 'wsl' ? fromWindowsPath(typed) : undefined) ?? typed;
  // startFolder never opens on the root, where the folder above leads.
  const root = folder === '/' ? '/' : platform === 'windows' ? /^[A-Za-z]:[\\/]?$/.exec(folder)?.[0] : undefined;
  const path = root ? (root === '/' ? '/' : `${root[0]!.toUpperCase()}:/`) : startFolder(folder, home);
  const { names, error } = folderNames(path);
  const parent = dirname(path);
  return {
    path,
    ...(parent !== path ? { parent } : {}),
    folders: names.slice(0, max),
    ...(names.length > max ? { more: true } : {}),
    ...(error ? { error } : {}),
    places: placesOf(home, platform),
  };
}
