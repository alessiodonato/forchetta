import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// The files where Forchetta keeps what you made (templates, presets, skills, teams, the state of the sessions):
// written whole or not at all, the version before kept as <file>.bak, and never written over when they cannot be
// read. A file that does not parse is set aside as <file>.corrupt-<time>, and the version before takes its place;
// entries that are not valid any more are kept in <file>.rejected.json, so that saving again loses nothing.

/** The time in a name of a file: 2026-11-20T10-31-02. */
const stamp = (now = new Date()): string => now.toISOString().slice(0, 19).replace(/:/g, '-');

/**
 * Writes a data file whole: a temporary file next to it, flushed to the disk, then renamed over it. The version
 * before stays as <file>.bak (a second name of the same file: it costs nothing).
 */
export function writeDataFile(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(file)) {
      const backup = `${file}.bak`;
      try {
        rmSync(backup, { force: true });
        linkSync(file, backup);
      } catch {
        // No backup this time: the file is written all the same.
      }
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** A data file as JSON, written by writeDataFile. */
export const writeDataJson = (file: string, value: unknown, pretty = true): void => writeDataFile(file, `${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`);

/**
 * Reads a data file as JSON: undefined when there is none. One that cannot be read is set aside as
 * <file>.corrupt-<time> (so that nothing writes over it) and the version before, <file>.bak, is read in its place.
 * `label` names it in the log.
 */
export function readDataJson(file: string, label: string, log: (message: string, level?: 'info' | 'warn' | 'error') => void, now = new Date()): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    const aside = `${file}.corrupt-${stamp(now)}`;
    try {
      renameSync(file, aside);
      log(`${label}: file not readable (${error instanceof Error ? error.message : String(error)}), set aside as ${basename(aside)}`, 'warn');
    } catch (moveError) {
      log(`${label}: file not readable, and not moved: ${String(moveError)}`, 'error');
    }
    try {
      const value = JSON.parse(readFileSync(`${file}.bak`, 'utf8')) as unknown;
      log(`${label}: the version before is back (${basename(file)}.bak)`, 'warn');
      return value;
    } catch {
      return undefined;
    }
  }
}

/**
 * Keeps the entries of a data file that are not valid any more in <file>.rejected.json, each once, so that the next
 * save does not lose them; says how many in the log.
 */
export function keepRejected(file: string, rejected: readonly unknown[], label: string, log: (message: string, level?: 'info' | 'warn' | 'error') => void): void {
  if (rejected.length === 0) return;
  const target = `${file}.rejected.json`;
  let kept: unknown[] = [];
  try {
    const before = JSON.parse(readFileSync(target, 'utf8')) as unknown;
    if (Array.isArray(before)) kept = before;
  } catch {
    // None yet.
  }
  const seen = new Set(kept.map((item) => JSON.stringify(item)));
  const fresh = rejected.filter((item) => !seen.has(JSON.stringify(item)));
  if (fresh.length === 0) return;
  try {
    writeDataJson(target, [...kept, ...fresh]);
    log(`${label}: ${fresh.length === 1 ? '1 entry not valid' : `${fresh.length} entries not valid`} kept aside in ${basename(target)}`, 'warn');
  } catch (error) {
    log(`${label}: entries not valid, not saved: ${String(error)}`, 'error');
  }
}

/**
 * The version of the data in the private folder, for changes of format to come: each step in MIGRATIONS takes the
 * data from one version to the next. Data of a newer Forchetta is not touched: the daemon does not start on it.
 */
export const DATA_VERSION = 1;

/** The steps from version n (index n - 1) to n + 1. None yet. */
const MIGRATIONS: ((varDir: string, log: (message: string, level?: 'info' | 'warn' | 'error') => void) => void)[] = [];

/** Brings the data of the private folder to DATA_VERSION; an error when it is newer than this Forchetta knows. */
export function migrateData(varDir: string, log: (message: string, level?: 'info' | 'warn' | 'error') => void, current = DATA_VERSION, steps = MIGRATIONS): { ok: true } | { ok: false; error: string } {
  const file = join(varDir, 'data-version');
  let version = current;
  if (existsSync(file)) {
    const read = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    version = Number.isInteger(read) && read > 0 ? read : current;
  } else if (!existsSync(dirname(file))) {
    return { ok: true };
  } else {
    // A folder from before the versions: the format of version 1.
    version = 1;
  }
  if (version > current) return { ok: false, error: `the data in ${varDir} are of a newer Forchetta (format ${version}, this one knows up to ${current}): update Forchetta` };
  for (; version < current; version++) {
    const step = steps[version - 1];
    if (!step) return { ok: false, error: `no step brings the data from format ${version} to ${version + 1}` };
    step(varDir, log);
    log(`data brought from format ${version} to ${version + 1}`);
    writeFileSync(file, `${version + 1}\n`, { mode: 0o600 });
  }
  writeFileSync(file, `${current}\n`, { mode: 0o600 });
  return { ok: true };
}
