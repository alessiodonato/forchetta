import { VERSION } from '../shared/version.ts';
import type { Style } from './style.ts';

// The help of `forchetta` and of each command, and the command you probably meant when you mistype one.

export const HOMEPAGE = 'https://alessiodonato.github.io/forchetta/manual.html';

interface Entry {
  /** What you type, painted in Claude orange: "setup", "--app-dir". */
  name: string;
  /** What follows it, in the color of the text: "start|stop|status", "<folder>". */
  args?: string;
  text: string;
}

interface CommandHelp {
  summary: string;
  usage: string;
  about?: string[];
  actions?: Entry[];
  options?: Entry[];
  examples?: string[];
}

const COMMANDS: Record<string, CommandHelp> = {
  setup: {
    summary: 'Get Forchetta ready: build the app and install the hooks',
    usage: 'forchetta setup [options]',
    about: [
      'Checks tmux, Claude Code and the Command Line Tools, builds the app in ~/Applications, then adds',
      'the hooks to ~/.claude/settings.json: it shows what it changes and asks first (d shows the whole diff).',
      'Run it again after every `brew upgrade forchetta`: it builds the app again only when it changed.',
    ],
    options: [
      { name: '--yes', text: 'Install the hooks without asking' },
      { name: '--force', text: 'Build the app again, even when it is up to date' },
      { name: '--diff', text: 'Show the whole diff of ~/.claude/settings.json before asking' },
      { name: '--app-dir', args: '<folder>', text: 'Where the app goes (default: ~/Applications)' },
    ],
    examples: ['forchetta setup', 'forchetta setup --yes --app-dir /Applications'],
  },
  run: {
    summary: 'Start Claude Code in tmux, where Forchetta shows it and sends it commands',
    usage: 'forchetta run claude [claude arguments]',
    about: [
      'Starts Claude Code in the tmux of Forchetta and attaches this terminal to it: it looks and works like claude.',
      'Detach with Ctrl-b d, or close the window: the session goes on, and Forchetta keeps showing it.',
    ],
    examples: ['forchetta run claude', 'forchetta run claude --continue', 'forchetta run claude "fix the failing test"'],
  },
  ls: {
    summary: 'List the Claude Code sessions and their state',
    usage: 'forchetta ls [--json]',
    about: [
      'One line per session the daemon knows: state, what it does, context and prompt cache (from arricurdAI),',
      'whether Forchetta can send it commands (tmux) or only show it (read only).',
    ],
    options: [{ name: '--json', text: 'The sessions as JSON, for scripts and jq (times in ms since 1970)' }],
    examples: ['forchetta ls', `forchetta ls --json | jq -r '.[] | select(.state == "waiting") | .project'`],
  },
  daemon: {
    summary: 'Manage the local daemon (sessions never stop with it)',
    usage: 'forchetta daemon <start|stop|status>',
    actions: [
      { name: 'start', text: 'Start the daemon, unless it is running' },
      { name: 'stop', text: 'Stop it: the Claude and tmux sessions go on' },
      { name: 'status', text: 'Whether it runs, for how long and with how many sessions (exit code 1 when not)' },
    ],
  },
  hooks: {
    summary: 'Add or remove the hooks in ~/.claude/settings.json',
    usage: 'forchetta hooks <install|uninstall> [--yes] [--diff]',
    about: ['Shows what it changes and asks first (d shows the whole diff); keeps a copy of the old file.'],
    actions: [
      { name: 'install', text: 'Add the hooks of Forchetta, and put its status line in front of yours' },
      { name: 'uninstall', text: 'Remove them, and give you back the status line you had' },
    ],
    options: [
      { name: '--yes', text: 'Apply the changes without asking' },
      { name: '--diff', text: 'Show the whole diff before asking' },
    ],
  },
};

const LIST: Entry[] = [
  { name: 'setup', text: COMMANDS.setup!.summary },
  { name: 'run', args: 'claude [arguments]', text: COMMANDS.run!.summary },
  { name: 'ls', text: COMMANDS.ls!.summary },
  { name: 'daemon', args: 'start|stop|status', text: COMMANDS.daemon!.summary },
  { name: 'hooks', args: 'install|uninstall', text: COMMANDS.hooks!.summary },
];

