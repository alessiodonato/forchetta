import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, which } from '../src/shared/config.ts';
import { installHint, systemTool } from '../src/shared/platform.ts';
import { defaultVarDir, ROOT } from '../src/shared/paths.ts';
import { isOwnOrigin } from '../src/daemon/origin.ts';
import { Registry } from '../src/daemon/registry.ts';
import { createDaemonServer } from '../src/daemon/server.ts';
import { folderOf } from '../src/daemon/spawn.ts';
import { contentSecurityPolicy } from '../src/daemon/static.ts';
import { optionalFeatures, setupChecks, type SystemInputs } from '../src/daemon/system.ts';
import { clipboardKey } from '../src/ui/layout.ts';
import { commandKey, keyText } from '../src/ui/platform.ts';
import { http, tempDir } from './helpers.ts';

// What Forchetta does on a Mac, as it was before Linux and WSL (0.12.6): nothing of theirs reaches it. And on Linux
// nothing of a Mac runs.

const temp = tempDir('mac-untouched');
afterAll(() => temp.cleanup());

describe('on a Mac', () => {
  it('the page talks only to 127.0.0.1, with the policy it had', () => {
    expect(contentSecurityPolicy(47821)).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ws://127.0.0.1:47821; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(isOwnOrigin('http://127.0.0.1:47821', 47821)).toBe(true);
    expect(isOwnOrigin('http://localhost:47821', 47821)).toBe(false);
  });

  it('there are no codes for a browser: /open and /api/open are nowhere', async () => {
    const registry = new Registry({ settleMs: 5 });
    let port = 0;
    const token = 'a'.repeat(64);
    const server = createDaemonServer({ registry, token, port: () => port, log: () => {}, info: () => ({}), onShutdown: () => {} });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    const json = { 'content-type': 'application/json' };
    expect((await http(port, { method: 'POST', path: '/open', headers: { ...json, origin: `http://127.0.0.1:${port}` }, body: '{"code":"x"}' })).status).toBe(404);
    expect((await http(port, { method: 'POST', path: '/api/open', headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    expect((await http(port, { path: '/api/health', headers: { authorization: `Bearer ${token}`, origin: `http://localhost:${port}` } })).status).toBe(403);
    registry.dispose();
    await new Promise((resolve) => server.close(resolve));
  });

  it('the daemon turns on what is of Linux and WSL only there', () => {
    const main = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8');
    expect(main).toContain("...(PLATFORM === 'macos' ? {} : { browser: { codes: openCodes, localhost: PLATFORM === 'wsl', ...(PLATFORM === 'linux' ? { sameUser } : {}) } }),");
    expect(main).toContain("PLATFORM === 'macos' ? { onChooseFolder: (folder?: string) => folderChooser.choose(folder) } : { onListFolders: (folder?: string) => listFolders(folder) }");
    expect(main.match(/localhost: PLATFORM === 'wsl'/g)).toHaveLength(3);
    // The codes of the pages that were open during an update: none on a Mac, where the app has the token.
    expect(main).toContain("if (PLATFORM !== 'macos' && existsSync(paths.handover)) {");
    expect(main).toContain("if (PLATFORM === 'macos' || updates?.info().run?.state !== 'running' || !openCodes.hand(code)) return;");
    expect(main).toContain("ptyProblem: PLATFORM === 'macos' ? undefined : ptyProblem(),");
  });

  it('the data, the folders as typed and the programs are where they were', () => {
    expect(defaultVarDir('/usr/local/opt/forchetta/libexec', {}, () => false, '/Users/dev', 'macos')).toBe('/Users/dev/Library/Application Support/Forchetta');
    expect(folderOf('C:\\Users\\me', 'macos')).toBeUndefined();
    expect(installHint('tmux', () => '/usr/bin/apt-get', 'macos')).toBe('brew install tmux');
    // A folder called /mnt/c on a Mac is a folder like any other.
    const bin = join(temp.dir, 'mnt');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'tool-of-a-mac'), '#!/bin/sh\n', { mode: 0o755 });
    expect(which('tool-of-a-mac', { PATH: bin }, 'macos')).toBe(join(bin, 'tool-of-a-mac'));
    const mac = (path: string): boolean => ['/usr/sbin/lsof', '/bin/ps', '/usr/bin/pgrep'].includes(path);
    expect([systemTool('lsof', mac), systemTool('ps', mac), systemTool('pgrep', mac)]).toEqual(['/usr/sbin/lsof', '/bin/ps', '/usr/bin/pgrep']);
  });

  it('the checklist and the features are those it had', () => {
    const inputs: SystemInputs = { config: loadConfig(join(temp.dir, 'none.json')), notesSupported: false, haikuOn: false, socket: true, hookSeen: false, sessions: 0, settingsText: '{}' };
    expect(setupChecks(inputs, 'macos').map((check) => check.id)).toEqual(['hooks', 'statusline', 'tmux', 'claude', 'socket', 'events']);
    expect(setupChecks(inputs, 'macos').find((check) => check.id === 'tmux')?.fix).toBe('brew install tmux');
    expect(optionalFeatures(inputs, 'macos').map((feature) => feature.id)).toEqual(['arricurdai', 'notes', 'haiku', 'keepalive']);
  });

  it('the keys and the texts of the page are those of a Mac', () => {
    for (const text of ['⌘N', '⇧⌘N', 'Settings (⌘,) · Commands (⌘K)', '⌘↩ starts it.']) expect(keyText(text, true)).toBe(text);
    expect(commandKey({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    for (const key of ['v', 'c']) expect(clipboardKey({ type: 'keydown', key, shiftKey: false, altKey: false, ctrlKey: true, metaKey: false }, true, true)).toBeUndefined();
  });

  it('the scripts take no Node.js of their own, and the archive of a release is the one of a Mac', () => {
    expect(readFileSync(join(ROOT, 'bin', 'forchetta'), 'utf8')).toContain('[ ! -d /System/Library/CoreServices ] && [ -x "$root/../forchetta-node/bin/node" ]');
    const release = readFileSync(join(ROOT, 'scripts', 'package-release.sh'), 'utf8');
    expect(release).toContain('cp -R "$PTY/prebuilds/darwin-arm64" "$PTY/prebuilds/darwin-x64"');
    expect(release).not.toMatch(/linux/i);
  });
});

describe('what tmux copies', () => {
  const command = /^set -s copy-command '(.*)'$/m.exec(readFileSync(join(ROOT, 'config', 'tmux.conf'), 'utf8'))![1]!;
  const awk = which('awk');

  /** Runs the copy command with only these programs around it, and awk, which cleans the text first; which one took the text, and the text. */
  function copy(programs: string[], env: NodeJS.ProcessEnv = {}): string | undefined {
    const dir = mkdtempSync(join(tmpdir(), 'forchetta-copy-'));
    try {
      symlinkSync(awk!, join(dir, 'awk'));
      for (const name of programs) {
        writeFileSync(join(dir, name), `#!/bin/sh\n{ printf '%s:' ${name}; /bin/cat; } > '${dir}/out'\n`);
        chmodSync(join(dir, name), 0o755);
      }
      execFileSync('/bin/sh', ['-c', command], { input: 'ciao è', env: { PATH: dir, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
      return readFileSync(join(dir, 'out'), 'utf8');
    } catch {
      return undefined;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('goes to pbcopy on a Mac, whatever else is there', () => {
    expect(copy(['pbcopy'])).toBe('pbcopy:ciao è');
    expect(copy(['pbcopy', 'wl-copy', 'xclip'], { WAYLAND_DISPLAY: 'wayland-0' })).toBe('pbcopy:ciao è');
  });

  it('goes to Wayland or X on Linux, and nowhere without them', () => {
    expect(copy(['wl-copy', 'xclip'], { WAYLAND_DISPLAY: 'wayland-0' })).toBe('wl-copy:ciao è');
    expect(copy(['wl-copy', 'xclip'])).toBe('xclip:ciao è');
    expect(copy([])).toBeUndefined();
  });
});

describe('on Linux', () => {
  it('nothing of a Mac runs: no launchd, no osascript, no Swift', () => {
    const read = (file: string): string => readFileSync(join(ROOT, 'src', ...file.split('/')), 'utf8');
    const agent = read('daemon/launch-agent.ts');
    expect(agent).toMatch(/export function installLaunchAgent\([^]*?\{\n  if \(process\.platform !== 'darwin'\) return/);
    expect(agent).toMatch(/export function kickstartLaunchAgent\(\): boolean \{\n  if \(process\.platform !== 'darwin'\) return false/);
    // The setup of Linux returns before the compiler and the app.
    const setup = read('cli/setup.ts');
    expect(setup.indexOf("if (PLATFORM !== 'macos') {")).toBeLessThan(setup.indexOf('const swiftc = swiftCompiler();'));
    const linux = readFileSync(join(ROOT, 'scripts', 'package-linux.sh'), 'utf8');
    expect(linux).not.toMatch(/native|darwin|build-app/);
  });

  it.skipIf(process.platform === 'darwin')('the private folder and the machine are those of Linux', () => {
    expect(defaultVarDir('/home/me/.local/lib/forchetta', {}, () => false, '/home/me')).toBe('/home/me/.local/share/forchetta');
  });
});
