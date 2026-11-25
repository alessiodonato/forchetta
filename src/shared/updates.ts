// A new version of Forchetta, as the page says it. No Node module here: the page uses it too.

/**
 * How this Forchetta was installed: with Homebrew, or with the installer of Windows and Linux, it can update itself. A clone, or a
 * folder put there by hand, cannot.
 */
export type InstallKind = 'brew' | 'installer' | 'clone' | 'other';

/** An update under way, or how the last one went. */
export interface UpdateRun {
  /** hooks: the new version is in place, and its hooks are other ones: you say whether to apply them. */
  state: 'running' | 'hooks' | 'done' | 'failed';
  from: string;
  to: string;
  at: number;
  /** What it is doing; why it failed. */
  text?: string;
  /** The changes of the hooks, a line each, while you decide. */
  changes?: string[];
  /** The process that does it. */
  pid?: number;
}

export interface UpdateInfo {
  current: string;
  /** Newer than this one, and not one you hid. */
  latest?: string;
  run?: UpdateRun;
  /** What to type to do it by hand. */
  command: string;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

/** The numbers of a version; a beta comes before its release. Undefined for what is not one. */
const numbers = (version: string): number[] | undefined => {
  const match = VERSION.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Number.POSITIVE_INFINITY : Number(match[4])] : undefined;
};

export function isNewer(candidate: string, current: string): boolean {
  const a = numbers(candidate);
  const b = numbers(current);
  if (!a || !b) return false;
  for (let index = 0; index < 4; index++) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
}

/** The version a formula of Homebrew installs. */
export const formulaVersion = (text: string): string | undefined => /\/releases\/download\/v(\d+\.\d+\.\d+)\//.exec(text)?.[1];

const STATES = ['running', 'hooks', 'done', 'failed'];

/** A run as its file has it, checked. */
export function runOf(raw: unknown): UpdateRun | undefined {
  const run = raw as Partial<UpdateRun> | undefined;
  if (!run || typeof run !== 'object' || !STATES.includes(run.state as string) || typeof run.from !== 'string' || typeof run.to !== 'string' || typeof run.at !== 'number') return undefined;
  return {
    state: run.state!,
    from: run.from,
    to: run.to,
    at: run.at,
    ...(typeof run.text === 'string' ? { text: run.text.slice(0, 600) } : {}),
    ...(Array.isArray(run.changes) ? { changes: run.changes.filter((line): line is string => typeof line === 'string').slice(0, 60) } : {}),
    ...(typeof run.pid === 'number' ? { pid: run.pid } : {}),
  };
}
