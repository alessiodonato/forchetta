import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { type Agent, displayName, STATE_LABEL, type ToolFamily } from '../shared/agent.ts';
import {
  agoShort,
  CACHE_SOON_MS,
  cacheText,
  COMPLETED_MS,
  conflictsTitle,
  conflictText,
  controlLabel,
  hasEvents,
  percentText,
  stalledFor,
  stallText,
  shortTokens,
  usdText,
  waitingText,
} from '../shared/present.ts';
import { Check, ToolIcon } from './icons.tsx';
import { useMotionAnchor } from './anchor.ts';
import { CommandBar, CommandStatus, currentCommand } from './Commands.tsx';
import { animateEnter, animateShake } from './motion.ts';
import { FilesButton } from './Files.tsx';
import { PermissionOutcomeLine, PermissionPrompt, visibleOutcome } from './Permission.tsx';
import { roleText, TeamEditor } from './Team.tsx';
import { canOpen, type Store } from './store.ts';

// One box per session. Its data-state drives the colors and the animations in the CSS; the few one-off
// animations (entering, shaking at an error) run here, through motion.ts.

interface Line {
  text: string;
  family?: ToolFamily;
  tone?: 'muted' | 'accent' | 'error';
}

function actionLine(agent: Agent): Line {
  switch (agent.state) {
    case 'working': {
      const action = agent.action;
      if (!action) return { text: 'thinking…', tone: 'muted' };
      return { text: action.subagent ? `↳ ${action.subagent} · ${action.label}` : action.label, family: action.family };
    }
    case 'waiting':
      return { text: waitingText(agent), tone: 'accent' };
    case 'idle':
      return { text: agent.completedAt ? 'turn finished' : 'ready', tone: 'muted' };
    case 'starting':
      return { text: 'starting…', tone: 'muted' };
    case 'compacting':
      return { text: agent.compactTrigger === 'auto' ? 'compacting, automatically' : 'compacting, as you asked' };
    case 'error':
      return { text: `error · ${agent.error?.kind ?? '?'}`, tone: 'error' };
    case 'ended':
      return { text: `ended · ${agent.endReason ?? '?'}`, tone: 'muted' };
  }
}

function summaryText(agent: Agent): string | undefined {
  if (agent.state === 'error' && agent.error?.message) return agent.error.message;
  return agent.summary?.text;
}

const LARGE_CONTEXT = 100_000;

function ContextBar({ agent }: { agent: Agent }) {
  const context = agent.context;
  const share = context ? Math.min(1, Math.max(0, context.percent / 100)) : 0;
  const title = context
    ? `${context.tokens.toLocaleString('en-US')} tokens in the last request, of an estimated window of ${context.window.toLocaleString('en-US')} (data from arricurdAI)`
    : 'No data from arricurdAI for this session';
  return (
    <div class="ctx" title={title} data-high={context && context.percent >= 80 ? '' : undefined}>
      <div class="track">
        <div class="fill" style={{ transform: `scaleX(${share})` }}>
          <i class={agent.state === 'compacting' ? 'squeeze' : undefined} />
        </div>
      </div>
      <span class="pct">{context ? `${percentText(context)} · ${shortTokens(context.tokens)}` : '—'}</span>
    </div>
  );
}

function Meta({ agent, now, store }: { agent: Agent; now: number; store: Store }) {
  const { context, cache } = agent;
  const left = cache ? cache.expiresAt - now : 0;
  const soon = cache && left > 0 && left < CACHE_SOON_MS && (context?.tokens ?? 0) >= LARGE_CONTEXT;
  const expiry = cache ? new Date(cache.expiresAt).toLocaleTimeString('en-US') : '';
  const cacheTitle = cache
    ? `${left > 0 ? 'The prompt cache expires' : 'The prompt cache expired'} at ${expiry} (data from arricurdAI)`
    : undefined;
  const usage = agent.usage;
  const today = agent.today;
  const usageTitle = [
    usage
      ? `Cost of the session since it started: about ${usdText(usage.usd)} at API prices, computed by Claude Code as for /cost.`
      : 'The cost comes from the status line of Claude Code with the next message of the session.',
    today
      ? `Today, with its subagents: ${today.tokens.toLocaleString('en-US')} tokens in ${today.calls.toLocaleString('en-US')} calls, about ${usdText(today.usd)} (data from arricurdAI).`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <footer class="meta">
      <span class="usage" title={usageTitle}>
        {usage ? `${usage.usd >= 0.01 ? '≈ ' : ''}${usdText(usage.usd)}` : '—'}
        {today && today.tokens > 0 ? ` · today ${shortTokens(today.tokens)} tok` : ''}
      </span>
      {cache && (
        <span class={`cache-left${soon ? ' soon' : left <= 0 ? ' faded' : ''}`} title={cacheTitle}>
          {left <= 0 ? 'expired' : cacheText(cache, now)}
        </span>
      )}
      {cache && left <= 0 && cache.guardWillStop && (
        <span class="tag" title="arricurdAI will stop the next prompt: the cache expired on a large context">
          guard
        </span>
      )}
      <span class="grow" />
      <FilesButton agent={agent} store={store} />
      {hasEvents(agent) && agent.state !== 'ended' && (
        <span class="ago" title="Time since the last event">
          {agoShort(now - agent.lastEvent.at)}
        </span>
      )}
      <span class={`tag control-${agent.control.kind}`}>{controlLabel(agent)}</span>
    </footer>
  );
}

