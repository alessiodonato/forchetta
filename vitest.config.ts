import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Some tests start tmux and shell scripts: on a busy Mac a new process can take seconds. A test that works
    // still ends in milliseconds; the margin only keeps a slow machine from failing it.
    testTimeout: 20_000,
  },
});
