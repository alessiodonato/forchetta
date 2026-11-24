import { homedir } from '../shared/fspath.ts';
import type { HookPayload } from './state.ts';

// How the guard reads a line of PowerShell, the other tool that runs commands on Windows: as the same commands of a POSIX
// shell, which shell.ts reads already. Set-Content a.txt is tee a.txt, Remove-Item a -Recurse is rm a, Set-Location src is
// cd src; a program (git, npm) stays itself. As there, a plain reading: what a variable holds is not known, and what cannot
// be read says nothing.

/** A part of a line: words, or what separates two commands. */
type Part = { kind: 'word'; text: string; quoted: boolean; list: boolean } | { kind: 'end'; text: string } | { kind: 'redirect'; append: boolean } | { kind: 'copy' };

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '', a: '', b: '', f: '', v: '' };

/** The variables a line may start a path with, whose value is known. */
const known = (text: string): string =>
  text
    .replace(/^\$(?:\{PWD\}|PWD(?![\w:]))(?:\.Path)?/i, '.')
    .replace(/^\$(?:\{HOME\}|HOME(?![\w:])|env:USERPROFILE(?!\w)|\{env:USERPROFILE\})/i, homedir())
    .replace(/^~(?=[\\/]|$)/, homedir());

/** The parts of a line; undefined when a quote or a here-string is left open. */
function partsOf(line: string): Part[] | undefined {
  const parts: Part[] = [];
  let word = '';
  let inWord = false;
  let quoted = false;
  let list = false;
  const endWord = (): void => {
    if (inWord) parts.push({ kind: 'word', text: word, quoted, list });
    if (inWord) list = false;
    word = '';
    inWord = false;
    quoted = false;
  };
  const end = (text: string): void => {
    endWord();
    list = false;
    parts.push({ kind: 'end', text });
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const rest = line.slice(i);
    if (c === '`') {
      const next = line[i + 1];
      if (next === '\r' || next === '\n') {
        // The line goes on.
        i += next === '\r' && line[i + 2] === '\n' ? 2 : 1;
        endWord();
        continue;
      }
      if (next !== undefined) word += ESCAPES[next] ?? next;
      inWord = true;
      i++;
      continue;
    }
    const here = !inWord ? /^@(['"])[ \t]*\r?\n/.exec(rest) : null;
    if (here) {
      const close = new RegExp(`\\r?\\n${here[1]}@`).exec(rest.slice(here[0].length - 1));
      if (!close) return undefined;
      const from = here[0].length;
      const to = here[0].length - 1 + close.index;
      word = rest.slice(from, Math.max(from, to));
      inWord = true;
      quoted = true;
      i += here[0].length - 1 + close.index + close[0].length - 1;
      endWord();
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      for (; j < line.length; j++) {
        if (line[j] !== "'") word += line[j];
        else if (line[j + 1] === "'") {
          word += "'";
          j++;
        } else break;
      }
      if (j >= line.length) return undefined;
      inWord = true;
      quoted = true;
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      // A subexpression in it may hold quotes of its own.
      let depth = 0;
      for (; j < line.length; j++) {
        const d = line[j]!;
        if (d === '`' && j + 1 < line.length) word += ESCAPES[line[++j]!] ?? line[j];
        else if (d === '$' && line[j + 1] === '(') {
          depth++;
          word += '$(';
          j++;
        } else if (depth > 0 && d === '(') {
          depth++;
          word += d;
        } else if (depth > 0 && d === ')') {
          depth--;
          word += d;
        } else if (d !== '"' || depth > 0) word += d;
        else if (line[j + 1] === '"') {
          word += '"';
          j++;
        } else break;
      }
      if (j >= line.length) return undefined;
      inWord = true;
      quoted = true;
      i = j;
      continue;
    }
    if (rest.startsWith('<#')) {
      const close = line.indexOf('#>', i + 2);
      if (close < 0) return undefined;
      i = close + 1;
      continue;
    }
    if (c === '#' && !inWord) {
      const stop = line.indexOf('\n', i);
      if (stop < 0) break;
      i = stop - 1;
      continue;
    }
    const redirect = !inWord || /^[1-6*]$/.test(word) ? /^(?:[1-6*])?(>>?)(&[1-6])?/.exec(inWord ? word + rest : rest) : null;
    if (redirect && (c === '>' || inWord)) {
      const used = redirect[0].length - (inWord ? word.length : 0);
      word = '';
      inWord = false;
      quoted = false;
      parts.push(redirect[2] ? { kind: 'copy' } : { kind: 'redirect', append: redirect[1] === '>>' });
      i += used - 1;
      continue;
    }
    if (c === '>') {
      // Right after a word: it ends it.
      endWord();
      const arrow = /^(>>?)(&[1-6])?/.exec(rest)!;
      parts.push(arrow[2] ? { kind: 'copy' } : { kind: 'redirect', append: arrow[1] === '>>' });
      i += arrow[0].length - 1;
      continue;
    }
    if (c === ' ' || c === '\t') endWord();
    else if (c === ',') {
      // a.txt, b.txt: one argument with several values.
      endWord();
      list = true;
    } else if (c === '\r') continue;
    else if (c === ';' || c === '\n' || c === '{' || c === '}' || c === '(' || c === ')') end(c);
    else if (c === '|' || c === '&') {
      const double = line[i + 1] === c;
      end(double ? c + c : c);
      if (double) i++;
    } else {
      word += c;
      inWord = true;
    }
  }
  endWord();
  return parts;
}

interface Argument {
  /** The name of a parameter, in lower case and without its dash; undefined for a value. */
  name?: string;
  values: string[];
}

interface Command {
  words: Array<{ text: string; quoted: boolean; list: boolean }>;
  /** The files its output is written to. */
  outputs: string[];
  /** What separates it from the next one. */
  end: string;
}

function commandsOf(parts: readonly Part[]): Command[] {
  const commands: Command[] = [];
  let current: Command = { words: [], outputs: [], end: '' };
  const push = (end: string): void => {
    current.end = end;
    commands.push(current);
    current = { words: [], outputs: [], end: '' };
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.kind === 'end') push(part.text);
    else if (part.kind === 'redirect') {
      const target = parts[i + 1];
      if (target?.kind === 'word') {
        current.outputs.push(target.text);
        i++;
      }
    } else if (part.kind === 'word') current.words.push(part);
  }
  push('');
  return commands;
}

/** The parameters that take no value: what follows one is a value of the command. */
const SWITCHES = ['force', 'recurse', 'append', 'nonewline', 'noclobber', 'confirm', 'whatif', 'verbose', 'debug', 'passthru', 'asbytestream', 'container', 'notypeinformation', 'usebasicparsing', 'raw', 'wait', 'nonewwindow', 'useculture', 'noheader'];

/** A parameter by its name or by the beginning of it: -Rec is -Recurse, -Literal is -LiteralPath. */
const isParam = (given: string, name: string): boolean => given.length > 0 && name.startsWith(given);

function argumentsOf(words: Command['words']): Argument[] {
  const out: Argument[] = [];
  let open: Argument | undefined;
  for (const word of words) {
    const named = !word.quoted && !word.list ? /^-([A-Za-z]\w*)(?::(.*))?$/.exec(word.text) : null;
    if (named) {
      const name = named[1]!.toLowerCase();
      const argument: Argument = { name, values: named[2] ? [named[2]] : [] };
      out.push(argument);
      open = named[2] !== undefined || SWITCHES.some((one) => isParam(name, one)) ? undefined : argument;
      continue;
    }
    const last = out.at(-1);
    // The second value of a list goes where the first went.
    if (word.list && last) last.values.push(word.text);
    else if (open) {
      open.values.push(word.text);
      open = undefined;
    } else out.push({ values: [word.text] });
  }
  return out;
}

const valuesOf = (args: readonly Argument[], ...names: string[]): string[] => args.filter((arg) => arg.name !== undefined && names.some((name) => isParam(arg.name!, name))).flatMap((arg) => arg.values);
const positional = (args: readonly Argument[]): string[][] => args.filter((arg) => arg.name === undefined).map((arg) => arg.values);

/** The aliases of PowerShell that Forchetta reads, and the POSIX names it has for some of them. */
const ALIASES: Record<string, string> = {
  sc: 'set-content',
  ac: 'add-content',
  clc: 'clear-content',
  tee: 'tee-object',
  epcsv: 'export-csv',
  ni: 'new-item',
  rm: 'remove-item',
  ri: 'remove-item',
  del: 'remove-item',
  erase: 'remove-item',
  rd: 'remove-item',
  rmdir: 'remove-item',
  cp: 'copy-item',
  copy: 'copy-item',
  cpi: 'copy-item',
  mv: 'move-item',
  move: 'move-item',
  mi: 'move-item',
  ren: 'rename-item',
  rni: 'rename-item',
  cd: 'set-location',
  chdir: 'set-location',
  sl: 'set-location',
  pushd: 'set-location',
  'push-location': 'set-location',
  kill: 'stop-process',
  spps: 'stop-process',
  iwr: 'invoke-webrequest',
  wget: 'invoke-webrequest',
  curl: 'invoke-webrequest',
};

/** Where each cmdlet that writes takes its file: by these names, else its first value. */
const WRITERS: Record<string, string[]> = {
  'set-content': ['path', 'literalpath', 'pspath'],
  'add-content': ['path', 'literalpath', 'pspath'],
  'clear-content': ['path', 'literalpath', 'pspath'],
  'out-file': ['filepath', 'literalpath', 'path', 'pspath'],
  'tee-object': ['filepath', 'literalpath'],
  'export-csv': ['path', 'literalpath'],
  'export-clixml': ['path', 'literalpath'],
};

const SOURCES = ['path', 'literalpath', 'pspath'];

const dirOf = (path: string): string => {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut + 1);
};

