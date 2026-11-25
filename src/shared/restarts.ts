import type { Agent } from './agent.ts';
import { compareVersions } from './system.ts';

// The sessions on an older Claude Code than the one installed. An update installs the new version next to the ones in
// use, and a session keeps its own until it restarts ("Update installed · Restart to update"). Claude Code has a
// command for it, /restart: the same process goes on as the new version, on the same conversation, with its model,
// permission mode, system prompt, MCP servers, rules and timers (verified from 2.1.328 to 2.1.331). Forchetta types it
// into the sessions at rest (daemon/restarts.ts); here is which ones, and why the others wait. No Node module here:
// the page uses it too.

/**
 * ready: at rest, and its prompt cache is over: a restart costs nothing more. warm: at rest, but its cache is still
 * warm. later: something of it is under way. never: /restart does not work there, until you change something.
 */
export type RestartWhen = 'ready' | 'warm' | 'later' | 'never';

export interface RestartView {
  when: RestartWhen;
  /** Why not now, or what it costs. */
  reason?: string;
}

/** With no word on its prompt cache (arricurdAI off), a session at rest this long has none: an hour is the longest. */
export const CACHE_GONE_MS = 60 * 60_000;

/** A refusal of Claude Code that only holds while something runs: worth another try later. */
export const passing = (reason: string): boolean => /running in the background/i.test(reason);

/** Whether the session runs an older Claude Code than the one installed. */
export const isOutdated = (agent: Pick<Agent, 'state' | 'version'>, installed: string | undefined): boolean =>
  installed !== undefined && agent.state !== 'ended' && agent.version !== undefined && compareVersions(agent.version, installed) < 0;

/** What Forchetta can do about a session on an older Claude Code; undefined for the others. */
export function restartView(agent: Agent, installed: string | undefined, now: number): RestartView | undefined {
  if (!isOutdated(agent, installed)) return undefined;
  if (agent.control.kind !== 'tmux') return { when: 'never', reason: 'outside the tmux of Forchetta: type /restart in its terminal' };
  if (agent.remoteControl) return { when: 'never', reason: 'Remote Control is connected, and Claude Code does not restart then: disconnect it, or exit and reopen the session' };
  switch (agent.state) {
    case 'waiting':
      return { when: 'later', reason: 'it waits for your answer' };
    case 'compacting':
      return { when: 'later', reason: 'it compacts' };
    case 'starting':
      return { when: 'later', reason: 'it is starting' };
    case 'error':
      return { when: 'later', reason: 'it stopped on an error' };
    case 'idle':
      break;
    default:
      return { when: 'later', reason: 'it is at work' };
  }
  if (agent.subagents?.some((subagent) => subagent.state === 'running' || subagent.state === 'waiting')) return { when: 'later', reason: 'a subagent is at work' };
  if (agent.backgroundShell) return { when: 'later', reason: 'a command runs in the background' };
  if (agent.commands?.some((command) => command.status === 'in-coda' || command.status === 'bloccato' || command.status === 'inviato')) return { when: 'later', reason: 'a command is in its queue' };
  const warm = agent.cache ? agent.cache.expiresAt > now : now - agent.lastEvent.at < CACHE_GONE_MS;
  return warm ? { when: 'warm', reason: 'its prompt cache is still warm: after a restart, its next message may read the whole conversation again' } : { when: 'ready' };
}

/** The restarts of the sessions, as the page gets them (daemon/restarts.ts). */
export interface RestartsInfo {
  /** The sessions at rest restart by themselves (Settings). */
  auto: boolean;
  /** Under way: the session that restarts now, and those after it. */
  running?: { agentId: string; auto: boolean; next: number; done: number };
  /** Stopped: a restart did not go as expected, and you are asked before any other. */
  paused?: { name: string; reason: string; waiting: number };
  /** How the last ones you asked for went, for the line of the page. */
  last?: { at: number; done: string[]; failed: { name: string; reason: string }[] };
}
