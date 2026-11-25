import { IS_MAC } from './platform.ts';
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

/** How long a page waits for the daemon of the new version, during an update. */
const COME_BACK_MS = 30 * 60_000;

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
  /** An update is under way: the code this page gets in with after it, since the daemon comes back with another token. */
  private handover: { code: string; until: number } | undefined;

  constructor(private readonly store: Store) {
    store.send = (message) => {
      const sent = this.send(message);
      // Not sent: what waits for its answer is told now, not left "…" forever.
      if (!sent) store.notSent();
      return sent;
    };
    store.onUpdating = () => this.prepareHandover();
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
    // On a Mac there are no codes, and nothing is kept: the app gives the token, or the address for development.
    if (IS_MAC) return;
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

  /** In a browser there is no app to give the new token: the page leaves a code of its own with the daemon of now. */
  private prepareHandover(): void {
    if (shell() || IS_MAC || this.handover) return;
    const code = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (this.send({ type: 'handover', code })) this.handover = { code, until: Date.now() + COME_BACK_MS };
  }

  /** After an update: the code for the token of the new daemon, once. */
  private async comeBack(): Promise<boolean> {
    if (!this.handover) return false;
    try {
      const response = await fetch('/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: this.handover.code }) });
      const token = response.ok ? ((await response.json()) as { token?: unknown }).token : undefined;
      if (typeof token !== 'string') return false;
      this.handover = undefined;
      keepToken(token);
      this.use(token);
      this.attempts = 0;
      this.open();
      return true;
    } catch {
      // Not there yet.
      return false;
    }
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
      if (this.handover && Date.now() > this.handover.until) this.handover = undefined;
      // Refused, or nobody there: in a browser, only `forchetta open` can help; or, during an update, waiting.
      if (!opened && !shell() && !IS_MAC && !this.handover) this.store.setNeedsOpen(true);
      if (!opened) this.askShell();
      const again = (): void => {
        const delay = Math.min(this.handover ? 2000 : 10_000, 1000 * 2 ** this.attempts++);
        this.retry = setTimeout(() => this.open(), delay);
      };
      if (opened || !this.handover) return again();
      void this.comeBack().then((back) => {
        if (!back) again();
      });
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
