// Builds dist/: the CLI and the daemon for Node, and the page of the app for the WebKit of macOS 12.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

await build({
  // team-mcp: the MCP server of the tools of a team, started by Claude Code (src/mcp/team.ts).
  entryPoints: { cli: 'src/cli/main.ts', daemon: 'src/daemon/main.ts', 'team-mcp': 'src/mcp/team.ts' },
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
  // The font of the terminals: styles.css points to it, esbuild copies it next to the page.
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  minify: true,
  sourcemap: 'linked',
  logLevel: 'warning',
});
copyFileSync('src/ui/index.html', 'dist/ui/index.html');
// The license of JetBrains Mono goes with its files, also in the archive of a release (which has dist/, not src/).
copyFileSync('src/ui/fonts/OFL.txt', 'dist/ui/fonts/OFL.txt');
console.log('dist/ pronto');
