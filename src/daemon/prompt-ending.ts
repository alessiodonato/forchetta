import { open } from 'node:fs/promises';

// A prompt that started no turn. Claude Code sends UserPromptSubmit to all its hooks at once, so the hook of
// Forchetta hears of a prompt also when another hook refuses it (arricurdAI does, when the prompt cache expired):
// no turn starts, no Stop comes, and Claude Code puts the prompt back into the input box. What says so is a line of
// the transcript, written about half a second after the hook (seen with 2.1.322):
//
//   {"type":"system","subtype":"informational","content":"UserPromptSubmit operation blocked by hook:\n…\n\nOriginal prompt: …",
//    "promptSubmitEnding":{"ending":{"kind":"blocked_by_hook","reason":"…"},"promptKept":false},"timestamp":"…"}

export interface PromptEnding {
  kind: string;
  reason?: string;
  at: number;
}

interface TranscriptLine {
  type?: string;
  isMeta?: boolean;
  timestamp?: string;
  content?: unknown;
  promptSubmitEnding?: { ending?: { kind?: unknown; reason?: unknown } };
}

/** How much of the end of a transcript is read: the line of a refusal is short, and the last one written. */
const TAIL_BYTES = 128 * 1024;

/**
 * The end of a prompt that started no turn, written at `since` or later, in the last lines of a transcript. None
 * when a prompt (or a tool result) went in after it, or when it names another prompt.
 */
export function promptEndingIn(tail: string, since: number, prompt?: string): PromptEnding | undefined {
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith('{')) continue;
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line) as TranscriptLine;
    } catch {
      // The first line of the tail, cut in the middle.
      continue;
    }
    // Lines with no time (the mode, the last prompt, the cost) say nothing of the turn.
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isNaN(at)) continue;
    if (at < since) return undefined;
    const ending = entry.promptSubmitEnding?.ending;
    if (ending && typeof ending.kind === 'string') {
      // "Original prompt: …" at the end of the notice: it must be this prompt.
      const head = prompt?.trim().split('\n')[0]?.slice(0, 200);
      if (head && typeof entry.content === 'string' && entry.content.includes('Original prompt:') && !entry.content.includes(head)) return undefined;
      return { kind: ending.kind, ...(typeof ending.reason === 'string' && ending.reason ? { reason: ending.reason } : {}), at };
    }
    if (entry.type === 'user' && !entry.isMeta) return undefined;
  }
  return undefined;
}

/** The last bytes of a transcript. */
export async function transcriptTail(file: string, bytes = TAIL_BYTES): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}
