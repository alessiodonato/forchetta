import type { Agent, CacheInfo, Conflict, ContextInfo } from './agent.ts';

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

/** The share of the window, marked as an estimate: the window comes from a table, not from Claude Code. */
export const percentText = (context: ContextInfo): string => `≈${context.percent}%`;

/** cache 42 min, cache 45 s (in steps of 5 s), cache expired. */
export function cacheText(cache: CacheInfo, now: number): string {
  const left = cache.expiresAt - now;
  if (left <= 0) return 'cache expired';
  if (left < 60_000) return `cache ${Math.ceil(left / 5000) * 5} s`;
  return `cache ${Math.floor(left / 60_000)} min`;
}

/** The last minutes of a large live cache, when going on still saves the rewrite: as the menu of arricurdAI. */
export const CACHE_SOON_MS = 10 * 60_000;

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
  const future = times.filter((time) => time > now);
  return future.length > 0 ? Math.min(...future) : undefined;
}

/** $0.42, $12.40, $1,234: dollars at API prices, as `arricurdai status` writes them. Below a cent: <$0.01. */
export function usdText(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: usd >= 1000 ? 0 : 2, maximumFractionDigits: usd >= 1000 ? 0 : 2 })}`;
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
