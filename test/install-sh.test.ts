import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT } from '../src/shared/paths.ts';
import { tempDir } from './helpers.ts';

// docs/install.sh, the installer for Linux and WSL: from files of this folder in place of GitHub and nodejs.org, on a
// pretend Linux.

const temp = tempDir('install-sh');
afterAll(() => temp.cleanup());

const SCRIPT = join(ROOT, 'docs', 'install.sh');
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

let count = 0;
/** A home, programs in front of those of the system, and a release with Forchetta in it. */
function scene(options: { arch?: string; node?: string; tmux?: boolean; prebuild?: boolean; checksum?: string; system?: string } = {}) {
  const dir = join(temp.dir, `scene-${++count}`);
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const release = join(dir, 'releases', 'download', 'v9.9.9');
  const app = join(dir, 'forchetta-9.9.9');
  for (const folder of [home, bin, release, join(app, 'bin'), join(app, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64')]) mkdirSync(folder, { recursive: true });
  const program = (name: string, body: string): void => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  program('uname', `case "$1" in -m) echo ${options.arch ?? 'x86_64'} ;; *) echo ${options.system ?? 'Linux'} ;; esac`);
  if (options.tmux !== false) program('tmux', 'echo tmux 3.4');
  program('node', `echo ${options.node ?? '22'}`);
  writeFileSync(join(app, 'bin', 'forchetta'), '#!/bin/sh\necho forchetta "$@"\n', { mode: 0o755 });
  if (options.prebuild !== false) writeFileSync(join(app, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'), 'binary');
  const tar = join(release, 'forchetta-9.9.9-linux.tar.gz');
  execFileSync('tar', ['-czf', tar, '-C', dir, 'forchetta-9.9.9'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  writeFileSync(`${tar}.sha256`, `${options.checksum ?? sha(tar)}  forchetta-9.9.9-linux.tar.gz\n`);
  const run = (extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync('/bin/sh', [SCRIPT], {
      encoding: 'utf8',
      // A PATH with no tmux of this computer: only what the scene has, and the programs of the system.
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, FORCHETTA_RELEASES: `file://${join(dir, 'releases')}`, FORCHETTA_PROTO: '=file', FORCHETTA_VERSION: '9.9.9', FORCHETTA_NO_SETUP: '1', FORCHETTA_ANY_CURL: '1', ...extra },
    });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return { dir, home, bin, app, tar, release, run };
}

describe('docs/install.sh', () => {
  it('puts Forchetta in ~/.local/lib and its command in ~/.local/bin; again, it takes the place of the old one', () => {
    const { home, run } = scene();
    const first = run();
    expect(first.err).toBe('');
    expect(first).toMatchObject({ code: 0, out: expect.stringContaining('Forchetta 9.9.9, for linux-x64') });
    expect(first.out).toContain('~/.local/bin is not in your PATH yet');
    const link = join(home, '.local', 'bin', 'forchetta');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(execFileSync(link, ['hello'], { encoding: 'utf8' })).toBe('forchetta hello\n');
    writeFileSync(join(home, '.local', 'lib', 'forchetta', 'of-the-old-one'), '');
    expect(run().code).toBe(0);
    expect(existsSync(join(home, '.local', 'lib', 'forchetta', 'of-the-old-one'))).toBe(false);
    // Nothing of its own left around, and no Node.js when the one of the system will do.
    expect(readdirSync(join(home, '.local', 'lib'))).toEqual(['forchetta']);
  });

  it('downloads a Node.js of its own when there is none recent, checked against the list of nodejs.org', () => {
    const { dir, home, run } = scene({ node: '18' });
    const dist = join(dir, 'node-dist');
    mkdirSync(join(dir, 'node-v22.20.0-linux-x64', 'bin'), { recursive: true });
    mkdirSync(dist);
    writeFileSync(join(dir, 'node-v22.20.0-linux-x64', 'bin', 'node'), '#!/bin/sh\necho 22\n', { mode: 0o755 });
    const tar = join(dist, 'node-v22.20.0-linux-x64.tar.gz');
    execFileSync('tar', ['-czf', tar, '-C', dir, 'node-v22.20.0-linux-x64']);
    const list = (sum: string): void => writeFileSync(join(dist, 'SHASUMS256.txt'), `${'0'.repeat(64)}  node-v22.20.0-linux-arm64.tar.gz\n${sum}  node-v22.20.0-linux-x64.tar.gz\n${'1'.repeat(64)}  node-v22.20.0-linux-x64.tar.xz\n`);
    list('f'.repeat(64));
    const wrong = run({ FORCHETTA_NODE_DIST: `file://${dist}` });
    expect(wrong).toMatchObject({ code: 1, err: expect.stringContaining('not the one nodejs.org lists') });
    expect(existsSync(join(home, '.local', 'lib', 'forchetta'))).toBe(false);
    list(sha(tar));
    expect(run({ FORCHETTA_NODE_DIST: `file://${dist}` }).code).toBe(0);
    expect(existsSync(join(home, '.local', 'lib', 'forchetta-node', 'bin', 'node'))).toBe(true);
  });

  it('for a clone (scripts/from-source.sh) takes only the Node.js, where it is told', () => {
    const { dir, home, run } = scene({ node: '18' });
    const dist = join(dir, 'node-dist');
    mkdirSync(join(dir, 'node-v22.20.0-linux-x64', 'bin'), { recursive: true });
    mkdirSync(dist);
    writeFileSync(join(dir, 'node-v22.20.0-linux-x64', 'bin', 'node'), '#!/bin/sh\necho 22\n', { mode: 0o755 });
    const tar = join(dist, 'node-v22.20.0-linux-x64.tar.gz');
    execFileSync('tar', ['-czf', tar, '-C', dir, 'node-v22.20.0-linux-x64']);
    const only = { FORCHETTA_NODE_ONLY: '1', FORCHETTA_NODE_LIB: join(home, 'forchetta-node'), FORCHETTA_NODE_DIST: `file://${dist}`, FORCHETTA_RELEASES: 'file:///nowhere', FORCHETTA_VERSION: '' };
    writeFileSync(join(dist, 'SHASUMS256.txt'), `${'f'.repeat(64)}  node-v22.20.0-linux-x64.tar.gz\n`);
    expect(run(only)).toMatchObject({ code: 1, err: expect.stringContaining('not the one nodejs.org lists') });
    expect(existsSync(join(home, 'forchetta-node'))).toBe(false);
    writeFileSync(join(dist, 'SHASUMS256.txt'), `${sha(tar)}  node-v22.20.0-linux-x64.tar.gz\n`);
    expect(run(only)).toMatchObject({ code: 0, err: '' });
    expect(readdirSync(home)).toEqual(['forchetta-node']);
  });

  it('installs nothing that is not the release, or that does not run here', () => {
    const changed = scene({ checksum: 'f'.repeat(64) });
    expect(changed.run()).toMatchObject({ code: 1, err: expect.stringContaining('not the one of the release') });
    expect(existsSync(join(changed.home, '.local'))).toBe(false);
    const without = scene({ prebuild: false });
    expect(without.run()).toMatchObject({ code: 1, err: expect.stringContaining('no terminals for linux-x64') });
    expect(existsSync(join(without.home, '.local'))).toBe(false);
    // A release of a Mac alone, as those before Linux: its archive is not taken for this one.
    const macOnly = scene();
    renameSync(macOnly.tar, join(macOnly.release, 'forchetta-9.9.9.tar.gz'));
    expect(macOnly.run()).toMatchObject({ code: 1, err: expect.stringContaining('for Linux could not be downloaded') });
    expect(existsSync(join(macOnly.home, '.local'))).toBe(false);
    expect(scene({ arch: 'riscv64' }).run()).toMatchObject({ code: 1, err: expect.stringContaining('riscv64') });
    expect(scene().run({ FORCHETTA_VERSION: '9.9.9/../evil' })).toMatchObject({ code: 1, err: expect.stringContaining('was not found') });
  });

  it('says what to do elsewhere', () => {
    expect(scene({ system: 'Darwin' }).run()).toMatchObject({ code: 1, err: expect.stringContaining('brew install') });
    expect(scene({ system: 'MINGW64_NT-10.0' }).run()).toMatchObject({ code: 1, err: expect.stringContaining('WSL 2') });
    expect(scene().run({ HOME: '/mnt/c/Users/me' })).toMatchObject({ code: 1, err: expect.stringContaining('folder of Windows') });
  });

  it.skipIf(existsSync('/usr/bin/tmux'))('needs tmux', () => {
    expect(scene({ tmux: false }).run()).toMatchObject({ code: 1, err: expect.stringContaining('tmux is missing') });
  });
});
