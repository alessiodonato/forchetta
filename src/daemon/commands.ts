import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, paths } from '../shared/paths.ts';
import type { Agent, CommandKind, CommandStatus, QueuedCommand } from '../shared/agent.ts';
import type { TmuxCommand, TmuxResult } from '../shared/tmux.ts';
import type { Registry } from './registry.ts';
import { readPromptBox, screenShows } from './screen.ts';
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
//     closed for you;
//   - after typing, the box must show exactly the command, or Enter is not pressed.
//
// Then a hook confirms it: PostCompact for /compact (PreCompact only says it started: Claude Code may still give
// up, "Not enough messages to compact", with no PostCompact), SessionEnd/SessionStart "clear" for /clear. /btw has no hook
// and leaves no trace in the transcript: its answer is only on screen, and the command counts as confirmed when
// its answer box shows the question. A request is confirmed by UserPromptSubmit with its first line.
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
  log: (message: string) => void;
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
}

export type EnqueueResult = { ok: true; command: QueuedCommand } | { ok: false; error: string };

const ACK_MS: Record<CommandKind, number> = { compact: 30_000, clear: 15_000, btw: 6_000, request: 15_000, ask: 15_000 };
/** The longest request, as the first prompt of a new session. */
export const MAX_REQUEST = 20_000;
/** A compaction that started may take minutes on a large context. */
const COMPACTION_MS = 10 * 60_000;
const MAX_QUESTION_BYTES = 1000;
const KEEP_DONE = 3;
const WAITING: CommandStatus[] = ['in-coda', 'bloccato'];
const DONE: CommandStatus[] = ['confermato', 'non-confermato', 'fallito'];

/** A request of a team, or a question from the menu of a selection: a text that goes as your words, typed and pasted. */
const isText = (command: Pick<QueuedCommand, 'kind'>): boolean => command.kind === 'request' || command.kind === 'ask';

/** What is typed: "/btw …", "/compact", or the whole text of a request. */
export const commandText = (command: Pick<QueuedCommand, 'kind' | 'arg'>): string =>
  command.kind === 'btw' ? `/btw ${command.arg ?? ''}` : isText(command) ? (command.arg ?? '') : `/${command.kind}`;

/** How the log calls it: a request by its number, not by its text. */
const commandLabel = (command: Pick<QueuedCommand, 'kind' | 'arg' | 'request'>): string =>
  command.kind === 'request' ? `request #${command.request?.n ?? '?'}` : command.kind === 'ask' ? `question "${requestParts(command.arg ?? '').head.slice(0, 40)}"` : commandText(command);

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
    this.options.log(`comando in coda per ${agent.project}: ${commandText(command)}`);
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
    this.options.log(`richiesta #${request.n} in coda per ${agent.team?.label ?? agent.project}`);
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
    this.options.log(`domanda in coda per ${agent.team?.label ?? agent.project}`);
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
      this.options.log(`testo messo nel prompt di ${agent.team?.label ?? agent.project} (${clean.length} caratteri)`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    } finally {
      this.dispatching.delete(agentId);
    }
  }

  /** A request whose status changed: its team is told. */
  private changed(agent: Agent, command: QueuedCommand): void {
    if (command.kind === 'request') this.options.onRequest?.(agent, command);
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
    command.status = status;
    command.reason = reason;
    this.options.registry.touch(agent);
    this.changed(agent, command);
  }

  private finish(agent: Agent, command: QueuedCommand, status: CommandStatus, reason?: string): void {
    command.status = status;
    command.reason = reason;
    command.doneAt = this.now();
    if (this.inflight.get(agent.id)?.command === command) this.inflight.delete(agent.id);
    this.options.log(`comando ${commandLabel(command)} per ${agent.project}: ${status}${reason ? ` (${reason})` : ''}`);
    this.prune(agent);
    this.options.registry.touch(agent);
    this.changed(agent, command);
    if (agent.state === 'idle' && this.next(agent)) this.kick(agent.id, this.options.settleMs ?? 800);
  }

  /** Keeps the commands waiting or sent, and the last few done. */
  private prune(agent: Agent): void {
    const commands = (agent.commands ?? []).filter((command) => command.status !== 'annullato');
    const done = commands.filter((command) => DONE.includes(command.status));
    const old = new Set(done.slice(0, Math.max(0, done.length - KEEP_DONE)));
    agent.commands = commands.filter((command) => !old.has(command));
  }

  /** The session ended: what was still waiting will never be sent. */
  private abandon(agent: Agent): void {
    let changed = false;
    for (const command of agent.commands ?? []) {
      if (WAITING.includes(command.status) || command.status === 'inviato') {
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
      // The input box is on screen, and empty.
      const box = readPromptBox(await this.capture(pane, true));
      if (!box.found) return this.note(agent, command, 'bloccato', 'a dialog or the answer of /btw is open in the terminal: close it with Esc');
      if (box.typed) return this.note(agent, command, 'bloccato', 'there is text in the prompt: it stays as it is');
      // A state that changed while checking: the next round decides again.
      if (agent.state !== 'idle') return this.note(agent, command, 'in-coda', waitReason(agent));

      if (command.kind === 'clear' && this.options.notes && agent.transcriptPath && (await this.options.notes.supported())) {
        try {
          await this.options.notes.prepare(agent.transcriptPath);
        } catch (error) {
          return this.finish(agent, command, 'fallito', `arricurdAI did not write the note of the session: ${String(error)}`);
        }
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
        this.options.log(`${commandLabel(command)} per ${agent.project}: il prompt mostra ${typed.found ? JSON.stringify(typed.typed.slice(0, 300)) : 'niente (riquadro non trovato)'}`);
        return this.finish(agent, command, 'fallito', 'the prompt does not show the command as typed: Enter not pressed, check the terminal');
      }
      await tmux.run('send-keys', ['-t', pane, 'Enter']);
      command.status = 'inviato';
      command.reason = undefined;
      command.sentAt = this.now();
      this.inflight.set(agentId, { command, deadline: this.now() + ACK_MS[command.kind] });
      this.options.log(`comando inviato a ${agent.project} (${session}, ${pane}, pid ${agent.pid}): ${commandLabel(command)}`);
      this.options.registry.touch(agent);
      this.changed(agent, command);

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
