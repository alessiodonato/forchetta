import { createRequire } from 'node:module';
import { release } from 'node:os';
import { backslashes, WINDOWS } from '../shared/fspath.ts';

// node-pty, the pseudo-terminals of the panes: native, and loaded from node_modules the first time one opens. Its
// binaries come with it for a Mac and for Windows; for Linux they are compiled (CI, or pnpm in a clone), so they may not be
// there.

export interface Pty {
  readonly pid: number;
  /** The program in front, where the system says it (not on Windows). */
  readonly process?: string;
  onData(listener: (data: Buffer | string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string | Buffer): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): Pty;
}

let ptyModule: PtyModule | undefined;

export function loadPty(): PtyModule {
  ptyModule ??= createRequire(import.meta.url)('node-pty') as PtyModule;
  return ptyModule;
}

/** Windows 11: its own console draws all that Claude Code asks. Before, the one that comes with node-pty. */
const WINDOWS_11 = 22000;
export const windowsBuild = WINDOWS ? Number(release().split('.')[2]) || undefined : undefined;

/** Whether the console that comes with node-pty was the one to open. */
let ownConsole = false;

/**
 * The build of Windows whose console draws here, for what reads it as it draws: the one of node-pty works as that of
 * Windows 11, also on a Windows before it. After openPty.
 */
export const consoleBuild = (build = windowsBuild, own = ownConsole): number | undefined => (build === undefined ? undefined : own ? Math.max(build, WINDOWS_11) : build);

/** A program in a pseudo-terminal; on Windows its paths as Windows has them, and the console that draws best there. */
export function openPty(pty: PtyModule, file: string, args: string[], options: Record<string, unknown> & { cwd: string }): Pty {
  if (!WINDOWS) return pty.spawn(file, args, options);
  const own = windowsBuild !== undefined && windowsBuild < WINDOWS_11;
  const there = { ...options, cwd: backslashes(options.cwd) };
  try {
    const opened = pty.spawn(backslashes(file), args, { ...there, useConptyDll: own });
    ownConsole = own;
    return opened;
  } catch (error) {
    if (!own) throw error;
    ownConsole = false;
    return pty.spawn(backslashes(file), args, there);
  }
}

/** Windows loads the binary only when a terminal opens, and may refuse it then (Smart App Control): one that ends at once. */
function openOne(): void {
  const pty = loadPty();
  if (process.platform !== 'win32') return;
  const trial = pty.spawn(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`, ['/d', '/c', 'exit'], { cols: 80, rows: 24 });
  trial.onExit(() => {});
}

let lastProblem: { text?: string } | undefined;

/** Why the terminals cannot open (no binary for this computer, say), in a line; undefined when they can. */
export function ptyProblem(load?: () => unknown): string | undefined {
  if (!load && lastProblem) return lastProblem.text;
  let text: string | undefined;
  try {
    (load ?? openOne)();
  } catch (error) {
    text = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);
  }
  if (!load) lastProblem = text === undefined ? {} : { text };
  return text;
}
