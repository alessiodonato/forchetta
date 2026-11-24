import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  const run = (extra: NodeJS.ProcessEnv = {}, script = SCRIPT) => {
    const result = spawnSync('/bin/sh', [script], {
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

  /** The copy of the installer that a release has. */
  const pinned = (dir: string, version: string, sum: string): string => {
    const text = readFileSync(SCRIPT, 'utf8').replace(/^PINNED_VERSION=$/m, `PINNED_VERSION=${version}`).replace(/^PINNED_SHA256=$/m, `PINNED_SHA256=${sum}`);
    expect(text).toContain(`\nPINNED_VERSION=${version}\nPINNED_SHA256=${sum}\n`);
    const file = join(dir, 'install.sh');
    writeFileSync(file, text);
    return file;
  };

  it('of a release installs its version, and no other archive, whatever the checksum next to it says', () => {
    const good = scene();
    expect(good.run({ FORCHETTA_VERSION: '' }, pinned(good.dir, '9.9.9', sha(good.tar)))).toMatchObject({ code: 0, err: '' });
    // Another archive in its place, with its own checksum.
    const changed = scene();
    const bad = changed.run({ FORCHETTA_VERSION: '' }, pinned(changed.dir, '9.9.9', sha(good.tar).replace(/^./, 'x')));
    expect(bad).toMatchObject({ code: 1, err: expect.stringContaining('not the one of the release') });
    expect(existsSync(join(changed.home, '.local'))).toBe(false);
    // Asked for another version, the one it knows is not of use: the checksum of that one is.
    const other = scene();
    expect(other.run({ FORCHETTA_VERSION: '9.9.9' }, pinned(other.dir, '8.0.0', 'f'.repeat(64))).code).toBe(0);
  });

  it('takes a beta, and no other kind of version', () => {
    const beta = scene();
    mkdirSync(join(beta.dir, 'releases', 'download', 'v9.9.9-beta.1'));
    for (const end of ['', '.sha256']) renameSync(`${beta.tar}${end}`, join(beta.dir, 'releases', 'download', 'v9.9.9-beta.1', `forchetta-9.9.9-beta.1-linux.tar.gz${end}`));
    expect(beta.run({ FORCHETTA_VERSION: '9.9.9-beta.1' }).code).toBe(0);
    for (const version of ['9.9.9/../evil', '../9', '9..9', 'beta', '-rf', '9.9.9 x', '9.9.9\nx', '9.9.9-Beta', '$(id)']) {
      expect(scene().run({ FORCHETTA_VERSION: version })).toMatchObject({ code: 1, err: expect.stringContaining('was not found') });
    }
  });

  /** A scene where GitHub is this folder: a curl that reads from it, and a gh that says yes or no. */
  function github(gh: { signedIn?: boolean; knows?: boolean; says?: boolean }) {
    const made = scene();
    writeFileSync(join(made.bin, 'curl'), `#!/bin/sh\nwhile [ $# -gt 1 ]; do if [ "$1" = -o ]; then out=$2; fi; shift; done\ncase $1 in https://github.com/alessiodonato/forchetta/releases/download/v9.9.9/*) exec cp "${made.release}/\${1##*/}" "$out" ;; esac\nexit 22\n`, { mode: 0o755 });
    writeFileSync(
      join(made.bin, 'gh'),
      `#!/bin/sh\necho "$@" >> "${made.dir}/gh.log"\ncase "$*" in\n'attestation verify --help') echo "${gh.knows === false ? '--repo' : '--repo --source-ref'}" ;;\n'auth token'*) exit ${gh.signedIn === false ? 1 : 0} ;;\n'attestation verify '*) echo "no matching attestations"; exit ${gh.says === false ? 1 : 0} ;;\n*) exit 3 ;;\nesac\n`,
      { mode: 0o755 },
    );
    const result = made.run({ FORCHETTA_RELEASES: '' });
    return { ...made, result, asked: readFileSync(join(made.dir, 'gh.log'), 'utf8').split('\n') };
  }

  it('asks GitHub whether it made the archive, where the CLI of GitHub can', () => {
    const yes = github({});
    expect(yes.result).toMatchObject({ code: 0, out: expect.stringContaining('GitHub made it from the source of Forchetta: checked.') });
    // Of github.com, whatever GH_HOST says; from that workflow, and for the tag of that version: an older archive has another.
    expect(yes.asked.find((line) => line.includes('forchetta.tar.gz'))).toMatch(
      / --hostname github\.com --repo alessiodonato\/forchetta --signer-workflow alessiodonato\/forchetta\/\.github\/workflows\/linux-release\.yml --source-ref refs\/tags\/v9\.9\.9 --deny-self-hosted-runners$/,
    );
    expect(yes.asked).toContain('auth token --hostname github.com');
    const no = github({ says: false });
    expect(no.result).toMatchObject({ code: 1, err: expect.stringContaining('nothing was installed') });
    expect(no.result.err).toContain('no matching attestations');
    expect(existsSync(join(no.home, '.local'))).toBe(false);
    // Not signed in, or too old to check: the checksum alone, and it says so.
    for (const gh of [{ signedIn: false, says: false }, { knows: false, says: false }]) expect(github(gh).result).toMatchObject({ code: 0, out: expect.stringContaining('Only the checksum is checked') });
  });

  it('takes no checksum that is not one', () => {
    // With no program that makes one, an empty list would match an empty answer.
    for (const checksum of ['', ' ', 'x'.repeat(64), 'f'.repeat(63), 'F'.repeat(64)]) {
      const made = scene({ checksum: 'f'.repeat(64) });
      writeFileSync(`${made.tar}.sha256`, `${checksum}  forchetta-9.9.9-linux.tar.gz\n`);
      for (const tool of ['sha256sum', 'shasum']) writeFileSync(join(made.bin, tool), `#!/bin/sh\necho '${checksum}'\n`, { mode: 0o755 });
      expect(made.run()).toMatchObject({ code: 1, err: expect.stringContaining('not the one of the release') });
    }
  });

  it('leaves the Forchetta there is when an update fails, and puts back one cut short', () => {
    const made = scene();
    expect(made.run().code).toBe(0);
    const lib = join(made.home, '.local', 'lib');
    const command = join(made.home, '.local', 'bin', 'forchetta');
    const works = (): void => {
      expect(execFileSync(command, ['hello'], { encoding: 'utf8' })).toBe('forchetta hello\n');
      expect(readdirSync(lib)).toEqual(['forchetta']);
    };
    writeFileSync(join(lib, 'forchetta', 'mine'), '');
    const broken = (name: string, body: string, says: string): void => {
      writeFileSync(join(made.bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      expect(made.run()).toMatchObject({ code: 1, err: expect.stringContaining(says) });
      rmSync(join(made.bin, name));
      works();
      expect(existsSync(join(lib, 'forchetta', 'mine'))).toBe(true);
    };
    // No room for the copy, after part of it is there.
    broken('cp', 'for last; do :; done; mkdir -p "$last"; echo half > "$last/half"; exit 1', 'the one there is as it was');
    // The old one is moved away, the new one does not get its place.
    broken('mv', 'case $1 in *.new) exit 1 ;; esac; exec /bin/mv "$@"', 'the one there is as it was');
    // Killed between the two, with nothing that could clean up.
    renameSync(join(lib, 'forchetta'), join(lib, 'forchetta.old'));
    mkdirSync(join(lib, 'forchetta.new'));
    expect(made.run({ FORCHETTA_VERSION: '1.2.3' }).code).toBe(1);
    works();
    expect(existsSync(join(lib, 'forchetta', 'mine'))).toBe(true);
    // Cut short, and the update after it fails too: the only copy there is is the old one.
    renameSync(join(lib, 'forchetta'), join(lib, 'forchetta.old'));
    broken('mv', 'case $1 in *.new) exit 1 ;; esac; exec /bin/mv "$@"', 'the one there is as it was');
    // And the update after that goes on as any.
    expect(made.run()).toMatchObject({ code: 0, err: '' });
    works();
    expect(existsSync(join(lib, 'forchetta', 'mine'))).toBe(false);
  });

  it('installs no terminals that do not open here', () => {
    const made = scene();
    writeFileSync(join(made.bin, 'node'), '#!/bin/sh\ncase $1 in -e) exit 1 ;; esac\necho 22\n', { mode: 0o755 });
    expect(made.run()).toMatchObject({ code: 1, err: expect.stringContaining('do not open on this Linux') });
    expect(readdirSync(join(made.home, '.local', 'lib'))).toEqual([]);
  });

  it('brings its own Node.js up to date, and takes another when the one there does not run', () => {
    const made = scene({ node: '18' });
    const dist = join(made.dir, 'node-dist');
    mkdirSync(dist);
    const env = { FORCHETTA_NODE_DIST: `file://${dist}` };
    const publish = (version: string): void => {
      const name = `node-v${version}-linux-x64`;
      mkdirSync(join(made.dir, name, 'bin'), { recursive: true });
      writeFileSync(join(made.dir, name, 'bin', 'node'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
      execFileSync('tar', ['-czf', join(dist, `${name}.tar.gz`), '-C', made.dir, name]);
      writeFileSync(join(dist, 'SHASUMS256.txt'), `${sha(join(dist, `${name}.tar.gz`))}  ${name}.tar.gz\n`);
    };
    const own = join(made.home, '.local', 'lib', 'forchetta-node', 'bin', 'node');
    const version = (): string => execFileSync(own, { encoding: 'utf8' }).trim();
    publish('22.20.0');
    expect(made.run(env).code).toBe(0);
    expect(version()).toBe('22.20.0');
    expect(made.run(env).out).not.toContain('Downloading');
    publish('22.21.1');
    expect(made.run(env)).toMatchObject({ code: 0, out: expect.stringContaining('Downloading') });
    expect(version()).toBe('22.21.1');
    // nodejs.org does not answer: the one there will do.
    expect(made.run({ FORCHETTA_NODE_DIST: 'file:///nowhere' })).toMatchObject({ code: 0, out: expect.stringContaining('stays at 22.21.1') });
    // Not whole: not a Node.js.
    writeFileSync(own, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(made.run({ FORCHETTA_NODE_DIST: 'file:///nowhere' })).toMatchObject({ code: 1, err: expect.stringContaining('Node.js could not be downloaded') });
    expect(made.run(env).code).toBe(0);
    expect(version()).toBe('22.21.1');
    // One that does not run here takes the place of none.
    publish('22.30.0');
    writeFileSync(join(made.dir, 'node-v22.30.0-linux-x64', 'bin', 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    execFileSync('tar', ['-czf', join(dist, 'node-v22.30.0-linux-x64.tar.gz'), '-C', made.dir, 'node-v22.30.0-linux-x64']);
    writeFileSync(join(dist, 'SHASUMS256.txt'), `${sha(join(dist, 'node-v22.30.0-linux-x64.tar.gz'))}  node-v22.30.0-linux-x64.tar.gz\n`);
    expect(made.run(env)).toMatchObject({ code: 1, err: expect.stringContaining('does not run on this Linux') });
    expect(version()).toBe('22.21.1');
  });

  it('says what to do elsewhere', () => {
    expect(scene({ system: 'Darwin' }).run()).toMatchObject({ code: 1, err: expect.stringContaining('brew install') });
    expect(scene({ system: 'MINGW64_NT-10.0' }).run()).toMatchObject({ code: 1, err: expect.stringContaining('forchetta.dev/windows') });
    expect(scene().run({ HOME: '/mnt/c/Users/me' })).toMatchObject({ code: 1, err: expect.stringContaining('folder of Windows') });
  });

  it.skipIf(existsSync('/usr/bin/tmux'))('needs tmux', () => {
    expect(scene({ tmux: false }).run()).toMatchObject({ code: 1, err: expect.stringContaining('tmux is missing') });
  });
});
