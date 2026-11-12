import { useEffect, useRef, useState } from 'preact/hooks';
import { type Agent, displayName } from '../shared/agent.ts';
import { fillPrompt, type QuickPrompt } from '../shared/prompts.ts';
import { askText, btwText, insertText, oneLine, sendText } from '../shared/selection.ts';
import { canOpen, type SelectionMenuState, type Store } from './store.ts';

// The menu of a selection: you select text in a pane with the mouse (tmux copies it, as before) and, where you let
// go, a small menu offers to ask about it. It does not take the keyboard: what you type still goes to the terminal,
// and closes it, as does a click anywhere else.
//   - Ask: your question to this session, with the selection quoted; it waits for the session to be ready.
//   - btw: the same as /btw, a side question kept out of the conversation, on one line.
//   - Put in prompt: the selection, quoted, into the prompt of the session, not sent: you finish the question.
//   - Send to: your question to another session, with the selection and where it comes from.
//   - The quick prompts: one click, with the selection in their text (shared/prompts.ts); ✎ edits them.

const MENU_WIDTH = 400;

type Mode = { kind: 'menu' } | { kind: 'ask' } | { kind: 'btw' } | { kind: 'pick' } | { kind: 'send'; to: Agent };

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * Where the menu goes in the pane: under the last line of the selection, or, when that is in the lower part of the
 * pane, above its first line. Never over the selection, which stays readable.
 */
export function menuPosition(selection: Pick<SelectionMenuState, 'x' | 'top' | 'bottom' | 'width' | 'height'>): Record<string, string> {
  const left = Math.max(8, Math.min(selection.x - 24, selection.width - MENU_WIDTH - 8));
  return selection.bottom > selection.height * 0.55 ? { left: `${left}px`, bottom: `${selection.height - selection.top + 14}px` } : { left: `${left}px`, top: `${selection.bottom + 14}px` };
}

interface Props {
  agent: Agent;
  selection: SelectionMenuState;
  store: Store;
}

