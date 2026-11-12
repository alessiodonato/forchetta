import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_PROMPTS, MAX_PROMPT_NAME, MAX_PROMPT_TEXT, MAX_PROMPTS, type PromptMode, type QuickPrompt } from '../shared/prompts.ts';
import type { Store } from './store.ts';

// The quick prompts of the menu of a selection: a name (its button), a text with variables, and where it goes. The
// daemon checks and keeps them (var/prompts.json); until you save yours, the defaults.

const MODES: { mode: PromptMode; label: string }[] = [
  { mode: 'ask', label: 'send it' },
  { mode: 'btw', label: 'as /btw' },
  { mode: 'prompt', label: 'into the prompt' },
];

export function PromptsPanel({ store, onClose }: { store: Store; onClose: () => void }) {
  const [rows, setRows] = useState<QuickPrompt[]>(() => store.state.prompts.map((prompt) => ({ ...prompt })));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const saving = store.state.promptsSave;
  // Saved from this panel: it closes.
  const opened = useRef(Date.now());
  const savedAt = saving?.ok && saving.at >= opened.current ? saving.at : undefined;
  useEffect(() => {
    if (savedAt !== undefined) onClose();
  }, [savedAt]);

  // From the rows as they are now: two changes in the same moment must not undo each other.
  const change = (index: number, patch: Partial<QuickPrompt>): void => setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  return (
    <section class="broadcast prompts-panel" aria-label="Quick prompts" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <p class="broadcast-note">
        Quick prompts are in the menu that opens when you select text in a pane: one click sends them with the selection. In the text, <code>{'{selection}'}</code> is the selected
        text (quoted, when it is alone on its line; after the text, when it is missing), <code>{'{session}'}</code> the name of the session, <code>{'{folder}'}</code> its folder.
      </p>
      {rows.map((row, index) => (
        <div class="prompt-row" key={index}>
          <div class="broadcast-row">
            <input
              ref={index === 0 ? first : undefined}
              class="command-input prompt-name"
              type="text"
              value={row.name}
              maxLength={MAX_PROMPT_NAME}
              placeholder="Name"
              onInput={(event) => change(index, { name: (event.target as HTMLInputElement).value })}
            />
            {MODES.map(({ mode, label }) => (
              <button key={mode} type="button" class={`chip${row.mode === mode ? ' on' : ''}`} onClick={() => change(index, { mode })}>
                {label}
              </button>
            ))}
            <button type="button" class="quiet" title="Remove this prompt" onClick={() => setRows((current) => current.filter((_, at) => at !== index))}>
              ✕
            </button>
          </div>
          <textarea
            class="command-input mono prompt-text"
            rows={2}
            value={row.text}
            maxLength={MAX_PROMPT_TEXT}
            placeholder={'Explain this:\n{selection}'}
            onInput={(event) => change(index, { text: (event.target as HTMLTextAreaElement).value })}
          />
        </div>
      ))}
      {rows.length === 0 && <p class="broadcast-note">No quick prompts: the menu shows only Ask, btw, Put in prompt and Send to.</p>}
      <div class="broadcast-row">
        <button type="button" disabled={rows.length >= MAX_PROMPTS} onClick={() => setRows((current) => [...current, { name: '', text: '{selection}', mode: 'ask' }])}>
          Add
        </button>
        <button type="button" class="quiet" title="Explain, Fix, Test" onClick={() => setRows(DEFAULT_PROMPTS.map((prompt) => ({ ...prompt })))}>
          Restore the defaults
        </button>
        <span class="broadcast-note">{saving?.error && !saving.busy ? <span class="error-text">{saving.error}</span> : null}</span>
        <button type="button" class="quiet" onClick={onClose}>
          Close
        </button>
        <button type="button" class="primary" disabled={saving?.busy === true} onClick={() => store.savePrompts(rows)}>
          {saving?.busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
