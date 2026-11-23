import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserShell, type BrowserShellDeps } from '../src/ui/browser-shell.ts';
import { openCodeIn } from '../src/ui/connection.ts';
import { clipboardKey } from '../src/ui/layout.ts';
import { commandKey, keyText } from '../src/ui/platform.ts';
import { ROOT } from '../src/shared/paths.ts';

// The page in a browser, on a computer that is not a Mac.

describe('the shortcuts', () => {
  it('are with Ctrl, and the texts call them so', () => {
    const on = (text: string): string => keyText(text, false);
    expect(on('⌘N')).toBe('Ctrl+N');
    expect(on('⇧⌘N')).toBe('Ctrl+Shift+N');
    expect(on('⌥⌘N')).toBe('Ctrl+Alt+N');
    expect(on('⌘1 … ⌘9')).toBe('Ctrl+1 … Ctrl+9');
    expect(on('⌘+ ⌘− ⌘0')).toBe('Ctrl++ Ctrl+− Ctrl+0');
    expect(on('⌘-click')).toBe('Ctrl-click');
    expect(on('⇧-click adds')).toBe('Shift-click adds');
    expect(on('⇧Enter')).toBe('Shift+Enter');
    expect(on('Settings (⌘,) · Commands (⌘K)')).toBe('Settings (Ctrl+,) · Commands (Ctrl+K)');
    expect(on('Open the next session (⌘])')).toBe('Open the next session (Ctrl+])');
    expect(on('⌘↩ starts it.')).toBe('Ctrl+Enter starts it.');
    expect(on('⌘ and the wheel')).toBe('Ctrl and the wheel');
    expect(on('nothing here')).toBe('nothing here');
    expect(keyText('Settings (⌘,)', true)).toBe('Settings (⌘,)');
  });

  it('no text of the page shows a key of the Mac by itself', () => {
    const bare: string[] = [];
    for (const name of readdirSync(join(ROOT, 'src', 'ui')).filter((file) => file.endsWith('.tsx'))) {
      readFileSync(join(ROOT, 'src', 'ui', name), 'utf8').split('\n').forEach((line, index) => {
        if (!/[⌘⌥⇧]/.test(line) || /^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        // Through keyText here, or where it is shown: the keys of a list, the note of the studio, the texts of Settings.
        if (/keyText\(|\bkeys: |setNote\(|IS_MAC \?|brings back what was/.test(line)) return;
        bare.push(`${name}:${index + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(bare).toEqual([]);
  });

  it('a link opens with ⌘ on a Mac, with Ctrl elsewhere', () => {
    expect(commandKey({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(commandKey({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(commandKey({ metaKey: false, ctrlKey: true }, false)).toBe(true);
  });

  it('Ctrl+V pastes in a terminal; Ctrl+C copies only what the page selected', () => {
    const key = (extra: object) => ({ type: 'keydown', key: 'v', shiftKey: false, altKey: false, ctrlKey: true, metaKey: false, ...extra });
    expect(clipboardKey(key({}), false, false)).toBe('paste');
    expect(clipboardKey(key({ key: 'V', shiftKey: true }), false, false)).toBe('paste');
    expect(clipboardKey(key({ key: 'c' }), true, false)).toBe('copy');
    expect(clipboardKey(key({ key: 'c' }), false, false)).toBeUndefined();
    expect(clipboardKey(key({ type: 'keyup' }), false, false)).toBeUndefined();
    expect(clipboardKey(key({ altKey: true }), false, false)).toBeUndefined();
    expect(clipboardKey(key({}), false, true)).toBeUndefined();
  });
});

describe('the address of forchetta open', () => {
  it('has a code in its fragment', () => {
    expect(openCodeIn(`#open=${'a1'.repeat(16)}`)).toBe('a1'.repeat(16));
    expect(openCodeIn('#open=short')).toBeUndefined();
    expect(openCodeIn(`#open=${'a1'.repeat(17)}`)).toBeUndefined();
    expect(openCodeIn('')).toBeUndefined();
  });
});

describe('outside the window, in a browser', () => {
  function shell(extra: Partial<BrowserShellDeps> = {}) {
    const seen = { titles: [] as string[], shown: [] as { title: string; tag: string; closed: boolean; click: () => void }[], focused: [] as string[] };
    const post = browserShell({
      title: (text) => seen.titles.push(text),
      inFront: () => false,
      allowed: () => true,
      show: (title, options) => {
        const one = { title, tag: options.tag, closed: false, click: () => {} };
        seen.shown.push(one);
        return {
          close: () => void (one.closed = true),
          set onclick(listener: (() => void) | null) {
            one.click = listener ?? (() => {});
          },
          get onclick() {
            return one.click;
          },
        };
      },
      focus: (id) => seen.focused.push(id),
      ...extra,
    });
    return { post, seen };
  }

  it('counts in the title the sessions that wait for you', () => {
    const { post, seen } = shell();
    post({ type: 'attention', count: 2, waiting: ['a', 'b'] });
    post({ type: 'attention', count: 0, waiting: [] });
    expect(seen.titles).toEqual(['(2) Forchetta', 'Forchetta']);
  });

  it('shows the notifications, opens their session, and closes those of a wait that ended', () => {
    const { post, seen } = shell();
    post({ type: 'notify', id: 'a', kind: 'waiting', title: 'shop waits for you', body: 'Permission' });
    post({ type: 'notify', id: 'a', kind: 'error', title: 'shop ended with an error', body: '' });
    expect(seen.shown.map((one) => one.tag)).toEqual(['a', 'a:error']);
    seen.shown[0]!.click();
    expect(seen.focused).toEqual(['a']);
    post({ type: 'attention', count: 0, waiting: [] });
    expect(seen.shown.map((one) => one.closed)).toEqual([true, false]);
  });

  it('shows none with the page in front, or not allowed', () => {
    const front = shell({ inFront: () => true });
    front.post({ type: 'notify', id: 'a', kind: 'waiting', title: 't', body: '' });
    const denied = shell({ allowed: () => false });
    denied.post({ type: 'notify', id: 'a', kind: 'waiting', title: 't', body: '' });
    expect([...front.seen.shown, ...denied.seen.shown]).toEqual([]);
  });
});
