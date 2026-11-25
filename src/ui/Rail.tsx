import { memo } from 'preact/compat';
import { useRef, useState } from 'preact/hooks';
import { type Agent, displayName, SESSION_COLOR_HEX, STATE_LABEL, type UsageLimits } from '../shared/agent.ts';
import type { CrewSummary } from '../shared/crew.ts';
import { conflictsTitle, cornerTime, crewUsage, errorLine, SHELL_TITLE, shortTokens, stalledFor, stallText, tokensTotal, usdText, waitingText } from '../shared/present.ts';
import { useMotionAnchor } from './anchor.ts';
import { heldBackText } from './Guard.tsx';
import { PermissionButtons } from './Permission.tsx';
import { runningSubagentsTag } from './Subagents.tsx';
import { moveAndKeep, moveKey, useReorder } from './reorder.ts';
import { canOpen, type Store } from './store.ts';
import { ColorDot } from './Team.tsx';

// With panes open, the boxes become a column on the left: project, state, one line, time. They keep their state
// colors and animations (the amber breath shows here too). A click opens or activates the pane of the session.
// The column can be hidden: then a thin strip keeps one square per session, with its initial, its color and the
// color of its state, so a session that waits for you still shows.

function line(agent: Agent, now: number, limits: UsageLimits | undefined): string {
  if (agent.state === 'waiting') return waitingText(agent);
  if (agent.state === 'working') return agent.action ? agent.action.label : 'thinking…';
  if (agent.state === 'error') return errorLine(agent, limits, now);
  return agent.summary?.text ?? (agent.state === 'ended' ? 'ended' : 'ready');
}

interface Props {
  agent: Agent;
  now: number;
  open: boolean;
  onOpen: (id: string) => void;
  store: Store;
  unseen: boolean;
  limits?: UsageLimits;
}

function CompactBoxView({ agent, now, open, onOpen, store, unseen, limits }: Props) {
  const stallMs = (store.state.settings.stallMin ?? 10) * 60_000;
  const ref = useRef<HTMLDivElement>(null);
  const since = useMotionAnchor(ref, agent.state);
  const openable = canOpen(agent);
  const subagents = runningSubagentsTag(agent);
  const title = openable ? undefined : agent.state === 'ended' ? 'Session ended' : 'Outside the tmux of Forchetta: read only. Start it with "forchetta run claude" to open it here.';
  return (
    // A div with the role of a button: a <button> does not lay out its content as a flex column in WebKit.
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      class="box compact"
      data-id={agent.id}
      data-state={agent.state}
      data-since={since}
      data-open={open ? '' : undefined}
      data-openable={openable ? '' : undefined}
      title={title}
      onClick={() => onOpen(agent.id)}
      onKeyDown={(event) => {
        // In a team the order is the one of its chart.
        const by = event.target === event.currentTarget && !agent.team?.crew ? moveKey(event) : undefined;
        if (by) {
          event.preventDefault();
          moveAndKeep(store, agent.id, by, event.currentTarget);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(agent.id);
        }
      }}
    >
      <span class="aura" aria-hidden="true" />
      <span class="busy" aria-hidden="true">
        <i />
      </span>
      <span class="compact-head">
        <span class="project" title={agent.team?.label ? agent.project : undefined}>
          <ColorDot agent={agent} />
          {displayName(agent)}
        </span>
        {unseen && (
          <span class="unseen" title="It finished since you last looked">
            ●
          </span>
        )}
        <span class="state">{STATE_LABEL[agent.state]}</span>
      </span>
      <span class="compact-line" title={agent.permission?.detail}>
        {line(agent, now, limits)}
      </span>
      {agent.permission && <PermissionButtons agent={agent} store={store} />}
      <span class="compact-meta">
        <span title={cornerTime(agent, now)?.title}>{cornerTime(agent, now)?.text ?? ''}</span>
        {subagents && (
          <span class="tag" title={subagents.title}>
            {subagents.text}
          </span>
        )}
        {stalledFor(agent, now, stallMs) !== undefined && (
          <span class="tag conflict-tag" title={stallText(agent, stalledFor(agent, now, stallMs)!)}>
            ◷ stuck?
          </span>
        )}
        {agent.state === 'idle' && agent.backgroundShell && (
          <span class="tag" title={SHELL_TITLE}>
            shell
          </span>
        )}
        {agent.heldBack && (
          <span class="tag guard-tag" title={agent.heldBack.map(heldBackText).join('\n')}>
            ‖ held
          </span>
        )}
        {agent.conflicts && (
          <span class="tag conflict-tag" title={conflictsTitle(agent.conflicts)}>
            ⚠ {agent.conflicts[0]!.kind === 'file' ? 'same file' : 'same repo'}
          </span>
        )}
        {!openable && agent.state !== 'ended' && <span class="tag">read only</span>}
      </span>
    </div>
  );
}

