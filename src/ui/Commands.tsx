import { useEffect, useRef, useState } from 'preact/hooks';
import { type Agent, displayName, type QueuedCommand } from '../shared/agent.ts';
import { shortTokens } from '../shared/present.ts';
import type { Store } from './store.ts';

// The commands of a session: /btw with its question, /compact, and /clear after a confirmation. The daemon types
// them into the session only when it is ready (see daemon/commands.ts); here they are asked for, and their state
// is shown: in coda, bloccato, inviato, confermato.

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const label = (command: QueuedCommand): string => (command.kind === 'btw' ? `/btw ${clip(command.arg ?? '', 32)}` : `/${command.kind}`);

/** The command to show: the one waiting or sent, else the last one done in the last two minutes. */
export function currentCommand(agent: Agent, now: number): QueuedCommand | undefined {
  const commands = agent.commands ?? [];
  const active = commands.find((command) => command.status === 'in-coda' || command.status === 'bloccato' || command.status === 'inviato');
  if (active) return active;
  const done = commands.filter((command) => command.doneAt !== undefined && now - command.doneAt < 120_000);
  return done.at(-1);
}

export function CommandStatus({ agent, store, now }: { agent: Agent; store: Store; now: number }) {
  const command = currentCommand(agent, now);
  if (!command) return null;
  const stop = (event: Event): void => event.stopPropagation();
  const name = label(command);
  let text: string;
  switch (command.status) {
    case 'in-coda':
      text = `queued: ${name}${command.reason ? ` · ${command.reason}` : ''}`;
      break;
    case 'bloccato':
      text = `${name} blocked · ${command.reason ?? ''}`;
      break;
    case 'inviato':
      text = command.reason ? `${name}: ${command.reason}…` : `${name} sent…`;
      break;
    case 'confermato':
      text = command.kind === 'btw' ? '/btw: the answer is in the terminal' : command.kind === 'compact' ? '✓ /compact done' : '✓ /clear done';
      break;
    case 'non-confermato':
      text = `${name}: ${command.reason ?? 'no confirmation'}`;
      break;
    default:
      text = `${name} not sent: ${command.reason ?? ''}`;
  }
  const waiting = command.status === 'in-coda' || command.status === 'bloccato';
  return (
    <div class="command-status" data-status={command.status} onClick={stop} title={text}>
      <span class="command-text">{text}</span>
      {command.kind === 'btw' && command.status === 'confermato' && (
        <button type="button" class="link" onClick={() => store.open(agent.id)}>
          open
        </button>
      )}
      {waiting && (
        <button type="button" class="link" title="Cancel the command" onClick={() => store.cancelCommand(agent.id, command.id)}>
          cancel
        </button>
      )}
    </div>
  );
}

type Mode = 'idle' | 'btw' | 'clear';

/** The buttons, the field of /btw and the confirmation of /clear. */
export function CommandBar({ agent, store, onModeChange }: { agent: Agent; store: Store; onModeChange?: (active: boolean) => void }) {
  const [mode, setMode] = useState<Mode>('idle');
  const [question, setQuestion] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onModeChange?.(mode !== 'idle');
    if (mode === 'btw') field.current?.focus();
  }, [mode]);

  // Clicks and keys stay here: they must not open the box, nor reach a terminal.
  const stop = (event: Event): void => event.stopPropagation();
  const close = (): void => {
    setMode('idle');
    setQuestion('');
  };

  if (mode === 'btw') {
    const send = (): void => {
      if (!question.trim()) return;
      store.command(agent.id, 'btw', question);
      close();
    };
    return (
      <div class="command-bar" onClick={stop} onMouseDown={stop}>
        <input
          ref={field}
          class="command-input"
          type="text"
          value={question}
          maxLength={900}
          placeholder="Question for /btw"
          onInput={(event) => setQuestion((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') send();
            if (event.key === 'Escape') close();
          }}
        />
        <button type="button" onClick={send} disabled={!question.trim()}>
          Send
        </button>
        <button type="button" class="quiet" onClick={close}>
          Cancel
        </button>
      </div>
    );
  }

  if (mode === 'clear') {
    const tokens = agent.context ? ` (${shortTokens(agent.context.tokens)} tokens)` : '';
    const notes = store.state.settings.arricurdaiNotes
      ? 'arricurdAI first writes a note for the new session.'
      : 'This version of arricurdAI cannot save a note: the transcript stays on disk, and recall finds it.';
    return (
      <div class="command-bar confirm" onClick={stop} onMouseDown={stop}>
        <span class="confirm-text">
          Clear <strong>{displayName(agent)}</strong>? Its context{tokens} will be emptied. {notes}
        </span>
        <button
          type="button"
          class="danger"
          onClick={() => {
            store.command(agent.id, 'clear', undefined, true);
            close();
          }}
        >
          Clear
        </button>
        <button type="button" class="quiet" onClick={close}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div class="command-bar" onClick={stop} onMouseDown={stop}>
      <button type="button" title="A side question, kept out of the conversation" onClick={() => setMode('btw')}>
        btw…
      </button>
      <button type="button" title="Summarizes the conversation and frees context" onClick={() => store.command(agent.id, 'compact')}>
        compact
      </button>
      <button type="button" title="A new conversation: asks first" onClick={() => setMode('clear')}>
        clear
      </button>
    </div>
  );
}
