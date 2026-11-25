import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/shared/agent.ts';
import { nextFold } from '../src/ui/fold.ts';
import { menuItems } from '../src/ui/PaneMenu.tsx';
import type { Store } from '../src/ui/store.ts';

describe('the header of a pane', () => {
  it('folds one step more while it does not fit, as far as it goes', () => {
    expect(nextFold(0, 300, 400, 3)).toBe(0);
    expect(nextFold(0, 401, 400, 3)).toBe(0);
    expect(nextFold(0, 402, 400, 3)).toBe(1);
    expect(nextFold(2, 500, 400, 3)).toBe(3);
    expect(nextFold(3, 500, 400, 3)).toBe(3);
  });
});

describe('what has no room in it', () => {
  const agent = { id: 'a', cwd: '/p/shop', filesChanged: 162, subagents: [{ id: 's', state: 'running' }], artifacts: [{ url: 'https://claude.ai/artifact/1', title: 'One', at: 1 }] } as unknown as Agent;
  const done: string[] = [];
  const storeWith = (kinds: { id: string; label: string }[] | undefined): Store =>
    ({
      state: { shellKinds: kinds },
      showFiles: () => done.push('files'),
      showSubagents: () => done.push('subagents'),
      openShell: (_id: string, kind: string) => done.push(`shell ${kind}`),
      command: (_id: string, kind: string) => done.push(kind),
    }) as unknown as Store;
  const names = (...args: Parameters<typeof menuItems>): string[] => menuItems(...args).map((item) => item.name);

  it('is in the menu: the actions, and what the session shows when it is folded too', () => {
    const store = storeWith([{ id: 'shell', label: 'zsh' }]);
    expect(names(agent, store, false, false, () => {})).toEqual(['shell', 'btw…', 'compact', 'clear']);
    expect(names(agent, store, true, false, () => {})).toEqual(['1 subagent', '162 files', 'One', 'shell', 'btw…', 'compact', 'clear']);
  });
  it('a shell for each kind, on Windows; none with a daemon that has none', () => {
    expect(names(agent, storeWith([{ id: 'powershell', label: 'PowerShell' }, { id: 'bash', label: 'Git Bash' }]), false, false, () => {})).toEqual(['PowerShell', 'Git Bash', 'btw…', 'compact', 'clear']);
    expect(names(agent, storeWith(undefined), false, false, () => {})).toEqual(['btw…', 'compact', 'clear']);
  });
  it('every artifact, not the first few', () => {
    const many = { ...agent, artifacts: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ url: `https://claude.ai/artifact/${n}`, title: 'The same title', at: n })) } as unknown as Agent;
    const keys = menuItems(many, storeWith([]), true, false, () => {}).map((item) => item.key);
    expect(keys.filter((key) => key.startsWith('https:'))).toHaveLength(7);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('an item is the same one while its number changes: what has the focus keeps it', () => {
    const keysWith = (filesChanged: number) => menuItems({ ...agent, filesChanged } as Agent, storeWith([]), true, false, () => {}).map((item) => item.key);
    expect(keysWith(163)).toEqual(keysWith(162));
  });
  it('an ended session takes no commands', () => {
    expect(names(agent, storeWith([{ id: 'shell', label: 'zsh' }]), true, true, () => {})).toEqual(['1 subagent', '162 files', 'One', 'shell']);
  });
  it('/clear asks before it goes, and so does /btw', () => {
    const asked: string[] = [];
    for (const item of menuItems(agent, storeWith([{ id: 'shell', label: 'zsh' }]), true, false, (ask) => asked.push(ask))) if (item.name !== 'One') item.run();
    expect(asked).toEqual(['btw', 'clear']);
    expect(done).toEqual(['subagents', 'files', 'shell shell', 'compact']);
  });
});
