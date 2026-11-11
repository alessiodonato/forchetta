import type { Store } from './store.ts';

// The WebSocket to the daemon. The token comes from the app (it reads var/daemon.json and puts it in the page
// before it loads); when the connection fails before opening, the token may be old (a restarted daemon), so the
// page asks the app for a new one, and the app starts the daemon when it is not running.

interface Auth {
  token: string;
  port: number;
  /** "Riduci movimento" of macOS when the page loaded, from the app. */
  reducedMotion?: boolean;
}

declare global {
  interface Window {
    __FORCHETTA__?: Auth;
    forchettaAuth?: (auth: Auth) => void;
    forchettaVisibility?: (visible: boolean) => void;
    forchettaReducedMotion?: (reduced: boolean) => void;
    webkit?: { messageHandlers?: { forchetta?: { postMessage: (message: unknown) => void } } };
  }
}

/** The app around the page, when there is one. */
export const shell = (): { postMessage: (message: unknown) => void } | undefined => window.webkit?.messageHandlers?.forchetta;

/** For development in a browser: http://127.0.0.1:47821/#token=… */
const tokenFromHash = (): string | undefined => /(?:^#|&)token=([0-9a-f]{16,})/.exec(location.hash)?.[1];

let currentToken: string | undefined;
/** The token the terminals of the panes connect with. */
export const token = (): string | undefined => currentToken;

export class Connection {
  private socket: WebSocket | undefined;
  private token: string | undefined;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private visible = true;
  private lastAsk = 0;

  constructor(private readonly store: Store) {
    store.send = (message) => this.send(message);
    window.forchettaAuth = (auth) => {
      this.token = auth.token;
      currentToken = auth.token;
      this.attempts = 0;
      this.open();
    };
  }

  start(): void {
    this.token = window.__FORCHETTA__?.token ?? tokenFromHash();
    currentToken = this.token;
    if (this.token) this.open();
    else this.askShell();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.send({ type: 'visibility', visible });
  }

  send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private open(): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
    }
    if (!this.token) return;
    const socket = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(this.token)}`);
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.attempts = 0;
      this.store.setConnected(true);
      this.send({ type: 'visibility', visible: this.visible });
    };
    socket.onmessage = (event) => {
      try {
        this.store.apply(JSON.parse(String(event.data)));
      } catch {
        // A message from a newer daemon: ignored.
      }
    };
    socket.onclose = () => {
      this.store.setConnected(false);
      if (!opened) this.askShell();
      const delay = Math.min(10_000, 1000 * 2 ** this.attempts++);
      this.retry = setTimeout(() => this.open(), delay);
    };
    this.socket = socket;
  }

  private askShell(): void {
    const now = Date.now();
    if (now - this.lastAsk < 3000) return;
    this.lastAsk = now;
    shell()?.postMessage({ type: 'needAuth' });
  }
}
