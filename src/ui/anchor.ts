import { useLayoutEffect, useRef } from 'preact/hooks';

/**
 * When the animation of the current state started (at mount, or at the last change of state), for ambient.ts,
 * which carries it on from the same phase. Leaving a moving state drops the styles that ambient.ts had set.
 */
export function useMotionAnchor(element: { current: HTMLElement | null }, state: string): number {
  const since = useRef(Date.now());
  const shown = useRef(state);
  if (shown.current !== state) {
    shown.current = state;
    since.current = Date.now();
  }
  useLayoutEffect(() => {
    for (const moved of Array.from(element.current?.querySelectorAll<HTMLElement>('.aura[style], .fill i[style]') ?? [])) {
      moved.style.removeProperty('opacity');
      moved.style.removeProperty('transform');
    }
  }, [state]);
  return since.current;
}
