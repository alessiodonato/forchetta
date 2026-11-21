import { useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import { shortTokens } from '../shared/present.ts';
import { type LostSession, lostName, lostText, SESSION_ID } from '../shared/reopen.ts';
import type { Store } from './store.ts';

// The sessions that ended with the Mac (shared/reopen.ts): a line under the top one says which, with "Reopen all",
// one by one, or not now; and the box of any session that ended has "reopen" while it shows. Each one goes on with
// its conversation, in its folder; a member of a team goes back into its team.

/** A conversation this large costs a share of the limits when Claude reads it again, at the first message. */
const LARGE_CONTEXT = 300_000;

function LostRow({ lost, store, busy }: { lost: LostSession; store: Store; busy: boolean }) {
  const large = (lost.contextTokens ?? 0) >= LARGE_CONTEXT;
  return (
    <li class="reopen-row">
      <strong>{lostName(lost)}</strong>
      <span class="team-hint" title={lost.cwd}>
        {lost.cwd.replace(/^\/Users\/[^/]+/, '~')}
      </span>
      {lost.team?.crew && lost.team.group && <span class="team-hint">· team {lost.team.group}</span>}
      {lost.contextTokens ? (
        <span class={`team-hint${large ? ' reopen-large' : ''}`} title="Claude reads the whole conversation again at its first message after it reopens: a large one costs a share of your limits">
          · {shortTokens(lost.contextTokens)} of context
        </span>
      ) : null}
      <span class="grow" />
      <button type="button" class="quiet" disabled={busy} onClick={() => store.reopen([lost.agentId])}>
        reopen
      </button>
      <button type="button" class="quiet" disabled={busy} aria-label={`Do not offer ${lostName(lost)} again`} title="Not this one: it is offered no more" onClick={() => store.dismissReopen([lost.agentId])}>
        ×
      </button>
    </li>
  );
}

/** The line of the sessions that ended with the Mac, and of how reopening went. */
export function ReopenNotice({ store }: { store: Store }) {
  const [choosing, setChoosing] = useState(false);
  const lost = store.state.reopen ?? [];
  const doing = store.state.reopening;
  const busy = doing?.busy === true;
  // How the last reopening went, for a little while.
  const recent = doing && !doing.busy && Date.now() - doing.at < 30_000 ? doing : undefined;
  if (lost.length === 0 && !busy && !recent) return null;
  return (
    <section class="notice reopen-notice" role="status" aria-label="Sessions that ended with the Mac">
      <div class="reopen-head">
        {busy && doing ? (
          <span>
            Reopening {doing.agentIds.length} {doing.agentIds.length === 1 ? 'session' : 'sessions'}, each on its conversation…
          </span>
        ) : lost.length > 0 ? (
          <span>
            {lost.length} {lost.length === 1 ? 'session' : 'sessions'} ended when the Mac restarted: {lostText(lost)}.
          </span>
        ) : (
          <span />
        )}
        {recent && (
          <span class={recent.failed?.length ? 'reopen-failed' : 'reopen-done'}>
            {recent.reopened?.length ? `${recent.reopened.length} reopened` : ''}
            {recent.reopened?.length && recent.failed?.length ? '; ' : ''}
            {recent.failed?.length ? `not reopened: ${recent.failed.map((one) => `${one.name} (${one.error})`).join('; ')}` : ''}
          </span>
        )}
        <span class="grow" />
        {lost.length > 0 && (
          <>
            <button type="button" class="primary" disabled={busy} title="Each one on its conversation, in its folder; the members of a team back into their team" onClick={() => store.reopen(lost.map((one) => one.agentId))}>
              Reopen all
            </button>
            <button type="button" class={`quiet${choosing ? ' on' : ''}`} aria-expanded={choosing} onClick={() => setChoosing(!choosing)}>
              Choose…
            </button>
            <button type="button" class="quiet" disabled={busy} title="Offered no more: their conversations stay with Claude Code (claude --resume)" onClick={() => store.dismissReopen()}>
              Not now
            </button>
          </>
        )}
      </div>
      {choosing && lost.length > 0 && (
        <ul class="reopen-list">
          {lost.map((one) => (
            <LostRow key={one.agentId} lost={one} store={store} busy={busy} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** "reopen" in the box of a session that ended, while it shows: on its conversation again. */
export function ReopenButton({ agent, store }: { agent: Agent; store: Store }) {
  if (agent.state !== 'ended' || store.state.reopen === undefined || !agent.cwd || !agent.sessionId || !SESSION_ID.test(agent.sessionId)) return null;
  const busy = store.state.reopening?.busy === true;
  const mine = busy && store.state.reopening?.agentIds.includes(agent.id);
  return (
    <div class="reopen-box" onClick={(event) => event.stopPropagation()}>
      <button type="button" class="link" disabled={busy} title="Its conversation again, in its folder (claude --resume); back into its team if it was in one" onClick={() => store.reopen([agent.id])}>
        {mine ? 'reopening…' : 'reopen'}
      </button>
      <span class="team-hint">{agent.endReason === 'the Mac restarted' ? 'it ended with the Mac' : 'its conversation goes on'}</span>
    </div>
  );
}
