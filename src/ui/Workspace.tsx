import { useCallback, useLayoutEffect, useRef } from 'preact/hooks';
import { type Agent, displayName } from '../shared/agent.ts';
import { layoutFor } from './layout.ts';
import { motionAllowed } from './motion.ts';
import { Pane } from './Pane.tsx';
import { Rail } from './Rail.tsx';
import { springKeyframes } from './spring.ts';
import type { Store, UiState } from './store.ts';

// The work area: the column of boxes on the left, up to four panes on the right. When panes open, close or
// change place, they move to their new place with a spring (position and size), and a new one grows in.

/** Moves each pane from where it was to where it is, scaling it from its old size; new panes grow in. */
function useSpringLayout(container: { current: HTMLElement | null }, key: string): void {
  const places = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const now = new Map<string, DOMRect>();
    const panes = Array.from(element.querySelectorAll<HTMLElement>(':scope > .pane'));
    for (const pane of panes) now.set(pane.dataset.id ?? '', pane.getBoundingClientRect());
    if (motionAllowed()) {
      for (const pane of panes) {
        const after = now.get(pane.dataset.id ?? '');
        const before = places.current.get(pane.dataset.id ?? '');
        if (!after || after.width === 0 || after.height === 0) continue;
        if (!before) {
          const { keyframes, duration } = springKeyframes((p) => ({ opacity: Math.min(1, p * 1.6), transform: `scale(${0.96 + 0.04 * p})` }));
          pane.animate(keyframes, { duration, easing: 'linear' });
          continue;
        }
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        const sx = before.width / after.width;
        const sy = before.height / after.height;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
        const { keyframes, duration } = springKeyframes((p) => ({
          transform: `translate(${dx * (1 - p)}px, ${dy * (1 - p)}px) scale(${sx + (1 - sx) * p}, ${sy + (1 - sy) * p})`,
        }));
        pane.animate(keyframes, { duration, easing: 'linear' });
      }
    }
    places.current = now;
  }, [key]);
}

function nameOf(state: UiState, id: string): string {
  const agent = state.agents.get(id);
  return agent ? displayName(agent) : id;
}

function ReplaceChooser({ state, store }: { state: UiState; store: Store }) {
  const asking = state.panes.asking ? state.agents.get(state.panes.asking) : undefined;
  if (!asking) return null;
  return (
    <div class="chooser" role="dialog" aria-label="Quale riquadro sostituisco?">
      <span>
        Quattro riquadri aperti. Quale sostituisco con <strong>{displayName(asking)}</strong>?
      </span>
      {state.panes.open.map((id) => (
        <button key={id} type="button" onClick={() => store.replace(id)}>
          {nameOf(state, id)}
        </button>
      ))}
      <button type="button" class="quiet" onClick={() => store.cancelAsking()}>
        Annulla
      </button>
    </div>
  );
}

export function Workspace({ state, store, agents, now }: { state: UiState; store: Store; agents: readonly Agent[]; now: number }) {
  const panes = state.panes;
  const layout = layoutFor(panes);
  const grid = useRef<HTMLDivElement>(null);
  useSpringLayout(grid, `${panes.open.join(' ')}|${layout.areas}|${JSON.stringify(layout.place)}`);
  const open = useCallback((id: string) => store.open(id), [store]);
  const close = useCallback((id: string) => store.close(id), [store]);
  const use = useCallback((id: string) => store.use(id), [store]);

  return (
    <div class="workspace">
      <Rail agents={agents} now={now} open={panes.open} onOpen={open} store={store} />
      <div class="work">
        <ReplaceChooser state={state} store={store} />
        <div class="panes" ref={grid} style={{ gridTemplateColumns: layout.columns, gridTemplateRows: layout.rows, gridTemplateAreas: layout.areas }}>
          {panes.open.map((id) => {
            const agent = state.agents.get(id);
            if (!agent) return null;
            return <Pane key={id} agent={agent} area={layout.place[id] ?? 'auto'} focusKey={id === panes.active ? (panes.used[id] ?? 0) : -1} now={now} store={store} onClose={close} onUse={use} />;
          })}
        </div>
      </div>
    </div>
  );
}
