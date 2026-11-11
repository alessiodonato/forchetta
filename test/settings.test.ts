import { describe, expect, it } from 'vitest';
import {
  ASYNC_EVENTS,
  formatSettings,
  HOOK_EVENTS,
  isOurHook,
  PERMISSION_EVENT,
  SYNC_EVENTS,
  UnexpectedSettings,
  withForchettaHooks,
  withoutForchettaHooks,
} from '../src/shared/settings.ts';

const SCRIPT = '/Users/dev/Desktop/Forchetta/bin/forchetta-hook';
const PERMISSION_SCRIPT = '/Users/dev/Desktop/Forchetta/bin/forchetta-permission';
const SYNC = { type: 'command', command: `${SCRIPT} 47821`, timeout: 3 };
const ASYNC = { type: 'command', command: `${SCRIPT} 47821`, async: true };
const PERMISSION = { type: 'command', command: `${PERMISSION_SCRIPT} 47821`, timeout: 3600 };
const targets = (port: number, hookScript = SCRIPT) => ({ port, hookScript, permissionScript: PERMISSION_SCRIPT });

/** The shape of the real settings: other keys, and the two hooks of arricurdAI. */
const settings = (): Record<string, unknown> => ({
  cleanupPeriodDays: 30,
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /Users/dev/Desktop/arricurdAI/packages/cli/dist/bin.js guard' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'node /Users/dev/Desktop/arricurdAI/packages/cli/dist/bin.js handoff' }] }],
  },
  statusLine: { type: 'command', command: 'echo hi' },
  theme: 'dark',
});

type Groups = Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;

describe('install', () => {
  it('adds one group per event and leaves every other hook and key exactly as it was', () => {
    const before = settings();
    const { settings: after, changes } = withForchettaHooks(before, targets(47821));
    const hooks = after.hooks as Groups;

    expect(changes).toHaveLength(HOOK_EVENTS.length);
    // arricurdAI: same groups, same place, same content.
    expect(hooks.UserPromptSubmit![0]).toEqual((before.hooks as Groups).UserPromptSubmit![0]);
    expect(hooks.SessionStart![0]).toEqual((before.hooks as Groups).SessionStart![0]);
    for (const event of SYNC_EVENTS) expect(hooks[event]!.at(-1)).toEqual({ hooks: [SYNC] });
    for (const event of ASYNC_EVENTS) expect(hooks[event]!.at(-1)).toEqual({ hooks: [ASYNC] });
    expect(hooks[PERMISSION_EVENT]!.at(-1)).toEqual({ hooks: [PERMISSION] });
    for (const key of ['cleanupPeriodDays', 'permissions', 'statusLine', 'theme']) expect(after[key]).toEqual(before[key]);
    // The input is not touched.
    expect(before).toEqual(settings());
  });

  it('changes nothing the second time', () => {
    const once = withForchettaHooks(settings(), targets(47821)).settings;
    const twice = withForchettaHooks(once, targets(47821));
    expect(twice.changes).toEqual([]);
    expect(formatSettings(twice.settings)).toBe(formatSettings(once));
  });

  it('updates its own hooks in place when the port changes', () => {
    const once = withForchettaHooks(settings(), targets(47821)).settings;
    const moved = withForchettaHooks(once, targets(50000));
    expect(moved.changes.every((line) => line.startsWith('~ '))).toBe(true);
    const hooks = moved.settings.hooks as Groups;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop![0]!.hooks[0]!.command).toBe(`${SCRIPT} 50000`);
  });

  it('replaces the http hooks of the first version in place', () => {
    const old = { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:47821/forchetta/hook', timeout: 2 }] }] } };
    const { settings: after, changes } = withForchettaHooks(old, targets(47821));
    expect(changes).toContain(`~ Stop: http http://127.0.0.1:47821/forchetta/hook → command ${SCRIPT} 47821 (async)`);
    expect((after.hooks as Groups).Stop).toEqual([{ hooks: [ASYNC] }]);
  });

  it('turns the background PermissionRequest hook of 0.4 into the one that waits, in place', () => {
    const old = {
      hooks: {
        PermissionRequest: [{ hooks: [{ type: 'command', command: 'say ok' }] }, { hooks: [ASYNC] }],
      },
    };
    const { settings: after, changes } = withForchettaHooks(old, targets(47821));
    expect(changes).toContain(`~ PermissionRequest: command ${SCRIPT} 47821 (async) → command ${PERMISSION_SCRIPT} 47821 (waits, timeout 3600 s)`);
    expect((after.hooks as Groups).PermissionRequest).toEqual([{ hooks: [{ type: 'command', command: 'say ok' }] }, { hooks: [PERMISSION] }]);
  });

  it('quotes a script path with spaces', () => {
    const { settings: after } = withForchettaHooks({}, targets(1, '/Users/a b/Forchetta/bin/forchetta-hook'));
    const command = String((after.hooks as Groups).SessionStart![0]!.hooks[0]!.command);
    expect(command).toBe('"/Users/a b/Forchetta/bin/forchetta-hook" 1');
    expect(isOurHook({ type: 'command', command })).toBe(true);
  });

  it('refuses settings it does not understand', () => {
    expect(() => withForchettaHooks({ hooks: [] }, targets(1))).toThrow(UnexpectedSettings);
    expect(() => withForchettaHooks({ hooks: { Stop: {} } }, targets(1))).toThrow(UnexpectedSettings);
    expect(() => withForchettaHooks({ hooks: { Stop: [{ hooks: 'x' }] } }, targets(1))).toThrow(UnexpectedSettings);
  });
});

describe('uninstall', () => {
  it('gives back the original settings, byte for byte', () => {
    const original = settings();
    const installed = withForchettaHooks(original, targets(47821)).settings;
    const { settings: removed, changes } = withoutForchettaHooks(installed);
    expect(changes).toHaveLength(HOOK_EVENTS.length);
    expect(formatSettings(removed)).toBe(formatSettings(original));
  });

  it('keeps the other hooks of a mixed group', () => {
    const mixed = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }, ASYNC] }] } };
    expect(withoutForchettaHooks(mixed).settings).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
  });

  it('removes the hooks object when only ours were there', () => {
    const only = withForchettaHooks({ theme: 'dark' }, targets(47821)).settings;
    expect(withoutForchettaHooks(only).settings).toEqual({ theme: 'dark' });
  });

  it('also removes the http hooks of the first version', () => {
    const old = { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:47821/forchetta/hook', timeout: 2 }] }] } };
    expect(withoutForchettaHooks(old).settings).toEqual({});
  });
});

describe('isOurHook', () => {
  it('knows only the hooks of Forchetta', () => {
    expect(isOurHook({ type: 'http', url: 'http://127.0.0.1:47821/forchetta/hook' })).toBe(true);
    expect(isOurHook({ type: 'command', command: `${SCRIPT} 47821` })).toBe(true);
    expect(isOurHook({ type: 'command', command: `${PERMISSION_SCRIPT} 47821` })).toBe(true);
    expect(isOurHook({ type: 'command', command: 'node /x/arricurdAI/packages/cli/dist/bin.js guard' })).toBe(false);
    expect(isOurHook({ type: 'http', url: 'http://127.0.0.1:47821/hook' })).toBe(false);
    expect(isOurHook({ type: 'http', url: 'https://example.com/forchetta/hook' })).toBe(false);
    expect(isOurHook({ type: 'command', command: 'echo forchetta-hooks' })).toBe(false);
  });
});
