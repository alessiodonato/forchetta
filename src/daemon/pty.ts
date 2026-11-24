import { createRequire } from 'node:module';

// node-pty, the pseudo-terminals of the panes: native, and loaded from node_modules the first time one opens. Its
// binaries come with it for a Mac and for Windows; for Linux they are compiled (CI, or pnpm in a clone), so they may not be
// there.

export interface Pty {
  readonly pid: number;
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
