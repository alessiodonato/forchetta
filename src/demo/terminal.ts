// A terminal of the demo: what a tmux pane is in the app. The fake Claude draws its screen here; every pane of the
// page that shows this session gets it; the keys of the page come back to the fake Claude; and the Commander of
// the daemon reads the screen and types into it through the fake tmux (demo/tmux.ts).

import type { DemoSocket } from './socket.ts';

const encoder = new TextEncoder();

export class FakeTerminal {
  cols = 100;
  rows = 30;
  /** The screen as last drawn, one string per line, with its colors. */
  lines: string[] = [];
  /** When someone last typed into it from the page: tmux's session_activity. */
  lastInput = 0;
  private readonly pages = new Set<DemoSocket>();
  ended = false;
  /** Set by the fake Claude. */
  onInput: (data: string) => void = () => {};
  onResize: () => void = () => {};

  /** A pane of the page opens this terminal. */
  attach(page: DemoSocket): void {
    if (this.ended) {
      page.end(4000);
      return;
    }
    this.pages.add(page);
    page.receive = (text) => {
      let message: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
      try {
        message = JSON.parse(text) as typeof message;
      } catch {
        return;
      }
      if (message.type === 'input' && typeof message.data === 'string') {
        // Reports of focus and of the mouse are not typing.
        if (!/^\x1b\[(?:I|O|<[\d;]+[mM]|M...)$/.test(message.data)) this.lastInput = Date.now();
        this.onInput(message.data);
      } else if (message.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number') {
        const cols = Math.max(20, Math.min(400, Math.floor(message.cols)));
        const rows = Math.max(6, Math.min(200, Math.floor(message.rows)));
        if (cols !== this.cols || rows !== this.rows) {
          this.cols = cols;
          this.rows = rows;
          this.onResize();
        } else this.paint(page);
      }
    };
    page.closed = () => this.pages.delete(page);
    page.open();
    this.paint(page);
  }

  /** A new screen: every pane redraws it in place. */
  render(lines: string[]): void {
    this.lines = lines;
    for (const page of this.pages) this.paint(page);
  }

  private paint(page: DemoSocket): void {
    const text = `\x1b[?25l\x1b[H${this.lines.map((line) => `${line}\x1b[0m\x1b[K`).join('\r\n')}\x1b[J`;
    page.deliver(encoder.encode(text).buffer as ArrayBuffer);
  }

  /** What `tmux capture-pane -p -e` prints: the screen, with its colors. */
  capture(): string {
    return this.lines.join('\n');
  }

  /** The session ended: its panes say so. */
  end(): void {
    this.ended = true;
    for (const page of this.pages) page.end(4000);
    this.pages.clear();
  }
}
