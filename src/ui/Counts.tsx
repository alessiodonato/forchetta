import type { ComponentChildren } from 'preact';
import { type Agent, displayName, type TodayInfo, type UsageLimits } from '../shared/agent.ts';
import { limitParts, shortTokens, usdText } from '../shared/present.ts';
import { guardTotal, type GuardStatsInfo, statsTitle } from '../shared/guard-stats.ts';
import { dayHeights, markGap, sessionKinds, sessionMarks, sessionsTitle } from './counts-model.ts';

// The counts of the top line: each a name and its number, and under them a band of marks on one baseline, the one
// that fits what is counted. The days of the guard are columns, a limit is how much of it is used, the sessions are
// a mark each: those that need you stand taller than the others, so it does not take the color to see them.

function todayTitle(today: TodayInfo): string {
  const since = new Date(today.since).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const unpriced = today.unpricedCalls > 0 ? `, ${today.unpricedCalls} of them from models with no known price left out of the cost` : '';
  return `Every session since ${since}: ${today.calls.toLocaleString('en-US')} calls, ${today.tokens.toLocaleString('en-US')} tokens, at API prices${unpriced} (data from arricurdAI)`;
}

interface CountProps {
  name: string;
  value: string;
  /** Beside the number: when a limit runs out, when it is back. */
  note?: string;
  /** Read aloud after the number, not shown: what the marks say. */
  aloud?: string;
  level?: 'calm' | 'warn' | 'out';
  title?: string;
  children?: ComponentChildren;
}

function Count({ name, value, note, aloud, level, title, children }: CountProps) {
  return (
    <div class="count" data-level={level} title={title}>
      <span class="count-line">
        <span class="count-name">{name}</span> <span class="count-value">{value}</span>
        {note && <span class="count-note"> {note}</span>}
        {aloud && <span class="sr-only"> {aloud}</span>}
      </span>
      {children}
    </div>
  );
}

/** Under a count with no marks to draw: a few words, in their place. */
const Caption = ({ children }: { children: ComponentChildren }) => <span class="count-caption">{children}</span>;

/** How much is used. A little still shows: 1% of 68 px would be less than a pixel. */
function Meter({ percent }: { percent: number }) {
  const shown = percent > 0 ? Math.min(100, Math.max(6, percent)) : 0;
  return (
    <span class="count-band" aria-hidden="true">
      <span class="count-meter">
        <i style={{ transform: `translateX(${shown - 100}%)` }} />
      </span>
    </span>
  );
}

function GuardCount({ stats }: { stats: GuardStatsInfo }) {
  const total = guardTotal(stats.counts);
  const days = stats.byDay;
  return (
    <Count name="guard" value={total.toLocaleString('en-US')} title={statsTitle(stats)} aloud={days ? 'this week' : undefined}>
      {days ? (
        <span class="count-band count-days" aria-hidden="true">
          {dayHeights(days).map((height, index) => (
            <i key={index} data-none={days[index] ? undefined : ''} data-today={index === days.length - 1 ? '' : undefined} style={{ height: `${height}px` }} />
          ))}
        </span>
      ) : (
        <Caption>this week</Caption>
      )}
    </Count>
  );
}

/** As wide as "sessions 13" needs, so that the marks end where the number does. */
const SESSIONS_WIDTH = 74;

function SessionsCount({ agents }: { agents: readonly Agent[] }) {
  const kinds = sessionKinds(agents);
  const total = kinds.reduce((sum, { count }) => sum + count, 0);
  return (
    <Count name={total === 1 ? 'session' : 'sessions'} value={String(total)} title={sessionsTitle(kinds) || undefined}>
      {total === 0 ? (
        <Meter percent={0} />
      ) : (
        <span class="count-band" aria-hidden="true" style={{ width: `${SESSIONS_WIDTH}px`, gap: `${markGap(total)}px` }}>
          {sessionMarks(kinds, SESSIONS_WIDTH).map((mark, index) => (
            <i key={index} class="count-mark" data-kind={mark.kind} style={{ width: `${mark.width}px` }} />
          ))}
        </span>
      )}
    </Count>
  );
}

interface CountsProps {
  agents: readonly Agent[];
  today?: TodayInfo;
  limits?: UsageLimits;
  guardStats?: GuardStatsInfo;
  onWaiting: () => void;
}

export function Counts({ agents, today, limits, guardStats, onWaiting }: CountsProps) {
  const waiting = agents.filter((agent) => agent.state === 'waiting').length;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const parts = limitParts(limits, Date.now(), (id) => {
    const agent = byId.get(id);
    return agent ? displayName(agent) : undefined;
  });
  // With the limits of a plan, what counts is how much of them is left: the cost at API prices goes in their tooltip.
  const todayLine = today ? `today ≈ ${usdText(today.usd)} · ${shortTokens(today.tokens)} tokens` : undefined;
  return (
    <div class="counts">
      {/* What the guard did this week: shown once it did something, the details in its tooltip. */}
      {guardStats && guardTotal(guardStats.counts) > 0 && <GuardCount stats={guardStats} />}
      {today && parts.length === 0 && (
        <Count name="today" value={`≈ ${usdText(today.usd)}`} title={todayTitle(today)}>
          <Caption>{shortTokens(today.tokens)} tokens</Caption>
        </Count>
      )}
      {parts.map((part, index) => (
        <Count key={part.name} name={part.name} value={part.value} note={part.level === 'out' ? undefined : part.note} level={part.level} title={index === 0 && today ? `${part.title}\n\n${todayLine}: ${todayTitle(today)}` : part.title}>
          {part.level === 'out' ? <Caption>{part.note}</Caption> : <Meter percent={part.percent} />}
        </Count>
      ))}
      <SessionsCount agents={agents} />
      {waiting > 0 && (
        <button type="button" class="waiting-button" title="Open the next session that waits for you (⌘])" onClick={onWaiting}>
          {waiting} {waiting === 1 ? 'waits for you' : 'wait for you'}
        </button>
      )}
    </div>
  );
}
