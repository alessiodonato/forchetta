// What you select in a pane, made fit to quote to Claude, and the texts the menu of the selection sends.
//
// The selection of tmux brings along what Claude Code draws around its text: ⏺ and ⎿ before its lines, │ at the
// sides of its boxes, the rules, and the indentation that lines its text up after them. All of that goes; the text
// keeps its own indentation (code, lists), relative to its least indented line.

export const MAX_SELECTION = 10_000;
/** The longest question of /btw, in bytes: the same limit as the field of /btw in the box (daemon/commands.ts). */
export const MAX_BTW_BYTES = 1000;

/** A line of box drawing only: a rule, the top or the bottom of a box. */
const DRAWING = /^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬╌╍┄┅┈┉]+$/;

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const indentOf = (line: string): number => /^ */.exec(line)?.[0].length ?? 0;

export function cleanSelection(text: string): string {
  let lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    // Control characters but newlines: an Esc in a paste could close it early.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  lines = lines.filter((line) => !DRAWING.test(line));
  lines = lines.map((line) =>
    line
      // The sides of a box: "│ text │". The left one becomes a space, so that the text stays lined up.
      .replace(/^(\s*)[│┃]/, '$1 ')
      .replace(/\s*[│┃]$/, '')
      // ⏺ before a message or a tool, ⎿ before its result: one cell each, as a space.
      .replace(/^(\s*)[⏺⎿](?=\s|$)/, '$1 ')
      .replace(/\s+$/, ''),
  );
  const indents = lines.filter((line) => line.trim()).map(indentOf);
  const cut = indents.length > 0 ? Math.min(...indents) : 0;
  const cleaned = lines
    .map((line) => line.slice(Math.min(cut, indentOf(line))))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
  return clip(cleaned, MAX_SELECTION);
}

/** The selection as a quote: "> " before each line. */
export const quote = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');

/** On one line, without control characters. */
export const oneLine = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const encoder = new TextEncoder();
export const byteLength = (text: string): number => encoder.encode(text).length;

/** The longest start of a text that fits in so many bytes, with … when it is cut. */
export function fitBytes(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(`${text.slice(0, middle)}…`) <= max) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low).replace(/\s+$/, '')}…`;
}

/** Ask: your question, then the selection as a quote. Its first line is typed as your words (daemon/commands.ts). */
export const askText = (question: string, selection: string): string => `${question.trim()}\n\n${quote(selection)}`;

/** Send to another session: as Ask, saying which session the text comes from. */
export const sendText = (question: string, selection: string, from: string): string => `${question.trim()}\n\nFrom the session ${oneLine(from)}:\n${quote(selection)}`;

/** Put in prompt: the selection as a quote, and a new line under it for your question. */
export const insertText = (selection: string): string => `${quote(selection)}\n`;

/** /btw takes one line: the question, then the selection in quotes, cut to fit. */
export function btwText(question: string, selection: string, max = MAX_BTW_BYTES): string {
  const head = `${oneLine(question)} — about: "`;
  const room = max - byteLength(head) - byteLength('"');
  if (room < 8) return fitBytes(oneLine(question), max);
  return `${head}${fitBytes(oneLine(selection), room)}"`;
}
