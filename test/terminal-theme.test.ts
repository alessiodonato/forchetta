import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../src/daemon/static.ts';
import { extendedAnsi, standard256, TERMINAL_THEME } from '../src/ui/terminal-theme.ts';

// The terminal of a pane: the colors Claude Code meant, where tmux makes it send the nearest of the 256.

describe('the colors of the terminal', () => {
  it('gives each index Claude Code uses the color it stands for', () => {
    const colors = extendedAnsi();
    expect(colors).toHaveLength(240);
    const at = (index: number) => colors[index - 16];
    expect(at(174)).toBe('#d97757'); // claude, not the pink of the standard table
    expect(at(147)).toBe('#af87ff'); // auto-accept: purple, apart from the blue of permissions
    expect(at(153)).toBe('#b1b9f9'); // permission
    expect(at(22)).toBe('#234a2d'); // added line of an edit
    expect(at(52)).toBe('#5a2a31'); // removed line of an edit
    expect(TERMINAL_THEME.extendedAnsi).toEqual(colors);
  });

  it('leaves every other index as the standard table has it', () => {
    const colors = extendedAnsi();
    expect(colors[100 - 16]).toBe(standard256(100));
    expect(standard256(16)).toBe('#000000');
    expect(standard256(100)).toBe('#878700');
    expect(standard256(196)).toBe('#ff0000');
    expect(standard256(232)).toBe('#080808');
    expect(standard256(255)).toBe('#eeeeee');
    expect(colors[167 - 16]).toBe('#d75f5f'); // a color of the syntax highlighting, untouched
  });

  it('lets the page load its own font, and no other', () => {
    expect(contentSecurityPolicy(47821)).toContain("font-src 'self'");
    expect(contentSecurityPolicy(47821)).toContain("default-src 'none'");
  });
});
