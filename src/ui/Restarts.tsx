import { useState } from 'preact/hooks';
import { type Agent, displayName } from '../shared/agent.ts';
import { type RestartView, type RestartWhen, restartView } from '../shared/restarts.ts';
import { restartsLater, setRestartsLater } from './prefs.ts';
import type { Store } from './store.ts';
import { keyText } from './platform.ts';

// The sessions on an older Claude Code than the one installed (shared/restarts.ts): a line under the top one with how
// many, "Restart the N at rest", a list to choose from, or not now, until the next version. A restart keeps the
// conversation and everything of the session: Claude Code does it itself (/restart), or says why not.

const ORDER: RestartWhen[] = ['ready', 'warm', 'later', 'never'];
/** How long how the last ones went stays in the line. */
const RECENT_MS = 60_000;

const count = (n: number): string => `${n} ${n === 1 ? 'session' : 'sessions'}`;
const atRest = (view: RestartView): boolean => view.when === 'ready' || view.when === 'warm';

/** Why a session is not restarted now: what Claude Code answered for this version, or what it is doing. */
export function whyNot(agent: Agent, view: RestartView, installed: string): string | undefined {
  if (agent.restartRefused?.version === installed) return `Claude Code: ${agent.restartRefused.reason}`;
  return view.reason;
}

function Row({ agent, view, installed, restarting, store }: { agent: Agent; view: RestartView; installed: string; restarting: boolean; store: Store }) {
  const reason = whyNot(agent, view, installed);
  return (
    <li class="reopen-row">
      <strong>{displayName(agent)}</strong>
      <span class="team-hint">{agent.version}</span>
      {reason && (
        <span class={`team-hint restart-why${view.when === 'warm' ? ' reopen-large' : ''}`} title={reason}>
          · {reason}
        </span>
      )}
      <span class="grow" />
      <button type="button" class="quiet" disabled={restarting || !atRest(view)} title={atRest(view) ? 'It goes on with its conversation, on the Claude Code installed' : reason} onClick={() => store.restart([agent.id])}>
        {restarting ? 'restarting…' : 'restart'}
      </button>
    </li>
  );
}

export function RestartNotice({ agents, store }: { agents: readonly Agent[]; store: Store }) {
  const [choosing, setChoosing] = useState(false);
  const [later, setLater] = useState(restartsLater);
  const info = store.state.restarts;
  const installed = store.state.system?.claude.installed;
  if (!info || !installed) return null;
  const now = Date.now();
  const rows = agents.flatMap((agent) => {
    const view = restartView(agent, installed, now);
    return view ? [{ agent, view }] : [];
  });
  // Those that can restart now come first.
  rows.sort((a, b) => ORDER.indexOf(a.view.when) - ORDER.indexOf(b.view.when));
  const { paused } = info;
  const running = info.running && !info.running.auto ? info.running : undefined;
  const recent = info.last && now - info.last.at < RECENT_MS && info.last.done.length + info.last.failed.length > 0 ? info.last : undefined;
  const offered = rows.length > 0 && !info.auto && later !== installed;
  if (!paused && !running && !recent && !offered) return null;
  const ready = rows.filter(({ view }) => atRest(view));
  const warm = ready.filter(({ view }) => view.when === 'warm');
  const agent = running && agents.find((one) => one.id === running.agentId);
  return (
    <section class="notice reopen-notice" role="status" aria-label="Sessions on an older Claude Code">
      <div class="reopen-head">
        {paused ? (
          <span class="reopen-failed">
            Restarts stopped at {paused.name}: {paused.reason}. {paused.waiting > 0 ? `${count(paused.waiting)} still to restart.` : ''}
          </span>
        ) : running ? (
          <span>
            Restarting {agent ? displayName(agent) : 'a session'} on Claude Code {installed}
            {running.done > 0 ? `, ${running.done} done` : ''}
            {running.next > 0 ? `, ${running.next} to go` : ''}…
          </span>
        ) : offered ? (
          <span>
            Claude Code {installed} is installed: {count(rows.length)} {rows.length === 1 ? 'runs' : 'run'} an older one.
          </span>
        ) : (
          <span />
        )}
        {recent && !running && !paused && (
          <span class={recent.failed.length ? 'reopen-failed' : 'reopen-done'}>
            {recent.done.length ? `${recent.done.length} restarted` : ''}
            {recent.done.length && recent.failed.length ? '; ' : ''}
            {recent.failed.length ? `not restarted: ${recent.failed.map((one) => `${one.name} (${one.reason})`).join('; ')}` : ''}
          </span>
        )}
        <span class="grow" />
        {paused ? (
          <>
            <button type="button" class="primary" title={`Look at the terminal of ${paused.name} first`} onClick={() => store.restartsGoOn(true)}>
              Go on
            </button>
            {paused.waiting > 0 && (
              <button type="button" class="quiet" title="The others stay on their version" onClick={() => store.restartsGoOn(false)}>
                Leave the others
              </button>
            )}
          </>
        ) : (
          offered &&
          !running && (
            <>
              <button
                type="button"
                class="primary"
                disabled={ready.length === 0}
                title={
                  ready.length === 0
                    ? 'None of them is at rest now'
                    : `One after the other, each on its conversation: ${ready.map(({ agent: one }) => displayName(one)).join(', ')}.${warm.length ? ` The prompt cache of ${count(warm.length)} is still warm: after the restart, the next message may read the whole conversation again.` : ''}`
                }
                onClick={() => store.restart(ready.map(({ agent: one }) => one.id))}
              >
                {ready.length === 0 ? 'Restart' : ready.length === 1 ? 'Restart the one at rest' : `Restart the ${ready.length} at rest`}
              </button>
              <button type="button" class={`quiet${choosing ? ' on' : ''}`} aria-expanded={choosing} onClick={() => setChoosing(!choosing)}>
                Choose…
              </button>
              <button
                type="button"
                class="quiet"
                title={keyText('Offered again with the next version. In Settings (⌘,) the sessions can restart by themselves')}
                onClick={() => {
                  setRestartsLater(installed);
                  setLater(installed);
                }}
              >
                Not now
              </button>
            </>
          )
        )}
      </div>
      {choosing && offered && !paused && (
        <ul class="reopen-list">
          {rows.map(({ agent: one, view }) => (
            <Row key={one.id} agent={one} view={view} installed={installed} restarting={info.running?.agentId === one.id} store={store} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** In the box of a session that stays on an older Claude Code until you do something about it: its version, and why. */
export function OldVersionTag({ agent, store, now }: { agent: Agent; store: Store; now: number }) {
  const installed = store.state.restarts && store.state.system?.claude.installed;
  if (!installed) return null;
  const view = restartView(agent, installed, now);
  if (!view || agent.control.kind !== 'tmux' || (view.when !== 'never' && agent.restartRefused?.version !== installed)) return null;
  return (
    <span class="tag" title={`On Claude Code ${agent.version}, while ${installed} is installed. ${whyNot(agent, view, installed) ?? ''}`}>
      {agent.version}
    </span>
  );
}
