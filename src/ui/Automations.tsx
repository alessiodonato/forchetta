import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import {
  AUTO_MINUTES_DEFAULT,
  AUTO_MINUTES_MAX,
  AUTO_MINUTES_MIN,
  type AutoItem,
  type AutomationView,
  type AutoTrigger,
  defaultGoal,
  fieldsOf,
  triggerText,
} from '../shared/automation.ts';
import { type CrewSummary, type CrewTemplate, paramsUsed, VALUE_MAX } from '../shared/crew.ts';
import { crewUsage, usdText } from '../shared/present.ts';
import { lastPart, recentFolders } from './NewSession.tsx';
import { useReturnFocus } from './focus.ts';
import type { Store } from './store.ts';

// The panel "auto": the teams that start by themselves (shared/automation.ts). On top, one chip for each and "+ new";
// below, the one chosen: how it starts, the run at work, what waits and why, the last runs; or the form that makes
// or changes one. The daemon checks what the form sends (daemon/automations.ts) and says what is wrong.

const DAYS: readonly { day: number; name: string }[] = [
  { day: 1, name: 'Mon' },
  { day: 2, name: 'Tue' },
  { day: 3, name: 'Wed' },
  { day: 4, name: 'Thu' },
  { day: 5, name: 'Fri' },
  { day: 6, name: 'Sat' },
  { day: 0, name: 'Sun' },
];

/** A glyph for the state of an automation, on its chip. */
function stateMark(auto: AutomationView): { mark: string; title: string } {
  if (auto.items.some((item) => item.status === 'running')) return { mark: '▶', title: 'a run is at work' };
  if (auto.paused) return { mark: '‖', title: `paused: ${auto.paused.reason}` };
  if (auto.items.some((item) => item.status === 'waiting')) return { mark: '●', title: auto.wait ?? 'something waits in the queue' };
  return { mark: '', title: 'nothing to do now' };
}

const clock = (at: number): string => {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return new Date().toDateString() === date.toDateString() ? time : `${date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
};

const minutes = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 60_000));
  return total < 60 ? `${total} min` : `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')}`;
};

/** What the sessions of a team cost so far, from their boxes. */
function liveCost(crew: CrewSummary | undefined, agents: ReadonlyMap<string, Agent>): number | undefined {
  if (!crew) return undefined;
  const sessions = (crew.recipients ?? []).flatMap((recipient) => (recipient.agentId && agents.get(recipient.agentId) ? [agents.get(recipient.agentId)!] : []));
  return crewUsage(sessions)?.usd;
}

/** What the form holds: as typed, checked by the daemon on save. */
interface Draft {
  name: string;
  template: string;
  cwd: string;
  kind: AutoTrigger['kind'];
  days: number[];
  time: string;
  what: 'issues' | 'prs';
  label: string;
  repo: string;
  goal: string;
  values: Record<string, string>;
  budget: string;
  maxMinutes: string;
  endSessions: boolean;
}

function draftOf(auto: AutomationView | undefined, templates: readonly CrewTemplate[], folder: string): Draft {
  if (!auto) {
    const first = templates.find((template) => template.lead.kind === 'claude');
    return { name: '', template: first?.name ?? '', cwd: folder, kind: 'queue', days: [1, 2, 3, 4, 5], time: '09:00', what: 'issues', label: 'forchetta', repo: '', goal: '{item}', values: {}, budget: '10', maxMinutes: String(AUTO_MINUTES_DEFAULT), endSessions: true };
  }
  const trigger = auto.trigger;
  return {
    name: auto.name,
    template: auto.template,
    cwd: auto.cwd,
    kind: trigger.kind,
    days: trigger.kind === 'schedule' ? [...trigger.days] : [1, 2, 3, 4, 5],
    time: trigger.kind === 'schedule' ? trigger.time : '09:00',
    what: trigger.kind === 'github' ? trigger.what : 'issues',
    label: trigger.kind === 'github' ? (trigger.label ?? '') : 'forchetta',
    repo: trigger.kind === 'github' ? (trigger.repo ?? '') : '',
    goal: auto.goal,
    values: { ...(auto.values ?? {}) },
    budget: String(auto.budgetUsd),
    maxMinutes: String(auto.maxMinutes),
    endSessions: auto.endSessions,
  };
}