const GLOBAL_OPTIONS: Entry[] = [
  { name: '-h, --help', text: 'Show this help; `forchetta <command> --help` for a command' },
  { name: '-V, --version', text: 'Show the version' },
];

export const COMMAND_NAMES = Object.keys(COMMANDS);

/** `code` in Claude orange: what you can type. Without colors the backticks just go. */
export const code = (text: string, style: Style): string => text.replace(/`([^`]+)`/g, (_, inner: string) => style.claude(inner));

function entries(list: readonly Entry[], style: Style, width: number): string {
  return list
    .map((entry) => {
      const typed = entry.args ? `${entry.name} ${entry.args}` : entry.name;
      const painted = entry.args ? `${style.claude(entry.name)} ${entry.args}` : style.claude(entry.name);
      return `  ${painted}${' '.repeat(width - typed.length)}  ${code(entry.text, style)}`;
    })
    .join('\n');
}

const widthOf = (...lists: (readonly Entry[] | undefined)[]): number =>
  Math.max(...lists.flatMap((list) => (list ?? []).map((entry) => (entry.args ? `${entry.name} ${entry.args}` : entry.name).length)));

const section = (title: string, body: string, style: Style): string => `${style.bold(title)}\n${body}`;

const examples = (list: readonly string[], style: Style): string => list.map((line) => `  ${style.dim('$')} ${line}`).join('\n');

const header = (style: Style, title: string, text: string): string => `${style.bold(style.claude(title))} ${style.dim(VERSION)}\n${text}`;

export function mainHelp(style: Style): string {
  const width = widthOf(LIST, GLOBAL_OPTIONS);
  return `${[
    header(style, 'forchetta', 'Control center for parallel Claude Code sessions, on your Mac'),
    section('Usage', '  forchetta <command> [options]', style),
    section('Commands', entries(LIST, style, width), style),
    section('Options', entries(GLOBAL_OPTIONS, style, width), style),
    section('Examples', examples(['forchetta setup', 'forchetta run claude --continue', 'forchetta ls'], style), style),
    `${style.bold('Docs')}  ${HOMEPAGE}`,
  ].join('\n\n')}\n`;
}

export function commandHelp(name: string, style: Style): string | undefined {
  const help = COMMANDS[name];
  if (!help) return undefined;
  const width = widthOf(help.actions, help.options);
  const parts = [header(style, `forchetta ${name}`, help.summary), section('Usage', `  ${help.usage}`, style)];
  if (help.about) parts.push(help.about.map((line) => code(line, style)).join('\n'));
  if (help.actions) parts.push(section('Actions', entries(help.actions, style, width), style));
  if (help.options) parts.push(section('Options', entries(help.options, style, width), style));
  if (help.examples) parts.push(section('Examples', examples(help.examples, style), style));
  return `${parts.join('\n\n')}\n`;
}

/** Words people type for a command that has another name here. */
const ALIASES: Record<string, string> = {
  list: 'ls',
  ps: 'ls',
  sessions: 'ls',
  status: 'daemon status',
  start: 'daemon start',
  stop: 'daemon stop',
  install: 'setup',
  init: 'setup',
  uninstall: 'hooks uninstall',
  claude: 'run claude',
  version: '--version',
};

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** The name closest to a mistyped word: "daemon" for "deamon", "--yes" for "--yse", "status" for "stat"; undefined when none is close. */
export function closest(typed: string, names: readonly string[]): string | undefined {
  const word = typed.toLowerCase();
  // The start of a single name is that name: "stat" is status, not start.
  const starts = names.filter((name) => word.length >= 2 && name.startsWith(word));
  if (starts.length === 1) return starts[0];
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const d = distance(word, name);
    if (d <= (name.length <= 3 ? 1 : 2) && (!best || d < best.distance)) best = { name, distance: d };
  }
  return best?.name;
}

/** The command you probably meant: "forchetta ls" for "list" or "lss"; undefined when none is close. */
export function suggestCommand(typed: string): string | undefined {
  const alias = ALIASES[typed.toLowerCase()];
  if (alias) return `forchetta ${alias}`;
  const name = closest(typed, COMMAND_NAMES);
  return name ? `forchetta ${name}` : undefined;
}
