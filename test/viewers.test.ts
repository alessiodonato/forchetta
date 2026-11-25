import { describe, expect, it } from 'vitest';
import { consoleBuild } from '../src/daemon/pty.ts';
import { Screen } from '../src/host/screen.ts';
import { Viewers } from '../src/host/viewers.ts';
import { sleep } from './helpers.ts';

// The windows that look at a session of a host: nothing of what it draws is lost, and nothing comes twice.

const FULL = (cols: number, rows: number): string => `\u001b[2J\u001b[H❯ say hello\r\n● hi\u001b[${rows - 3};1H${'─'.repeat(cols)}\u001b[${rows - 2};1H❯ `;

function session() {
  const screen = new Screen({ cols: 200, rows: 50 }, 22000);
  const got = new Map<string, string>();
  const viewers = new Viewers<string>(screen, (viewer, data) => got.set(viewer, (got.get(viewer) ?? '') + data));
  const draw = (data: string): void => {
    screen.write(data);
    viewers.drawn(data);
  };
  // A full screen, as Claude Code has it: the question on top, the prompt at the bottom.
  draw(`\u001b[?1049h${FULL(200, 50)}`);
  return { screen, got, viewers, draw };
}

/** What a window shows of what it got. */
async function shown(data: string): Promise<string> {
  const screen = new Screen({ cols: 110, rows: 32 }, 22000);
  screen.write(data);
  await new Promise<void>((done) => screen.settled(done));
  return screen.capture(0);
}

describe('a window that comes while the session draws', () => {
  for (const [when, wait] of [
    ['at once', (run: () => void) => run()],
    ['in the same turn', (run: () => void) => setImmediate(run)],
    ['a moment later', (run: () => void) => setTimeout(run, 1)],
    ['after a while', (run: () => void) => setTimeout(run, 40)],
  ] as const) {
    it(`sees what is drawn ${when}`, async () => {
      for (let round = 0; round < 10; round++) {
        const { screen, got, viewers, draw } = session();
        await sleep(20);
        // Its size is the one of the session, and the session draws all of it again.
        screen.resize({ cols: 110, rows: 32 });
        viewers.add('window');
        wait(() => draw(FULL(110, 32)));
        await sleep(80);
        expect(await shown(got.get('window') ?? '')).toBe(screen.capture(0));
        expect(screen.capture(0)).toContain('say hello');
      }
    });
  }

  it('gets each thing once, in its order', async () => {
    const { got, viewers, draw } = session();
    await sleep(20);
    viewers.add('first');
    await sleep(20);
    draw('\u001b[10;1Hone');
    viewers.add('second');
    draw('\u001b[11;1Htwo');
    draw('\u001b[12;1Hthree');
    await sleep(20);
    draw('\u001b[13;1Hfour');
    for (const viewer of ['first', 'second']) {
      const text = got.get(viewer)!;
      const at = ['one', 'two', 'three', 'four'].map((word) => [text.indexOf(word), text.lastIndexOf(word)] as const);
      for (const [first, last] of at) expect(first).toBe(last);
      expect(at.map(([first]) => first)).toEqual([...at.map(([first]) => first)].sort((a, b) => a - b));
      expect(at[0]![0]).toBeGreaterThan(-1);
    }
  });

  it('that goes at once gets nothing; one that comes again gets a new screen', async () => {
    const { got, viewers, draw } = session();
    viewers.add('gone');
    viewers.delete('gone');
    viewers.add('again');
    viewers.add('again');
    draw('\u001b[10;1Hlater');
    await sleep(20);
    expect(got.has('gone')).toBe(false);
    expect([...viewers]).toEqual(['again']);
    expect(got.get('again')!.split('say hello')).toHaveLength(2);
    expect(got.get('again')!.split('later')).toHaveLength(2);
  });
});

describe('the console a session draws in', () => {
  it('is the one of Windows 11 when node-pty brings its own', () => {
    expect(consoleBuild(19045, true)).toBe(22000);
    expect(consoleBuild(20348, true)).toBe(22000);
    expect(consoleBuild(26100, false)).toBe(26100);
    // The one of node-pty did not open: it is the one of that Windows.
    expect(consoleBuild(19045, false)).toBe(19045);
    expect(consoleBuild(undefined, false)).toBeUndefined();
  });
});
