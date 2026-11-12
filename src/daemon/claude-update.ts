import { execFile } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';
import type { ClaudeUpdateInfo } from '../shared/agent.ts';

// The updates of Claude Code. When its automatic update fails, a session says "Auto-update failed · Run claude
// doctor" under its input box. The app says it once, in its top line, with a button that runs `claude update`: one
// installation serves every session. Run only when you click.
//
// How the last update attempt went is in ~/.claude/.last-update-result.json, the file `claude doctor` reads for
// "Last update attempt". It is not documented; on 2.1.322 a failed attempt wrote
// {"timestamp":"2026-11-12T03:06:27.290Z","path":"native","outcome":"failed","status":"install_failed",
//  "version_from":"2.1.322","version_to":null,"error_code":null}

export interface LastUpdate {
  at: number;
  outcome: string;
  status?: string;
  from?: string;
  to?: string;
}

const UPDATE_TIMEOUT_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 30_000;
const MAX_TEXT = 300;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** The last update attempt, from the file of Claude Code; undefined if it cannot be read. */
export function parseLastUpdate(content: string): LastUpdate | undefined {
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    const at = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : Number.NaN;
    const outcome = text(data.outcome);
    if (!Number.isFinite(at) || !outcome) return undefined;
    return { at, outcome, status: text(data.status), from: text(data.version_from), to: text(data.version_to) };
  } catch {
    return undefined;
  }
}

/** The version in `claude --version`: "2.1.322 (Claude Code)" gives 2.1.322. */
export function versionIn(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+[\w.+-]*)/.exec(output)?.[1];
}

const SGR = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The last lines of what a command wrote, without colors: what it says at the end, for a line of the app. */
export function lastLines(output: string, count = 2): string {
  const lines = output
    .replace(SGR, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.slice(-count).join(' · ');
  return joined.length > MAX_TEXT ? `${joined.slice(0, MAX_TEXT - 1)}…` : joined;
}

export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** What the app says after `claude update`: the version changed, it was already the latest, or why it failed. */
export function updateOutcome(result: RunResult, before: string | undefined, after: string | undefined): { ok: boolean; text: string } {
  if (result.timedOut) return { ok: false, text: `claude update did not finish in ${UPDATE_TIMEOUT_MS / 60_000} minutes` };
  if (result.code !== 0) return { ok: false, text: lastLines(result.output) || `claude update ended with code ${result.code ?? '?'}` };
  if (before && after && before !== after) {
    return { ok: true, text: `Claude Code ${after} installed: new sessions use it, the open ones keep ${before} until they restart` };
  }
  const version = after ?? before;
  return { ok: true, text: `Nothing to install: Claude Code ${version ? `${version} ` : ''}is the latest version` };
}

/** The PATH of `claude update`: an install by npm needs npm, and the daemon started by the app has the short PATH of the Finder. */
function updateEnv(claude: string): NodeJS.ProcessEnv {
  const dirs = [dirname(claude), dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', ...(process.env.PATH ?? '').split(delimiter)];
  return { ...process.env, PATH: [...new Set(dirs.filter(Boolean))].join(delimiter), NO_COLOR: '1' };
}

function run(bin: string, args: string[], timeout: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: updateEnv(bin) }, (error, stdout, stderr) => {
      const output = `${String(stdout)}\n${String(stderr)}`;
      if (!error) return resolve({ code: 0, output, timedOut: false });
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      resolve({ code: typeof failure.code === 'number' ? failure.code : null, output: output.trim() ? output : String(error), timedOut: failure.killed === true });
    });
    // Nothing to read: a question on stdin gets an end of file, not a wait.
    child.stdin?.end();
  });
}

export interface ClaudeUpdatesOptions {
  /** ~/.claude/.last-update-result.json, written by Claude Code. */
  resultFile: string;
  /** Where Forchetta remembers the failed attempt that a `claude update` from the app has taken care of. */
  handledFile: string;
  claude: () => string | undefined;
  onChange: (info: ClaudeUpdateInfo) => void;
  log: (message: string) => void;
  timeoutMs?: number;
}

export class ClaudeUpdates {
  private last: LastUpdate | undefined;
  /** The time of the failed attempt already taken care of: an older or equal one is not shown again. */
  private handled = 0;
  private result: ClaudeUpdateInfo['run'];

  constructor(private readonly options: ClaudeUpdatesOptions) {
    try {
      const saved = JSON.parse(readFileSync(options.handledFile, 'utf8')) as { handled?: unknown };
      if (typeof saved.handled === 'number') this.handled = saved.handled;
    } catch {
      // Nothing taken care of yet.
    }
  }

  info(): ClaudeUpdateInfo {
    const last = this.last;
    const failed = last && last.outcome === 'failed' && last.at > this.handled ? { at: last.at, from: last.from, status: last.status } : undefined;
    return { ...(failed ? { failed } : {}), ...(this.result ? { run: this.result } : {}) };
  }

  private changed(before: string): void {
    const info = this.info();
    if (JSON.stringify(info) !== before) this.options.onChange(info);
  }

  private read(): void {
    let content: string | undefined;
    try {
      content = readFileSync(this.options.resultFile, 'utf8');
    } catch {
      // No attempt yet, or another folder: nothing to show.
    }
    this.last = content === undefined ? undefined : parseLastUpdate(content);
  }

  /** Reads the file of Claude Code again; tells the app if what it shows changes. */
  check(): void {
    const before = JSON.stringify(this.info());
    this.read();
    this.changed(before);
  }

  /** The line of the last `claude update` goes away. */
  dismiss(): void {
    if (!this.result || this.result.state === 'running') return;
    const before = JSON.stringify(this.info());
    this.result = undefined;
    this.changed(before);
  }

  /** `claude update`, once at a time. The version before and after says what it did. */
  async update(): Promise<void> {
    if (this.result?.state === 'running') return;
    const before = JSON.stringify(this.info());
    const bin = this.options.claude();
    if (!bin) {
      this.result = { state: 'error', text: 'claude not found', at: Date.now() };
      return this.changed(before);
    }
    this.result = { state: 'running', at: Date.now() };
    this.changed(before);
    this.options.log(`claude update avviato dall'app (${bin})`);
    const versionBefore = versionIn((await run(bin, ['--version'], VERSION_TIMEOUT_MS)).output);
    const result = await run(bin, ['update'], this.options.timeoutMs ?? UPDATE_TIMEOUT_MS);
    const versionAfter = versionIn((await run(bin, ['--version'], VERSION_TIMEOUT_MS)).output);
    const outcome = updateOutcome(result, versionBefore, versionAfter);
    this.options.log(`claude update: ${outcome.ok ? 'riuscito' : 'non riuscito'} (${versionBefore ?? '?'} → ${versionAfter ?? '?'}): ${lastLines(result.output, 4) || 'nessun output'}`);
    const running = JSON.stringify(this.info());
    if (outcome.ok && this.last?.outcome === 'failed') this.remember(this.last.at);
    this.result = { state: outcome.ok ? 'done' : 'error', text: outcome.text, at: Date.now() };
    // Claude Code may have written how this attempt went.
    this.read();
    this.changed(running);
  }

  private remember(at: number): void {
    this.handled = at;
    try {
      const temporary = `${this.options.handledFile}.${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify({ handled: at })}\n`, { mode: 0o600 });
      renameSync(temporary, this.options.handledFile);
    } catch (error) {
      this.options.log(`aggiornamento di Claude Code: stato non salvato: ${String(error)}`);
    }
  }
}
