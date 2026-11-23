import type { Store } from './store.ts';

// The WebSocket to the daemon. The token comes from the app (it reads var/daemon.json and puts it in the page
// before it loads); when the connection fails before opening, the token may be old (a restarted daemon), so the
// page asks the app for a new one, and the app starts the daemon when it is not running. In a browser there is no app:
// `forchetta open` opens the page with a code, which it trades for the token once (daemon/open-codes.ts). The token is
// kept for that tab only, so that a reload works; after a restart of the daemon the page says to open it again.

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
export const shell = (): { postMessage: (message: unknown) => void } | undefined => (typeof window === 'undefined' ? undefined : window.webkit?.messageHandlers?.forchetta);

/** For development in a browser: http://127.0.0.1:47821/#token=… */
const tokenFromHash = (): string | undefined => /(?:^#|&)token=([0-9a-f]{16,})/.exec(location.hash)?.[1];

/** From `forchetta open`: http://127.0.0.1:47821/#open=… */
export const openCodeIn = (hash: string): string | undefined => /(?:^#|&)open=([0-9a-f]{32})(?:&|$)/.exec(hash)?.[1];

const TOKEN_KEY = 'forchetta.token';
/** The token of this tab: sessionStorage is of this address (with its port) and this tab, and goes with it. */
function keptToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function keepToken(token: string | undefined): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Only a reload asks for `forchetta open` again.
  }
}

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
    store.send = (message) => {
      const sent = this.send(message);
      // Not sent: what waits for its answer is told now, not left "…" forever.
      if (!sent) store.notSent();
      return sent;
    };
    window.forchettaAuth = (auth) => {
      this.use(auth.token);
      this.attempts = 0;
      this.open();
    };
  }

  start(): void {
    this.use(window.__FORCHETTA__?.token ?? tokenFromHash());
    if (this.token) return this.open();
    if (shell()) return this.askShell();
    const code = openCodeIn(location.hash);
    if (!code) {
      this.use(keptToken());
      if (this.token) this.open();
      else this.store.setNeedsOpen(true);
      return;
    }
    // Spent or not, the code leaves the address: a reload must not try it again.
    history.replaceState(null, '', location.pathname);
    void this.redeem(code);
  }

  private use(token: string | undefined): void {
    this.token = token;
    currentToken = token;
  }

  /** Trades the code of `forchetta open` for the token. */
  private async redeem(code: string): Promise<void> {
    try {
      const response = await fetch('/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      const token = response.ok ? ((await response.json()) as { token?: unknown }).token : undefined;
      if (typeof token === 'string') {
        keepToken(token);
        this.use(token);
        return this.open();
      }
    } catch {
      // The daemon is not there: the note says what to do.
    }
    this.use(keptToken());
    if (this.token) this.open();
    else this.store.setNeedsOpen(true);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.send({ type: 'visibility', visible });
  }

  /** Sends a message to the daemon; false when the connection is not open (nothing is kept to send later). */
  send(message: unknown): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
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
      this.store.setNeedsOpen(false);
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
      // Refused, or nobody there: in a browser, only `forchetta open` can help.
      if (!opened && !shell()) this.store.setNeedsOpen(true);
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
