import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT } from '../shared/paths.ts';

// Forchetta opened when you log in (Settings → "Open Forchetta when you log in"). On a Mac, a LaunchAgent that opens
// the app of this Forchetta once at each login, with `open`. Nothing more: no KeepAlive, and it is not loaded when it
// is written, so ticking the box does not bring the window up now. From macOS 13 Login Items lists it as Forchetta
// (AssociatedBundleIdentifiers). The daemon kept alive at login is another LaunchAgent (launch-agent.ts), without the
// window.

export const OPEN_AGENT_LABEL = 'dev.forchetta.open';
const BUNDLE_ID = 'local.forchetta.app';

export const openAgentFile = (home = homedir()): string => join(home, 'Library', 'LaunchAgents', `${OPEN_AGENT_LABEL}.plist`);

/** The app of this Forchetta: the one setup builds in ~/Applications or /Applications, or build-app.sh in a clone. */
export function appOfThisForchetta(home = homedir(), root = ROOT): string | undefined {
  for (const dir of [join(home, 'Applications'), '/Applications', join(root, 'build')]) {
    const app = join(dir, 'Forchetta.app');
    const plist = join(app, 'Contents', 'Info.plist');
    if (!existsSync(plist)) continue;
    const owner = /<key>ForchettaRoot<\/key>\s*<string>([^<]*)<\/string>/.exec(readFileSync(plist, 'utf8'))?.[1];
    if (owner === root) return app;
  }
  return undefined;
}

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The property list: `open -a` with the app, once, when you log in to the desktop. */
export function openAgentPlist(app: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${OPEN_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/open</string>
      <string>-a</string>
      <string>${xml(app)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>AssociatedBundleIdentifiers</key>
    <array>
      <string>${BUNDLE_ID}</string>
    </array>
  </dict>
</plist>
`;
}

export const opensAtLogin = (home = homedir()): boolean => existsSync(openAgentFile(home));

/** Writes the LaunchAgent, or takes it away. */
export function setOpensAtLogin(on: boolean, home = homedir(), findApp: () => string | undefined = () => appOfThisForchetta(home)): { ok: true } | { ok: false; error: string } {
  const file = openAgentFile(home);
  try {
    if (!on) {
      rmSync(file, { force: true });
      return { ok: true };
    }
    const app = findApp();
    if (!app) return { ok: false, error: 'there is no app of this Forchetta to open: forchetta setup builds it' };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, openAgentPlist(app), { mode: 0o644 });
  } catch (error) {
    return { ok: false, error: `~/Library/LaunchAgents: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true };
}
