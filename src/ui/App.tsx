import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Agent, TodayInfo } from '../shared/agent.ts';
import { nextChange, shortTokens, usdText } from '../shared/present.ts';
import { startAmbient, stopAmbient } from './ambient.ts';
import { Box } from './Box.tsx';
import { BroadcastButton, BroadcastPanel } from './Broadcast.tsx';
import { FilesPanel } from './Files.tsx';
import { NewSessionPanel } from './NewSession.tsx';
import { NewTeamPanel } from './NewTeam.tsx';
import { TeamPanel } from './TeamRequests.tsx';
import { crewLineOf } from '../shared/crew.ts';
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
  const since = new Date(today.since).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const unpriced = today.unpricedCalls > 0 ? `, ${today.unpricedCalls} of them from models with no known price left out of the cost` : '';
  return `Every session since ${since}: ${today.calls.toLocaleString('en-US')} calls, ${today.tokens.toLocaleString('en-US')} tokens, at API prices${unpriced} (data from arricurdAI)`;
}

function counts(agents: readonly Agent[], today: TodayInfo | undefined) {
  const live = agents.filter((agent) => agent.state !== 'ended').length;
  const waiting = agents.filter((agent) => agent.state === 'waiting').length;
  return (
    <p class="counts">
      {today && (
        <span class="today" title={todayTitle(today)}>
          today ≈ {usdText(today.usd)} · {shortTokens(today.tokens)} tokens ·{' '}
        </span>
      )}
      {live} {live === 1 ? 'session' : 'sessions'}
      {waiting > 0 && <span class="waiting"> · {waiting} {waiting === 1 ? 'waits for you' : 'wait for you'}</span>}
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
  const [panel, setPanel] = useState<'broadcast' | 'new' | 'team' | 'crew' | 'recall' | undefined>(undefined);
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
  const toggle = (which: 'broadcast' | 'new' | 'team' | 'crew' | 'recall'): void => {
    store.endSpawn();
    store.endCrewSpawn();
    setPanel(panel === which ? undefined : which);
  };
  // "Nuova sessione…" from the menu of the icon.
  const requestedAt = state.panelRequest?.at;
  useEffect(() => {
    if (requestedAt === undefined) return;
    store.endSpawn();
    setPanel('new');
  }, [requestedAt]);
  // A team started with every session: the panel closes, their terminals open. With something that did not
  // start, it stays open to say what.
  const crewCreated = state.crewSpawn?.createdId;
  const crewError = state.crewSpawn?.error;
  useEffect(() => {
    if (!crewCreated || crewError) return;
    setPanel(undefined);
    store.endCrewSpawn();
  }, [crewCreated, crewError]);
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
            <span class="view-switch" role="group" aria-label="View">
              <button type="button" class={view === 'grid' ? 'on' : undefined} onClick={() => chooseView('grid')}>
                grid
              </button>
              <button type="button" class={view === 'org' ? 'on' : undefined} onClick={() => chooseView('org')}>
                org chart
              </button>
            </span>
          )}
          {state.ready && <BroadcastButton agents={agents} open={panel === 'broadcast'} onToggle={() => toggle('broadcast')} />}
          {state.ready && (
            <button type="button" class={`broadcast-toggle${panel === 'recall' ? ' active' : ''}`} title="Search the earlier sessions of a project (arricurdai recall)" onClick={() => toggle('recall')}>
              search
            </button>
          )}
          {state.ready && state.crews.length > 0 && (
            <button type="button" class={`broadcast-toggle${panel === 'crew' ? ' active' : ''}`} title="Write a request to the members of a team, and see where the last ones stand" onClick={() => toggle('crew')}>
              team
            </button>
          )}
          {state.ready && (
            <button type="button" class={`broadcast-toggle${panel === 'team' ? ' active' : ''}`} title="Start a team of Claude Code sessions that work together: a lead and its members" onClick={() => toggle('team')}>
              new team
            </button>
          )}
          {state.ready && (
            <button type="button" class={`broadcast-toggle primary${panel === 'new' ? ' active' : ''}`} title="Start a Claude Code session in a folder" onClick={() => toggle('new')}>
              new session
            </button>
          )}
        </div>
      </header>
      {state.ready && panel === 'broadcast' && <BroadcastPanel agents={agents} store={store} onClose={() => setPanel(undefined)} />}
      {state.ready && panel === 'new' && <NewSessionPanel agents={agents} store={store} onClose={() => toggle('new')} />}
      {state.ready && panel === 'team' && <NewTeamPanel agents={agents} store={store} onClose={() => toggle('team')} />}
      {state.ready && panel === 'crew' && <TeamPanel crews={state.crews} store={store} onClose={() => toggle('crew')} />}
      {state.ready && panel === 'recall' && <RecallPanel agents={agents} store={store} onClose={() => toggle('recall')} />}
      {state.ready && !state.connected && <p class="notice">Daemon unreachable: trying again…</p>}
      {!state.ready ? (
        <p class="empty">Connecting to the daemon…</p>
      ) : working ? (
        <Workspace state={state} store={store} agents={agents} now={now} />
      ) : agents.length === 0 ? (
        <div class="empty">
          <p>No Claude Code session running.</p>
          <p class="hint">
            Start one with <code>forchetta run claude</code>
          </p>
        </div>
      ) : showOrg ? (
        <OrgChart
          agents={agents}
          crews={state.crews}
          render={(agent) => (
            <Box key={agent.id} agent={agent} now={now} entering={store.entering.has(agent.id)} onEntered={entered} onOpen={open} store={store} crewLine={crewLineOf(agent.id, state.crews)} />
          )}
        />
      ) : (
        <main class="grid" ref={grid}>
          {agents.map((agent) => (
            <Box key={agent.id} agent={agent} now={now} entering={store.entering.has(agent.id)} onEntered={entered} onOpen={open} store={store} crewLine={crewLineOf(agent.id, state.crews)} />
          ))}
        </main>
      )}
      <FilesPanel store={store} now={now} />
    </div>
  );
}
