import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url));
const windows = process.platform === 'win32';

/** What Windows has not: tmux, the shell scripts of the hooks, the installers and the app of the other systems. */
const NOT_ON_WINDOWS: string[] = [];

export default defineConfig({
  // On Windows the tests write paths as Forchetta does, with forward slashes (src/shared/fspath.ts).
  ...(windows
    ? {
        resolve: {
          alias: [
            { find: /^node:path$/, replacement: here('test/windows-path.ts') },
            { find: /^node:os$/, replacement: here('test/windows-os.ts') },
          ],
        },
      }
    : {}),
  test: {
    include: ['test/**/*.test.ts'],
    exclude: windows ? NOT_ON_WINDOWS : [],
    // Some tests start tmux and shell scripts: on a busy Mac a new process can take seconds. A test that works
    // still ends in milliseconds; the margin only keeps a slow machine from failing it.
    testTimeout: 20_000,
  },
});
