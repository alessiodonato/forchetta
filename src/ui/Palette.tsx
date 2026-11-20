import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useReturnFocus } from './focus.ts';

// The palette of commands (⌘K): every action of the page and every session, found by typing a few letters. Enter
// runs the one chosen, the arrows move, Esc closes.

export interface PaletteCommand {
  id: string;
  label: string;
  /** Where it belongs: the actions first, then the sessions. */
  group: 'Actions' | 'Sessions' | 'Window';
  /** Its shortcut, when it has one: "⌘N". */
  keys?: string;
  /** More words it is found by. */
  words?: string;
  run: () => void;
}

/** The commands that hold every word typed, in their order. */
export function matchCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  return commands.filter((command) => {
    const text = `${command.label} ${command.words ?? ''} ${command.group}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function Palette({ commands, onClose }: { commands: readonly PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useReturnFocus(panel);
  useEffect(() => input.current?.focus(), []);
  const found = useMemo(() => matchCommands(commands, query), [commands, query]);
  const chosen = Math.min(index, Math.max(0, found.length - 1));
  const run = (command: PaletteCommand | undefined): void => {
    if (!command) return;
    onClose();
    // After the palette is gone: what it opens takes the focus.
    setTimeout(() => command.run(), 0);
  };
  useEffect(() => {
    panel.current?.querySelector(`[data-index="${chosen}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [chosen]);

  let group: string | undefined;
  return (
    <div class="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} class="palette" role="dialog" aria-modal="true" aria-label="Commands">
        <input
          ref={input}
          class="command-input palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={found[chosen] ? `palette-${found[chosen]!.id}` : undefined}
          aria-label="Type a command or the name of a session"
          placeholder="Type a command or the name of a session"
          value={query}
          onInput={(event) => {
            setQuery((event.target as HTMLInputElement).value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setIndex((chosen + 1) % Math.max(1, found.length));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setIndex((chosen - 1 + found.length) % Math.max(1, found.length));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              run(found[chosen]);
            }
          }}
        />
        <ul id="palette-list" class="palette-list" role="listbox" aria-label="Commands">
          {found.length === 0 && <li class="palette-empty">Nothing matches.</li>}
          {found.map((command, at) => {
            const head = command.group !== group ? command.group : undefined;
            group = command.group;
            return (
              <>
                {head && (
                  <li class="palette-group" role="presentation" key={`group-${head}`}>
                    {head}
                  </li>
                )}
                <li
                  key={command.id}
                  id={`palette-${command.id}`}
                  data-index={at}
                  role="option"
                  aria-selected={at === chosen}
                  class={`palette-item${at === chosen ? ' chosen' : ''}`}
                  onMouseMove={() => setIndex(at)}
                  onClick={() => run(command)}
                >
                  <span>{command.label}</span>
                  {command.keys && <kbd>{command.keys}</kbd>}
                </li>
              </>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** The shortcuts of Forchetta, by what they do. */
export const SHORTCUTS: { group: string; keys: string; what: string }[] = [
  { group: 'Anywhere', keys: '⌘K', what: 'Commands and sessions, by typing' },
  { group: 'Anywhere', keys: '⌘N', what: 'New session' },
  { group: 'Anywhere', keys: '⇧⌘N', what: 'New team' },
  { group: 'Anywhere', keys: '⌥⌘N', what: 'New team in the studio' },
  { group: 'Anywhere', keys: '⌘,', what: 'Settings' },
  { group: 'Anywhere', keys: '⌘/', what: 'These shortcuts' },
  { group: 'Sessions', keys: '⌘1 … ⌘9', what: 'Open the first nine sessions, in the order of the boxes' },
  { group: 'Sessions', keys: '⌘]', what: 'The next session that waits for you' },
  { group: 'Sessions', keys: '⌘W', what: 'Close the pane in front (with none, hide the window)' },
  { group: 'Sessions', keys: 'Tab, then Enter', what: 'Open a box from the keyboard' },
  { group: 'Panes', keys: '⇧Enter', what: 'A new line in the prompt of Claude Code' },
  { group: 'Panes', keys: '⌘-click', what: 'Open a link of a terminal in the browser' },
  { group: 'Window', keys: '⌘+ ⌘− ⌘0', what: 'Zoom the page (in the studio: its canvas)' },
  { group: 'Window', keys: '⌘R', what: 'Reload the page' },
  { group: 'Window', keys: 'ctrl ⌥ F', what: 'Show or hide Forchetta from any app (Settings)' },
  { group: 'Studio', keys: '⌘Z ⇧⌘Z', what: 'Undo, redo' },
  { group: 'Studio', keys: '⌘C ⌘V ⌘D ⌘A', what: 'Copy, paste, duplicate, select every box' },
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useReturnFocus(panel, true, true);
  const groups = [...new Set(SHORTCUTS.map((shortcut) => shortcut.group))];
  return (
    <div class="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} class="palette shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1} onKeyDown={(event) => event.key === 'Escape' && onClose()}>
        <h2>Keyboard shortcuts</h2>
        {groups.map((group) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
                <div key={shortcut.keys + shortcut.what}>
                  <dt>
                    <kbd>{shortcut.keys}</kbd>
                  </dt>
                  <dd>{shortcut.what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <div class="broadcast-row">
          <button type="button" class="quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
