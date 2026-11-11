import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Agent } from '../shared/agent.ts';
import { clip, permissionDetail } from './labels.ts';
import { type AlwaysOption, alwaysOptions } from './suggestions.ts';
import type { Registry } from './registry.ts';
import { type HookPayload, keyOf } from './state.ts';

// Permission dialogs answered from the box. bin/forchetta-permission sends the request and gets a ticket, then
// waits on the ticket; the box shows the request with Consenti and Rifiuta, and the answer goes back to the hook
// as the decision Claude Code reads. Meanwhile the terminal shows the same dialog (seen with 2.1.322), and
// whichever answers first wins:
//
// - "Yes" in the terminal leaves the hook waiting: the PostToolUse of the same call, or the next request of the
//   same thread, closes it here;
// - "No" or Esc in the terminal ends the hook: its connection closes, and Claude has stopped;
// - an answer that comes after the dialog closed is ignored by Claude Code. Before sending one, the daemon asks
//   `claude agents --json` whether the session still waits, so that the box does not say "rifiutato" about a
//   call that already ran.
//
// `claude -p` and the SDK have no dialog, and a hook that waits would stop them: their requests are not held.

export type PermissionBehavior = 'allow' | 'deny';

/** Tools whose dialog is not a yes or no: a question to answer, a plan with several ways to accept it. */
const NOT_YES_NO = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** What Claude reads when the box refuses. The refusal also stops it, as "No" in the terminal does. */
export const DENY_MESSAGE = 'The user denied this request from Forchetta.';

/** The hook must come back for its answer within this time, or the request is dropped. */
const ATTACH_MS = 5_000;
/** The daemon gives up this long before the hook does, so that curl never runs out of time. */
const MARGIN_MS = 10_000;
const MIN_WAIT_S = 20;
const MAX_WAIT_S = 86_400;

