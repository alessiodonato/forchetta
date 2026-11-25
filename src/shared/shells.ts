// A plain terminal in the folder of a session, next to the sessions: no Claude in it, and not a session. No Node module
// here: the page uses it too.

/** What can run in one: the shell of the user on a Mac and on Linux, PowerShell and Git Bash on Windows. */
export interface ShellKind {
  id: string;
  /** As it is called: "zsh", "PowerShell". */
  label: string;
}

export interface ShellInfo {
  id: string;
  /** The session it was opened from, while it is there. */
  agentId: string;
  /** The name of that session, and the folder. */
  name: string;
  cwd: string;
  kind: string;
  label: string;
}

/** The id of a plain terminal, told from the id of a session. */
export const SHELL_ID = /^shell-[0-9a-f-]{36}$/;
export const isShellId = (id: string): boolean => SHELL_ID.test(id);
