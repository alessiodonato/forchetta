import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hookChanges, lastWords } from '../src/cli/update.ts';
import { Updates } from '../src/daemon/updates.ts';
import { OpenCodes } from '../src/daemon/open-codes.ts';
import { brewPrefix, installKind, isIntact, latestVersion, pickRelease } from '../src/shared/install.ts';
import { ROOT } from '../src/shared/paths.ts';
import { formulaVersion, isNewer, runOf, type UpdateRun } from '../src/shared/updates.ts';
import { VERSION } from '../src/shared/version.ts';
import { isBehind, loadAgain, panesBefore } from '../src/ui/reload.ts';
import { sleep, tempDir } from './helpers.ts';

const temp = tempDir('updates');
afterAll(() => temp.cleanup());

describe('a version', () => {
  it('is newer by its numbers; a beta comes before its release', () => {
    expect(isNewer('0.12.10', '0.12.9')).toBe(true);
    expect(isNewer('0.12.9', '0.12.10')).toBe(false);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.13.0-beta.10', '0.13.0-beta.9')).toBe(true);
    expect(isNewer('0.13.0', '0.13.0-beta.9')).toBe(true);
    expect(isNewer('0.13.0-beta.9', '0.13.0')).toBe(false);
    expect(isNewer('0.12.8', '0.12.8')).toBe(false);
  });
  it('is nothing when it is not one', () => {
    for (const odd of ['', 'latest', '1.2', 'v1.2.3', '1.2.3; rm', '1.2.3-rc.1']) expect(isNewer(odd, '0.1.0')).toBe(false);
  });
  it('is read from the formula of Homebrew', async () => {
    const formula = 'class Forchetta < Formula\n  url "https://github.com/alessiodonato/forchetta/releases/download/v0.12.9/forchetta-0.12.9.tar.gz"\n';
    expect(formulaVersion(formula)).toBe('0.12.9');
    expect(formulaVersion('not found')).toBeUndefined();
    const file = join(temp.dir, 'formula.rb');
    writeFileSync(file, formula);
    expect(await latestVersion(file, 'brew')).toBe('0.12.9');
  });
  it('updates by itself when Homebrew put it there, not in a clone', () => {
    expect(brewPrefix('/opt/homebrew/opt/forchetta/libexec')).toBe('/opt/homebrew');
    expect(brewPrefix('/usr/local/Cellar/forchetta/0.12.8/libexec')).toBe('/usr/local');
    expect(brewPrefix('/Users/dev/forchetta')).toBeUndefined();
    expect(installKind('/opt/homebrew/opt/forchetta/libexec', () => false, 'macos')).toBe('brew');
    expect(installKind('/Users/dev/forchetta', (path) => path.endsWith('.git'), 'macos')).toBe('clone');
    expect(installKind('/Users/dev/forchetta', () => false, 'macos')).toBe('other');
  });
  it('or the installer of Windows and Linux', () => {
    expect(installKind('C:/Users/me/.local/lib/forchetta', () => false, 'windows')).toBe('installer');
    expect(installKind('/home/me/.local/lib/forchetta', () => false, 'wsl')).toBe('installer');
    expect(installKind('/home/me/.local/lib/forchetta', (path) => path.endsWith('.git'), 'linux')).toBe('clone');
    expect(installKind('/home/me/src/forchetta', () => false, 'linux')).toBe('other');
    expect(installKind('/home/me/.local/lib/forchetta', () => false, 'macos')).toBe('other');
  });
});

