// node:os in the tests on Windows: its folders as Forchetta writes paths there (vitest.config.ts).
export * from 'os';
export { homedir, tmpdir } from '../src/shared/fspath.ts';
