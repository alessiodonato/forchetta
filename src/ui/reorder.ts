import { useEffect, useRef } from 'preact/hooks';
import type { Store } from './store.ts';

// Dragging the boxes into another order: in the grid, and in the column on the left. A press, then a move beyond a few
// pixels, is a drag; a line shows where the box goes, and the others glide when it is let go. Esc leaves them as they
// are. Only with a mouse: a finger scrolls.

/** How far the mouse moves with the button down before it is a drag, not a click. */
const DRAG_PX = 6;
/** Near an edge of what scrolls, it scrolls: from this far, this much for each frame. */
const EDGE_PX = 44;
const SCROLL_PX = 12;

/** What keeps its own press: buttons, fields, links. */
const OWN_PRESS = 'button:not([data-drag-handle]), input, textarea, select, a, label, [contenteditable], .team-editor, .permission, .command-bar';

export interface Slot {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Drop {
  /** The box the line is at, and its side. */
  id: string;
  side: 'before' | 'after';
  /** The box the dragged one goes before; undefined for the end. */
  before: string | undefined;
}

/** Where a box let go at this point goes, among the others: next to the nearest one. Undefined when it stays. */
export function dropAt(slots: readonly Slot[], dragged: string, x: number, y: number, column: boolean): Drop | undefined {
  const others = slots.filter((slot) => slot.id !== dragged);
  let nearest: Slot | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const slot of others) {
    const dx = Math.max(slot.left - x, 0, x - slot.right);
    const dy = Math.max(slot.top - y, 0, y - slot.bottom);
    const far = Math.hypot(dx, dy);
    if (far < distance) {
      distance = far;
      nearest = slot;
    }
  }
  if (!nearest) return undefined;
  const after = column ? y > (nearest.top + nearest.bottom) / 2 : x > (nearest.left + nearest.right) / 2;
  const at = others.indexOf(nearest) + (after ? 1 : 0);
  const was = slots.findIndex((slot) => slot.id === dragged);
  if (was === at) return undefined;
  return { id: nearest.id, side: after ? 'after' : 'before', before: others[at]?.id };
}

const scrollerOf = (element: HTMLElement): HTMLElement | undefined => {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const { overflowY } = getComputedStyle(current);
    if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) return current;
  }
  return undefined;
};

/** The children of the container with a data-id, dragged into another order; onDrop says which one goes before which. */
export function useReorder(container: { current: HTMLElement | null }, enabled: boolean, column: boolean, onDrop: (id: string, before: string | undefined) => void): void {
  const drop = useRef(onDrop);
  drop.current = onDrop;
  useEffect(() => {
    const root = container.current;
    if (!root || !enabled) return;
    let cancel: (() => void) | undefined;

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0 || event.pointerType === 'touch' || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement;
      if (target.closest(OWN_PRESS)) return;
      let item: HTMLElement | null = target;
      while (item && item.parentElement !== root) item = item.parentElement;
      const id = item?.dataset.id;
      if (!item || !id) return;
      const box = item;
      const start = { x: event.clientX, y: event.clientY };
      let last = start;
      let dragging = false;
      let found: Drop | undefined;
      let marked: HTMLElement | undefined;
      let frame = 0;

      const mark = (next: Drop | undefined): void => {
        marked?.removeAttribute('data-drop');
        marked = next ? (Array.from(root.children) as HTMLElement[]).find((child) => child.dataset.id === next.id) : undefined;
        if (marked && next) marked.dataset.drop = next.side;
        found = next;
      };
      const look = (): void => {
        const slots = (Array.from(root.children) as HTMLElement[])
          .filter((child) => child.dataset.id)
          .map((child) => {
            const { left, top, right, bottom } = child.getBoundingClientRect();
            return { id: child.dataset.id!, left, top, right, bottom };
          });
        mark(dropAt(slots, id, last.x, last.y, column));
      };
      const scroll = (): void => {
        const scroller = scrollerOf(root);
        if (scroller) {
          const { top, bottom } = scroller.getBoundingClientRect();
          const step = last.y < top + EDGE_PX ? -SCROLL_PX : last.y > bottom - EDGE_PX ? SCROLL_PX : 0;
          if (step !== 0) {
            scroller.scrollTop += step;
            look();
          }
        }
        frame = requestAnimationFrame(scroll);
      };
      const onMove = (move: PointerEvent): void => {
        last = { x: move.clientX, y: move.clientY };
        if (!dragging) {
          if (Math.hypot(last.x - start.x, last.y - start.y) < DRAG_PX) return;
          dragging = true;
          box.dataset.dragged = '';
          document.body.classList.add('reordering');
          window.getSelection()?.removeAllRanges();
          frame = requestAnimationFrame(scroll);
        }
        move.preventDefault();
        look();
      };
      const stop = (): void => {
        cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', stop);
        window.removeEventListener('blur', stop);
        window.removeEventListener('keydown', onKey, true);
        mark(undefined);
        box.removeAttribute('data-dragged');
        document.body.classList.remove('reordering');
        cancel = undefined;
      };
      const onUp = (): void => {
        const place = found;
        const moved = dragging;
        stop();
        if (!moved) return;
        // The click that follows would open the box.
        const swallow = (click: MouseEvent): void => {
          click.stopPropagation();
          click.preventDefault();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, true), 0);
        if (place) drop.current(id, place.before);
      };
      const onKey = (key: KeyboardEvent): void => {
        if (key.key !== 'Escape' || !dragging) return;
        key.preventDefault();
        key.stopPropagation();
        stop();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', stop);
      window.addEventListener('blur', stop);
      window.addEventListener('keydown', onKey, true);
      cancel = stop;
    };
    root.addEventListener('pointerdown', onDown);
    return () => {
      root.removeEventListener('pointerdown', onDown);
      cancel?.();
    };
  }, [enabled, column, container.current]);
}

/** ⌥ and an arrow on a box moves it by one place: −1, 1, or undefined for any other key. */
export function moveKey(event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'key'>): -1 | 1 | undefined {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return -1;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return 1;
  return undefined;
}

/** A box moved from the keyboard keeps it: the page may take it out and put it back elsewhere. */
export function moveAndKeep(store: Store, id: string, by: -1 | 1, element: HTMLElement): void {
  store.moveBox(id, by);
  requestAnimationFrame(() => {
    if (document.activeElement !== element) element.focus();
    element.scrollIntoView({ block: 'nearest' });
  });
}