describe('the releases of GitHub', () => {
  const at = (version: string, script: string): string => `https://github.com/alessiodonato/forchetta/releases/download/v${version}/${script}`;
  const release = (version: string, more: object = {}, script = 'install.ps1') => ({ tag_name: `v${version}`, draft: false, prerelease: version.includes('beta'), assets: [{ name: script, browser_download_url: at(version, script), digest: `sha256:${'a'.repeat(64)}` }], ...more });
  it('the newest with an installer for this system; a beta only for who has one', () => {
    const list = [release('0.13.0-beta.4'), release('0.13.0-beta.10'), release('0.12.9', { assets: [] }), release('0.12.0')];
    expect(pickRelease(list, 'install.ps1', '0.13.0-beta.3')).toEqual({ version: '0.13.0-beta.10', installer: at('0.13.0-beta.10', 'install.ps1'), sha256: 'a'.repeat(64) });
    expect(pickRelease(list, 'install.ps1', '0.11.0')?.version).toBe('0.12.0');
    expect(pickRelease([...list, release('0.13.0')], 'install.ps1', '0.13.0-beta.3')?.version).toBe('0.13.0');
    expect(pickRelease(list, 'install.sh', '0.13.0-beta.3')).toBeUndefined();
  });
  it('not a draft, nor a file that is elsewhere, nor what is not a version', () => {
    for (const list of [[release('0.14.0', { draft: true })], [release('0.14.0', { assets: [{ name: 'install.ps1', browser_download_url: 'https://evil.example/install.ps1' }] })], [release('0.14.0', { assets: [{ name: 'install.ps1', browser_download_url: at('0.13.0', 'install.ps1') }] })], [release('0.14.0', { tag_name: 'latest' })], [null, 1, {}], { message: 'rate limit' }, undefined]) expect(pickRelease(list, 'install.ps1', '0.1.0')).toBeUndefined();
    expect(pickRelease([release('0.14.0', { assets: [{ name: 'install.ps1', browser_download_url: at('0.14.0', 'install.ps1'), digest: 'md5:x' }] })], 'install.ps1', '0.1.0')).toEqual({ version: '0.14.0', installer: at('0.14.0', 'install.ps1') });
  });
  it('its installer is the one of its checksum', () => {
    const bytes = Buffer.from('echo hello');
    expect(isIntact(bytes, createHash('sha256').update(bytes).digest('hex'))).toBe(true);
    expect(isIntact(bytes, 'b'.repeat(64))).toBe(false);
    expect(isIntact(bytes, undefined)).toBe(true);
  });
});

describe('a page in a browser, after an update', () => {
  it('gets in once with the code it left, by the hash the daemon before kept', () => {
    let now = 1000;
    const before = new OpenCodes(() => now);
    const code = 'c'.repeat(32);
    expect(before.hand(code)).toBe(true);
    expect(before.hand('short')).toBe(false);
    const kept = before.handedOver();
    expect(JSON.stringify(kept)).not.toContain(code);
    const after = new OpenCodes(() => now);
    after.adopt(kept);
    expect(after.redeem('d'.repeat(32))).toBe(false);
    expect(after.redeem(code)).toBe(true);
    expect(after.redeem(code)).toBe(false);
    // Too late; and a file that is not one, or wants to last for ever.
    const late = new OpenCodes(() => now);
    late.adopt(kept);
    now += 41 * 60_000;
    expect(late.redeem(code)).toBe(false);
    const odd = new OpenCodes(() => now);
    for (const file of [null, 'x', { nope: 1 }, { [Object.keys(kept)[0]!]: 'x' }, { [Object.keys(kept)[0]!]: now + 10 ** 12 }]) odd.adopt(file);
    expect(odd.redeem(code)).toBe(false);
  });
});

