import { motionAllowed, reducedMotion } from './motion.ts';

// The endless state animations: the pulse of a box at work, the breath of a box waiting for you, the squeeze of
// the context bar while compacting, the pulse of the button of the subagents while one works.
//
// On this hardware (Intel Mac, macOS 12) the window server spends about a quarter of a core on any animation at
// 60 fps, and independent animations add up. So each one runs smoothly in CSS for its first seconds after a
// change, when the eye should catch it; then this single timer carries all of them on, at 12 steps per second
// and in the same frame, with the same curve and phase as the CSS: the window is composited 12 times per
// second however many boxes move. Nothing runs while the window cannot be seen or with "Riduci movimento".

const STEP_MS = 1000 / 12;

interface Ambient {
  selector: string;
  /** One cycle of the CSS animation, and how many of them run in CSS before this timer takes over. */
  period: number;
  smoothCycles: number;
  apply: (element: HTMLElement, elapsed: number) => void;
}

/** 0 at the start of a cycle, 1 at its middle, 0 at its end: the shape of the ease-in-out keyframes. */
const wave = (elapsed: number, period: number): number => (1 - Math.cos((2 * Math.PI * elapsed) / period)) / 2;

const AMBIENTS: Ambient[] = [
  {
    selector: '.box[data-state="working"] .aura',
    period: 2400,
    smoothCycles: 2,
    apply: (element, elapsed) => {
      element.style.opacity = (0.12 + 0.68 * wave(elapsed, 2400)).toFixed(3);
    },
  },
  {
    selector: '.box[data-state="waiting"] .aura',
    period: 1600,
    smoothCycles: 5,
    apply: (element, elapsed) => {
      element.style.opacity = (0.25 + 0.75 * wave(elapsed, 1600)).toFixed(3);
    },
  },
  {
    selector: '[data-working] > .subagents-pulse',
    period: 1600,
    smoothCycles: 3,
    apply: (element, elapsed) => {
      element.style.opacity = (0.1 + 0.9 * wave(elapsed, 1600)).toFixed(3);
    },
  },
  {
    selector: '.box[data-state="compacting"] .fill i',
    // The CSS runs 1.4 s one way and 1.4 s back (alternate): a cycle is 2.8 s.
    period: 2800,
    smoothCycles: 2,
    apply: (element, elapsed) => {
      element.style.transform = `scaleX(${(1 - 0.5 * wave(elapsed, 2800)).toFixed(3)})`;
    },
  },
];

let timer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
  if (!motionAllowed()) {
    stopAmbient(reducedMotion());
    return;
  }
  const now = Date.now();
  let any = false;
  for (const ambient of AMBIENTS) {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(ambient.selector))) {
      any = true;
      // The phase comes from the nearest element that says when its state began: its box, or the button.
      const since = Number((element.closest('[data-since]') as HTMLElement | null)?.dataset.since);
      if (!Number.isFinite(since)) continue;
      const elapsed = now - since;
      // Still in its smooth CSS cycles: the CSS animation wins over this style anyway.
      if (elapsed < ambient.period * ambient.smoothCycles - STEP_MS) continue;
      ambient.apply(element, elapsed);
    }
  }
  if (!any) stopAmbient(false);
}

/** Starts the timer when some box moves and motion is allowed. Cheap to call after every render. */
export function startAmbient(): void {
  if (timer !== undefined || !motionAllowed()) return;
  if (!AMBIENTS.some((ambient) => document.querySelector(ambient.selector))) return;
  timer = setInterval(tick, STEP_MS);
}

/** Stops the timer; with `clear`, the boxes go back to the still styles of the CSS. */
export function stopAmbient(clear: boolean): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  if (!clear) return;
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('.aura[style], .fill i[style], .subagents-pulse[style]'))) {
    element.style.removeProperty('opacity');
    element.style.removeProperty('transform');
  }
}
