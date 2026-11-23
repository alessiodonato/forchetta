import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { redact } from '../src/cli/doctor.ts';
import { linuxProfile, windowsFolder } from '../src/cli/open.ts';
import { peerUid, sameUser } from '../src/daemon/peer.ts';
import { OpenCodes } from '../src/daemon/open-codes.ts';
import { Registry } from '../src/daemon/registry.ts';
import { createDaemonServer } from '../src/daemon/server.ts';
import { ensurePrivateDir, ROOT } from '../src/shared/paths.ts';
import { keepTextHere } from '../src/ui/platform.ts';
import { http, tempDir } from './helpers.ts';

// What keeps the sessions private on Linux and on Windows, where the page is in a browser and the computer may be of
// more than one person. On a Mac all this stays off (test/mac-untouched.test.ts).

const temp = tempDir('safety-off-mac');
afterAll(() => temp.cleanup());

describe('the window in a browser', () => {
  it('finds the folder of the data of Windows, also of a user with accents', () => {
    expect(windowsFolder(Buffer.from('C:\\Users\\Zoë Rossi\\AppData\\Local\r\n', 'utf16le'))).toBe('C:\\Users\\Zoë Rossi\\AppData\\Local');
    expect(windowsFolder(Buffer.from('D:\\Data\\\r\n'))).toBe('D:\\Data');
    // Not set, not a folder, or with what could end an argument: no profile, rather than one somewhere else.
    for (const text of ['%LOCALAPPDATA%', '', 'ECHO is on.', 'C:\\a"b', '\\\\server\\share']) expect(windowsFolder(Buffer.from(text))).toBeUndefined();
    expect(windowsFolder(Buffer.from([0x43, 0x3a, 0x5c, 0xff, 0xfe]))).toBeUndefined();
  });

  it('on Linux keeps its profile in the private folder; the one of snap where snap may write', () => {
    expect(linuxProfile('/usr/bin/google-chrome', () => true, '/home/dev', '/v')).toBe('/v/browser');
    expect(linuxProfile('/usr/bin/chromium', () => false, '/home/dev', '/v')).toBe('/v/browser');
    expect(linuxProfile('/usr/bin/chromium-browser', (path) => path === '/snap/bin/chromium', '/home/dev', '/v')).toBe('/home/dev/snap/chromium/common/forchetta-browser');
  });

  it('asks the browser not to translate it, nor to check its spelling', () => {
    const root = { translate: true, spellcheck: true };
    keepTextHere(root);
    expect(root).toEqual({ translate: false, spellcheck: false });
    expect(readFileSync(join(ROOT, 'src', 'ui', 'main.tsx'), 'utf8')).toMatch(/if \(!IS_MAC\) \{[^}]*keepTextHere\(document\.documentElement\);\n\}/);
  });
});

