import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { useMotionAnchor } from './anchor.ts';
import { type Agent, displayName, type Subagent, type SubagentStep } from '../shared/agent.ts';
import { durationText, modelShort, shownSubagents, subagentActive, subagentDetail, subagentKey, subagentTime, WAITING_TEXT } from '../shared/present.ts';
import { ToolIcon } from './icons.tsx';
import type { Store } from './store.ts';

// The subagents a session starts with the Agent tool: under its box while they work and for a few minutes after,
// and in a panel with their transcript. Read only: a subagent runs inside the process of its session, with no
// terminal of its own.

const MARK: Record<Subagent['state'], string> = { running: '●', waiting: '◷', done: '✓', failed: '✕', stopped: '■' };

/** How many subagents the box lists before "+N more". */
const ROWS = 3;

const STATE_TEXT: Record<Subagent['state'], string> = { running: 'at work', waiting: 'waiting', done: 'done', failed: 'failed', stopped: 'stopped' };

/** Foreground or background, once Claude Code said it: a call that asks nothing may still go to the background. */
const shapeText = (subagent: Subagent): string | undefined => (subagent.background === undefined ? undefined : subagent.background ? 'background' : 'foreground');

/** Everything known of a subagent, for its tooltip. */
function subagentTitle(subagent: Subagent): string {
  return [
    `${subagent.type}${subagent.description ? `: ${subagent.description}` : ''}`,
    [modelShort(subagent.model), shapeText(subagent), subagent.state === 'waiting' ? WAITING_TEXT : undefined, subagent.isolation === 'worktree' ? 'in its own worktree' : undefined, subagent.by ? `started by ${subagent.by}` : undefined]
      .filter(Boolean)
      .join(' · '),
    subagent.prompt ? `\n${subagent.prompt.length > 400 ? `${subagent.prompt.slice(0, 399)}…` : subagent.prompt}` : '',
    '\nClick to read what it does.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The subagents under the box of their session: those at work, then those just ended. */
export function SubagentRows({ agent, now, store }: { agent: Agent; now: number; store: Store }) {
  const shown = shownSubagents(agent, now);
  if (shown.length === 0) return null;
  const rows = shown.slice(0, ROWS);
  const more = shown.length - rows.length;
  return (
    <div class="subagents" aria-label="Subagents">
      {rows.map((subagent) => (
        <button
          type="button"
          class="subagent"
          data-state={subagent.state}
          key={subagentKey(subagent)}
          title={subagentTitle(subagent)}
          onClick={(event) => {
            event.stopPropagation();
            store.showSubagents(agent.id, subagentKey(subagent));
          }}
        >
          <span class="subagent-mark" aria-label={STATE_TEXT[subagent.state]}>
            {MARK[subagent.state]}
          </span>
          <span class="subagent-type">{subagent.type}</span>
          <span class="subagent-desc">{subagent.description ?? ''}</span>
          <span class="subagent-time">{subagentTime(subagent, now)}</span>
          {subagentActive(subagent) && <span class="subagent-detail">{subagentDetail(subagent)}</span>}
        </button>
      ))}
      {more > 0 && (
        <button
          type="button"
          class="subagents-more"
          onClick={(event) => {
            event.stopPropagation();
            store.showSubagents(agent.id);
          }}
        >
          +{more} more
        </button>
      )}
    </div>
  );
}

/**
 * "2 subagents" in the box and in the header of a pane: opens their panel. While one of them works, the button
 * pulses as a box at work does, a little quicker (ambient.ts carries the pulse on after its first cycles).
 */
export function SubagentsButton({ agent, store, className }: { agent: Agent; store: Store; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const working = agent.subagents?.some((subagent) => subagent.state === 'running') ?? false;
  const since = useMotionAnchor(ref, working ? 'working' : 'still');
  const count = agent.subagents?.length ?? 0;
  if (count === 0) return null;
  const running = agent.subagents!.filter(subagentActive).length;
  return (
    <button
      ref={ref}
      type="button"
      class={className ?? 'files-button'}
      data-working={working ? '' : undefined}
      data-since={working ? since : undefined}
      title={running > 0 ? `${running} at work or waiting: what the subagents of this session do` : 'What the subagents of this session did'}
      onClick={(event) => {
        event.stopPropagation();
        store.showSubagents(agent.id);
      }}
    >
      {working && <span class="subagents-pulse" aria-hidden="true" />}
      {count} {count === 1 ? 'subagent' : 'subagents'}
    </button>
  );
}

/** For the column of compact boxes: "↳ 2" while subagents work or wait, with what they are in the tooltip. */
export function runningSubagentsTag(agent: Agent): { text: string; title: string } | undefined {
  const running = (agent.subagents ?? []).filter(subagentActive);
  if (running.length === 0) return undefined;
  return {
    text: `↳ ${running.length}`,
    title: running.map((subagent) => `${subagent.type}${subagent.description ? `: ${subagent.description}` : ''} · ${subagent.state === 'waiting' ? WAITING_TEXT : (subagent.action?.label ?? 'thinking…')}`).join('\n'),
  };
}

function Step({ step }: { step: SubagentStep }) {
  switch (step.kind) {
    case 'prompt':
    case 'message':
      return (
        <section class="sub-step sub-task">
          <p class="sub-step-head">{step.kind === 'prompt' ? 'Task from the session' : 'Message from the session'}</p>
          <p class="sub-text">{step.text}</p>
        </section>
      );
    case 'report':
      return (
        <section class="sub-step sub-report">
          <p class="sub-step-head">Report to the session</p>
          <p class="sub-text">{step.text}</p>
        </section>
      );
    case 'text':
      return <p class="sub-step sub-text">{step.text}</p>;
    case 'notice':
      return (
        <p class="sub-step sub-notice" title="A notice of Claude Code to the subagent, not a message of the session">
          ◷ {step.text}
        </p>
      );
    case 'tool':
      return (
        <div class={`sub-step sub-tool${step.error ? ' failed' : ''}`}>
          <span class="icon">
            <ToolIcon family={step.family} />
          </span>
          <span class="sub-tool-label" title={step.label}>
            {step.label}
          </span>
          {step.result && (
            <span class="sub-tool-result" title={step.result}>
              {step.error ? 'error: ' : ''}
              {step.result}
            </span>
          )}
        </div>
      );
  }
}

/** The chosen subagent: what it was started with, then its transcript, the newest step at the bottom. */
function SubagentDetail({ agent, subagent, store, now }: { agent: Agent; subagent: Subagent; store: Store; now: number }) {
  const panel = store.state.subagents;
  const key = subagentKey(subagent);
  const thread = panel?.thread?.key === key ? panel.thread : undefined;
  const body = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Read again as it works: a new call, its end.
  useEffect(() => {
    store.readSubagent(agent.id, key);
  }, [agent.id, key, subagent.tools, subagent.state, subagent.action?.at]);

  // The newest step stays in sight, unless you scrolled up to read.
  useLayoutEffect(() => {
    const element = body.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [thread]);

  const model = modelShort(subagent.model ?? thread?.model);
  const facts = [
    subagent.state === 'running' ? `at work · ${subagentTime(subagent, now)}` : subagent.state === 'waiting' ? `waiting · started ${subagentTime({ ...subagent, state: 'running' }, now)} ago` : subagentTime(subagent, now),
    model,
    shapeText(subagent),
    subagent.isolation === 'worktree' ? 'own worktree' : undefined,
    subagent.by ? `started by ${subagent.by}` : undefined,
    subagent.tools ? `${subagent.tools} tool ${subagent.tools === 1 ? 'call' : 'calls'}` : undefined,
    subagent.tokens ? `${subagent.tokens.toLocaleString('en-US')} tokens` : undefined,
  ].filter(Boolean);

  return (
    <div class="sub-detail">
      <header class="sub-detail-head" data-state={subagent.state}>
        <p class="sub-detail-title">
          <span class="subagent-mark">{MARK[subagent.state]}</span>
          <strong>{subagent.type}</strong>
          {subagent.description ? <span> · {subagent.description}</span> : null}
        </p>
        <p class="sub-facts">{facts.join(' · ')}</p>
        {subagent.state === 'running' && <p class="sub-now">{subagent.action ? `now: ${subagent.action.label}` : 'thinking…'}</p>}
        {subagent.state === 'waiting' && <p class="sub-now">{`It stopped and ${WAITING_TEXT}: Claude Code starts it again when that ends.`}</p>}
        {subagent.error && <p class="sub-error">{subagent.error}</p>}
      </header>
      <div
        class="sub-thread"
        ref={body}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        {thread === undefined ? (
          <p class="files-note">Reading the transcript…</p>
        ) : (
          <>
            {thread.skipped ? <p class="files-note">{thread.skipped} earlier steps left out.</p> : null}
            {thread.steps.map((step, index) => (
              <Step key={index} step={step} />
            ))}
            {thread.note && <p class="files-note">{thread.note}</p>}
            {thread.steps.length === 0 && !thread.note && <p class="files-note">Nothing in its transcript yet.</p>}
          </>
        )}
      </div>
    </div>
  );
}

export function SubagentsPanel({ store, now }: { store: Store; now: number }) {
  const panel = store.state.subagents;
  const agent = panel ? store.state.agents.get(panel.agentId) : undefined;
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') store.closeSubagents();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel !== undefined]);
  if (!panel) return null;
  // The newest first: the one just started is at the top.
  const list = [...(agent?.subagents ?? [])].reverse();
  const current = list.find((subagent) => subagentKey(subagent) === panel.key);
  return (
    <div class="files-backdrop" onClick={() => store.closeSubagents()}>
      <section class="files subagents-panel" aria-label="Subagents of the session" onClick={(event) => event.stopPropagation()}>
        <header class="files-head">
          <span class="files-title">
            Subagents of <strong>{agent ? displayName(agent) : '?'}</strong>
          </span>
          <span class="files-sub">read only: they run inside the session, with no terminal of their own</span>
          <button type="button" class="files-close" title="Close (Esc)" onClick={() => store.closeSubagents()}>
            ✕
          </button>
        </header>
        {list.length === 0 ? (
          <p class="files-note">This session started no subagent, or Forchetta no longer keeps them.</p>
        ) : (
          <div class="files-body">
            <ul class="files-list subagents-list">
              {list.map((subagent) => {
                const key = subagentKey(subagent);
                return (
                  <li key={key}>
                    <button type="button" class={key === panel.key ? 'on' : undefined} data-state={subagent.state} title={subagentTitle(subagent)} onClick={() => store.selectSubagent(key)}>
                      <span class="subagent-mark">{MARK[subagent.state]}</span>
                      <span class="files-name">
                        <span class="subagent-type">{subagent.type}</span> {subagent.description ?? ''}
                      </span>
                      <span class="files-when">{subagentActive(subagent) ? subagentTime(subagent, now) : subagent.endedAt !== undefined ? durationText(subagent.endedAt - subagent.startedAt) : STATE_TEXT[subagent.state]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {current && agent ? <SubagentDetail key={panel.key} agent={agent} subagent={current} store={store} now={now} /> : <p class="files-note">Choose a subagent on the left.</p>}
          </div>
        )}
      </section>
    </div>
  );
}
