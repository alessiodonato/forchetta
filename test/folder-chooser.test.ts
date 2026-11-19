import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FolderChooser, type Osascript, startFolder } from '../src/daemon/folder-chooser.ts';
import { tempDir } from './helpers.ts';

// The panel of macOS for a folder, opened by the daemon for a page in a browser (the app has its own).

const temp = tempDir('folder-chooser');
afterAll(() => temp.cleanup());

describe('where the panel opens', () => {
  it('on the folder written, or the nearest folder above it, or your home', () => {
    const home = join(temp.dir, 'home');
    mkdirSync(join(home, 'projects', 'shop'), { recursive: true });
    expect(startFolder(join(home, 'projects', 'shop'), home)).toBe(join(home, 'projects', 'shop'));
    expect(startFolder(join(home, 'projects', 'not-yet', 'deeper'), home)).toBe(join(home, 'projects'));
    expect(startFolder('~/projects/shop', home)).toBe(join(home, 'projects', 'shop'));
    expect(startFolder('~', home)).toBe(home);
    expect(startFolder('projects/shop', home)).toBe(home);
    expect(startFolder(undefined, home)).toBe(home);
    expect(startFolder('   ', home)).toBe(home);
  });
});

describe('the panel', () => {
  it('gives the folder chosen without its last slash, and nothing when cancelled or failed', async () => {
    const calls: (readonly string[])[] = [];
    let answer: string | undefined = '/Users/you/projects/shop/\n';
    const run: Osascript = async (lines, args) => {
      calls.push(args);
      expect(lines.join('\n')).toContain('choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))');
      return answer;
    };
    const chooser = new FolderChooser(run);
    expect(await chooser.choose(temp.dir)).toBe('/Users/you/projects/shop');
    expect(calls[0]).toEqual(['The folder for Forchetta', temp.dir]);
    answer = '/\n';
    expect(await chooser.choose()).toBe('/');
    answer = '\n';
    expect(await chooser.choose()).toBeUndefined();
    answer = undefined;
    expect(await chooser.choose()).toBeUndefined();
  });

  it('opens one at a time: a second ask while one is open gets nothing', async () => {
    let release: (value: string) => void = () => {};
    const run: Osascript = () => new Promise((resolve) => (release = resolve));
    const chooser = new FolderChooser(run);
    const first = chooser.choose();
    expect(await chooser.choose()).toBeUndefined();
    release('/Users/you/a/\n');
    expect(await first).toBe('/Users/you/a');
    const again = chooser.choose();
    release('/Users/you/b\n');
    expect(await again).toBe('/Users/you/b');
  });
});
