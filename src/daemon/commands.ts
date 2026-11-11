import { randomUUID } from 'node:crypto';
import type { Agent, CommandKind, CommandStatus, QueuedCommand } from '../shared/agent.ts';
import type { TmuxCommand, TmuxResult } from '../shared/tmux.ts';
import type { Registry } from './registry.ts';
import { readPromptBox, screenShows } from './screen.ts';
import type { HookPayload } from './state.ts';

// The commands of the box: /btw <question>, /compact, /clear. They are typed into the session through its tmux
// pane, as you would type them, and only when it is safe:
//
//   - the session waits for a new prompt (state "inattiva"): at work, or with a dialog open, the command waits
//     in a queue, and it is never typed into a dialog, where a key could answer it;
//   - the pane is still the one of that session and of that claude process (checked by pid every time);
//   - nobody typed into the session in the last seconds (tmux session_activity counts only keys from clients);
//   - the input box is on screen and empty: a draft of yours is never touched, an open answer of /btw is not
//     closed for you;
//   - after typing, the box must show exactly the command, or Enter is not pressed.
//
// Then a hook confirms it: PostCompact for /compact (PreCompact only says it started: Claude Code may still give
// up, "Not enough messages to compact", with no PostCompact), SessionEnd/SessionStart "clear" for /clear. /btw has no hook
// and leaves no trace in the transcript: its answer is only on screen, and the command counts as confirmed when
// its answer box shows the question.

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
}

export type EnqueueResult = { ok: true; command: QueuedCommand } | { ok: false; error: string };

const ACK_MS: Record<CommandKind, number> = { compact: 30_000, clear: 15_000, btw: 6_000 };
/** A compaction that started may take minutes on a large context. */
const COMPACTION_MS = 10 * 60_000;
const MAX_QUESTION_BYTES = 1000;
const KEEP_DONE = 3;
const WAITING: CommandStatus[] = ['in-coda', 'bloccato'];
const DONE: CommandStatus[] = ['confermato', 'non-confermato', 'fallito'];

export const commandText = (command: Pick<QueuedCommand, 'kind' | 'arg'>): string => (command.kind === 'btw' ? `/btw ${command.arg ?? ''}` : `/${command.kind}`);

/** Each byte as two hex digits: `send-keys -H` types them as they are, with nothing for tmux to interpret. */
const hexBytes = (text: string): string[] => Buffer.from(text, 'utf8').toString('hex').match(/../g) ?? [];

const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