const triggerOf = (draft: Draft): AutoTrigger =>
  draft.kind === 'queue'
    ? { kind: 'queue' }
    : draft.kind === 'schedule'
      ? { kind: 'schedule', days: draft.days, time: draft.time }
      : { kind: 'github', what: draft.what, ...(draft.label.trim() ? { label: draft.label.trim() } : {}), ...(draft.repo.trim() ? { repo: draft.repo.trim() } : {}) };

function AutoForm({ auto, agents, store, onDone }: { auto?: AutomationView; agents: readonly Agent[]; store: Store; onDone: (id?: string) => void }) {
  const templates = store.state.templates;
  const recent = useMemo(() => recentFolders(agents), [agents]);
  const [draft, setDraft] = useState<Draft>(() => draftOf(auto, templates, recent[0] ?? ''));
  const put = (patch: Partial<Draft>): void => setDraft((current) => ({ ...current, ...patch }));
  const edit = store.state.autoEdit;
  const busy = edit?.action === 'save' && edit.busy;
  const asked = useRef(0);
  // The folder chosen in the panel of macOS.
  useEffect(() => {
    window.forchettaFolder = (path: string) => put({ cwd: path });
    return () => {
      window.forchettaFolder = undefined;
    };
  }, []);
  // Saved: back to the automation, by the id the daemon gave.
  useEffect(() => {
    if (asked.current && edit && !edit.busy && edit.action === 'save' && edit.at >= asked.current && edit.ok) onDone(edit.id ?? auto?.id);
  }, [edit?.at]);

  const template = templates.find((one) => one.name === draft.template);
  const params = template ? paramsUsed(template) : [];
  const fields = fieldsOf(triggerOf(draft));
  const fieldList = fields.map((field) => `{${field}}`).join(', ');
  /** Another way to start: the goal follows, unless you wrote one of your own. */
  const switchKind = (kind: Draft['kind'], what = draft.what): void => {
    const before = defaultGoal(triggerOf(draft));
    const after = defaultGoal(triggerOf({ ...draft, kind, what }));
    put({ kind, what, ...(draft.goal.trim() === '' || draft.goal === before ? { goal: after } : {}) });
  };
  const save = (): void => {
    if (busy) return;
    asked.current = Date.now();
    const values = Object.fromEntries(params.flatMap((param) => (draft.values[param]?.trim() ? [[param, draft.values[param]!.trim()]] : [])));
    store.saveAutomation(
      {
        name: draft.name,
        template: draft.template,
        cwd: draft.cwd,
        trigger: triggerOf(draft),
        goal: draft.goal,
        values,
        budgetUsd: draft.budget,
        maxMinutes: draft.maxMinutes.trim() === '' ? undefined : Number(draft.maxMinutes),
        endSessions: draft.endSessions,
      },
      auto?.id,
    );
  };
  const error = edit?.action === 'save' && !edit.busy && edit.at >= asked.current && asked.current > 0 ? edit.error : undefined;

  return (
    <div class="auto-form" onKeyDown={(event) => event.key === 'Enter' && (event.metaKey || event.ctrlKey) && save()}>
      <div class="broadcast-row">
        <label class="broadcast-label" for="auto-name">
          Name
        </label>
        <input id="auto-name" class="command-input" type="text" value={draft.name} maxLength={40} placeholder="nightly fixes" onInput={(event) => put({ name: (event.target as HTMLInputElement).value })} />
      </div>
      <div class="broadcast-row">
        <label class="broadcast-label" for="auto-template">
          Team
        </label>
        <select id="auto-template" value={draft.template} onChange={(event) => put({ template: (event.target as HTMLSelectElement).value })}>
          {!template && <option value="">choose a template</option>}
          {templates.map((one) => (
            <option key={one.name} value={one.name} disabled={one.lead.kind !== 'claude'}>
              {one.name}
              {one.lead.kind !== 'claude' ? ' (you lead it: not for this)' : ''}
            </option>
          ))}
        </select>
        <span class="team-hint">{template ? `${template.members.length + 1} agents, a new team for each run` : 'a template with a Claude lead: it splits the work and says when it is delivered'}</span>
      </div>
      <div class="broadcast-row">
        <label class="broadcast-label" for="auto-folder">
          Folder
        </label>
        <input id="auto-folder" class="command-input mono" type="text" value={draft.cwd} placeholder="~/projects/app" spellcheck={false} onInput={(event) => put({ cwd: (event.target as HTMLInputElement).value })} />
        <button type="button" title="Choose the folder in the panel of macOS" onClick={() => store.chooseFolder(draft.cwd)}>
          Choose…
        </button>
      </div>
      {recent.length > 0 && (
        <div class="broadcast-row">
          <span class="broadcast-label" />
          {recent.map((path) => (
            <button key={path} type="button" class={`chip${path === draft.cwd ? ' on' : ''}`} title={path} aria-pressed={path === draft.cwd} onClick={() => put({ cwd: path })}>
              {lastPart(path)}
            </button>
          ))}
        </div>
      )}
      <div class="broadcast-row">
        <span class="broadcast-label">Starts</span>
        <span class="view-switch" role="group" aria-label="How it starts">
          {(
            [
              ['queue', 'from a queue'],
              ['schedule', 'at a time'],
              ['github', 'from GitHub'],
            ] as const
          ).map(([kind, text]) => (
            <button key={kind} type="button" class={draft.kind === kind ? 'on' : undefined} aria-pressed={draft.kind === kind} onClick={() => switchKind(kind)}>
              {text}
            </button>
          ))}
        </span>
        <span class="team-hint">
          {draft.kind === 'queue'
            ? 'You add the items, one per line; they go one at a time.'
            : draft.kind === 'schedule'
              ? 'If the Mac sleeps then, the run starts once when it wakes.'
              : 'Checked every 5 minutes with gh, as you; each issue or pull request once.'}
        </span>
      </div>
      {draft.kind === 'schedule' && (
        <div class="broadcast-row">
          <span class="broadcast-label" />
          <span class="auto-days" role="group" aria-label="Days of the week">
            {DAYS.map(({ day, name }) => {
              const on = draft.days.includes(day);
              return (
                <button key={day} type="button" class={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => put({ days: on ? draft.days.filter((one) => one !== day) : [...draft.days, day] })}>
                  {name}
                </button>
              );
            })}
          </span>
          <label class="spawn-option">
            at
            <input class="command-input mono auto-time" type="time" value={draft.time} onInput={(event) => put({ time: (event.target as HTMLInputElement).value })} />
          </label>
        </div>
      )}
      {draft.kind === 'github' && (
        <div class="broadcast-row">
          <span class="broadcast-label" />
          <span class="view-switch" role="group" aria-label="Issues or pull requests">
            <button type="button" class={draft.what === 'issues' ? 'on' : undefined} aria-pressed={draft.what === 'issues'} onClick={() => switchKind('github', 'issues')}>
              issues
            </button>
            <button type="button" class={draft.what === 'prs' ? 'on' : undefined} aria-pressed={draft.what === 'prs'} onClick={() => switchKind('github', 'prs')}>
              pull requests
            </button>
          </span>
          <label class="spawn-option">
            labelled
            <input class="command-input mono" type="text" value={draft.label} maxLength={50} placeholder={draft.what === 'issues' ? 'forchetta' : 'any: only the new ones'} onInput={(event) => put({ label: (event.target as HTMLInputElement).value })} />
          </label>
          <label class="spawn-option">
            of
            <input class="command-input mono" type="text" value={draft.repo} placeholder="the repository of the folder" spellcheck={false} onInput={(event) => put({ repo: (event.target as HTMLInputElement).value })} />
          </label>
        </div>
      )}
      {draft.kind === 'github' && draft.what === 'prs' && !draft.label.trim() && (
        <div class="broadcast-row">
          <span class="broadcast-label" />
          <span class="team-hint crew-stopped">Without a label, every new pull request starts a run, also one from someone you do not know: in a public repository, use a label.</span>
        </div>
      )}
      <div class="broadcast-row top">
        <label class="broadcast-label" for="auto-goal">
          Goal
        </label>
        <textarea
          id="auto-goal"
          class="command-input prompt-input"
          rows={3}
          value={draft.goal}
          placeholder={draft.kind === 'schedule' ? 'What to do each time: "Update the dependencies, run the tests, and open a pull request"' : 'What the lead gets when the team starts'}
          onInput={(event) => put({ goal: (event.target as HTMLTextAreaElement).value })}
        />
      </div>
      <div class="broadcast-row">
        <span class="broadcast-label" />
        <span class="team-hint">
          It can use {fieldList}
          {params.length > 0 ? ` and the parameters of the team (${params.map((param) => `{${param}}`).join(', ')})` : ''}. Each run reads it as a request of yours.
        </span>
      </div>
      {params.length > 0 && (
        <div class="broadcast-row" role="group" aria-label="Values of the parameters">
          <span class="broadcast-label">Values</span>
          {params.map((param) => {
            const declared = template?.params?.find((one) => one.name === param);
            const placeholder = declared?.default ?? (fields.includes(param) ? `{${param}}` : (fields[0] ? `{${fields[0]}}` : 'value'));
            return (
              <label key={param} class="spawn-option" title={declared?.hint ?? `{${param}} in the texts of the team`}>
                {`{${param}}`}
                <input class="command-input mono" type="text" value={draft.values[param] ?? ''} maxLength={VALUE_MAX} placeholder={placeholder} onInput={(event) => put({ values: { ...draft.values, [param]: (event.target as HTMLInputElement).value } })} />
              </label>
            );
          })}
        </div>
      )}
      <div class="broadcast-row">
        <span class="broadcast-label">Each run</span>
        <label class="spawn-option auto-limit" title="Past it, the run stops and the automation pauses: you are told">
          at most $
          <input class="command-input mono auto-number" type="text" inputMode="decimal" value={draft.budget} placeholder="10" onInput={(event) => put({ budget: (event.target as HTMLInputElement).value })} />
        </label>
        <label class="spawn-option auto-limit" title={`From ${AUTO_MINUTES_MIN} to ${AUTO_MINUTES_MAX}; the time it waits for your approval does not count`}>
          and
          <input class="command-input mono auto-number" type="text" inputMode="numeric" value={draft.maxMinutes} placeholder={String(AUTO_MINUTES_DEFAULT)} onInput={(event) => put({ maxMinutes: (event.target as HTMLInputElement).value })} />
          minutes
        </label>
        <label class="spawn-option" title="With /exit, when the session is free; a worktree with work in it stays, with its branch">
          <input type="checkbox" checked={draft.endSessions} onChange={() => put({ endSessions: !draft.endSessions })} />
          its sessions end when it delivers
        </label>
      </div>
      <div class="broadcast-row end">
        <span class={`broadcast-note${error ? ' error' : ''}`}>
          {error ?? 'A run is over when its lead delivers. One that fails (over its budget or its time) stops, and the automation pauses until you look. ⌘↩ saves.'}
        </span>
        <button type="button" class="primary" disabled={busy || !draft.name.trim() || !draft.template || !draft.cwd.trim()} onClick={save}>
          {busy ? 'Saving…' : auto ? 'Save' : 'Create'}
        </button>
        <button type="button" class="quiet" onClick={() => onDone(auto?.id)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ItemLine({ auto, item, crews, agents, store, onTeam }: { auto: AutomationView; item: AutoItem; crews: readonly CrewSummary[]; agents: ReadonlyMap<string, Agent>; store: Store; onTeam: (crewId: string) => void }) {
  const crew = item.crewId ? crews.find((one) => one.id === item.crewId) : undefined;
  const now = Date.now();
  const mark = item.status === 'running' ? '▶' : item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : item.status === 'cancelled' ? '○' : '·';
  const usd = item.status === 'running' ? (liveCost(crew, agents) ?? item.usd) : item.usd;
  const detail = [
    item.status === 'running' && item.startedAt ? `for ${minutes(now - item.startedAt - (item.approvalMs ?? 0))}` : '',
    item.status !== 'waiting' && item.status !== 'running' && item.endedAt ? clock(item.endedAt) : '',
    item.status !== 'waiting' && item.status !== 'running' && item.startedAt && item.endedAt ? minutes(item.endedAt - item.startedAt - (item.approvalMs ?? 0)) : '',
    usd ? `≈ ${usdText(usd)}${item.status === 'running' ? ` of ${usdText(auto.budgetUsd)}` : ''}` : '',
    item.status === 'waiting' ? `added ${clock(item.addedAt)}${item.source === 'github' ? ' from GitHub' : item.source === 'schedule' ? ' by the schedule' : ''}` : '',
  ].filter(Boolean);
  const said = item.delivered?.where ?? item.note;
  // A run over whose sessions were kept (by choice, or because it failed), still open: they can end from here.
  const live = item.closing === 'kept' && item.status !== 'running' && item.status !== 'waiting' && !!crew && !crew.endedAt && (crew.recipients ?? []).some((recipient) => recipient.agentId && agents.get(recipient.agentId) && agents.get(recipient.agentId)!.state !== 'ended');
  return (
    <li class="auto-item" data-status={item.status}>
      <span class="auto-mark" aria-hidden="true">
        {mark}
      </span>
      <span class="auto-item-text">
        <span class="auto-item-label" title={item.delivered?.summary ?? item.label}>
          {item.label}
        </span>
        {detail.length > 0 && <span class="team-hint"> · {detail.join(' · ')}</span>}
        {said && <span class={`auto-item-note${item.status === 'failed' ? ' error' : ''}`}>{said}</span>}
        {item.closing === 'asked' && <span class="team-hint auto-item-note">its sessions are ending (/exit)</span>}
        {live && <span class="team-hint auto-item-note">{item.status === 'done' ? 'Its team goes on: write to it from its panel.' : 'Nothing more goes to its sessions: they stay for you to look at.'}</span>}
      </span>
      {live && (
        <button type="button" class="quiet" title="/exit in each of its sessions, when it is free; a worktree with work in it stays" onClick={() => store.autoAction(auto.id, 'close', { itemId: item.id })}>
          end sessions
        </button>
      )}
      {crew && (
        <button type="button" class="quiet" title="The thread of its team" onClick={() => onTeam(crew.id)}>
          team
        </button>
      )}
      {item.status === 'waiting' && (
        <button type="button" class="quiet" aria-label={`Take ${item.label} out of the queue`} title="Take it out of the queue" onClick={() => store.autoAction(auto.id, 'cancel', { itemId: item.id })}>
          ×
        </button>
      )}
      {(item.status === 'failed' || item.status === 'cancelled') && (
        <button type="button" class="quiet" title="Put it in the queue again" onClick={() => store.autoAction(auto.id, 'retry', { itemId: item.id })}>
          again
        </button>
      )}
    </li>
  );
}

function AutoView({ auto, agents, store, onEdit, onTeam }: { auto: AutomationView; agents: readonly Agent[]; store: Store; onEdit: () => void; onTeam: (crewId: string) => void }) {
  const [items, setItems] = useState('');
  const [confirm, setConfirm] = useState<'stop' | 'delete' | undefined>(undefined);
  const edit = store.state.autoEdit;
  const busy = edit?.busy === true && edit.id === auto.id;
  const agentMap = store.state.agents;
  const running = auto.items.find((item) => item.status === 'running');
  const waiting = auto.items.filter((item) => item.status === 'waiting');
  const over = auto.items.filter((item) => item.status !== 'waiting' && item.status !== 'running').reverse();
  const added = edit?.action === 'add' && !edit.busy && edit.id === auto.id && edit.ok ? edit.added : undefined;
  useEffect(() => {
    if (added) setItems('');
  }, [edit?.at]);
  useEffect(() => setConfirm(undefined), [auto.id]);
  const error = edit && !edit.busy && edit.id === auto.id && !edit.ok ? edit.error : undefined;
  void agents;
  return (
    <div class="auto-view">
      <div class="broadcast-row">
        <span class="broadcast-label">Runs</span>
        <span class="auto-summary">
          <strong>{auto.template}</strong> in <span class="mono" title={auto.cwd}>{lastPart(auto.cwd)}</span> · {triggerText(auto.trigger)}
          {auto.poll?.repo ? ` · ${auto.poll.repo}` : ''}
        </span>
        <span class="team-hint">
          at most {usdText(auto.budgetUsd)} and {auto.maxMinutes} min each{auto.endSessions ? ', sessions end when it delivers' : ''}
        </span>
      </div>
      <div class="broadcast-row">
        <span class="broadcast-label" />
        <span class={`auto-status${auto.paused ? ' paused' : ''}`}>
          {auto.paused
            ? `Paused: ${auto.paused.reason}`
            : running
              ? `At work: ${running.label}`
              : auto.wait
                ? `Next: ${waiting[0]?.label ?? ''} · ${auto.wait}`
                : waiting.length > 0
                  ? `Next: ${waiting[0]!.label}, in a moment`
                  : auto.nextAt
                    ? `Next run ${clock(auto.nextAt)}`
                    : auto.trigger.kind === 'queue'
                      ? 'The queue is empty: add items below.'
                      : auto.trigger.kind === 'github'
                        ? auto.poll?.error
                          ? `GitHub: ${auto.poll.error}`
                          : auto.poll
                            ? `Nothing new on GitHub (looked ${clock(auto.poll.at)}).`
                            : 'Looking at GitHub…'
                        : 'Nothing to do now.'}
        </span>
        {auto.trigger.kind === 'github' && auto.poll?.error && (auto.paused || running || waiting.length > 0) && <span class="auto-item-note error">GitHub: {auto.poll.error}</span>}
      </div>
      <div class="broadcast-row">
        <span class="broadcast-label" />
        {auto.paused ? (
          <button type="button" class="primary" disabled={busy} onClick={() => store.autoAction(auto.id, 'resume')}>
            Resume
          </button>
        ) : (
          <button type="button" disabled={busy} title="Nothing new starts; the run at work goes on" onClick={() => store.autoAction(auto.id, 'pause')}>
            Pause
          </button>
        )}
        {running &&
          (confirm === 'stop' ? (
            <>
              <span class="team-hint">its team stops, its sessions end, the automation pauses</span>
              <button
                type="button"
                class="danger"
                onClick={() => {
                  setConfirm(undefined);
                  store.autoAction(auto.id, 'stop');
                }}
              >
                Stop the run
              </button>
              <button type="button" class="quiet" onClick={() => setConfirm(undefined)}>
                keep it
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirm('stop')}>
              Stop the run…
            </button>
          ))}
        {auto.trigger.kind === 'schedule' && (
          <button type="button" disabled={busy} title="A run now, in the queue, besides those of the schedule" onClick={() => store.autoAction(auto.id, 'add')}>
            Run now
          </button>
        )}
        {auto.trigger.kind === 'github' && (
          <button type="button" disabled={busy || !!auto.paused} title={auto.paused ? 'Resume it first' : 'Look at GitHub now, not in 5 minutes'} onClick={() => store.autoAction(auto.id, 'add')}>
            Look at GitHub now
          </button>
        )}
        <button type="button" class="quiet" onClick={onEdit}>
          Edit
        </button>
        {confirm === 'delete' ? (
          <>
            <button
              type="button"
              class="danger"
              onClick={() => {
                setConfirm(undefined);
                store.deleteAutomation(auto.id);
              }}
            >
              Delete it
            </button>
            <button type="button" class="quiet" onClick={() => setConfirm(undefined)}>
              keep it
            </button>
          </>
        ) : (
          <button type="button" class="quiet" disabled={!!running} title={running ? 'A run is at work: stop it first' : 'Delete the automation (its last runs go with it)'} onClick={() => setConfirm('delete')}>
            Delete…
          </button>
        )}
      </div>
      {auto.trigger.kind === 'queue' && (
        <div class="broadcast-row top">
          <label class="broadcast-label" for="auto-items">
            Add
          </label>
          <textarea
            id="auto-items"
            class="command-input prompt-input"
            rows={2}
            value={items}
            placeholder={'One item per line: each is {item} of one run\nAPP-42'}
            onInput={(event) => setItems((event.target as HTMLTextAreaElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && items.trim()) store.autoAction(auto.id, 'add', { text: items });
            }}
          />
          <button type="button" class="primary" disabled={busy || !items.trim()} onClick={() => store.autoAction(auto.id, 'add', { text: items })}>
            Add to the queue
          </button>
        </div>
      )}
      {error && <p class="broadcast-note error auto-error">{error}</p>}
      {(running || waiting.length > 0 || over.length > 0) && (
        <ol class="auto-list" aria-label="Runs: the one at work, the queue, the last ones">
          {running && <ItemLine auto={auto} item={running} crews={store.state.crews} agents={agentMap} store={store} onTeam={onTeam} />}
          {waiting.map((item) => (
            <ItemLine key={item.id} auto={auto} item={item} crews={store.state.crews} agents={agentMap} store={store} onTeam={onTeam} />
          ))}
          {over.map((item) => (
            <ItemLine key={item.id} auto={auto} item={item} crews={store.state.crews} agents={agentMap} store={store} onTeam={onTeam} />
          ))}
        </ol>
      )}
    </div>
  );
}

export function AutoPanel({ agents, store, onClose, onTeam, startNew = false }: { agents: readonly Agent[]; store: Store; onClose: () => void; onTeam: (crewId: string) => void; startNew?: boolean }) {
  const automations = store.state.automations;
  const [chosen, setChosen] = useState<string | undefined>(automations[0]?.id);
  const [editing, setEditing] = useState<'new' | 'edit' | undefined>(startNew || automations.length === 0 ? 'new' : undefined);
  const panel = useRef<HTMLElement>(null);
  useReturnFocus(panel);
  const auto = automations.find((one) => one.id === chosen) ?? automations[0];
  // Deleted: the panel goes to another one, or to the form when none is left.
  const edit = store.state.autoEdit;
  useEffect(() => {
    if (edit?.action === 'delete' && edit.ok && !edit.busy) {
      setChosen(undefined);
      if (store.state.automations.length === 0) setEditing('new');
    }
  }, [edit?.at]);
  return (
    <section ref={panel} class="broadcast auto-panel" aria-label="Teams that start by themselves" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <div class="broadcast-row">
        <span class="broadcast-label">Auto</span>
        {automations.map((one) => {
          const state = stateMark(one);
          const on = editing !== 'new' && one.id === auto?.id;
          return (
            <button
              key={one.id}
              type="button"
              class={`chip${on ? ' on' : ''}${one.paused ? ' paused' : ''}`}
              title={state.title}
              aria-pressed={on}
              onClick={() => {
                setChosen(one.id);
                setEditing(undefined);
              }}
            >
              {state.mark ? <span class="auto-chip-mark">{state.mark} </span> : null}
              {one.name}
            </button>
          );
        })}
        <button type="button" class={`chip${editing === 'new' ? ' on' : ''}`} title="A team that starts by itself: from a queue, at a time, from GitHub" onClick={() => setEditing('new')}>
          + new automatic team
        </button>
      </div>
      {editing === 'new' ? (
        <AutoForm
          key="new"
          agents={agents}
          store={store}
          onDone={(id) => {
            if (id) setChosen(id);
            setEditing(undefined);
            if (!id && automations.length === 0) onClose();
          }}
        />
      ) : auto && editing === 'edit' ? (
        <AutoForm
          key={auto.id}
          auto={auto}
          agents={agents}
          store={store}
          onDone={() => setEditing(undefined)}
        />
      ) : auto ? (
        <AutoView auto={auto} agents={agents} store={store} onEdit={() => setEditing('edit')} onTeam={onTeam} />
      ) : null}
    </section>
  );
}
