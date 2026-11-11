import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { UserError } from './errors.ts';
import { ensurePrivateDir, paths } from './paths.ts';

// The settings of Forchetta, in var/config.json. `forchetta hooks install` writes there the full paths of
// node, tmux and claude, because an app opened from the Finder gets a PATH without /usr/local/bin.

export const DEFAULT_PORT = 47821;

export type Tool = 'node' | 'tmux' | 'claude';

export interface Config {
  port: number;
  paths: Partial<Record<Tool, string>>;
  /** The command of arricurdAI, as a list: ["arricurdai"] or ["/usr/local/bin/node", ".../bin.js"]. */
  arricurdai?: string[];
  /**
   * The context window of each model, in tokens, for the percentage in the box. `arricurdai status` gives the
   * tokens, not the window: this table is an estimate. A key matches a model id or its beginning; "*" is the rest.
   */
  contextWindows: Record<string, number>;
  /** The optional one-line summary written by a Haiku model. Off unless turned on here. */
  summaries: { haiku: boolean; model: string; minIntervalSec: number };
  /** The work area: at most 4 panes; a new one replaces the least recently used, or asks which one to replace. */
  panes: { replace: 'lru' | 'chiedi' };
  /** How long a finished session stays in the list. */
  endedRetentionMin: number;
  /** How often `claude agents --json` is read to find sessions that sent no hook. */
  reconcileIntervalMin: number;
  /** A session "al lavoro" with no event for this long is shown as stalled. */
  stallMin: number;
  /** The shortcut that shows or hides the app from anywhere, read by the app: "ctrl+alt+f", or "" for none. */
  hotkey: string;
}

/** Native 1M window for the current models; 200k for those that compact at 200k without extended context. */
export const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  '*': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-6': 200_000,
};

export const DEFAULT_CONFIG: Config = {
  port: DEFAULT_PORT,
  paths: {},
  contextWindows: DEFAULT_CONTEXT_WINDOWS,
  summaries: { haiku: false, model: 'claude-haiku-5-5', minIntervalSec: 30 },
  panes: { replace: 'lru' },
  endedRetentionMin: 10,
  reconcileIntervalMin: 5,
  stallMin: 10,
  hotkey: 'ctrl+alt+f',
};

const positive = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);

export function loadConfig(file = paths.config): Config {
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // A broken file falls back to the defaults; `hooks install` writes it again.
  }
  const toolPaths: Partial<Record<Tool, string>> = {};
  const given = raw.paths;
  if (given && typeof given === 'object') {
    for (const tool of ['node', 'tmux', 'claude'] as const) {
      const value = (given as Record<string, unknown>)[tool];
      if (typeof value === 'string' && value) toolPaths[tool] = value;
    }
  }
  const port = raw.port;
  const arricurdai = Array.isArray(raw.arricurdai) && raw.arricurdai.length > 0 && raw.arricurdai.every((part) => typeof part === 'string' && part) ? (raw.arricurdai as string[]) : undefined;
  const windows: Record<string, number> = { ...DEFAULT_CONTEXT_WINDOWS };
  if (raw.contextWindows && typeof raw.contextWindows === 'object') {
    for (const [model, size] of Object.entries(raw.contextWindows as Record<string, unknown>)) {
      if (typeof size === 'number' && Number.isFinite(size) && size > 0) windows[model] = size;
    }
  }
  const summaries = (raw.summaries && typeof raw.summaries === 'object' ? raw.summaries : {}) as Record<string, unknown>;
  return {
    port: typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    paths: toolPaths,
    arricurdai,
    contextWindows: windows,
    summaries: {
      haiku: summaries.haiku === true,
      model: typeof summaries.model === 'string' && summaries.model ? summaries.model : DEFAULT_CONFIG.summaries.model,
      minIntervalSec: positive(summaries.minIntervalSec, DEFAULT_CONFIG.summaries.minIntervalSec),
    },
    panes: { replace: (raw.panes as { replace?: unknown } | undefined)?.replace === 'chiedi' ? 'chiedi' : 'lru' },
    endedRetentionMin: positive(raw.endedRetentionMin, DEFAULT_CONFIG.endedRetentionMin),
    reconcileIntervalMin: positive(raw.reconcileIntervalMin, DEFAULT_CONFIG.reconcileIntervalMin),
    stallMin: positive(raw.stallMin, DEFAULT_CONFIG.stallMin),
    hotkey: typeof raw.hotkey === 'string' ? raw.hotkey : DEFAULT_CONFIG.hotkey,
  };
}

/** The window of a model: its own entry, the longest entry it begins with, or "*". */
export function contextWindowOf(model: string | undefined, windows: Record<string, number>): number {
  const fallback = windows['*'] ?? DEFAULT_CONTEXT_WINDOWS['*']!;
  if (!model) return fallback;
  if (windows[model] !== undefined) return windows[model];
  const prefix = Object.keys(windows)
    .filter((key) => key !== '*' && model.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? windows[prefix]! : fallback;
}

/**
 * How to run arricurdAI: from the PATH, or the same command its hooks use in the Claude Code settings
 * (`node /path/to/arricurdai/.../bin.js guard`), with node as a full path.
 */
export function detectArricurdai(settingsText: string | undefined, find: (name: string) => string | undefined = (name) => which(name)): string[] | undefined {
  const onPath = find('arricurdai');
  if (onPath) return [onPath];
  if (!settingsText) return undefined;
  const match = /"command"\s*:\s*"(\S+)\s+\\?"?([^"\\\s]*arricurd[^"\\\s]*\/bin\.js)\\?"?\s+(?:guard|handoff)\b/i.exec(settingsText);
  if (!match) return undefined;
  const [, runner, script] = match;
  if (!runner || !script) return undefined;
  const node = runner.includes('/') ? runner : find(runner);
  return node ? [node, script] : undefined;
}

export function saveConfig(config: Config, file = paths.config): void {
  ensurePrivateDir(paths.varDir);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The full path of a program, from the PATH and then from the usual places of Homebrew and of Claude Code. */
export function which(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = [...(env.PATH ?? '').split(delimiter), '/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.local', 'bin')];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

export function resolveTool(tool: Tool, config: Config): string {
  if (tool === 'node' && !config.paths.node) return process.execPath;
  const found = config.paths[tool] ?? which(tool);
  if (!found) throw new UserError(`non trovo ${tool}: installalo o scrivi il suo percorso in ${paths.config}`);
  return found;
}
