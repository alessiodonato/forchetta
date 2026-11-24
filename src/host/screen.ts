import { SerializeAddon } from '@xterm/addon-serialize';
import headless from '@xterm/headless';

// The screen of a session as its host keeps it (Windows): a terminal with no window, that reads what claude draws. From it
// come the text the daemon reads (as `tmux capture-pane -e` prints it: daemon/screen.ts reads both), and the screen a
// window that opens gets before what comes next.

/** The lines kept above the screen, as the history-limit of config/tmux.conf asks for less than tmux: they are in memory. */
export const HISTORY_LINES = 5000;
/** The history a window gets when it opens. */
const SENT_HISTORY = 2000;

export interface ScreenSize {
  cols: number;
  rows: number;
}

type Cell = { getChars(): string; getWidth(): number; isBold(): number; isDim(): number; isItalic(): number; isUnderline(): number; isInverse(): number; isFgRGB(): boolean; isFgPalette(): boolean; getFgColor(): number; isBgRGB(): boolean; isBgPalette(): boolean; getBgColor(): number };

/** The SGR codes of a cell: "1;38;5;174", or nothing for plain text. */
function sgr(cell: Cell): string {
  const codes: number[] = [];
  if (cell.isBold()) codes.push(1);
  if (cell.isDim()) codes.push(2);
  if (cell.isItalic()) codes.push(3);
  if (cell.isUnderline()) codes.push(4);
  if (cell.isInverse()) codes.push(7);
  const color = (rgb: boolean, palette: boolean, value: number, base: 38 | 48): void => {
    if (rgb) codes.push(base, 2, value >> 16, (value >> 8) & 255, value & 255);
    else if (palette) codes.push(base, 5, value);
  };
  color(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 38);
  color(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 48);
  return codes.join(';');
}

export class Screen {
  private readonly terminal: InstanceType<typeof headless.Terminal>;
  private readonly serializer = new SerializeAddon();

  /** `build`: that of Windows, so that its pseudo-terminal is read as it draws. */
  constructor(size: ScreenSize, build?: number) {
    this.terminal = new headless.Terminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: HISTORY_LINES,
      allowProposedApi: true,
      ...(build ? { windowsPty: { backend: 'conpty' as const, buildNumber: build } } : {}),
    });
    this.terminal.loadAddon(this.serializer as unknown as Parameters<typeof this.terminal.loadAddon>[0]);
  }

  get size(): ScreenSize {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  /** The program asked for pastes as one block. */
  get bracketedPaste(): boolean {
    return this.terminal.modes.bracketedPasteMode;
  }

  write(data: string): void {
    this.terminal.write(data);
  }

  /** Calls back when everything written so far is on the screen. */
  settled(done: () => void): void {
    this.terminal.write('', done);
  }

  /** What the terminal answers to the questions of a program (where the cursor is, what it can do). */
  onReply(listener: (data: string) => void): void {
    this.terminal.onData(listener);
  }

  resize(size: ScreenSize): void {
    this.terminal.resize(size.cols, size.rows);
  }

  /** The screen, with so many lines of what scrolled off it: lines with their styles. */
  capture(history: number): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = Math.max(0, buffer.baseY - history); row < buffer.baseY + this.terminal.rows; row++) lines.push(this.line(row));
    return `${lines.join('\n')}\n`;
  }

  private line(row: number): string {
    const line = this.terminal.buffer.active.getLine(row);
    if (!line) return '';
    let out = '';
    let style = '';
    let text = '';
    const flush = (next: string): void => {
      out += text;
      if (style) out += '\u001b[0m';
      if (next) out += `\u001b[${next}m`;
      text = '';
      style = next;
    };
    for (let x = 0; x < this.terminal.cols; x++) {
      const cell = line.getCell(x) as Cell | undefined;
      // The second half of a wide character.
      if (!cell || cell.getWidth() === 0) continue;
      const next = sgr(cell);
      if (next !== style) flush(next);
      text += cell.getChars() || ' ';
    }
    flush('');
    return out.replace(/\s+$/, '');
  }

  /** The screen and its modes, as what draws them in an empty terminal of the same size. */
  snapshot(): string {
    return this.serializer.serialize({ scrollback: SENT_HISTORY });
  }
}
