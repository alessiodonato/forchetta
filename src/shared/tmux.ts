import { execFile } from 'node:child_process';

// The only way Forchetta talks to tmux. It runs a private tmux server, with its own socket and
// configuration, and it can run only the commands below. None of them ends a session, a window, a pane or
// the server: closing a pane in Forchetta detaches a client, and nothing in the code can do more.

export const TMUX_ALLOWED = [
  'new-session',
  'attach-session',
  'send-keys',
  'capture-pane',
  'list-panes',
  'display-message',
  'has-session',
] as const;

export type TmuxCommand = (typeof TMUX_ALLOWED)[number];

export class TmuxRefused extends Error {
  override name = 'TmuxRefused';
}

const allowed = new Set<string>(TMUX_ALLOWED);

/** The name of the tmux session of an agent started with `forchetta run`. */
export const tmuxSessionName = (agentId: string): string => `fk-${agentId.slice(0, 8)}`;

export interface TmuxResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class Tmux {
  constructor(
    readonly bin: string,
    readonly socket: string,
    readonly conf: string,
  ) {}

  /**
   * The arguments of one tmux command. tmux reads an argument that is `;` or ends with `;` as the end of a
   * command, so such an argument could chain a second command: it is refused.
   */
  argv(command: string, args: readonly string[]): string[] {
    if (!allowed.has(command)) throw new TmuxRefused(`comando tmux non permesso: ${command}`);
    for (const arg of args) {
      if (arg.endsWith(';')) throw new TmuxRefused(`argomento tmux non permesso (finisce con ";"): ${JSON.stringify(arg)}`);
    }
    // -u: UTF-8 also when LANG is not set, as for an app opened from the Finder.
    return ['-u', '-S', this.socket, '-f', this.conf, command, ...args];
  }

  run(command: TmuxCommand, args: readonly string[], timeoutMs = 5000): Promise<TmuxResult> {
    const argv = this.argv(command, args);
    return new Promise((resolve) => {
      execFile(this.bin, argv, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
}

export interface PaneInfo {
  paneId: string;
  panePid: number;
  session: string;
}

/** The panes of the private server, or none when it is not running. */
export async function listPanes(tmux: Tmux): Promise<PaneInfo[]> {
  const result = await tmux.run('list-panes', ['-a', '-F', '#{pane_id}\t#{pane_pid}\t#{session_name}']);
  if (result.code !== 0) return [];
  const panes: PaneInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    const [paneId, pid, session] = line.split('\t');
    const panePid = Number(pid);
    if (paneId && session && Number.isInteger(panePid)) panes.push({ paneId, panePid, session });
  }
  return panes;
}
