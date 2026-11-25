import { useEffect, useRef, useState } from 'preact/hooks';
import { type Agent, displayName } from '../shared/agent.ts';
import type { ShellInfo } from '../shared/shells.ts';
import { useReturnFocus } from './focus.ts';
import type { Store } from './store.ts';
import { ColorDot } from './Team.tsx';
import { type TerminalStatus, TerminalView } from './TerminalView.tsx';

// The plain terminals (daemon/shells.ts): a shell in the folder of a session, in a pane next to the sessions. It ends with
// its pane, as a window of a terminal does; when something runs in it, the pane asks first.

interface PaneProps {
  shell: ShellInfo;
  area: string;
  focusKey: number;
  store: Store;
  onUse: (id: string) => void;
}

export function ShellPane({ shell, area, focusKey, store, onUse }: PaneProps) {
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const opened = useRef(Date.now());
  const running = store.state.shellBusy?.id === shell.id ? store.state.shellBusy.running : undefined;
  // `exit` closes its pane; a shell that ended as soon as it started stays, to show why.
  useEffect(() => {
    if (status === 'ended' && Date.now() - opened.current > 1500) store.shellGone(shell.id);
  }, [status]);
  return (
    <section class="pane pane-shell" data-id={shell.id} style={{ gridArea: area }}>
      <header class="pane-head">
        <div class="pane-head-main pane-head-plain">
          <span class="pane-project" title={shell.cwd}>
            {shell.name}
          </span>
          <span class="pane-state">{shell.label}</span>
          <span class="pane-activity" title={shell.cwd}>
            a plain terminal, no Claude in it
          </span>
        </div>
        <button class="pane-close" type="button" title="Close the terminal: what runs in it ends" aria-label="Close the terminal" onClick={() => store.closeShell(shell.id)}>
          ✕
        </button>
      </header>
      {running && (
        <p class="pane-scrolled" role="alert">
          <span>
            <strong>{running}</strong> is running here: it ends with the terminal.
          </span>
          <button type="button" class="link" onClick={() => store.closeShell(shell.id, true)}>
            close it
          </button>
          <button type="button" class="link" onClick={() => store.keepShell()}>
            keep it
          </button>
        </p>
      )}
      <div class="pane-body">
        <TerminalView shell agentId={shell.id} focusKey={focusKey} onUse={() => onUse(shell.id)} onStatus={setStatus} />
        {status === 'ended' && <p class="pane-note">The shell ended.</p>}
        {status === 'lost' && <p class="pane-note">Lost the connection to the daemon: if it restarted, this shell ended with it.</p>}
      </div>
    </section>
  );
}

/** "+ new › terminal": in the folder of which session. */
export function ShellPanel({ agents, store, onClose }: { agents: readonly Agent[]; store: Store; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  useReturnFocus(panel);
  const kinds = store.state.shellKinds ?? [];
  const [kind, setKind] = useState(kinds[0]?.id);
  const error = store.state.shellError;
  // One for each folder: the session of it that was used last.
  const seen = new Set<string>();
  const folders = [...agents]
    .sort((a, b) => b.lastEvent.at - a.lastEvent.at)
    .filter((agent) => agent.cwd && !seen.has(agent.cwd) && seen.add(agent.cwd));
  useEffect(() => {
    (panel.current?.querySelector('button.chip-folder') as HTMLElement | null)?.focus();
  }, []);
  return (
    <section ref={panel} class="broadcast" aria-label="A plain terminal" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      {kinds.length > 1 && (
        <div class="broadcast-row">
          <span class="broadcast-label">With</span>
          {kinds.map((one) => (
            <button key={one.id} type="button" class={`chip${kind === one.id ? ' on' : ''}`} aria-pressed={kind === one.id} onClick={() => setKind(one.id)}>
              {one.label}
            </button>
          ))}
        </div>
      )}
      <div class="broadcast-row">
        <span class="broadcast-label">In</span>
        {folders.length === 0 && <span class="broadcast-note">No session yet: a plain terminal opens in the folder of one.</span>}
        {folders.map((agent) => (
          <button
            key={agent.id}
            type="button"
            class="chip chip-folder"
            title={agent.cwd}
            onClick={() => {
              store.openShell(agent.id, kind);
              onClose();
            }}
          >
            <ColorDot agent={agent} />
            {displayName(agent)}
          </button>
        ))}
      </div>
      <div class="broadcast-row end">
        <span class={`broadcast-note${error ? ' error' : ''}`}>{error ?? 'Your shell, in a pane: no Claude in it, and no box. It ends when you close its pane.'}</span>
        <button type="button" class="quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}
