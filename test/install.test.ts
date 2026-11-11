import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { installedApp, needsBuild } from '../src/cli/setup.ts';
import { defaultVarDir, stablePath } from '../src/shared/paths.ts';
import { tempDir } from './helpers.ts';

// What makes an installed copy work: paths that survive `brew upgrade`, a private folder outside the copy, and an
// app built again only when it has to.

const temp = tempDir('install');
afterAll(() => temp.cleanup());

describe('stable paths', () => {
  const there = (...found: string[]) => (path: string) => found.includes(path);

  it('turns the folder of a Homebrew version into its opt path, when there is one', () => {
    expect(stablePath('/usr/local/Cellar/forchetta/0.7.0/libexec', there('/usr/local/opt/forchetta/libexec'))).toBe('/usr/local/opt/forchetta/libexec');
    expect(stablePath('/opt/homebrew/Cellar/node/24.1.0/bin/node', there('/opt/homebrew/opt/node/bin/node'))).toBe('/opt/homebrew/opt/node/bin/node');
    expect(stablePath('/usr/local/Cellar/forchetta/0.7.0', there('/usr/local/opt/forchetta'))).toBe('/usr/local/opt/forchetta');
  });

  it('leaves every other path as it is', () => {
    expect(stablePath('/usr/local/Cellar/forchetta/0.7.0/libexec', there())).toBe('/usr/local/Cellar/forchetta/0.7.0/libexec');
    expect(stablePath('/Users/dev/Desktop/Forchetta', there('/Users/dev/Desktop/Forchetta'))).toBe('/Users/dev/Desktop/Forchetta');
    expect(stablePath('/usr/local/bin/node', () => true)).toBe('/usr/local/bin/node');
  });
});

describe('the private folder', () => {
  const home = '/Users/dev';
  const checkout = '/Users/dev/Desktop/Forchetta';
  const installed = '/usr/local/opt/forchetta/libexec';
  const gitIn = (root: string) => (path: string) => path === join(root, '.git');

  it('is var/ in a git checkout, as it always was', () => {
    expect(defaultVarDir(checkout, {}, gitIn(checkout), home)).toBe('/Users/dev/Desktop/Forchetta/var');
  });

  it('is in Application Support for an installed copy', () => {
    expect(defaultVarDir(installed, {}, gitIn(checkout), home)).toBe('/Users/dev/Library/Application Support/Forchetta');
  });

  it('is FORCHETTA_VAR when set, for the simulation and the tests', () => {
    expect(defaultVarDir(checkout, { FORCHETTA_VAR: '/tmp/sim' }, gitIn(checkout), home)).toBe('/tmp/sim');
  });
});

describe('forchetta setup', () => {
  it('reads version and folder of an installed app from its Info.plist', () => {
    const app = join(temp.dir, 'Forchetta.app');
    mkdirSync(join(app, 'Contents'), { recursive: true });
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      '<dict>\n  <key>CFBundleShortVersionString</key>\n  <string>0.6.0</string>\n  <key>ForchettaRoot</key>\n  <string>/usr/local/opt/forchetta/libexec</string>\n</dict>\n',
    );
    expect(installedApp(app)).toEqual({ version: '0.6.0', root: '/usr/local/opt/forchetta/libexec' });
    expect(installedApp(join(temp.dir, 'Nessuna.app'))).toBeUndefined();
  });

  it('builds the app only when it is missing, of another version or of another folder, or when forced', () => {
    const app = { version: '0.6.0', root: '/usr/local/opt/forchetta/libexec' };
    expect(needsBuild(app, '0.6.0', '/usr/local/opt/forchetta/libexec', false)).toBe(false);
    expect(needsBuild(app, '0.6.0', '/usr/local/opt/forchetta/libexec', true)).toBe(true);
    expect(needsBuild(undefined, '0.6.0', '/usr/local/opt/forchetta/libexec', false)).toBe(true);
    expect(needsBuild(app, '0.7.0', '/usr/local/opt/forchetta/libexec', false)).toBe(true);
    expect(needsBuild(app, '0.6.0', '/Users/dev/Desktop/Forchetta', false)).toBe(true);
  });
});
