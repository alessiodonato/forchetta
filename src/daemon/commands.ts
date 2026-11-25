import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from '../shared/fspath.ts';
import { ensurePrivateDir, paths } from '../shared/paths.ts';
import type { Agent, CommandKind, CommandStatus, QueuedCommand } from '../shared/agent.ts';
import type { TmuxCommand, TmuxResult } from '../shared/tmux.ts';
import type { Registry } from './registry.ts';
import type { SessionFile } from './claude-agents.ts';
import { keepsWorktree, readPromptBox, restartAnswer, restartOffer, restartWorked, screenShows } from './screen.ts';
import type { HookPayload } from './state.ts';

// The commands of the box: /btw <question>, /compact, /clear; and the requests of a team of agents, which go in
// the same queue (so they never cross a command) and are pasted as one block. They are typed into the session through its tmux
// pane, as you would type them, and only when it is safe:
//
//   - the session waits for a new prompt (state "inattiva"): at work, or with a dialog open, the command waits
//     in a queue, and it is never typed into a dialog, where a key could answer it;
//   - the pane is still the one of that session and of that claude process (checked by pid every time);
//   - nobody typed into the session in the last seconds (tmux session_activity counts only keys from clients);
//   - the pane is not scrolled back (tmux copy mode, the wheel in a pane): there every key goes to tmux, "/" starts
//     a search and Enter copies the selection to the clipboard;
//   - the input box is on screen and empty: a draft of yours is never touched, an open answer of /btw is not
//     closed for you. One text is not a draft: the prompt a hook refused (arricurdAI, when the cache expired),
//     which Claude Code put back into the box. A /clear or /compact takes it out (Ctrl+U, Backspace between lines)
//     and puts it back once done, not sent;
//   - after typing, the box must show exactly the command, or Enter is not pressed.
//
// Then a hook confirms it: PostCompact for /compact (PreCompact only says it started: Claude Code may still give
// up, "Not enough messages to compact", with no PostCompact), SessionEnd/SessionStart "clear" for /clear. /btw has no hook
// and leaves no trace in the transcript: its answer is only on screen, and the command counts as confirmed when
// its answer box shows the question. A request is confirmed by UserPromptSubmit with its first line.
//
// /restart (daemon/restarts.ts) is stricter: it goes only into a session that is ready now, and does not wait in the
// queue; Enter only when the menu under the box shows that /restart is the command of Claude Code, on a newer version;
// and it is confirmed by the version in the file of the process, not by what is on screen. After it, no key at all:
// Claude Code may open a question, with a choice already made.
//
// A request goes in two steps: its first line ("Request #3 from the user:") is typed, as words of the user, and
// the rest is pasted after it with tmux paste-buffer -p (bracketed paste), so that its newlines stay newlines,
// not Enters. Claude Code shows a short paste as it is and a long one as "[Pasted text #1 +32 lines]", and takes
// it whole at Enter (verified with 2.1.322: 2163 characters, answered from the last line). A long paste reaches
// the model, and UserPromptSubmit, inside <pasted_content>: with the first line typed before it, the request is
// still the user's own words, and the prompt still starts with them.

export interface CommanderTmux {
  run(command: TmuxCommand, args: readonly string[]): Promise<TmuxResult>;
}

/** What arricurdAI can do before a /clear: keep a note of the session for the next one. */
export interface ResetNotes {
  supported(): Promise<boolean>;
  prepare(transcriptPath: string): Promise<void>;
}

export interface CommanderOptions {
  registry: Registry;
  tmux: CommanderTmux;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  notes?: ResetNotes;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** No command while someone typed into the session less than this ago. */
  typingQuietMs?: number;
  /** Claude Code takes text followed at once by Enter as a paste and ignores the Enter: a pause between them. */
  pasteSettleMs?: number;
  tickMs?: number;
  /** After a turn ends, a moment for the screen to settle before typing. */
  settleMs?: number;
  /** A request of a team changed status: queued, blocked, sent, confirmed, failed, cancelled. */
  onRequest?: (agent: Agent, command: QueuedCommand) => void;
  /** A /restart changed status; `refused`: Claude Code said why it does not restart. */
  onRestart?: (agent: Agent, command: QueuedCommand, refused?: boolean) => void;
  /** The file of a claude process: its version, whether Remote Control is connected. */
  sessionFile?: (pid: number) => Promise<SessionFile | undefined>;
  /** How often a session that restarts is looked at. */
  restartLookMs?: number;
}

export type EnqueueResult = { ok: true; command: QueuedCommand } | { ok: false; error: string };

