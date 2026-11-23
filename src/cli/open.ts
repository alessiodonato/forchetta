import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveTool, which } from '../shared/config.ts';
import { api, ensureDaemon } from '../shared/daemon-client.ts';
import { UserError } from '../shared/errors.ts';
import { paths, ROOT } from '../shared/paths.ts';
import { PLATFORM, type Platform } from '../shared/platform.ts';
import { code } from './help.ts';
import type { RunIO } from './run.ts';
import { tildify } from './style.ts';

// `forchetta open`: the window of Forchetta. On a Mac the app; on Linux, and in WSL, the page in a browser, which gets the token of the daemon for a code good once (daemon/open-codes.ts). In WSL the browser is
// one of Windows: Edge or Chrome as a window of its own (--app), where the shortcuts are not those of the browser;
// else the default one. It reaches the daemon on localhost, which WSL2 forwards.

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

/** The program that opens the page and its arguments; undefined when none is found. */
export function openerOf(
  url: string,
  platform: Platform | undefined = PLATFORM,
  exists: (path: string) => boolean = existsSync,
  find: (name: string) => string | undefined = (name) => which(name),
): { file: string; args: string[] } | undefined {
  if (platform === 'wsl') {
    const browser = WINDOWS_BROWSERS.find(exists);
    if (browser) return { file: browser, args: [`--app=${url}`] };
    const wslview = find('wslview');
    if (wslview) return { file: wslview, args: [url] };
    // The default browser of Windows; no shell reads the address on the way.
    const rundll = '/mnt/c/Windows/System32/rundll32.exe';
    if (exists(rundll)) return { file: rundll, args: ['url.dll,FileProtocolHandler', url] };
  }
  const own = LINUX_BROWSERS.map(find).find((path) => path !== undefined);
  if (own) return { file: own, args: [`--app=${url}`] };
  const opener = find('xdg-open');
  return opener ? { file: opener, args: [url] } : undefined;
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
      ? `${s.mark('✓', 'green', `Forchetta opens in the browser ${s.dim(`· port ${info.port}`)}`)}\n  ${code('If no window appears: `forchetta open --print` gives the address to open by hand.', s)}\n`
      : `${s.mark('▲', 'amber', 'No browser found from here. Open this address (good once, for two minutes):')}\n\n    ${url}\n`,
  );
  return 0;
}
