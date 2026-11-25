import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../src/shared/paths.ts';
import { tempDir } from './helpers.ts';

// `forchetta hooks install` and `uninstall` as a script runs them: the real command line, with no terminal, in a home and
// a private folder of their own.

const temp = tempDir('hooks-cli');
afterAll(() => temp.cleanup());

const cli = join(temp.dir, 'cli.mjs');
beforeAll(async () => {
  await build({
    entryPoints: [join(ROOT, 'src', 'cli', 'main.ts')],
    outfile: cli,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node-pty'],
    logLevel: 'error',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
});

let count = 0;
function scene() {
  const home = join(temp.dir, `home-${++count}`);
  const varDir = join(home, 'var');
  const settings = join(home, '.claude', 'settings.json');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(varDir, { mode: 0o700 });
  const run = (...args: string[]) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), FORCHETTA_VAR: varDir, FORCHETTA_ROOT: ROOT, NO_COLOR: '1' };
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, cwd: home });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return { settings, config: join(varDir, 'config.json'), run };
}

describe('forchetta hooks, with no terminal', () => {
  it('changes nothing without --yes, and its exit code says so', () => {
    const { settings, run } = scene();
    expect(run('hooks', 'install')).toMatchObject({ code: 2, out: expect.stringContaining('No change: this is not an interactive terminal.'), err: '' });
    expect(existsSync(settings)).toBe(false);
    expect(run('hooks', 'install', '--yes').code).toBe(0);
    const installed = readFileSync(settings, 'utf8');
    // Nothing left to do is done.
    expect(run('hooks', 'install')).toMatchObject({ code: 0, out: expect.stringContaining('already in') });
    expect(run('hooks', 'uninstall').code).toBe(2);
    expect(readFileSync(settings, 'utf8')).toBe(installed);
    expect(run('hooks', 'uninstall', '--yes').code).toBe(0);
    expect(run('hooks', 'uninstall')).toMatchObject({ code: 0, out: expect.stringContaining('No hook of Forchetta') });
  });

  it('is an error, not a question with no answer, when the settings cannot be read', () => {
    const { settings, run } = scene();
    writeFileSync(settings, '{ nope');
    expect(run('hooks', 'install').code).toBe(1);
    expect(readFileSync(settings, 'utf8')).toBe('{ nope');
  });
});

describe('the saved path of node', () => {
  const saved = (config: string): unknown => (JSON.parse(readFileSync(config, 'utf8')) as { paths: { node?: unknown } }).paths.node;

  it('is given up when an update of Node.js took it away: running it again is enough', () => {
    const { config, settings, run } = scene();
    const gone = `${temp.dir.replaceAll('\\', '/')}/gone/node-v24.20.0/node`;
    writeFileSync(config, JSON.stringify({ paths: { node: gone } }));
    expect(run('hooks', 'install', '--yes').code).toBe(0);
    expect(saved(config)).not.toBe(gone);
    expect(existsSync(saved(config) as string)).toBe(true);
    expect(readFileSync(settings, 'utf8')).not.toContain('node-v24.20.0');
  });

  it('stays while it is there', () => {
    const { config, run } = scene();
    const mine = join(temp.dir, process.platform === 'win32' ? 'my-node.exe' : 'my-node').replaceAll('\\', '/');
    writeFileSync(mine, '', { mode: 0o755 });
    writeFileSync(config, JSON.stringify({ paths: { node: mine } }));
    expect(run('hooks', 'install', '--yes').code).toBe(0);
    expect(saved(config)).toBe(mine);
  });
});
