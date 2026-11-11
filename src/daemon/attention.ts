import { type Agent, displayName } from '../shared/agent.ts';
import { DEFAULT_STALL_MS, stallText, waitingText } from '../shared/present.ts';
import { clip } from './labels.ts';

// When a session deserves a notification of macOS. One per episode, of three kinds:
//
// - waiting: it waits for you (a permission, a question, a dialog) for 5 s. A wait answered within a few seconds,
//   at the terminal, gets none, as Claude Code does with its own (permission_prompt comes about 6 s after the
//   dialog);
// - stall: it is "al lavoro" with no sign of life for the stall threshold, the rule of the box (present.ts);
// - error: its turn ended with an error (StopFailure: a limit of the API, an overloaded server…), at once.
//
// The timers run here and not in the page: a hidden app can be slowed down by App Nap, a message from the daemon
// still wakes it.

export const ATTENTION_DELAY_MS = 5_000;

export type NoticeKind = 'waiting' | 'stall' | 'error';

export interface AttentionNotice {
  agentId: string;
  kind: NoticeKind;
  title: string;
  body: string;
}

export interface AttentionOptions {
  notify: (notice: AttentionNotice) => void;
  delayMs?: number;
  stallMs?: number;
  now?: () => number;
}

/** The episode of each kind: it stays the same while the episode lasts, and changes with the next one. */
function episode(agent: Agent, kind: NoticeKind): string | undefined {
  switch (kind) {
    case 'waiting':
      // A wait that only `claude agents --json` saw (the answer of /btw, open on screen): you are already there.
      return agent.state === 'waiting' && !agent.waiting?.fromAgentView ? String(agent.waiting?.since ?? 0) : undefined;
    case 'stall':
      return agent.state === 'working' || agent.state === 'compacting' ? String(lastSign(agent)) : undefined;
    case 'error':
      return agent.state === 'error' ? String(agent.error?.at ?? 0) : undefined;
  }
}

/** The last sign of life: a hook, or a cost that went up. */
const lastSign = (agent: Agent): number => Math.max(agent.lastEvent.at, agent.usage?.at ?? 0);

const KINDS: NoticeKind[] = ['waiting', 'stall', 'error'];

export class Attention {
  /** Keyed by agent and kind. */
  private readonly timers = new Map<string, { key: string; timer: NodeJS.Timeout }>();
  private readonly notified = new Map<string, string>();
  private readonly delayMs: number;
  private readonly stallMs: number;
  private readonly now: () => number;

  constructor(private readonly options: AttentionOptions) {
    this.delayMs = options.delayMs ?? ATTENTION_DELAY_MS;
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    this.now = options.now ?? Date.now;
  }

  /** At start: what is already going on was seen before, by the previous daemon or by you. */
  prime(agents: Iterable<Agent>): void {
    for (const agent of agents) {
      for (const kind of KINDS) {
        const key = episode(agent, kind);
        if (key !== undefined) this.notified.set(`${agent.id}:${kind}`, key);
      }
    }
  }

  agentChanged(agent: Agent): void {
    for (const kind of KINDS) this.check(agent, kind);
  }

  /** When the notice of an episode is due: after the delay of a wait, the threshold of a stall, an error at once. */
  private dueAt(agent: Agent, kind: NoticeKind): number {
    if (kind === 'waiting') return (agent.waiting?.since ?? this.now()) + this.delayMs;
    if (kind === 'stall') return lastSign(agent) + this.stallMs;
    return this.now();
  }

  private notice(agent: Agent, kind: NoticeKind): AttentionNotice {
    const name = displayName(agent);
    if (kind === 'waiting') return { agentId: agent.id, kind, title: `${name} ti aspetta`, body: clip(waitingText(agent), 180) };
    // A timer may fire a hair early: the time shown is the threshold at least, not "55 s" for one minute.
    if (kind === 'stall') return { agentId: agent.id, kind, title: `${name} sembra ferma`, body: clip(stallText(agent, Math.max(this.now() - lastSign(agent), this.stallMs)), 180) };
    const error = agent.error;
    return { agentId: agent.id, kind, title: `${name}: errore`, body: clip(`${error?.kind ?? 'errore'}${error?.message ? ` · ${error.message}` : ''}`, 180) };
  }

  private check(agent: Agent, kind: NoticeKind): void {
    const slot = `${agent.id}:${kind}`;
    const key = episode(agent, kind);
    if (key === undefined) {
      this.cancel(slot);
      this.notified.delete(slot);
      return;
    }
    if (this.notified.get(slot) === key || this.timers.get(slot)?.key === key) return;
    this.cancel(slot);
    const timer = setTimeout(() => {
      this.timers.delete(slot);
      if (episode(agent, kind) !== key) return;
      this.notified.set(slot, key);
      this.options.notify(this.notice(agent, kind));
    }, Math.max(0, this.dueAt(agent, kind) - this.now()));
    timer.unref();
    this.timers.set(slot, { key, timer });
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) {
      for (const kind of KINDS) {
        this.cancel(`${id}:${kind}`);
        this.notified.delete(`${id}:${kind}`);
      }
    }
  }

  private cancel(slot: string): void {
    const current = this.timers.get(slot);
    if (current) clearTimeout(current.timer);
    this.timers.delete(slot);
  }

  stop(): void {
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
