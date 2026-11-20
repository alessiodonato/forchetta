import { describe, expect, it } from 'vitest';
import { newAgent } from '../src/daemon/state.ts';
import type { Agent } from '../src/shared/agent.ts';
import { announcements, boxLabel, waitSentence } from '../src/ui/announce.ts';
import { permissionTarget } from '../src/ui/Permission.tsx';
import { TERMINAL_THEME, TERMINAL_THEME_LIGHT, extendedAnsi, terminalTheme, tint } from '../src/ui/terminal-theme.ts';
import { parseTheme, resolveTheme } from '../src/ui/theme.ts';

// The page for the keyboard and for a screen reader: what is said, and the light theme.

const agentOf = (id: string, folder: string): Agent => newAgent({ id, cwd: `/x/${folder}`, control: { kind: 'tmux', session: `fk-${id}` } }, 1000);

describe('what a screen reader is told', () => {
  it('says once when a session starts waiting, and again only when it waits for something else', () => {
    const shop = agentOf('a-1', 'shop');
    const docs = agentOf('a-2', 'docs');
    shop.state = 'waiting';
    shop.waiting = { kind: 'permesso', tool: 'Bash', detail: 'Bash npm test', since: 1000 };
    // The page opens: the waits already there are not read out.
    const first = announcements(new Map(), [shop, docs], true);
    expect(first.said).toEqual([]);
    // Nothing changed: nothing said.
    expect(announcements(first.next, [shop, docs]).said).toEqual([]);
    docs.state = 'waiting';
    docs.waiting = { kind: 'domanda', detail: 'Which branch?', since: 2000 };
    const second = announcements(first.next, [shop, docs]);
    expect(second.said).toEqual(['docs waits for you: Question: Which branch?']);
    // Back to work, then waiting again: said again.
    shop.state = 'working';
    shop.waiting = undefined;
    const third = announcements(second.next, [shop, docs]);
    expect(third.said).toEqual([]);
    shop.state = 'waiting';
    shop.waiting = { kind: 'permesso', tool: 'Bash', detail: 'Bash npm test', since: 3000 };
    expect(announcements(third.next, [shop, docs]).said).toEqual([waitSentence(shop)]);
    expect(waitSentence(shop)).toBe('shop waits for you: Permission: Bash npm test');
  });

  it('names the session and its state on a box, and the session on Allow and Deny', () => {
    const shop = agentOf('a-1', 'shop');
    shop.state = 'working';
    expect(boxLabel(shop, 'Bash npm test', true)).toBe('shop, working: Bash npm test');
    const outside = { ...shop, control: { kind: 'readonly' as const, reason: 'fuori-tmux' as const } };
    expect(boxLabel(outside, '', false)).toBe('shop, working (read only)');
    shop.permission = { ticket: 't', tool: 'Bash', detail: 'npm test', since: 1, until: 2 };
    expect(permissionTarget(shop)).toBe('Bash for shop');
  });
});

describe('the theme', () => {
  it('is dark, light, or what the system prefers; anything else is dark', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('system')).toBe('system');
    expect(parseTheme('blue')).toBe('dark');
    expect(parseTheme(null)).toBe('dark');
  });

  it('turns the terminal around on light: dark text on paper, the backgrounds of Claude Code light', () => {
    expect(terminalTheme(undefined, 'light')).toBe(TERMINAL_THEME_LIGHT);
    expect(terminalTheme(undefined)).toBe(TERMINAL_THEME);
    const light = extendedAnsi(true);
    const at = (index: number) => light[index - 16];
    expect(at(231)).toBe('#1f1e1c'); // the text of Claude Code
    expect(at(235)).toBe(TERMINAL_THEME_LIGHT.background); // its background, with no patch
    expect(at(22)).toBe('#d9efdc'); // an added line: a light band
    expect(light[100 - 16]).toBe(extendedAnsi()[100 - 16]); // the rest as the standard table
    const blue = terminalTheme('blue', 'light');
    expect(blue.background).toBe(tint('#faf9f5', '#5b9cf5'));
    expect(blue.foreground).toBe('#1f1e1c');
    expect(blue.extendedAnsi![235 - 16]).toBe(blue.background);
  });
});
