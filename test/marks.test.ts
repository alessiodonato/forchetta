import { describe, expect, it } from 'vitest';
import { type FirstCell, messageRows } from '../src/ui/marks.ts';

// The first cells are those Claude Code 2.1.332 draws, recorded from the real one: in tmux, outside it, on both its themes.

const none: FirstCell = { text: ' ', background: 'default', color: -1 };
const palette = (color: number, text = ' '): FirstCell => ({ text, background: 'palette', color });
const rgb = (color: number, text = ' '): FirstCell => ({ text, background: 'rgb', color });

describe('your messages in a terminal', () => {
  it('are the lines on their background, in tmux', () => {
    expect(messageRows([none, palette(237, '❯'), palette(237), none, none, palette(237, '❯'), none])).toEqual([
      { top: 1, bottom: 2 },
      { top: 5, bottom: 5 },
    ]);
  });
  it('are found outside tmux too, and on the light theme', () => {
    for (const color of [0x373737, 0xf0f0f0]) expect(messageRows([none, rgb(color, '❯'), rgb(color), none])).toEqual([{ top: 1, bottom: 2 }]);
    expect(messageRows([palette(255, '❯'), none])).toEqual([{ top: 0, bottom: 0 }]);
  });
  it('are what you run with ! as well', () => {
    for (const cell of [palette(59, '!'), rgb(0x413c41, '!'), rgb(0xfaf5fa, '!')]) expect(messageRows([cell])).toEqual([{ top: 0, bottom: 0 }]);
  });
  it('go on when their start is above the screen, and end one after the other', () => {
    expect(messageRows([palette(237), palette(237), none])).toEqual([{ top: 0, bottom: 1 }]);
    expect(messageRows([palette(237, '❯'), palette(237, '❯')])).toEqual([
      { top: 0, bottom: 0 },
      { top: 1, bottom: 1 },
    ]);
  });
  it('are not the box of the prompt, the diffs, nor what another program paints', () => {
    expect(messageRows([{ ...none, text: '❯' }, palette(22), palette(52), palette(174), rgb(0xd77757), rgb(0x000000), undefined])).toEqual([]);
  });
  it('are ❯ on any gray, for a theme not listed', () => {
    expect(messageRows([rgb(0x2b2c2e, '❯'), rgb(0x2b2c2e), none])).toEqual([{ top: 0, bottom: 1 }]);
    expect(messageRows([rgb(0x802020, '❯')])).toEqual([]);
  });
});