export const CompactBox = memo(CompactBoxView, (before, after) => {
  if (before.agent !== after.agent || before.open !== after.open || before.onOpen !== after.onOpen || before.unseen !== after.unseen || before.limits !== after.limits) return false;
  return cornerTime(before.agent, before.now)?.text === cornerTime(after.agent, after.now)?.text;
});

/** The first letter of the name of a session, for its square in the hidden column. */
export function initialOf(agent: Agent): string {
  return [...displayName(agent).trim()][0]?.toUpperCase() ?? '·';
}

/** A session in the hidden column: a square with its initial; its state in the border, its name on hover. */
function MiniBox({ agent, open, onOpen, unseen }: { agent: Agent; open: boolean; onOpen: (id: string) => void; unseen: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const since = useMotionAnchor(ref, agent.state);
  const color = agent.team?.color;
  const label = `${displayName(agent)} · ${STATE_LABEL[agent.state]}${unseen ? ' · it finished since you last looked' : ''}`;
  return (
    <button
      ref={ref}
      type="button"
      class="rail-mini"
      data-state={agent.state}
      data-since={since}
      data-open={open ? '' : undefined}
      data-unseen={unseen ? '' : undefined}
      title={label}
      aria-label={label}
      style={color ? { '--session-color': SESSION_COLOR_HEX[color] } : undefined}
      onClick={() => onOpen(agent.id)}
    >
      {initialOf(agent)}
      <span class="busy" aria-hidden="true">
        <i />
      </span>
    </button>
  );
}

/** One line of the column: a session on its own, or a team with its sessions, the lead first. */
export type RailItem = { kind: 'agent'; agent: Agent } | { kind: 'team'; crew: CrewSummary; agents: Agent[] };

/** The column in order: the sessions of a team together, where the first of them was. */
export function railItems(agents: readonly Agent[], crews: readonly CrewSummary[]): RailItem[] {
  const items: RailItem[] = [];
  const teams = new Map<string, Extract<RailItem, { kind: 'team' }>>();
  for (const agent of agents) {
    const crew = agent.team?.crew ? crews.find((candidate) => candidate.id === agent.team!.crew) : undefined;
    if (!crew) {
      items.push({ kind: 'agent', agent });
      continue;
    }
    let team = teams.get(crew.id);
    if (!team) {
      team = { kind: 'team', crew, agents: [] };
      teams.set(crew.id, team);
      items.push(team);
    }
    team.agents.push(agent);
  }
  // In a team, the order of its chart: the lead, then the members as they were added.
  for (const team of teams.values()) {
    const order = (team.crew.recipients ?? []).map((recipient) => recipient.agentId);
    const rank = (agent: Agent): number => (order.includes(agent.id) ? order.indexOf(agent.id) : order.length);
    team.agents.sort((a, b) => rank(a) - rank(b));
  }
  return items;
}

const EXPANDED_KEY = 'forchetta.railTeams';

function savedExpanded(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** A team in the column: one box with its name and how it is doing; open, its sessions under it. */
function TeamGroup({
  crew,
  agents,
  now,
  open,
  onOpen,
  store,
  expanded,
  onToggle,
}: {
  crew: CrewSummary;
  agents: readonly Agent[];
  now: number;
  open: readonly string[];
  onOpen: (id: string) => void;
  store: Store;
  expanded: boolean;
  onToggle: () => void;
}) {
  const waiting = agents.filter((agent) => agent.state === 'waiting').length;
  const working = agents.filter((agent) => agent.state === 'working').length;
  const failed = agents.some((agent) => agent.state === 'error');
  const state = waiting > 0 ? 'waiting' : working > 0 ? 'working' : failed ? 'error' : 'idle';
  const used = crewUsage(agents);
  const tokens = used ? tokensTotal(used.tokens) : 0;
  const usage = used && (used.usd > 0 || tokens > 0) ? [used.usd > 0 ? `${used.usd >= 0.01 ? '≈ ' : ''}${usdText(used.usd)}` : '', tokens > 0 ? `${shortTokens(tokens)} tok` : ''].filter(Boolean).join(' · ') : '';
  const status = waiting > 0 ? `${waiting} ${waiting === 1 ? 'waits' : 'wait'} for you` : working > 0 ? `${working} working` : failed ? 'one stopped with an error' : 'all idle';
  return (
    <div class="rail-team" data-id={`team-${crew.id}`} data-state={state} data-expanded={expanded ? '' : undefined} data-open={agents.some((agent) => open.includes(agent.id)) ? '' : undefined}>
      <button
        type="button"
        class="rail-team-head"
        data-drag-handle=""
        aria-expanded={expanded}
        title={expanded ? `Hide the sessions of ${crew.name}` : `Show the ${agents.length} sessions of ${crew.name}`}
        onClick={onToggle}
      >
        <span class="rail-team-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span class="rail-team-name">{crew.name}</span>
        <span class="rail-team-count">{agents.length}</span>
      </button>
      <span class="rail-team-line">
        {status}
        {usage ? ` · ${usage}` : ''}
      </span>
      {expanded && (
        <div class="rail-team-members">
          {agents.map((agent) => (
            <CompactBox
              key={agent.id}
              agent={agent}
              now={now}
              open={open.includes(agent.id)}
              onOpen={onOpen}
              store={store}
              unseen={store.unseen(agent)}
              limits={agent.state === 'error' ? store.state.limits : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Rail({
  agents,
  now,
  open,
  onOpen,
  store,
  hidden,
  onToggle,
}: {
  agents: readonly Agent[];
  now: number;
  open: readonly string[];
  onOpen: (id: string) => void;
  store: Store;
  hidden: boolean;
  onToggle: () => void;
}) {
  // The teams whose sessions show, kept for the next time.
  const [expanded, setExpanded] = useState<Set<string>>(savedExpanded);
  const toggleTeam = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      } catch {
        // Only for this window.
      }
      return next;
    });
  };
  // Dragged into another order: a session, or a team with all its sessions.
  const column = useRef<HTMLElement>(null);
  const items = railItems(agents, store.state.crews);
  const idsOf = (id: string | undefined): string[] => items.filter((item) => id !== undefined && (item.kind === 'team' ? `team-${item.crew.id}` : item.agent.id) === id).flatMap((item) => (item.kind === 'team' ? item.agents.map((agent) => agent.id) : [item.agent.id]));
  useReorder(column, store.state.order !== undefined && !hidden && items.length > 1, true, (id, before) => {
    // Before a team: before the first of its sessions in the order of the boxes.
    const first = new Set(idsOf(before));
    store.moveBoxes(idsOf(id), agents.find((agent) => first.has(agent.id))?.id);
  });
  if (hidden) {
    return (
      <nav class="rail hidden" aria-label="Sessions">
        <button type="button" class="rail-toggle" title="Show the column of sessions" aria-expanded="false" onClick={onToggle}>
          ›
        </button>
        {agents.map((agent) => (
          <MiniBox key={agent.id} agent={agent} open={open.includes(agent.id)} onOpen={onOpen} unseen={store.unseen(agent)} />
        ))}
      </nav>
    );
  }
  return (
    <nav class="rail" aria-label="Sessions" ref={column}>
      <button type="button" class="rail-toggle" title="Hide the column of sessions: the panes take its room" aria-expanded="true" onClick={onToggle}>
        ‹
      </button>
      {items.map((item) =>
        item.kind === 'team' ? (
          <TeamGroup
            key={`team-${item.crew.id}`}
            crew={item.crew}
            agents={item.agents}
            now={now}
            open={open}
            onOpen={onOpen}
            store={store}
            expanded={expanded.has(item.crew.id)}
            onToggle={() => toggleTeam(item.crew.id)}
          />
        ) : (
          <CompactBox
            key={item.agent.id}
            agent={item.agent}
            now={now}
            open={open.includes(item.agent.id)}
            onOpen={onOpen}
            store={store}
            unseen={store.unseen(item.agent)}
            limits={item.agent.state === 'error' ? store.state.limits : undefined}
          />
        ),
      )}
    </nav>
  );
}
