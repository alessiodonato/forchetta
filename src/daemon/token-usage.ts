import { open, readdir, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { join } from '../shared/fspath.ts';
import type { TokenUsage } from '../shared/agent.ts';
import { addTokens, noTokens } from '../shared/present.ts';

// The tokens of a session, from its transcript and those of its subagents (<session>/subagents/*.jsonl): every
// answer of the model has its usage. Claude Code writes an answer on several lines, one per block, each with the same
// id and the same usage, so each id counts once. A transcript can be tens of MB: each file is read from where the
// last reading stopped, a chunk at a time, and only its new lines are parsed; one reading at a time, so the daemon
// (and the guard, which answers in milliseconds) never waits on it.

const CHUNK = 512 * 1024;

interface FileState {
  offset: number;
  decoder: StringDecoder;
  /** The start of a line not finished yet at the last reading. */
  rest: string;
  /** The usage of each answer, by its id. */
  answers: Map<string, TokenUsage>;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** The usage of a line of a transcript, with the id of its answer; undefined for any other line. */
export function usageOfLine(line: string): { id: string; usage: TokenUsage } | undefined {
  if (!line.includes('"usage"')) return undefined;
  let entry: { type?: unknown; message?: { id?: unknown; usage?: Record<string, unknown> } };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    return undefined;
  }
  const usage = entry.message?.usage;
  if (entry.type !== 'assistant' || !usage || typeof usage !== 'object' || typeof entry.message?.id !== 'string') return undefined;
  return {
    id: entry.message.id,
    usage: {
      input: count(usage.input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      output: count(usage.output_tokens),
    },
  };
}

export class TokenCounter {
  private readonly files = new Map<string, FileState>();
  private queue: Promise<unknown> = Promise.resolve();

  /** The tokens of one transcript: what it had, plus its new lines. */
  private async read(file: string): Promise<TokenUsage> {
    let state = this.files.get(file);
    const size = (await stat(file)).size;
    // A shorter file is another one (rewritten): count it again from the start.
    if (!state || size < state.offset) {
      state = { offset: 0, decoder: new StringDecoder('utf8'), rest: '', answers: new Map() };
      this.files.set(file, state);
    }
    if (size > state.offset) {
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(CHUNK, size - state.offset));
        while (state.offset < size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - state.offset), state.offset);
          if (bytesRead <= 0) break;
          state.offset += bytesRead;
          const lines = (state.rest + state.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
          state.rest = lines.pop() ?? '';
          for (const line of lines) {
            const found = usageOfLine(line);
            if (found) state.answers.set(found.id, found.usage);
          }
        }
      } finally {
        await handle.close();
      }
    }
    const total = noTokens();
    for (const usage of state.answers.values()) addTokens(total, usage);
    return total;
  }

  private async count(transcriptPath: string): Promise<TokenUsage | undefined> {
    try {
      await stat(transcriptPath);
    } catch {
      return undefined;
    }
    const files = [transcriptPath];
    const subagents = join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents');
    try {
      for (const name of await readdir(subagents)) if (name.endsWith('.jsonl')) files.push(join(subagents, name));
    } catch {
      // No subagents.
    }
    const total = noTokens();
    for (const file of files) {
      try {
        addTokens(total, await this.read(file));
      } catch {
        // Gone or not readable: the others count.
      }
    }
    return total;
  }

  /** The tokens of a session with its subagents; undefined when its transcript is not there (yet). */
  of(transcriptPath: string | undefined): Promise<TokenUsage | undefined> {
    if (!transcriptPath || !transcriptPath.endsWith('.jsonl')) return Promise.resolve(undefined);
    const result = this.queue.then(() => this.count(transcriptPath));
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Forgets the transcripts of a session that ended. */
  forget(transcriptPath: string): void {
    const base = transcriptPath.slice(0, -'.jsonl'.length);
    for (const file of this.files.keys()) if (file === transcriptPath || file.startsWith(`${base}/`)) this.files.delete(file);
  }
}
