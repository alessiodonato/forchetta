import { fromGitBash, fromOutside, resolve, WINDOWS } from '../shared/fspath.ts';

// How the guard reads a shell line: split into simple commands, and told apart by what they do. A plain reading, as
// a person would read the line: no expansions, no subshells, no aliases. What cannot be read says nothing, and the
// command goes on as usual.

/**
 * The words of a shell line, split into simple commands at ;, &, |, &&, || and newlines, with quotes and
 * backslashes taken away. A plain reading: no expansions, no subshells. Undefined when a quote is left open.
 * The body of a here-document is text for a program (a file it writes, the message of a commit), not commands,
 * unless the program is a shell: bash <<EOF, cat <<EOF | sh.
 */
export function shellCommands(line: string): string[][] | undefined {
  return shellTokens(stripHeredocs(line, goesToShell))?.map((words) => words.map((word) => word.text));
}

/** A word of a shell line, with where in it a > was written outside quotes: the start of a redirection. */
interface ShellToken {
  text: string;
  /** The positions in `text` of the > written outside quotes and not escaped. */
  arrows: number[];
}

/** shellCommands, with the redirections told apart from a > in quotes ("grep '>' file" redirects nothing). */
function shellTokens(line: string): ShellToken[][] | undefined {
  const commands: ShellToken[][] = [];
  let words: ShellToken[] = [];
  let word = '';
  let arrows: number[] = [];
  let inWord = false;
  const endWord = (): void => {
    if (inWord) words.push({ text: word, arrows });
    word = '';
    arrows = [];
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
      if (c === '>') arrows.push(word.length);
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/**
 * The line without the bodies of its here-documents (cat > f <<'EOF' … EOF): what they hold is text for a program,
 * not commands, and an apostrophe in it would leave a quote open. The line that opens one stays.
 */
export const withoutHeredocs = (line: string): string => stripHeredocs(line, () => false);

const HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w.-]*))/y;

/**
 * The line without the bodies of its here-documents, except those `keep` wants, told the command a body is for (the
 * text before <<) and the rest of its line. A << in quotes, in a comment or in arithmetic opens none, nor does one
 * whose end is nowhere: those lines stay, as commands.
 */
function stripHeredocs(line: string, keep: (head: string, tail: string) => boolean): string {
  let out = '';
  // Where the reading is: in double quotes or not, inside each $( and (; and where the command at hand starts.
  const contexts = [{ quoted: false, from: 0 }];
  const waiting: { word: string; tabs: boolean; keep: boolean }[] = [];
  let i = 0;
  const copyTo = (end: number): void => {
    out += line.slice(i, end);
    i = end;
  };
  while (i < line.length) {
    const c = line[i]!;
    const top = contexts.at(-1)!;
    if (c === '\\') copyTo(Math.min(i + 2, line.length));
    else if (line.startsWith('$((', i) || (!top.quoted && line.startsWith('((', i))) {
      const end = line.indexOf('))', i);
      copyTo(end < 0 ? i + 2 : end + 2);
    } else if (line.startsWith('$(', i)) {
      copyTo(i + 2);
      contexts.push({ quoted: false, from: i });
    } else if (c === '"') {
      copyTo(i + 1);
      if (top.quoted) contexts.pop();
      else contexts.push({ quoted: true, from: i });
    } else if (top.quoted) copyTo(i + 1);
    else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      copyTo(end < 0 ? line.length : end + 1);
    } else if (c === '#' && (i === 0 || /[\s;&|(]/.test(line[i - 1]!))) {
      const end = line.indexOf('\n', i);
      copyTo(end < 0 ? line.length : end);
    } else if (c === '\n' && waiting.length > 0) {
      copyTo(i + 1);
      for (const doc of waiting.splice(0)) {
        const body = bodyOf(line, i, doc);
        if (!body) break;
        if (doc.keep) out += stripHeredocs(line.slice(i, body.end), keep);
        i = body.next;
      }
      top.from = i;
    } else if (line.startsWith('<<<', i)) copyTo(i + 3);
    else if (line.startsWith('<<', i)) {
      HEREDOC.lastIndex = i;
      const match = HEREDOC.exec(line);
      if (!match) copyTo(i + 2);
      else {
        const head = line.slice(top.from, i);
        copyTo(HEREDOC.lastIndex);
        const end = line.indexOf('\n', i);
        waiting.push({ word: (match[2] ?? match[3] ?? match[4])!, tabs: match[1] === '-', keep: keep(head, line.slice(i, end < 0 ? line.length : end)) });
      }
    } else {
      copyTo(i + 1);
      if (c === '(') contexts.push({ quoted: false, from: i });
      else if (c === ')' && contexts.length > 1) contexts.pop();
      // 2>&1 and &> copy a descriptor: the & ends no command.
      else if (c === ';' || c === '|' || c === '\n' || c === '`' || (c === '&' && line[i - 2] !== '>' && line[i] !== '>')) top.from = i;
    }
  }
  return out;
}

