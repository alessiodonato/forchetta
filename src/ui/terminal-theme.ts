import type { ITheme } from '@xterm/xterm';
import { SESSION_COLOR_HEX, type SessionColor } from '../shared/agent.ts';

// The colors of the terminal of a pane.
//
// Inside tmux (TERM=screen-256color) Claude Code does not send its own colors: chalk turns each one into the
// nearest of the 256, by a rule that blurs them. Claude orange rgb(215,119,87) becomes 174, a pink; the green and
// the red of a diff become a gray green and a brown; the purple of auto-accept and the blue of permissions become
// two almost equal lilacs. Here each index Claude Code uses (its dark theme, read from Claude Code 2.1.322) shows
// the color Claude Code meant, with the neutrals warmed to the background. The other indices keep the standard
// color, for any other program.

/**
 * Index of the 256 → the color of Claude Code it stands for. Where two colors share an index, the one listed
 * won. Indices that Claude Code shares with the colors of its syntax highlighting (167 of the red subagent, say),
 * or whose standard color is already close, are left alone.
 */
const CLAUDE_CODE: Record<number, string> = {
  // Text and neutrals, warm like the app.
  231: '#f2f0e9', // text
  235: '#262624', // composer sidebar: the background itself
  237: '#3a3935', // your messages
  238: '#44423e', // your messages, under the mouse
  239: '#5c5a54', // subtle
  244: '#8c8981', // border of the prompt
  246: '#a29e95', // inactive: tool results, hints
  247: '#b0aca3', // border of the prompt, shimmer
  250: '#c8c4bb', // inactive, shimmer
  // Claude.
  174: '#d97757', // claude (not diffRemovedWord, which shares the index)
  216: '#eb9f7f', // claude, shimmer
  // States and modes.
  114: '#4eba65', // success
  211: '#ff6b80', // error (and the border of bash mode)
  220: '#f4c142', // warning, a little softer than #ffc107
  221: '#f8d56a', // warning, shimmer
  153: '#b1b9f9', // permission, suggestion
  189: '#cfd7ff', // permission, shimmer
  147: '#af87ff', // auto-accept, skills: purple again, no longer the lilac of permissions
  73: '#48968c', // plan mode
  74: '#4782c8', // IDE
  44: '#2ec4c4', // background tasks
  208: '#ff7814', // fast mode
  215: '#ffa546', // fast mode, shimmer
  // Diffs. Those of an edit use 22 and 52 as backgrounds, pure #005f00 and #5f0000 in the standard table: here a
  // softer green and red, under the colors of the syntax.
  22: '#234a2d', // added line, in an edit
  52: '#5a2a31', // removed line, in an edit
  242: '#7a776f', // line numbers of an edit
  65: '#225c2b', // added line
  95: '#7a2936', // removed line
  72: '#38a660', // added word
  96: '#69484d', // removed line, dimmed
  // Backgrounds and the rest.
  66: '#264f78', // selection
  59: '#413c41', // bash and memory messages
  102: '#505370', // rate limit, empty
  110: '#6a9bcc', // professional blue, blue subagent
  117: '#7ab4e8', // label "you" of brief mode
};

const hex = (value: number): string => value.toString(16).padStart(2, '0');

/** The standard color of an index from 16 to 255: the 6×6×6 cube, then the ramp of grays. */
export function standard256(index: number): string {
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10;
    return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
  }
  const steps = [0, 95, 135, 175, 215, 255];
  const n = index - 16;
  return `#${hex(steps[Math.floor(n / 36)]!)}${hex(steps[Math.floor(n / 6) % 6]!)}${hex(steps[n % 6]!)}`;
}

/** Colors 16 to 255, as xterm.js wants them in extendedAnsi. */
export const extendedAnsi = (): string[] => Array.from({ length: 240 }, (_, offset) => CLAUDE_CODE[offset + 16] ?? standard256(offset + 16));

export const TERMINAL_THEME: ITheme = {
  // The dark gray of Claude.ai rather than near black: easier to read for hours, close to the boxes of the app.
  background: '#262624',
  foreground: '#f2f0e9',
  cursor: '#f2f0e9',
  cursorAccent: '#262624',
  selectionBackground: 'rgba(38, 79, 120, 0.75)',
  black: '#3a3935',
  red: '#ef5b5b',
  green: '#46c48a',
  yellow: '#e2b85c',
  blue: '#6aa7ec',
  magenta: '#c08ae0',
  cyan: '#5ec2c8',
  white: '#d6d3cb',
  brightBlack: '#8a8780',
  brightRed: '#ff7a7a',
  brightGreen: '#6bd8a3',
  brightYellow: '#f0cd7f',
  brightBlue: '#8cbcf3',
  brightMagenta: '#d2a6ee',
  brightCyan: '#82d6db',
  brightWhite: '#f8f7f3',
  extendedAnsi: extendedAnsi(),
};

/** How much of the color of a session goes into the background of its terminal: enough to tell it, little enough to read on. */
export const SESSION_TINT = 0.14;

/** A color with a part of another, both as #rrggbb. */
export function tint(base: string, color: string, amount = SESSION_TINT): string {
  const rgb = (value: string): number[] => [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
  const from = rgb(base);
  const to = rgb(color);
  return `#${from.map((channel, at) => hex(Math.round(channel + (to[at]! - channel) * amount))).join('')}`;
}

/**
 * The theme of the terminal of a session. With a color, its background is tinted with it, and so are the
 * neutrals Claude Code paints as backgrounds of their own on it (235, the background itself; 237 and 238, your
 * messages; black): untinted, they would show as gray patches.
 */
export function terminalTheme(color?: SessionColor): ITheme {
  if (!color) return TERMINAL_THEME;
  const tinted = (value: string): string => tint(value, SESSION_COLOR_HEX[color]);
  const ansi = [...extendedAnsi()];
  for (const index of [235, 237, 238]) ansi[index - 16] = tinted(ansi[index - 16]!);
  const background = tinted(TERMINAL_THEME.background!);
  return { ...TERMINAL_THEME, background, cursorAccent: background, black: tinted(TERMINAL_THEME.black!), extendedAnsi: ansi };
}
