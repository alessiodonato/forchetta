// node:path for the demo in the browser: POSIX paths only, as on the Mac.

export const sep = '/';

export function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else out.push(part);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined || '.';
}

export const isAbsolute = (path: string): boolean => path.startsWith('/');

export const join = (...parts: string[]): string => normalize(parts.filter((part) => part !== '').join('/'));

export function resolve(...parts: string[]): string {
  let out = '';
  for (let index = parts.length - 1; index >= 0 && !out.startsWith('/'); index -= 1) {
    const part = parts[index];
    if (part) out = out ? `${part}/${out}` : part;
  }
  if (!out.startsWith('/')) out = `/Users/you/${out}`;
  return normalize(out);
}

export function dirname(path: string): string {
  const normal = normalize(path);
  const cut = normal.lastIndexOf('/');
  if (cut < 0) return '.';
  return cut === 0 ? '/' : normal.slice(0, cut);
}

export function basename(path: string, ext?: string): string {
  const base = normalize(path).split('/').at(-1) ?? '';
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

export const extname = (path: string): string => {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
};

export function relative(from: string, to: string): string {
  const a = resolve(from).split('/').filter(Boolean);
  const b = resolve(to).split('/').filter(Boolean);
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same += 1;
  return [...a.slice(same).map(() => '..'), ...b.slice(same)].join('/');
}

export const posix = { sep, normalize, isAbsolute, join, resolve, dirname, basename, extname, relative };
export default posix;
