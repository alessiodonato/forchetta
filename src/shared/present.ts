import type { Agent, CacheInfo, Conflict, ContextInfo, Subagent, UsageLimits } from './agent.ts';

// How an agent reads, in English, for `forchetta ls` and for the boxes of the app. No Node module here.

/** 4 s, 3 min, 1 h 5 min, 2 d. */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d`;
}

/**
 * The same, for the boxes: within the first minute it moves in steps of 5 s ("now", "5 s", "10 s"), so that a
 * dozen boxes do not render again every second.
 */
export function agoShort(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${Math.floor(seconds / 5) * 5} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/** A session found by `claude agents --json` has sent no event yet: no time to show. */
export const hasEvents = (agent: Agent): boolean => agent.lastEvent.name !== 'rilevata';

/** What the agent is doing, in one line. */
export function activity(agent: Agent): string {
  switch (agent.state) {
    case 'starting':
      return 'starting…';
    case 'working': {
      const action = agent.action;
      if (action) return action.subagent ? `↳ ${action.subagent}: ${action.label}` : action.label;
      return agent.summary?.text ?? 'working';
    }
    case 'waiting':
      return waitingText(agent);
    case 'idle':
      return agent.summary?.text ?? '—';
    case 'compacting':
      return agent.compactTrigger === 'auto' ? 'compacting, automatically' : 'compacting, as you asked';
    case 'error':
      return `Error: ${agent.error?.kind ?? '?'}${agent.error?.message ? ` — ${agent.error.message}` : ''}`;
    case 'ended':
      return `ended (${agent.endReason ?? '?'})`;
  }
}

export function waitingText(agent: Agent): string {
  const waiting = agent.waiting;
  if (!waiting) return 'waits for you';
  if (waiting.kind === 'permesso') return `Permission: ${waiting.detail ?? waiting.tool ?? '?'}`;
  if (waiting.kind === 'domanda') return `Question: ${waiting.detail ?? '?'}`;
  return waiting.detail ?? 'dialog open';
}

export function controlLabel(agent: Agent): string {
  if (agent.control.kind === 'tmux') return 'tmux';
  return agent.control.reason === 'background' ? 'background' : 'read only';
}

/** 812, 357k, 1.2M: as `arricurdai status` writes them. */
export function shortTokens(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(tokens >= 1e7 ? 0 : 1)}M`;
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}k`;
  return String(tokens);
}

/**
 * The share of the window. From the status line it is Claude Code's own number; from arricurdAI it is marked as an
 * estimate (≈), because the window comes from a table, not from Claude Code.
 */
export const percentText = (context: ContextInfo): string => `${context.source === 'statusline' ? '' : '≈'}${context.percent}%`;

/** cache 42 min, cache 45 s (in steps of 5 s), cache expired. */
export function cacheText(cache: CacheInfo, now: number): string {
  const left = cache.expiresAt - now;
  if (left <= 0) return 'cache expired';
  if (left < 60_000) return `cache ${Math.ceil(left / 5000) * 5} s`;
  return `cache ${Math.floor(left / 60_000)} min`;
}

/** The last minutes of a large live cache, when going on still saves the rewrite: as the menu of arricurdAI. */
export const CACHE_SOON_MS = 10 * 60_000;

/** A context large enough that a cache about to expire is worth a warning. */
export const LARGE_CONTEXT = 100_000;

/** A cache that expires within CACHE_SOON_MS on a large context: the box and `forchetta ls` paint it amber. */
export function cacheSoon(agent: Pick<Agent, 'cache' | 'context'>, now: number): boolean {
  const left = agent.cache ? agent.cache.expiresAt - now : 0;
  return left > 0 && left < CACHE_SOON_MS && (agent.context?.tokens ?? 0) >= LARGE_CONTEXT;
}

/** How long the check of a finished turn stays on the box. */
export const COMPLETED_MS = 2600;

/**
 * The next moment a text of the box changes by itself (the time since the last event, the cache countdown,
 * the end of the check), so that the page renders only then and not every second.
 */
export function nextChange(agent: Agent, now: number): number | undefined {
  const times: number[] = [];
  if (hasEvents(agent) && agent.state !== 'ended') {
    const age = now - agent.lastEvent.at;
    const step = age < 60_000 ? 5000 : age < 3_600_000 ? 60_000 : 3_600_000;
    times.push(agent.lastEvent.at + (Math.floor(age / step) + 1) * step);
  }
  if (agent.cache && agent.state !== 'ended') {
    const expires = agent.cache.expiresAt;
    const left = expires - now;
    // Minutes are rounded down: "2 min" lasts while 120 s <= left < 180 s. The last minute is rounded up to
    // steps of 5 s: "50 s" lasts while 45 s < left <= 50 s.
    if (left >= 60_000) times.push(expires - Math.floor(left / 60_000) * 60_000 + 1);
    else if (left > 0) times.push(expires - (Math.ceil(left / 5000) - 1) * 5000);
  }
  if (agent.completedAt !== undefined && agent.completedAt + COMPLETED_MS > now) times.push(agent.completedAt + COMPLETED_MS);
  for (const subagent of shownSubagents(agent, now)) {
    if (subagent.state === 'running') {
      // Its time moves as agoShort does: every 5 s in the first minute, then every minute.
      const age = now - subagent.startedAt;
      const step = age < 60_000 ? 5000 : age < 3_600_000 ? 60_000 : 3_600_000;
      times.push(subagent.startedAt + (Math.floor(age / step) + 1) * step);
    } else if (subagent.endedAt !== undefined) {
      times.push(subagent.endedAt + SUBAGENT_SHOWN_MS);
    }
  }
  const future = times.filter((time) => time > now);
  return future.length > 0 ? Math.min(...future) : undefined;
}

/** $0.42, $12.40, $1,234: dollars at API prices, as `arricurdai status` writes them. Below a cent: <$0.01. */
export function usdText(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: usd >= 1000 ? 0 : 2, maximumFractionDigits: usd >= 1000 ? 0 : 2 })}`;
}

