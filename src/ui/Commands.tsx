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
      text = `in coda: ${name}${command.reason ? ` · ${command.reason}` : ''}`;
      break;
    case 'bloccato':
      text = `${name} bloccato · ${command.reason ?? ''}`;
      break;
    case 'inviato':
      text = command.reason ? `${name}: ${command.reason}…` : `${name} inviato…`;
      break;
    case 'confermato':
      text = command.kind === 'btw' ? '/btw: la risposta è nel terminale' : command.kind === 'compact' ? '✓ /compact fatto' : '✓ /clear fatto';
      break;
    case 'non-confermato':
      text = `${name}: ${command.reason ?? 'nessuna conferma'}`;
      break;
    default:
      text = `${name} non inviato: ${command.reason ?? ''}`;
  }
  const waiting = command.status === 'in-coda' || command.status === 'bloccato';
  return (
    <div class="command-status" data-status={command.status} onClick={stop} title={text}>
      <span class="command-text">{text}</span>
      {command.kind === 'btw' && command.status === 'confermato' && (
        <button type="button" class="link" onClick={() => store.open(agent.id)}>
          apri
        </button>
      )}
      {waiting && (
        <button type="button" class="link" title="Annulla il comando" onClick={() => store.cancelCommand(agent.id, command.id)}>
          annulla
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
          placeholder="Domanda per /btw"
          onInput={(event) => setQuestion((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') send();
            if (event.key === 'Escape') close();
          }}
        />
        <button type="button" onClick={send} disabled={!question.trim()}>
          Invia
        </button>
        <button type="button" class="quiet" onClick={close}>
          Annulla
        </button>
      </div>
    );
  }

  if (mode === 'clear') {
    const tokens = agent.context ? ` (${shortTokens(agent.context.tokens)} token)` : '';
    const notes = store.state.settings.arricurdaiNotes
      ? 'arricurdAI prepara prima una nota per la nuova sessione.'
      : 'arricurdAI non può salvare una nota in questa versione: il transcript resta su disco e recall lo trova.';
    return (
      <div class="command-bar confirm" onClick={stop} onMouseDown={stop}>
        <span class="confirm-text">
          Pulire <strong>{displayName(agent)}</strong>? Il contesto{tokens} verrà azzerato. {notes}
        </span>
        <button
          type="button"
          class="danger"
          onClick={() => {
            store.command(agent.id, 'clear', undefined, true);
            close();
          }}
        >
          Pulisci
        </button>
        <button type="button" class="quiet" onClick={close}>
          Annulla
        </button>
      </div>
    );
  }

  return (
    <div class="command-bar" onClick={stop} onMouseDown={stop}>
      <button type="button" title="Domanda a parte, senza entrare nella conversazione" onClick={() => setMode('btw')}>
        btw…
      </button>
      <button type="button" title="Riassume la conversazione e libera contesto" onClick={() => store.command(agent.id, 'compact')}>
        compact
      </button>
      <button type="button" title="Nuova conversazione: chiede conferma" onClick={() => setMode('clear')}>
        clear
      </button>
    </div>
  );
}
