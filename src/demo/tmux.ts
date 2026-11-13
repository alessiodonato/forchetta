// The tmux of the demo, for the Commander of the daemon (daemon/commands.ts): it answers the few commands it runs
// by reading and typing into the terminals of the fake sessions.

import type { TmuxCommand, TmuxResult } from '../shared/tmux.ts';
import { readText } from './shims/fs.ts';
import type { FakeTerminal } from './terminal.ts';

export interface Pane {
  pane: string;
  session: string;
  pid: number;
  terminal: FakeTerminal;
  /** Keys typed by the daemon, as tmux send-keys would. */
  type: (data: string) => void;
}

const later = (run: () => void): void => void setTimeout(run, 15);
const ok = (stdout = ''): TmuxResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): TmuxResult => ({ code: 1, stdout: '', stderr });

export class FakeTmux {
  private readonly panes = new Map<string, Pane>();
  private readonly buffers = new Map<string, string>();
  private next = 1;

  /** A new pane: its id, as tmux names them. */
  add(input: Omit<Pane, 'pane'>): Pane {
    const pane = { ...input, pane: `%${this.next++}` };
    this.panes.set(pane.pane, pane);
    return pane;
  }

  remove(pane: string): void {
    this.panes.delete(pane);
  }

  private find(target: string | undefined): Pane | undefined {
    if (!target) return undefined;
    return this.panes.get(target) ?? [...this.panes.values()].find((pane) => pane.session === target);
  }

  async run(command: TmuxCommand, args: readonly string[]): Promise<TmuxResult> {
    const target = args[args.indexOf('-t') + 1];
    const pane = args.includes('-t') ? this.find(target) : undefined;
    switch (command) {
      case 'display-message': {
        if (!pane) return fail("can't find pane");
        const format = args.at(-1) ?? '';
        return ok(
          `${format
            .replace('#{session_name}', pane.session)
            .replace('#{pane_pid}', String(pane.pid))
            .replace('#{session_activity}', String(Math.floor(pane.terminal.lastInput / 1000)))
            .replace('#{pane_in_mode}', '0')}\n`,
        );
      }
      case 'capture-pane':
        return pane ? ok(`${pane.terminal.capture()}\n`) : fail("can't find pane");
      case 'send-keys': {
        if (!pane) return fail("can't find pane");
        const keys = args.slice(args.indexOf('-t') + 2);
        const text =
          keys[0] === '-H'
            ? new TextDecoder().decode(new Uint8Array(keys.slice(1).map((hex) => Number.parseInt(hex, 16))))
            : keys.map((key) => (key === 'Enter' ? '\r' : key === 'Escape' ? '\x1b' : key === 'C-c' ? '\x03' : key)).join('');
        // As with a real tmux, the keys reach the program a moment after the command returns.
        later(() => pane.type(text));
        return ok();
      }
      case 'load-buffer': {
        const name = args[args.indexOf('-b') + 1] ?? '';
        const text = readText(args.at(-1) ?? '');
        if (text === undefined) return fail('no file');
        this.buffers.set(name, text);
        return ok();
      }
      case 'paste-buffer': {
        const name = args[args.indexOf('-b') + 1] ?? '';
        const text = this.buffers.get(name);
        if (!pane || text === undefined) return fail('no buffer');
        if (args.includes('-d')) this.buffers.delete(name);
        later(() => pane.type(args.includes('-p') ? `\x1b[200~${text}\x1b[201~` : text));
        return ok();
      }
      case 'has-session':
        return pane || this.find(target) ? ok() : fail("can't find session");
      default:
        return ok();
    }
  }
}
