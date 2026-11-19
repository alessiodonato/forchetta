import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Agent, displayName, type TodayInfo, type UsageLimits } from '../shared/agent.ts';
import { limitParts, nextChange, shortTokens, usdText } from '../shared/present.ts';
import { startAmbient, stopAmbient } from './ambient.ts';
import { Box } from './Box.tsx';
import { BroadcastButton, BroadcastPanel } from './Broadcast.tsx';
import { ClaudeUpdateNotice } from './ClaudeUpdate.tsx';
import { FilesPanel } from './Files.tsx';
import { SubagentsPanel } from './Subagents.tsx';
import { NewSessionPanel } from './NewSession.tsx';
import { NewTeamPanel } from './NewTeam.tsx';
import { Studio } from './Studio.tsx';
import { TeamPanel } from './TeamRequests.tsx';
import { crewLineOf } from '../shared/crew.ts';
import { guardTotal, type GuardStatsInfo, statsTitle } from '../shared/guard-stats.ts';
import { PromptsPanel } from './PromptsPanel.tsx';
import { RecallPanel } from './Recall.tsx';
import { hasGroups, OrgChart } from './Team.tsx';
import { animateMove, onReducedMotionChange } from './motion.ts';
import type { Store, UiState } from './store.ts';
import { Workspace } from './Workspace.tsx';

function useStore(store: Store): UiState {
  const [state, setState] = useState(store.state);
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setState(store.state));
    // What changed between the first render and now (the daemon of the demo answers at once): not lost.
    setState(store.state);
    return unsubscribe;
  }, [store]);
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

function counts(agents: readonly Agent[], today: TodayInfo | undefined, limits: UsageLimits | undefined, guardStats: GuardStatsInfo | undefined) {
  const live = agents.filter((agent) => agent.state !== 'ended').length;
  const waiting = agents.filter((agent) => agent.state === 'waiting').length;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const parts = limitParts(limits, Date.now(), (id) => {
    const agent = byId.get(id);
    return agent ? displayName(agent) : undefined;
  });
  // With the limits of a plan, what counts is how much of them is left: the cost at API prices goes in their tooltip.
  const todayLine = today ? `today ≈ ${usdText(today.usd)} · ${shortTokens(today.tokens)} tokens` : undefined;
  // What the guard did this week: shown once it did something, the details in its tooltip.
  const guarded = guardStats ? guardTotal(guardStats.counts) : 0;
  return (
    <p class="counts">
      {guardStats && guarded > 0 && (
        <span class="guard-count" title={statsTitle(guardStats)}>
          guard {guarded} this week ·{' '}
        </span>
      )}
      {today && parts.length === 0 && (
        <span class="today" title={todayTitle(today)}>
          {todayLine} ·{' '}
        </span>
      )}
      {parts.map((part, index) => (
        <span key={part.text} class={`limit ${part.level}`} title={index === 0 && today ? `${part.title}\n\n${todayLine}: ${todayTitle(today)}` : part.title}>
          {part.text} ·{' '}
        </span>
      ))}
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
  const [panel, setPanel] = useState<'broadcast' | 'new' | 'team' | 'crew' | 'recall' | 'prompts' | undefined>(undefined);
  const [view, setView] = useState<'grid' | 'org'>(savedView);
  /** The studio of teams, over everything else. */
  const [studio, setStudio] = useState(false);
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
  const toggle = (which: 'broadcast' | 'new' | 'team' | 'crew' | 'recall' | 'prompts'): void => {
    store.endSpawn();
    store.endCrewSpawn();
    setPanel(panel === which ? undefined : which);
  };
  // "Nuova sessione…" from the menu of the icon; the quick prompts from the menu of a selection.
  const requestedAt = state.panelRequest?.at;
  useEffect(() => {
    if (requestedAt === undefined || !state.panelRequest) return;
    store.endSpawn();
    setPanel(state.panelRequest.which);
  }, [requestedAt]);
  // A team started with every session: the panel closes, their terminals open. With something that did not
  // start, it stays open to say what.
  const crewCreated = state.crewSpawn?.createdId;
  const crewError = state.crewSpawn?.error;
  useEffect(() => {
    if (!crewCreated || crewError) return;
    setPanel(undefined);
    setStudio(false);
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
          {state.ready && <ClaudeUpdateNotice info={state.claudeUpdate} store={store} />}
          {state.ready && counts(agents, state.today, state.limits, state.guardStats)}
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
          {state.ready && (
            // One button for the teams: their thread when there are some, with "+ new team" in it; a new one otherwise.
            <button
              type="button"
              class={`broadcast-toggle${panel === 'crew' || panel === 'team' ? ' active' : ''}`}
              title={state.crews.length > 0 ? 'Your teams: write a request to their members, see where the last ones stand, or start a new one' : 'Start a team of Claude Code sessions that work together: a lead and its members'}
              onClick={() => (panel === 'crew' || panel === 'team' ? setPanel(undefined) : toggle(state.crews.length > 0 ? 'crew' : 'team'))}
            >
              {state.crews.length > 0 ? 'teams' : 'new team'}
            </button>
          )}
          {state.ready && (
            <button
              type="button"
              class={`broadcast-toggle${studio ? ' active' : ''}`}
              title="Draw a team: drag agents and teams onto a canvas, link them with arrows, then create it or keep it as a template"
              onClick={() => {
                store.endCrewSpawn();
                setStudio(!studio);
              }}
            >
              studio
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
      {state.ready && panel === 'team' && (
        <NewTeamPanel
          agents={agents}
          store={store}
          onClose={() => toggle('team')}
          onStudio={() => {
            setPanel(undefined);
            store.endCrewSpawn();
            setStudio(true);
          }}
        />
      )}
      {state.ready && studio && (
        <Studio
          agents={agents}
          store={store}
          onClose={() => {
            store.endCrewSpawn();
            setStudio(false);
          }}
        />
      )}
      {state.ready && panel === 'crew' && <TeamPanel crews={state.crews} store={store} onClose={() => toggle('crew')} onNew={() => setPanel('team')} />}
      {state.ready && panel === 'recall' && <RecallPanel agents={agents} store={store} onClose={() => toggle('recall')} />}
      {state.ready && panel === 'prompts' && <PromptsPanel store={store} onClose={() => setPanel(undefined)} />}
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
            <Box
              key={agent.id}
              agent={agent}
              now={now}
              entering={store.entering.has(agent.id)}
              onEntered={entered}
              onOpen={open}
              store={store}
              crewLine={crewLineOf(agent.id, state.crews)}
              unseen={store.unseen(agent)}
              limits={agent.state === 'error' ? state.limits : undefined}
            />
          )}
        />
      ) : (
        <main class="grid" ref={grid}>
          {agents.map((agent) => (
            <Box
              key={agent.id}
              agent={agent}
              now={now}
              entering={store.entering.has(agent.id)}
              onEntered={entered}
              onOpen={open}
              store={store}
              crewLine={crewLineOf(agent.id, state.crews)}
              unseen={store.unseen(agent)}
              limits={agent.state === 'error' ? state.limits : undefined}
            />
          ))}
        </main>
      )}
      <FilesPanel store={store} now={now} />
      <SubagentsPanel store={store} now={now} />
    </div>
  );
}
