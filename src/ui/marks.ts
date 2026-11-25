import type { Terminal } from '@xterm/xterm';

// Your messages in the terminal of a session: a bar on their left and a light band, so that they stand out from the
// answers. Claude Code paints each line of them on a background of its own, all the way across, the first with ❯: that is
// how they are found, on what is on the screen now. Nothing is written in the terminal, and nothing is read from it
// beyond the first cell of each line.

/** The first cell of a line of the screen. */
export interface FirstCell {
  text: string;
  background: 'default' | 'palette' | 'rgb';
  color: number;
}

/**
 * The backgrounds of your messages and of what you run with !, as Claude Code 2.1.332 sends them: in tmux as indices of the
 * 256 (238 is under the mouse), outside it as colors; on its dark theme, then on its light one.
 */
const PALETTE = new Set([237, 238, 59, 255, 231]);
const RGB = new Set([0x373737, 0x413c41, 0xf0f0f0, 0xfaf5fa]);

const isGray = (color: number): boolean => {
  const parts = [color >> 16, (color >> 8) & 255, color & 255];
  return Math.max(...parts) - Math.min(...parts) <= 8;
};

/** Whether a line starts on the background of your messages; ❯ on any gray is one too, of a theme not listed here. */
function isMine(cell: FirstCell | undefined): boolean {
  if (!cell || cell.background === 'default') return false;
  if (cell.background === 'palette') return PALETTE.has(cell.color);
  return RGB.has(cell.color) || (cell.text === '❯' && isGray(cell.color));
}

/** The lines of your messages on the screen: the first and the last of each run, from 0. */
export function messageRows(cells: readonly (FirstCell | undefined)[]): { top: number; bottom: number }[] {
  const runs: { top: number; bottom: number }[] = [];
  let open: { top: number; bottom: number; color: number } | undefined;
  for (const [row, cell] of cells.entries()) {
    const goesOn = open && cell && cell.background !== 'default' && cell.color === open.color && cell.text !== '❯';
    if (open && goesOn) {
      open.bottom = row;
      continue;
    }
    if (open) runs.push({ top: open.top, bottom: open.bottom });
    open = isMine(cell) ? { top: row, bottom: row, color: cell!.color } : undefined;
  }
  if (open) runs.push({ top: open.top, bottom: open.bottom });
  return runs;
}

/** The marks over a terminal. They follow what it draws, once for each frame, and cost nothing while it draws nothing. */
export function markMessages(term: Terminal, shown: () => boolean): { update: () => void; dispose: () => void } {
  const layer = document.createElement('div');
  layer.className = 'message-marks';
  layer.setAttribute('aria-hidden', 'true');
  let frame = 0;
  let drawn = '';
  const draw = (): void => {
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    // Beside xterm.js, not in it: the bar is in the margin of the pane, which xterm.js would cut away.
    const host = term.element?.parentElement;
    if (!screen || !host) return;
    if (layer.parentElement !== host) host.append(layer);
    const runs: { top: number; bottom: number }[] = [];
    if (shown()) {
      const buffer = term.buffer.active;
      const cells: (FirstCell | undefined)[] = [];
      for (let row = 0; row < term.rows; row++) {
        const cell = buffer.getLine(buffer.viewportY + row)?.getCell(0);
        cells.push(cell ? { text: cell.getChars(), background: cell.isBgRGB() ? 'rgb' : cell.isBgPalette() ? 'palette' : 'default', color: cell.getBgColor() } : undefined);
      }
      runs.push(...messageRows(cells));
    }
    const height = screen.clientHeight / term.rows;
    layer.style.width = `${screen.clientWidth}px`;
    const next = `${height}|${runs.map((run) => `${run.top}-${run.bottom}`).join(',')}`;
    if (next === drawn) return;
    drawn = next;
    while (layer.childElementCount > runs.length) layer.lastElementChild!.remove();
    while (layer.childElementCount < runs.length) layer.append(document.createElement('i'));
    for (const [index, run] of runs.entries()) {
      const mark = layer.children[index] as HTMLElement;
      mark.style.top = `${Math.round(run.top * height)}px`;
      mark.style.height = `${Math.round((run.bottom - run.top + 1) * height)}px`;
    }
  };
  const soon = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };
  const listeners = [term.onRender(soon), term.onResize(soon), term.onScroll(soon)];
  soon();
  return {
    update: soon,
    dispose: () => {
      cancelAnimationFrame(frame);
      for (const listener of listeners) listener.dispose();
      layer.remove();
    },
  };
}
