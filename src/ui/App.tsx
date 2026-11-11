import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Agent, TodayInfo } from '../shared/agent.ts';
import { nextChange, shortTokens, usdText } from '../shared/present.ts';
import { startAmbient, stopAmbient } from './ambient.ts';
import { Box } from './Box.tsx';
import { BroadcastButton, BroadcastPanel } from './Broadcast.tsx';
import { FilesPanel } from './Files.tsx';
import { NewSessionPanel } from './NewSession.tsx';
import { RecallPanel } from './Recall.tsx';
import { hasGroups, OrgChart } from './Team.tsx';
import { animateMove, onReducedMotionChange } from './motion.ts';
import type { Store, UiState } from './store.ts';
import { Workspace } from './Workspace.tsx';

function useStore(store: Store): UiState {
  const [state, setState] = useState(store.state);
  useEffect(() => store.subscribe(() => setState(store.state)), [store]);
  return state;
}

/**
 * The time to render with. The page renders again only when a text would change by itself (a countdown, the
 * time since the last event), never while the window cannot be seen.
 */
function useNow(agents: readonly Agent[], visible: boolean): number {
  const [tick, setTick] = useState(0);
  const now = Date.now();
  useEffect(() => {
    if (!visible) return;
    let next = Number.POSITIVE_INFINITY;
    for (const agent of agents) next = Math.min(next, nextChange(agent, now) ?? Number.POSITIVE_INFINITY);
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.max(50, next - Date.now()));
    return () => clearTimeout(timer);
  }, [agents, visible, tick]);
  return now;
}

/** When boxes come or go, the others glide to their new place instead of jumping. */
function useGlide(container: { current: HTMLElement | null }, order: string): void {
  const places = useRef(new Map<string, DOMRect>());
  const measure = (): Map<string, DOMRect> => {
    const found = new Map<string, DOMRect>();
    for (const child of Array.from(container.current?.children ?? []) as HTMLElement[]) {
      if (child.dataset.id) found.set(child.dataset.id, child.getBoundingClientRect());
    }
    return found;
  };
  useLayoutEffect(() => {
    const now = measure();
    for (const child of Array.from(container.current?.children ?? []) as HTMLElement[]) {
      const before = places.current.get(child.dataset.id ?? '');
      const after = now.get(child.dataset.id ?? '');
      if (!before || !after) continue;
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) animateMove(child, dx, dy);
    }
    places.current = now;
  }, [order]);
  // A resized window moves every box by itself: what matters next is where they are now.
  useEffect(() => {
    const remember = (): void => {
      places.current = measure();
    };
    window.addEventListener('resize', remember);
    return () => window.removeEventListener('resize', remember);
  }, []);
}

/** The view chosen last time in this window: a convenience, so it may be missing. */
function savedView(): 'grid' | 'org' {
  try {
    return localStorage.getItem('forchetta.view') === 'org' ? 'org' : 'grid';
  } catch {
    return 'grid';
  }
}

function todayTitle(today: TodayInfo): string {
  const since = new Date(today.since).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const unpriced = today.unpricedCalls > 0 ? `, ${today.unpricedCalls} di modelli senza prezzo noto esclusi dal costo` : '';
  return `Tutte le sessioni dalle ${since}: ${today.calls.toLocaleString('it-IT')} chiamate, ${today.tokens.toLocaleString('it-IT')} token, a prezzi API${unpriced} (dati di arricurdAI)`;
}

function counts(agents: readonly Agent[], today: TodayInfo | undefined) {
  const live = agents.filter((agent) => agent.state !== 'ended').length;
  const waiting = agents.filter((agent) => agent.state === 'waiting').length;
  return (
    <p class="counts">
      {today && (
        <span class="today" title={todayTitle(today)}>
          oggi ≈ {usdText(today.usd)} · {shortTokens(today.tokens)} token ·{' '}
        </span>
      )}
      {live} {live === 1 ? 'sessione' : 'sessioni'}
      {waiting > 0 && <span class="waiting"> · {waiting} {waiting === 1 ? 'ti aspetta' : 'ti aspettano'}</span>}
    </p>
  );
}

