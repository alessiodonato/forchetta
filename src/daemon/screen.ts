// What the screen of Claude Code shows where you type, read from `tmux capture-pane -p -e` (with the attributes).
//
// The input box of Claude Code 2.1.322 is the area between the last two horizontal rules at the bottom of the
// screen, and starts with "❯". Its placeholder ("Try …") and its suggestions are drawn dim (SGR 2): everything
// else in the box was typed by someone. When the box is not there, Claude shows something else in its place: a
// dialog, the answer of /btw, a menu. Verified on real captures, see test/fixtures/screens.

export interface PromptBox {
  /** The input box is on screen, ready for typing. */
  found: boolean;
  /** What is typed in it, without the dim placeholder and suggestions, on one line. */
  typed: string;
}

const SGR = /\u001b\[([0-9;]*)m/g;
/** A rule; a session with a name (claude --name) has it in the rule above the box: "──── developer ─". */
const RULE = /^─{10,}(?: \S.* ─+)?$/;
/** A line of box drawing only: the rest of a rule wrapped by a resize. */
const DRAWING = /^[─│┌┐└┘├┤┬┴┼╭╮╯╰\s]*$/;

const plain = (line: string): string => line.replace(SGR, '').replace(/\s+$/, '');

/** The text of a line without its dim parts. */
function bright(line: string): string {
  let dim = false;
  let out = '';
  let last = 0;
  for (const match of line.matchAll(SGR)) {
    if (!dim) out += line.slice(last, match.index);
    const codes = (match[1] ?? '').split(';');
    if (codes.includes('2')) dim = true;
    else if (match[1] === '' || codes.includes('0') || codes.includes('22')) dim = false;
    last = (match.index ?? 0) + match[0].length;
  }
  if (!dim) out += line.slice(last);
  return out;
}

export function readPromptBox(capture: string): PromptBox {
  const lines = capture.split('\n');
  const rules: number[] = [];
  lines.forEach((line, index) => {
    if (RULE.test(plain(line).trim())) rules.push(index);
  });
  if (rules.length < 2) return { found: false, typed: '' };
  const box = lines.slice(rules[rules.length - 2]! + 1, rules[rules.length - 1]).filter((line) => !DRAWING.test(plain(line)));
  const first = box[0];
  if (first === undefined || !plain(first).trimStart().startsWith('❯')) return { found: false, typed: '' };
  const typed = box
    .map((line, index) => {
      const text = bright(line);
      return index === 0 ? text.replace(/^\s*❯/, '') : text;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { found: true, typed };
}

/** Whether the screen shows a line with this text (the question of /btw in its answer box, for example). */
export function screenShows(capture: string, text: string): boolean {
  const flat = capture
    .split('\n')
    .map(plain)
    .join(' ')
    .replace(/\s+/g, ' ');
  return flat.includes(text.replace(/\s+/g, ' ').trim());
}
