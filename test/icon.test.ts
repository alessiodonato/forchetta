import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Registry } from '../src/daemon/registry.ts';
import { createDaemonServer } from '../src/daemon/server.ts';
import { join } from '../src/shared/fspath.ts';
import { ROOT } from '../src/shared/paths.ts';
import { http } from './helpers.ts';

// The fork of the window on Windows and Linux, and of the shortcut in the Start menu: scripts/make-icon.swift draws it.

const ico = readFileSync(join(ROOT, 'src', 'ui', 'forchetta.ico'));
const read = (...path: string[]): string => readFileSync(join(ROOT, ...path), 'utf8');

interface Entry {
  size: number;
  data: Buffer;
}

/** The images of an .ico, as its first bytes list them. */
function entries(file: Buffer): Entry[] {
  expect([file.readUInt16LE(0), file.readUInt16LE(2)]).toEqual([0, 1]);
  return Array.from({ length: file.readUInt16LE(4) }, (_, index) => {
    const at = 6 + 16 * index;
    expect(file.readUInt16LE(at + 6)).toBe(32);
    const from = file.readUInt32LE(at + 12);
    expect(file[at + 1]).toBe(file[at]);
    return { size: file[at] || 256, data: file.subarray(from, from + file.readUInt32LE(at + 8)) };
  });
}

describe('the icon', () => {
  const images = entries(ico);

  it('has the sizes of Windows at its scales, and nothing else', () => {
    expect(images.map((image) => image.size)).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256]);
    expect(ico.length).toBe(6 + 16 * images.length + images.reduce((sum, image) => sum + image.data.length, 0));
  });

  it('has bitmaps that every Windows reads, and PNG where they would be large', () => {
    for (const { size, data } of images) {
      if (size >= 128) {
        expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect([data.readUInt32BE(16), data.readUInt32BE(20)]).toEqual([size, size]);
        continue;
      }
      // The height is twice: the image and its mask.
      expect([data.readUInt32LE(0), data.readInt32LE(4), data.readInt32LE(8), data.readUInt16LE(14)]).toEqual([40, size, size * 2, 32]);
      expect(data.length).toBe(40 + size * size * 4 + (Math.ceil(size / 32) * 4) * size);
      // The neck of the fork is in the middle, amber; the corner is empty.
      const middle = 40 + ((size / 2) * size + size / 2) * 4;
      const [blue, , red, alpha] = data.subarray(middle, middle + 4);
      expect(red! > 200 && blue! < 120 && alpha === 255).toBe(true);
      expect(data[40 + 3]).toBe(0);
    }
  });

  it('is the one of the page, with the sizes it says', () => {
    const link = /<link rel="icon" href="forchetta\.ico" type="image\/x-icon" sizes="([^"]+)" \/>/.exec(read('src', 'ui', 'index.html'));
    expect(link?.[1]).toBe(images.map(({ size }) => `${size}x${size}`).join(' '));
    expect(read('scripts', 'build.mjs')).toContain("copyFileSync('src/ui/forchetta.ico', 'dist/ui/forchetta.ico');");
  });

  it('is the one of the shortcut, at the link that an update leaves where it is', () => {
    const installer = read('docs', 'install.ps1');
    expect(installer).toContain("$icon = Join-Path $Link 'dist\\ui\\forchetta.ico'");
    expect(installer.indexOf('Set-Junction $Link $folder')).toBeLessThan(installer.indexOf('{ Write-Shortcut }'));
  });

  it('comes from the daemon as an icon, with no token', async () => {
    const registry = new Registry({ settleMs: 5 });
    let port = 0;
    const server = createDaemonServer({ registry, token: 'a'.repeat(64), uiDir: join(ROOT, 'src', 'ui'), port: () => port, log: () => {}, info: () => ({}), onShutdown: () => {} });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    const answer = await http(port, { path: '/forchetta.ico' });
    registry.dispose();
    await new Promise((resolve) => server.close(resolve));
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('image/x-icon');
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(Number(answer.headers['content-length'])).toBe(ico.length);
  });
});
