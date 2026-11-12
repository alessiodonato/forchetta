import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { type ILink, Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'preact/hooks';
import { linksIn } from '../shared/artifacts.ts';
import { openLink } from './Artifacts.tsx';
import { token } from './connection.ts';
import { GlyphFilter } from './glyphs.ts';
import { isFocusReport, keyInput } from './layout.ts';
import { TERMINAL_THEME } from './terminal-theme.ts';

// The terminal of a pane: xterm.js on a WebSocket of the daemon, which runs `tmux attach` for the session. Closing
// the pane closes the socket, and the daemon detaches that tmux client: the session goes on.

// Apple Symbols draws ⏺ and the other symbols of Claude Code as text, one cell wide: without it WebKit falls back
// to the color emoji, two cells wide over the next letter.
const FALLBACK_FONTS = 'ui-monospace, "SF Mono", Menlo, "Apple Symbols", monospace';
const FONTS = `"JetBrains Mono", ${FALLBACK_FONTS}`;

/**
 * The links on line `y` (from 1) of the screen, for xterm.js. A link can go on over the next lines when the terminal
 * wraps a long line: the whole wrapped line is read, and each link is placed by its cells.
 */
function linksAt(term: Terminal, y: number, open: (url: string) => void): ILink[] | undefined {
  const buffer = term.buffer.active;
  let first = y - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = first;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  let text = '';
  for (let row = first; row <= last; row++) text += buffer.getLine(row)?.translateToString(row === last) ?? '';
  const cols = term.cols;
  const cell = (offset: number) => ({ x: (offset % cols) + 1, y: first + Math.floor(offset / cols) + 1 });
  const links = linksIn(text)
    .map(({ url, index }): ILink => ({
      range: { start: cell(index), end: cell(index + url.length - 1) },
      text: url,
      decorations: { pointerCursor: true, underline: true },
      hover: () => {
        if (term.element) term.element.title = '⌘-click to open in the browser';
      },
      leave: () => {
        if (term.element) term.element.title = '';
      },
      activate: (event: MouseEvent, link: string) => {
        if (event.metaKey) open(link);
      },
    }))
    .filter((link) => link.range.start.y <= y && y <= link.range.end.y);
  return links.length > 0 ? links : undefined;
}

/**
 * JetBrains Mono, loaded once for all the panes. xterm.js measures its cells with the font it has when it opens:
 * a terminal that opens before the font is there starts with the fallback and switches when it arrives.
 */
let fontReady = false;
const fontLoaded: Promise<void> =
  typeof document === 'undefined' || !document.fonts
    ? Promise.resolve()
    : Promise.all([document.fonts.load('400 13px "JetBrains Mono"'), document.fonts.load('700 13px "JetBrains Mono"')]).then(
        () => {
          fontReady = true;
        },
        () => {
          // No font: the fallback stays.
        },
      );

/** Ended: tmux closed the client because the session is over. Lost: the daemon cannot be reached. */
export type TerminalStatus = 'connecting' | 'open' | 'ended' | 'lost';

declare global {
  interface Window {
    /** For the tests of the app: the terminals of the open panes. */
    forchettaDebug?: { terminals: Map<string, Terminal>; domRenderer?: boolean; store?: unknown };
  }
}

interface Props {
  agentId: string;
  /** Typing or clicking in the terminal. */
  onUse: () => void;
  onStatus: (status: TerminalStatus) => void;
  /** Focus the terminal when the pane opens or is activated: when this changes, and is not -1 (see layout.ts). */
  focusKey: number;
}

export function TerminalView({ agentId, onUse, onStatus, focusKey }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const callbacks = useRef({ onUse, onStatus });
  callbacks.current = { onUse, onStatus };

  useEffect(() => {
    const element = host.current;
    const auth = token();
    if (!element || !auth) return;
    const term = new Terminal({
      fontFamily: fontReady ? FONTS : FALLBACK_FONTS,
      fontSize: 13,
      lineHeight: 1.3,
      // A safety net under the colors of terminal-theme.ts: xterm.js lightens any text that would read below this
      // contrast with its background. 3, not 4.5: higher, the subtle grays of Claude Code would become as light
      // as the inactive ones, and the difference between them would go.
      minimumContrastRatio: 3,
      cursorBlink: false,
      // Option must stay Option: on an Italian keyboard it types @, # and the square brackets.
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      // The history is in tmux: the wheel scrolls it (mouse on). A second one here would only show a scrollbar.
      scrollback: 0,
      theme: TERMINAL_THEME,
      // Links that the program marks itself (OSC 8): ⌘-click opens them, as in the Terminal.
      linkHandler: {
        activate: (event, text) => {
          if (event.metaKey) openLink(text);
        },
        allowNonHttpProtocols: false,
      },
    });
    // The links written as plain text: ⌘-click opens them in the browser. A plain click stays with tmux (its mouse is on).
    term.registerLinkProvider({
      provideLinks: (y, callback) => callback(linksAt(term, y, (url) => openLink(url))),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    // WebGL draws faster; the DOM renderer is the fallback, and what the snapshots of the tests can see.
    if (!window.forchettaDebug?.domRenderer) try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL: xterm.js draws with the DOM.
    }
    fit.fit();
    terminal.current = term;
    window.forchettaDebug?.terminals.set(agentId, term);
    let disposed = false;
    if (!fontReady) {
      void fontLoaded.then(() => {
        if (disposed || !fontReady) return;
        // A new font family makes xterm.js measure its cells again; then the pane fits them.
        term.options.fontFamily = FONTS;
        try {
          fit.fit();
        } catch {
          // Not visible right now: the ResizeObserver fits it later.
        }
      });
    }

    const url = `ws://${location.host}/term?token=${encodeURIComponent(auth)}&agent=${encodeURIComponent(agentId)}&cols=${term.cols}&rows=${term.rows}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const send = (message: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    callbacks.current.onStatus('connecting');
    socket.onopen = () => {
      callbacks.current.onStatus('open');
      send({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    const glyphs = new GlyphFilter();
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) term.write(glyphs.push(new Uint8Array(event.data)));
    };
    socket.onclose = (event) => callbacks.current.onStatus(event.code === 4000 ? 'ended' : 'lost');

    term.onData((data) => {
      send({ type: 'input', data });
      if (!isFocusReport(data)) callbacks.current.onUse();
    });
    term.onBinary((data) => send({ type: 'input', data, binary: true }));
    term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
    term.attachCustomKeyEventHandler((event) => {
      const input = keyInput(event);
      if (input === undefined) return true;
      send({ type: 'input', data: input });
      callbacks.current.onUse();
      return false;
    });
    const onPointer = (): void => callbacks.current.onUse();
    element.addEventListener('mousedown', onPointer);

    // The pane changes size with the layout and the window: the terminal follows, once per frame.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // Not visible right now.
        }
      });
    });
    observer.observe(element);

    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      element.removeEventListener('mousedown', onPointer);
      socket.onclose = null;
      socket.close();
      window.forchettaDebug?.terminals.delete(agentId);
      term.dispose();
      terminal.current = null;
    };
  }, [agentId]);

  useEffect(() => {
    if (focusKey >= 0) terminal.current?.focus();
  }, [focusKey]);

  return <div class="terminal" ref={host} />;
}
