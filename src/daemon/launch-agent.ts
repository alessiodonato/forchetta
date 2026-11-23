import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { paths } from '../shared/paths.ts';

// The daemon kept alive by macOS (`forchetta daemon keepalive on`): a LaunchAgent that starts it at login and again
// when it stops by mistake. A daemon stopped on purpose (`forchetta daemon stop`, exit code 0) stays stopped until
// the next login, or until the app or the CLI start it. Only on a Mac: elsewhere the CLI starts the daemon when it needs it.

export const LAUNCH_AGENT_LABEL = 'dev.forchetta.daemon';

export const launchAgentFile = (home = homedir()): string => join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The property list of the LaunchAgent: node and the daemon by their full paths, the PATH of who turned it on. */
export function launchAgentPlist(node: string, env: NodeJS.ProcessEnv = process.env): string {
  const variables: Record<string, string> = { PATH: env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' };
  if (env.FORCHETTA_VAR) variables.FORCHETTA_VAR = env.FORCHETTA_VAR;
  if (env.LANG) variables.LANG = env.LANG;
  const entries = Object.entries(variables)
    .map(([name, value]) => `      <key>${xml(name)}</key>\n      <string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(node)}</string>
      <string>${xml(paths.daemonJs)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(paths.varDir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${entries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>${xml(paths.log)}</string>
  </dict>
</plist>
`;
}

const domain = (): string => `gui/${userInfo().uid}`;

function launchctl(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10_000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/** Writes the LaunchAgent and loads it: macOS starts the daemon now (no other one must be running) and at login. */
export function installLaunchAgent(node: string): { ok: true } | { ok: false; error: string } {
  if (process.platform !== 'darwin') return { ok: false, error: 'the daemon is kept alive only on a Mac, by launchd' };
  const file = launchAgentFile();
  mkdirSync(dirname(file), { recursive: true });
  // Loaded already (an older copy): unloaded first, so that the new one is read.
  if (existsSync(file)) launchctl(['bootout', `${domain()}/${LAUNCH_AGENT_LABEL}`]);
  writeFileSync(file, launchAgentPlist(node), { mode: 0o644 });
  const loaded = launchctl(['bootstrap', domain(), file]);
  return loaded.ok ? { ok: true } : { ok: false, error: `launchctl bootstrap: ${loaded.output || 'it failed'}` };
}

/** Unloads the LaunchAgent (which stops the daemon it runs) and removes its file. */
export function removeLaunchAgent(): { ok: true; was: boolean } | { ok: false; error: string } {
  const file = launchAgentFile();
  if (!existsSync(file)) return { ok: true, was: false };
  launchctl(['bootout', `${domain()}/${LAUNCH_AGENT_LABEL}`]);
  try {
    rmSync(file);
  } catch (error) {
    return { ok: false, error: `${file} not removed: ${String(error)}` };
  }
  return { ok: true, was: true };
}

/** Asks macOS to start the daemon of the LaunchAgent, when there is one; false when it cannot. */
export function kickstartLaunchAgent(): boolean {
  if (process.platform !== 'darwin') return false;
  if (!existsSync(launchAgentFile())) return false;
  return launchctl(['kickstart', `${domain()}/${LAUNCH_AGENT_LABEL}`]).ok;
}
