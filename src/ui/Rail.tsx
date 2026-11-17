import { memo } from 'preact/compat';
import { useRef } from 'preact/hooks';
import { type Agent, displayName, SESSION_COLOR_HEX, STATE_LABEL, type UsageLimits } from '../shared/agent.ts';
import { conflictsTitle, cornerTime, errorLine, stalledFor, stallText, waitingText } from '../shared/present.ts';
import { useMotionAnchor } from './anchor.ts';
import { heldBackText } from './Guard.tsx';
import { PermissionButtons } from './Permission.tsx';
import { runningSubagentsTag } from './Subagents.tsx';
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
        if (event.key === 'Enter' || event.key === ' ') {
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
    <nav class="rail" aria-label="Sessions">
      <button type="button" class="rail-toggle" title="Hide the column of sessions: the panes take its room" aria-expanded="true" onClick={onToggle}>
        ‹
      </button>
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
    </nav>
  );
}
