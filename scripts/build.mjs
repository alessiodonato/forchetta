// Builds dist/: the CLI and the daemon for Node, and the page of the app for the WebKit of macOS 12.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: { cli: 'src/cli/main.ts', daemon: 'src/daemon/main.ts' },
  outdir: 'dist',
  bundle: true,
  // The SDK of the optional summaries goes into a chunk of its own, loaded only when they are on.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Native: loaded from node_modules at run time.
  external: ['node-pty'],
  sourcemap: 'linked',
  logLevel: 'warning',
  // ws is CommonJS and calls require(): an ES module needs one made for it.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});

mkdirSync('dist/ui', { recursive: true });
await build({
  entryPoints: { app: 'src/ui/main.tsx' },
  outdir: 'dist/ui',
  bundle: true,
  format: 'esm',
  // Safari 17.0 is the WebKit of macOS 12 here; 15 keeps a margin.
  target: ['safari15'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  sourcemap: 'linked',
  logLevel: 'warning',
});
copyFileSync('src/ui/index.html', 'dist/ui/index.html');
console.log('dist/ pronto');
