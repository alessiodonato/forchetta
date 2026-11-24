import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { backslashes, homedir, join, slashes } from '../shared/fspath.ts';
import { loadConfig, resolveTool, which } from '../shared/config.ts';
import { api, ensureDaemon } from '../shared/daemon-client.ts';
import { UserError } from '../shared/errors.ts';
import { paths, ROOT } from '../shared/paths.ts';
import { PLATFORM, type Platform } from '../shared/platform.ts';
import { system32 } from '../shared/windows.ts';
import { code } from './help.ts';
import type { RunIO } from './run.ts';
import { tildify } from './style.ts';

// `forchetta open`: the window of Forchetta. On a Mac the app; on Windows, on Linux and in WSL, the page in a browser, which
// gets the token of the daemon for a code good once (daemon/open-codes.ts). On Windows and in WSL the browser is
// one of Windows: Edge or Chrome as a window of its own (--app), where the shortcuts are not those of the browser;
// else the default one. It reaches the daemon on localhost, which WSL2 forwards.
//
// The window has a profile of its own, with no extensions: in the profile of every day, one that may read every site
// would read the terminals, and could type in them. On a Mac the app has none.

export interface OpenOptions {
  /** Only print the address (not on a Mac, where the app has no need of one). */
  print: boolean;
}

/** The address of the page with a code: localhost in WSL, which is what Windows forwards. */
export const pageUrl = (port: number, openCode: string, platform: Platform | undefined = PLATFORM): string =>
  `http://${platform === 'wsl' ? 'localhost' : '127.0.0.1'}:${port}/#open=${openCode}`;

/** The app on a Mac, where setup puts it, or the one of a clone; undefined when there is none. */
export function macApp(exists: (path: string) => boolean = existsSync, home = homedir(), root = ROOT): string | undefined {
  return [join(home, 'Applications', 'Forchetta.app'), '/Applications/Forchetta.app', join(root, 'build', 'Forchetta.app')].find(exists);
}

/** The browsers of Windows that open a page as a window of its own, where they usually are. */
const WINDOWS_BROWSERS = [
  '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
];
/** Those of Linux, by name. */
const LINUX_BROWSERS = ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser', 'brave-browser'];

/** The same on Windows itself: in its program folders, for everyone or for this user. */
export function windowsBrowsers(env: NodeJS.ProcessEnv = process.env): string[] {
  const folders = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((dir): dir is string => Boolean(dir)).map(slashes);
  return ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe', 'BraveSoftware/Brave-Browser/Application/brave.exe'].flatMap((program) => folders.map((folder) => join(folder, program)));
}

const CMD = '/mnt/c/Windows/System32/cmd.exe';

