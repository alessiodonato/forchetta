// A spring, sampled frame by frame, turned into keyframes for the Web Animations API. The WebKit of macOS 12 has
// no linear() easing, so the curve goes into the keyframes themselves and the animation runs with a linear easing.

export interface Spring {
  stiffness: number;
  damping: number;
  mass: number;
}

/** Quick, with a hint of overshoot: for boxes and panes that move into place. */
export const GENTLE: Spring = { stiffness: 210, damping: 22, mass: 1 };

const FRAME_MS = 1000 / 60;

/** The progress of a spring from 0 to 1, one value per frame, until it settles (or `maxMs`). */
export function springProgress(spring: Spring = GENTLE, maxMs = 1500): number[] {
  let position = 0;
  let velocity = 0;
  const values = [0];
  const dt = FRAME_MS / 1000;
  for (let elapsed = 0; elapsed < maxMs; elapsed += FRAME_MS) {
    const force = -spring.stiffness * (position - 1) - spring.damping * velocity;
    velocity += (force / spring.mass) * dt;
    position += velocity * dt;
    values.push(position);
    if (Math.abs(position - 1) < 0.001 && Math.abs(velocity) < 0.01) break;
  }
  values[values.length - 1] = 1;
  return values;
}

export interface SpringAnimation {
  keyframes: Keyframe[];
  duration: number;
}

/** Keyframes for a spring: `frame(p)` gives the style at progress p. At most `maxFrames` keyframes. */
export function springKeyframes(frame: (progress: number) => Keyframe, spring: Spring = GENTLE, maxFrames = 40): SpringAnimation {
  const values = springProgress(spring);
  const last = values.length - 1;
  const step = Math.max(1, Math.ceil(values.length / maxFrames));
  const indexes: number[] = [];
  for (let index = 0; index < last; index += step) indexes.push(index);
  indexes.push(last);
  return {
    keyframes: indexes.map((index) => ({ ...frame(values[index]!), offset: last === 0 ? 1 : index / last })),
    duration: Math.round(last * FRAME_MS),
  };
}