/** A limit of the Claude plan in the top line: its words, how loud, and the whole story for the tooltip. */
export interface LimitPart {
  text: string;
  level: 'calm' | 'warn' | 'out';
  title: string;
}

/** After this long with no status line the pace is old news: someone stopped, or every session is idle. */
export const LIMITS_PACE_FRESH_MS = 15 * 60_000;

const hourText = (at: number): string => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayText = (at: number): string => new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * The limits for the top line: "5h 62%", "5h 62% · out ≈3:20 PM" when at this pace it runs out before the reset,
 * "5h used up · back 4:40 PM"; then "week 31%". A window whose reset has passed says nothing: a new one began.
 */
export function limitParts(limits: UsageLimits | undefined, now: number, nameOf: (agentId: string) => string | undefined = () => undefined): LimitPart[] {
  const parts: LimitPart[] = [];
  const five = limits?.fiveHour;
  if (limits && five && five.resetsAt > now) {
    const reset = hourText(five.resetsAt);
    const fresh = now - limits.at < LIMITS_PACE_FRESH_MS;
    const runsOut = fresh && five.runsOutAt !== undefined && five.runsOutAt > now ? five.runsOutAt : undefined;
    if (five.percent >= 100) {
      parts.push({ text: `5h used up · back ${reset}`, level: 'out', title: `The 5-hour limit of your Claude plan is used up: sessions stop until ${reset}.` });
    } else {
      const pace = runsOut === undefined ? '' : ` At the pace of the last half hour it runs out at about ${hourText(runsOut)}, ${ago(five.resetsAt - runsOut)} before the reset.`;
      const named = (five.sessions ?? []).map((session) => ({ name: nameOf(session.agentId), percent: session.percent })).filter((session) => session.name);
      const who = named.length >= 2 ? `\nWhat the sessions spent in this window, an estimate from their cost: ${named.map((session) => `${session.name} ${session.percent}%`).join(', ')}.` : '';
      parts.push({
        text: runsOut === undefined ? `5h ${five.percent}%` : `5h ${five.percent}% · out ≈${hourText(runsOut)}`,
        level: runsOut !== undefined || five.percent >= 90 ? 'warn' : 'calm',
        title: `5-hour limit of your Claude plan: ${five.percent}% used, it resets at ${reset}.${pace}${who}`,
      });
    }
  }
  const week = limits?.sevenDay;
  if (week && week.resetsAt > now) {
    const reset = dayText(week.resetsAt);
    if (week.percent >= 100) {
      parts.push({ text: `week used up · back ${reset}`, level: 'out', title: `The weekly limit of your Claude plan is used up: sessions stop until ${reset}.` });
    } else {
      parts.push({ text: `week ${week.percent}%`, level: week.percent >= 90 ? 'warn' : 'calm', title: `Weekly limit of your Claude plan: ${week.percent}% used, it resets ${reset}.` });
    }
  }
  return parts;
}