/** A folder as a program of Windows printed it (cmd /u: UTF-16); undefined when it is not one. */
export function windowsFolder(output: Buffer): string | undefined {
  const text = (output.includes(0) ? output.toString('utf16le') : output.toString('utf8')).replace(/^\uFEFF/, '').trim();
  return /^[A-Za-z]:\\[^"%\r\n\uFFFD]+$/.test(text) ? text.replace(/\\+$/, '') : undefined;
}

/** The profile of the window among the data of this user of Windows: C:\Users\me\AppData\Local\Forchetta\browser. */
function windowsProfile(): string | undefined {
  if (!existsSync(CMD)) return undefined;
  const shown = spawnSync(CMD, ['/d', '/u', '/c', 'echo', '%LOCALAPPDATA%'], { cwd: '/mnt/c/Windows', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  const data = shown.status === 0 ? windowsFolder(shown.stdout) : undefined;
  return data ? `${data}\\Forchetta\\browser` : undefined;
}

/** On Linux, in the private folder of Forchetta; a browser of snap sees only its own folders. */
export function linuxProfile(browser: string, exists: (path: string) => boolean = existsSync, home = homedir(), varDir = paths.varDir): string {
  const snap = /\/chromium(?:-browser)?$/.test(browser) && exists('/snap/bin/chromium');
  return snap ? join(home, 'snap', 'chromium', 'common', 'forchetta-browser') : join(varDir, 'browser');
}

/** A window of its own; with a profile of its own, also without extensions and without the first-run pages. */
const ownWindow = (url: string, profile: string | undefined): string[] => [
  `--app=${url}`,
  ...(profile ? [`--user-data-dir=${profile}`, '--disable-extensions', '--no-first-run', '--no-default-browser-check'] : []),
];

export interface Opener {
  file: string;
  args: string[];
  /** The profile is that of Forchetta; false: the one of every day, with its extensions. */
  own: boolean;
}

/** The program that opens the page and its arguments; undefined when none is found. */
export function openerOf(
  url: string,
  platform: Platform | undefined = PLATFORM,
  exists: (path: string) => boolean = existsSync,
  find: (name: string) => string | undefined = (name) => which(name),
  profileOf: (browser: string) => string | undefined = (browser) => (platform === 'wsl' ? windowsProfile() : platform === 'windows' ? backslashes(join(paths.varDir, 'browser')) : linuxProfile(browser)),
): Opener | undefined {
  if (platform === 'windows') {
    const browser = windowsBrowsers().find(exists);
    if (browser) return { file: browser, args: ownWindow(url, profileOf(browser)), own: true };
    return { file: system32('rundll32.exe'), args: ['url.dll,FileProtocolHandler', url], own: false };
  }
  if (platform === 'wsl') {
    const browser = WINDOWS_BROWSERS.find(exists);
    if (browser) {
      const profile = profileOf(browser);
      return { file: browser, args: ownWindow(url, profile), own: profile !== undefined };
    }
    const wslview = find('wslview');
    if (wslview) return { file: wslview, args: [url], own: false };
    // The default browser of Windows; no shell reads the address on the way.
    const rundll = '/mnt/c/Windows/System32/rundll32.exe';
    if (exists(rundll)) return { file: rundll, args: ['url.dll,FileProtocolHandler', url], own: false };
  }
  const browser = LINUX_BROWSERS.map(find).find((path) => path !== undefined);
  if (browser) {
    // A browser of Linux, inside WSL too: its profile is among the files of Linux.
    const profile = platform === 'wsl' ? linuxProfile(browser, exists) : profileOf(browser);
    return { file: browser, args: ownWindow(url, profile), own: profile !== undefined };
  }
  const opener = find('xdg-open');
  return opener ? { file: opener, args: [url], own: false } : undefined;
}

/** Starts the program apart from this terminal; false when it cannot start. */
function start(file: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    // In WSL a program of Windows wants a folder of Windows to start from.
    const child = spawn(file, [...args], { detached: true, stdio: 'ignore', cwd: file.startsWith('/mnt/') ? '/mnt/c' : homedir() });
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function openCommand(options: OpenOptions, io: RunIO): Promise<number> {
  const s = io.style;
  if (PLATFORM === 'macos') {
    if (options.print) throw new UserError('--print is for Linux and WSL, where the page opens in a browser', 'on a Mac `forchetta open` opens the app');
    const app = macApp();
    if (!app) throw new UserError('the app is not there', 'build it with `forchetta setup`');
    if (!(await start('/usr/bin/open', [app]))) throw new UserError(`${tildify(app)} did not open`);
    io.stdout(`${s.mark('✓', 'green', `Forchetta opens ${s.dim(`· ${tildify(app)}`)}`)}\n`);
    return 0;
  }
  const info = await ensureDaemon(resolveTool('node', loadConfig()));
  if (!info) throw new UserError('the daemon did not start', `see its log: ${tildify(paths.log)}`);
  let openCode: string;
  try {
    openCode = (await api<{ code: string }>(info, 'POST', '/api/open')).code;
  } catch {
    throw new UserError('this daemon cannot open the page in a browser: it is of an older version', 'restart it: `forchetta daemon stop && forchetta daemon start`');
  }
  const url = pageUrl(info.port, openCode);
  if (options.print) {
    io.stdout(`${url}\n`);
    return 0;
  }
  const opener = openerOf(url);
  const opened = opener ? await start(opener.file, opener.args) : false;
  io.stdout(
    opened
      ? `${s.mark('✓', 'green', `Forchetta opens ${opener?.own && PLATFORM === 'windows' ? 'in a window of its own' : 'in the browser'} ${s.dim(`· port ${info.port}`)}`)}\n${opener?.own ? '' : `${s.mark('▲', 'amber', 'It is your usual browser: its extensions can read the page and type in it. With Edge or Chrome it is a window of its own, without them.')}\n`}  ${code('If no window appears: `forchetta open --print` gives the address to open by hand.', s)}\n`
      : `${s.mark('▲', 'amber', 'No browser found from here. Open this address (good once, for two minutes):')}\n\n    ${url}\n`,
  );
  return 0;
}
