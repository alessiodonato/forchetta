import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import { artifactName, menuPlace, openLink } from './Artifacts.tsx';
import type { Ask } from './Commands.tsx';
import type { Store } from './store.ts';

// "⋯" in the header of a pane: what has no room in it. The ✕ beside it always has.

interface Item {
  /** The same while its name changes ("162 files", "163 files"): what has the focus keeps it. */
  key: string;
  name: string;
  what: string;
  run: () => void;
}

/** What the menu has: the actions, and, when they are folded too, what the session has to show. */
export function menuItems(agent: Agent, store: Store, withShown: boolean, ended: boolean, onAsk: (ask: Ask) => void): Item[] {
  const items: Item[] = [];
  if (withShown) {
    const subagents = agent.subagents?.length ?? 0;
    const files = agent.filesChanged ?? 0;
    if (subagents > 0) items.push({ key: 'subagents', name: `${subagents} ${subagents === 1 ? 'subagent' : 'subagents'}`, what: 'what they do', run: () => store.showSubagents(agent.id) });
    if (files > 0) items.push({ key: 'files', name: `${files} ${files === 1 ? 'file' : 'files'}`, what: 'the changes of this session', run: () => store.showFiles(agent.id) });
    for (const artifact of agent.artifacts ?? []) items.push({ key: artifact.url, name: artifactName(artifact), what: 'an artifact, in the browser', run: () => openLink(artifact.url) });
  }
  if (agent.cwd) for (const kind of store.state.shellKinds ?? []) items.push({ key: `shell ${kind.id}`, name: (store.state.shellKinds?.length ?? 0) > 1 ? kind.label : 'shell', what: 'a plain terminal in its folder', run: () => store.openShell(agent.id, kind.id) });
  if (ended) return items;
  items.push(
    { key: 'btw', name: 'btw…', what: 'a side question, kept out of the conversation', run: () => onAsk('btw') },
    { key: 'compact', name: 'compact', what: 'summarizes the conversation, frees context', run: () => store.command(agent.id, 'compact') },
    { key: 'clear', name: 'clear', what: 'a new conversation: asks first', run: () => onAsk('clear') },
  );
  return items;
}

/** Hidden, it is still here: the header is measured with nothing folded each time its labels change, and an open menu must stay. */
export function PaneMenu({ agent, store, withShown, ended, hidden, onAsk }: { agent: Agent; store: Store; withShown: boolean; ended: boolean; hidden: boolean; onAsk: (ask: Ask) => void }) {
  const [place, setPlace] = useState<ReturnType<typeof menuPlace>>();
  // As it was when it opened: the header folds and unfolds to be measured, and the menu must not change under the pointer.
  const [all, setAll] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = place !== undefined;
  const working = withShown && (agent.subagents?.some((subagent) => subagent.state === 'running') ?? false);

  useEffect(() => {
    if (!open) return;
    (menu.current?.querySelector('button') as HTMLElement | null)?.focus();
    const close = (): void => setPlace(undefined);
    const outside = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) close();
    };
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const onKey = (event: KeyboardEvent): void => {
    const buttons = [...(menu.current?.querySelectorAll('button') ?? [])] as HTMLElement[];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      setPlace(undefined);
      button.current?.focus();
    } else if (event.key === 'ArrowDown') buttons[(at + 1) % buttons.length]?.focus();
    else if (event.key === 'ArrowUp') buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const items = menuItems(agent, store, open ? all : withShown, ended, onAsk);
  // An ended session with nothing to show.
  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={button}
        type="button"
        class="pane-more"
        hidden={hidden}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        title="More: what has no room here"
        onClick={() => {
          if (open) setPlace(undefined);
          else if (button.current) {
            setAll(withShown);
            setPlace(menuPlace(button.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }));
          }
        }}
      >
        ⋯{working && <span class="pane-more-dot" aria-label="a subagent is at work" />}
      </button>
      {open &&
        createPortal(
          <div ref={menu} class="new-menu-list pane-menu" role="menu" style={place} onKeyDown={onKey} onMouseDown={(event) => event.stopPropagation()}>
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  setPlace(undefined);
                  item.run();
                }}
              >
                <span class="new-menu-name">
                  {item.name}
                  <small>{item.what}</small>
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
