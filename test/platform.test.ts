import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { macApp, openerOf, pageUrl } from '../src/cli/open.ts';
import { type LinuxFacts, linuxSteps, tmuxVersionOf } from '../src/cli/setup-linux.ts';
import { listFolders, placesOf } from '../src/daemon/folder-list.ts';
import { OPEN_CODE_MS, OpenCodes } from '../src/daemon/open-codes.ts';
import { ptyProblem } from '../src/daemon/pty.ts';
import { folderOf } from '../src/daemon/spawn.ts';
import { optionalFeatures, setupChecks, type SystemInputs } from '../src/daemon/system.ts';
import { DEFAULT_CONFIG, which } from '../src/shared/config.ts';
import { fromWindowsPath, installHint, onWindowsDrive, platformOf, systemTool } from '../src/shared/platform.ts';
import { tempDir } from './helpers.ts';

// Forchetta out of a Mac: on Linux, and on Windows inside WSL2.

const temp = tempDir('platform');
afterAll(() => temp.cleanup());

describe('where Forchetta runs', () => {
  it('a Mac, Linux, or the Linux of WSL; not Windows itself', () => {
    expect(platformOf('darwin', {}, '21.6.0')).toBe('macos');
    expect(platformOf('linux', {}, '6.8.0-45-generic')).toBe('linux');
    expect(platformOf('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, '6.8.0')).toBe('wsl');
    expect(platformOf('linux', {}, '5.15.153.1-microsoft-standard-WSL2')).toBe('wsl');
    expect(platformOf('win32', {}, '10.0.22631')).toBeUndefined();
  });

  it('knows the folders of Windows, and the paths as Windows writes them', () => {
    expect(onWindowsDrive('/mnt/c/Users/me')).toBe(true);
    expect(onWindowsDrive('/mnt/c')).toBe(true);
    expect(onWindowsDrive('/mnt/data/code')).toBe(false);
    expect(onWindowsDrive('/home/me')).toBe(false);
    expect(fromWindowsPath('C:\\Users\\me\\shop')).toBe('/mnt/c/Users/me/shop');
    expect(fromWindowsPath('d:/code/shop/')).toBe('/mnt/d/code/shop');
    expect(fromWindowsPath('C:\\')).toBe('/mnt/c');
    expect(fromWindowsPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\shop')).toBe('/home/me/shop');
    expect(fromWindowsPath('\\\\wsl$\\Ubuntu-24.04\\home\\me')).toBe('/home/me');
    expect(fromWindowsPath('\\\\wsl.localhost\\Ubuntu')).toBe('/');
    expect(fromWindowsPath('/home/me')).toBeUndefined();
    expect(fromWindowsPath('shop')).toBeUndefined();
    expect(folderOf('C:\\Users\\me\\shop', 'wsl')).toBe('/mnt/c/Users/me/shop');
    expect(folderOf('C:\\Users\\me\\shop', 'linux')).toBeUndefined();
    expect(folderOf('/home/me/shop', 'wsl')).toBe('/home/me/shop');
  });

  it('a program of Windows is not one of WSL', () => {
    const own = join(temp.dir, 'bin');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'some-tool-of-linux'), '#!/bin/sh\n', { mode: 0o755 });
    expect(which('some-tool-of-linux', { PATH: `/mnt/c/Windows:${own}` }, 'wsl')).toBe(join(own, 'some-tool-of-linux'));
  });

  it('finds the programs of the system where each has them', () => {
    expect(systemTool('lsof', (path) => path === '/usr/sbin/lsof')).toBe('/usr/sbin/lsof');
    expect(systemTool('lsof', (path) => path === '/usr/bin/lsof')).toBe('/usr/bin/lsof');
    expect(systemTool('lsof', () => false)).toBe('/usr/bin/lsof');
  });

  it('says how to install a package with the manager that is there', () => {
    const only = (name: string) => (program: string) => (program === name ? `/usr/bin/${name}` : undefined);
    expect(installHint('tmux', only('apt-get'), 'wsl')).toBe('sudo apt install tmux');
    expect(installHint('tmux', only('dnf'), 'linux')).toBe('sudo dnf install tmux');
    expect(installHint('tmux', only('pacman'), 'linux')).toBe('sudo pacman -S tmux');
    expect(installHint('tmux', only('apt-get'), 'macos')).toBe('brew install tmux');
  });
});

describe('forchetta setup on Linux', () => {
  const facts = (extra: Partial<LinuxFacts> = {}): LinuxFacts => ({
    platform: 'wsl',
    node: '22.20.0',
    kernel: '5.15.153.1-microsoft-standard-WSL2',
    root: '/home/me/.local/lib/forchetta',
    varDir: '/home/me/.local/share/forchetta',
    tmux: '/usr/bin/tmux',
    tmuxVersion: 'tmux 3.4',
    curl: true,
    claude: '/home/me/.local/bin/claude',
    lsof: true,
    clone: false,
    ...extra,
  });
  const install = (name: string): string => `sudo apt install ${name}`;

  it('is all there', () => {
    const result = linuxSteps(facts(), install);
    expect('error' in result).toBe(false);
    expect(result.steps.map((step) => `${step.mark} ${step.label}`)).toEqual(['✓ WSL', '✓ Node.js', '✓ tmux', '✓ Terminals', '✓ claude']);
    expect(linuxSteps(facts({ platform: 'linux' }), install).steps[0]!.label).toBe('Node.js');
  });

  it('stops for what it cannot do without, and says what to do', () => {
    expect(linuxSteps(facts({ root: '/mnt/c/Users/me/Forchetta' }), install)).toMatchObject({ error: expect.stringContaining('folder of Windows') });
    expect(linuxSteps(facts({ node: '18.19.1' }), install)).toMatchObject({ error: expect.stringContaining('22 or later') });
    expect(linuxSteps(facts({ tmux: undefined }), install)).toMatchObject({ error: 'tmux is missing', hint: expect.stringContaining('sudo apt install tmux') });
    expect(linuxSteps(facts({ tmuxVersion: 'tmux 3.0a' }), install)).toMatchObject({ error: expect.stringContaining('3.0 is too old') });
    expect(linuxSteps(facts({ curl: false }), install)).toMatchObject({ error: expect.stringContaining('curl') });
    expect(linuxSteps(facts({ pty: 'Failed to load native module' }), install)).toMatchObject({ error: expect.stringContaining('Failed to load') });
    expect(linuxSteps(facts({ pty: 'no', clone: true }), install)).toMatchObject({ hint: expect.stringContaining('pnpm rebuild node-pty') });
  });

  it('warns of the Claude Code of Windows, of WSL 1 and of a missing lsof', () => {
    const warned = (extra: Partial<LinuxFacts>): string[] => linuxSteps(facts(extra), install).steps.filter((step) => step.mark === '▲').map((step) => step.label);
    expect(warned({ claude: undefined, windowsClaude: '/mnt/c/Users/me/AppData/Roaming/npm/claude' })).toEqual(['claude']);
    expect(warned({ claude: undefined })).toEqual(['claude']);
    expect(warned({ kernel: '4.4.0-19041-Microsoft' })).toEqual(['WSL']);
    expect(warned({ lsof: false })).toEqual(['lsof']);
  });

  it('reads the version of tmux', () => {
    expect(tmuxVersionOf('tmux 3.4')).toBe('3.4');
    expect(tmuxVersionOf('tmux 3.3a')).toBe('3.3');
    expect(tmuxVersionOf('tmux next-3.5')).toBe('3.5');
    expect(tmuxVersionOf(undefined)).toBeUndefined();
  });

  it('says why the terminals cannot open, in a line', () => {
    expect(ptyProblem(() => ({}))).toBeUndefined();
    expect(
      ptyProblem(() => {
        throw new Error('Failed to load native module: pty.node\nmore');
      }),
    ).toBe('Failed to load native module: pty.node');
  });

  it('the checklist has the terminals only when they cannot open, and keepalive only on a Mac', () => {
    const inputs: SystemInputs = { config: DEFAULT_CONFIG, notesSupported: false, haikuOn: false, socket: true, hookSeen: false, sessions: 0, settingsText: '{}' };
    expect(setupChecks(inputs, 'linux').some((check) => check.id === 'terminals')).toBe(false);
    expect(setupChecks({ ...inputs, ptyProblem: 'no binary' }, 'linux').find((check) => check.id === 'terminals')).toMatchObject({ ok: false, detail: expect.stringContaining('no binary') });
    expect(optionalFeatures(inputs, 'wsl').some((feature) => feature.id === 'keepalive')).toBe(false);
    expect(optionalFeatures(inputs, 'macos').some((feature) => feature.id === 'keepalive')).toBe(true);
  });
});

describe('forchetta open', () => {
  it('a code is good once, for two minutes', () => {
    let now = 1000;
    const codes = new OpenCodes(() => now);
    const code = codes.create();
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    expect(codes.redeem('0'.repeat(32))).toBe(false);
    expect(codes.redeem(undefined)).toBe(false);
    expect(codes.redeem(code)).toBe(true);
    expect(codes.redeem(code)).toBe(false);
    const late = codes.create();
    now += OPEN_CODE_MS;
    expect(codes.redeem(late)).toBe(false);
    const first = codes.create();
    for (let n = 0; n < 16; n++) codes.create();
    expect(codes.redeem(first)).toBe(false);
  });

  it('the address is at localhost in WSL, which Windows forwards', () => {
    expect(pageUrl(47821, 'ab', 'wsl')).toBe('http://localhost:47821/#open=ab');
    expect(pageUrl(47821, 'ab', 'linux')).toBe('http://127.0.0.1:47821/#open=ab');
  });

  it('in WSL opens a browser of Windows as a window of its own, else the default one', () => {
    const none = (): undefined => undefined;
    const edge = '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    const profile = (): string => 'P';
    const flags = ['--user-data-dir=P', '--disable-extensions', '--no-first-run', '--no-default-browser-check'];
    expect(openerOf('U', 'wsl', (path) => path === edge, none, profile)).toEqual({ file: edge, args: ['--app=U', ...flags], own: true });
    // Without a folder for the profile it still opens, and says it is not its own.
    expect(openerOf('U', 'wsl', (path) => path === edge, none, none)).toEqual({ file: edge, args: ['--app=U'], own: false });
    expect(openerOf('U', 'wsl', () => false, (name) => (name === 'wslview' ? '/usr/bin/wslview' : undefined), profile)).toEqual({ file: '/usr/bin/wslview', args: ['U'], own: false });
    expect(openerOf('U', 'wsl', (path) => path.endsWith('rundll32.exe'), none, profile)).toEqual({ file: '/mnt/c/Windows/System32/rundll32.exe', args: ['url.dll,FileProtocolHandler', 'U'], own: false });
    expect(openerOf('U', 'linux', () => false, (name) => (name === 'google-chrome' ? '/usr/bin/google-chrome' : undefined), profile)).toEqual({ file: '/usr/bin/google-chrome', args: ['--app=U', ...flags], own: true });
    expect(openerOf('U', 'linux', () => false, (name) => (name === 'xdg-open' ? '/usr/bin/xdg-open' : undefined), profile)).toEqual({ file: '/usr/bin/xdg-open', args: ['U'], own: false });
    expect(openerOf('U', 'linux', () => false, none, profile)).toBeUndefined();
    // A browser of Linux inside WSL has its profile among the files of Linux, not of Windows.
    const inside = openerOf('U', 'wsl', () => false, (name) => (name === 'google-chrome' ? '/usr/bin/google-chrome' : undefined), () => 'C:\\P');
    expect(inside?.args[1]).toMatch(/^--user-data-dir=\/.*\/browser$/);
  });

  it('on a Mac opens the app, when it is there', () => {
    expect(macApp((path) => path === '/Users/dev/Applications/Forchetta.app', '/Users/dev', '/F')).toBe('/Users/dev/Applications/Forchetta.app');
    expect(macApp((path) => path === '/F/build/Forchetta.app', '/Users/dev', '/F')).toBe('/F/build/Forchetta.app');
    expect(macApp(() => false, '/Users/dev', '/F')).toBeUndefined();
  });
});

describe('the folders inside a folder', () => {
  it('names only, only of folders, without the hidden ones; the nearest above one that is not there', () => {
    const home = join(temp.dir, 'home');
    mkdirSync(join(home, 'projects', 'shop 10'), { recursive: true });
    mkdirSync(join(home, 'projects', 'shop 2'));
    mkdirSync(join(home, 'projects', '.git'));
    writeFileSync(join(home, 'projects', 'notes.txt'), 'x');
    symlinkSync(join(home, 'projects', 'shop 2'), join(home, 'projects', 'link'));
    symlinkSync(join(home, 'nowhere'), join(home, 'projects', 'broken'));
    const list = listFolders(join(home, 'projects'), home, 'linux');
    expect(list).toMatchObject({ path: join(home, 'projects'), parent: home, folders: ['link', 'shop 2', 'shop 10'] });
    expect(list.places).toEqual([{ label: 'home', path: home }]);
    expect(listFolders('~/projects/not-yet', home, 'linux').path).toBe(join(home, 'projects'));
    expect(listFolders('', home, 'linux').path).toBe(home);
    expect(listFolders(join(home, 'projects'), home, 'linux', 1)).toMatchObject({ folders: ['link'], more: true });
    expect(listFolders('/', home, 'linux').parent).toBeUndefined();
  });

  it('in WSL starts from Windows too: your own folder there, when it is clear which', () => {
    const users = join(temp.dir, 'Users');
    for (const name of ['Public', 'Default', 'me']) mkdirSync(join(users, name), { recursive: true });
    expect(placesOf('/home/me', 'wsl', users)).toEqual([{ label: 'home', path: '/home/me' }, { label: 'Windows', path: join(users, 'me') }]);
    mkdirSync(join(users, 'other'));
    expect(placesOf('/home/me', 'wsl', users)[1]).toEqual({ label: 'Windows', path: users });
    expect(placesOf('/home/me', 'wsl', join(temp.dir, 'none'))).toHaveLength(1);
  });
});
