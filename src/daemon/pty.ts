import { createRequire } from 'node:module';

// node-pty, the pseudo-terminals of the panes: native, and loaded from node_modules the first time one opens. Its
// binaries come with it for a Mac; for Linux they are compiled (CI, or pnpm in a clone), so they may not be there.

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

/** Why the terminals cannot open (no binary for this computer, say), in a line; undefined when they can. */
export function ptyProblem(load: () => unknown = loadPty): string | undefined {
  try {
    load();
    return undefined;
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);
  }
}