export function SelectionMenu({ agent, selection, store }: Props) {
  const [mode, setMode] = useState<Mode>({ kind: 'menu' });
  const [question, setQuestion] = useState('');
  const menu = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const sending = store.state.selectionSend;
  const busy = sending?.busy === true;
  const name = displayName(agent);
  const lines = selection.text.split('\n').length;

  useEffect(() => {
    if (mode.kind === 'ask' || mode.kind === 'btw' || mode.kind === 'send') field.current?.focus();
  }, [mode.kind]);

  // A click anywhere else closes it.
  useEffect(() => {
    const outside = (event: MouseEvent): void => {
      if (!menu.current?.contains(event.target as Node)) store.closeSelection();
    };
    document.addEventListener('mousedown', outside, true);
    return () => document.removeEventListener('mousedown', outside, true);
  }, [store]);

  const others = [...store.state.agents.values()].filter((other) => other.id !== agent.id && canOpen(other)).sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const back = (): void => {
    setMode({ kind: 'menu' });
    setQuestion('');
  };
  const send = (): void => {
    const text = question.trim();
    if (!text || busy) return;
    if (mode.kind === 'ask') store.askAbout(agent.id, askText(text, selection.text), true);
    else if (mode.kind === 'btw') store.btwAbout(agent.id, btwText(text, selection.text));
    else if (mode.kind === 'send') store.askAbout(mode.to.id, sendText(text, selection.text, name), false);
  };
  const quick = (prompt: QuickPrompt): void => {
    if (busy) return;
    const text = fillPrompt(prompt, { selection: selection.text, session: name, folder: agent.cwd ?? '' });
    if (prompt.mode === 'ask') store.askAbout(agent.id, text, true);
    else if (prompt.mode === 'btw') store.btwAbout(agent.id, text);
    else store.insertText(agent.id, text);
  };
  // Keys stay in the menu: they must not reach the terminal, nor the shortcuts of the page.
  const onKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      if (mode.kind === 'menu') store.closeSelection();
      else back();
    }
  };

  const where =
    mode.kind === 'ask'
      ? `Ask ${name}: it goes when the session is ready, with the selection quoted.`
      : mode.kind === 'btw'
        ? `/btw to ${name}: answered in its terminal, kept out of the conversation. One line, the selection in quotes.`
        : mode.kind === 'send'
          ? `To ${displayName(mode.to)}: your question, the selection quoted, and that it comes from ${name}.`
          : '';

  return (
    <div ref={menu} class="selection-menu" role="dialog" aria-label="Selection" style={menuPosition(selection)} onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
      <p class="selection-preview" title={selection.text}>
        “{clip(oneLine(selection.text), 70)}”{lines > 1 ? ` · ${lines} lines` : ''}
      </p>
      {mode.kind === 'menu' && (
        <>
          <div class="selection-row">
            <button type="button" class="primary" disabled={busy} title={`Ask ${name} about the selection`} onClick={() => setMode({ kind: 'ask' })}>
              Ask…
            </button>
            <button type="button" disabled={busy} title="A side question about the selection, kept out of the conversation" onClick={() => setMode({ kind: 'btw' })}>
              btw…
            </button>
            <button type="button" disabled={busy} title="The selection, quoted, into the prompt of the session: not sent, you finish the question" onClick={() => store.insertText(agent.id, insertText(selection.text))}>
              Put in prompt
            </button>
            <button type="button" disabled={busy || others.length === 0} title={others.length === 0 ? 'No other session to send to' : 'Ask another session about the selection'} onClick={() => setMode({ kind: 'pick' })}>
              Send to…
            </button>
          </div>
          <div class="selection-row">
            {store.state.prompts.map((prompt) => (
              <button key={prompt.name} type="button" class="chip" disabled={busy} title={`${prompt.mode === 'ask' ? 'Sends' : prompt.mode === 'btw' ? '/btw:' : 'Into the prompt:'} ${clip(oneLine(prompt.text), 120)}`} onClick={() => quick(prompt)}>
                {prompt.name}
              </button>
            ))}
            <button
              type="button"
              class="quiet"
              title="Edit the quick prompts"
              onClick={() => {
                store.closeSelection();
                store.requestPanel('prompts');
              }}
            >
              ✎ prompts
            </button>
          </div>
        </>
      )}
      {mode.kind === 'pick' && (
        <div class="selection-row">
          {others.map((other) => (
            <button key={other.id} type="button" class="chip" title={other.cwd} onClick={() => setMode({ kind: 'send', to: other })}>
              {displayName(other)}
            </button>
          ))}
          <button type="button" class="quiet" onClick={back}>
            Back
          </button>
        </div>
      )}
      {(mode.kind === 'ask' || mode.kind === 'btw' || mode.kind === 'send') && (
        <>
          {mode.kind === 'btw' ? (
            <input
              ref={field}
              class="command-input"
              type="text"
              value={question}
              maxLength={600}
              placeholder="Your question about the selection"
              onInput={(event) => setQuestion((event.target as HTMLInputElement).value)}
              onKeyDown={(event) => event.key === 'Enter' && send()}
            />
          ) : (
            <textarea
              ref={field}
              class="command-input selection-question"
              rows={2}
              value={question}
              maxLength={4000}
              placeholder="Your question about the selection"
              onInput={(event) => setQuestion((event.target as HTMLTextAreaElement).value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
          )}
          <p class="selection-note">{where}</p>
          <div class="selection-row end">
            <button type="button" class="quiet" onClick={back}>
              Back
            </button>
            <button type="button" class="primary" disabled={!question.trim() || busy} onClick={send}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </>
      )}
      {busy && mode.kind === 'menu' && <p class="selection-note">{sending?.action === 'insert' ? 'Putting it in the prompt…' : 'Sending…'}</p>}
      {sending?.error && !busy && <p class="selection-note error">{sending.error}</p>}
    </div>
  );
}
