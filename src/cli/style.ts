import { homedir } from 'node:os';

// How the CLI looks: the colors of the app, in the terminal. As in the app, amber, green and red mean a state and
// nothing else; Claude orange marks what you can type. Colors (and the symbols that go with them) only on a
// terminal, never with NO_COLOR (no-color.org) or TERM=dumb; FORCE_COLOR forces them, FORCE_COLOR=0 turns them
// off. 24-bit colors where the terminal says it has them (COLORTERM); else the closest of the 256, which
// Terminal.app of macOS 12 shows.

/** 0: no color, 1: the 256 colors, 2: 24-bit colors. */
export type ColorLevel = 0 | 1 | 2;

export function colorLevel(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): ColorLevel {
  const force = env.FORCE_COLOR;
  if (force === '0' || force === 'false') return 0;
  if (force === undefined) {
    if (env.NO_COLOR) return 0;
    if (!stream.isTTY || env.TERM === 'dumb') return 0;
  }
  return /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '') || force === '3' ? 2 : 1;
}

type Paint = (text: string) => string;

/** The colors of src/ui/styles.css, each with its closest of the 256. */
const COLORS = {
  claude: { rgb: [217, 119, 87], ansi: 173 },
  amber: { rgb: [240, 164, 60], ansi: 215 },
  green: { rgb: [70, 196, 138], ansi: 78 },
  red: { rgb: [239, 91, 91], ansi: 203 },
  gray: { rgb: [139, 134, 125], ansi: 245 },
} as const;

export type Tone = keyof typeof COLORS;

export interface Style {
  readonly color: boolean;
  readonly claude: Paint;
  readonly amber: Paint;
  readonly green: Paint;
  readonly red: Paint;
  /** Secondary: labels, ids, what is not there. */
  readonly dim: Paint;
  readonly bold: Paint;
  /** A symbol and a space in front of the text, only with colors: "✓ text". */
  readonly mark: (symbol: string, tone: Tone | undefined, text: string) => string;
}

export function makeStyle(level: ColorLevel): Style {
  const color = (name: Tone): Paint => {
    if (level === 0) return (text) => text;
    const { rgb, ansi } = COLORS[name];
    const open = level === 2 ? `\u001b[38;2;${rgb.join(';')}m` : `\u001b[38;5;${ansi}m`;
    return (text) => `${open}${text}\u001b[39m`;
  };
  const style: Style = {
    color: level > 0,
    claude: color('claude'),
    amber: color('amber'),
    green: color('green'),
    red: color('red'),
    dim: color('gray'),
    bold: level === 0 ? (text) => text : (text) => `\u001b[1m${text}\u001b[22m`,
    mark: (symbol, tone, text) => (level === 0 ? text : `${tone ? style[tone === 'gray' ? 'dim' : tone](symbol) : symbol} ${text}`),
  };
  return style;
}

export const plain = makeStyle(0);

export const styleFor = (stream: { isTTY?: boolean }): Style => makeStyle(colorLevel(stream, process.env));

/** The visible length of a text, without the escape codes of colors. */
export const visibleLength = (text: string): number => text.replace(/\u001b\[[0-9;]*m/g, '').length;

/** A path to show, with ~ for the home folder: never for a command to copy, where ~ inside quotes stays ~. */
export function tildify(path: string, home = homedir()): string {
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Labels and values in two aligned columns: "  pid      63659". */
export function pairs(rows: readonly (readonly [string, string])[], style: Style, indent = 2): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${' '.repeat(indent)}${style.dim(label.padEnd(width))}  ${value}`).join('\n');
}

/** A unified diff with + in green, - in red and the positions dimmed. */
export function paintDiff(diff: string, style: Style): string {
  if (!style.color) return diff;
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return style.bold(line);
      if (line.startsWith('@@')) return style.dim(line);
      if (line.startsWith('+')) return style.green(line);
      if (line.startsWith('-')) return style.red(line);
      return line;
    })
    .join('\n');
}

/** The stars of the spinner of Claude Code, there and back: all in Menlo, unlike the Braille dots. */
const STARS = ['·', '✢', '✳', '✶', '✻', '✽'];
const FRAMES = [...STARS, ...STARS.slice(1, -1).reverse()];

/**
 * A line that spins while something runs, on a terminal (live) with colors; elsewhere the text is printed once. The
 * work must not block the event loop (an async spawn, not spawnSync), or the line stands still.
 */
export function spinner(text: string, style: Style, write: (text: string) => void, live: boolean): { stop: () => void } {
  if (!style.color || !live) {
    write(`${text}\n`);
    return { stop: () => {} };
  }
  let frame = 0;
  const draw = (): void => write(`\r\u001b[2K${style.claude(FRAMES[frame++ % FRAMES.length]!)} ${text}`);
  draw();
  const timer = setInterval(draw, 120);
  return {
    stop: () => {
      clearInterval(timer);
      write('\r\u001b[2K');
    },
  };
}