function waitReason(agent: Agent): string {
  switch (agent.state) {
    case 'working':
      return 'aspetto la fine del turno';
    case 'waiting':
      return 'Claude aspetta una tua risposta';
    case 'compacting':
      return 'aspetto la fine della compattazione';
    case 'starting':
      return 'la sessione sta partendo';
    case 'error':
      return 'aspetto che la sessione riprenda';
    default:
      return 'aspetto';
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

  enqueue(agentId: string, kind: string, arg?: unknown, confirmed?: unknown): EnqueueResult {
    const agent = this.options.registry.agents.get(agentId);
    if (!agent) return { ok: false, error: 'sessione sconosciuta' };
    if (agent.control.kind !== 'tmux' || agent.state === 'ended') return { ok: false, error: 'sessione in sola lettura o terminata' };
    if (kind !== 'btw' && kind !== 'compact' && kind !== 'clear') return { ok: false, error: `comando sconosciuto: ${kind}` };
    if (kind === 'clear' && confirmed !== true) return { ok: false, error: '/clear va confermato' };
    let question: string | undefined;
    if (kind === 'btw') {
      // One line: a newline would be an Enter in the middle of the question.
      question = String(arg ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!question) return { ok: false, error: 'manca la domanda' };
      if (Buffer.byteLength(question) > MAX_QUESTION_BYTES) return { ok: false, error: 'domanda troppo lunga' };
    }
    const command: QueuedCommand = { id: randomUUID(), kind, arg: question, status: 'in-coda', createdAt: this.now() };
    agent.commands = [...(agent.commands ?? []), command];
    this.options.log(`comando in coda per ${agent.project}: ${commandText(command)}`);
    this.prune(agent);
    this.options.registry.touch(agent);
    this.kick(agent.id);
    return { ok: true, command };
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
    if (flight?.command.kind === 'compact' && flight.command.reason === 'compattazione in corso' && agent.state === 'idle' && agent.lastEvent.name === 'PreCompact') {
      this.finish(agent, flight.command, 'non-confermato', 'Claude non ha compattato (forse troppo pochi messaggi): guarda il terminale');
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
      this.note(agent, flight.command, 'inviato', 'compattazione in corso');
    } else if (flight.command.kind === 'compact' && ((event === 'PostCompact' && payload.trigger === 'manual') || (event === 'SessionStart' && payload.source === 'compact'))) {
      this.finish(agent, flight.command, 'confermato', 'compattazione fatta');
    } else if (flight.command.kind === 'clear' && ((event === 'SessionEnd' && payload.reason === 'clear') || (event === 'SessionStart' && payload.source === 'clear'))) {
      this.finish(agent, flight.command, 'confermato', 'sessione pulita');
    }
  }

  /** Every few seconds: commands sent with no confirmation in time, and commands waiting that may go now. */
  tick(): void {
    const now = this.now();
    for (const [agentId, flight] of this.inflight) {
      if (now < flight.deadline) continue;
      const agent = this.options.registry.agents.get(agentId);
      if (agent) this.finish(agent, flight.command, 'non-confermato', flight.command.kind === 'compact' ? 'nessuna compattazione partita: guarda il terminale' : 'nessuna conferma: guarda il terminale');
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
  }

  private finish(agent: Agent, command: QueuedCommand, status: CommandStatus, reason?: string): void {
    command.status = status;
    command.reason = reason;
    command.doneAt = this.now();
    if (this.inflight.get(agent.id)?.command === command) this.inflight.delete(agent.id);
    this.options.log(`comando ${commandText(command)} per ${agent.project}: ${status}${reason ? ` (${reason})` : ''}`);
    this.prune(agent);
    this.options.registry.touch(agent);
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
        command.reason = 'sessione terminata';
        command.doneAt = this.now();
        changed = true;
      }
    }
    this.inflight.delete(agent.id);
    if (changed) {
      this.prune(agent);
      this.options.registry.touch(agent);
    }
  }

  private async capture(pane: string): Promise<string> {
    const result = await this.options.tmux.run('capture-pane', ['-p', '-e', '-t', pane]);
    return result.code === 0 ? result.stdout : '';
  }

  private async dispatch(agentId: string): Promise<void> {
    if (this.dispatching.has(agentId) || this.inflight.has(agentId)) return;
    const agent = this.options.registry.agents.get(agentId);
    if (!agent) return;
    const command = this.next(agent);
    if (!command) return;
    if (agent.state !== 'idle') return this.note(agent, command, 'in-coda', waitReason(agent));
    if (agent.control.kind !== 'tmux' || !agent.control.paneId || !agent.pid) return this.note(agent, command, 'in-coda', 'aspetto di conoscere il pane della sessione');
    const pane = agent.control.paneId;
    const session = agent.control.session;
    const { tmux } = this.options;
    this.dispatching.add(agentId);
    try {
      // The pane is still the one of this session and of this claude process.
      const identity = await tmux.run('display-message', ['-p', '-t', pane, '#{session_name}\t#{pane_pid}']);
      const [paneSession, panePid] = identity.stdout.trim().split('\t');
      if (identity.code !== 0 || paneSession !== session || Number(panePid) !== agent.pid) {
        return this.finish(agent, command, 'fallito', 'il pane non corrisponde più alla sessione');
      }
      // Nobody typed into it in the last seconds.
      const activity = Number((await tmux.run('display-message', ['-p', '-t', session, '#{session_activity}'])).stdout.trim()) * 1000;
      if (Number.isFinite(activity) && this.now() - activity < (this.options.typingQuietMs ?? 10_000)) {
        return this.note(agent, command, 'in-coda', 'stai scrivendo nella sessione: aspetto');
      }
      // The input box is on screen, and empty.
      const box = readPromptBox(await this.capture(pane));
      if (!box.found) return this.note(agent, command, 'bloccato', 'nel terminale è aperto un dialogo o la risposta di /btw: chiudilo con Esc');
      if (box.typed) return this.note(agent, command, 'bloccato', "c'è del testo nel prompt: lo lascio com'è");
      // A state that changed while checking: the next round decides again.
      if (agent.state !== 'idle') return this.note(agent, command, 'in-coda', waitReason(agent));

      if (command.kind === 'clear' && this.options.notes && agent.transcriptPath && (await this.options.notes.supported())) {
        try {
          await this.options.notes.prepare(agent.transcriptPath);
        } catch (error) {
          return this.finish(agent, command, 'fallito', `arricurdAI non ha preparato la nota della sessione: ${String(error)}`);
        }
      }

      const text = commandText(command);
      await tmux.run('send-keys', ['-t', pane, '-H', ...hexBytes(text)]);
      await this.sleep(this.options.pasteSettleMs ?? 1000);
      const typed = readPromptBox(await this.capture(pane));
      if (!typed.found || !sameText(typed.typed, text)) {
        return this.finish(agent, command, 'fallito', 'il prompt non mostra il comando come scritto: Invio non premuto, controlla il terminale');
      }
      await tmux.run('send-keys', ['-t', pane, 'Enter']);
      command.status = 'inviato';
      command.reason = undefined;
      command.sentAt = this.now();
      this.inflight.set(agentId, { command, deadline: this.now() + ACK_MS[command.kind] });
      this.options.log(`comando inviato a ${agent.project} (${session}, ${pane}, pid ${agent.pid}): ${text}`);
      this.options.registry.touch(agent);

      if (command.kind === 'btw') {
        await this.sleep(1500);
        const screen = await this.capture(pane);
        if (this.inflight.get(agentId)?.command === command && screenShows(screen, text)) {
          this.finish(agent, command, 'confermato', 'la risposta è nel terminale');
        }
      }
    } catch (error) {
      this.finish(agent, command, 'fallito', String(error));
    } finally {
      this.dispatching.delete(agentId);
    }
  }
}
