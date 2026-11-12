import { describe, expect, it } from 'vitest';
import { paneModes, scrolledBack } from '../src/daemon/scrollback.ts';
import { newAgent } from '../src/daemon/state.ts';

// A pane open in the app and scrolled back in tmux (copy mode): its keys go to tmux, and the pane says so.

const agent = (session: string, paneId?: string) => newAgent({ id: session, cwd: '/p', control: { kind: 'tmux', session, ...(paneId ? { paneId } : {}) } }, 0);

describe('panes scrolled back', () => {
  it('reads the output of list-panes: by pane, and by session when any of its panes is', () => {
    const modes = paneModes('fk-a\t%1\t0\nfk-b\t%2\t1\nfk-c\t%3\t0\nfk-c\t%4\t1\n\nbroken line\n');
    expect(modes.get('%1')).toBe(false);
    expect(modes.get('fk-a')).toBe(false);
    expect(modes.get('%2')).toBe(true);
    expect(modes.get('fk-b')).toBe(true);
    expect(modes.get('fk-c')).toBe(true);
    expect(modes.has('broken line')).toBe(false);
  });

  it('only for a session whose terminal is open in the app, by its pane when it is known', () => {
    const modes = paneModes('fk-a\t%1\t1\nfk-b\t%2\t1\nfk-b\t%5\t0\n');
    const open = new Set(['fk-a', 'fk-b']);
    expect(scrolledBack(agent('fk-a'), open, modes)).toBe(true);
    expect(scrolledBack(agent('fk-a'), new Set(), modes)).toBe(false);
    expect(scrolledBack(agent('fk-b', '%5'), open, modes)).toBe(false);
    expect(scrolledBack(agent('fk-b', '%2'), open, modes)).toBe(true);
    expect(scrolledBack({ ...agent('fk-a'), state: 'ended' }, open, modes)).toBe(false);
    expect(scrolledBack(newAgent({ id: 'r', cwd: '/p', control: { kind: 'readonly', reason: 'fuori-tmux' } }, 0), open, modes)).toBe(false);
  });
});
