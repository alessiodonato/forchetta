import { springKeyframes } from './spring.ts';

// Motion that tells something: a box that enters, moves into place, or shakes once at an error. All of it stops
// with "Riduci movimento" of macOS and while the window cannot be seen. The animations of the states themselves
// are in the CSS and in ambient.ts, which follow the same two rules.
//
// "Riduci movimento" arrives in two ways. Inside the app, the window tells the page (at load, and whenever the
// setting changes): the media query of a web view does not always follow a change while the page is open. In a
// browser, the media query alone. Either way it ends up in one attribute, html[data-reduced-motion], that the
// CSS reads.

const query = matchMedia('(prefers-reduced-motion: reduce)');
let reduced = window.__FORCHETTA__?.reducedMotion ?? query.matches;
let hidden = false;
const listeners = new Set<(reduced: boolean) => void>();

function setReduced(value: boolean): void {
  const changed = value !== reduced;
  reduced = value;
  document.documentElement.toggleAttribute('data-reduced-motion', value);
  if (changed) for (const listener of listeners) listener(value);
}

setReduced(reduced);
query.addEventListener('change', () => setReduced(query.matches));
window.forchettaReducedMotion = (value: boolean) => setReduced(value);

export const reducedMotion = (): boolean => reduced;
export const motionAllowed = (): boolean => !reduced && !hidden;

/** "Riduci movimento" switched on or off while the app runs. */
export function onReducedMotionChange(listener: (reduced: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setHidden(value: boolean): void {
  hidden = value;
  document.documentElement.toggleAttribute('data-hidden', value);
}

export function animateEnter(element: HTMLElement): void {
  if (!motionAllowed()) return;
  const { keyframes, duration } = springKeyframes((p) => ({ opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 10}px) scale(${0.985 + 0.015 * p})` }));
  element.animate(keyframes, { duration, easing: 'linear' });
}

/** From where the element was to where it is now. */
export function animateMove(element: HTMLElement, dx: number, dy: number): void {
  if (!motionAllowed()) return;
  const { keyframes, duration } = springKeyframes((p) => ({ transform: `translate(${(1 - p) * dx}px, ${(1 - p) * dy}px)` }));
  element.animate(keyframes, { duration, easing: 'linear' });
}

export function animateShake(element: HTMLElement): void {
  if (!motionAllowed()) return;
  element.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-5px)' },
      { transform: 'translateX(4px)' },
      { transform: 'translateX(-3px)' },
      { transform: 'translateX(2px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: 420, easing: 'ease-out' },
  );
}