describe('the daemon', () => {
  let count = 0;
  function scene(more: Partial<ConstructorParameters<typeof Updates>[0]> = {}) {
    const dir = join(temp.dir, `d${++count}`);
    mkdirSync(dir);
    const state = { at: 1_000_000_000_000, on: true, latest: '0.13.0' as string | undefined, looked: 0, started: 0, applied: 0, changes: 0, alive: true };
    const options = {
      current: '0.12.8',
      command: 'forchetta update',
      file: join(dir, 'updates.json'),
      runFile: join(dir, 'run.json'),
      enabled: () => state.on,
      latest: async () => {
        state.looked++;
        return state.latest;
      },
      start: () => void state.started++,
      applyHooks: async () => {
        state.applied++;
        return { ok: true, text: '' };
      },
      onChange: () => void state.changes++,
      alive: () => state.alive,
      log: () => {},
      now: () => state.at,
      ...more,
    };
    const write = (run: Partial<UpdateRun>): void => writeFileSync(options.runFile, JSON.stringify({ from: '0.12.8', to: '0.13.0', at: state.at, ...run }));
    return { state, options, write, make: () => new Updates(options) };
  }
  const opened: Updates[] = [];
  const keep = (one: Updates): Updates => {
    opened.push(one);
    return one;
  };
  afterAll(() => opened.forEach((one) => one.close()));

  it('looks once a day, and says what is newer', async () => {
    const { state, make } = scene();
    const updates = keep(make());
    expect(updates.info()).toEqual({ current: '0.12.8', command: 'forchetta update' });
    await updates.look();
    expect(updates.info().latest).toBe('0.13.0');
    expect([state.looked, state.changes]).toEqual([1, 1]);
    await updates.look();
    expect(state.looked).toBe(1);
    state.at += 21 * 3_600_000;
    await updates.look();
    expect([state.looked, state.changes]).toEqual([2, 1]);
    // A daemon that starts again does not look again the same day.
    const again = keep(make());
    expect(again.info().latest).toBe('0.13.0');
    await again.look();
    expect(state.looked).toBe(2);
  });

  it('says nothing for the same version, an older one, or what is not a version', async () => {
    for (const latest of ['0.12.8', '0.12.7', 'nonsense', undefined]) {
      const { state, make } = scene();
      state.latest = latest;
      const updates = keep(make());
      await updates.look();
      expect(updates.info().latest, String(latest)).toBeUndefined();
      updates.install();
      expect(state.started).toBe(0);
    }
  });

  it('does not look when it is turned off, and says nothing of what it knew', async () => {
    const { state, make } = scene();
    const updates = keep(make());
    await updates.look();
    state.on = false;
    expect(updates.info().latest).toBeUndefined();
    state.at += 48 * 3_600_000;
    await updates.look();
    expect(state.looked).toBe(1);
  });

  it('tries again in an hour when it could not look', async () => {
    let fail = true;
    const { state, make } = scene({
      latest: async () => {
        if (fail) throw new Error('offline');
        return '0.13.0';
      },
    });
    const updates = keep(make());
    await updates.look();
    expect(updates.info().latest).toBeUndefined();
    fail = false;
    await updates.look();
    expect(updates.info().latest).toBeUndefined();
    state.at += 3_700_000;
    await updates.look();
    expect(updates.info().latest).toBe('0.13.0');
  });

  it('a version you hide stays hidden; the next one shows', async () => {
    const { state, make } = scene();
    const updates = keep(make());
    await updates.look();
    updates.hide('0.13.0');
    expect(updates.info().latest).toBeUndefined();
    expect(keep(make()).info().latest).toBeUndefined();
    state.latest = '0.13.1';
    state.at += 21 * 3_600_000;
    await updates.look();
    expect(updates.info().latest).toBe('0.13.1');
  });

  it('installs when you click, once at a time, and follows how it goes', async () => {
    const { state, make, write } = scene();
    const updates = keep(make());
    await updates.look();
    updates.install();
    updates.install();
    expect(state.started).toBe(1);
    expect(updates.info().run).toMatchObject({ state: 'running', from: '0.12.8', to: '0.13.0' });
    write({ state: 'running', text: 'Homebrew installs Forchetta 0.13.0', pid: 42 });
    await vi.waitFor(() => expect(updates.info().run?.text).toContain('Homebrew'), 4000);
    // The daemon of the new version finds it, and how it ends.
    const after = keep(new Updates({ ...scene().options, current: '0.13.0', runFile: (updates as unknown as { options: { runFile: string } }).options.runFile, now: () => state.at }));
    expect(after.info().run).toMatchObject({ state: 'running', pid: 42 });
    write({ state: 'done' });
    await vi.waitFor(() => expect(after.info().run?.state).toBe('done'), 4000);
    after.forget();
    expect(after.info().run).toBeUndefined();
  });

  it('says when it stopped halfway, or never started', async () => {
    const { state, make, write } = scene();
    write({ state: 'running', text: 'Homebrew installs it', pid: 42 });
    state.alive = false;
    expect(keep(make()).info().run).toMatchObject({ state: 'failed', text: expect.stringContaining('stopped halfway') });
    write({ state: 'running', at: state.at - 60_000 });
    expect(keep(make()).info().run).toMatchObject({ state: 'failed', text: expect.stringContaining('did not start') });
    const broken = scene({
      start: () => {
        throw new Error('no node');
      },
    });
    const updates = keep(broken.make());
    await updates.look();
    updates.install();
    expect(updates.info().run).toMatchObject({ state: 'failed', text: expect.stringContaining('no node') });
  });

  it('applies the hooks only when you say so', async () => {
    const { state, make, write } = scene();
    write({ state: 'hooks', changes: ['+ Stop: command x'] });
    const no = keep(make());
    expect(no.info().run).toMatchObject({ state: 'hooks', changes: ['+ Stop: command x'] });
    await no.hooks(false);
    expect([state.applied, no.info().run?.state]).toEqual([0, 'done']);
    await no.hooks(true);
    expect(state.applied).toBe(0);
    write({ state: 'hooks', changes: ['+ Stop: command x'] });
    const yes = keep(make());
    await yes.hooks(true);
    expect(state.applied).toBe(1);
    expect(yes.info().run).toMatchObject({ state: 'done' });
    expect(yes.info().run?.changes).toBeUndefined();
    const refused = scene({ applyHooks: async () => ({ ok: false, text: 'settings.json changed meanwhile' }) });
    refused.write({ state: 'hooks', changes: [] });
    const failing = keep(refused.make());
    await failing.hooks(true);
    expect(failing.info().run).toMatchObject({ state: 'failed', text: 'settings.json changed meanwhile' });
  });

  it('takes a file of a run only when it is one', () => {
    for (const odd of [null, 'x', {}, { state: 'x', from: 'a', to: 'b', at: 1 }, { state: 'done', from: 1, to: 'b', at: 1 }]) expect(runOf(odd)).toBeUndefined();
    expect(runOf({ state: 'hooks', from: 'a', to: 'b', at: 1, changes: ['x', 2], more: 'y' })).toEqual({ state: 'hooks', from: 'a', to: 'b', at: 1, changes: ['x'] });
  });
});

