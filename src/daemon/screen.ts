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

/**
 * Whether the screen shows the question Claude Code asks at /exit of a session in a worktree with commits or
 * changes, with "Keep worktree" chosen (verified with 2.1.328):
 *
 *   Exiting worktree session
 *   You have 1 commit on worktree-developer. The branch will be deleted if you remove the worktree.
 *   ❯ 1. Keep worktree    Stays at …/.claude/worktrees/developer
 *     2. Remove worktree  All changes and commits will be lost.
 *
 * Only then Enter keeps it: the worktree and its branch stay, with the work in them.
 */
export function keepsWorktree(capture: string): boolean {
  const lines = capture.split('\n').map(plain);
  if (!lines.some((line) => line.trim() === 'Exiting worktree session')) return false;
  const keep = lines.some((line) => /^\s*❯\s*1\.\s*Keep worktree\b/.test(line));
  const remove = lines.some((line) => /^\s*❯\s*\d+\.\s*Remove worktree\b/.test(line));
  return keep && !remove;
}

/**
 * What the menu under the input box offers for "/restart": its own line, the chosen one (verified with 2.1.328):
 *
 *   ❯ /restart                    Restart on 2.1.331 and keep this session
 *     /deep-research              [dynamic workflow] …
 *
 * 'newer': a restart would bring the version installed. 'same': the session is already on it. Anything else is not
 * the command of Claude Code (one of yours with the same name, or a version without it, where Enter would take the
 * first line of the menu, whatever it is).
 */
export function restartOffer(capture: string): 'newer' | 'same' | undefined {
  const lines = capture.split('\n').map(plain);
  // Below the input box only: the conversation above it can hold any text.
  const box = lines.findLastIndex((line) => RULE.test(line.trim()));
  for (const line of box < 0 ? [] : lines.slice(box + 1)) {
    const what = /^\s*❯\s*\/restart\s{2,}(\S.*)$/.exec(line)?.[1];
    if (what === undefined) continue;
    if (/^Restart on v?\d+\./.test(what)) return 'newer';
    if (/^Restart Claude Code/.test(what)) return 'same';
    return undefined;
  }
  return undefined;
}

/**
 * What Claude Code last answered to a /restart on this screen:
 *
 *   ❯ /restart
 *     ⎿  Can't restart while work is running in the background. Wait for it to finish or stop it in /tasks, then
 *        try again.
 */
export function restartAnswer(capture: string): string | undefined {
  const lines = capture.split('\n').map(plain);
  let answer: string | undefined;
  lines.forEach((line, index) => {
    if (!/^❯\s*\/restart$/.test(line)) return;
    const first = /^\s+⎿\s+(\S.*)$/.exec(lines[index + 1] ?? '')?.[1];
    if (first === undefined) return;
    const rest: string[] = [];
    for (let next = index + 2; /^\s{3,}\S/.test(lines[next] ?? ''); next++) rest.push(lines[next]!.trim());
    answer = [first, ...rest].join(' ');
  });
  return answer;
}

/** The answers of Claude Code to a /restart that worked. */
export const restartWorked = (answer: string): boolean => /^(Successfully (updated|downgraded)|Session resumed)/.test(answer);

/** Whether the screen shows a line with this text (the question of /btw in its answer box, for example). */
export function screenShows(capture: string, text: string): boolean {
  const flat = capture
    .split('\n')
    .map(plain)
    .join(' ')
    .replace(/\s+/g, ' ');
  return flat.includes(text.replace(/\s+/g, ' ').trim());
}
