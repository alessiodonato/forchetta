import type { Agent, TeamInfo } from './agent.ts';

// The sessions that ended with the Mac: a restart closes every Claude Code process, the tmux of Forchetta with
// them. Their conversations stay with Claude Code (~/.claude/projects): a session reopens on its conversation
// (`claude --resume <id>`), in its folder, with its name, color and model; a member of a team goes back into its
// team, with its role and its tools (Crews.reopen). The daemon finds them when it starts (daemon/reopen.ts) and
// keeps them until you reopen them or say not now. No Node module here: the page uses it too.

export interface LostSession {
  /** The box it had: also how the page asks for it. */
  agentId: string;
  /** The conversation to go on with. */
  sessionId: string;
  cwd: string;
  project: string;
  /** Its name in Claude Code (--name). */
  name?: string;
  model?: string;
  /** Its name, color, group and role in the window; for a member of a team, its team. */
  team?: TeamInfo;
  /** Its context when it ended, in tokens: Claude reads all of it again at the first message after it reopens. */
  contextTokens?: number;
  endedAt: number;
}

/** How long the sessions ended with the Mac are offered again. */
export const REOPEN_KEEP_MS = 7 * 86_400_000;

/** A session id of Claude Code: what `--resume` takes. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What reopens a session that ended; undefined when it has no conversation or no folder to go back to. */
export function lostOf(agent: Agent, now: number): LostSession | undefined {
  if (!agent.sessionId || !SESSION_ID.test(agent.sessionId) || !agent.cwd) return undefined;
  return {
    agentId: agent.id,
    sessionId: agent.sessionId,
    cwd: agent.cwd,
    project: agent.project,
    ...(agent.name ? { name: agent.name } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.team ? { team: { ...agent.team } } : {}),
    ...(agent.context?.tokens ? { contextTokens: agent.context.tokens } : {}),
    endedAt: agent.endedAt ?? now,
  };
}

/** The model of a session as `--model` takes it: opus, sonnet, haiku, fable; undefined for any other. */
export function modelAlias(model: string | undefined): string | undefined {
  const words = (model ?? '').toLowerCase();
  return ['opus', 'sonnet', 'haiku', 'fable'].find((alias) => words.includes(alias));
}

/** How a lost session is called: its name in the window, then its folder. */
export const lostName = (lost: Pick<LostSession, 'team' | 'project'>): string => lost.team?.label?.trim() || lost.project;

/** "api, docs and the team Studio (2)": what ended, in a line. */
export function lostText(list: readonly LostSession[]): string {
  const teams = new Map<string, number>();
  const alone: string[] = [];
  for (const lost of list) {
    if (lost.team?.crew && lost.team.group) teams.set(lost.team.group, (teams.get(lost.team.group) ?? 0) + 1);
    else alone.push(lostName(lost));
  }
  const parts = [...alone, ...[...teams].map(([group, count]) => `the team ${group} (${count})`)];
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** How Claude Code says a session ended on purpose: /exit, a logout, a /clear, a resume in another process. */
const ON_PURPOSE = new Set(['prompt_input_exit', 'logout', 'clear', 'resume']);
/** How long before the last save of the daemon a session that ended counts as stopped by the shutdown. */
export const SHUTDOWN_SPAN_MS = 5 * 60_000;

/**
 * The sessions the shutdown of the Mac ended while the daemon still listened: when the Mac started after the daemon
 * last saved its state, those it saved as ended in the last minutes before that, and not on purpose (macOS stops
 * the processes in any order, and a Claude Code that went before the daemon may have said SessionEnd).
 */
export function endedAtShutdown(agents: readonly Agent[], savedAt: number, bootAt: number): Agent[] {
  if (!(bootAt > savedAt)) return [];
  return agents.filter((agent) => agent.state === 'ended' && agent.endedAt !== undefined && agent.endedAt >= savedAt - SHUTDOWN_SPAN_MS && !ON_PURPOSE.has(agent.endReason ?? ''));
}

/**
 * The sessions a restart of the Mac ended, among those the daemon finds alive in its state when it starts: their
 * last sign of life came before the Mac started. A process that ended so said nothing, and its pid may already
 * belong to another process: the time is the sure way.
 */
export function endedByRestart(agents: readonly Agent[], bootAt: number): Agent[] {
  return agents.filter((agent) => agent.state !== 'ended' && agent.lastEvent.at < bootAt && agent.createdAt < bootAt);
}