describe('the code of forchetta open', () => {
  const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const row = (local: string, remote: string, uid: number): string => `   0: ${local} ${remote} 01 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 12345 1 0000000000000000 20 4 30 10 -1\n`;
  // 47821 is BACD, 50000 is C350.
  const table = HEAD + row('0100007F:BACD', '00000000:0000', 1000) + row('0100007F:BACD', '0100007F:C350', 1000) + row('0100007F:C350', '0100007F:BACD', 1001);

  it('knows whose program is at the other end', () => {
    expect(peerUid(table, 50000, 47821)).toBe(1001);
    expect(peerUid(table, 50001, 47821)).toBeUndefined();
    expect(peerUid(HEAD + row('0000000000000000FFFF00000100007F:C350', '0000000000000000FFFF00000100007F:BACD', 7), 50000, 47821)).toBe(7);
    // From elsewhere than this computer: nobody.
    expect(peerUid(HEAD + row('0A00020F:C350', '0100007F:BACD', 1000), 50000, 47821)).toBeUndefined();
    expect(peerUid('', 50000, 47821)).toBeUndefined();
  });

  it('is only for the user of the daemon; when it cannot tell, for nobody', () => {
    const socket = { remotePort: 50000, localPort: 47821 };
    expect(sameUser(socket, 1001, () => table)).toBe(true);
    expect(sameUser(socket, 1000, () => table)).toBe(false);
    // In the table of IPv6 only.
    expect(sameUser(socket, 1001, (file) => (file.endsWith('tcp6') ? table : HEAD))).toBe(true);
    const missing = (): string => {
      throw new Error('ENOENT');
    };
    expect(sameUser(socket, 1001, missing)).toBe(false);
    expect(sameUser(socket, undefined, () => table)).toBe(false);
    expect(sameUser({}, 1001, () => table)).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('reads it from the kernel', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const accepted = new Promise<{ remotePort?: number; localPort?: number }>((resolve) => server.once('connection', resolve));
    const client = connect((server.address() as AddressInfo).port, '127.0.0.1');
    const socket = await accepted;
    expect(sameUser(socket)).toBe(true);
    expect(sameUser(socket, process.getuid!() + 1)).toBe(false);
    client.destroy();
    server.close();
  });

  it('refused to another user, stays good for its own', async () => {
    const registry = new Registry({ settleMs: 5 });
    const codes = new OpenCodes();
    const logged: string[] = [];
    let mine = false;
    let port = 0;
    const server = createDaemonServer({ registry, token: 'a'.repeat(64), port: () => port, log: (line) => logged.push(line), info: () => ({}), onShutdown: () => {}, browser: { codes, localhost: false, sameUser: () => mine } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    const body = JSON.stringify({ code: codes.create() });
    const trade = () => http(port, { method: 'POST', path: '/open', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body });
    expect((await trade()).status).toBe(403);
    expect(logged).toEqual(['open: refused, not from a program of this user']);
    mine = true;
    expect((await trade()).status).toBe(200);
    registry.dispose();
    await new Promise((resolve) => server.close(resolve));
  });

  it('is checked on Linux only: in WSL who connects is a program of the system', () => {
    expect(readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')).toContain("...(PLATFORM === 'linux' ? { sameUser } : {})");
  });
});

describe('the private folder', () => {
  const dir = (name: string): string => join(temp.dir, name);

  it('must be private for real off a Mac', () => {
    ensurePrivateDir(dir('good'), 'wsl');
    expect(lstatSync(dir('good')).mode & 0o777).toBe(0o700);
    const open = (): { mode: number; uid: number } => ({ mode: 0o40777, uid: process.getuid!() });
    expect(() => ensurePrivateDir(dir('drive'), 'wsl', open)).toThrow(/cannot be made private/);
    expect(() => ensurePrivateDir(dir('disk'), 'linux', open)).toThrow(/cannot be made private/);
    expect(() => ensurePrivateDir(dir('other'), 'linux', () => ({ mode: 0o40700, uid: process.getuid!() + 1 }))).toThrow(/of another user/);
  });

  it('is on a Mac as it was', () => {
    mkdirSync(dir('mac'));
    chmodSync(dir('mac'), 0o755);
    ensurePrivateDir(dir('mac'), 'macos', () => ({ mode: 0o40777, uid: -1 }));
    expect(lstatSync(dir('mac')).mode & 0o777).toBe(0o700);
  });
});

describe('the report of doctor', () => {
  const clean = (text: string, host = 'MARIO-PC'): string => redact(text, [], '/home/dev', 'dev', host);

  it('has no name of the user of Windows, in any way a path is written', () => {
    expect(clean('/mnt/c/Users/Mario Rossi/shop/a.ts')).toBe('/mnt/c/Users/<user>/shop/a.ts');
    expect(clean('C:\\Users\\mrossi\\AppData\\Local')).toBe('C:\\Users\\<user>\\AppData\\Local');
    expect(clean(JSON.stringify({ cwd: 'C:\\Users\\mrossi\\shop' }))).toBe('{"cwd":"C:\\\\Users\\\\<user>\\\\shop"}');
    expect(clean('c:/users/mrossi/shop')).toBe('c:/users/<user>/shop');
    expect(clean('/mnt/c/Users/mrossi is a folder of Windows')).toBe('/mnt/c/Users/<user> is a folder of Windows');
    // Known from a path, it goes from the rest too; a word that only holds it stays.
    expect(clean('/mnt/d/Users/mrossi/x, started by MRossi, mrossini')).toBe('/mnt/d/Users/<user>/x, started by <user>, mrossini');
    expect(clean('the PC is mario-pc')).toBe('the PC is <computer>');
    expect(clean('/mnt/c/Users/Public/x, a public API')).toBe('/mnt/c/Users/<user>/x, a public API');
  });

  it('is on a Mac as it was', () => {
    expect(clean('/mnt/c/Users/mrossi/shop by dev on MARIO-PC', '')).toBe('/mnt/c/Users/mrossi/shop by <user> on MARIO-PC');
  });
});
