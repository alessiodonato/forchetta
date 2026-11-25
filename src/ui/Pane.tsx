import { useEffect, useRef, useState } from 'preact/hooks';
import { type Agent, displayName, STATE_LABEL } from '../shared/agent.ts';
import { activity } from '../shared/present.ts';
import { type Ask, CommandAsk, CommandButtons, CommandStatus } from './Commands.tsx';
import { GuardLines } from './Guard.tsx';
import { ArtifactsButton } from './Artifacts.tsx';
import { FilesButton } from './Files.tsx';
import { useFold } from './fold.ts';
import { PaneMenu } from './PaneMenu.tsx';
import { SubagentsButton } from './Subagents.tsx';
import { SelectionMenu } from './SelectionMenu.tsx';
import { ShellButton } from './ShellButton.tsx';
import { ColorDot } from './Team.tsx';
import type { Store } from './store.ts';
import { terminalTheme } from './terminal-theme.ts';
import { type TerminalStatus, TerminalView } from './TerminalView.tsx';

// A pane of the work area: a header with the session and its state, and its terminal. The ✕ closes the pane
// only: the session goes on, in tmux, and stays in the column on the left.

/** The steps of the header, as its room goes: the actions into ⋯; then what the session shows as a glyph and a number; then that too. */
const FOLD_ACTIONS = 1;
const FOLD_SHORT = 2;
const FOLD_SHOWN = 3;

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
  const [ask, setAsk] = useState<Ask>();
  const head = useRef<HTMLElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const ended = agent.state === 'ended' || status === 'ended';
  const fold = useFold(
    head,
    main,
    FOLD_SHOWN,
    [displayName(agent), agent.state, ended, agent.subagents?.length, agent.filesChanged, agent.artifacts?.length, store.state.shellKinds?.length].join('|'),
  );
  const body = useRef<HTMLDivElement>(null);
  const selection = store.state.selection?.agentId === agent.id && !ended ? store.state.selection : undefined;
  // Text put into the prompt from the menu of a selection: the keyboard comes here, to finish the question.
  const inserted = store.state.inserted?.agentId === agent.id ? store.state.inserted.at : undefined;
  useEffect(() => {
    if (inserted !== undefined) (body.current?.querySelector('.xterm-helper-textarea') as HTMLElement | null)?.focus();
  }, [inserted]);
  // The color of the session tints its terminal, and the pane around it.
  const color = agent.team?.color;
  return (
    <section
      class="pane"
      data-id={agent.id}
      data-state={agent.state}
      style={{ gridArea: area, ...(color ? { '--terminal': terminalTheme(color).background } : {}) }}
    >
      {/* What has no room folds, what matters least first; the ✕ is apart, and is always there. */}
      <header class="pane-head" ref={head} data-fold={fold}>
        <div class="pane-head-main" ref={main}>
          <span class="pane-project" title={`${displayName(agent)}${agent.cwd ? `\n${agent.cwd}` : ''}`}>
            <ColorDot agent={agent} />
            {displayName(agent)}
          </span>
          <span class="pane-state">{STATE_LABEL[agent.state]}</span>
          <span class="pane-activity" title={activity(agent)}>
            {activity(agent)}
          </span>
          {fold < FOLD_SHOWN && (
            <>
              <SubagentsButton agent={agent} store={store} className="pane-files" short={fold >= FOLD_SHORT} />
              <FilesButton agent={agent} store={store} className="pane-files" short={fold >= FOLD_SHORT} />
              <ArtifactsButton agent={agent} className="pane-files" short={fold >= FOLD_SHORT} />
            </>
          )}
          {fold < FOLD_ACTIONS && (
            <>
              <ShellButton agent={agent} store={store} className="pane-files" />
              {!ended && <CommandButtons agent={agent} store={store} onAsk={setAsk} />}
            </>
          )}
        </div>
        <PaneMenu agent={agent} store={store} ended={ended} hidden={fold < FOLD_ACTIONS} withShown={fold >= FOLD_SHOWN} onAsk={setAsk} />
        <button class="pane-close" type="button" title="Close the pane: the session goes on" aria-label="Close the pane" onClick={() => onClose(agent.id)}>
          ✕
        </button>
      </header>
      {ask && !ended && (
        <div class="pane-ask">
          <CommandAsk agent={agent} store={store} ask={ask} onDone={() => setAsk(undefined)} />
        </div>
      )}
      <CommandStatus agent={agent} store={store} now={now} />
      {(agent.heldBack || agent.holding) && !ended && (
        <div class="pane-guard">
          <GuardLines agent={agent} store={store} />
        </div>
      )}
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
      <div class="pane-body" ref={body}>
        <TerminalView
          agentId={agent.id}
          color={color}
          focusKey={focusKey}
          onUse={() => {
            onUse(agent.id);
            // Typing or clicking in the terminal closes the menu of a selection.
            if (store.state.selection?.agentId === agent.id) store.closeSelection();
          }}
          onStatus={setStatus}
          onDragStart={() => store.selectionStart(agent.id)}
          onDragEnd={(place) => store.selectionEnd(agent.id, place)}
          onSelectText={(text, place) => store.showSelection(agent.id, text, place)}
        />
        {selection && (
          // Over the terminal, with its coordinates: the menu opens where the mouse was let go.
          <div class="selection-layer">
            <SelectionMenu key={selection.at} agent={agent} selection={selection} store={store} />
          </div>
        )}
        {ended && <p class="pane-note">Session ended. The pane shows its last screen.</p>}
        {!ended && status === 'lost' && <p class="pane-note">Lost the connection to the daemon: close the pane and open it again.</p>}
      </div>
    </section>
  );
}
