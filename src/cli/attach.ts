import type { Pty } from '../daemon/pty.ts';
import { HostSessions } from '../shared/host-sessions.ts';

// This terminal on a session, on Windows: what `tmux attach` does elsewhere. Ctrl-b d leaves it, as in tmux, and so does
// closing the window: the session goes on. Ctrl-b twice types one.

const PREFIX = '\u0002';
/** What a program may have turned on in the terminal: pastes as blocks, the mouse, the focus, a hidden cursor. */
const RESET = '\u001b[?2004l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1004l\u001b[?25h\u001b[0m\r\n';

/** The keys typed, told apart: what goes to the session, and whether to leave it. */
export class Prefix {
  private waiting = false;

  push(text: string): { send: string; leave: boolean } {
    let send = '';
    for (const key of text) {
      if (this.waiting) {
        this.waiting = false;
        if (key === 'd') return { send, leave: true };
        send += key === PREFIX ? PREFIX : PREFIX + key;
      } else if (key === PREFIX) this.waiting = true;
      else send += key;
    }
    return { send, leave: false };
  }
}

/** Attaches this terminal to a session until it ends or you leave it; the exit code. */
export function attachHere(session: string, sessions = new HostSessions()): Promise<number> {
  const { stdin, stdout } = process;
  let pty: Pty;
  try {
    pty = sessions.attach(session, stdout.columns || 120, stdout.rows || 40);
  } catch {
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    const prefix = new Prefix();
    const onKeys = (chunk: Buffer): void => {
      const { send, leave } = prefix.push(chunk.toString('utf8'));
      if (send) pty.write(send);
      if (leave) end(0);
    };
    const onResize = (): void => pty.resize(stdout.columns || 120, stdout.rows || 40);
    const end = (code: number): void => {
      stdin.removeListener('data', onKeys);
      stdout.removeListener('resize', onResize);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      pty.kill();
      stdout.write(RESET);
      resolve(code);
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKeys);
    stdout.on('resize', onResize);
    pty.onData((data) => stdout.write(data));
    pty.onExit(({ exitCode }) => end(exitCode));
  });
}
