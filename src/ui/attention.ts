import { type Agent, displayName, STATE_LABEL, type TodayInfo } from '../shared/agent.ts';
import { percentText, shortTokens, usdText, waitingText } from '../shared/present.ts';
import type { ServerMessage } from '../daemon/hub.ts';
import { canOpen, type Store } from './store.ts';

// What the app shows outside its window: the number of sessions that wait for you on the icon in the Dock and
// in the menu bar, the menu of the icon, and the notifications the daemon asks for (daemon/attention.ts). A click
// on a notification or on a session of the menu brings the window back on that session.

/** The sessions that wait for you, as the header counts them. */
export const waitingIds = (agents: Iterable<Agent>): string[] => [...agents].filter((agent) => agent.state === 'waiting').map((agent) => agent.id);

declare global {
  interface Window {
    /** From the app, after a click on a notification or on a session of the menu. */
    forchettaFocus?: (agentId: string) => void;
    /** From the menu of the icon: the panel of a new session. */
    forchettaNewSession?: () => void;
  }
}

/** One line of the menu of the icon. The app writes the time left of the cache when the menu opens. */
export interface MenuSession {
  id: string;
  name: string;
  state: string;
  waiting: boolean;
  /** What it waits for, or the context: "Permesso: Bash npm test", "≈46% · 459k". */
  detail?: string;
  cost?: string;
  cacheExpiresAt?: number;
}

export interface MenuData {
  waiting: number;
  today?: string;
  sessions: MenuSession[];
}

/** The menu of the icon: the sessions that run, those that wait for you first. */
export function menuData(agents: Iterable<Agent>, today: TodayInfo | undefined): MenuData {
  const live = [...agents].filter((agent) => agent.state !== 'ended');
  const sessions = live
    .sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting') || b.lastEvent.at - a.lastEvent.at)
    .map((agent): MenuSession => ({
      id: agent.id,
      name: displayName(agent),
      state: STATE_LABEL[agent.state],
      waiting: agent.state === 'waiting',
      detail: agent.state === 'waiting' ? waitingText(agent) : agent.context ? `${percentText(agent.context)} · ${shortTokens(agent.context.tokens)}` : undefined,
      cost: agent.usage && agent.usage.usd >= 0.01 ? `≈ ${usdText(agent.usage.usd)}` : undefined,
      cacheExpiresAt: agent.cache?.expiresAt,
    }));
  return {
    waiting: sessions.filter((session) => session.waiting).length,
    today: today ? `today ≈ ${usdText(today.usd)} · ${shortTokens(today.tokens)} tokens` : undefined,
    sessions,
  };
}

export function connectAttention(store: Store, post: ((message: unknown) => void) | undefined): void {
  if (!post) return;
  let last = '';
  let lastMenu = '';
  const update = (): void => {
    if (!store.state.ready) return;
    const waiting = waitingIds(store.state.agents.values());
    const key = waiting.join(' ');
    if (key !== last) {
      last = key;
      post({ type: 'attention', count: waiting.length, waiting });
    }
    const menu = menuData(store.state.agents.values(), store.state.today);
    const menuKey = JSON.stringify(menu);
    if (menuKey !== lastMenu) {
      lastMenu = menuKey;
      post({ type: 'menu', ...menu });
    }
  };
  store.subscribe(update);
  store.onNotify = (message: Extract<ServerMessage, { type: 'notify' }>) => post({ type: 'notify', id: message.agentId, kind: message.kind, title: message.title, body: message.body });
  window.forchettaNewSession = () => store.requestPanel('new');
  window.forchettaFocus = (agentId: string) => {
    const agent = store.state.agents.get(agentId);
    if (!agent) return;
    if (canOpen(agent)) store.open(agentId);
    else document.querySelector(`.box[data-id="${CSS.escape(agentId)}"]`)?.scrollIntoView({ block: 'center' });
  };
}
