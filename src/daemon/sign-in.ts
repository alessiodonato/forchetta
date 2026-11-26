import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, homedir, join, slashes } from '../shared/fspath.ts';
import { system32 } from '../shared/windows.ts';

// Forchetta opened when you sign in to Windows (Settings → "Open Forchetta when you sign in to Windows"): the shortcut
// of the Start menu that the installer writes (forchetta.cmd open, minimized, with the icon), copied into the Startup
// folder of the user, which Windows opens at each sign-in. The copy keeps working across updates: forchetta.cmd stays
// where it is. Only on Windows: on a Mac the daemon has its LaunchAgent (launch-agent.ts).

const SHORTCUT = 'Forchetta.lnk';

/** Where Windows keeps a program of the Startup folder turned off in Settings → Apps → Startup, by its file name. */
const TURNED_OFF = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder';

const programs = (env: NodeJS.ProcessEnv): string =>
  join(env.APPDATA ? slashes(env.APPDATA) : join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');

/** The shortcut of the Start menu, written by the installer. */
export const startMenuShortcut = (env: NodeJS.ProcessEnv = process.env): string => join(programs(env), SHORTCUT);

/** Its copy in the Startup folder. */
export const signInShortcut = (env: NodeJS.ProcessEnv = process.env): string => join(programs(env), 'Startup', SHORTCUT);

export const opensAtSignIn = (env: NodeJS.ProcessEnv = process.env): boolean => existsSync(signInShortcut(env));

/** A Forchetta turned off in Settings → Apps → Startup stays off with the shortcut there: forgotten, so that the box in Forchetta decides. */
function forgetTurnedOff(env: NodeJS.ProcessEnv): void {
  spawnSync(system32('reg.exe', env), ['delete', TURNED_OFF, '/v', SHORTCUT, '/f'], { timeout: 5000, windowsHide: true, stdio: 'ignore' });
}

/** Puts the copy in the Startup folder, or takes it away. */
export function setOpensAtSignIn(on: boolean, env: NodeJS.ProcessEnv = process.env, forget: (env: NodeJS.ProcessEnv) => void = forgetTurnedOff): { ok: true } | { ok: false; error: string } {
  const target = signInShortcut(env);
  try {
    if (!on) {
      rmSync(target, { force: true });
      return { ok: true };
    }
    const source = startMenuShortcut(env);
    if (!existsSync(source)) return { ok: false, error: 'Forchetta is not in the Start menu: run the installer again, then tick this once more' };
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  } catch (error) {
    return { ok: false, error: `the Startup folder of Windows: ${error instanceof Error ? error.message : String(error)}` };
  }
  forget(env);
  return { ok: true };
}
