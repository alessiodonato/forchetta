import { resolve } from 'node:path';

// How the guard reads a shell line: split into simple commands, and told apart by what they do. A plain reading, as
// a person would read the line: no expansions, no subshells, no aliases. What cannot be read says nothing, and the
// command goes on as usual.

/**
 * The words of a shell line, split into simple commands at ;, &, |, &&, || and newlines, with quotes and
 * backslashes taken away. A plain reading: no expansions, no subshells. Undefined when a quote is left open.
 */
export function shellCommands(line: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\') {
      if (i + 1 < line.length && line[i + 1] !== '\n') {
        word += line[++i];
        inWord = true;
      } else i++;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && j + 1 < line.length) word += line[++j];
        else word += line[j];
      }
      if (j >= line.length) return undefined;
      inWord = true;
      i = j;
    } else if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') {
      endCommand();
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** The words that only run the command after them: VAR=value, command, exec, env, nice, time, nohup. */
export function commandStart(words: readonly string[]): number {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || ['command', 'exec', 'env', 'nice', 'time', 'nohup'].includes(words[i]!))) i++;
  return i;
}

/** A simple command of a line, with the folder it runs in (cd followed): its words from the program on. */
export interface PlacedCommand {
  words: string[];
  dir: string;
}

/** The simple commands of a line, each from its program on, with the folder it runs in; cd itself is left out. */
export function placedCommands(line: string, cwd: string): PlacedCommand[] {
  const commands = shellCommands(line);
  if (!commands) return [];
  const found: PlacedCommand[] = [];
  let dir = cwd;
  for (const all of commands) {
    const words = all.slice(commandStart(all));
    if (words.length === 0) continue;
    if (words[0] === 'cd') {
      const to = words[1];
      if (to && to !== '-' && !to.startsWith('~') && !to.includes('$')) dir = resolve(dir, to);
      continue;
    }
    found.push({ words, dir });
  }
  return found;
}

const base = (word: string | undefined): string => (word ?? '').split('/').at(-1) ?? '';

/** npm, pnpm, yarn, bun: the script a command runs ("npm test" runs test, "pnpm build" runs build); undefined otherwise. */
function scriptOf(words: readonly string[]): string | undefined {
  const tool = base(words[0]);
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(tool)) return undefined;
  const rest = words.slice(1).filter((word) => !word.startsWith('-'));
  const first = rest[0];
  if (!first) return undefined;
  if (first === 'run' || first === 'run-script') return rest[1];
  if (tool === 'npm' && !['test', 't', 'start', 'tst'].includes(first)) return undefined;
  if (['exec', 'dlx', 'x', 'install', 'i', 'add', 'remove', 'update', 'ci'].includes(first)) return undefined;
  return first === 't' || first === 'tst' ? 'test' : first;
}

/** The program a runner of packages starts: "npx vitest" → vitest, "pnpm exec tsc" → tsc. */
function packageProgram(words: readonly string[]): { name: string; args: string[] } | undefined {
  const tool = base(words[0]);
  let i = -1;
  if (tool === 'npx' || tool === 'pnpx' || tool === 'bunx') i = 1;
  else if ((tool === 'pnpm' || tool === 'npm') && (words[1] === 'exec' || words[1] === 'dlx')) i = 2;
  else if (tool === 'yarn' && (words[1] === 'exec' || words[1] === 'dlx')) i = 2;
  else if (tool === 'bun' && words[1] === 'x') i = 2;
  if (i < 0) return undefined;
  while (i < words.length && words[i]!.startsWith('-')) i++;
  const name = words[i];
  return name ? { name: base(name).replace(/@[^/]*$/, ''), args: words.slice(i + 1) } : undefined;
}

const CHECK_SCRIPT = /(^|[:._-])(test|tests|spec|e2e|build|lint|check|typecheck|types|tsc|ci|verify|validate)([:._-]|$)/i;
const CHECK_PROGRAMS = new Set(['vitest', 'jest', 'tsc', 'playwright', 'mocha', 'eslint', 'cypress', 'ava', 'tap', 'biome', 'pytest', 'py.test', 'ruff', 'mypy', 'pyright', 'rspec', 'phpunit', 'tox', 'nox']);

/**
 * Whether a simple command runs tests, a build, a type check or a linter: what fails when the code of another
 * session is half done.
 */
export function isCheckCommand(words: readonly string[]): boolean {
  const name = base(words[0]);
  const sub = words.slice(1).find((word) => !word.startsWith('-'));
  const script = scriptOf(words);
  if (script !== undefined) return CHECK_SCRIPT.test(script);
  const program = packageProgram(words);
  if (program) {
    if (program.name === 'turbo' || program.name === 'nx') return program.args.some((arg) => CHECK_SCRIPT.test(arg));
    return CHECK_PROGRAMS.has(program.name);
  }
  if (name === 'turbo' || name === 'nx') return words.slice(1).some((arg) => CHECK_SCRIPT.test(arg));
  if (CHECK_PROGRAMS.has(name)) return true;
  if (/^python3?$/.test(name) && words[1] === '-m') return ['pytest', 'unittest', 'mypy', 'ruff', 'pyright', 'tox'].includes(words[2] ?? '');
  switch (name) {
    case 'go':
      return ['test', 'build', 'vet'].includes(sub ?? '');
    case 'cargo':
      return ['test', 'build', 'check', 'clippy', 'nextest'].includes(sub ?? '');
    case 'make':
    case 'gmake':
    case 'just':
      return true;
    case 'mvn':
    case 'gradle':
    case 'gradlew':
    case 'xcodebuild':
      return true;
    case 'dotnet':
    case 'swift':
      return ['test', 'build'].includes(sub ?? '');
    case 'deno':
      return ['test', 'check', 'lint'].includes(sub ?? '');
    case 'mix':
      return ['test', 'compile'].includes(sub ?? '');
    case 'rake':
      return ['test', 'spec'].includes(sub ?? '') || sub === undefined;
    case 'bundle':
      return words[1] === 'exec' && ['rspec', 'rake'].includes(base(words[2]));
    default:
      return false;
  }
}