/** The result of a session you may not have seen yet: when its last turn ended, or when it stopped on an error. */
export function resultAt(agent: Agent): number | undefined {
  if (agent.state === 'idle' && agent.completedAt !== undefined) return agent.completedAt;
  if (agent.state === 'error') return agent.error?.at;
  return undefined;
}

/** The kinds of StopFailure, in words. */
const ERROR_WORDS: Record<string, string> = {
  rate_limit: 'rate limit',
  overloaded: 'API overloaded',
  server_error: 'server error',
  authentication_failed: 'not logged in',
  billing_error: 'billing problem',
  invalid_request: 'invalid request',
  max_output_tokens: 'answer too long',
  unknown: 'unknown error',
};

/**
 * The line of a session stopped on an error: what kind, in words. A rate limit when a limit of the plan is used up
 * says which, and when it comes back: "5-hour limit used up · back 4:40 PM".
 */
export function errorLine(agent: Agent, limits: UsageLimits | undefined, now: number): string {
  const kind = agent.error?.kind ?? 'unknown';
  if (kind === 'rate_limit' && limits) {
    const five = limits.fiveHour;
    const week = limits.sevenDay;
    if (week && week.percent >= 100 && week.resetsAt > now) return `weekly limit used up · back ${dayText(week.resetsAt)}`;
    if (five && five.percent >= 100 && five.resetsAt > now) return `5-hour limit used up · back ${hourText(five.resetsAt)}`;
  }
  return ERROR_WORDS[kind] ?? kind.replace(/_/g, ' ');
}

/** The folder of a session, short: ~/Desktop/shop. */
export function folderText(cwd: string | undefined): string {
  if (!cwd) return '';
  return cwd.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
}

/** How a session ended, in words; nothing when Claude Code says no more than that it ended. */
const ENDED_WORDS: Record<string, string> = { prompt_input_exit: 'closed', logout: 'logged out', clear: 'cleared', resume: 'resumed elsewhere' };

/**
 * The line under the name, for a session that is not at work: it does not say again what the state says. Finished
 * and when, the folder of one that is starting or ready, why it compacts, the error in words, how it ended.
 */
export function restLine(agent: Agent, now: number, limits?: UsageLimits): string | undefined {
  switch (agent.state) {
    case 'idle': {
      if (agent.completedAt === undefined) return folderText(agent.cwd);
      const ago = agoShort(now - agent.completedAt);
      return ago === 'now' ? 'finished just now' : `finished ${ago} ago`;
    }
    case 'starting':
      return folderText(agent.cwd);
    case 'compacting':
      return agent.compactTrigger === 'auto' ? 'the context was full' : 'as you asked';
    case 'error':
      return errorLine(agent, limits, now);
    case 'ended':
      return ENDED_WORDS[agent.endReason ?? ''] ?? '';
    default:
      return undefined;
  }
}

/**
 * The time in the corner of a box: how long the turn has gone on while it works, how long it has waited for you,
 * the time since the last event otherwise; nothing for a finished session, whose line says when.
 */
export function cornerTime(agent: Agent, now: number): { text: string; title: string } | undefined {
  if (!hasEvents(agent) || agent.state === 'ended' || agent.state === 'idle') return undefined;
  const last = agoShort(now - agent.lastEvent.at);
  if ((agent.state === 'working' || agent.state === 'compacting') && agent.turnStartedAt !== undefined) {
    const turn = agoShort(now - agent.turnStartedAt);
    const lastText = last === 'now' ? 'just now' : `${last} ago`;
    if (turn === 'now') return { text: 'just started', title: `This turn just started; the last event came ${lastText}` };
    return { text: `for ${turn}`, title: `At work on this turn for ${turn}; the last event came ${lastText}` };
  }
  if (agent.state === 'waiting') {
    const since = agoShort(now - (agent.waiting?.since ?? agent.lastEvent.at));
    return { text: since, title: `It has waited for you for ${since}` };
  }
  return { text: last, title: 'Time since the last event' };
}

/** One conflict, in a line: "same file as beta: src/api.ts and 2 more", "same repo as beta (Forchetta)". */
export function conflictText(conflict: Conflict): string {
  if (conflict.kind === 'file') {
    const more = conflict.files.length > 1 ? ` and ${conflict.files.length === 2 ? 'one more' : `${conflict.files.length - 1} more`}` : '';
    return `same file as ${conflict.withName}: ${conflict.files[0] ?? '?'}${more}`;
  }
  return `same repo as ${conflict.withName}${conflict.repo ? ` (${conflict.repo})` : ''}`;
}