/** A session at work that gave no sign of life for a while: how long, and what it was doing. */
function StallLine({ agent, now, stallMs }: { agent: Agent; now: number; stallMs: number }) {
  const quiet = stalledFor(agent, now, stallMs);
  if (quiet === undefined) return null;
  const text = stallText(agent, quiet);
  return (
    <div
      class="conflict stall"
      title={`Claude Code has sent no event for ${agoShort(quiet)}. It may be a long command or a long answer, or the session is stuck: open the terminal to see.`}
    >
      <span class="conflict-mark">◷</span>
      <span class="conflict-text">{text}</span>
    </div>
  );
}

interface BoxProps {
  agent: Agent;
  now: number;
  entering: boolean;
  onEntered: (id: string) => void;
  /** A click opens the terminal of the session; only sessions in the tmux of Forchetta have one. */
  onOpen: (id: string) => void;
  store: Store;
}

function BoxView({ agent, now, entering, onEntered, onOpen, store }: BoxProps) {
  const [commanding, setCommanding] = useState(false);
  const [editingTeam, setEditingTeam] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (entering && ref.current) animateEnter(ref.current);
    if (entering) onEntered(agent.id);
  }, []);

  // One shake per error, also when the box appears with an error that just happened.
  const errorAt = agent.state === 'error' ? agent.error?.at : undefined;
  const shaken = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (errorAt === undefined || shaken.current === errorAt || !ref.current) return;
    shaken.current = errorAt;
    if (Date.now() - errorAt < 5000) animateShake(ref.current);
  }, [errorAt]);

  const since = useMotionAnchor(ref, agent.state);
  const openable = canOpen(agent);

  const line = actionLine(agent);
  const summary = summaryText(agent);
  const completed = agent.state === 'idle' && agent.completedAt !== undefined && now - agent.completedAt < COMPLETED_MS;

  return (
    <article
      ref={ref}
      class="box"
      data-id={agent.id}
      data-state={agent.state}
      data-since={since}
      data-completed={completed ? '' : undefined}
      data-openable={openable ? '' : undefined}
      title={openable ? 'Open the terminal of the session' : agent.state === 'ended' ? undefined : 'Outside the tmux of Forchetta: read only. Start it with "forchetta run claude" to open it here.'}
      onClick={openable ? () => onOpen(agent.id) : undefined}
    >
      <div class="aura" aria-hidden="true" />
      {completed && (
        <span class="done" key={agent.completedAt}>
          <Check />
        </span>
      )}
      <header class="head">
        <h2 class="project" title={agent.cwd}>
          {displayName(agent)}
        </h2>
        {agent.team?.label && (
          <span class="folder" title={agent.cwd}>
            {agent.project}
          </span>
        )}
        <button
          type="button"
          class="team-edit"
          title="Name, group and role"
          aria-label="Name, group and role"
          onClick={(event) => {
            event.stopPropagation();
            setEditingTeam(!editingTeam);
          }}
        >
          ✎
        </button>
        <span class="grow" />
        {roleText(agent) && <span class="role">{roleText(agent)}</span>}
        <span class="state">{STATE_LABEL[agent.state]}</span>
      </header>
      {editingTeam && <TeamEditor agent={agent} agents={[...store.state.agents.values()]} store={store} onClose={() => setEditingTeam(false)} />}
      <div class={`action${line.tone ? ` ${line.tone}` : ''}`}>
        {line.family && (
          <span class="icon" key={line.family}>
            <ToolIcon family={line.family} />
          </span>
        )}
        <span class="text" title={line.text}>
          {line.text}
        </span>
      </div>
      {agent.permission ? (
        <PermissionPrompt agent={agent} store={store} />
      ) : (
        <p class="summary" title={summary}>
          {summary ?? ''}
          {agent.summary?.source === 'haiku' && summary === agent.summary.text && <span class="by" title="Summary written by Haiku"> · H</span>}
        </p>
      )}
      <PermissionOutcomeLine agent={agent} now={now} />
      <StallLine agent={agent} now={now} stallMs={(store.state.settings.stallMin ?? 10) * 60_000} />
      {agent.conflicts && (
        <div class="conflict" title={conflictsTitle(agent.conflicts)}>
          <span class="conflict-mark">⚠</span>
          <span class="conflict-text">
            {conflictText(agent.conflicts[0]!)}
            {agent.conflicts.length > 1 ? ` · +${agent.conflicts.length - 1}` : ''}
          </span>
        </div>
      )}
      <CommandStatus agent={agent} store={store} now={now} />
      <ContextBar agent={agent} />
      <Meta agent={agent} now={now} store={store} />
      {openable && (
        <div class={`box-commands${commanding ? ' active' : ''}`}>
          <CommandBar agent={agent} store={store} onModeChange={setCommanding} />
        </div>
      )}
    </article>
  );
}

/** What of a box changes with the clock alone: when it is the same, the box does not render again. */
function clockKey(agent: Agent, now: number): string {
  const completed = agent.state === 'idle' && agent.completedAt !== undefined && now - agent.completedAt < COMPLETED_MS;
  const left = agent.cache ? agent.cache.expiresAt - now : 0;
  const soon = agent.cache !== undefined && left > 0 && left < CACHE_SOON_MS;
  return [
    hasEvents(agent) ? agoShort(now - agent.lastEvent.at) : '',
    agent.cache ? cacheText(agent.cache, now) : '',
    completed,
    soon,
    currentCommand(agent, now)?.id ?? '',
    // The stall line counts minutes as the time since the last event above does: no key of its own.
    visibleOutcome(agent, now) !== undefined,
  ].join('|');
}

export const Box = memo(
  BoxView,
  (before, after) =>
    before.agent === after.agent &&
    before.entering === after.entering &&
    before.onOpen === after.onOpen &&
    clockKey(before.agent, before.now) === clockKey(after.agent, after.now),
);
