// node-pty 1.1.0 ships spawn-helper without the executable bit in its prebuilds, and then every pty fails with
// "posix_spawnp failed". This sets the bit on the helper of this platform, and does nothing else.
import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('node-pty/package.json'));
const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
if (existsSync(helper)) {
  chmodSync(helper, 0o755);
  console.log(`node-pty: ${helper} reso eseguibile`);
}
