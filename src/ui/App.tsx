import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Agent, displayName, type TodayInfo, type UsageLimits } from '../shared/agent.ts';
import { limitParts, nextChange, shortTokens, usdText } from '../shared/present.ts';
import { startAmbient, stopAmbient } from './ambient.ts';
import { Announcer } from './Announcer.tsx';
import { Palette, type PaletteCommand, ShortcutsSheet } from './Palette.tsx';
import { CopyCommand, MANUAL, SettingsPanel, SetupChecks } from './Settings.tsx';
import { openLink } from './Artifacts.tsx';
import { applyTheme, resolvedTheme } from './theme.ts';
import { setTerminalFontSize, terminalFontSize } from './prefs.ts';
import { PROTOCOL } from '../shared/system.ts';
import { Box } from './Box.tsx';
import { BroadcastButton, BroadcastPanel } from './Broadcast.tsx';
import { ClaudeUpdateNotice } from './ClaudeUpdate.tsx';
import { FilesPanel } from './Files.tsx';
import { SubagentsPanel } from './Subagents.tsx';
import { NewSessionPanel } from './NewSession.tsx';
import { NewTeamPanel } from './NewTeam.tsx';
import { type NewKind, NewMenu, newKindOf } from './NewMenu.tsx';
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

export function useStore(store: Store): UiState {
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

function counts(agents: readonly Agent[], today: TodayInfo | undefined, limits: UsageLimits | undefined, guardStats: GuardStatsInfo | undefined, onWaiting: () => void) {
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
      {waiting > 0 && (
        <>
          {' · '}
          <button type="button" class="waiting waiting-button" title="Open the next session that waits for you (⌘])" onClick={onWaiting}>
            {waiting} {waiting === 1 ? 'waits for you' : 'wait for you'}
          </button>
        </>
      )}
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
  const [panel, setPanel] = useState<'broadcast' | 'new' | 'team' | 'crew' | 'recall' | 'prompts' | 'settings' | undefined>(undefined);
  /** Over everything: the palette of commands (⌘K) or the sheet of the shortcuts (⌘/). */
  const [overlay, setOverlay] = useState<'palette' | 'shortcuts' | undefined>(undefined);
  const [view, setView] = useState<'grid' | 'org'>(savedView);
  /** The studio of teams, over everything else. */
  const [studio, setStudio] = useState(false);
  /** The running team the studio shows, when it was opened on one from its panel. */
  const [live, setLive] = useState<string | undefined>(undefined);
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
  const toggle = (which: 'broadcast' | 'new' | 'team' | 'crew' | 'recall' | 'prompts' | 'settings'): void => {
    store.endSpawn();
    store.endCrewSpawn();
    setPanel(panel === which ? undefined : which);
  };
  // "+ new": a session, a team from its panel, or a team in the studio; also from ⌘N, ⇧⌘N and ⌥⌘N anywhere.
  const startNew = (kind: NewKind): void => {
    store.endSpawn();
    store.endCrewSpawn();
    if (kind === 'studio') {
      setPanel(undefined);
      setLive(undefined);
      setStudio(true);
      return;
    }
    setStudio(false);
    setPanel(kind === 'session' ? 'new' : 'team');
  };
  /** The next session that waits for you opens (⌘], the counter in the top line). */
  const nextWaiting = (): void => {
    const id = store.nextWaiting();
    if (id) store.open(id);
  };
  /** ⌘W: the palette, a panel, then the pane in front. False when there was nothing: the app hides the window. */
  const closeFront = (): boolean => {
    if (overlay) {
      setOverlay(undefined);
      return true;
    }
    if (panel) {
      setPanel(undefined);
      return true;
    }
    const pane = store.state.panes.active ?? store.state.panes.open.at(-1);
    if (pane && store.state.panes.open.includes(pane)) {
      store.close(pane);
      return true;
    }
    return false;
  };
  /** What the menus of the app and the shortcuts ask for, by name (window.forchettaCommand). */
  const command = (name: string): boolean => {
    if (!store.state.ready) return false;
    switch (name) {
      case 'newSession':
        startNew('session');
        return true;
      case 'newTeam':
        startNew('team');
        return true;
      case 'studio':
        startNew('studio');
        return true;
      case 'settings':
        setStudio(false);
        setPanel('settings');
        return true;
      case 'palette':
        setOverlay('palette');
        return true;
      case 'shortcuts':
        setOverlay('shortcuts');
        return true;
      case 'nextWaiting':
        nextWaiting();
        return true;
      case 'close':
        return closeFront();
      case 'manual':
        openLink(MANUAL);
        return true;
      case 'issue':
        openLink('https://github.com/alessiodonato/forchetta/issues/new');
        return true;
      default:
        return false;
    }
  };
  const commandRef = useRef(command);
  commandRef.current = command;
  const startNewRef = useRef(startNew);
  startNewRef.current = startNew;
  useEffect(() => {
    window.forchettaCommand = (name: string) => commandRef.current(name);
    const typing = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    const onKey = (event: KeyboardEvent): void => {
      if (!store.state.ready) return;
      const kind = newKindOf(event);
      if (kind) {
        event.preventDefault();
        startNewRef.current(kind);
        return;
      }
      const mod = (event.metaKey || event.ctrlKey) && !event.altKey;
      // In a terminal (its hidden textarea) or a field, only the shortcuts with ⌘.
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOverlay((current) => (current === 'palette' ? undefined : 'palette'));
      } else if (mod && !event.shiftKey && event.key === ',') {
        event.preventDefault();
        commandRef.current('settings');
      } else if (mod && (event.key === '/' || event.key === '?')) {
        event.preventDefault();
        setOverlay((current) => (current === 'shortcuts' ? undefined : 'shortcuts'));
      } else if (mod && !event.shiftKey && event.key === ']') {
        event.preventDefault();
        commandRef.current('nextWaiting');
      } else if (mod && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
        const list = [...store.state.agents.values()].sort((a, b) => a.createdAt - b.createdAt);
        const target = list[Number(event.code.slice(5)) - 1];
        if (!target) return;
        event.preventDefault();
        store.open(target.id);
      } else if (mod && !event.shiftKey && event.key.toLowerCase() === 'w') {
        if (commandRef.current('close')) event.preventDefault();
      } else if (event.key === '?' && !mod && !typing(event.target)) {
        event.preventDefault();
        setOverlay('shortcuts');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.forchettaCommand = undefined;
    };
  }, []);
  // The palette: every action, then every session.
  const paletteCommands = (): PaletteCommand[] => {
    const actions: PaletteCommand[] = [
      { id: 'new-session', group: 'Actions', label: 'New session', keys: '⌘N', run: () => startNew('session') },
      { id: 'new-team', group: 'Actions', label: 'New team', keys: '⇧⌘N', run: () => startNew('team') },
      { id: 'studio', group: 'Actions', label: 'New team in the studio', keys: '⌥⌘N', words: 'draw canvas', run: () => startNew('studio') },
      ...(state.crews.length > 0 ? [{ id: 'teams', group: 'Actions' as const, label: 'Teams: requests, threads, cost', run: () => setPanel('crew') }] : []),
      { id: 'next-waiting', group: 'Actions', label: 'Next session that waits for you', keys: '⌘]', run: nextWaiting },
      { id: 'search', group: 'Actions', label: 'Search earlier sessions', words: 'recall arricurdai', run: () => setPanel('recall') },
      { id: 'broadcast', group: 'Actions', label: 'Send to several sessions', words: 'broadcast', run: () => setPanel('broadcast') },
      { id: 'prompts', group: 'Actions', label: 'Quick prompts of the selection menu', run: () => setPanel('prompts') },
      { id: 'settings', group: 'Window', label: 'Settings', keys: '⌘,', words: 'preferences guard port hotkey', run: () => command('settings') },
      { id: 'shortcuts', group: 'Window', label: 'Keyboard shortcuts', keys: '⌘/', run: () => setOverlay('shortcuts') },
      ...(grouped && !working ? [{ id: 'view', group: 'Window' as const, label: view === 'grid' ? 'Show the org chart' : 'Show the grid', run: () => chooseView(view === 'grid' ? 'org' : 'grid') }] : []),
      { id: 'theme', group: 'Window', label: resolvedTheme() === 'dark' ? 'Light theme' : 'Dark theme', words: 'appearance colors', run: () => applyTheme(resolvedTheme() === 'dark' ? 'light' : 'dark') },
      { id: 'font-up', group: 'Window', label: 'Larger text in the terminals', words: 'font zoom', run: () => setTerminalFontSize(terminalFontSize() + 1) },
      { id: 'font-down', group: 'Window', label: 'Smaller text in the terminals', words: 'font zoom', run: () => setTerminalFontSize(terminalFontSize() - 1) },
      { id: 'manual', group: 'Window', label: 'The manual', words: 'help docs', run: () => openLink(MANUAL) },
    ];
    const sessions: PaletteCommand[] = agents.map((agent, index) => ({
      id: `session-${agent.id}`,
      group: 'Sessions',
      label: `${displayName(agent)}${agent.state === 'waiting' ? ' — waits for you' : agent.state === 'ended' ? ' — ended' : ''}`,
      ...(index < 9 ? { keys: `⌘${index + 1}` } : {}),
      words: `${agent.project} ${agent.team?.role ?? ''} ${agent.state}`,
      run: () => store.open(agent.id),
    }));
    return [...actions, ...sessions];
  };
  // Dismissed notices of the top line (a newer Claude Code), by what they said: kept in this window.
  const [dismissed, setDismissed] = useState<string>(() => {
    try {
      return localStorage.getItem('forchetta.dismissed') ?? '';
    } catch {
      return '';
    }
  });
  const dismiss = (key: string): void => {
    setDismissed(key);
    try {
      localStorage.setItem('forchetta.dismissed', key);
    } catch {
      // For this time only.
    }
  };
  const system = state.system;
  const claudeNotice = system?.claude.newer === 'minor' ? `claude-${system.claude.installed}` : undefined;
  const hooksMissing = system?.checks.find((check) => check.id === 'hooks' && !check.ok);
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
    <div class={`app${working ? ' with-panes' : ''}${state.ready && !state.connected ? ' offline' : ''}`}>
      <header class="top">
        <h1>Forchetta</h1>
        <div class="top-right">
          {state.ready && <ClaudeUpdateNotice info={state.claudeUpdate} store={store} />}
          {state.ready && counts(agents, state.today, state.limits, state.guardStats, nextWaiting)}
          {state.ready && grouped && !working && (
            <span class="view-switch" role="group" aria-label="View">
              <button type="button" class={view === 'grid' ? 'on' : undefined} aria-pressed={view === 'grid'} onClick={() => chooseView('grid')}>
                grid
              </button>
              <button type="button" class={view === 'org' ? 'on' : undefined} aria-pressed={view === 'org'} onClick={() => chooseView('org')}>
                org chart
              </button>
            </span>
          )}
          {state.ready && <BroadcastButton agents={agents} open={panel === 'broadcast'} onToggle={() => toggle('broadcast')} />}
          {state.ready && (
            <button
              type="button"
              class={`broadcast-toggle quiet${panel === 'recall' ? ' active' : ''}`}
              title="Search the earlier sessions of a project (arricurdai recall)"
              aria-pressed={panel === 'recall'}
              onClick={() => toggle('recall')}
            >
              search
            </button>
          )}
          {state.ready && state.crews.length > 0 && (
            <button
              type="button"
              class={`broadcast-toggle${panel === 'crew' ? ' active' : ''}`}
              title="Your teams: write a request to their members, see where the last ones stand, what they cost"
              aria-pressed={panel === 'crew'}
              onClick={() => toggle('crew')}
            >
              teams
            </button>
          )}
          {state.ready && <NewMenu active={panel === 'new' || panel === 'team' || studio} onPick={startNew} />}
          {state.ready && (
            <button type="button" class={`broadcast-toggle quiet settings-toggle${panel === 'settings' ? ' active' : ''}`} aria-pressed={panel === 'settings'} title="Settings (⌘,) · Commands (⌘K)" aria-label="Settings" onClick={() => toggle('settings')}>
              ⚙
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
          key={live ?? 'draft'}
          agents={agents}
          store={store}
          live={live}
          onClose={() => {
            store.endCrewSpawn();
            setStudio(false);
            setLive(undefined);
          }}
        />
      )}
      {state.ready && panel === 'crew' && <TeamPanel
          crews={state.crews}
          store={store}
          onClose={() => toggle('crew')}
          onNew={() => setPanel('team')}
          onStudio={(crewId) => {
            setPanel(undefined);
            setLive(crewId);
            setStudio(true);
          }}
        />}
      {state.ready && panel === 'recall' && <RecallPanel agents={agents} store={store} onClose={() => toggle('recall')} />}
      {state.ready && panel === 'prompts' && <PromptsPanel store={store} onClose={() => setPanel(undefined)} />}
      {state.ready && panel === 'settings' && <SettingsPanel store={store} onClose={() => setPanel(undefined)} />}
      {state.ready && state.connected && !system && (
        <p class="notice" role="status">
          The daemon is older than this page: restart it to have everything (<code>forchetta daemon stop</code>, then open the app).
        </p>
      )}
      {state.ready && system && system.protocol !== PROTOCOL && (
        <p class="notice" role="status">
          This window and the daemon are of different versions of Forchetta.{' '}
          <button type="button" class="quiet" onClick={() => location.reload()}>
            Reload
          </button>
        </p>
      )}
      {state.ready && hooksMissing && panel !== 'settings' && agents.length > 0 && (
        <p class="notice" role="status">
          The hooks of Forchetta are not in place: the sessions send no events. <CopyCommand command="forchetta hooks install" />{' '}
          <button type="button" class="quiet" onClick={() => toggle('settings')}>
            Settings
          </button>
        </p>
      )}
      {state.ready && claudeNotice && dismissed !== claudeNotice && (
        <p class="notice" role="status">
          Claude Code {system?.claude.installed} is newer than the one this Forchetta was tested with ({system?.claude.tested}): if something looks off, <code>forchetta doctor</code> says what, and an
          issue helps.{' '}
          <button type="button" class="quiet" onClick={() => dismiss(claudeNotice)}>
            Got it
          </button>
        </p>
      )}
      {state.ready && !state.connected && (
        <p class="notice offline-notice" role="status">
          The daemon of Forchetta is not answering: what you see may be old, and nothing can be sent until it is back. Trying again… If it stays off: <CopyCommand command="forchetta daemon start" />
        </p>
      )}
      {!state.ready ? (
        <p class="empty">Connecting to the daemon…</p>
      ) : working ? (
        <Workspace state={state} store={store} agents={agents} now={now} />
      ) : agents.length === 0 ? (
        <div class="empty">
          {system && system.checks.some((check) => !check.ok) ? (
            <div class="getting-ready">
              <h2>Get Forchetta ready</h2>
              <SetupChecks system={system} store={store} />
            </div>
          ) : null}
          <p>No Claude Code session running.</p>
          <p class="hint">
            Start one with <code>forchetta run claude</code>, or <button type="button" class="link-button" onClick={() => startNew('session')}>a new session</button> (⌘N). ⌘K finds every command.
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
      <Announcer agents={agents} />
      {overlay === 'palette' && <Palette commands={paletteCommands()} onClose={() => setOverlay(undefined)} />}
      {overlay === 'shortcuts' && <ShortcutsSheet onClose={() => setOverlay(undefined)} />}
    </div>
  );
}
