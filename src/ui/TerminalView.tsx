import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'preact/hooks';
import { token } from './connection.ts';
import { GlyphFilter } from './glyphs.ts';
import { isFocusReport, keyInput } from './layout.ts';

// The terminal of a pane: xterm.js on a WebSocket of the daemon, which runs `tmux attach` for the session. Closing
// the pane closes the socket, and the daemon detaches that tmux client: the session goes on.

const THEME = {
  background: '#111215',
  foreground: '#e3e5e8',
  cursor: '#e3e5e8',
  cursorAccent: '#111215',
  selectionBackground: 'rgba(163, 168, 176, 0.32)',
  black: '#1c1e22',
  red: '#ef5b5b',
  green: '#46c48a',
  yellow: '#e2b85c',
  blue: '#6aa7ec',
  magenta: '#c08ae0',
  cyan: '#5ec2c8',
  white: '#c8ccd2',
  brightBlack: '#5c616b',
  brightRed: '#ff7a7a',
  brightGreen: '#6bd8a3',
  brightYellow: '#f0cd7f',
  brightBlue: '#8cbcf3',
  brightMagenta: '#d2a6ee',
  brightCyan: '#82d6db',
  brightWhite: '#f2f3f5',
};

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
      // Apple Symbols draws ⏺ and the other symbols of Claude Code as text, one cell wide: without it WebKit falls
      // back to the color emoji, two cells wide over the next letter.
      fontFamily: 'ui-monospace, "SF Mono", Menlo, "Apple Symbols", monospace',
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: false,
      // Option must stay Option: on an Italian keyboard it types @, # and the square brackets.
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      // The history is in tmux: the wheel scrolls it (mouse on). A second one here would only show a scrollbar.
      scrollback: 0,
      theme: THEME,
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
