// Line diffs for the demo: the patch of an edit, as Claude Code reports it (structuredPatch), and the diff since
// the last commit, as git prints it. The files of the demo are small: a plain LCS table is enough.

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

const linesOf = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** Each line of the old and new text, kept (' '), removed ('-') or added ('+'), in order. */
function ops(a: string[], b: string[]): Array<{ op: ' ' | '-' | '+'; line: string; ai: number; bi: number }> {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: Array<{ op: ' ' | '-' | '+'; line: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) out.push({ op: ' ', line: a[i]!, ai: i++, bi: j++ });
    else if (j < m && (i >= n || table[i]![j + 1]! >= table[i + 1]![j]!)) out.push({ op: '+', line: b[j]!, ai: i, bi: j++ });
    else out.push({ op: '-', line: a[i]!, ai: i++, bi: j });
  }
  return out;
}

/** The hunks between two texts, with three lines of context around each change. */
export function hunks(before: string, after: string, context = 3): Hunk[] {
  const list = ops(linesOf(before), linesOf(after));
  const changed = list.map((item, index) => (item.op === ' ' ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return [];
  const out: Hunk[] = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(list.length - 1, changed[0]! + context);
  const flush = (): void => {
    const slice = list.slice(start, end + 1);
    const first = slice[0]!;
    const oldLines = slice.filter((item) => item.op !== '+').length;
    const newLines = slice.filter((item) => item.op !== '-').length;
    out.push({ oldStart: oldLines ? first.ai + 1 : first.ai, oldLines, newStart: newLines ? first.bi + 1 : first.bi, newLines, lines: slice.map((item) => item.op + item.line) });
  };
  for (const index of changed.slice(1)) {
    if (index - context <= end + 1) end = Math.min(list.length - 1, index + context);
    else {
      flush();
      start = Math.max(0, index - context);
      end = Math.min(list.length - 1, index + context);
    }
  }
  flush();
  return out;
}

/** Lines added and removed between two texts. */
export function counts(before: string, after: string): { added: number; removed: number } {
  const list = ops(linesOf(before), linesOf(after));
  return { added: list.filter((item) => item.op === '+').length, removed: list.filter((item) => item.op === '-').length };
}

/** A diff as git prints it, for one file. */
export function gitDiff(name: string, before: string | undefined, after: string | undefined): string {
  if (before === after) return '';
  const head = [`diff --git a/${name} b/${name}`];
  if (before === undefined) head.push('new file mode 100644', 'index 0000000..3b18e51', '--- /dev/null', `+++ b/${name}`);
  else if (after === undefined) head.push('deleted file mode 100644', 'index 3b18e51..0000000', `--- a/${name}`, '+++ /dev/null');
  else head.push('index 8f3c2a1..3b18e51 100644', `--- a/${name}`, `+++ b/${name}`);
  const body = hunks(before ?? '', after ?? '').flatMap((hunk) => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines]);
  return `${[...head, ...body].join('\n')}\n`;
}
