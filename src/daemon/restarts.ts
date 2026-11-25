import { type Agent, displayName, type QueuedCommand } from '../shared/agent.ts';
import { isOutdated, passing, type RestartsInfo, restartView } from '../shared/restarts.ts';
import type { EnqueueResult } from './commands.ts';

// The sessions on an older Claude Code restart on the one installed, with its own command /restart: the same process,
// the same conversation (shared/restarts.ts says which sessions, daemon/commands.ts types it). Asked from the page, or
// by themselves when that is turned on: then only a session whose prompt cache is over, so that a restart never makes
// a conversation still in cache be read again.
//
// One at a time, and the next only once the version of the one before has changed. What Claude Code refuses stays as
// it is, with its reason. A restart that does not go as expected stops the others until you say to go on: nothing is
// ever closed from here.

/** Between one restart and the next: Claude Code starts, with its MCP servers. */
const GAP_MS = 5_000;
/** By themselves: not in the first minutes of the daemon, which still learns what the sessions do. */
const AUTO_START_MS = 2 * 60_000;
/** By themselves: a session that was not ready, or with work in the background, is asked again after this long. */
const AUTO_AGAIN_MS = 30 * 60_000;
/** How long how the last ones went is kept. */
const LAST_MS = 10 * 60_000;

export interface RestarterDeps {
  /** The Claude Code installed. */
  installed: () => string | undefined;
  agents: () => Iterable<Agent>;
  agent: (agentId: string) => Agent | undefined;
  /** /restart into a session, when it is ready (Commander). */
  enqueue: (agentId: string) => EnqueueResult;
  /** A request of its team is open for this session, or what it passed on is. */
  teamBusy: (agentId: string) => boolean;
  auto: () => boolean;
  touch: (agent: Agent) => void;
  onChange: () => void;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  now?: () => number;
}

export class Restarter {
  private queue: string[] = [];
  private current: { agentId: string; commandId: string; auto: boolean } | undefined;
  private paused: { name: string; reason: string } | undefined;
  private last: { at: number; done: string[]; failed: { name: string; reason: string }[] } | undefined;
  private done = 0;
  private nextAt = 0;
  /** By themselves: when a session may be asked again. */
  private readonly notBefore = new Map<string, number>();
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(private readonly deps: RestarterDeps) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
  }

  info(): RestartsInfo {
    const now = this.now();
    const running = this.current ?? (this.queue[0] && !this.paused ? { agentId: this.queue[0], auto: false } : undefined);
    return {
      auto: this.deps.auto(),
      ...(running ? { running: { agentId: running.agentId, auto: running.auto, next: this.queue.filter((id) => id !== running.agentId).length, done: this.done } } : {}),
      ...(this.paused ? { paused: { ...this.paused, waiting: this.queue.length } } : {}),
      ...(this.last && now - this.last.at < LAST_MS ? { last: { at: this.last.at, done: [...this.last.done], failed: this.last.failed.map((one) => ({ ...one })) } } : {}),
    };
  }

  /** Asked from the page: these sessions, those that can, one after the other. */
  restart(agentIds: readonly string[]): void {
    this.paused = undefined;
    if (!this.current && this.queue.length === 0) this.begin();
    for (const agentId of new Set(agentIds)) {
      const agent = this.deps.agent(agentId);
      if (!agent || !isOutdated(agent, this.deps.installed())) continue;
      if (this.current?.agentId === agentId || this.queue.includes(agentId)) continue;
      this.queue.push(agentId);
    }
    this.deps.onChange();
    this.tick();
  }

  /** After a restart that stopped the others: they go on, or those you asked for are left as they are. */
  resume(goOn = true): void {
    if (!this.paused) return;
    this.paused = undefined;
    if (!goOn) this.queue = [];
    this.deps.onChange();
  }

  /** Every few seconds: the next of the queue, or by themselves. */
  tick(): void {
    const now = this.now();
    if (this.current || now < this.nextAt) return;
    if (this.queue.length > 0) {
      if (this.paused) return;
      const agentId = this.queue.shift()!;
      this.start(agentId, false);
      return;
    }
    if (!this.deps.auto() || this.paused || now - this.startedAt < AUTO_START_MS) return;
    const installed = this.deps.installed();
    for (const agent of this.deps.agents()) {
      if ((this.notBefore.get(agent.id) ?? 0) > now) continue;
      if (restartView(agent, installed, now)?.when !== 'ready') continue;
      // What Claude Code refused for this version, it refuses again; unless it was for something that ends.
      const refused = agent.restartRefused;
      if (refused && refused.version === installed && (!passing(refused.reason) || now - refused.at < AUTO_AGAIN_MS)) continue;
      if (this.deps.teamBusy(agent.id)) continue;
      this.start(agent.id, true);
      return;
    }
  }

  private begin(): void {
    this.done = 0;
    this.last = { at: this.now(), done: [], failed: [] };
  }

  private start(agentId: string, auto: boolean): void {
    const now = this.now();
    const agent = this.deps.agent(agentId);
    const view = agent ? restartView(agent, this.deps.installed(), now) : undefined;
    // Restarted by hand meanwhile, or ended.
    if (!agent || !view) return this.deps.onChange();
    const why = view.when === 'ready' || (view.when === 'warm' && !auto) ? (this.deps.teamBusy(agentId) ? 'a request of its team is open' : undefined) : (view.reason ?? 'it is not at rest');
    const queued: EnqueueResult = why ? { ok: false, error: why } : this.deps.enqueue(agentId);
    if (!queued.ok) {
      this.notBefore.set(agentId, now + AUTO_AGAIN_MS);
      if (!auto) this.failed(agent, queued.error);
      return this.deps.onChange();
    }
    this.deps.log(`${displayName(agent)}: /restart, from Claude Code ${agent.version ?? '?'} to ${this.deps.installed() ?? '?'}${auto ? ' (by itself)' : ''}`);
    this.current = { agentId, commandId: queued.command.id, auto };
    this.deps.onChange();
  }

  private failed(agent: Agent, reason: string): void {
    if (!this.last) this.begin();
    this.last!.at = this.now();
    this.last!.failed.push({ name: displayName(agent), reason });
  }

  /** The command of a restart changed status (Commander). */
  commandChanged(agent: Agent, command: QueuedCommand, refused = false): void {
    if (this.current?.commandId !== command.id || command.status === 'inviato') return;
    const now = this.now();
    const installed = this.deps.installed() ?? '';
    const { auto } = this.current;
    this.current = undefined;
    this.nextAt = now + GAP_MS;
    const reason = command.reason ?? 'no reason given';
    switch (command.status) {
      case 'confermato':
        if (!auto) {
          if (!this.last) this.begin();
          this.last!.at = now;
          this.last!.done.push(displayName(agent));
          this.done += 1;
        }
        this.notBefore.delete(agent.id);
        break;
      case 'annullato':
        // Not ready after all: nothing was typed.
        this.notBefore.set(agent.id, now + AUTO_AGAIN_MS);
        if (!auto) this.failed(agent, reason);
        break;
      default:
        this.notBefore.set(agent.id, now + AUTO_AGAIN_MS);
        if (!auto) this.failed(agent, reason);
        if (refused) {
          agent.restartRefused = { version: installed, reason, at: now };
          this.deps.touch(agent);
        } else {
          // Not a refusal: something else happened. The others wait for you.
          this.paused = { name: displayName(agent), reason };
          this.deps.log(`restarts stopped: ${displayName(agent)}: ${reason}`, 'warn');
        }
    }
    this.deps.onChange();
  }
}
