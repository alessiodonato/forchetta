// What the page and `forchetta doctor` know of the installation: whether the hooks, tmux and Claude Code are in
// place (the checklist of the first start), which optional features are on and why not, the version of Claude Code
// against the one Forchetta was tested with, and the settings you can change from the app. No Node module here: the
// page uses it too.

/**
 * The version of the messages between the daemon and the page. A page of another protocol (an app or a window left
 * open across an upgrade) is told to reload, instead of misreading what the daemon sends.
 */
export const PROTOCOL = 3;

/** The Claude Code this Forchetta was tested with; a newer minor version is said in the top line. */
export const TESTED_CLAUDE = '2.1.322';

export interface SetupCheck {
  id: 'hooks' | 'statusline' | 'tmux' | 'claude' | 'socket' | 'events';
  ok: boolean;
  /** What it is: "Hooks in ~/.claude/settings.json". */
  label: string;
  /** What was found, or what is wrong. */
  detail?: string;
  /** A command that fixes it, to copy into a terminal. */
  fix?: string;
}

export interface OptionalFeature {
  id: 'arricurdai' | 'notes' | 'haiku' | 'keepalive';
  on: boolean;
  label: string;
  /** What it gives, or why it is off. */
  why: string;
  /** How to turn it on, when it is off. */
  how?: string;
  link?: string;
}

export interface ClaudeVersionInfo {
  installed?: string;
  tested: string;
  /** Newer than the tested one: in its minor version (said in the top line), or only in its patch. */
  newer?: 'minor' | 'patch';
}

/** The settings of var/config.json that the app changes. */
export interface EditableSettings {
  guard: { files: boolean; git: boolean; notes: boolean; servers: boolean };
  /** Minutes with no event after which a session at work is shown as stalled. */
  stallMin: number;
  /** Minutes a finished session stays in the list. */
  endedRetentionMin: number;
  /** A fifth pane replaces the least recently used one ('lru'), or asks ('chiedi'). */
  replace: 'lru' | 'chiedi';
  /** The shortcut that shows or hides the app from anywhere: "ctrl+alt+f", or "" for none. */
  hotkey: string;
  port: number;
  haiku: boolean;
}

export interface SystemInfo {
  version: string;
  protocol: number;
  checks: SetupCheck[];
  features: OptionalFeature[];
  claude: ClaudeVersionInfo;
  settings: EditableSettings;
  /** The private folder and the log, with ~ for the home. */
  varDir: string;
  logFile: string;
}

/** 2.1.322 → [2, 1, 322]; anything after the numbers is left out. */
const parts = (version: string): number[] => (/^(\d+)\.(\d+)\.(\d+)/.exec(version.trim()) ?? []).slice(1).map(Number);

/** Negative, zero or positive, as a is older than, the same as, or newer than b. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether Claude Code is newer than the version tested: in its major or minor version, or only in its patch. */
export function newerThanTested(installed: string | undefined, tested = TESTED_CLAUDE): ClaudeVersionInfo['newer'] {
  if (!installed || parts(installed).length < 3) return undefined;
  const [x, y] = [parts(installed), parts(tested)];
  if (x[0]! > y[0]! || (x[0] === y[0] && x[1]! > y[1]!)) return 'minor';
  return compareVersions(installed, tested) > 0 ? 'patch' : undefined;
}

const HOTKEY = /^((ctrl|alt|cmd|shift)\+)+[a-z0-9]$/;

/** The settings as the app sends them, checked; or what is wrong, in a line for the panel. */
export function cleanSettings(input: unknown): { settings: EditableSettings } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'no settings' };
  const raw = input as Record<string, unknown>;
  const guard = (raw.guard && typeof raw.guard === 'object' ? raw.guard : {}) as Record<string, unknown>;
  const minutes = (value: unknown, what: string, max: number): number | { error: string } => {
    const number = typeof value === 'string' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > max) return { error: `${what}: a whole number of minutes, from 1 to ${max}` };
    return number;
  };
  const stallMin = minutes(raw.stallMin, 'stuck after', 240);
  if (typeof stallMin !== 'number') return stallMin;
  const endedRetentionMin = minutes(raw.endedRetentionMin, 'finished sessions stay', 1440);
  if (typeof endedRetentionMin !== 'number') return endedRetentionMin;
  const hotkey = typeof raw.hotkey === 'string' ? raw.hotkey.trim().toLowerCase().replace(/\s+/g, '') : '';
  if (hotkey && !HOTKEY.test(hotkey)) return { error: 'the shortcut is like ctrl+alt+f: ctrl, alt, cmd or shift, then a letter or a digit' };
  const port = typeof raw.port === 'string' ? Number(raw.port) : raw.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) return { error: 'the port is a number from 1024 to 65535' };
  return {
    settings: {
      guard: { files: guard.files !== false, git: guard.git !== false, notes: guard.notes !== false, servers: guard.servers !== false },
      stallMin,
      endedRetentionMin,
      replace: raw.replace === 'chiedi' ? 'chiedi' : 'lru',
      hotkey,
      port,
      haiku: raw.haiku === true,
    },
  };
}

/** The settings that take effect only after the daemon starts again. */
export function needsRestart(before: EditableSettings, after: EditableSettings): string[] {
  const changed: string[] = [];
  if (before.port !== after.port) changed.push('the port');
  if (before.haiku !== after.haiku) changed.push('the Haiku summaries');
  return changed;
}
