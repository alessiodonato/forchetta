import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { type Agent, displayName, STATE_LABEL, type ToolFamily, type UsageLimits } from '../shared/agent.ts';
import {
  agoShort,
  CACHE_SOON_MS,
  cacheSoon,
  cacheText,
  COMPLETED_MS,
  conflictsTitle,
  conflictText,
  controlLabel,
  cornerTime,
  loopText,
  percentText,
  restLine,
  SHELL_TITLE,
  shownSubagents,
  stalledFor,
  stallText,
  shortTokens,
  subagentTime,
  tokensDetail,
  tokensTotal,
  usdText,
  waitingText,
} from '../shared/present.ts';
import { boxLabel } from './announce.ts';
import { Check, ToolIcon } from './icons.tsx';
import { useMotionAnchor } from './anchor.ts';
import { CommandBar, CommandStatus, currentCommand } from './Commands.tsx';
import { ReopenButton } from './Reopen.tsx';
import { OldVersionTag } from './Restarts.tsx';
import { animateEnter, animateShake } from './motion.ts';
import { moveAndKeep, moveKey } from './reorder.ts';
import { ArtifactsButton } from './Artifacts.tsx';
import { FilesButton } from './Files.tsx';
import { SubagentRows, SubagentsButton } from './Subagents.tsx';
import { PermissionOutcomeLine, PermissionPrompt, visibleOutcome } from './Permission.tsx';
import { GuardLines } from './Guard.tsx';
import { ShellButton } from './ShellButton.tsx';
import { ColorDot, roleText, TeamEditor } from './Team.tsx';
import { canOpen, type Store } from './store.ts';
import { placeText } from './platform.ts';

// One box per session. Its data-state drives the colors and the animations in the CSS; the few one-off
// animations (entering, shaking at an error) run here, through motion.ts.

interface Line {
  text: string;
  /** More than the text, for its tooltip. */
  title?: string;
  family?: ToolFamily;
  tone?: 'muted' | 'accent' | 'error';
}

/**
 * The line under the name: what it does now while it works or waits; otherwise something the state above does not
 * already say (when it finished, the folder, the error in words).
 */
function actionLine(agent: Agent, now: number, limits: UsageLimits | undefined): Line {
  switch (agent.state) {
    case 'working': {
      const action = agent.action;
      if (!action) return { text: 'thinking…', tone: 'muted' };
      return { text: action.subagent ? `↳ ${action.subagent} · ${action.label}` : action.label, family: action.family };
    }
    case 'waiting':
      return { text: waitingText(agent), tone: 'accent' };
    case 'error':
      return { text: restLine(agent, now, limits) ?? '', tone: 'error' };
    case 'compacting':
      return { text: restLine(agent, now) ?? '' };
    default:
      return {
        text: restLine(agent, now) ?? '',
        ...(agent.state === 'idle' && agent.backgroundShell ? { title: `${restLine(agent, now) ?? ''}\n${SHELL_TITLE}` } : {}),
        tone: 'muted',
      };
  }
}

function summaryText(agent: Agent): string | undefined {
  if (agent.state === 'error' && agent.error?.message) return agent.error.message;
  return agent.summary?.text;
}

function ContextBar({ agent }: { agent: Agent }) {
  const context = agent.context;
  const share = context ? Math.min(1, Math.max(0, context.percent / 100)) : 0;
  const tokens = context?.tokens.toLocaleString('en-US');
  const window = context?.window.toLocaleString('en-US');
  const title = !context
    ? 'No context yet: it shows after the first answer of the session'
    : context.source === 'statusline'
      ? `${tokens} tokens in the context, of a window of ${window} (from Claude Code)`
      : `${tokens} tokens in the last request, of an estimated window of ${window} (data from arricurdAI)`;
  return (
    <div class="ctx" title={title} data-high={context && context.percent >= 80 ? '' : undefined}>
      <div class="track">
        <div class="fill" style={{ transform: `scaleX(${share})` }}>
          <i class={agent.state === 'compacting' ? 'squeeze' : undefined} />
        </div>
      </div>
      <span class="pct">{context ? percentText(context) : '—'}</span>
    </div>
  );
}

