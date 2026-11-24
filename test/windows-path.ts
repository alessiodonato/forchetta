// node:path in the tests on Windows: as Forchetta writes paths there (vitest.config.ts).
export { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from '../src/shared/fspath.ts';
export { win32, posix } from 'path';
