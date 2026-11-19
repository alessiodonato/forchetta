import { useEffect, useRef, useState } from 'preact/hooks';

// "+ new" at the top: what to start, in one place. A session in a folder, a team from its panel, or a team drawn in
// the studio; each with its shortcut, which works anywhere in the window.

export type NewKind = 'session' | 'team' | 'studio';

const ITEMS: readonly { kind: NewKind; name: string; what: string; keys: string }[] = [
  { kind: 'session', name: 'session', what: 'Claude Code in a folder', keys: '⌘N' },
  { kind: 'team', name: 'team', what: 'a lead and its members, from a panel', keys: '⇧⌘N' },
  { kind: 'studio', name: 'draw a team', what: 'agents and arrows, in the studio', keys: '⌥⌘N' },
];

/** The kind a shortcut asks for: ⌘N, ⇧⌘N, ⌥⌘N; undefined for any other key. */
export function newKindOf(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'code'>): NewKind | undefined {
  if (!(event.metaKey || event.ctrlKey) || event.code !== 'KeyN') return undefined;
  return event.altKey ? 'studio' : event.shiftKey ? 'team' : 'session';
}

export function NewMenu({ active, onPick }: { active: boolean; onPick: (kind: NewKind) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);
  const pick = (kind: NewKind): void => {
    setOpen(false);
    onPick(kind);
  };
  return (
    <div class="new-menu" ref={root}>
      <button
        type="button"
        class={`broadcast-toggle primary${active || open ? ' active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Start a session or a team (⌘N, ⇧⌘N, ⌥⌘N)"
        onClick={() => setOpen(!open)}
      >
        + new ▾
      </button>
      {open && (
        <div class="new-menu-list" role="menu">
          {ITEMS.map((item) => (
            <button key={item.kind} type="button" role="menuitem" onClick={() => pick(item.kind)}>
              <span class="new-menu-name">
                {item.name}
                <small>{item.what}</small>
              </span>
              <kbd>{item.keys}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