/** Every conflict of a box, for its tooltip. */
export function conflictsTitle(conflicts: readonly Conflict[]): string {
  const lines = conflicts.map((conflict) =>
    conflict.kind === 'file'
      ? `${conflict.withName} also changed in the last hour: ${conflict.files.join(', ')}`
      : `${conflict.withName} also changed files in ${conflict.repo ?? 'this repo'} in the last hour`,
  );
  return `${lines.join('\n')}\n(Only the changes made with Edit and Write: those of Bash commands cannot be seen.)`;
}

export const DEFAULT_STALL_MS = 10 * 60_000;

/**
 * A session that works and sent no event for `stallMs`: Claude Code gave no sign of life. The daemon has asked
 * `claude agents --json` meanwhile (it does when hooks fall quiet), so a session that in fact waits or is idle
 * is no longer "working". What is left is a long command, a long answer, or a session that is stuck.
 */
export function stalledFor(agent: Agent, now: number, stallMs = DEFAULT_STALL_MS): number | undefined {
  if (agent.state !== 'working' && agent.state !== 'compacting') return undefined;
  // A cost that went up is a sign of life too: an API call ended.
  const quiet = now - Math.max(agent.lastEvent.at, agent.usage?.at ?? 0);
  return quiet >= stallMs ? quiet : undefined;
}

/** "no event for 12 min · Bash npm test running": what the box says of a stall. */
export function stallText(agent: Agent, quietMs: number): string {
  const running = agent.state === 'working' && agent.action ? ` · ${agent.action.label} running` : '';
  return `no event for ${agoShort(quietMs)}${running}`;
}

/** How long a finished subagent stays in the box of its session; its panel keeps it longer. */
export const SUBAGENT_SHOWN_MS = 10 * 60_000;

/** A subagent, for the page and the daemon: the same however much is known of it. */
export const subagentKey = (subagent: Pick<Subagent, 'type' | 'startedAt'>): string => `${subagent.type}@${subagent.startedAt}`;

/** At work, or waiting for work of its own in the background: not ended. */
export const subagentActive = (subagent: Pick<Subagent, 'state'>): boolean => subagent.state === 'running' || subagent.state === 'waiting';

/** The subagents the box shows: those at work or waiting, oldest first, then those that ended in the last minutes, latest first. */
export function shownSubagents(agent: Pick<Agent, 'subagents'>, now: number): Subagent[] {
  const list = agent.subagents ?? [];
  const running = list.filter(subagentActive);
  const ended = list
    .filter((subagent) => !subagentActive(subagent) && subagent.endedAt !== undefined && now - subagent.endedAt < SUBAGENT_SHOWN_MS)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return [...running, ...ended];
}

/** 12 s, 3 min, 1 h 20 min: how long something took. */
export function durationText(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** At work: "starting", "40 s", "3 min" since it started. Waiting: "waiting". Then: "done in 1 min", "failed", "stopped". */
export function subagentTime(subagent: Subagent, now: number): string {
  if (subagent.state === 'waiting') return 'waiting';
  if (subagent.state === 'running') {
    const age = agoShort(now - subagent.startedAt);
    return age === 'now' ? 'starting' : age;
  }
  if (subagent.state === 'done') return subagent.endedAt !== undefined ? `done in ${durationText(subagent.endedAt - subagent.startedAt)}` : 'done';
  return subagent.state;
}

/** "haiku", "opus 5.5": the model of a subagent, short. claude-haiku-5-5 becomes haiku 5.5. */
export function modelShort(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const full = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|\[|$)/.exec(model);
  if (full) return full[3] ? `${full[1]} ${full[2]}.${full[3]}` : `${full[1]} ${full[2]}`;
  return model.replace(/^claude-/, '');
}

/** What a subagent that stopped to wait does: shown in place of its last call. */
export const WAITING_TEXT = 'waits for its work in the background';

/** The second line of a subagent at work or waiting: its model, the background, what it does now. */
export function subagentDetail(subagent: Subagent): string {
  const now = subagent.state === 'waiting' ? WAITING_TEXT : (subagent.action?.label ?? 'thinking…');
  return [modelShort(subagent.model), subagent.background ? 'background' : undefined, now].filter(Boolean).join(' · ');
}