describe.runIf(process.platform === 'darwin')('forchetta update, with Homebrew', () => {
  const cli = join(temp.dir, 'cli.mjs');
  beforeAll(async () => {
    await build({ entryPoints: [join(ROOT, 'src', 'cli', 'main.ts')], outfile: cli, bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['node-pty'], logLevel: 'error', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  });

  let count = 0;
  /** A Homebrew with a Forchetta in it, that writes what it is asked. */
  function scene(options: { latest?: string; installs?: string; setupCode?: number; upgradeCode?: number } = {}) {
    const prefix = join(temp.dir, `brew${++count}`);
    const root = join(prefix, 'opt', 'forchetta', 'libexec');
    const varDir = join(prefix, 'var');
    mkdirSync(root, { recursive: true });
    mkdirSync(join(prefix, 'bin'));
    mkdirSync(varDir, { mode: 0o700 });
    const asked = join(prefix, 'asked.txt');
    const program = (name: string, body: string): void => {
      writeFileSync(join(prefix, 'bin', name), `#!/bin/sh\necho "${name} $*" >> '${asked}'\n${body}\n`);
      chmodSync(join(prefix, 'bin', name), 0o755);
    };
    program('brew', `[ "$1" = upgrade ] && { echo 'Error: no space left' >&2; echo '${options.installs ?? '99.0.0'}' > '${prefix}/version'; exit ${options.upgradeCode ?? 0}; }\nexit 0`);
    program('forchetta', `case "$1" in --version) cat '${prefix}/version' 2>/dev/null || echo ${VERSION} ;; setup) printf 'Adding these hooks\\n\\n  + Stop: command x\\n  ~ PreToolUse: command y\\n\\n'; exit ${options.setupCode ?? 0} ;; esac`);
    const formula = join(prefix, 'formula.rb');
    writeFileSync(formula, `url "https://github.com/alessiodonato/forchetta/releases/download/v${options.latest ?? '99.0.0'}/x.tar.gz"`);
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, 'update', ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: prefix, FORCHETTA_ROOT: root, FORCHETTA_VAR: varDir, FORCHETTA_UPDATE_SOURCE: formula, NO_COLOR: '1' } });
      return { code: result.status, out: result.stdout, err: result.stderr };
    };
    return { run, asked: () => (existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n') : []), state: () => runOf(JSON.parse(readFileSync(join(varDir, 'update-run.json'), 'utf8'))) };
  }

  it('installs the last version with Homebrew, then sets it up', () => {
    const { run, asked, state } = scene();
    expect(run('--page')).toMatchObject({ code: 0 });
    expect(asked()).toEqual(['brew update', 'brew upgrade alessiodonato/tap/forchetta', 'forchetta --version', 'forchetta setup']);
    expect(state()).toMatchObject({ state: 'done', from: VERSION, to: '99.0.0' });
  });

  it('from the page it applies no hooks: it says which would change', () => {
    const { run, state } = scene({ setupCode: 2 });
    expect(run('--page').code).toBe(0);
    expect(state()).toMatchObject({ state: 'hooks', to: '99.0.0', changes: ['+ Stop: command x', '~ PreToolUse: command y'] });
    expect(state()?.pid).toBeUndefined();
  });

  it('says why it did not go, and what was there stays', () => {
    const failing = scene({ upgradeCode: 1 });
    expect(failing.run('--page').code).toBe(1);
    expect(failing.state()).toMatchObject({ state: 'failed', text: expect.stringContaining('no space left') });
    expect(failing.asked().at(-1)).toContain('brew upgrade');
    const same = scene({ installs: VERSION });
    expect(same.run('--page').code).toBe(1);
    expect(same.state()).toMatchObject({ state: 'failed', text: expect.stringContaining('did not install') });
    const setup = scene({ setupCode: 1 });
    expect(setup.run('--page').code).toBe(1);
    expect(setup.state()).toMatchObject({ state: 'failed', text: expect.stringContaining('Setting up 99.0.0') });
  });

  it('only says it, with --check; and does nothing when it is the last one', () => {
    const { run, asked } = scene();
    expect(run('--check')).toMatchObject({ code: 0, out: expect.stringContaining('99.0.0 is out') });
    expect(asked()).toEqual([]);
    const last = scene({ latest: '0.0.1' });
    expect(last.run()).toMatchObject({ code: 0, out: expect.stringContaining('is the last version') });
    expect(last.asked()).toEqual([]);
  });

  it('does not touch a Forchetta that is elsewhere', () => {
    const result = spawnSync(process.execPath, [cli, 'update'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: temp.dir, FORCHETTA_ROOT: join(temp.dir, 'elsewhere'), FORCHETTA_VAR: join(temp.dir, 'v'), NO_COLOR: '1' } });
    expect(result).toMatchObject({ status: 1, stderr: expect.stringContaining('does not update by itself') });
  });

  it('reads what a program wrote', () => {
    expect(lastWords('\u001b[31ma\u001b[0m\n\nb\nc\nd\n')).toBe('b · c · d');
    expect(hookChanges('Adding\n\n  + Stop: x\n  - Old: y\n  not one\n+ neither\n')).toEqual(['+ Stop: x', '- Old: y']);
  });
});

