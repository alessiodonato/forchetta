import { describe, expect, it } from 'vitest';
import { newAgent } from '../src/daemon/state.ts';
import { commandable, overThreshold } from '../src/ui/Broadcast.tsx';

// Who a command to several sessions can go to, and the preset of the panel: context at 80% or more.

const agent = (id: string, percent: number | undefined, control: 'tmux' | 'readonly' = 'tmux', state: 'idle' | 'ended' = 'idle') => ({
  ...newAgent({ id, cwd: `/x/${id}`, control: control === 'tmux' ? { kind: 'tmux', session: `fk-${id}` } : { kind: 'readonly', reason: 'fuori-tmux' } }, 0),
  state,
  context: percent === undefined ? undefined : { tokens: percent * 10_000, window: 1_000_000, percent, lastCallAt: 0, at: 0 },
});

describe('broadcast targets', () => {
  const agents = [agent('a', 85), agent('b', 80), agent('c', 79), agent('d', 95, 'readonly'), agent('e', 90, 'tmux', 'ended'), agent('f', undefined)];

  it('are the sessions in the tmux of Forchetta that did not end', () => {
    expect(commandable(agents).map((candidate) => candidate.id)).toEqual(['a', 'b', 'c', 'f']);
  });

  it('preset: context at 80% or more, among those', () => {
    expect(overThreshold(agents).map((candidate) => candidate.id)).toEqual(['a', 'b']);
  });
});