/** The stdout of the hook for a decision, as Claude Code reads it. */
export function decisionOutput(behavior: PermissionBehavior, always?: AlwaysOption): string {
  const decision =
    behavior === 'allow'
      ? always
        ? { behavior: 'allow', updatedPermissions: [always.update] }
        : { behavior: 'allow' }
      : { behavior: 'deny', message: DENY_MESSAGE, interrupt: true };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

function endEmpty(res: ServerResponse): void {
  if (res.writableEnded) return;
  if (!res.headersSent) res.writeHead(200, { 'Content-Length': '0', 'Cache-Control': 'no-store' });
  res.end();
}

function endJson(res: ServerResponse, text: string): void {
  if (res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

interface Pending {
  ticket: string;
  agentId: string;
  /** The agent_id of the hook input: a subagent asks on its own. */
  thread?: string;
  key: string;
  ask: NonNullable<Agent['permission']>;
  /** The hook, waiting. */
  res?: ServerResponse;
  /** An answer given before the hook came back for it. */
  answer?: PermissionBehavior;
  /** The "always" choices of the request, and the one chosen with the answer. */
  options: AlwaysOption[];
  always?: AlwaysOption;
  deciding?: boolean;
  timers: NodeJS.Timeout[];
}

/** Why a request stops being open, other than an answer from the box. */
type Closure = 'altrove' | 'terminale' | 'scaduta';

export interface PermissionsOptions {
  registry: Registry;
  /** Whether the claude process of the agent shows its dialogs in a terminal. */
  interactive: (agent: Agent) => Promise<boolean>;
  /** The status `claude agents --json` gives the session now ("waiting" while a dialog is open), if it lists it. */
  status: (agent: Agent) => Promise<string | undefined>;
  now?: () => number;
  log: (message: string) => void;
  /** For the tests: shorter times. */
  attachMs?: number;
  marginMs?: number;
  minWaitS?: number;
}

export class Permissions {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;
  private readonly attachMs: number;
  private readonly marginMs: number;
  private readonly minWaitS: number;

  constructor(private readonly options: PermissionsOptions) {
    this.now = options.now ?? Date.now;
    this.attachMs = options.attachMs ?? ATTACH_MS;
    this.marginMs = options.marginMs ?? MARGIN_MS;
    this.minWaitS = options.minWaitS ?? MIN_WAIT_S;
  }

  get size(): number {
    return this.pending.size;
  }

  private of(agentId: string): Pending[] {
    return [...this.pending.values()].filter((pending) => pending.agentId === agentId);
  }

  /**
   * A PermissionRequest from bin/forchetta-permission, already applied to its agent. Returns the ticket the hook
   * waits on, or undefined when Forchetta does not hold this request: the hook then ends at once.
   */
  async open(agent: Agent, payload: HookPayload, waitSec: number): Promise<string | undefined> {
    if (payload.hook_event_name !== 'PermissionRequest') return undefined;
    const thread = payload.agent_id || undefined;
    // Claude Code asks one permission at a time (seen with 2.1.322): a new request of the same thread means the
    // previous one was answered in the terminal, where "Yes" leaves its hook waiting.
    for (const pending of this.of(agent.id)) if (pending.thread === thread && pending.answer === undefined) this.close(pending, 'altrove');
    const tool = payload.tool_name;
    if (!tool || NOT_YES_NO.has(tool) || agent.state === 'ended') return undefined;
    if (!Number.isFinite(waitSec) || waitSec <= 0 || waitSec < this.minWaitS) return undefined;
    const key = keyOf(tool, payload.tool_input);
    if (!(await this.options.interactive(agent))) return undefined;
    // While ps ran, the dialog may have been answered already.
    if (agent.state !== 'waiting' || agent.waiting?.key !== key) return undefined;

    const now = this.now();
    const holdMs = Math.min(waitSec, MAX_WAIT_S) * 1000 - this.marginMs;
    const ticket = randomBytes(16).toString('hex');
    const options = alwaysOptions(payload.permission_suggestions);
    const pending: Pending = {
      ticket,
      agentId: agent.id,
      thread,
      key,
      ask: {
        ticket,
        tool,
        detail: permissionDetail(tool, payload.tool_input, agent.cwd ?? payload.cwd),
        subagent: thread ? payload.agent_type || 'subagent' : undefined,
        always: options.length > 0 ? options.map(({ label, where }) => ({ label, where })) : undefined,
        since: now,
        until: now + holdMs,
      },
      options,
      timers: [],
    };
    const later = (ms: number, run: () => void): void => {
      const timer = setTimeout(run, ms);
      timer.unref();
      pending.timers.push(timer);
    };
    // The hook did not come back for its answer: it is gone, and so is the request.
    later(this.attachMs, () => {
      if (!pending.res) this.close(pending, 'altrove');
    });
    later(holdMs, () => this.close(pending, 'scaduta'));
    this.pending.set(ticket, pending);
    // The outcome of an earlier answer is not about this request.
    agent.permissionOutcome = undefined;
    this.publish(agent);
    return ticket;
  }

  /** The hook comes back with its ticket and waits for the answer on this response. */
  attach(ticket: string, res: ServerResponse): void {
    const pending = this.pending.get(ticket);
    if (!pending) return endEmpty(res);
    if (pending.res && pending.res !== res) endEmpty(pending.res);
    pending.res = res;
    if (pending.answer) return this.deliver(pending);
    res.on('close', () => {
      // The hook went away before any answer: Claude Code ends it when the dialog gets No or Esc in the terminal.
      if (pending.res === res && !res.writableEnded && this.pending.get(ticket) === pending) this.close(pending, 'terminale');
    });
  }

  /**
   * An answer from the box. It goes to the hook only if that request is still open, and only after
   * `claude agents --json` confirms that the session still waits (when it lists the session).
   */
  async decide(agentId: string, ticket: string, behavior: PermissionBehavior, alwaysIndex?: number): Promise<boolean> {
    const agent = this.options.registry.agents.get(agentId);
    if (!agent) return false;
    const pending = this.pending.get(ticket);
    if (!pending || pending.agentId !== agentId || pending.answer !== undefined) {
      this.outcome(agent, 'The request is no longer open');
      return false;
    }
    if (pending.deciding) return false;
    pending.deciding = true;
    let status: string | undefined;
    try {
      status = await this.options.status(agent);
    } catch (error) {
      this.options.log(`permesso: claude agents --json non riuscito, invio la risposta lo stesso: ${String(error)}`);
    }
    pending.deciding = false;
    if (this.pending.get(ticket) !== pending) {
      this.outcome(agent, 'The request closed meanwhile');
      return false;
    }
    if (status !== undefined && status !== 'waiting') {
      this.close(pending, 'altrove');
      this.outcome(agent, 'Already answered in the terminal');
      return false;
    }
    if (alwaysIndex !== undefined) {
      const option = behavior === 'allow' ? pending.options[alwaysIndex] : undefined;
      if (!option) {
        this.outcome(agent, 'Invalid “always” choice: answer again');
        return false;
      }
      pending.always = option;
    }
    pending.answer = behavior;
    if (pending.res && !pending.res.writableEnded) this.deliver(pending);
    // Not back yet: the hook gets the answer as soon as it asks. The buttons go away now.
    else this.publish(agent);
    return true;
  }

  private deliver(pending: Pending): void {
    const res = pending.res;
    const behavior = pending.answer;
    if (!res || !behavior) return;
    this.forget(pending);
    endJson(res, decisionOutput(behavior, pending.always));
    const agent = this.options.registry.agents.get(pending.agentId);
    if (!agent) return;
    if (agent.state !== 'ended' && agent.waiting?.key === pending.key) {
      if (behavior === 'allow') {
        agent.state = 'working';
        agent.waiting = undefined;
        agent.completedAt = undefined;
      } else {
        // Like No in the terminal: Claude stops and waits for the next prompt, and no hook says so.
        agent.state = 'idle';
        agent.waiting = undefined;
        agent.action = undefined;
      }
    }
    const what = clip(pending.ask.detail, 70);
    agent.permissionOutcome =
      behavior === 'allow'
        ? pending.always
          ? { text: `${pending.always.label} (${pending.always.where}): ${what}`, tone: 'done', at: this.now() }
          : { text: `Allowed from Forchetta: ${what}`, tone: 'done', at: this.now() }
        : { text: `Denied from Forchetta: ${what}`, tone: 'muted', at: this.now() };
    this.publish(agent);
  }

  /** An event of the agent: the call ran, or the turn or the session is over. */
  hook(agent: Agent, payload: HookPayload): void {
    const open = this.of(agent.id);
    if (open.length === 0) return;
    switch (payload.hook_event_name) {
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const key = keyOf(payload.tool_name, payload.tool_input);
        for (const pending of open) if (pending.key === key) this.close(pending, 'altrove');
        break;
      }
      case 'UserPromptSubmit':
      case 'Stop':
      case 'StopFailure':
      case 'SessionStart':
      case 'SessionEnd':
        for (const pending of open) this.close(pending, 'altrove');
        break;
    }
  }

  /** The state of the agent changed: when it no longer waits, nothing of it is open any more. */
  agentChanged(agent: Agent): void {
    if (agent.state === 'waiting') return;
    for (const pending of this.of(agent.id)) if (pending.answer === undefined) this.close(pending, 'altrove');
  }

  private forget(pending: Pending): void {
    this.pending.delete(pending.ticket);
    for (const timer of pending.timers) clearTimeout(timer);
  }

  private close(pending: Pending, how: Closure): void {
    if (this.pending.get(pending.ticket) !== pending) return;
    this.forget(pending);
    if (pending.res) endEmpty(pending.res);
    const agent = this.options.registry.agents.get(pending.agentId);
    if (!agent) return;
    if (pending.answer) {
      agent.permissionOutcome = { text: 'Answer not delivered: answer in the terminal', tone: 'muted', at: this.now() };
    } else if (how === 'terminale' && agent.state === 'waiting' && agent.waiting?.key === pending.key) {
      // No or Esc in the terminal: Claude stopped, and waits for the next prompt.
      agent.state = 'idle';
      agent.waiting = undefined;
      agent.action = undefined;
    } else if (how === 'scaduta' && agent.state === 'waiting') {
      agent.permissionOutcome = { text: 'Timed out: answer in the terminal', tone: 'muted', at: this.now() };
    }
    this.publish(agent);
  }

  private outcome(agent: Agent, text: string): void {
    agent.permissionOutcome = { text, tone: 'muted', at: this.now() };
    this.options.registry.touch(agent);
  }

  /** The request the box shows: the oldest still open. */
  private publish(agent: Agent): void {
    const open = this.of(agent.id)
      .filter((pending) => pending.answer === undefined)
      .sort((a, b) => a.ask.since - b.ask.since)[0];
    agent.permission = open?.ask;
    this.options.registry.touch(agent);
  }

  /** At shutdown: every hook ends with no answer, and the dialogs go on in the terminal. */
  stop(): void {
    for (const pending of [...this.pending.values()]) {
      this.forget(pending);
      if (pending.res) endEmpty(pending.res);
    }
  }
}