const SERVER_SCRIPT = /^(dev|start|serve|server|preview|develop)([:._-].*)?$/i;
const SERVER_PROGRAMS: Record<string, string[] | true> = {
  vite: ['dev', 'serve', 'preview', ''],
  next: ['dev', 'start'],
  nuxt: ['dev', 'preview', 'start'],
  nuxi: ['dev', 'preview'],
  astro: ['dev', 'preview'],
  remix: ['dev'],
  ng: ['serve'],
  webpack: ['serve'],
  'webpack-dev-server': true,
  parcel: true,
  expo: ['start'],
  gatsby: ['develop', 'serve'],
  'svelte-kit': ['dev'],
  hugo: ['server', 'serve'],
  jekyll: ['serve', 's'],
  'http-server': true,
  'live-server': true,
  serve: true,
  uvicorn: true,
  gunicorn: true,
  fastapi: ['dev', 'run'],
  wrangler: ['dev'],
};

/** Whether a simple command starts a dev server: a script like dev or start, vite, next dev, rails s, runserver… */
export function isDevServerCommand(words: readonly string[]): boolean {
  const script = scriptOf(words);
  if (script !== undefined) return SERVER_SCRIPT.test(script);
  const program = packageProgram(words);
  const name = program?.name ?? base(words[0]);
  const args = program?.args ?? words.slice(1);
  const sub = args.find((word) => !word.startsWith('-')) ?? '';
  const known = SERVER_PROGRAMS[name];
  if (known === true) return true;
  // A bare vite, with options or with the folder of the app: a server; vite build, a subcommand by name, is not.
  if (known) return known.includes(sub) || (known.includes('') && !/^[a-z][a-z-]*$/i.test(sub));
  if (name === 'rails') return sub === 's' || sub === 'server';
  if (words[0] === 'bin/dev' || words[0] === './bin/dev') return true;
  if (name === 'php' && base(words[1]) === 'artisan') return words[2] === 'serve';
  if (/^python3?$/.test(name)) {
    if (words[1] === '-m') return words[2] === 'http.server' || words[2] === 'uvicorn' || (words[2] === 'flask' && words[3] === 'run');
    return base(words[1]) === 'manage.py' && words[2] === 'runserver';
  }
  if (name === 'flask') return sub === 'run';
  return false;
}

/** What a kill command aims at: pids, process names or patterns (pkill, killall), or the ports of servers. */
export interface KillTargets {
  pids: number[];
  /** For pgrep, as pkill and killall would match: ["-f", "vite"], ["-x", "node"]. */
  patterns: string[][];
  ports: number[];
}

/** The targets of the kill commands of a line: kill, pkill, killall, kill of a port (lsof -ti, kill-port, fuser -k). */
export function killTargets(line: string): KillTargets | undefined {
  const targets: KillTargets = { pids: [], patterns: [], ports: [] };
  const commands = shellCommands(line);
  if (!commands) return undefined;
  // "kill $(lsof -ti:3000)" and "lsof -ti:3000 | xargs kill": the port of lsof, when a kill is on the line.
  const hasKill = commands.some((all) => {
    const words = all.slice(commandStart(all));
    return ['kill', 'xargs', 'pkill', 'killall'].includes(base(words[0])) || words.some((word) => word === 'kill' || word.startsWith('$(kill'));
  });
  for (const all of commands) {
    const words = all.slice(commandStart(all));
    const name = base(words[0]);
    if (name === 'kill' || (name === 'xargs' && words.includes('kill'))) {
      for (const word of words.slice(1)) if (/^\d+$/.test(word)) targets.pids.push(Number(word));
    } else if (name === 'pkill') {
      const full = words.includes('-f');
      const pattern = words.slice(1).filter((word) => !word.startsWith('-')).at(-1);
      if (pattern) targets.patterns.push(full ? ['-f', pattern] : [pattern]);
    } else if (name === 'killall') {
      for (const word of words.slice(1)) if (!word.startsWith('-')) targets.patterns.push(['-x', word]);
    } else if (name === 'kill-port' || (packageProgram(words)?.name === 'kill-port')) {
      const args = packageProgram(words)?.args ?? words.slice(1);
      for (const word of args) if (/^\d+$/.test(word)) targets.ports.push(Number(word));
    } else if (name === 'fuser' && words.some((word) => /^-[a-z]*k/.test(word))) {
      for (const word of words.slice(1)) {
        const port = /^(\d+)\/tcp$/.exec(word);
        if (port) targets.ports.push(Number(port[1]));
      }
    } else if (name === 'lsof' && hasKill) {
      for (const word of words.slice(1)) {
        const port = /-[a-zA-Z]*i:?(\d+)$|^:(\d+)$|^tcp:(\d+)$/i.exec(word);
        const value = port?.[1] ?? port?.[2] ?? port?.[3];
        if (value) targets.ports.push(Number(value));
      }
    }
  }
  // $(lsof -ti:3000) inside a kill: the shell reading above split it at the parenthesis, so lsof was seen.
  return targets.pids.length + targets.patterns.length + targets.ports.length > 0 ? targets : undefined;
}
