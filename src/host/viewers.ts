import type { Screen } from './screen.ts';

/**
 * The windows that look at a session. Each gets the screen as it was when it came, and then all that is drawn after that.
 *
 * The screen reads what it is given a little later (a turn of the event loop). What is drawn between the question and the
 * answer is not on the screen that is sent, so it is kept, and sent after it. A window that comes changes the size of the
 * session, and Claude Code draws all of it again: that is just what would be lost.
 */
export class Viewers<T> {
  /** With what it waits for, or undefined when it has had its screen. */
  private readonly all = new Map<T, string[] | undefined>();

  constructor(
    private readonly screen: Pick<Screen, 'settled' | 'snapshot'>,
    private readonly send: (viewer: T, data: string) => void,
  ) {}

  add(viewer: T): void {
    const late: string[] = [];
    this.all.set(viewer, late);
    this.screen.settled(() => {
      // Gone meanwhile, or come again.
      if (this.all.get(viewer) !== late) return;
      this.all.set(viewer, undefined);
      this.send(viewer, this.screen.snapshot());
      for (const data of late) this.send(viewer, data);
    });
  }

  /** What the session draws. The screen must have it before, or it would be sent twice. */
  drawn(data: string): void {
    for (const [viewer, late] of this.all) {
      if (late) late.push(data);
      else this.send(viewer, data);
    }
  }

  delete(viewer: T): void {
    this.all.delete(viewer);
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.all.keys();
  }
}
