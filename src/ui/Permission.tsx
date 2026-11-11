import { useEffect, useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import type { Store } from './store.ts';

// The permission dialog of a session, answered from its box: what is asked, in full, with Consenti and Rifiuta,
// and "sempre…" for the lasting choices Claude Code offers (a rule, a folder, a mode). The terminal shows the same
// dialog; whichever answers first wins (see daemon/permissions.ts). The buttons wake up a moment after the
// request appears, so that a click meant for something else does not answer it; a lasting choice takes two
// clicks, "sempre…" and then the choice.

const ARM_MS = 700;
/** How long the outcome of an answer stays under the summary. */
export const OUTCOME_MS = 60_000;

/** The outcome to show now, if any. */
export const visibleOutcome = (agent: Agent, now: number) =>
  agent.permissionOutcome && now - agent.permissionOutcome.at < OUTCOME_MS ? agent.permissionOutcome : undefined;

function useAnswer(agent: Agent, store: Store) {
  const ask = agent.permission;
  const [armed, setArmed] = useState(false);
  const [sent, setSent] = useState<string>();
  useEffect(() => {
    setArmed(false);
    if (!ask) return;
    const timer = setTimeout(() => setArmed(true), Math.max(0, ARM_MS - (Date.now() - ask.since)));
    return () => clearTimeout(timer);
  }, [ask?.ticket]);
  const ready = ask !== undefined && armed && sent !== ask.ticket;
  const answer = (behavior: 'allow' | 'deny', always?: number) => (event: Event) => {
    event.stopPropagation();
    if (!ask || !ready) return;
    setSent(ask.ticket);
    store.permission(agent.id, ask.ticket, behavior, always);
  };
  return { ask, ready, waiting: ask !== undefined && sent === ask.ticket, answer };
}

const stop = (event: Event): void => event.stopPropagation();

function Buttons({ ready, waiting, answer }: Pick<ReturnType<typeof useAnswer>, 'ready' | 'waiting' | 'answer'>) {
  return (
    <>
      <button type="button" class="allow" disabled={!ready} title="Allow once, as “Yes” in the terminal" onClick={answer('allow')}>
        Allow
      </button>
      <button type="button" class="deny" disabled={!ready} title="Deny and stop Claude, as “No” in the terminal" onClick={answer('deny')}>
        Deny
      </button>
      {waiting && <span class="permission-note">checking…</span>}
    </>
  );
}

/** In the box of the grid: the request in full, the two buttons, and the lasting choices behind "sempre…". */
export function PermissionPrompt({ agent, store }: { agent: Agent; store: Store }) {
  const { ask, ready, waiting, answer } = useAnswer(agent, store);
  const [choosing, setChoosing] = useState<string>();
  if (!ask) return null;
  const always = ask.always ?? [];
  const open = choosing === ask.ticket && always.length > 0;
  return (
    <div class="permission" onClick={stop} onMouseDown={stop}>
      <pre class="permission-detail" title={ask.detail}>
        {ask.detail}
      </pre>
      <div class="permission-actions">
        <Buttons ready={ready} waiting={waiting} answer={answer} />
        {always.length > 0 && !waiting && (
          <button
            type="button"
            class={`always-toggle${open ? ' on' : ''}`}
            disabled={!ready}
            title="The lasting choices: a rule, a folder, a mode"
            onClick={() => setChoosing(open ? undefined : ask.ticket)}
          >
            always…
          </button>
        )}
        {!waiting && <span class="permission-note">{ask.subagent ? `asked by ${ask.subagent} · ` : ''}or in the terminal</span>}
      </div>
      {open && !waiting && (
        <ul class="always-list">
          {always.map((option, index) => (
            <li key={index}>
              <button type="button" disabled={!ready} onClick={answer('allow', index)}>
                <span class="always-label">{option.label}</span>
                <span class="always-where">{option.where}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** In the column of compact boxes: the buttons only; the line above says what is asked. */
export function PermissionButtons({ agent, store }: { agent: Agent; store: Store }) {
  const { ask, ready, waiting, answer } = useAnswer(agent, store);
  if (!ask) return null;
  return (
    <span class="permission-actions compact" onClick={stop} onMouseDown={stop} onKeyDown={stop}>
      <Buttons ready={ready} waiting={waiting} answer={answer} />
    </span>
  );
}

export function PermissionOutcomeLine({ agent, now }: { agent: Agent; now: number }) {
  const outcome = visibleOutcome(agent, now);
  if (!outcome || agent.permission) return null;
  return (
    <div class="command-status permission-outcome" data-tone={outcome.tone} title={outcome.text}>
      <span class="command-text">{outcome.text}</span>
    </div>
  );
}
