// What the app does outside its window, for a page in a browser: the sessions that wait for you are counted in the
// title of the tab, and the notifications the daemon asks for (daemon/attention.ts) are those of the browser, once you
// allow them in Settings. A click on one brings the window back on its session.

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

/** Whether the browser may show notifications for this page, or may be asked. Never in the app, nor in the demo. */
export const notificationState = (): NotificationState => (typeof Notification === 'undefined' || window.__FORCHETTA__ ? 'unsupported' : Notification.permission);

export async function askNotifications(): Promise<NotificationState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationState();
  }
}

interface Shown {
  close(): void;
  onclick: (() => void) | null;
}

export interface BrowserShellDeps {
  title: (text: string) => void;
  /** The page can be seen and has the focus: the box says it already. */
  inFront: () => boolean;
  allowed: () => boolean;
  show: (title: string, options: { body: string; tag: string }) => Shown;
  focus: (agentId: string) => void;
}

const browserDeps = (): BrowserShellDeps => ({
  title: (text) => {
    document.title = text;
  },
  inFront: () => document.visibilityState === 'visible' && document.hasFocus(),
  allowed: () => notificationState() === 'granted',
  show: (title, options) => new Notification(title, options) as unknown as Shown,
  focus: (agentId) => {
    window.focus();
    window.forchettaFocus?.(agentId);
  },
});

/** Takes the messages of connectAttention (ui/attention.ts) as the app does. */
export function browserShell(deps: BrowserShellDeps = browserDeps()): (message: unknown) => void {
  /** The notifications of the waits, by session: closed when it stops waiting. */
  const waits = new Map<string, Shown>();
  return (raw) => {
    const message = raw as { type?: string; count?: number; waiting?: string[]; id?: string; kind?: string; title?: string; body?: string };
    if (message.type === 'attention') {
      deps.title(message.count ? `(${message.count}) Forchetta` : 'Forchetta');
      const waiting = new Set(message.waiting ?? []);
      for (const [id, shown] of waits) {
        if (waiting.has(id)) continue;
        shown.close();
        waits.delete(id);
      }
    } else if (message.type === 'notify' && message.id && message.title) {
      const { id, kind, title, body } = message;
      if (!deps.allowed() || deps.inFront()) return;
      try {
        // One per session and kind: a new wait takes the place of the one before.
        const shown = deps.show(title, { body: body ?? '', tag: kind === 'waiting' ? id : `${id}:${kind}` });
        shown.onclick = () => {
          deps.focus(id);
          shown.close();
        };
        if (kind === 'waiting') waits.set(id, shown);
      } catch {
        // The browser does not let this page show one after all.
      }
    }
  };
}
