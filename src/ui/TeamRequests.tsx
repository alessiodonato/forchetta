import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { type CrewSummary, type DeliveryStatus, MEMBER_NAME_MAX, PATH_MAX, PATHS_MAX, pathsText, ROLE_MAX, type Talk, type ThreadEntry, threadOf } from '../shared/crew.ts';
import type { Agent } from '../shared/agent.ts';
import { crewUsage, shortTokens, tokensDetail, tokensTotal, usdText } from '../shared/present.ts';
import { MODELS } from './NewSession.tsx';
import { useReturnFocus } from './focus.ts';
import type { Store } from './store.ts';

// The panel of a team of agents, as a conversation: above, the thread of the team in the order things happened
// (requests, questions, answers, each with where it stands, and the verdicts of the members that review), from the
// file of the team, so it is the same after
// a restart of the app or of the daemon; below, a request from you to some of its members, to all of them, or to
// its Claude lead. The daemon numbers the requests, puts them in the queue of each session and pastes them when
// the session is ready (daemon/crews.ts, daemon/commands.ts).

export const DELIVERY_TEXT: Record<DeliveryStatus, string> = {
  queued: 'queued',
  blocked: 'blocked',
  sent: 'sent',
  working: 'working',
  delegated: 'passed on',
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
      return `${who(entry.from)} → ${entry.deliveries.map((delivery) => delivery.to).join(', ')}${entry.parent !== undefined ? ` · for #${entry.parent}` : ''}`;
    case 'question':
      return `${entry.from} → ${who(entry.to)} · question on #${entry.n}`;
    case 'answer':
      return entry.status === 'kept' ? `${entry.from} · finished #${entry.n}` : `${entry.from} → ${who(entry.to)} · answer to #${entry.n}`;
    case 'review':
      return `${entry.from} · reviewed ${entry.short}${entry.subject ? ` ${entry.subject}` : ''}`;
  }
}

