import { useState } from 'preact/hooks';
import { type Agent, displayName, STATE_LABEL } from '../shared/agent.ts';
import { activity } from '../shared/present.ts';
import { CommandBar, CommandStatus } from './Commands.tsx';
import { ArtifactsButton } from './Artifacts.tsx';
import { FilesButton } from './Files.tsx';
import type { Store } from './store.ts';
import { type TerminalStatus, TerminalView } from './TerminalView.tsx';

// A pane of the work area: a header with the session and its state, and its terminal. The ✕ closes the pane
// only: the session goes on, in tmux, and stays in the column on the left.

interface Props {
  agent: Agent;
  area: string;
  focusKey: number;
  now: number;
  store: Store;
  onClose: (id: string) => void;
  onUse: (id: string) => void;
}

export function Pane({ agent, area, focusKey, now, store, onClose, onUse }: Props) {
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const ended = agent.state === 'ended' || status === 'ended';
  return (
    <section class="pane" data-id={agent.id} data-state={agent.state} style={{ gridArea: area }}>
      <header class="pane-head">
        <span class="pane-project" title={agent.cwd}>
          {displayName(agent)}
        </span>
        <span class="pane-state">{STATE_LABEL[agent.state]}</span>
        <span class="pane-activity" title={activity(agent)}>
          {activity(agent)}
        </span>
        <FilesButton agent={agent} store={store} className="pane-files" />
        <ArtifactsButton agent={agent} className="pane-files" />
        {!ended && <CommandBar agent={agent} store={store} />}
        <button class="pane-close" type="button" title="Close the pane: the session goes on" onClick={() => onClose(agent.id)}>
          ✕
        </button>
      </header>
      <CommandStatus agent={agent} store={store} now={now} />
      {agent.scrolledBack && !ended && (
        <p class="pane-scrolled" role="status">
          <span>Scrolled back in the history: the keys go to tmux, not to Claude.</span>
          <button
            type="button"
            class="link"
            onClick={(event) => {
              store.scrollEnd(agent.id);
              // The keyboard back to the terminal, to type at once.
              (event.currentTarget.closest('.pane')?.querySelector('.xterm-helper-textarea') as HTMLElement | null)?.focus();
            }}
          >
            back to the end
          </button>
          <span>or press q</span>
        </p>
      )}
      <div class="pane-body">
        <TerminalView agentId={agent.id} focusKey={focusKey} onUse={() => onUse(agent.id)} onStatus={setStatus} />
        {ended && <p class="pane-note">Session ended. The pane shows its last screen.</p>}
        {!ended && status === 'lost' && <p class="pane-note">Lost the connection to the daemon: close the pane and open it again.</p>}
      </div>
    </section>
  );
}
