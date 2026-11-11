import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Agent, displayName } from '../shared/agent.ts';
import { percentText, shortTokens } from '../shared/present.ts';
import { canOpen, type Store } from './store.ts';

// One command to several sessions: /compact to all those over 80% of their context, say. Each session gets its
// own command, as from its box: it waits until that session is ready, and /clear asks arricurdAI for the note
// first when it can (daemon/commands.ts). The boxes show how each one goes.

export const CONTEXT_THRESHOLD = 80;

type Kind = 'compact' | 'clear' | 'btw';

/** The sessions a command can go to: in the tmux of Forchetta, not ended. */
export const commandable = (agents: readonly Agent[]): Agent[] => agents.filter((agent) => canOpen(agent));

/** Those whose context fills at least the threshold of its window. */
export const overThreshold = (agents: readonly Agent[], threshold = CONTEXT_THRESHOLD): Agent[] =>
  commandable(agents).filter((agent) => (agent.context?.percent ?? 0) >= threshold);

export function BroadcastButton({ agents, open, onToggle }: { agents: readonly Agent[]; open: boolean; onToggle: () => void }) {
  if (commandable(agents).length < 2 && !open) return null;
  return (
    <button type="button" class={`broadcast-toggle${open ? ' active' : ''}`} title="One command to several sessions" onClick={onToggle}>
      command to several
    </button>
  );
}

export function BroadcastPanel({ agents, store, onClose }: { agents: readonly Agent[]; store: Store; onClose: () => void }) {
  const targets = useMemo(() => commandable(agents), [agents]);
  const [kind, setKind] = useState<Kind>('compact');
  const [question, setQuestion] = useState('');
  // At first: those over the threshold, the case this panel is for.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(overThreshold(agents).map((agent) => agent.id)));
  const [confirming, setConfirming] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (kind === 'btw') field.current?.focus();
    setConfirming(false);
  }, [kind]);

  // A session that ended, or left the tmux of Forchetta, drops out of the choice.
  const selected = targets.filter((agent) => chosen.has(agent.id));
  // From the latest choice, not the one of the last render: two quick clicks both count.
  const toggle = (id: string): void => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirming(false);
  };
  const pick = (agents: readonly Agent[]): void => {
    setChosen(new Set(agents.map((agent) => agent.id)));
    setConfirming(false);
  };
  const over = overThreshold(targets);
  const ready = selected.length > 0 && (kind !== 'btw' || question.trim() !== '');

  const send = (): void => {
    if (!ready) return;
    if (kind === 'clear' && !confirming) {
      setConfirming(true);
      return;
    }
    for (const agent of selected) store.command(agent.id, kind, kind === 'btw' ? question : undefined, kind === 'clear');
    onClose();
  };

  const tokens = selected.reduce((sum, agent) => sum + (agent.context?.tokens ?? 0), 0);
  const notes = store.state.settings.arricurdaiNotes
    ? 'arricurdAI first writes a note for each.'
    : 'This version of arricurdAI cannot save a note: the transcripts stay on disk, and recall finds them.';

  return (
    <section class="broadcast" aria-label="Command to several sessions" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <div class="broadcast-row">
        <span class="broadcast-label">Command</span>
        {(['compact', 'clear', 'btw'] as const).map((option) => (
          <button key={option} type="button" class={`chip${kind === option ? ' on' : ''}`} onClick={() => setKind(option)}>
            /{option}
          </button>
        ))}
        {kind === 'btw' && (
          <input
            ref={field}
            class="command-input"
            type="text"
            value={question}
            maxLength={900}
            placeholder="Question for /btw"
            onInput={(event) => setQuestion((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => event.key === 'Enter' && send()}
          />
        )}
      </div>
      <div class="broadcast-row">
        <span class="broadcast-label">Sessions</span>
        <button type="button" class="chip" onClick={() => pick(over)} disabled={over.length === 0}>
          context ≥ {CONTEXT_THRESHOLD}% ({over.length})
        </button>
        <button type="button" class="chip" onClick={() => pick(targets)}>
          all ({targets.length})
        </button>
        <button type="button" class="chip" onClick={() => pick([])}>
          none
        </button>
      </div>
      <ul class="broadcast-list">
        {targets.map((agent) => (
          <li key={agent.id}>
            <label>
              <input type="checkbox" checked={chosen.has(agent.id)} onChange={() => toggle(agent.id)} />
              <span class="broadcast-name">{displayName(agent)}</span>
              <span class="broadcast-ctx" data-high={(agent.context?.percent ?? 0) >= CONTEXT_THRESHOLD ? '' : undefined}>
                {agent.context ? `${percentText(agent.context)} · ${shortTokens(agent.context.tokens)}` : '—'}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {kind === 'clear' && confirming && (
        <p class="broadcast-confirm">
          Clear {selected.length === 1 ? '1 session' : `${selected.length} sessions`}? Their context ({shortTokens(tokens)} tokens in all) will be emptied. {notes}
        </p>
      )}
      <div class="broadcast-row end">
        <span class="broadcast-note">Each session gets it when it is ready, as from its box.</span>
        <button type="button" class={kind === 'clear' && confirming ? 'danger' : 'primary'} disabled={!ready} onClick={send}>
          {kind === 'clear' && confirming ? 'Clear' : `Send to ${selected.length === 1 ? '1 session' : `${selected.length} sessions`}`}
        </button>
        <button type="button" class="quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}