/** Where an answer or a question stands on its way. */
export function entryTag(entry: ThreadEntry): string | undefined {
  if (entry.kind === 'request') return undefined;
  if (entry.kind === 'review') return entry.verdict === 'approved' ? 'approved' : 'changes asked';
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
    <li
      class="thread-entry"
      data-kind={entry.kind}
      data-status={entry.kind === 'request' || entry.kind === 'review' ? undefined : entry.status}
      data-verdict={entry.kind === 'review' ? entry.verdict : undefined}
    >
      <div class="thread-head">
        <span class="thread-who">{entryHead(entry)}</span>
        {entry.kind === 'request' && <span class="thread-n">#{entry.n}</span>}
        {tag && (
          <span
            class="thread-tag"
            title={
              entry.kind === 'answer' && entry.status === 'kept'
                ? 'It executes only, or it asked a question: the answer comes with the next request'
                : entry.kind === 'review'
                  ? entry.verdict === 'approved'
                    ? 'The lead can merge the branch up to this commit: Forchetta asks you before a merge of anything after it'
                    : 'The reviewer asked for changes on this commit'
                  : undefined
            }
          >
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
            <span
              key={delivery.to}
              class="crew-delivery"
              data-status={delivery.status}
              title={delivery.reason ?? (delivery.status === 'delegated' ? 'It passed part of the work to the members that report to it: it is done, and answers, when they are' : DELIVERY_TEXT[delivery.status])}
            >
              {delivery.to} · {DELIVERY_TEXT[delivery.status]}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * The files of a member, to change: written as a list ("src/ui/, docs/"), sent when you leave the field or press
 * Enter. The guard follows them at once; the member learns them with its next request.
 */
function MemberFiles({ crewId, name, paths, busy, store }: { crewId: string; name: string; paths?: string[]; busy: boolean; store: Store }) {
  const saved = pathsText(paths ?? []);
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const send = (): void => {
    if (value.trim() === saved) return;
    store.editCrew(crewId, { action: 'paths', name, paths: value });
  };
  return (
    <input
      class="command-input mono member-files"
      type="text"
      value={value}
      disabled={busy}
      maxLength={PATHS_MAX * (PATH_MAX + 2)}
      placeholder="files: any no one else has"
      spellcheck={false}
      aria-label={`Files of ${name}`}
      title="The files it works on, relative to the folder of the team: folders (src/ui/), files, or patterns (*.test.ts). The guard stops its edits elsewhere, and the edits of the other members here. Empty: any file no other member has."
      onInput={(event) => setValue((event.target as HTMLInputElement).value)}
      onBlur={send}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          send();
        }
      }}
    />
  );
}

/**
 * The members of a team, to change: → / ⇄ of each (from its next request), its files, take one out (its session
 * goes on, the ones that reported to it go up), add one (a new session), under the lead or under a member that can
 * lead it, and keep the team as a template.
 */
function EditTeam({ crew, store }: { crew: CrewSummary; store: Store }) {
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [talk, setTalk] = useState<Talk>('twoway');
  const [model, setModel] = useState('');
  const [under, setUnder] = useState('');
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
  // A new member goes under the lead, or under a member whose session started with the tools to give requests.
  const leaders = members.filter((member) => member.canLead).map((member) => member.name);
  const note =
    edit?.error ??
    (edit?.ok && edit.action === 'saveCrewTemplate'
      ? `Saved as the template "${crew.name}": "new team" can start it again.`
      : edit?.ok && edit.action === 'talk'
        ? 'It counts from its next request, which tells it.'
        : edit?.ok && edit.action === 'paths'
          ? 'The guard follows its new files at once; the member learns them with its next request.'
          : 'A member taken away keeps its session: end it with /exit when you like.');
  return (
    <div class="edit-team">
      {members.map((member) => (
        <div key={member.name} class="broadcast-row">
          <span class="broadcast-label" />
          <span class="edit-member-name" title={member.reviews ? 'It reviews: the lead merges only the commits it approved' : undefined}>
            {member.name}
            {member.reportsTo !== undefined ? <span class="team-hint"> ↳ {member.reportsTo}</span> : null}
            {member.reviews ? <span class="team-hint"> · reviews</span> : null}
          </span>
          <button
            type="button"
            class="talk-toggle chosen"
            data-talk={member.talk}
            disabled={busy}
            title={
              member.talk === 'twoway'
                ? `It answers ${member.reportsTo ?? 'its lead'}. Click: from its next request it only executes.`
                : 'It only executes. Click: from its next request it also answers.'
            }
            aria-label={`${member.name} answers ${member.reportsTo ?? 'its lead'}`}
            aria-pressed={member.talk === 'twoway'}
            onClick={() => store.editCrew(crew.id, { action: 'talk', name: member.name, talk: member.talk === 'twoway' ? 'oneway' : 'twoway' })}
          >
            {member.talk === 'twoway' ? '⇄ answers' : '→ executes'}
          </button>
          <MemberFiles crewId={crew.id} name={member.name} paths={member.paths} busy={busy} store={store} />
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
            <button
              type="button"
              class="quiet"
              disabled={busy || members.length === 1}
              title={members.length === 1 ? 'A team needs at least one member' : 'Take it out of the team'}
              aria-label={`Remove ${member.name} from the team`}
              onClick={() => setRemoving(member.name)}
            >
              remove
            </button>
          )}
        </div>
      ))}
      <div class="broadcast-row">
        <span class="broadcast-label">Add</span>
        <input
          class="command-input member-name"
          type="text"
          value={name}
          maxLength={MEMBER_NAME_MAX}
          placeholder="name"
          spellcheck={false}
          aria-label="Name of the new member"
          onInput={(event) => setName((event.target as HTMLInputElement).value)}
        />
        <input
          class="command-input member-role"
          type="text"
          value={role}
          maxLength={ROLE_MAX}
          placeholder="What it does, in a sentence"
          aria-label="Role of the new member"
          onInput={(event) => setRole((event.target as HTMLInputElement).value)}
        />
        <button type="button" class="talk-toggle chosen" aria-label="The new member answers the one it reports to" aria-pressed={talk === 'twoway'} onClick={() => setTalk(talk === 'twoway' ? 'oneway' : 'twoway')}>
          {talk === 'twoway' ? '⇄ answers' : '→ executes'}
        </button>
        {leaders.length > 0 && (
          <label class="spawn-option" title="Who it reports to: a member here leads it, gives it requests and gets its answers. Only the members that started leading others can take one more.">
            under
            <select value={under} onChange={(event) => setUnder((event.target as HTMLSelectElement).value)}>
              <option value="">{crew.lead ?? 'you'} (lead)</option>
              {leaders.map((leader) => (
                <option key={leader} value={leader}>
                  {leader}
                </option>
              ))}
            </select>
          </label>
        )}
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
          onClick={() =>
            store.editCrew(crew.id, { action: 'add', member: { name: name.trim(), role: role.trim(), talk, ...(model ? { model } : {}), ...(under && leaders.includes(under) ? { reportsTo: under } : {}) } })
          }
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

/** What each session of a team used since it started, and the team together: tokens from the transcripts, cost from Claude Code. */
function UsageTable({ rows }: { rows: { name: string; lead?: boolean; agent?: Agent }[] }) {
  const all = crewUsage(rows.flatMap((row) => (row.agent ? [row.agent] : [])));
  const teamTokens = all ? tokensTotal(all.tokens) : 0;
  const usd = (value: number | undefined): string => (!value ? '—' : `${value >= 0.01 ? '≈ ' : ''}${usdText(value)}`);
  return (
    <div class="crew-usage">
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th title="Every token of every kind: input, cache writes, cache reads, output">Tokens</th>
            <th title="The tokens the model wrote: the most expensive kind">Output</th>
            <th title="At API prices, as Claude Code computes it for /cost">Cost</th>
            <th title="Its share of the tokens of the team">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const tokens = row.agent?.tokens;
            const total = tokens ? tokensTotal(tokens) : 0;
            return (
              <tr key={row.name}>
                <td>
                  {row.name}
                  {row.lead && row.name !== 'lead' ? <span class="team-hint"> · lead</span> : null}
                </td>
                <td title={total > 0 ? tokensDetail(tokens!) : 'Nothing yet: it counts from its first answer.'}>{total > 0 ? shortTokens(total) : '—'}</td>
                <td>{total > 0 ? shortTokens(tokens!.output) : '—'}</td>
                <td>{usd(row.agent?.usage?.usd)}</td>
                <td>{teamTokens > 0 && total > 0 ? `${Math.round((100 * total) / teamTokens)}%` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
        {all && (
          <tfoot>
            <tr>
              <td>Team</td>
              <td title={tokensDetail(all.tokens)}>{shortTokens(teamTokens)}</td>
              <td>{shortTokens(all.tokens.output)}</td>
              <td>{usd(all.usd)}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
      <p class="team-hint usage-note">
        Since each session started, with its subagents. Tokens are read from the transcripts, each answer once; most are cache reads, the cheapest kind. The cost is at API prices: on a Claude
        plan you do not pay it, but it shows what weighs on your limits.
      </p>
    </div>
  );
}

export function TeamPanel({ crews, store, onClose, onNew, onStudio }: { crews: readonly CrewSummary[]; store: Store; onClose: () => void; onNew: () => void; onStudio?: (crewId: string) => void }) {
  const [crewId, setCrewId] = useState(crews.at(-1)?.id);
  const crew = crews.find((candidate) => candidate.id === crewId) ?? crews.at(-1);
  const [to, setTo] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  useReturnFocus(panel);
  const list = useRef<HTMLOListElement>(null);
  /** Whether the thread shows its end: new steps scroll it only then, not while you read above. */
  const atEnd = useRef(true);
  const state = store.state.crewRequest;
  const busy = state?.busy === true && state.crewId === crew?.id;
  const thread = store.state.crewThread?.crewId === crew?.id ? store.state.crewThread?.requests : undefined;
  const reviews = store.state.crewThread?.crewId === crew?.id ? store.state.crewThread?.reviews : undefined;
  const entries = thread ? threadOf(thread, reviews) : [];

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
  const usageRows = recipients.map((recipient) => ({ name: recipient.name, lead: recipient.lead, agent: recipient.agentId ? store.state.agents.get(recipient.agentId) : undefined }));
  const used = crewUsage(usageRows.flatMap((row) => (row.agent ? [row.agent] : [])));
  const usedTokens = used ? tokensTotal(used.tokens) : 0;
  const members = recipients.filter((recipient) => !recipient.lead).map((recipient) => recipient.name);
  const send = (): void => {
    if (busy || !text.trim()) return;
    atEnd.current = true;
    store.sendCrewRequest(crew.id, to, text);
  };

  return (
    <section
      ref={panel}
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
            aria-pressed={candidate.id === crew.id}
            onClick={() => {
              setCrewId(candidate.id);
              setTo([]);
            }}
          >
            {candidate.name}
          </button>
        ))}
        <button type="button" class="chip" title="Start a team of Claude Code sessions that work together: a lead and its members" onClick={onNew}>
          + new team
        </button>
        <span class="team-hint thread-count">{thread ? `${thread.length} ${thread.length === 1 ? 'request' : 'requests'}` : ''}</span>
        {((used && (used.usd > 0 || usedTokens > 0)) || crew.budgetUsd) && (
          <button
            type="button"
            class={`quiet${usageOpen ? ' on' : ''}${crew.budgetUsd && (used?.usd ?? 0) >= crew.budgetUsd ? ' over-budget' : ''}`}
            title={`What the team used, agent by agent${crew.budgetUsd ? `; its budget is ${usdText(crew.budgetUsd)} (a warning, not a limit)` : ''}`}
            aria-expanded={usageOpen}
            onClick={() => setUsageOpen(!usageOpen)}
          >
            {used && used.usd > 0 ? `${used.usd >= 0.01 ? '≈ ' : ''}${usdText(used.usd)}` : crew.budgetUsd ? '$0' : ''}
            {crew.budgetUsd ? ` of ${usdText(crew.budgetUsd)}` : ''}
            {used && usedTokens > 0 ? `${used.usd > 0 || crew.budgetUsd ? ' · ' : ''}${shortTokens(usedTokens)} tok` : ''}
          </button>
        )}
        {onStudio && (
          <button type="button" class="quiet" title="The team on the canvas of the studio, live: what each one does, what goes along each arrow; add or take away a member there" onClick={() => onStudio(crew.id)}>
            studio
          </button>
        )}
        <button type="button" class={`quiet${editing ? ' on' : ''}`} title="Members, → / ⇄, template" aria-expanded={editing} onClick={() => setEditing(!editing)}>
          edit team
        </button>
      </div>
      {usageOpen && <UsageTable rows={usageRows} />}
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
            <Entry key={`${entry.kind}-${entry.n}-${entry.kind === 'request' ? '' : entry.from}-${entry.kind === 'review' ? entry.short : ''}-${entry.at}`} entry={entry} />
          ))}
        </ol>
      )}
      <div class="broadcast-row" role="group" aria-labelledby="team-request-to">
        <span class="broadcast-label" id="team-request-to">
          To
        </span>
        <button type="button" class={`chip${to.length === 0 ? ' on' : ''}`} title="Every member of the team (not the lead)" aria-pressed={to.length === 0} onClick={() => setTo([])}>
          all members
        </button>
        {recipients.map((recipient) => (
          <button
            key={recipient.name}
            type="button"
            class={`chip${to.includes(recipient.name) ? ' on' : ''}`}
            aria-pressed={to.includes(recipient.name)}
            disabled={!recipient.agentId}
            title={
              recipient.lead
                ? 'The lead of the team'
                : `${recipient.reportsTo !== undefined ? `Reports to ${recipient.reportsTo}; ` : ''}${recipient.talk === 'twoway' ? 'answers whoever asks it' : 'executes only'}`
            }
            onClick={() => setTo(toggleRecipient(to, recipient.name, members))}
          >
            {recipientText(recipient)}
          </button>
        ))}
      </div>
      <div class="broadcast-row top">
        <label class="broadcast-label" for="team-request-text">
          Request
        </label>
        <textarea
          ref={field}
          id="team-request-text"
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
