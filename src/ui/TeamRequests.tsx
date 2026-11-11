import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { type CrewSummary, type DeliveryStatus, MEMBER_NAME_MAX, ROLE_MAX, type Talk, type ThreadEntry, threadOf } from '../shared/crew.ts';
import { MODELS } from './NewSession.tsx';
import type { Store } from './store.ts';

// The panel of a team of agents, as a conversation: above, the thread of the team in the order things happened
// (requests, questions, answers, each with where it stands), from the file of the team, so it is the same after
// a restart of the app or of the daemon; below, a request from you to some of its members, to all of them, or to
// its Claude lead. The daemon numbers the requests, puts them in the queue of each session and pastes them when
// the session is ready (daemon/crews.ts, daemon/commands.ts).

export const DELIVERY_TEXT: Record<DeliveryStatus, string> = {
  queued: 'queued',
  blocked: 'blocked',
  sent: 'sent',
  working: 'working',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** Who gets the request: none chosen means all the members; a click on a name adds it or takes it away. */
export function toggleRecipient(to: readonly string[], name: string, members: readonly string[]): string[] {
  const next = to.includes(name) ? to.filter((other) => other !== name) : [...to, name];
  // Every member and nobody else is "all the members".
  return next.length === members.length && members.every((member) => next.includes(member)) ? [] : next;
}

/** "lead", "anna · lead", "⇄ tester", "→ formatter": a recipient on its chip. */
export const recipientText = (recipient: { name: string; talk?: string; lead?: boolean }): string =>
  recipient.lead
    ? recipient.name.toLowerCase() === 'lead'
      ? recipient.name
      : `${recipient.name} · lead`
    : `${recipient.talk === 'twoway' ? '⇄' : '→'} ${recipient.name}`;

const who = (name: string): string => (name === 'the user' ? 'you' : name);

/** The head of a step of the thread: who to whom, and what. */
export function entryHead(entry: ThreadEntry): string {
  switch (entry.kind) {
    case 'request':
      return `${who(entry.from)} → ${entry.deliveries.map((delivery) => delivery.to).join(', ')}`;
    case 'question':
      return `${entry.from} → ${who(entry.to)} · question on #${entry.n}`;
    case 'answer':
      return entry.status === 'kept' ? `${entry.from} · finished #${entry.n}` : `${entry.from} → ${who(entry.to)} · answer to #${entry.n}`;
  }
}

/** Where an answer or a question stands on its way. */
export function entryTag(entry: ThreadEntry): string | undefined {
  if (entry.kind === 'request') return undefined;
  const to = who(entry.to);
  switch (entry.status) {
    case 'shown':
      return 'for you';
    case 'kept':
      return 'not sent back';
    case 'queued':
      return `in the queue of ${to}`;
    case 'sent':
      return `sent to ${to}`;
    case 'delivered':
      return entry.kind === 'answer' && entry.byWait ? `collected by ${to} (waiting for it)` : `delivered to ${to}`;
    case 'held':
      return `held for ${to}, who waits for it`;
    case 'failed':
      return 'not delivered';
  }
}

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Entry({ entry }: { entry: ThreadEntry }) {
  const [open, setOpen] = useState(false);
  const tag = entryTag(entry);
  return (
    <li class="thread-entry" data-kind={entry.kind} data-status={entry.kind === 'request' ? undefined : entry.status}>
      <div class="thread-head">
        <span class="thread-who">{entryHead(entry)}</span>
        {entry.kind === 'request' && <span class="thread-n">#{entry.n}</span>}
        {tag && (
          <span class="thread-tag" title={entry.kind === 'answer' && entry.status === 'kept' ? 'It executes only, or it asked a question: the answer comes with the next request' : undefined}>
            {tag}
          </span>
        )}
        <span class="thread-time">{clock(entry.at)}</span>
      </div>
      {entry.text && (
        <p class={`thread-text${open ? ' open' : ''}`} title={open ? undefined : 'Click to read it all'} onClick={() => setOpen(!open)}>
          {entry.text}
        </p>
      )}
      {entry.kind === 'request' && (
        <div class="crew-deliveries">
          {entry.deliveries.map((delivery) => (
            <span key={delivery.to} class="crew-delivery" data-status={delivery.status} title={delivery.reason ?? DELIVERY_TEXT[delivery.status]}>
              {delivery.to} · {DELIVERY_TEXT[delivery.status]}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * The members of a team, to change: → / ⇄ of each (from its next request), take one out (its session goes on), add
 * one (a new session), and keep the team as a template.
 */
function EditTeam({ crew, store }: { crew: CrewSummary; store: Store }) {
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [talk, setTalk] = useState<Talk>('twoway');
  const [model, setModel] = useState('');
  const edit = store.state.crewEdit;
  const busy = edit?.busy === true;
  // Added: the row empties for the next one.
  const addedAt = edit?.action === 'add' && edit.ok ? edit.at : undefined;
  useEffect(() => {
    if (addedAt === undefined) return;
    setName('');
    setRole('');
  }, [addedAt]);
  const members = (crew.recipients ?? []).filter((recipient) => !recipient.lead);
  const note =
    edit?.error ??
    (edit?.ok && edit.action === 'saveCrewTemplate'
      ? `Saved as the template "${crew.name}": "new team" can start it again.`
      : edit?.ok && edit.action === 'talk'
        ? 'It counts from its next request, which tells it.'
        : 'A member taken away keeps its session: end it with /exit when you like.');
  return (
    <div class="edit-team">
      {members.map((member) => (
        <div key={member.name} class="broadcast-row">
          <span class="broadcast-label" />
          <span class="edit-member-name">{member.name}</span>
          <button
            type="button"
            class="talk-toggle chosen"
            data-talk={member.talk}
            disabled={busy}
            title={member.talk === 'twoway' ? 'It answers its lead. Click: from its next request it only executes.' : 'It only executes. Click: from its next request it also answers.'}
            onClick={() => store.editCrew(crew.id, { action: 'talk', name: member.name, talk: member.talk === 'twoway' ? 'oneway' : 'twoway' })}
          >
            {member.talk === 'twoway' ? '⇄ answers' : '→ executes'}
          </button>
          {removing === member.name ? (
            <>
              <span class="team-hint">its requests in the queue are cancelled</span>
              <button
                type="button"
                class="danger"
                onClick={() => {
                  setRemoving(undefined);
                  store.editCrew(crew.id, { action: 'remove', name: member.name });
                }}
              >
                take it out
              </button>
              <button type="button" class="quiet" onClick={() => setRemoving(undefined)}>
                keep it
              </button>
            </>
          ) : (
            <button type="button" class="quiet" disabled={busy || members.length === 1} title={members.length === 1 ? 'A team needs at least one member' : 'Take it out of the team'} onClick={() => setRemoving(member.name)}>
              remove
            </button>
          )}
        </div>
      ))}
      <div class="broadcast-row">
        <span class="broadcast-label">Add</span>
        <input class="command-input member-name" type="text" value={name} maxLength={MEMBER_NAME_MAX} placeholder="name" spellcheck={false} onInput={(event) => setName((event.target as HTMLInputElement).value)} />
        <input class="command-input member-role" type="text" value={role} maxLength={ROLE_MAX} placeholder="What it does, in a sentence" onInput={(event) => setRole((event.target as HTMLInputElement).value)} />
        <button type="button" class="talk-toggle chosen" onClick={() => setTalk(talk === 'twoway' ? 'oneway' : 'twoway')}>
          {talk === 'twoway' ? '⇄ answers' : '→ executes'}
        </button>
        <label class="spawn-option">
          model
          <select value={model} onChange={(event) => setModel((event.target as HTMLSelectElement).value)}>
            {MODELS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          class="primary"
          disabled={busy || !name.trim() || members.length >= 6}
          onClick={() => store.editCrew(crew.id, { action: 'add', member: { name: name.trim(), role: role.trim(), talk, ...(model ? { model } : {}) } })}
        >
          {busy && edit?.action === 'add' ? 'Starting…' : 'Add'}
        </button>
      </div>
      <div class="broadcast-row end">
        <span class={`broadcast-note${edit?.error ? ' error' : ''}`}>{note}</span>
        <button type="button" class="quiet" disabled={busy} onClick={() => store.saveTemplate({ crewId: crew.id })}>
          Save as template
        </button>
      </div>
    </div>
  );
}

export function TeamPanel({ crews, store, onClose }: { crews: readonly CrewSummary[]; store: Store; onClose: () => void }) {
  const [crewId, setCrewId] = useState(crews.at(-1)?.id);
  const crew = crews.find((candidate) => candidate.id === crewId) ?? crews.at(-1);
  const [to, setTo] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLOListElement>(null);
  /** Whether the thread shows its end: new steps scroll it only then, not while you read above. */
  const atEnd = useRef(true);
  const state = store.state.crewRequest;
  const busy = state?.busy === true && state.crewId === crew?.id;
  const thread = store.state.crewThread?.crewId === crew?.id ? store.state.crewThread?.requests : undefined;
  const entries = thread ? threadOf(thread) : [];

  useEffect(() => {
    if (!crew) return;
    field.current?.focus();
    atEnd.current = true;
    store.showThread(crew.id);
  }, [crew?.id]);
  useEffect(() => () => store.closeThread(), []);
  useLayoutEffect(() => {
    if (atEnd.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [entries.length, entries.at(-1)?.at]);
  // Sent: the field empties, ready for the next one.
  const sentN = state?.crewId === crew?.id ? state?.n : undefined;
  useEffect(() => {
    if (sentN !== undefined) setText('');
  }, [sentN]);

  if (!crew) return null;
  const recipients = crew.recipients ?? [];
  const members = recipients.filter((recipient) => !recipient.lead).map((recipient) => recipient.name);
  const send = (): void => {
    if (busy || !text.trim()) return;
    atEnd.current = true;
    store.sendCrewRequest(crew.id, to, text);
  };

  return (
    <section
      class="broadcast team-panel"
      aria-label={`Team ${crew.name}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send();
      }}
    >
      <div class="broadcast-row">
        <span class="broadcast-label">Team</span>
        {crews.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            class={`chip${candidate.id === crew.id ? ' on' : ''}`}
            onClick={() => {
              setCrewId(candidate.id);
              setTo([]);
            }}
          >
            {candidate.name}
          </button>
        ))}
        <span class="team-hint thread-count">{thread ? `${thread.length} ${thread.length === 1 ? 'request' : 'requests'}` : ''}</span>
        <button type="button" class={`quiet${editing ? ' on' : ''}`} title="Members, → / ⇄, template" onClick={() => setEditing(!editing)}>
          edit team
        </button>
      </div>
      {editing && <EditTeam crew={crew} store={store} />}
      {thread && entries.length === 0 && <p class="team-hint thread-empty">Nothing yet: the first request starts the thread of the team.</p>}
      {entries.length > 0 && (
        <ol
          ref={list}
          class="crew-thread"
          aria-label="Thread of the team"
          onScroll={(event) => {
            const element = event.currentTarget;
            atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          }}
        >
          {entries.map((entry) => (
            <Entry key={`${entry.kind}-${entry.n}-${entry.kind === 'request' ? '' : entry.from}-${entry.at}`} entry={entry} />
          ))}
        </ol>
      )}
      <div class="broadcast-row">
        <span class="broadcast-label">To</span>
        <button type="button" class={`chip${to.length === 0 ? ' on' : ''}`} title="Every member of the team (not the lead)" onClick={() => setTo([])}>
          all members
        </button>
        {recipients.map((recipient) => (
          <button
            key={recipient.name}
            type="button"
            class={`chip${to.includes(recipient.name) ? ' on' : ''}`}
            disabled={!recipient.agentId}
            title={recipient.lead ? 'The lead of the team' : recipient.talk === 'twoway' ? 'Answers its lead' : 'Executes only'}
            onClick={() => setTo(toggleRecipient(to, recipient.name, members))}
          >
            {recipientText(recipient)}
          </button>
        ))}
      </div>
      <div class="broadcast-row top">
        <span class="broadcast-label">Request</span>
        <textarea
          ref={field}
          class="command-input prompt-input"
          rows={2}
          value={text}
          maxLength={20_000}
          placeholder={`What to do, as you would write it to them. It reaches them as "Request #n from the user:". ⌘↩ sends it.`}
          onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
        />
      </div>
      <div class="broadcast-row end">
        <span class={`broadcast-note${state?.error && state.crewId === crew.id ? ' error' : ''}`}>
          {state?.error && state.crewId === crew.id ? state.error : 'It waits in the queue of each one and is pasted when the session is ready.'}
        </span>
        <button type="button" class="primary" disabled={busy || !text.trim()} onClick={send}>
          {busy ? 'Sending…' : 'Send'}
        </button>
        <button type="button" class="quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
