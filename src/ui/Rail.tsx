import { memo } from 'preact/compat';
import { useRef } from 'preact/hooks';
import { type Agent, displayName, STATE_LABEL } from '../shared/agent.ts';
import { agoShort, conflictsTitle, hasEvents, stalledFor, stallText, waitingText } from '../shared/present.ts';
import { useMotionAnchor } from './anchor.ts';
import { heldBackText } from './Guard.tsx';
import { PermissionButtons } from './Permission.tsx';
import { runningSubagentsTag } from './Subagents.tsx';
import { canOpen, type Store } from './store.ts';

// With panes open, the boxes become a column on the left: project, state, one line, time. They keep their state
// colors and animations (the amber breath shows here too). A click opens or activates the pane of the session.

function line(agent: Agent): string {
  if (agent.state === 'waiting') return waitingText(agent);
  if (agent.state === 'working') return agent.action ? agent.action.label : 'thinking…';
  if (agent.state === 'error') return `error · ${agent.error?.kind ?? '?'}`;
  return agent.summary?.text ?? (agent.state === 'ended' ? 'ended' : 'ready');
}

interface Props {
  agent: Agent;
  now: number;
  open: boolean;
  onOpen: (id: string) => void;
  store: Store;
}

function CompactBoxView({ agent, now, open, onOpen, store }: Props) {
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
      <span class="compact-head">
        <span class="project" title={agent.team?.label ? agent.project : undefined}>
          {displayName(agent)}
        </span>
        <span class="state">{STATE_LABEL[agent.state]}</span>
      </span>
      <span class="compact-line" title={agent.permission?.detail}>
        {line(agent)}
      </span>
      {agent.permission && <PermissionButtons agent={agent} store={store} />}
      <span class="compact-meta">
        <span>{hasEvents(agent) && agent.state !== 'ended' ? agoShort(now - agent.lastEvent.at) : ''}</span>
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
            ⏸ held
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
  if (before.agent !== after.agent || before.open !== after.open || before.onOpen !== after.onOpen) return false;
  const a = before.agent;
  return !hasEvents(a) || agoShort(before.now - a.lastEvent.at) === agoShort(after.now - a.lastEvent.at);
});

export function Rail({ agents, now, open, onOpen, store }: { agents: readonly Agent[]; now: number; open: readonly string[]; onOpen: (id: string) => void; store: Store }) {
  return (
    <nav class="rail" aria-label="Sessions">
      {agents.map((agent) => (
        <CompactBox key={agent.id} agent={agent} now={now} open={open.includes(agent.id)} onOpen={onOpen} store={store} />
      ))}
    </nav>
  );
}