function Meta({ agent, now, store }: { agent: Agent; now: number; store: Store }) {
  const { cache } = agent;
  const left = cache ? cache.expiresAt - now : 0;
  const soon = cacheSoon(agent, now);
  const expiry = cache ? new Date(cache.expiresAt).toLocaleTimeString('en-US') : '';
  const cacheTitle = cache
    ? `${left > 0 ? 'The prompt cache expires' : 'The prompt cache expired'} at ${expiry} (data from arricurdAI)`
    : undefined;
  const usage = agent.usage;
  const today = agent.today;
  // In a team, its own tokens since it started; otherwise today's, when arricurdAI says them.
  const tokens = agent.tokens && tokensTotal(agent.tokens) > 0 ? agent.tokens : undefined;
  const usageTitle = [
    usage
      ? `Cost of the session since it started: about ${usdText(usage.usd)} at API prices, computed by Claude Code as for /cost.`
      : 'The cost comes from the status line of Claude Code with the next message of the session.',
    tokens ? `Since it started, with its subagents: ${tokensDetail(tokens)}` : '',
    today
      ? `Today, with its subagents: ${today.tokens.toLocaleString('en-US')} tokens in ${today.calls.toLocaleString('en-US')} calls, about ${usdText(today.usd)} (data from arricurdAI).`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const time = cornerTime(agent, now);
  // The cache only when it counts: about to expire, or expired on a context that arricurdAI will stop.
  const stopped = cache !== undefined && left <= 0 && cache.guardWillStop === true;
  return (
    <footer class="meta">
      {(usage || tokens || (today && today.tokens > 0)) && (
        <span class="usage" title={usageTitle}>
          {usage ? `${usage.usd >= 0.01 ? '≈ ' : ''}${usdText(usage.usd)}` : ''}
          {tokens
            ? `${usage ? ' · ' : ''}${shortTokens(tokensTotal(tokens))} tok`
            : today && today.tokens > 0
              ? `${usage ? ' · ' : ''}today ${shortTokens(today.tokens)} tok`
              : ''}
        </span>
      )}
      {cache && (soon || stopped) && (
        <span class={`cache-left${soon ? ' soon' : ' faded'}`} title={cacheTitle}>
          {left <= 0 ? 'cache expired' : cacheText(cache, now)}
        </span>
      )}
      {stopped && (
        <span class="tag" title="arricurdAI will stop the next prompt: the cache expired on a large context">
          guard
        </span>
      )}
      <OldVersionTag agent={agent} store={store} now={now} />
      {/* One group, on the right: when the box is too narrow for one line, it goes whole to the next line. */}
      <span class="meta-end">
        {/* Its rows open the panel while they are in the box: the button only after. */}
        {shownSubagents(agent, now).length === 0 && <SubagentsButton agent={agent} store={store} />}
        <FilesButton agent={agent} store={store} />
        <ArtifactsButton agent={agent} />
        {time && (
          <span class="ago" title={time.title}>
            {time.text}
          </span>
        )}
        {/* In the tmux of Forchetta is the usual case: only the others say so. */}
        {agent.control.kind !== 'tmux' && agent.state !== 'ended' && <span class={`tag control-${agent.control.kind}`}>{controlLabel(agent)}</span>}
      </span>
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

/** A session going in circles: the same call failing the same way again and again in this turn (daemon/loops.ts). */
function LoopLine({ agent }: { agent: Agent }) {
  const loop = agent.loop;
  if (!loop || agent.state === 'ended') return null;
  return (
    <div
      class="conflict loop"
      title={`In this turn it ran ${loop.label} ${loop.count} times, and each time it failed the same way:\n${loop.error}\n\nOpen the terminal to give it a hint, or press Esc there to stop it.`}
    >
      <span class="conflict-mark">↻</span>
      <span class="conflict-text">{loopText(loop)}</span>
    </div>
  );
}

interface BoxProps {
  agent: Agent;
  now: number;
  entering: boolean;
  onEntered: (id: string) => void;
  /** A click opens the terminal of the session; only sessions in the tmux of Forchetta have one. It counts as seen. */
  onOpen: (id: string) => void;
  /** It finished, or stopped on an error, since you last looked: a dot until you click it. */
  unseen: boolean;
  /** The limits of the plan, for a session stopped on a rate limit: which one, and when it comes back. */
  limits?: UsageLimits;
  store: Store;
  /** In a team of agents: the request it works on, or the ones the lead waits on (shared/crew.ts, crewLineOf). */
  crewLine?: string;
}

function BoxView({ agent, now, entering, onEntered, onOpen, store, crewLine, unseen, limits }: BoxProps) {
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

  const line = actionLine(agent, now, limits);
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
      title={openable ? 'Open the terminal of the session' : agent.state === 'ended' ? undefined : placeText('Outside the tmux of Forchetta: read only. Start it with "forchetta run claude" to open it here.', store.state.system?.platform)}
      // From the keyboard too: Tab reaches it, Enter or Space opens it as a click. Its own buttons keep their keys.
      tabIndex={0}
      aria-label={boxLabel(agent, line.text, openable)}
      onClick={() => onOpen(agent.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const by = moveKey(event);
        if (by) {
          event.preventDefault();
          moveAndKeep(store, agent.id, by, event.currentTarget);
          return;
        }
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen(agent.id);
      }}
    >
      <div class="aura" aria-hidden="true" />
      <span class="busy" aria-hidden="true">
        <i />
      </span>
      {completed && (
        <span class="done" key={agent.completedAt}>
          <Check />
        </span>
      )}
      <header class="head">
        <h2 class="project" title={agent.cwd}>
          <ColorDot agent={agent} />
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
          title="Name, color, group and role"
          aria-label="Name, color, group and role"
          onClick={(event) => {
            event.stopPropagation();
            setEditingTeam(!editingTeam);
          }}
        >
          ✎
        </button>
        <span class="grow" />
        {roleText(agent) && (
          <span class="role" title={roleText(agent)}>
            {roleText(agent)}
          </span>
        )}
        {unseen && (
          <span class="unseen" title={agent.state === 'error' ? 'It stopped on an error since you last looked' : 'It finished since you last looked: click to mark it seen'}>
            ●
          </span>
        )}
        <span class="state">{STATE_LABEL[agent.state]}</span>
      </header>
      {editingTeam && <TeamEditor agent={agent} agents={[...store.state.agents.values()]} store={store} onClose={() => setEditingTeam(false)} />}
      <div class={`action${line.tone ? ` ${line.tone}` : ''}`}>
        {line.family && (
          <span class="icon" key={line.family}>
            <ToolIcon family={line.family} />
          </span>
        )}
        <span class="text" title={line.title ?? line.text}>
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
      <LoopLine agent={agent} />
      {agent.conflicts && (
        <div class="conflict" title={conflictsTitle(agent.conflicts)}>
          <span class="conflict-mark">⚠</span>
          <span class="conflict-text">
            {conflictText(agent.conflicts[0]!)}
            {agent.conflicts.length > 1 ? ` · +${agent.conflicts.length - 1}` : ''}
          </span>
        </div>
      )}
      <GuardLines agent={agent} store={store} />
      {crewLine && (
        <p class="crew-line" title={crewLine}>
          {crewLine}
        </p>
      )}
      <SubagentRows agent={agent} now={now} store={store} />
      <CommandStatus agent={agent} store={store} now={now} />
      <ReopenButton agent={agent} store={store} />
      <ContextBar agent={agent} />
      <Meta agent={agent} now={now} store={store} />
      {openable && (
        <div class={`box-commands${commanding ? ' active' : ''}`}>
          {/* The bar covers the last line on hover: its two buttons come with it, or they could not be clicked. */}
          {!commanding && shownSubagents(agent, now).length === 0 && <SubagentsButton agent={agent} store={store} />}
          {!commanding && <FilesButton agent={agent} store={store} />}
          {!commanding && <ArtifactsButton agent={agent} />}
          {!commanding && <ShellButton agent={agent} store={store} />}
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
    cornerTime(agent, now)?.text ?? '',
    restLine(agent, now) ?? '',
    agent.cache ? cacheText(agent.cache, now) : '',
    completed,
    soon,
    currentCommand(agent, now)?.id ?? '',
    // The stall line counts minutes as the time since the last event above does: no key of its own.
    visibleOutcome(agent, now) !== undefined,
    shownSubagents(agent, now)
      .map((subagent) => subagentTime(subagent, now))
      .join(','),
  ].join('|');
}

export const Box = memo(
  BoxView,
  (before, after) =>
    before.agent === after.agent &&
    before.crewLine === after.crewLine &&
    before.unseen === after.unseen &&
    before.limits === after.limits &&
    before.entering === after.entering &&
    before.onOpen === after.onOpen &&
    clockKey(before.agent, before.now) === clockKey(after.agent, after.now),
);