describe.runIf(process.platform === 'linux')('forchetta update, with the installer', () => {
  const cli = join(temp.dir, 'cli-linux.mjs');
  beforeAll(async () => {
    await build({ entryPoints: [join(ROOT, 'src', 'cli', 'main.ts')], outfile: cli, bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['node-pty'], logLevel: 'error', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  });
  let count = 0;
  function scene(options: { setupCode?: number; code?: number; changed?: boolean; installs?: string } = {}) {
    const home = join(temp.dir, `home${++count}`);
    const root = join(home, '.local', 'lib', 'forchetta');
    const varDir = join(home, 'var');
    const asked = join(home, 'asked.txt');
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(varDir, { mode: 0o700 });
    writeFileSync(join(root, 'package.json'), '{"name":"forchetta","type":"module"}');
    writeFileSync(
      join(root, 'dist', 'cli.js'),
      `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const asked = process.argv.slice(2).join(' ');
appendFileSync(${JSON.stringify(asked)}, 'forchetta ' + asked + '\\n');
if (asked === '--version') console.log(existsSync(${JSON.stringify(join(home, 'version'))}) ? readFileSync(${JSON.stringify(join(home, 'version'))}, 'utf8').trim() : '${VERSION}');
else { console.log('  + Stop: command x'); process.exit(${options.setupCode ?? 0}); }
`,
    );
    const installer = join(home, 'install.sh');
    const text = `echo "installer $FORCHETTA_NO_SETUP" >> '${asked}'\necho '${options.installs ?? '99.0.0'}' > '${home}/version'\necho 'no space left' >&2\nexit ${options.code ?? 0}\n`;
    writeFileSync(installer, text);
    const source = join(home, 'releases.json');
    writeFileSync(source, JSON.stringify([{ tag_name: 'v99.0.0', draft: false, assets: [{ name: 'install.sh', browser_download_url: installer, digest: `sha256:${createHash('sha256').update(options.changed ? 'else' : text).digest('hex')}` }] }]));
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, 'update', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, FORCHETTA_ROOT: root, FORCHETTA_VAR: varDir, FORCHETTA_UPDATE_SOURCE: source, NO_COLOR: '1' } });
      return { code: result.status, out: result.stdout, err: result.stderr };
    };
    return { run, asked: () => (existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n') : []), state: () => runOf(JSON.parse(readFileSync(join(varDir, 'update-run.json'), 'utf8'))) };
  }

  it('runs the installer of the release, then the setup of what it put there', () => {
    const { run, asked, state } = scene();
    expect(run('--page')).toMatchObject({ code: 0, err: '' });
    expect(asked()).toEqual(['installer 1', 'forchetta --version', 'forchetta setup']);
    expect(state()).toMatchObject({ state: 'done', to: '99.0.0' });
  });
  it('says which hooks would change, and applies none', () => {
    const { run, state } = scene({ setupCode: 2 });
    expect(run('--page').code).toBe(0);
    expect(state()).toMatchObject({ state: 'hooks', changes: ['+ Stop: command x'] });
  });
  it('runs no installer that is not the one of the release', () => {
    const { run, asked, state } = scene({ changed: true });
    expect(run('--page').code).toBe(1);
    expect(asked()).toEqual([]);
    expect(state()).toMatchObject({ state: 'failed', text: expect.stringContaining('not the one of the release') });
  });
  it('says why it did not go', () => {
    const failing = scene({ code: 1 });
    expect(failing.run('--page').code).toBe(1);
    expect(failing.state()).toMatchObject({ state: 'failed', text: expect.stringContaining('no space left') });
    const same = scene({ installs: VERSION });
    expect(same.run('--page').code).toBe(1);
    expect(same.state()).toMatchObject({ state: 'failed', text: expect.stringContaining('did not install') });
  });
});

