import { existsSync } from 'node:fs';
import { release } from 'node:os';

// Where Forchetta runs: a Mac, Windows, or Linux, the one of WSL2 too. On Windows there is no tmux: each session has a
// host of its own (src/host/main.ts). In WSL Forchetta, tmux and Claude Code are inside WSL, and the page is in a browser
// of Windows, which reaches the daemon on localhost.

export type Platform = 'macos' | 'linux' | 'wsl' | 'windows';

/** The platform of a process; undefined where Forchetta does not run. */
export function platformOf(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, kernel: string = release()): Platform | undefined {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  if (platform !== 'linux') return undefined;
  // The kernel of WSL says so: "5.15.153.1-microsoft-standard-WSL2", "4.4.0-19041-Microsoft" for WSL1.
  return env.WSL_DISTRO_NAME || /microsoft/i.test(kernel) ? 'wsl' : 'linux';
}

export const PLATFORM: Platform | undefined = platformOf();

/**
 * A folder of Windows, as WSL shows it: /mnt/c/… Its programs are not those of Linux (a claude there is the one of
 * Windows), and it holds neither private folders nor sockets.
 */
export const onWindowsDrive = (path: string): boolean => /^\/mnt\/[a-z](?:\/|$)/i.test(path);

/**
 * A path as Windows writes it, as WSL has it: C:\Users\me\shop is /mnt/c/Users/me/shop, \\wsl.localhost\Ubuntu\home\me
 * (copied from the Explorer) is /home/me. Undefined when it is not one.
 */
export function fromWindowsPath(text: string): string | undefined {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(text);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/[\\/]+/g, '/')}`.replace(/\/+$/, '');
  const distro = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i.exec(text);
  if (distro) return (distro[1] ?? '').replace(/\\+/g, '/').replace(/\/+$/, '') || '/';
  return undefined;
}

/** A program of the system by its full path (the daemon started by an app has a short PATH): the first that exists. */
export function systemTool(name: string, exists: (path: string) => boolean = existsSync): string {
  const dirs = ['/usr/sbin', '/usr/bin', '/bin', '/sbin'];
  for (const dir of dirs) if (exists(`${dir}/${name}`)) return `${dir}/${name}`;
  return `/usr/bin/${name}`;
}

/** How to install a package on this system, for a hint: the package manager that is there. */
export function installHint(name: string, find: (program: string) => string | undefined, platform: Platform | undefined = PLATFORM): string {
  if (platform === 'macos') return `brew install ${name}`;
  if (platform === 'windows') return `winget install ${name}`;
  if (find('apt-get')) return `sudo apt install ${name}`;
  if (find('dnf')) return `sudo dnf install ${name}`;
  if (find('pacman')) return `sudo pacman -S ${name}`;
  if (find('zypper')) return `sudo zypper install ${name}`;
  if (find('brew')) return `brew install ${name}`;
  return `sudo apt install ${name}`;
}
