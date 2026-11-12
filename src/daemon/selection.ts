import type { CommanderTmux } from './commands.ts';

// The text you select with the mouse in a pane. tmux selects it (mouse on, config/tmux.conf) and, when you let go,
// copies it into a new buffer of its own (buffer0, buffer1…: the numbers only grow) and to the clipboard of the Mac.
// The page says when the mouse is pressed and when a drag ends; the daemon notes the newest buffer at the press, and
// at the end reads the one that came after it. A click, or a drag that tmux did not take (an Option-drag is selected
// by the terminal of the page), makes no new buffer: nothing to read. Verified with tmux 3.7b.
//
// The press and the copy reach the daemon and tmux by two ways (this WebSocket, and the terminal of the pane): in a
// very quick drag tmux may copy before the daemon has looked, and then no buffer comes after the one it saw. So when
// none comes for a moment, the newest counts as the copy of this drag if tmux made it after the press (its time is in
// seconds) and no drag read it before.

const AUTOMATIC = /^buffer\d+$/;
const WAIT_MS = 1000;
const STEP_MS = 50;
/** After this, with no new buffer, the one seen at the press may be the copy of a very quick drag. */
const QUICK_MS = 300;
/** The buffers read lately: never the copy of another drag. */
const KEEP_READ = 50;

interface TmuxBuffer {
  name: string;
  /** When tmux made it, in seconds. */
  created: number;
}

export class SelectionReader {
  /** The newest buffer when the mouse was pressed, by agent, and when. */
  private readonly starts = new Map<string, { newest: Promise<TmuxBuffer | undefined>; at: number }>();
  private readonly read: string[] = [];

  constructor(
    private readonly tmux: CommanderTmux,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  /** The newest buffer that tmux made by itself, not one of Forchetta's (forchetta-…). */
  private async newest(): Promise<TmuxBuffer | undefined> {
    const listed = await this.tmux.run('list-buffers', ['-F', '#{buffer_name}\t#{buffer_created}']);
    if (listed.code !== 0) return undefined;
    for (const line of listed.stdout.split('\n')) {
      const [name, created] = line.trim().split('\t');
      if (name && AUTOMATIC.test(name)) return { name, created: Number(created) || 0 };
    }
    return undefined;
  }

  start(agentId: string): void {
    this.starts.set(agentId, { newest: this.newest(), at: this.now() });
  }

  /** The text of the drag that ended, or undefined if tmux copied nothing. */
  async end(agentId: string, waitMs = WAIT_MS): Promise<string | undefined> {
    const start = this.starts.get(agentId);
    if (!start) return undefined;
    this.starts.delete(agentId);
    const before = await start.newest;
    const pressed = Math.floor(start.at / 1000);
    // tmux copies when the release reaches it, through the terminal of the pane: a moment after the page saw it.
    for (let waited = 0; ; waited += STEP_MS) {
      const buffer = await this.newest();
      const fresh = buffer !== undefined && buffer.name !== before?.name;
      const quick = buffer !== undefined && waited >= QUICK_MS && buffer.name === before?.name && buffer.created >= pressed && !this.read.includes(buffer.name);
      if (buffer && (fresh || quick)) {
        this.read.push(buffer.name);
        if (this.read.length > KEEP_READ) this.read.shift();
        const shown = await this.tmux.run('show-buffer', ['-b', buffer.name]);
        return shown.code === 0 && shown.stdout.trim() ? shown.stdout : undefined;
      }
      if (waited >= waitMs) return undefined;
      await this.sleep(STEP_MS);
    }
  }
}