describe('the page after an update', () => {
  const store = new Map<string, string>();
  let reloads = 0;
  beforeEach(() => {
    store.clear();
    reloads = 0;
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) });
    vi.stubGlobal('location', { reload: () => reloads++ });
  });
  afterAll(() => vi.unstubAllGlobals());

  it('loads again once for a newer daemon, with the terminals it had, the one in front last', () => {
    expect(isBehind(undefined)).toBe(false);
    expect(isBehind(VERSION)).toBe(false);
    expect(isBehind('0.0.1')).toBe(false);
    expect(isBehind('99.0.0')).toBe(true);
    loadAgain('99.0.0', ['a', 'b', 'c'], 'a');
    expect(reloads).toBe(1);
    // Still of the version before (a page in the cache, say): it does not go on for ever.
    expect(isBehind('99.0.0')).toBe(false);
    expect(panesBefore()).toEqual(['b', 'c', 'a']);
    expect(panesBefore()).toEqual([]);
  });

  it('does not when it could not be kept that it did', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => { throw new Error('off'); }, removeItem: () => {} });
    loadAgain('99.0.0', [], undefined);
    expect(reloads).toBe(0);
    expect(panesBefore()).toEqual([]);
  });

  it('takes only ids from what it kept', async () => {
    store.set('forchetta.panesAfter', '{"a":1}');
    expect(panesBefore()).toEqual([]);
    store.set('forchetta.panesAfter', 'nope');
    expect(panesBefore()).toEqual([]);
    await sleep(0);
  });
});
