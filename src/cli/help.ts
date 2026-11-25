import { VERSION } from '../shared/version.ts';
import { MACHINE } from '../shared/machine.ts';
import { PLATFORM } from '../shared/platform.ts';
import type { Style } from './style.ts';

// The help of `forchetta` and of each command, and the command you probably meant when you mistype one.

export const HOMEPAGE = 'https://forchetta.dev/manual.html';

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
    summary: PLATFORM === 'macos' ? 'Get Forchetta ready: build the app and install the hooks' : 'Get Forchetta ready: check what it needs and install the hooks',
    usage: 'forchetta setup [options]',
    about:
      PLATFORM === 'macos'
        ? [
            'Checks tmux, Claude Code and the Command Line Tools, builds the app in ~/Applications, then adds',
            'the hooks to ~/.claude/settings.json: it shows what it changes and asks first (d shows the whole diff).',
            'Run it again after every `brew upgrade forchetta`: it builds the app again only when it changed.',
          ]
        : [
            `Checks Node.js, ${PLATFORM === 'windows' ? 'git' : 'tmux, curl'}, the terminals and Claude Code, then adds the hooks to ~/.claude/settings.json: it`,
            'shows what it changes and asks first (d shows the whole diff). Run it again after every upgrade.',
          ],
    options: [
      { name: '--yes', text: 'Install the hooks without asking (a script needs it: with no terminal it changes nothing, exit code 2)' },
      // Only a Mac has an app to build. Elsewhere the two options do nothing.
      ...(PLATFORM === 'macos' ? [{ name: '--force', text: 'Build the app again, even when it is up to date' }] : []),
      { name: '--diff', text: 'Show the whole diff of ~/.claude/settings.json before asking' },
      ...(PLATFORM === 'macos' ? [{ name: '--app-dir', args: '<folder>', text: 'Where the app goes (default: ~/Applications)' }] : []),
      { name: '--no-restart', text: 'Leave a daemon of another version running (by default it starts again on this one)' },
    ],
    examples: ['forchetta setup', PLATFORM === 'macos' ? 'forchetta setup --yes --app-dir /Applications' : 'forchetta setup --yes'],
  },
  open: {
    summary: PLATFORM === 'macos' ? 'Open the app' : PLATFORM === 'windows' ? 'Open the window of Forchetta' : 'Open Forchetta in a browser',
    usage: PLATFORM === 'macos' ? 'forchetta open' : 'forchetta open [--print]',
    about:
      PLATFORM === 'macos'
        ? ['Opens the app `forchetta setup` built.']
        : [
            PLATFORM === 'windows'
              ? 'Opens the window of Forchetta: the page in Edge or Chrome, with no tabs and no extensions. It starts the'
              : 'Opens the page in a browser (in WSL, one of Windows: Edge or Chrome, in a window of its own). It starts the',
            'daemon when it is off. The address has a code good once, for two minutes.',
          ],
    ...(PLATFORM === 'macos' ? {} : { options: [{ name: '--print', text: 'Only print the address, to open by hand' }] }),
    examples: PLATFORM === 'macos' ? ['forchetta open'] : ['forchetta open', 'forchetta open --print'],
  },
  run: {
    summary: PLATFORM === 'windows' ? 'Start Claude Code where Forchetta shows it and sends it commands' : 'Start Claude Code in tmux, where Forchetta shows it and sends it commands',
    usage: 'forchetta run claude [claude arguments]',
    about: [
      `Starts Claude Code in ${PLATFORM === 'windows' ? 'a session' : 'the tmux'} of Forchetta and attaches this terminal to it: it looks and works like claude.`,
      'Detach with Ctrl-b d, or close the window: the session goes on, and Forchetta keeps showing it.',
    ],
    examples: ['forchetta run claude', 'forchetta run claude --continue', 'forchetta run claude "fix the failing test"'],
  },
  ls: {
    summary: 'List the Claude Code sessions and their state',
    usage: 'forchetta ls [--json]',
    about: [
      'One line per session the daemon knows: state, what it does, context (from Claude Code, or estimated by',
      'arricurdAI), prompt cache (from arricurdAI), whether Forchetta can send it commands (tmux) or only show it',
      '(read only).',
    ],
    options: [{ name: '--json', text: 'The sessions as JSON, for scripts and jq (times in ms since 1970)' }],
    examples: ['forchetta ls', `forchetta ls --json | jq -r '.[] | select(.state == "waiting") | .project'`],
  },
  stats: {
    summary: `What the guard did on this ${MACHINE} in the last days`,
    usage: 'forchetta stats [--days N] [--json]',
    about: [
      'Counts by kind: edits stopped while another session changed the file, git commands asked, notes before',
      `tests, sessions going in circles… Only counts are kept, on this ${MACHINE}: no file, command or name.`,
    ],
    options: [
      { name: '--days', args: '<N>', text: 'How many days, today included (default: 7, at most 120)' },
      { name: '--json', text: 'The counts as JSON, for scripts' },
    ],
    examples: ['forchetta stats', 'forchetta stats --days 30'],
  },
  report: {
    summary: `What the sessions and the teams did and cost, from the ledger of this ${MACHINE}`,
    usage: 'forchetta report [--since 7d] [--by team|session|project|model|day] [--csv|--json]',
    about: [
      'The daemon writes a line for each turn, cost, file written, step of the guard, request and review in',
      'the ledger (one file a month in the private folder of Forchetta); this command reads it, also with the daemon off.',
    ],
    options: [
      { name: '--since', args: '<24h|7d|4w|date>', text: 'From when (default: 7d, today and the 6 days before)' },
      { name: '--by', args: '<what>', text: 'One row per team (default), session, project, model or day' },
      { name: '--team', args: '"<name>"', text: 'Only this team' },
      { name: '--csv', text: 'The rows as CSV, for a spreadsheet' },
      { name: '--json', text: 'The rows as JSON, for scripts' },
    ],
    examples: ['forchetta report', 'forchetta report --since 30d --by model', 'forchetta report --since 2026-11-01 --by day --csv > november.csv'],
  },
  doctor: {
    summary: 'Check the installation, say what to fix; --bundle writes a file for an issue',
    usage: 'forchetta doctor [--bundle] [--json]',
    about: [
      `Node.js, the daemon and its version, the hooks and the status line, ${PLATFORM === 'windows' ? 'the terminals' : 'tmux'}, Claude Code and the version it was`,
      'tested with, the optional features, files set aside, and the warnings of the log of the last day.',
    ],
    options: [
      { name: '--bundle', text: 'Also write forchetta-doctor-<date>.tar.gz here, with names, paths, e-mails and tokens replaced' },
      { name: '--out', args: '<folder>', text: 'Where the bundle goes (default: this folder)' },
      { name: '--json', text: 'The findings as JSON' },
    ],
    examples: ['forchetta doctor', 'forchetta doctor --bundle'],
  },
  daemon: {
    summary: 'Manage the local daemon (sessions never stop with it)',
    usage: 'forchetta daemon <start|stop|status|keepalive on|off>',
    actions: [
      { name: 'start', text: 'Start the daemon, unless it is running' },
      { name: 'stop', text: PLATFORM === 'windows' ? 'Stop it: the sessions go on' : 'Stop it: the Claude and tmux sessions go on' },
      { name: 'status', text: 'Whether it runs, for how long and with how many sessions (exit code 1 when not)' },
      { name: 'keepalive', args: 'on|off', text: PLATFORM === 'macos' ? 'Let macOS start it at login and again if it stops by mistake (a LaunchAgent)' : 'Only on a Mac, where macOS starts it at login and again if it stops by mistake' },
    ],
  },
  team: {
    summary: 'Start a team of agents, list the teams, write a team into the repository',
    usage: 'forchetta team <ls|start|export|thread> [options]',
    about: [
      'A team file in .forchetta/teams of the repository (from Export in the studio, or `forchetta team export`) is',
      'reviewed and shared with the code. .forchetta/rules.md adds rules to every team started there; .forchetta/guard.json',
      'turns parts of the guard on or off there: {"files": true, "git": true, "notes": true, "servers": false}.',
    ],
    actions: [
      { name: 'ls', args: '[--json] [--templates]', text: 'The teams that run, each session with its state; --templates: what start can start' },
      { name: 'start', args: '<name|file>', text: 'Start a team: a file of .forchetta/teams, a path, or one of your templates' },
      { name: 'export', args: '<template|team>', text: 'Write it to .forchetta/teams/<name>.forchetta-team.json (--out elsewhere, --stdout)' },
      { name: 'thread', args: '<team> [--json]', text: 'Every request, question, answer and review of a team, as Markdown' },
    ],
    options: [
      { name: '--goal', args: '"<text>"', text: 'start: the first request, to the lead (to every member when you lead)' },
      { name: '--set', args: '<name>=<value>', text: 'start: the value of a parameter of the team, {name} in its texts (once for each)' },
      { name: '--cwd', args: '<folder>', text: 'start: the folder of the team (default: this one)' },
      { name: '--name', args: '"<name>"', text: 'start: another name for the team' },
      { name: '--budget', args: '<dollars>', text: 'start: what it may cost before you are told (a warning, not a limit)' },
      { name: '--skills', args: 'fetch|skip', text: 'start: for a file with skills from GitHub, without asking' },
    ],
    examples: ['forchetta team start review-squad --goal "Add a CSV export to the orders page"', 'forchetta team start bugfix --set ticket=APP-123 --goal "Fix {ticket}"', 'forchetta team export "Feature squad"', 'forchetta team ls --json | jq \'.[] | {name, usd}\''],
  },
  reopen: {
    summary: `Reopen the sessions that ended with the ${MACHINE}, each on its conversation`,
    usage: 'forchetta reopen [--all | <name>…] [--json]',
    about: [
      `A restart of the ${MACHINE} closes every session. Forchetta remembers them for a week: each one reopens on its`,
      'conversation (claude --resume), in its folder, with its name; a member of a team goes back into its team.',
      'Claude reads the whole conversation again at its first message: a large one costs a share of your limits.',
    ],
    options: [
      { name: '--all', text: 'Reopen every one' },
      { name: '--json', text: 'The list, or what reopened, as JSON' },
    ],
    examples: ['forchetta reopen', 'forchetta reopen --all', 'forchetta reopen api "Checkout team"'],
  },
  auto: {
    summary: 'The teams that start by themselves: a queue, a time, GitHub',
    usage: 'forchetta auto <ls|add|pause|resume> [options]',
    about: [
      'Made in the app ("+ new" → "automatic team"): a template, a folder, how it starts, the goal of each run, what a run',
      'may cost and how long it may take. The runs go one at a time, each a new team; a run is over when its lead delivers.',
    ],
    actions: [
      { name: 'ls', args: '[--json]', text: 'Each automation: the run at work, what waits and why, the last run' },
      { name: 'add', args: '<name> [item…]', text: 'Items into a queue, one per argument; a run of a schedule now; GitHub looked at now' },
      { name: 'pause', args: '<name>', text: 'Nothing new starts; the run at work goes on' },
      { name: 'resume', args: '<name>', text: 'It goes on, also after a run that failed paused it' },
    ],
    examples: ['forchetta auto ls', 'forchetta auto add fixes APP-42 APP-43', 'forchetta auto resume nightly'],
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
      { name: '--yes', text: 'Apply the changes without asking (a script needs it: with no terminal it changes nothing, exit code 2)' },
      { name: '--diff', text: 'Show the whole diff before asking' },
    ],
  },
};

const LIST: Entry[] = [
  { name: 'setup', text: COMMANDS.setup!.summary },
  { name: 'open', text: COMMANDS.open!.summary },
  { name: 'run', args: 'claude [arguments]', text: COMMANDS.run!.summary },
  { name: 'ls', text: COMMANDS.ls!.summary },
  { name: 'reopen', args: '[--all|<name>…]', text: COMMANDS.reopen!.summary },
  { name: 'stats', text: COMMANDS.stats!.summary },
  { name: 'team', args: 'ls|start|export|thread', text: COMMANDS.team!.summary },
  { name: 'auto', args: 'ls|add|pause|resume', text: COMMANDS.auto!.summary },
  { name: 'report', text: COMMANDS.report!.summary },
  { name: 'doctor', text: COMMANDS.doctor!.summary },
  { name: 'daemon', args: 'start|stop|status|keepalive', text: COMMANDS.daemon!.summary },
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
    header(style, 'forchetta', `Control center for parallel Claude Code sessions, on your ${MACHINE}`),
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
