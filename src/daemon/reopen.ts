import type { Agent, TeamInfo } from '../shared/agent.ts';
import { readDataJson, writeDataJson } from '../shared/data-file.ts';
import { type LostSession, lostName, lostOf, modelAlias, REOPEN_KEEP_MS, SESSION_ID } from '../shared/reopen.ts';
import type { SpawnResult } from './spawn.ts';

// The sessions that ended with the Mac (shared/reopen.ts), kept in var/reopen.json until you reopen them or say not
// now, for a week at most; and the reopening, one session at a time: `claude --resume` in its folder, back into its
// team when it was in one. The box of a session that ended for another reason reopens the same way, while it shows.

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

export interface ReopenDeps {
  file?: string;
  log: Log;
  agent: (agentId: string) => Agent | undefined;
  /** Every session the daemon knows now: a conversation already open is not opened twice. */
  agents: () => Iterable<Agent>;
  isFolder: (dir: string) => boolean;
  /** A session on its conversation, out of any team. */
  spawn: (input: { cwd: string; model?: string; resume: string }, extras: { name?: string; team?: TeamInfo }) => Promise<SpawnResult>;
  /**
   * A member of a team (or its lead) on its conversation, back in its team with its role and tools; undefined when
   * its team does not take it back (gone, stopped, or it has another session now).
   */
  crewReopen: (crewId: string, agentId: string, sessionId: string, cwd: string) => Promise<SpawnResult> | undefined;
  /** The box of the session that ended leaves the window: the one that reopened takes its place. */
  forget: (agentId: string) => void;
  onChange: () => void;
  now?: () => number;
}

export interface ReopenOutcome {
  reopened: { agentId: string; newAgentId: string; name: string }[];
  failed: { agentId: string; name: string; error: string }[];
}

interface ReopenFile {
  version: 1;
  sessions: LostSession[];
}

export class Reopener {
  private lost: LostSession[] = [];
  /** One reopening at a time: two clicks never open a conversation twice. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ReopenDeps) {
    if (!deps.file) return;
    const raw = readDataJson(deps.file, 'sessions to reopen', deps.log) as Partial<ReopenFile> | undefined;
    const now = this.now();
    this.lost = (Array.isArray(raw?.sessions) ? raw.sessions : []).filter(
      (one): one is LostSession => typeof one?.agentId === 'string' && typeof one.sessionId === 'string' && SESSION_ID.test(one.sessionId) && typeof one.cwd === 'string' && now - (one.endedAt ?? 0) < REOPEN_KEEP_MS,
    );
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  list(): LostSession[] {
    return this.lost.map((one) => ({ ...one, ...(one.team ? { team: { ...one.team } } : {}) }));
  }

  /** The sessions a restart of the Mac ended, found when the daemon starts: offered until you reopen them. */
  remember(agents: readonly Agent[]): number {
    const now = this.now();
    let added = 0;
    for (const agent of agents) {
      const lost = lostOf(agent, now);
      if (!lost || this.lost.some((one) => one.sessionId === lost.sessionId)) continue;
      this.lost.push(lost);
      added += 1;
    }
    if (added > 0) this.changed();
    return added;
  }

  /** Not now: these (or all of them) are offered no more; their conversations stay with Claude Code. */
  dismiss(agentIds?: readonly string[]): void {
    const before = this.lost.length;
    this.lost = agentIds ? this.lost.filter((one) => !agentIds.includes(one.agentId)) : [];
    if (this.lost.length !== before) this.changed();
  }

  /** These sessions on their conversations, one after the other. */
  reopen(agentIds: readonly string[]): Promise<ReopenOutcome> {
    const run = this.queue.then(() => this.reopenAll(agentIds));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async reopenAll(agentIds: readonly string[]): Promise<ReopenOutcome> {
    const outcome: ReopenOutcome = { reopened: [], failed: [] };
    for (const agentId of [...new Set(agentIds)]) {
      const lost = this.lost.find((one) => one.agentId === agentId) ?? this.endedNow(agentId);
      if (!lost) {
        outcome.failed.push({ agentId, name: agentId.slice(0, 8), error: 'nothing to reopen: the session is not ended, or its conversation is not known' });
        continue;
      }
      const name = lostName(lost);
      try {
        const result = await this.reopenOne(lost);
        if (result.ok) outcome.reopened.push({ agentId, newAgentId: result.agentId, name });
        else outcome.failed.push({ agentId, name, error: result.error });
      } catch (error) {
        outcome.failed.push({ agentId, name, error: String(error) });
      }
    }
    if (outcome.reopened.length > 0 || outcome.failed.length > 0) {
      this.deps.log(`reopened ${outcome.reopened.length} ${outcome.reopened.length === 1 ? 'session' : 'sessions'}${outcome.failed.length ? `; not reopened: ${outcome.failed.map((one) => `${one.name} (${one.error})`).join('; ')}` : ''}`);
    }
    return outcome;
  }

  /** A session that ended while the daemon watched (its box still shows): reopenable as one ended with the Mac. */
  private endedNow(agentId: string): LostSession | undefined {
    const agent = this.deps.agent(agentId);
    return agent && agent.state === 'ended' ? lostOf(agent, this.now()) : undefined;
  }

  private async reopenOne(lost: LostSession): Promise<SpawnResult> {
    if (!this.deps.isFolder(lost.cwd)) return { ok: false, error: `its folder ${lost.cwd} is gone` };
    // A conversation already open in another session: once is enough.
    for (const agent of this.deps.agents()) {
      if (agent.state !== 'ended' && agent.sessionId === lost.sessionId) {
        this.forgetLost(lost.agentId);
        return { ok: false, error: 'its conversation is already open in a session' };
      }
    }
    const back = lost.team?.crew ? this.deps.crewReopen(lost.team.crew, lost.agentId, lost.sessionId, lost.cwd) : undefined;
    let result: SpawnResult;
    if (back) result = await back;
    else {
      // Out of a team (or its team does not take it back): its name and color stay, not its place in a team.
      const team: TeamInfo | undefined = lost.team?.crew ? { ...(lost.team.label ? { label: lost.team.label } : {}), ...(lost.team.color ? { color: lost.team.color } : {}) } : lost.team;
      const model = modelAlias(lost.model);
      result = await this.deps.spawn({ cwd: lost.cwd, ...(model ? { model } : {}), resume: lost.sessionId }, { ...(lost.name ? { name: lost.name } : {}), ...(team && Object.keys(team).length > 0 ? { team } : {}) });
    }
    if (!result.ok) return result;
    this.forgetLost(lost.agentId);
    const old = this.deps.agent(lost.agentId);
    if (old && old.state === 'ended') this.deps.forget(lost.agentId);
    return result;
  }

  private forgetLost(agentId: string): void {
    const before = this.lost.length;
    this.lost = this.lost.filter((one) => one.agentId !== agentId);
    if (this.lost.length !== before) this.changed();
  }

  private changed(): void {
    if (this.deps.file) {
      try {
        writeDataJson(this.deps.file, { version: 1, sessions: this.lost } satisfies ReopenFile);
      } catch (error) {
        this.deps.log(`sessions to reopen not saved: ${String(error)}`, 'error');
      }
    }
    this.deps.onChange();
  }
}
