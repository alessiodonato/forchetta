// Panes scrolled back in the history of tmux (copy mode): the wheel in a pane puts it there, and from then on the
// keys go to tmux, not to Claude Code, until you scroll to the end or press q. Easy to miss: the pane of the app
// says so, with a button that brings it back. One `list-panes` for every pane, about once a second, only while a
// window shows the sessions and some terminal is open.

import type { Agent } from '../shared/agent.ts';

/** The format of `tmux list-panes -a -F`: session, pane, whether it is in a mode (copy mode). */
export const PANE_MODES_FORMAT = '#{session_name}\t#{pane_id}\t#{pane_in_mode}';

/** Pane id and session name -> in copy mode, from the output of `list-panes` with PANE_MODES_FORMAT. */
export function paneModes(stdout: string): Map<string, boolean> {
  const modes = new Map<string, boolean>();
  for (const line of stdout.split('\n')) {
    const [session, pane, mode] = line.split('\t');
    if (!session || !pane || mode === undefined) continue;
    const scrolled = mode.trim() === '1';
    modes.set(pane, scrolled);
    // A session with several panes: scrolled back if any of them is.
    modes.set(session, (modes.get(session) ?? false) || scrolled);
  }
  return modes;
}

/** Whether the pane of a session open in the app is scrolled back now; false for the others. */
export function scrolledBack(agent: Agent, openSessions: ReadonlySet<string>, modes: ReadonlyMap<string, boolean>): boolean {
  if (agent.control.kind !== 'tmux' || agent.state === 'ended' || !openSessions.has(agent.control.session)) return false;
  const byPane = agent.control.paneId ? modes.get(agent.control.paneId) : undefined;
  return byPane ?? modes.get(agent.control.session) ?? false;
}
