// The WebSocket of the page, in the demo: no network. The page opens /ws (the daemon) and /term (a terminal) as in
// the app; this class hands each one to the daemon of the demo, which answers through `deliver` and `end`.

type Router = (url: URL, socket: DemoSocket) => void;

let router: Router = (_url, socket) => socket.end(1011);

/** Where the sockets of the page go: set once, by the daemon of the demo. */
export function routeSockets(next: Router): void {
  router = next;
}

export class DemoSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  binaryType = 'blob';
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  /** What the page sends: the daemon of the demo listens here. */
  receive: (data: string) => void = () => {};
  /** The page closed it. */
  closed: () => void = () => {};

  constructor(url: string | URL) {
    this.url = String(url);
    // Like a real socket, it opens after the code that made it has set its handlers.
    setTimeout(() => router(new URL(this.url, location.href), this), 0);
  }

  /** From the daemon: the socket is open. */
  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** From the daemon: a message for the page, text or bytes. */
  deliver(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data });
  }

  /** From the daemon: the socket is over (4000: the session ended, as the terminals of the app say it). */
  end(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** From the page. */
  send(data: string): void {
    if (this.readyState !== 1) return;
    this.receive(String(data));
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed();
    this.onclose?.({ code, reason: '' });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    if (type === 'open') this.onopen = listener as never;
    else if (type === 'message') this.onmessage = listener as never;
    else if (type === 'close') this.onclose = listener as never;
    else if (type === 'error') this.onerror = listener as never;
  }

  removeEventListener(): void {}
}

/**
 * The side of a page socket the Hub of the daemon sees: the few things it uses of a socket of `ws`, so that the
 * real Hub routes the messages of the page.
 */
export class HubSide {
  readonly OPEN = 1;
  private readonly handlers = new Map<string, ((data?: unknown) => void)[]>();

  constructor(private readonly page: DemoSocket) {
    page.receive = (data) => this.emit('message', data);
    page.closed = () => this.emit('close');
  }

  get readyState(): number {
    return this.page.readyState;
  }

  on(event: string, handler: (data?: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  send(text: string): void {
    // A turn of the event loop later, as over a network: the page never gets an answer inside its own call.
    setTimeout(() => this.page.deliver(text), 0);
  }

  close(): void {
    this.page.end(1001);
  }

  private emit(event: string, data?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }
}
