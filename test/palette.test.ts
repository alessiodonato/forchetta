import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/daemon/hub.ts';
import type { Agent } from '../src/shared/agent.ts';
import { matchCommands, type PaletteCommand, SHORTCUTS } from '../src/ui/Palette.tsx';
import { Store } from '../src/ui/store.ts';
import { docOfTemplate, specOfDoc, templateOfDoc } from '../src/ui/studio-model.ts';

// The palette (⌘K), the next session that waits for you (⌘]), the settings from the page, the budget in the studio.

const NOW = 1_800_000_000_000;
const agent = (id: string, state: Agent['state'], createdAt: number): Agent =>
  ({ id, state, createdAt, project: id, pastSessionIds: [], control: { kind: 'tmux', session: `fk-${id}` }, lastEvent: { name: 'Stop', at: NOW } }) as Agent;

describe('the palette', () => {
  const commands: PaletteCommand[] = [
    { id: 'a', group: 'Actions', label: 'New session', run: () => {} },
    { id: 'b', group: 'Window', label: 'Settings', words: 'preferences guard', run: () => {} },
    { id: 'c', group: 'Sessions', label: 'shop-api — waits for you', run: () => {} },
  ];
  it('finds a command by every word typed, in its label or its other words', () => {
    expect(matchCommands(commands, '').map((command) => command.id)).toEqual(['a', 'b', 'c']);
    expect(matchCommands(commands, 'guard').map((command) => command.id)).toEqual(['b']);
    expect(matchCommands(commands, 'shop waits').map((command) => command.id)).toEqual(['c']);
    expect(matchCommands(commands, 'new nothing')).toEqual([]);
  });
  it('the sheet lists ⌘K, ⌘, and ⌘]', () => {
    expect(SHORTCUTS.map((shortcut) => shortcut.keys)).toEqual(expect.arrayContaining(['⌘K', '⌘,', '⌘]', '⌘W']));
  });
});

describe('the page', () => {
  it('⌘] goes to the next session that waits for you, round', () => {
    const store = new Store();
    const hello: ServerMessage = { type: 'hello', now: NOW, agents: [agent('a', 'waiting', 1), agent('b', 'working', 2), agent('c', 'waiting', 3)], settings: { replace: 'lru', arricurdaiNotes: false } };
    store.apply(hello);
    expect(store.nextWaiting()).toBe('a');
    store.open('a');
    expect(store.nextWaiting()).toBe('c');
    store.open('c');
    expect(store.nextWaiting()).toBe('a');
  });
  it('saving the settings is under way until the daemon answers, then says what waits for a restart', () => {
    const store = new Store();
    const sent: unknown[] = [];
    store.send = (message) => (sent.push(message), true);
    const settings = { guard: { files: true, git: true, notes: true, servers: true }, stallMin: 10, endedRetentionMin: 10, replace: 'lru' as const, hotkey: '', port: 47900, haiku: false };
    store.saveSettings(settings);
    expect(store.state.settingsSave?.busy).toBe(true);
    expect(sent).toEqual([{ type: 'saveSettings', settings }]);
    store.apply({ type: 'settingsSaved', now: NOW, ok: true, restart: ['the port'] });
    expect(store.state.settingsSave).toMatchObject({ busy: false, ok: true, restart: ['the port'] });
  });
});

describe('the budget in the studio', () => {
  it('goes with the team and its template, and comes back when it opens again', () => {
    const doc = docOfTemplate({ name: 'Shop squad', lead: { kind: 'claude', name: 'lead', role: 'Leads.' }, talk: 'twoway', members: [{ name: 'dev', role: 'Codes.' }], budgetUsd: 25 }, '/tmp/shop');
    expect(doc.budget).toBe('25');
    const spec = specOfDoc({ ...doc, budget: '12.5' });
    expect('spec' in spec && spec.spec.budgetUsd).toBe(12.5);
    const template = templateOfDoc({ ...doc, budget: '' });
    expect('template' in template && template.template.budgetUsd).toBeUndefined();
  });
});
