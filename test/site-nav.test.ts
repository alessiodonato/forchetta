import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

// The bar at the top of forchetta.dev is the same on every page: the same links, in the same order, to the same places,
// with the page you are on marked, and Install apart.

const GITHUB = 'https://github.com/alessiodonato/forchetta';
const LINKS = [
  ['Studio', 'studio/'],
  ['Demo', 'demo/'],
  ['Manual', 'manual.html'],
  ['Windows', 'windows/'],
  ['Changelog', 'changelog/'],
  ['GitHub', GITHUB],
];
const PAGES: { file: string; current?: string }[] = [
  { file: 'index.html' },
  { file: 'manual.html', current: 'Manual' },
  { file: 'changelog/index.html', current: 'Changelog' },
  { file: 'windows/index.html', current: 'Windows' },
  { file: 'windows/wsl/index.html', current: 'Windows' },
  { file: 'bash-edits/index.html' },
];

/** A link of a page as it reads from the root of the site. */
const fromRoot = (file: string, href: string): string => {
  if (/^https:\/\//.test(href)) return href;
  const [path = '', hash = ''] = href.split('#');
  const resolved = path ? posix.normalize(posix.join(posix.dirname(file), path)) : file;
  return (resolved === '.' || resolved === './' ? '' : resolved.replace(/^\.\//, '')) + (hash ? `#${hash}` : '');
};

describe('the bar at the top of the site', () => {
  for (const page of PAGES) {
    it(`is the same on ${page.file}`, () => {
      const html = readFileSync(new URL(`../docs/${page.file}`, import.meta.url), 'utf8');
      const nav = /<nav aria-label="Site">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
      const links = [...nav.matchAll(/<a href="([^"]+)"( aria-current="[^"]+")?>([^<]+)<\/a>/g)];
      expect(links.map((link) => [link[3], fromRoot(page.file, link[1]!)])).toEqual(LINKS);
      expect(links.filter((link) => link[2]).map((link) => link[3])).toEqual(page.current ? [page.current] : []);
      expect((nav.match(/class="sep"/g) ?? []).length).toBe(2);
      const install = /<a class="nav-install" href="([^"]+)">Install<\/a>/.exec(html)?.[1];
      expect(install && fromRoot(page.file, install).replace(/^index\.html/, '')).toBe('#install');
    });
  }
});