const ACK_MS: Record<CommandKind, number> = { compact: 30_000, clear: 15_000, btw: 6_000, request: 15_000, ask: 15_000, free: 15_000, exit: 20_000, restart: 120_000 };
/** The same refusal as before on screen, this long after Enter: it is the answer to this /restart too. */
const SAME_REFUSAL_MS = 45_000;
/** How many looks at the input box after a restart: a question of Claude Code may be in its place. */
const RESTARTED_LOOKS = 6;
/** After /exit, when to look for the question of Claude Code about the worktree of the session. */
const EXIT_LOOKS_MS = [1200, 2000, 3000];
/** The longest request, as the first prompt of a new session. */
export const MAX_REQUEST = 20_000;
/** A compaction that started may take minutes on a large context. */
const COMPACTION_MS = 10 * 60_000;
const MAX_QUESTION_BYTES = 1000;
/** After a key that changes the input box, a moment for Claude Code to draw it again. */
const KEY_SETTLE_MS = 300;
/** When to try to put back the prompt a /clear or /compact made room for: the box comes back after the command. */
const PUT_BACK_WAITS_MS = [1500, 3000, 6000];
const KEEP_DONE = 3;
const WAITING: CommandStatus[] = ['in-coda', 'bloccato'];
const DONE: CommandStatus[] = ['confermato', 'non-confermato', 'fallito'];

/** A request of a team, a question from the menu of a selection, a notice of the guard: a text that goes as your words, typed and pasted. */
const isText = (command: Pick<QueuedCommand, 'kind'>): boolean => command.kind === 'request' || command.kind === 'ask' || command.kind === 'free';

/** What is typed: "/btw …", "/compact", or the whole text of a request. */
export const commandText = (command: Pick<QueuedCommand, 'kind' | 'arg'>): string =>
  command.kind === 'btw' ? `/btw ${command.arg ?? ''}` : isText(command) ? (command.arg ?? '') : `/${command.kind}`;

/** How the log calls it: a request by its number, not by its text. */
const commandLabel = (command: Pick<QueuedCommand, 'kind' | 'arg' | 'request'>): string =>
  command.kind === 'request'
    ? `request #${command.request?.n ?? '?'}`
    : command.kind === 'ask' || command.kind === 'free'
      ? `${command.kind === 'ask' ? 'question' : 'notice'} "${requestParts(command.arg ?? '').head.slice(0, 40)}"`
      : commandText(command);