/** A word for a POSIX shell. */
const quote = (word: string): string => (/^[\w./:@=+-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);
/** A path as Forchetta writes it. */
const path = (text: string): string => known(text).replace(/\\/g, '/');

/** A program by its name: C:\Program Files\Git\bin\git.exe is git. */
const program = (word: string): string => (/[\\/]/.test(word) ? path(word) : word).replace(/\.(?:exe|cmd|bat)$/i, '');

/** A cmdlet as the command of a POSIX shell that does the same to the files; undefined when it changes nothing. */
function cmdlet(name: string, args: readonly Argument[]): string[] | undefined {
  const values = positional(args);
  const paths = (...names: string[]): string[] => {
    const named = valuesOf(args, ...names);
    return (named.length > 0 ? named : (values[0] ?? [])).map(path);
  };
  const writer = WRITERS[name];
  if (writer) return ['tee', ...paths(...writer)];
  switch (name) {
    case 'new-item': {
      const type = valuesOf(args, 'itemtype', 'type')[0]?.toLowerCase();
      if (type && type !== 'file') return undefined;
      const inName = valuesOf(args, 'name');
      const where = paths(...SOURCES);
      // With -Name the path is the folder it goes in.
      return inName.length > 0 ? ['tee', ...inName.map((one) => (where[0] ? `${where[0]}/${path(one)}` : path(one)))] : type === 'file' ? ['tee', ...where] : undefined;
    }
    case 'remove-item':
      return ['rm', '-r', ...paths(...SOURCES)];
    case 'copy-item':
    case 'move-item': {
      const from = valuesOf(args, ...SOURCES);
      const to = valuesOf(args, 'destination');
      const left = [...values];
      const sources = (from.length > 0 ? from : (left.shift() ?? [])).map(path);
      const target = (to.length > 0 ? to : (left.shift() ?? ['.'])).map(path);
      return [name === 'copy-item' ? 'cp' : 'mv', ...sources, ...target];
    }
    case 'rename-item': {
      const from = valuesOf(args, ...SOURCES);
      const to = valuesOf(args, 'newname');
      const left = [...values];
      const source = path((from.length > 0 ? from : (left.shift() ?? []))[0] ?? '');
      const target = path((to.length > 0 ? to : (left.shift() ?? []))[0] ?? '');
      return source && target ? ['mv', source, target.includes('/') ? target : `${dirOf(source)}${target}`] : undefined;
    }
    case 'set-location': {
      const to = paths(...SOURCES)[0];
      return to ? ['cd', to] : undefined;
    }
    case 'invoke-webrequest': {
      const out = valuesOf(args, 'outfile');
      return out.length > 0 ? ['tee', ...out.map(path)] : undefined;
    }
    case 'stop-process': {
      const names = valuesOf(args, 'name', 'processname');
      if (names.length > 0) return ['killall', ...names];
      const ids = valuesOf(args, 'id');
      return ['kill', ...(ids.length > 0 ? ids : (values[0] ?? []))];
    }
    case 'get-nettcpconnection': {
      const ports = valuesOf(args, 'localport');
      return ports.length > 0 ? ['lsof', ...ports.map((port) => `-ti:${port}`)] : undefined;
    }
    default:
      return undefined;
  }
}

/** taskkill /PID 12 /IM node.exe /F: kill, or killall by name. */
function taskkill(words: readonly string[]): string[][] {
  const pids: string[] = [];
  const names: string[] = [];
  for (let i = 0; i < words.length; i++) {
    // Git Bash writes //PID, so that it is not taken for a path.
    const option = words[i]!.replace(/^\/\//, '/').toLowerCase();
    if (option === '/pid' && words[i + 1]) pids.push(words[++i]!);
    else if (option === '/im' && words[i + 1]) names.push(words[++i]!);
  }
  return [...(pids.length > 0 ? [['kill', ...pids]] : []), ...(names.length > 0 ? [['killall', ...names]] : [])];
}

const LISTERS = new Set(['get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi']);
const CMDLETS = new Set([...Object.keys(WRITERS), ...Object.values(ALIASES), 'get-nettcpconnection']);
const STATIC = /^\[(?:System\.)?IO\.(File|Directory)\]::(\w+)$/i;

/** [IO.File]::WriteAllText('a.txt', $x): what it does to its first file, or to its two. */
function staticCall(kind: string, method: string, args: readonly string[]): string[] | undefined {
  const name = method.toLowerCase();
  const files = args.map(path);
  if (/^(?:writeall|appendall)|^(?:create|createtext|appendtext|openwrite|replace)$/.test(name) && kind.toLowerCase() === 'file') return files[0] ? ['tee', files[0]] : undefined;
  if (name === 'delete') return files[0] ? ['rm', '-r', files[0]] : undefined;
  if (name === 'move' || name === 'copy') return files[0] && files[1] ? [name === 'move' ? 'mv' : 'cp', files[0], files[1]] : undefined;
  return undefined;
}

/** A line of PowerShell as a line of a POSIX shell that does the same to the files; empty when it cannot be read. */
export function powershellAsShell(line: string): string {
  const parts = partsOf(line);
  if (!parts) return '';
  const commands = commandsOf(parts);
  const out: string[] = [];
  /** What a command of this pipe lists, for a Remove-Item at its end. */
  let listed: string[] = [];
  const separators: Record<string, string> = { '|': ' | ', '&&': ' && ', '||': ' || ' };
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]!;
    let words = command.words;
    // $x = command, $x += command: the command.
    if (words.length >= 2 && /^[$[]/.test(words[0]!.text) && !words[1]!.quoted && /^[+]?=$/.test(words[1]!.text)) words = words.slice(2);
    // $x=command, with no spaces.
    const joined = words[0] && !words[0].quoted ? /^\$[\w:]+\+?=(.+)$/.exec(words[0].text) : null;
    if (joined) words = [{ ...words[0]!, text: joined[1]! }, ...words.slice(1)];
    while (words.length > 0 && !words[0]!.quoted && /^(?:return|throw|if|elseif|else|while|do|until|try|catch|finally|foreach|process|begin|end|\.)$/i.test(words[0]!.text)) words = words.slice(1);
    const redirects = command.outputs.map((file) => ` > ${quote(path(file))}`).join('');
    const end = separators[command.end] ?? '; ';
    const call = words.length === 1 && command.end === '(' ? STATIC.exec(words[0]!.text) : null;
    if (call) {
      // Its arguments are the next command, up to the closing parenthesis.
      const next = commands[i + 1];
      const found = next ? staticCall(call[1]!, call[2]!, next.words.map((word) => word.text)) : undefined;
      if (found) out.push(`${found.map(quote).join(' ')}; `);
      i++;
      continue;
    }
    if (words.length === 0) {
      // Parentheses and braces, or a redirection of what came out of them.
      if (redirects) out.push(`true${redirects}; `);
      continue;
    }
    const first = words[0]!;
    const name = program(first.text);
    const lower = name.toLowerCase();
    const cmd = first.quoted ? lower : (ALIASES[lower] ?? lower);
    // curl.exe and sc.exe are the programs; curl and sc may be the aliases.
    const asCmdlet = CMDLETS.has(cmd) && !/\.(?:exe|cmd|bat)$/i.test(first.text);
    const rest = words.slice(1);
    if (LISTERS.has(cmd)) {
      const args = argumentsOf(rest);
      const named = valuesOf(args, ...SOURCES);
      listed = (named.length > 0 ? named : (positional(args)[0] ?? ['.'])).map(path);
    } else if (commands[i - 1]?.end !== '|') listed = [];
    if (asCmdlet) {
      let done = cmdlet(cmd, argumentsOf(rest));
      // Get-ChildItem build | Remove-Item: what was listed goes.
      if (done?.length === 2 && done[0] === 'rm' && listed.length > 0) done = [...done, ...listed];
      out.push(`${done && done.length > 1 ? done.map(quote).join(' ') : done?.[0] === 'kill' ? 'kill' : 'true'}${redirects}${end}`);
    } else if (lower === 'taskkill') {
      const kills = taskkill(rest.map((word) => word.text));
      out.push(`${kills.length > 0 ? kills.map((kill) => kill.map(quote).join(' ')).join('; ') : 'true'}${redirects}${end}`);
    } else {
      out.push(`${[name, ...rest.map((word) => path(word.text))].map(quote).join(' ')}${redirects}${end}`);
    }
  }
  return out.join('').replace(/(?:; | \| | && | \|\| )+$/, '');
}

/** The tools that run a command line. */
export const isShellTool = (tool: string | undefined): boolean => tool === 'Bash' || tool === 'PowerShell';

/**
 * The command line of a call of Bash or PowerShell, as a POSIX shell has it; undefined for any other tool. What the dialogs
 * and the notes show is the line as it was written: this one is only to be read.
 */
export function shellLine(payload: Pick<HookPayload, 'tool_name' | 'tool_input'>): string | undefined {
  if (!isShellTool(payload.tool_name)) return undefined;
  const command = (payload.tool_input as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string') return undefined;
  return payload.tool_name === 'PowerShell' ? powershellAsShell(command) : command;
}
