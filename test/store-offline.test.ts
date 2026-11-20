import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/daemon/hub.ts';
import { NOT_SENT, Store } from '../src/ui/store.ts';

// The page when the daemon is not there: an action says it was not sent, instead of waiting for ever.

const NOW = 1_800_000_000_000;
const hello: ServerMessage = { type: 'hello', now: NOW, agents: [], settings: { replace: 'lru', arricurdaiNotes: false } };

describe('the page without its daemon', () => {
  it('says "not sent" at once for what could not go', async () => {
    const store = new Store();
    store.apply(hello);
    // As connection.ts wires it, with the socket closed.
    store.send = () => (store.notSent(), false);
    store.addSkill('https://github.com/owner/repo/tree/main/skills/pdf');
    expect(store.state.skillEdit?.busy).toBe(true);
    await Promise.resolve();
    expect(store.state.skillEdit).toMatchObject({ busy: false, ok: false, error: NOT_SENT });
  });

  it('what waited for an answer when the connection went is told that none will come', () => {
    const store = new Store();
    store.apply(hello);
    store.send = () => true;
    store.setConnected(true);
    store.importTeam('{}');
    store.addSkill('/somewhere');
    expect(store.state.teamFile?.busy).toBe(true);
    store.setConnected(false);
    expect(store.state.teamFile).toMatchObject({ busy: false, ok: false, error: NOT_SENT });
    expect(store.state.skillEdit).toMatchObject({ busy: false, error: NOT_SENT });
    // Nothing else is touched.
    expect(store.state.spawn).toBeUndefined();
  });
});