/** The body of a here-document that starts at `from`: where it ends, and where the line goes on; undefined with no end. */
function bodyOf(line: string, from: number, doc: { word: string; tabs: boolean }): { end: number; next: number } | undefined {
  for (let at = from; at < line.length; ) {
    const newline = line.indexOf('\n', at);
    const stop = newline < 0 ? line.length : newline;
    const text = line.slice(at, stop);
    if ((doc.tabs ? text.replace(/^\t+/, '') : text) === doc.word) return { end: at, next: newline < 0 ? line.length : newline + 1 };
    at = stop + 1;
  }
  return undefined;
}

/** Programs that run as commands what they read. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'su']);

function readsCommands(words: readonly string[]): boolean {
  let start = 0;
  while (['then', 'do', 'else', 'if', 'elif', 'while', 'until', '{', '!'].includes(words[start] ?? '')) start++;
  const rest = words.slice(start);
  const command = rest.slice(commandStart(rest));
  const name = base(command[0]);
  if (name === 'source' || name === '.') return command[1] === '/dev/stdin';
  // sudo -u me bash, env -i bash: the shell comes after their options.
  const at = ['sudo', 'doas'].includes(name) || name.startsWith('-') ? command.findIndex((word) => SHELLS.has(base(word))) : SHELLS.has(name) ? 0 : -1;
  // bash -c '…' has its commands there: what it reads is their input.
  return at >= 0 && !command.slice(at + 1).some((word) => /^-[A-Za-z]*c$/.test(word));
}

/** Whether a here-document is for a shell: the command it is written in, or one that command is piped to. */
function goesToShell(head: string, tail: string): boolean {
  const commands = [head];
  let ended = false;
  for (let i = 0; i < tail.length && !ended; i++) {
    const c = tail[i]!;
    let piece = c;
    if (c === '\\') piece = tail.slice(i, i + 2);
    else if (c === "'" || c === '"') {
      const end = tail.indexOf(c, i + 1);
      piece = tail.slice(i, end < 0 ? tail.length : end + 1);
    } else if (c === '|' && tail[i + 1] !== '|') {
      commands.push('');
      if (tail[i + 1] === '&') i++;
      continue;
    } else if (c === '|' || c === ';' || c === ')' || c === '`' || (c === '&' && tail[i - 1] !== '>' && tail[i + 1] !== '>')) ended = true;
    if (ended) break;
    commands[commands.length - 1] += piece;
    i += piece.length - 1;
  }
  // The pipe goes on after the body: who reads it is not known here, so the body stays.
  if (!ended && commands.length > 1 && commands.at(-1)!.trim() === '') return true;
  return commands.some((command) => {
    const words = shellTokens(command)?.[0]?.map((word) => word.text);
    return words ? readsCommands(words) : false;
  });
}

/** A file a shell line writes, as far as a plain reading tells. */
export interface ShellWrite {
  /** Absolute; with `glob`, a pattern of * and ?. */
  path: string;
  /** A pattern (sed -i 's/a/b/' src/*.ts): the files it matches. */
  glob?: boolean;
  /** Taken away with what is under it (rm -r, mv of a folder): any file under it counts. */
  tree?: boolean;
  /** Rewritten by a formatter or a fixer (prettier --write, eslint --fix, ruff format): with `tree`, a folder it covers. */
  formatter?: boolean;
}

