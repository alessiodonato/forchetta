import { closeSync, fstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';

// The log of the daemon (daemon.log in the private folder): a line for each thing worth knowing, in English, with
// its level. The daemon writes it itself and rotates it: past MAX_BYTES it becomes daemon.log.1 (then .2, .3) and a
// new one starts. What a crash prints goes there too, from the stderr of the daemon.

export type LogLevel = 'info' | 'warn' | 'error';
export type Log = (message: string, level?: LogLevel) => void;

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

/** "2026-11-20T08:32:16.931Z WARN  the message" */
export const logLine = (level: LogLevel, message: string, now = new Date()): string => `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`;

export class LogFile {
  private fd: number | undefined;
  private size = 0;

  constructor(
    private readonly file: string,
    private readonly options: { maxBytes?: number; keep?: number; echo?: (line: string) => void } = {},
  ) {}

  private open(): number | undefined {
    if (this.fd !== undefined) return this.fd;
    try {
      this.fd = openSync(this.file, 'a', 0o600);
      this.size = fstatSync(this.fd).size;
    } catch {
      this.fd = undefined;
    }
    return this.fd;
  }

  /** daemon.log → daemon.log.1 → .2 → .3, the oldest gone. */
  private rotate(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    const keep = this.options.keep ?? KEEP;
    try {
      rmSync(`${this.file}.${keep}`, { force: true });
      for (let n = keep - 1; n >= 1; n--) {
        try {
          renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`);
        } catch {
          // Not there yet.
        }
      }
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // It stays one file: better a long log than none.
    }
  }

  write(level: LogLevel, message: string): void {
    const line = logLine(level, message);
    this.options.echo?.(line);
    const fd = this.open();
    if (fd === undefined) return;
    try {
      this.size += writeSync(fd, line);
    } catch {
      return;
    }
    if (this.size > (this.options.maxBytes ?? MAX_BYTES)) this.rotate();
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}

/** The log function of the daemon: into its file, and on the terminal when one runs it by hand. */
export function createLog(file: string, echo = Boolean(process.stdout.isTTY)): { log: Log; close: () => void } {
  const out = new LogFile(file, { echo: echo ? (line) => process.stdout.write(line) : undefined });
  return { log: (message, level = 'info') => out.write(level, message), close: () => out.close() };
}
