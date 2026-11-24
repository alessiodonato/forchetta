// What passes on the pipe of the host of a session (src/host/main.ts), after the two ends proved to be Forchetta
// (shared/pipe.ts): one JSON object per line. No Node module here.

/** What the host is told: each question has an id, and an answer with the same one. */
export type HostRequest =
  | { id: number; op: 'identity' }
  | { id: number; op: 'capture'; history: number }
  /** Keys of the daemon: not you at the keyboard. */
  | { id: number; op: 'keys'; data: string }
  /** A text as one block, when the program takes pastes so. */
  | { id: number; op: 'paste'; text: string }
  /** A window: from now on it gets what the session draws, and its size is the one of the session. */
  | { op: 'attach'; cols: number; rows: number }
  | { op: 'input'; data: string }
  | { op: 'resize'; cols: number; rows: number };

export interface HostIdentity {
  session: string;
  /** The pid of claude. */
  pid: number;
  /** When someone last typed in it, in seconds, as #{session_activity} of tmux. */
  activity: number;
}

export type HostMessage = { id: number; ok: true; identity?: HostIdentity; text?: string } | { id: number; ok: false; error: string } | { type: 'data'; data: string } | { type: 'exit'; code: number };

/** How a host is started: a file of the private folder, which it deletes as soon as it has read it. */
export interface HostSpec {
  session: string;
  agentId: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  pipe: string;
  key: string;
  /** Where it writes its record, once it listens; next to it, with .error, why it could not start. */
  record: string;
}

/** The record of a session that runs: how to reach its host. */
export interface HostRecord {
  session: string;
  agentId: string;
  pipe: string;
  key: string;
  hostPid: number;
  pid: number;
  startedAt: number;
}

export const SESSION_NAME = /^fk-[0-9a-f]{8}$/;

export const clampSize = (cols: unknown, rows: unknown): { cols: number; rows: number } => {
  const number = (value: unknown, min: number, max: number, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback);
  return { cols: number(cols, 20, 500, 120), rows: number(rows, 5, 200, 40) };
};

/**
 * What a terminal sends by itself, not typed: the answers to the questions of a program (DA, DSR, the colors, the
 * version). The host answers them once, with its own screen: the windows that are open would answer again.
 */
// eslint-disable-next-line no-control-regex
export const TERMINAL_REPLY = /^(?:\u001b\[[?>=]?[\d;]*c|\u001b\[\??\d+(?:;\d+)*R|\u001b\[\d+n|\u001b\[\?[\d;]+\$y|\u001b\](?:4|1\d);[^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001bP[^\u001b]*\u001b\\)+$/;
/** A terminal that gained or lost the keyboard: passed on, but nobody typed. */
// eslint-disable-next-line no-control-regex
export const FOCUS_REPORT = /^\u001b\[[IO]$/;