/**
 * The files a shell line writes: redirections (> and >>), tee, sed -i, perl -i, the destination of cp and mv, what
 * rm and mv take away, and what the usual formatters and fixers rewrite (FORMATTERS, formatterPaths). Each with the
 * folder it runs in (cd followed). A plain reading: a word with $, a backquote or ~ is not followed, and what a
 * program writes by itself (a Python or Node script, a formatter not in the list) is not seen.
 */
export function shellWrites(line: string, cwd: string): ShellWrite[] {
  const commands = shellTokens(withoutHeredocs(line));
  if (!commands) return [];
  const found: ShellWrite[] = [];
  let dir = cwd;
  const add = (word: string | undefined, how: Omit<ShellWrite, 'path'> = {}): void => {
    if (!word || /[$`]/.test(word) || word.startsWith('~') || word.startsWith('/dev/') || word === '-' || (WINDOWS && /^nul$/i.test(word))) return;
    const glob = /[*?[]/.test(word);
    found.push({ path: place(dir, word), ...(glob ? { glob: true } : {}), ...how });
  };
  for (const all of commands) {
    // The redirections first: they can stand anywhere in the command, and are taken out of its words.
    const words: string[] = [];
    for (let i = 0; i < all.length; i++) {
      const token = all[i]!;
      const arrow = token.arrows[0];
      const fd = arrow === undefined ? '' : token.text.slice(0, arrow);
      if (arrow === undefined || !/^\d*$/.test(fd)) {
        words.push(token.text);
        continue;
      }
      // 2>&1 and >&2 copy a descriptor: the & ended the word, and nothing follows in this command.
      const rest = token.text.slice(arrow).replace(/^>>?\|?/, '');
      if (rest) add(rest);
      else add(all[++i]?.text);
    }
    const start = commandStart(words);
    const name = base(words[start]);
    const args = words.slice(start + 1);
    if (name === 'cd') {
      const to = args[0];
      if (to && to !== '-' && !to.startsWith('~') && !to.includes('$')) dir = place(dir, to);
      continue;
    }
    for (const write of programWrites(name, args)) add(write.word, write.tree ? { tree: true } : {});
    for (const word of formatterPaths(words.slice(start))) add(word, { tree: true, formatter: true });
  }
  return found;
}

/**
 * A formatter or a fixer. Its paths are the plain words after the program (and its subcommand), each a file, a folder
 * or a pattern it rewrites; the values of `values` are not paths.
 */
interface Formatter {
  /** Whether this call rewrites files: prettier only with --write, ruff format unless --check. */
  writes: (args: readonly string[]) => boolean;
  /** The options followed by a value. */
  values?: readonly string[];
  /** With no path, it formats the folder it runs in. */
  dot?: boolean;
  /** It takes no paths: it formats the project of the folder it runs in (cargo fmt). */
  project?: boolean;
}

/** An option given, alone or as --option=value. */
const given = (args: readonly string[], ...flags: string[]): boolean => args.some((word) => flags.some((flag) => word === flag || word.startsWith(`${flag}=`)));
const withFlag = (...flags: string[]) => (args: readonly string[]): boolean => given(args, ...flags);
const withoutFlag = (...flags: string[]) => (args: readonly string[]): boolean => !given(args, ...flags);

const BIOME_VALUES = ['--config-path', '--stdin-file-path', '--max-diagnostics', '--diagnostic-level', '--reporter', '--log-level', '--log-kind', '--since', '--vcs-root'];
const RUFF_VALUES = ['--config', '--target-version', '--line-length', '--select', '--ignore', '--extend-select', '--extend-ignore', '--exclude', '--extend-exclude', '--output-format', '-o', '--output-file', '--stdin-filename', '--cache-dir', '--fixable', '--unfixable', '--range'];

/** By program, or by program and subcommand ("ruff format", "go fmt"). */
const FORMATTERS = new Map<string, Formatter>([
  ['prettier', { writes: withFlag('--write', '-w'), values: ['--config', '--ignore-path', '--plugin', '--parser', '--cache-location', '--stdin-filepath', '--log-level'] }],
  ['eslint', { writes: withFlag('--fix'), values: ['-c', '--config', '--ext', '--rule', '-f', '--format', '-o', '--output-file', '--ignore-path', '--ignore-pattern', '--plugin', '--parser', '--cache-location', '--max-warnings', '--rulesdir', '--resolve-plugins-relative-to', '--fix-type'], dot: true }],
  ['biome format', { writes: withFlag('--write', '--fix', '--apply'), values: BIOME_VALUES, dot: true }],
  ['biome check', { writes: withFlag('--write', '--fix', '--apply', '--apply-unsafe'), values: BIOME_VALUES, dot: true }],
  ['biome lint', { writes: withFlag('--write', '--fix', '--apply', '--apply-unsafe'), values: BIOME_VALUES, dot: true }],
  ['ruff format', { writes: withoutFlag('--check', '--diff'), values: RUFF_VALUES, dot: true }],
  ['ruff check', { writes: (args) => given(args, '--fix') && !given(args, '--no-fix', '--diff'), values: RUFF_VALUES, dot: true }],
  ['black', { writes: withoutFlag('--check', '--diff'), values: ['-l', '--line-length', '-t', '--target-version', '--config', '--include', '--exclude', '--extend-exclude', '--force-exclude', '--stdin-filename', '-W', '--workers'] }],
  ['isort', { writes: withoutFlag('--check-only', '-c', '--check', '--diff'), values: ['--settings-path', '--sp', '--settings-file', '--profile', '-l', '--line-length', '--src', '--skip', '--skip-glob'] }],
  ['gofmt', { writes: withFlag('-w') }],
  ['go fmt', { writes: () => true, dot: true }],
  ['cargo fmt', { writes: withoutFlag('--check'), project: true }],
  ['rustfmt', { writes: withoutFlag('--check', '--emit'), values: ['--edition', '--config-path', '--config', '--color', '--style-edition'] }],
  ['clang-format', { writes: withFlag('-i'), values: ['--style', '--assume-filename', '--lines', '--offset', '--length', '--fallback-style', '--files'] }],
  ['rubocop', { writes: withFlag('-a', '-A', '--autocorrect', '--autocorrect-all', '--auto-correct', '--auto-correct-all', '-x', '--fix-layout'), values: ['-c', '--config', '-f', '--format', '-o', '--out', '--only', '--except', '-r', '--require', '--cache-root'], dot: true }],
  ['swiftformat', { writes: withoutFlag('--lint', '--dryrun'), values: ['--config', '--swiftversion', '--rules', '--enable', '--disable', '--exclude', '--unexclude', '--indent', '--cache', '--report', '--baseconfig', '--filelist'] }],
  ['dart format', { writes: (args) => !args.some((word, i) => /^--output=(none|show|json)$/.test(word) || ((word === '-o' || word === '--output') && /^(none|show|json)$/.test(args[i + 1] ?? ''))), values: ['-o', '--output', '-l', '--line-length', '--page-width', '--language-version', '--show', '--summary', '--indent', '--trailing-commas'] }],
  ['mix format', { writes: withoutFlag('--check-formatted', '--dry-run'), values: ['--dot-formatter', '--stdin-filename'], dot: true }],
  ['terraform fmt', { writes: (args) => !given(args, '-check', '--check') && !args.includes('-write=false'), dot: true }],
  ['shfmt', { writes: withFlag('-w', '--write'), values: ['-i', '--indent', '-ln', '--language-dialect', '--filename'] }],
  ['php-cs-fixer fix', { writes: withoutFlag('--dry-run'), values: ['--config', '--rules', '--path-mode', '--using-cache', '--cache-file', '--format', '--allow-risky'], dot: true }],
]);

/** The words that run the program after them: npx prettier, pnpm exec, uv run, bundle exec, python -m black. */
function unwrapRunner(words: readonly string[]): string[] | undefined {
  const tool = base(words[0]);
  let i = -1;
  if (['npx', 'pnpx', 'bunx', 'uvx'].includes(tool)) i = 1;
  else if (['pnpm', 'npm', 'yarn'].includes(tool) && (words[1] === 'exec' || words[1] === 'dlx')) i = 2;
  else if (tool === 'bun' && words[1] === 'x') i = 2;
  else if (['uv', 'poetry', 'pipenv', 'pdm', 'rye', 'hatch', 'pipx'].includes(tool) && words[1] === 'run') i = 2;
  else if (tool === 'bundle' && words[1] === 'exec') i = 2;
  else if (/^python[\d.]*$/.test(tool) && words[1] === '-m') i = 2;
  // pnpm and yarn run a program of the project by its name: pnpm prettier --write .
  else if ((tool === 'pnpm' || tool === 'yarn') && words[1] !== undefined && FORMATTERS.has(programName(words[1]))) i = 1;
  if (i < 0) return undefined;
  while (i < words.length && words[i]!.startsWith('-')) i++;
  return i < words.length ? words.slice(i) : undefined;
}

/** A program as FORMATTERS names it: @biomejs/biome@1.9 → biome. */
const programName = (word: string): string => base(word).replace(/@[^/]*$/, '');

/** A package script that formats or fixes: npm run format, pnpm fmt, yarn lint:fix, pnpm lint --fix. */
function formatsByScript(words: readonly string[]): boolean {
  const script = scriptOf(words);
  if (!script || /check|verify/i.test(script)) return false;
  if (/(^|[:_-])(format|fmt|prettier|prettify|fix)([:_-]|$)/i.test(script)) return true;
  return /^lint/i.test(script) && words.includes('--fix');
}

/**
 * What a formatter or a fixer rewrites, as the words of the command name it: files, folders, patterns (go fmt ./...
 * is the folder). None when the call only checks (prettier --check, ruff format --check). A package script that
 * formats rewrites the folder it runs in: what is in it is not read.
 */
function formatterPaths(words: readonly string[]): string[] {
  let call: readonly string[] = words;
  for (let n = 0; n < 3; n++) call = unwrapRunner(call) ?? call;
  if (call === words && formatsByScript(words)) return ['.'];
  const name = programName(call[0] ?? '');
  const sub = call[1];
  const bySub = sub !== undefined ? FORMATTERS.get(`${name} ${sub}`) : undefined;
  const formatter = bySub ?? FORMATTERS.get(name);
  if (!formatter) return [];
  const args = call.slice(bySub ? 2 : 1);
  if (!formatter.writes(args) || given(args, '--help', '-h', '--version', '-V')) return [];
  if (formatter.project) return ['.'];
  const values = new Set(formatter.values ?? []);
  const paths: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (options && word === '--') options = false;
    else if (options && word.startsWith('-') && word !== '-') {
      if (values.has(word)) i++;
    } else paths.push(word.replace(/\/\.\.\.$/, '') || '.');
  }
  return paths.length > 0 ? paths : formatter.dot ? ['.'] : [];
}

/** The words a program writes or takes away, by how it reads its arguments. */
function programWrites(name: string, args: readonly string[]): Array<{ word: string; tree?: boolean }> {
  const plain = (from: readonly string[]): string[] => {
    const out: string[] = [];
    let options = true;
    for (const word of from) {
      if (options && word === '--') options = false;
      else if (options && word.startsWith('-') && word !== '-') continue;
      else out.push(word);
    }
    return out;
  };
  switch (name) {
    case 'tee':
      return plain(args).map((word) => ({ word }));
    case 'sed':
      return inPlaceFiles(args, 'sed').map((word) => ({ word }));
    case 'perl':
      return inPlaceFiles(args, 'perl').map((word) => ({ word }));
    case 'rm':
    case 'unlink':
      return plain(args).map((word) => ({ word, tree: true }));
    case 'cp':
    case 'mv': {
      // -t names the destination before the sources: not followed.
      if (args.some((word) => word === '-t' || word.startsWith('--target-directory'))) return [];
      const files = plain(args);
      if (files.length < 2) return [];
      const target = { word: files.at(-1)! };
      return name === 'mv' ? [...files.slice(0, -1).map((word) => ({ word, tree: true })), target] : [target];
    }
    case 'truncate':
      return plain(args.filter((word, i) => !(args[i - 1] === '-s' || word.startsWith('-s')))).map((word) => ({ word }));
    default:
      return [];
  }
}

/**
 * The files sed -i or perl -i change in place: none without -i. For sed the script is the first plain word unless
 * -e or -f gave it; for perl, unless -e gave it. BSD sed takes the suffix as the next word: -i '' or -i .bak.
 */
function inPlaceFiles(args: readonly string[], program: 'sed' | 'perl'): string[] {
  let inPlace = false;
  let script = false;
  const plain: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === '--') {
      plain.push(...args.slice(i + 1));
      break;
    }
    if (word === '--in-place' || word.startsWith('--in-place=')) {
      inPlace = true;
      continue;
    }
    if (word === '--expression' || word === '--file') {
      script = true;
      i++;
      continue;
    }
    if (word.startsWith('--expression=') || word.startsWith('--file=')) {
      script = true;
      continue;
    }
    if (!word.startsWith('-') || word === '-') {
      plain.push(word);
      continue;
    }
    // A cluster of short options: -i, -i.bak, -Ei, -pi, -pe, -ne. What follows i is its suffix.
    const letters = word.slice(1);
    for (let j = 0; j < letters.length; j++) {
      const letter = letters[j]!;
      if (letter === 'i') {
        inPlace = true;
        // sed -i '' and sed -i .bak (BSD): the suffix is the next word.
        if (program === 'sed' && j === letters.length - 1 && (args[i + 1] === '' || /^\.[\w.-]*$/.test(args[i + 1] ?? ''))) i++;
        break;
      }
      if (letter === 'e' || (program === 'sed' && letter === 'f')) {
        script = true;
        if (j === letters.length - 1) i++;
        break;
      }
      // sed -l N (GNU, wrap length) takes a value.
      if (program === 'sed' && letter === 'l') {
        if (j === letters.length - 1) i++;
        break;
      }
    }
  }
  if (!inPlace) return [];
  return script ? plain : plain.slice(1);
}

/** Whether a pattern of * and ? (and ** for any folders, none included) matches a path; both absolute. */
export function globMatches(pattern: string, path: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
      source += '(?:.*/)?';
      i += 2;
    } else if (c === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, WINDOWS ? 'i' : '').test(path);
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
      if (to && to !== '-' && !to.startsWith('~') && !to.includes('$')) dir = place(dir, to);
      continue;
    }
    found.push({ words, dir });
  }
  return found;
}

/** A program by its name, without its folder; on Windows without .exe either. */
export const base = (word: string | undefined): string => {
  const name = (word ?? '').split(WINDOWS ? /[\\/]/ : '/').at(-1) ?? '';
  return WINDOWS ? name.replace(/\.(?:exe|cmd|bat)$/i, '') : name;
};

/** A path of a shell line, from the folder it is written in; on Windows also as Git Bash has it, and as the disk does. */
export const place = (dir: string, word: string): string => (WINDOWS ? fromOutside(resolve(dir, fromGitBash(word))) : resolve(dir, word));

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
  // Its own entries only: a word like constructor is not one.
  const known = Object.hasOwn(SERVER_PROGRAMS, name) ? SERVER_PROGRAMS[name] : undefined;
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
    // Of Windows, in Git Bash: //PID, so that it is not taken for a path.
    if (name === 'taskkill') {
      for (let i = 1; i < words.length; i++) {
        const option = words[i]!.replace(/^\/\//, '/').toLowerCase();
        if (option === '/pid' && /^\d+$/.test(words[i + 1] ?? '')) targets.pids.push(Number(words[++i]));
        else if (option === '/im' && words[i + 1]) targets.patterns.push(['-x', words[++i]!]);
      }
      continue;
    }
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
