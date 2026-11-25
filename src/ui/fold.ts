import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

// A row that folds what does not fit, a step at a time: what matters least goes first, and comes back when there is room. The
// row is measured, not guessed: its labels change with what the session does, and with the size of the text.

/** The next step of a row: one more while it does not fit and there is something left to fold. */
export const nextFold = (fold: number, content: number, room: number, max: number): number => (content > room + 1 && fold < max ? fold + 1 : fold);

/**
 * How many steps `content` folds to fit in itself: 0 for none. `frame` is what its room comes from: a new width starts again from
 * nothing folded, and so does a new `key` (the labels).
 */
export function useFold(frame: { current: HTMLElement | null }, content: { current: HTMLElement | null }, max: number, key: string): number {
  const [state, setState] = useState({ fold: 0, key });
  const [, again] = useState(0);
  const width = useRef(0);
  const fold = state.key === key ? state.fold : 0;

  // After each render, before it is painted: one step more, until it fits.
  useLayoutEffect(() => {
    const row = content.current;
    if (!row) return;
    const next = nextFold(fold, row.scrollWidth, row.clientWidth, max);
    if (next !== state.fold || state.key !== key) setState({ fold: next, key });
  });

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const now = element.clientWidth;
      if (Math.abs(now - width.current) < 1) return;
      width.current = now;
      setState((current) => ({ ...current, fold: 0 }));
      again((value) => value + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return fold;
}