/** What the prompt shows of a paste too long to show: "[Pasted text #1 +32 lines]". */
const PASTED = /^\[Pasted text #\d+(?: \+\d+ lines?)?\]$/;

/** A request split as it is typed: its first line, then the rest (pasted on a line of its own). */
function requestParts(text: string): { head: string; body: string } {
  const cut = text.indexOf('\n');
  return cut < 0 ? { head: text.trim(), body: '' } : { head: text.slice(0, cut).trim(), body: text.slice(cut + 1) };
}

/** Whether the prompt shows the request: its first line, then the rest as it is or as a long paste. */
function showsRequest(typed: string, text: string): boolean {
  if (sameText(typed, text)) return true;
  const { head } = requestParts(text);
  const flat = typed.replace(/\s+/g, ' ').trim();
  return flat.startsWith(head) && PASTED.test(flat.slice(head.length).trim());
}

/** Each byte as two hex digits: `send-keys -H` types them as they are, with nothing for tmux to interpret. */
const hexBytes = (text: string): string[] => Buffer.from(text, 'utf8').toString('hex').match(/../g) ?? [];

const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

function waitReason(agent: Agent): string {
  switch (agent.state) {
    case 'working':
      return 'waiting for the turn to end';
    case 'waiting':
      return 'Claude waits for your answer';
    case 'compacting':
      return 'waiting for the compaction to end';
    case 'starting':
      return 'the session is starting';
    case 'error':
      return 'waiting for the session to resume';
    default:
      return 'waiting';
  }
}

export class Commander {
  private readonly inflight = new Map<string, { command: QueuedCommand; deadline: number }>();
  private readonly dispatching = new Set<string>();
  /** The refused prompt each command took out of the input box, by command id: it goes back after the command. */
  private readonly putBacks = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: CommanderOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timer = setInterval(() => this.tick(), options.tickMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * After a restart, with the agents of the state saved: a command waiting goes when its session is ready, as
   * before; one that was sent and not confirmed yet cannot be confirmed any more (what waited for the hook is
   * gone), so it is said, and for a request of a team the Stop of the session decides, as for any unconfirmed one.
   */
  restored(): void {
    for (const agent of this.options.registry.agents.values()) {
      let changed = false;
      // A restart not sent yet: who asked for it is gone with the old daemon.
      const restarts = agent.commands?.filter((command) => command.kind === 'restart' && WAITING.includes(command.status)) ?? [];
      if (restarts.length > 0) {
        agent.commands = agent.commands!.filter((command) => !restarts.includes(command));
        changed = true;
      }
      for (const command of agent.commands ?? []) {
        if (command.status !== 'inviato') continue;
        command.status = 'non-confermato';
        command.reason = 'the daemon restarted before Claude Code confirmed it: see the terminal';
        command.doneAt = this.now();
        changed = true;
        this.changed(agent, command);
      }
      if (changed) {
        this.prune(agent);
        this.options.registry.touch(agent);
      }
    }
  }

  enqueue(agentId: string, kind: string, arg?: unknown, confirmed?: unknown, fromSelection = false): EnqueueResult {
    const agent = this.options.registry.agents.get(agentId);
    if (!agent) return { ok: false, error: 'unknown session' };
    if (agent.control.kind !== 'tmux' || agent.state === 'ended') return { ok: false, error: 'the session is read only or ended' };
    if (kind !== 'btw' && kind !== 'compact' && kind !== 'clear') return { ok: false, error: `unknown command: ${kind}` };
    if (kind === 'clear' && confirmed !== true) return { ok: false, error: '/clear va confermato' };
    let question: string | undefined;
    if (kind === 'btw') {
      // One line: a newline would be an Enter in the middle of the question.
      question = String(arg ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!question) return { ok: false, error: 'the question is missing' };
      if (Buffer.byteLength(question) > MAX_QUESTION_BYTES) return { ok: false, error: 'question too long' };
    }
    const command: QueuedCommand = { id: randomUUID(), kind, arg: question, status: 'in-coda', createdAt: this.now(), ...(fromSelection ? { afterSelection: this.now() } : {}) };
    agent.commands = [...(agent.commands ?? []), command];
    this.options.log(`command queued for ${agent.project}: ${commandText(command)}`);
    this.prune(agent);
    this.options.registry.touch(agent);
    this.kick(agent.id);
    return { ok: true, command };
  }

  /**
   * /exit, for a session of a run of an automation that is over: typed when the session is free, like any command,
   * never into a dialog. Not a command of the page. One at a time: one already waiting or sent is that one.
   */
  enqueueExit(agentId: string): EnqueueResult {
    const agent = this.options.registry.agents.get(agentId);
    if (!agent) return { ok: false, error: 'unknown session' };
    if (agent.control.kind !== 'tmux' || agent.state === 'ended') return { ok: false, error: 'the session is read only or ended' };
    const pending = agent.commands?.find((command) => command.kind === 'exit' && (WAITING.includes(command.status) || command.status === 'inviato'));
    if (pending) return { ok: true, command: pending };
    const command: QueuedCommand = { id: randomUUID(), kind: 'exit', status: 'in-coda', createdAt: this.now() };
    agent.commands = [...(agent.commands ?? []), command];
    this.options.log(`/exit queued for ${agent.team?.label ?? agent.project}`);
    this.prune(agent);
    this.options.registry.touch(agent);
    this.kick(agent.id);
    return { ok: true, command };
  }

  /**
   * /restart, for a session at rest on an older Claude Code (daemon/restarts.ts). Not a command of the page, and it
   * does not wait: if the session is not ready when its turn comes, it goes away, and is asked again later.
   */
  enqueueRestart(agentId: string): EnqueueResult {
    const agent = this.options.registry.agents.get(agentId);
    if (!agent) return { ok: false, error: 'unknown session' };
    if (agent.control.kind !== 'tmux' || agent.state === 'ended') return { ok: false, error: 'the session is read only or ended' };
    if (agent.state !== 'idle') return { ok: false, error: waitReason(agent) };
    if (this.next(agent) || this.inflight.has(agentId)) return { ok: false, error: 'a command is in its queue' };
    const command: QueuedCommand = { id: randomUUID(), kind: 'restart', status: 'in-coda', createdAt: this.now() };
    agent.commands = [...(agent.commands ?? []), command];
    this.prune(agent);
    this.options.registry.touch(agent);
    this.kick(agent.id);
    return { ok: true, command };
  }

  /** A request of a team of agents, whole: it waits in the queue of the session like a command. */
  enqueueRequest(agentId: string, text: string, request: { crew: string; n: number }): EnqueueResult {
    const agent = this.options.registry.agents.get(agentId);
    if (!agent) return { ok: false, error: 'unknown session' };
    if (agent.control.kind !== 'tmux' || agent.state === 'ended') return { ok: false, error: 'the session is read only or ended' };
    // Control characters but newlines and tabs go: an Esc in a paste could close it early.
    const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (!clean) return { ok: false, error: 'the request is empty' };
    if (clean.length > MAX_REQUEST) return { ok: false, error: `request too long (more than ${MAX_REQUEST} characters)` };
    const command: QueuedCommand = { id: randomUUID(), kind: 'request', arg: clean, request, status: 'in-coda', createdAt: this.now() };
    agent.commands = [...(agent.commands ?? []), command];
    this.options.log(`request #${request.n} queued for ${agent.team?.label ?? agent.project}`);
    this.prune(agent);
    this.options.registry.touch(agent);
    this.changed(agent, command);
    this.kick(agent.id);
    return { ok: true, command };
  }

  /**
   * A question about a selection, from the menu of a pane: it goes as your request, like one of a team. Asked about a
   * selection in this same session, the drag that made it is not taken for typing (fromSelection).
   */
  enqueueAsk(agentId: string, text: string, fromSelection = false): EnqueueResult {
    const agent = this.options.registry.agents.get(agentId);
    if (!agent) return { ok: false, error: 'unknown session' };
    if (agent.control.kind !== 'tmux' || agent.state === 'ended') return { ok: false, error: 'the session is read only or ended' };
    const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (!clean) return { ok: false, error: 'the question is empty' };
    if (clean.length > MAX_REQUEST) return { ok: false, error: `question too long (more than ${MAX_REQUEST} characters)` };
    const now = this.now();
    const command: QueuedCommand = { id: randomUUID(), kind: 'ask', arg: clean, status: 'in-coda', createdAt: now, ...(fromSelection ? { afterSelection: now } : {}) };
    agent.commands = [...(agent.commands ?? []), command];
    this.options.log(`question queued for ${agent.team?.label ?? agent.project}`);
    this.prune(agent);
    this.options.registry.touch(agent);
    this.kick(agent.id);
    return { ok: true, command };
  }

  /**
   * A notice of the guard: a file the session was stopped on is free. It goes as your words when the session is
   * ready, like a request; the caller cancels it if the session writes the file first.
   */
  enqueueFree(agentId: string, text: string): EnqueueResult {
    const agent = this.options.registry.agents.get(agentId);
    if (!agent) return { ok: false, error: 'unknown session' };
    if (agent.control.kind !== 'tmux' || agent.state === 'ended') return { ok: false, error: 'the session is read only or ended' };
    const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (!clean) return { ok: false, error: 'the notice is empty' };
    const command: QueuedCommand = { id: randomUUID(), kind: 'free', arg: clean, status: 'in-coda', createdAt: this.now() };
    agent.commands = [...(agent.commands ?? []), command];
    this.options.log(`notice of the guard queued for ${agent.team?.label ?? agent.project}`);
    this.prune(agent);
    this.options.registry.touch(agent);
    this.kick(agent.id);
    return { ok: true, command };
  }

  /**
   * Text into the prompt of a session, not sent: the menu of a selection puts it there for you to finish. At once,
   * not queued: it goes after what is already typed, also while Claude works; never into a dialog, nor into a pane
   * scrolled back, nor while a command of the box is being typed.
   */
  async insert(agentId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const agent = this.options.registry.agents.get(agentId);
    if (!agent) return { ok: false, error: 'unknown session' };
    if (agent.control.kind !== 'tmux' || agent.state === 'ended') return { ok: false, error: 'the session is read only or ended' };
    if (!agent.control.paneId || !agent.pid) return { ok: false, error: 'the pane of the session is not known yet' };
    const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (!clean.trim()) return { ok: false, error: 'nothing to put in' };
    if (clean.length > MAX_REQUEST) return { ok: false, error: `too long (more than ${MAX_REQUEST} characters)` };
    if (this.dispatching.has(agentId)) return { ok: false, error: 'a command of the box is being typed into the session: try again in a moment' };
    const pane = agent.control.paneId;
    const { tmux } = this.options;
    this.dispatching.add(agentId);
    try {
      const identity = await tmux.run('display-message', ['-p', '-t', pane, '#{session_name}\t#{pane_pid}']);
      const [paneSession, panePid] = identity.stdout.trim().split('\t');
      if (identity.code !== 0 || paneSession !== agent.control.session || Number(panePid) !== agent.pid) return { ok: false, error: 'the pane no longer belongs to the session' };
      const mode = await tmux.run('display-message', ['-p', '-t', pane, '#{pane_in_mode}']);
      if (mode.code === 0 && mode.stdout.trim() === '1') return { ok: false, error: 'the terminal is scrolled back (tmux copy mode): scroll to the end, or press q in it' };
      if (!readPromptBox(await this.capture(pane, true)).found) return { ok: false, error: 'a dialog or the answer of /btw is open in the terminal: close it with Esc' };
      await this.paste(pane, clean);
      this.options.log(`text put in the prompt of ${agent.team?.label ?? agent.project} (${clean.length} characters)`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    } finally {
      this.dispatching.delete(agentId);
    }
  }

  /** A request whose status changed: its team is told. */
  private changed(agent: Agent, command: QueuedCommand, refused = false): void {
    if (command.kind === 'request') this.options.onRequest?.(agent, command);
    if (command.kind === 'restart') this.options.onRestart?.(agent, command, refused);
  }

  /**
   * A command waits for a session that `claude agents --json` saw waiting for you, with no hook since: the answer
   * of /btw, for one, closes without a hook. Only another reading tells when it is ready again.
   */
  waitsOnAgentView(): boolean {
    for (const agent of this.options.registry.agents.values()) {
      if (agent.state === 'waiting' && agent.waiting?.fromAgentView && this.next(agent)) return true;
    }
    return false;
  }

  /** A command still waiting can be taken back. */
  cancel(agentId: string, commandId: string): boolean {
    const agent = this.options.registry.agents.get(agentId);
    const command = agent?.commands?.find((candidate) => candidate.id === commandId);
    if (!agent || !command || !WAITING.includes(command.status) || this.dispatching.has(agentId)) return false;
    command.status = 'annullato';
    command.doneAt = this.now();
    this.prune(agent);
    this.options.registry.touch(agent);
    this.changed(agent, command);
    return true;
  }

  /** After every change of an agent: a session ready for input gets its next command. */
  agentChanged(agent: Agent): void {
    if (agent.state === 'ended') {
      this.abandon(agent);
      return;
    }
    // A compaction that started and is over without PostCompact: Claude Code gave up on it.
    const flight = this.inflight.get(agent.id);
    if (flight?.command.kind === 'compact' && flight.command.reason === 'compacting' && agent.state === 'idle' && agent.lastEvent.name === 'PreCompact') {
      this.finish(agent, flight.command, 'non-confermato', 'Claude did not compact (too few messages, maybe): see the terminal');
      return;
    }
    const next = this.next(agent);
    if (!next) return;
    if (agent.state === 'idle') this.kick(agent.id, this.options.settleMs ?? 800);
    // The box says why the command waits: the reason follows the state of the session.
    else if (!this.dispatching.has(agent.id)) this.note(agent, next, 'in-coda', waitReason(agent));
  }

  /** The hooks that confirm a command. */
  hook(agent: Agent, payload: HookPayload): void {
    const flight = this.inflight.get(agent.id);
    if (!flight) return;
    const event = payload.hook_event_name;
    if (flight.command.kind === 'compact' && event === 'PreCompact' && payload.trigger === 'manual') {
      flight.deadline = this.now() + COMPACTION_MS;
      this.note(agent, flight.command, 'inviato', 'compacting');
    } else if (flight.command.kind === 'compact' && ((event === 'PostCompact' && payload.trigger === 'manual') || (event === 'SessionStart' && payload.source === 'compact'))) {
      this.finish(agent, flight.command, 'confermato', 'compaction done');
    } else if (flight.command.kind === 'clear' && ((event === 'SessionEnd' && payload.reason === 'clear') || (event === 'SessionStart' && payload.source === 'clear'))) {
      this.finish(agent, flight.command, 'confermato', 'session cleared');
    } else if (flight.command.kind === 'exit' && event === 'SessionEnd') {
      this.finish(agent, flight.command, 'confermato', 'session ended');
    } else if (isText(flight.command) && event === 'UserPromptSubmit' && (payload.prompt ?? '').trim().startsWith(requestParts(flight.command.arg ?? '').head)) {
      this.finish(agent, flight.command, 'confermato', 'delivered');
    }
  }

  /** Every few seconds: commands sent with no confirmation in time, and commands waiting that may go now. */
  tick(): void {
    const now = this.now();
    for (const [agentId, flight] of this.inflight) {
      if (now < flight.deadline) continue;
      const agent = this.options.registry.agents.get(agentId);
      if (agent) this.finish(agent, flight.command, 'non-confermato', flight.command.kind === 'compact' ? 'no compaction started: see the terminal' : 'no confirmation: see the terminal');
      else this.inflight.delete(agentId);
    }
    for (const agent of this.options.registry.agents.values()) {
      if (agent.state === 'idle' && this.next(agent)) this.kick(agent.id);
    }
  }

  private next(agent: Agent): QueuedCommand | undefined {
    return agent.commands?.find((command) => WAITING.includes(command.status));
  }

  private kick(agentId: string, delayMs = 0): void {
    const timer = setTimeout(() => void this.dispatch(agentId), delayMs);
    timer.unref?.();
  }

  private note(agent: Agent, command: QueuedCommand, status: CommandStatus, reason?: string): void {
    if (command.status === status && command.reason === reason) return;
    // A restart does not wait: the session that is not ready now is asked again later.
    if (command.kind === 'restart' && WAITING.includes(status)) return this.finish(agent, command, 'annullato', reason);
    command.status = status;
    command.reason = reason;
    this.options.registry.touch(agent);
    this.changed(agent, command);
  }

  private finish(agent: Agent, command: QueuedCommand, status: CommandStatus, reason?: string, refused = false): void {
    command.status = status;
    command.reason = reason;
    command.doneAt = this.now();
    if (this.inflight.get(agent.id)?.command === command) this.inflight.delete(agent.id);
    this.options.log(`command ${commandLabel(command)} for ${agent.project}: ${status}${reason ? ` (${reason})` : ''}`);
    this.prune(agent);
    this.options.registry.touch(agent);
    this.changed(agent, command, refused);
    const text = this.putBacks.get(command.id);
    if (text !== undefined) {
      // The prompt goes back before the next command of the queue.
      this.putBacks.delete(command.id);
      void this.putBack(agent.id, text).finally(() => this.kick(agent.id, this.options.settleMs ?? 800));
      return;
    }
    if (agent.state === 'idle' && this.next(agent)) this.kick(agent.id, this.options.settleMs ?? 800);
  }

  /** The prompt a hook refused, when the input box shows exactly it: a /clear or /compact may take it out. */
  private refusedIn(agent: Agent, command: QueuedCommand, typed: string): string | undefined {
    const refused = agent.refusedPrompt;
    if (!refused || (command.kind !== 'clear' && command.kind !== 'compact')) return undefined;
    return sameText(typed, refused.text) ? refused.text : undefined;
  }

  /** Empties the input box: Ctrl+U takes out a line, Backspace joins it to the one above. */
  private async emptyPrompt(pane: string, text: string): Promise<boolean> {
    const { tmux } = this.options;
    for (let round = 0; round <= text.split('\n').length + 1; round++) {
      await tmux.run('send-keys', ['-t', pane, 'C-u']);
      await this.sleep(KEY_SETTLE_MS);
      const box = readPromptBox(await this.capture(pane, true));
      if (!box.found) return false;
      if (!box.typed) return true;
      await tmux.run('send-keys', ['-t', pane, 'BSpace']);
      await this.sleep(KEY_SETTLE_MS);
    }
    return false;
  }

  /**
   * The refused prompt back into the input box, once the command that took it out is done: not sent. Only into an
   * empty box of the same claude process, never into a dialog or a pane scrolled back.
   */
  private async putBack(agentId: string, text: string): Promise<void> {
    const { tmux } = this.options;
    for (const wait of PUT_BACK_WAITS_MS) {
      await this.sleep(wait);
      const agent = this.options.registry.agents.get(agentId);
      if (!agent || agent.state === 'ended' || agent.control.kind !== 'tmux' || !agent.control.paneId || !agent.pid) return;
      if (this.dispatching.has(agentId)) continue;
      const pane = agent.control.paneId;
      this.dispatching.add(agentId);
      try {
        const identity = await tmux.run('display-message', ['-p', '-t', pane, '#{session_name}\t#{pane_pid}']);
        const [paneSession, panePid] = identity.stdout.trim().split('\t');
        if (identity.code !== 0 || paneSession !== agent.control.session || Number(panePid) !== agent.pid) return;
        const mode = await tmux.run('display-message', ['-p', '-t', pane, '#{pane_in_mode}']);
        if (mode.code === 0 && mode.stdout.trim() === '1') continue;
        const box = readPromptBox(await this.capture(pane, true));
        if (!box.found) continue;
        if (box.typed) {
          this.options.log(`refused prompt not put back in ${agent.project}: the prompt already holds text`);
          return;
        }
        await this.paste(pane, text);
        this.options.log(`refused prompt put back in the prompt of ${agent.project} (not sent)`);
        return;
      } catch (error) {
        this.options.log(`refused prompt not put back in ${agent.project}: ${String(error)}`, 'warn');
        return;
      } finally {
        this.dispatching.delete(agentId);
      }
    }
    this.options.log(`refused prompt not put back: the prompt box did not come back`, 'warn');
  }

  /** Keeps the commands waiting or sent, and the last few done. */
  private prune(agent: Agent): void {
    const commands = (agent.commands ?? []).filter((command) => command.status !== 'annullato');
    const done = commands.filter((command) => DONE.includes(command.status));
    const old = new Set(done.slice(0, Math.max(0, done.length - KEEP_DONE)));
    agent.commands = commands.filter((command) => !old.has(command));
  }

  /** The session ended: what was still waiting will never be sent. A /exit sent is what ended it. */
  private abandon(agent: Agent): void {
    let changed = false;
    for (const command of agent.commands ?? []) {
      this.putBacks.delete(command.id);
      if (command.kind === 'exit' && command.status === 'inviato') {
        command.status = 'confermato';
        command.reason = 'session ended';
        command.doneAt = this.now();
        changed = true;
        this.changed(agent, command);
      } else if (WAITING.includes(command.status) || command.status === 'inviato') {
        command.status = command.status === 'inviato' ? 'non-confermato' : 'annullato';
        command.reason = 'session ended';
        command.doneAt = this.now();
        changed = true;
        this.changed(agent, command);
      }
    }
    this.inflight.delete(agent.id);
    if (changed) {
      this.prune(agent);
      this.options.registry.touch(agent);
    }
  }

  /**
   * The screen of the pane. With history, also the last lines that scrolled off it: in a small pane a request of
   * a few lines pushes the rule above the input box out of the screen, and Claude Code draws in the normal screen,
   * so the rule is there, in the history of tmux.
   */
  private async capture(pane: string, history = false): Promise<string> {
    const result = await this.options.tmux.run('capture-pane', ['-p', '-e', ...(history ? ['-S', '-60'] : []), '-t', pane]);
    return result.code === 0 ? result.stdout : '';
  }

  /**
   * A request as one block, with bracketed paste: from a private file into a tmux buffer, then into the pane. The
   * text is never an argument of tmux, and the file goes at once.
   */
  private async paste(pane: string, text: string): Promise<void> {
    const { tmux } = this.options;
    ensurePrivateDir(paths.tmpDir);
    const id = randomUUID().slice(0, 8);
    const file = join(paths.tmpDir, `request-${id}.txt`);
    writeFileSync(file, text, { mode: 0o600 });
    try {
      const loaded = await tmux.run('load-buffer', ['-b', `forchetta-${id}`, file]);
      if (loaded.code !== 0) throw new Error(`tmux did not load the request: ${loaded.stderr.trim()}`);
    } finally {
      rmSync(file, { force: true });
    }
    const pasted = await tmux.run('paste-buffer', ['-p', '-d', '-b', `forchetta-${id}`, '-t', pane]);
    if (pasted.code !== 0) throw new Error(`tmux did not paste the request: ${pasted.stderr.trim()}`);
  }

  /**
   * A /restart under way: done when the file of the process has another version; refused when Claude Code says why.
   * Only looks, no keys. Past its time, tick() gives it up.
   */
  private async watchRestart(agent: Agent, command: QueuedCommand, pane: string, from: string, answerBefore: string | undefined): Promise<void> {
    const sentAt = this.now();
    while (this.inflight.get(agent.id)?.command === command) {
      await this.sleep(this.options.restartLookMs ?? 1500);
      if (this.inflight.get(agent.id)?.command !== command) return;
      const file = agent.pid ? await this.options.sessionFile?.(agent.pid) : undefined;
      if (file?.version && file.version !== from) {
        agent.version = file.version;
        agent.remoteControl = file.remoteControl || undefined;
        agent.restartRefused = undefined;
        let ready = false;
        for (let look = 0; look < RESTARTED_LOOKS && !ready; look++) {
          if (look > 0) await this.sleep(this.options.restartLookMs ?? 1500);
          ready = readPromptBox(await this.capture(pane, true)).found;
        }
        return this.finish(agent, command, 'confermato', ready ? file.version : `${file.version}: a question of Claude Code is open in its terminal`);
      }
      const screen = await this.capture(pane);
      const answer = restartAnswer(screen);
      if (answer === undefined || restartWorked(answer)) continue;
      // The refusal of an earlier /restart may still be the last one on screen.
      if (answer === answerBefore && this.now() - sentAt < SAME_REFUSAL_MS) continue;
      if (readPromptBox(await this.capture(pane, true)).typed) continue;
      return this.finish(agent, command, 'fallito', answer, true);
    }
  }

  private async dispatch(agentId: string): Promise<void> {
    if (this.dispatching.has(agentId) || this.inflight.has(agentId)) return;
    const agent = this.options.registry.agents.get(agentId);
    if (!agent) return;
    const command = this.next(agent);
    if (!command) return;
    if (agent.state !== 'idle') return this.note(agent, command, 'in-coda', waitReason(agent));
    if (agent.control.kind !== 'tmux' || !agent.control.paneId || !agent.pid) return this.note(agent, command, 'in-coda', 'waiting to know the pane of the session');
    const pane = agent.control.paneId;
    const session = agent.control.session;
    const { tmux } = this.options;
    this.dispatching.add(agentId);
    try {
      // The pane is still the one of this session and of this claude process.
      const identity = await tmux.run('display-message', ['-p', '-t', pane, '#{session_name}\t#{pane_pid}']);
      const [paneSession, panePid] = identity.stdout.trim().split('\t');
      if (identity.code !== 0 || paneSession !== session || Number(panePid) !== agent.pid) {
        return this.finish(agent, command, 'fallito', 'the pane no longer belongs to the session');
      }
      // Nobody typed into it in the last seconds. The drag of a selection that asked for this command does not count.
      const activity = Number((await tmux.run('display-message', ['-p', '-t', session, '#{session_activity}'])).stdout.trim()) * 1000;
      const selecting = command.afterSelection !== undefined && activity <= command.afterSelection;
      if (Number.isFinite(activity) && !selecting && this.now() - activity < (this.options.typingQuietMs ?? 10_000)) {
        return this.note(agent, command, 'in-coda', 'you are typing in the session: waiting');
      }
      // Not scrolled back: in copy mode the keys would go to tmux, not to Claude Code.
      const mode = await tmux.run('display-message', ['-p', '-t', pane, '#{pane_in_mode}']);
      if (mode.code === 0 && mode.stdout.trim() === '1') {
        return this.note(agent, command, 'bloccato', 'the terminal is scrolled back (tmux copy mode): scroll to the end, or press q in it');
      }
      // The input box is on screen, and empty; or it shows the prompt a hook refused, which a /clear or /compact takes out.
      const box = readPromptBox(await this.capture(pane, true));
      if (!box.found) return this.note(agent, command, 'bloccato', 'a dialog or the answer of /btw is open in the terminal: close it with Esc');
      const refused = box.typed ? this.refusedIn(agent, command, box.typed) : undefined;
      if (box.typed && refused === undefined) return this.note(agent, command, 'bloccato', 'there is text in the prompt: it stays as it is');
      // A state that changed while checking: the next round decides again.
      if (agent.state !== 'idle') return this.note(agent, command, 'in-coda', waitReason(agent));
      let before: SessionFile | undefined;
      if (command.kind === 'restart') {
        // What the file says now, not at the last reading: the version, and what a restart would cut.
        before = await this.options.sessionFile?.(agent.pid);
        if (!before?.version) return this.finish(agent, command, 'annullato', 'its version is not known');
        if (before.remoteControl) return this.finish(agent, command, 'annullato', 'Remote Control is connected');
        if (before.status !== 'idle') return this.finish(agent, command, 'annullato', before.status === 'shell' ? 'a command runs in the background' : 'it is not at rest');
      }

      if (command.kind === 'clear' && this.options.notes && agent.transcriptPath && (await this.options.notes.supported())) {
        try {
          await this.options.notes.prepare(agent.transcriptPath);
        } catch (error) {
          return this.finish(agent, command, 'fallito', `arricurdAI did not write the note of the session: ${String(error)}`);
        }
      }

      if (refused !== undefined) {
        this.putBacks.set(command.id, refused);
        if (!(await this.emptyPrompt(pane, refused))) return this.finish(agent, command, 'fallito', 'the prompt refused by a hook did not go out of the input box: check the terminal');
        this.options.log(`refused prompt taken out of the prompt of ${agent.project}: it comes back after ${commandText(command)}`);
      }

      const text = commandText(command);
      if (isText(command)) {
        const { head, body } = requestParts(text);
        await tmux.run('send-keys', ['-t', pane, '-H', ...hexBytes(head)]);
        if (body) await this.paste(pane, `\n${body}`);
      } else await tmux.run('send-keys', ['-t', pane, '-H', ...hexBytes(text)]);
      await this.sleep(this.options.pasteSettleMs ?? 1000);
      const shows = (box: ReturnType<typeof readPromptBox>): boolean => box.found && (isText(command) ? showsRequest(box.typed, text) : sameText(box.typed, text));
      let typed = readPromptBox(await this.capture(pane, true));
      // Claude Code may still be drawing a paste of several lines (or the pane is being resized): one more look.
      if (!shows(typed)) {
        await this.sleep(this.options.pasteSettleMs ?? 1000);
        typed = readPromptBox(await this.capture(pane, true));
      }
      const shown = shows(typed);
      if (!shown) {
        // What the prompt showed, for the log: what went wrong is seen only here.
        this.options.log(`${commandLabel(command)} for ${agent.project}: the prompt shows ${typed.found ? JSON.stringify(typed.typed.slice(0, 300)) : 'nothing (prompt box not found)'}`);
        return this.finish(agent, command, 'fallito', 'the prompt does not show the command as typed: Enter not pressed, check the terminal');
      }
      const answerBefore = command.kind === 'restart' ? restartAnswer(await this.capture(pane)) : undefined;
      if (command.kind === 'restart') {
        let offer = restartOffer(await this.capture(pane));
        if (!offer) {
          await this.sleep(this.options.pasteSettleMs ?? 1000);
          offer = restartOffer(await this.capture(pane));
        }
        if (offer !== 'newer') {
          const out = await this.emptyPrompt(pane, text);
          const why = offer === 'same' ? 'Claude Code offers it no newer version' : 'Claude Code offers it no /restart (a version without it, or a pane too small to show its menu)';
          return this.finish(agent, command, 'fallito', out ? why : `${why}; "/restart" is still in its prompt`, offer === 'same');
        }
      }
      await tmux.run('send-keys', ['-t', pane, 'Enter']);
      command.status = 'inviato';
      command.reason = command.kind === 'restart' ? 'restarting' : undefined;
      command.sentAt = this.now();
      this.inflight.set(agentId, { command, deadline: this.now() + ACK_MS[command.kind] });
      this.options.log(`command sent to ${agent.project} (${session}, ${pane}, pid ${agent.pid}): ${commandLabel(command)}`);
      this.options.registry.touch(agent);
      this.changed(agent, command);

      if (command.kind === 'exit') {
        // In a worktree with commits or changes, Claude Code asks whether to keep it: Enter only on "Keep worktree".
        for (const wait of EXIT_LOOKS_MS) {
          await this.sleep(wait);
          if (this.inflight.get(agentId)?.command !== command) break;
          if (keepsWorktree(await this.capture(pane))) {
            await tmux.run('send-keys', ['-t', pane, 'Enter']);
            this.options.log(`${agent.team?.label ?? agent.project}: /exit keeps its worktree`);
            break;
          }
        }
      }
      if (command.kind === 'restart' && before?.version) await this.watchRestart(agent, command, pane, before.version, answerBefore);
      if (command.kind === 'btw') {
        await this.sleep(1500);
        const screen = await this.capture(pane);
        if (this.inflight.get(agentId)?.command === command && screenShows(screen, text)) {
          this.finish(agent, command, 'confermato', 'the answer is in the terminal');
        }
      }
    } catch (error) {
      this.finish(agent, command, 'fallito', String(error));
    } finally {
      this.dispatching.delete(agentId);
    }
  }
}
