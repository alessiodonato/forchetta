import { readFileSync, rmSync } from 'node:fs';
import { readDataJson, writeDataJson } from '../shared/data-file.ts';
import { isNewer, runOf, type UpdateInfo, type UpdateRun } from '../shared/updates.ts';

// A new version of Forchetta: looked for once a day (Settings turns it off), said at the top of the page, installed when you
// click. The work is of `forchetta update` (cli/update.ts), a process of its own: the daemon restarts in the middle of it. It
// writes how it goes in a file; this reads it, also after the restart.

const DAY_MS = 20 * 3_600_000;
/** After one that could not be looked for. */
const AGAIN_MS = 3_600_000;
const WATCH_MS = 700;
/** How long how the last one went shows. */
const SHOWN_MS = 24 * 3_600_000;

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

export interface UpdatesOptions {
  current: string;
  /** What to type to do it by hand. */
  command: string;
  file: string;
  runFile: string;
  enabled: () => boolean;
  latest: () => Promise<string | undefined>;
  /** Starts `forchetta update` apart from the daemon. */
  start: () => void;
  /** Applies the hooks of the new version: you saw what changes. */
  applyHooks: () => Promise<{ ok: boolean; text: string }>;
  onChange: () => void;
  log: Log;
  alive: (pid: number) => boolean;
  now?: () => number;
}

export class Updates {
  private latest: string | undefined;
  private hidden: string | undefined;
  private nextLook = 0;
  private run: UpdateRun | undefined;
  private looking = false;
  private watching: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly options: UpdatesOptions) {
    const raw = readDataJson(options.file, 'new versions', options.log) as { latest?: unknown; hidden?: unknown; lookedAt?: unknown } | undefined;
    if (typeof raw?.latest === 'string') this.latest = raw.latest;
    if (typeof raw?.hidden === 'string') this.hidden = raw.hidden;
    if (typeof raw?.lookedAt === 'number') this.nextLook = raw.lookedAt + DAY_MS;
    this.readRun();
    if (this.run?.state === 'running') this.watch();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  info(): UpdateInfo {
    const { current, command } = this.options;
    const latest = this.options.enabled() && this.latest && this.latest !== this.hidden && isNewer(this.latest, current) ? this.latest : undefined;
    const run = this.run && (this.run.state === 'running' || this.run.state === 'hooks' || this.now() - this.run.at < SHOWN_MS) ? this.run : undefined;
    return { current, command, ...(latest ? { latest } : {}), ...(run ? { run: { ...run } } : {}) };
  }

  /** Looks for a new version, when it is time. */
  async look(): Promise<void> {
    if (this.looking || !this.options.enabled() || this.now() < this.nextLook) return;
    this.looking = true;
    try {
      const found = await this.options.latest();
      this.nextLook = this.now() + DAY_MS;
      const before = JSON.stringify(this.info());
      if (found) this.latest = found;
      this.save();
      if (JSON.stringify(this.info()) !== before) {
        if (this.info().latest) this.options.log(`Forchetta ${found} is out (this is ${this.options.current})`);
        this.options.onChange();
      }
    } catch (error) {
      this.nextLook = this.now() + AGAIN_MS;
      this.options.log(`new versions not looked for: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.looking = false;
    }
  }

  /** Not this version: the next one shows. */
  hide(version: string): void {
    this.hidden = version;
    this.save();
    this.options.onChange();
  }

  /** Installs the last version, once at a time. */
  install(): void {
    const { latest } = this.info();
    if (!latest || this.run?.state === 'running') return;
    this.set({ state: 'running', from: this.options.current, to: latest, at: this.now(), text: 'Starting' });
    this.options.log(`update to ${latest} started from the page`);
    try {
      this.options.start();
    } catch (error) {
      this.set({ state: 'failed', from: this.options.current, to: latest, at: this.now(), text: `it did not start: ${String(error)}` });
      return;
    }
    this.watch();
  }

  /** The hooks of the new version: applied, or left as they are. */
  async hooks(apply: boolean): Promise<void> {
    const run = this.run;
    if (run?.state !== 'hooks') return;
    if (!apply) return this.set({ ...run, state: 'done', at: this.now(), text: 'The hooks stay as they were: `forchetta setup` applies them.', changes: undefined });
    this.set({ ...run, state: 'running', at: this.now(), text: 'Applying the hooks', pid: process.pid });
    const result = await this.options.applyHooks();
    this.set({ ...run, state: result.ok ? 'done' : 'failed', at: this.now(), changes: undefined, text: result.ok ? undefined : result.text });
  }

  /** The line of the last one goes away. */
  forget(): void {
    if (!this.run || this.run.state === 'running') return;
    this.run = undefined;
    rmSync(this.options.runFile, { force: true });
    this.options.onChange();
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.watching);
  }

  private set(run: UpdateRun): void {
    const clean = JSON.parse(JSON.stringify(run)) as UpdateRun;
    this.run = clean;
    try {
      writeDataJson(this.options.runFile, clean);
    } catch (error) {
      this.options.log(`update: state not saved: ${String(error)}`, 'warn');
    }
    this.options.onChange();
  }

  private readRun(): void {
    let run: UpdateRun | undefined;
    try {
      run = runOf(JSON.parse(readFileSync(this.options.runFile, 'utf8')));
    } catch {
      // None, or being written.
      return;
    }
    if (!run) return;
    // Its process is gone, and said nothing: it stopped halfway.
    if (run.state === 'running' && run.pid !== undefined && !this.options.alive(run.pid)) run = { ...run, state: 'failed', at: this.now(), text: `it stopped halfway (${run.text ?? '?'}): do it by hand` };
    // Started, and never a word from its process.
    if (run.state === 'running' && run.pid === undefined && this.now() - run.at > 30_000) run = { ...run, state: 'failed', at: this.now(), text: 'it did not start: do it by hand' };
    this.run = run;
  }

  private watch(): void {
    clearTimeout(this.watching);
    if (this.stopped) return;
    this.watching = setTimeout(() => {
      const before = JSON.stringify(this.run);
      this.readRun();
      if (JSON.stringify(this.run) !== before) this.options.onChange();
      if (this.run?.state === 'running') this.watch();
    }, WATCH_MS);
    this.watching.unref?.();
  }

  private save(): void {
    try {
      writeDataJson(this.options.file, { version: 1, ...(this.latest ? { latest: this.latest } : {}), ...(this.hidden ? { hidden: this.hidden } : {}), lookedAt: this.nextLook - DAY_MS });
    } catch (error) {
      this.options.log(`new versions: state not saved: ${String(error)}`, 'warn');
    }
  }
}
