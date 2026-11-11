import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { RecallMatch } from '../shared/agent.ts';

// Search in the earlier sessions of a project, from the app: `arricurdai recall --json`. Forchetta does not search
// by itself: it shows what arricurdAI finds (and hides: it redacts secrets). Run only when you search.

export interface RecallResult {
  ok: boolean;
  /** How many earlier sessions arricurdAI looked at. */
  sessions?: number;
  matches?: RecallMatch[];
  error?: string;
}

const MAX_QUERY = 300;
const LIMIT = 10;

/** The matches of `arricurdai recall --json`; whatever cannot be read is left out. */
export function parseRecall(stdout: string): RecallResult {
  const data = JSON.parse(stdout) as { sessions?: unknown; matches?: unknown };
  const matches = Array.isArray(data.matches) ? data.matches : [];
  return {
    ok: true,
    sessions: typeof data.sessions === 'number' ? data.sessions : undefined,
    matches: matches
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .filter((item) => typeof item.excerpt === 'string')
      .map((item) => ({
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
        at: typeof item.timestamp === 'string' ? Date.parse(item.timestamp) || undefined : undefined,
        request: typeof item.request === 'string' ? item.request : undefined,
        excerpt: item.excerpt as string,
      })),
  };
}

export function runRecall(command: readonly string[] | undefined, project: unknown, query: unknown): Promise<RecallResult> {
  const [bin, ...prefix] = command ?? [];
  if (!bin) return Promise.resolve({ ok: false, error: 'arricurdAI not found: the search uses arricurdai recall' });
  if (typeof project !== 'string' || !isAbsolute(project)) return Promise.resolve({ ok: false, error: 'choose a project' });
  try {
    if (!statSync(project).isDirectory()) throw new Error();
  } catch {
    return Promise.resolve({ ok: false, error: `the folder ${project} does not exist` });
  }
  const words = typeof query === 'string' ? query.slice(0, MAX_QUERY).split(/\s+/).filter(Boolean) : [];
  if (words.length === 0) return Promise.resolve({ ok: false, error: 'write what to search for' });
  // "--" before the words: a word that starts with "-" is a word, not an option.
  const args = [...prefix, 'recall', '--project', project, '--json', '--limit', String(LIMIT), '--', ...words];
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const text = String(stdout).trim();
      if (text.startsWith('{')) {
        try {
          return resolve(parseRecall(text));
        } catch {
          // Not JSON after all: below.
        }
      }
      const message = String(stderr).trim() || text || (error ? String(error) : '');
      // "nothing in N earlier sessions matches": no error, no match.
      const none = /nothing in (\d+) earlier sessions? match/.exec(message);
      if (none) return resolve({ ok: true, sessions: Number(none[1]), matches: [] });
      resolve({ ok: false, error: message.replace(/^arricurdai recall:\s*/, '') || 'arricurdai recall did not answer' });
    });
  });
}
