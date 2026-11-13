// Builds docs/demo/: the page of the app (src/ui) with the daemon of the demo (src/demo), for forchetta.dev/demo.
// The modules of the daemon are the real ones; what they import of Node comes from src/demo/shims.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const shim = (file) => resolve('src/demo/shims', file);
const SHIMS = {
  fs: shim('fs.ts'),
  path: shim('path.ts'),
  os: shim('os.ts'),
  crypto: shim('crypto.ts'),
  child_process: shim('child_process.ts'),
  readline: shim('stubs.ts'),
  url: shim('stubs.ts'),
  module: shim('stubs.ts'),
  http: shim('stubs.ts'),
  stream: shim('stubs.ts'),
  ws: shim('stubs.ts'),
};

/** node:fs, fs and the others go to the shims of the demo. */
const nodeShims = {
  name: 'node-shims',
  setup(build) {
    build.onResolve({ filter: /^(node:)?(fs|path|os|crypto|child_process|readline|url|module|http|stream)$|^ws$/ }, (args) => ({ path: SHIMS[args.path.replace(/^node:/, '')] }));
  },
};

rmSync('docs/demo', { recursive: true, force: true });
mkdirSync('docs/demo', { recursive: true });
await build({
  entryPoints: { demo: 'src/demo/main.ts' },
  outdir: 'docs/demo',
  bundle: true,
  format: 'esm',
  target: ['safari16', 'chrome110', 'firefox115'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  plugins: [nodeShims],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
copyFileSync('src/demo/index.html', 'docs/demo/index.html');
copyFileSync('src/ui/fonts/OFL.txt', 'docs/demo/fonts/OFL.txt');
console.log('docs/demo/ pronto');
