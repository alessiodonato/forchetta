import { useEffect, useRef, useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import { agoShort } from '../shared/present.ts';
import { OUTCOME_TEXT, type ScheduledTask } from '../shared/scheduled.ts';
import { useReturnFocus } from './focus.ts';
import { lastPart, recentFolders } from './NewSession.tsx';
import { canOpen, type Store } from './store.ts';

// The scheduled tasks of the Claude desktop app (shared/scheduled.ts): what they do, the last run Forchetta saw, and their
// instructions started now as a session here.

function LastRun({ task, agents, store, now }: { task: ScheduledTask; agents: readonly Agent[]; store: Store; now: number }) {
  const run = task.lastRun;
  if (!run) return <p class="setup-detail">No run seen by Forchetta yet.</p>;
  const session = agents.find((agent) => agent.id === run.agentId);
  return (
    <p class="setup-detail">
      Last run {agoShort(Math.max(0, now - run.at))} ago{run.by === 'app' ? ', by the Claude app' : ', from here'}
      {run.cwd ? (
        <>
          , in <span title={run.cwd}>{lastPart(run.cwd)}</span>
        </>
      ) : null}
      : {OUTCOME_TEXT[run.outcome]}.{' '}
      {session && canOpen(session) && (
        <button type="button" class="link" onClick={() => store.open(session.id)}>
          open its session
        </button>
      )}
    </p>
  );
}

function Task({ task, agents, store, now }: { task: ScheduledTask; agents: readonly Agent[]; store: Store; now: number }) {
  const [reading, setReading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [folder, setFolder] = useState(task.lastRun?.cwd ?? recentFolders(agents)[0] ?? '');
  const spawn = store.state.spawn;
  const busy = spawn?.busy === true;
  useEffect(() => {
    if (!starting) return;
    window.forchettaFolder = (path: string) => setFolder(path);
    return () => {
      window.forchettaFolder = undefined;
    };
  }, [starting]);
  const start = (): void => {
    if (!busy && folder.trim()) store.runScheduled(task.id, folder.trim());
  };
  return (
    <li class="scheduled-task">
      <div class="broadcast-row">
        <strong class="scheduled-name">{task.name}</strong>
        <span class="grow" />
        <button type="button" class="quiet" aria-expanded={reading} onClick={() => setReading(!reading)}>
          {reading ? 'Hide the instructions' : 'Instructions'}
        </button>
        <button type="button" disabled={task.long} title={task.long ? 'Its instructions are too long for a first prompt: start it from the Claude app' : 'Its instructions as a new session, here'} aria-expanded={starting} onClick={() => setStarting(!starting)}>
          Run now…
        </button>
      </div>
      {task.description && <p class="scheduled-about">{task.description}</p>}
      <LastRun task={task} agents={agents} store={store} now={now} />
      {reading && <pre class="scheduled-text">{task.instructions}{task.cut ? '\n…' : ''}</pre>}
      {starting && (
        <div class="broadcast-row">
          <label class="broadcast-label" for={`scheduled-${task.id}`}>
            Folder
          </label>
          <input
            id={`scheduled-${task.id}`}
            class="command-input mono"
            type="text"
            value={folder}
            placeholder="~/projects/app"
            spellcheck={false}
            onInput={(event) => setFolder((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => event.key === 'Enter' && start()}
          />
          <button type="button" onClick={() => store.chooseFolder(folder)}>
            Choose…
          </button>
          <button type="button" class="primary" disabled={busy || !folder.trim()} onClick={start}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      )}
      {starting && spawn?.error && (
        <p class="broadcast-note error" role="alert">
          {spawn.error}
        </p>
      )}
    </li>
  );
}

export function ScheduledPanel({ agents, store, now, onClose }: { agents: readonly Agent[]; store: Store; now: number; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  useReturnFocus(panel);
  // Their folder may have changed since the page opened.
  useEffect(() => store.refreshScheduled(), []);
  const tasks = store.state.scheduled ?? [];
  return (
    <section ref={panel} class="broadcast scheduled" aria-label="Scheduled tasks" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      {tasks.length === 0 ? <p class="broadcast-note">No scheduled task of the Claude app on this computer.</p> : null}
      <ul class="scheduled-list">
        {tasks.map((task) => (
          <Task key={task.id} task={task} agents={agents} store={store} now={now} />
        ))}
      </ul>
      <div class="broadcast-row end">
        <span class="broadcast-note">When they start is set in the Claude app, which keeps it to itself. “Run now” starts the instructions here, as a session of yours, with your own permissions.</span>
        <button type="button" class="quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