export function App({ store }: { store: Store }) {
  const state = useStore(store);
  const agents = useMemo(() => [...state.agents.values()].sort((a, b) => a.createdAt - b.createdAt), [state.agents]);
  const now = useNow(agents, state.visible);
  const grid = useRef<HTMLElement>(null);
  useGlide(grid, agents.map((agent) => agent.id).join(' '));

  // The shared timer of the endless animations: on while some box moves and the window can be seen.
  useEffect(() => {
    if (state.visible) startAmbient();
    else stopAmbient(false);
  });
  useEffect(() => onReducedMotionChange((reduced) => (reduced ? stopAmbient(true) : startAmbient())), []);

  const open = useCallback((id: string) => store.open(id), [store]);
  const entered = useCallback((id: string) => store.entering.delete(id), [store]);
  const working = state.panes.open.length > 0;
  const [panel, setPanel] = useState<'broadcast' | 'new' | 'recall' | undefined>(undefined);
  const [view, setView] = useState<'grid' | 'org'>(savedView);
  const chooseView = (next: 'grid' | 'org'): void => {
    setView(next);
    try {
      localStorage.setItem('forchetta.view', next);
    } catch {
      // The choice is only for this window.
    }
  };
  const grouped = hasGroups(agents);
  const showOrg = view === 'org' && grouped;
  const toggle = (which: 'broadcast' | 'new' | 'recall'): void => {
    store.endSpawn();
    setPanel(panel === which ? undefined : which);
  };
  // "Nuova sessione…" from the menu of the icon.
  const requestedAt = state.panelRequest?.at;
  useEffect(() => {
    if (requestedAt === undefined) return;
    store.endSpawn();
    setPanel('new');
  }, [requestedAt]);
  // A session started from the panel: the panel closes, its terminal opens.
  const startedId = state.spawn?.startedId;
  useEffect(() => {
    if (!startedId) return;
    setPanel(undefined);
    store.endSpawn();
  }, [startedId]);

  return (
    <div class={`app${working ? ' with-panes' : ''}`}>
      <header class="top">
        <h1>Forchetta</h1>
        <div class="top-right">
          {state.ready && counts(agents, state.today)}
          {state.ready && grouped && !working && (
            <span class="view-switch" role="group" aria-label="Vista">
              <button type="button" class={view === 'grid' ? 'on' : undefined} onClick={() => chooseView('grid')}>
                griglia
              </button>
              <button type="button" class={view === 'org' ? 'on' : undefined} onClick={() => chooseView('org')}>
                organigramma
              </button>
            </span>
          )}
          {state.ready && <BroadcastButton agents={agents} open={panel === 'broadcast'} onToggle={() => toggle('broadcast')} />}
          {state.ready && (
            <button type="button" class={`broadcast-toggle${panel === 'recall' ? ' active' : ''}`} title="Cerca nelle sessioni passate di un progetto (arricurdai recall)" onClick={() => toggle('recall')}>
              cerca
            </button>
          )}
          {state.ready && (
            <button type="button" class={`broadcast-toggle${panel === 'new' ? ' active' : ''}`} title="Avvia una sessione Claude Code in una cartella" onClick={() => toggle('new')}>
              nuova sessione
            </button>
          )}
        </div>
      </header>
      {state.ready && panel === 'broadcast' && <BroadcastPanel agents={agents} store={store} onClose={() => setPanel(undefined)} />}
      {state.ready && panel === 'new' && <NewSessionPanel agents={agents} store={store} onClose={() => toggle('new')} />}
      {state.ready && panel === 'recall' && <RecallPanel agents={agents} store={store} onClose={() => toggle('recall')} />}
      {state.ready && !state.connected && <p class="notice">Daemon non raggiungibile: riprovo…</p>}
      {!state.ready ? (
        <p class="empty">Connessione al daemon…</p>
      ) : working ? (
        <Workspace state={state} store={store} agents={agents} now={now} />
      ) : agents.length === 0 ? (
        <div class="empty">
          <p>Nessuna sessione Claude Code attiva.</p>
          <p class="hint">
            Avviane una con <code>forchetta run claude</code>
          </p>
        </div>
      ) : showOrg ? (
        <OrgChart
          agents={agents}
          render={(agent) => <Box key={agent.id} agent={agent} now={now} entering={store.entering.has(agent.id)} onEntered={entered} onOpen={open} store={store} />}
        />
      ) : (
        <main class="grid" ref={grid}>
          {agents.map((agent) => (
            <Box key={agent.id} agent={agent} now={now} entering={store.entering.has(agent.id)} onEntered={entered} onOpen={open} store={store} />
          ))}
        </main>
      )}
      <FilesPanel store={store} now={now} />
    </div>
  );
}
