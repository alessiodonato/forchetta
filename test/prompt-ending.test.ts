import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptEndingIn, transcriptTail } from '../src/daemon/prompt-ending.ts';
import { Registry } from '../src/daemon/registry.ts';

// A prompt that a hook refused (arricurdAI, when the cache expired) starts no turn: Claude Code says so only in the
// transcript, and the box must not wait for a Stop that never comes.

const T0 = Date.parse('2026-11-14T16:50:00Z');
const PROMPT = 'Aggiungi i retry al client delle API, poi lancia i test.';
const REASON = 'arricurdai: this session was idle for 1h 20m and its prompt cache expired.';

/** The line Claude Code 2.1.322 writes for a refused prompt. */
const refusal = (at: number, prompt = PROMPT): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'informational',
    content: `UserPromptSubmit operation blocked by hook:\n${REASON}\n\nOriginal prompt: ${prompt}`,
    isMeta: false,
    timestamp: new Date(at).toISOString(),
    level: 'warning',
    preventContinuation: true,
    promptSubmitEnding: { ending: { kind: 'blocked_by_hook', reason: REASON }, promptKept: false },
  });
const assistant = (at: number): string => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'text', text: 'fatto' }] } });
const user = (at: number): string => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: PROMPT } });
const untimed = JSON.stringify({ type: 'last-prompt', lastPrompt: PROMPT });

describe('a prompt refused by a hook', () => {
  it('is read from the end of the transcript: what kind, why, when', () => {
    const tail = ['ut":"cut in the middle"}', assistant(T0 - 60_000), refusal(T0 + 500), untimed, ''].join('\n');
    expect(promptEndingIn(tail, T0 - 1500, PROMPT)).toEqual({ kind: 'blocked_by_hook', reason: REASON, at: T0 + 500 });
  });

  it('is not one older than the prompt, nor one followed by a prompt that went through, nor one of another prompt', () => {
    expect(promptEndingIn([refusal(T0 - 60_000), untimed].join('\n'), T0 - 1500, PROMPT)).toBeUndefined();
    expect(promptEndingIn([refusal(T0 + 500), user(T0 + 2000)].join('\n'), T0 - 1500, PROMPT)).toBeUndefined();
    expect(promptEndingIn(refusal(T0 + 500, 'un altro prompt'), T0 - 1500, PROMPT)).toBeUndefined();
    expect(promptEndingIn([assistant(T0 - 60_000), user(T0 + 300)].join('\n'), T0 - 1500, PROMPT)).toBeUndefined();
  });

  it('is looked for in the last bytes of the transcript only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forchetta-ending-'));
    try {
      const file = join(dir, 't.jsonl');
      writeFileSync(file, `${'x'.repeat(5000)}\n${refusal(T0)}\n`);
      const tail = await transcriptTail(file, 1000);
      expect(Buffer.byteLength(tail)).toBe(1000);
      expect(promptEndingIn(tail, T0 - 1500, PROMPT)?.kind).toBe('blocked_by_hook');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the box back to what it was, and keeps the prompt; not when the turn went on', () => {
    let now = T0;
    const registry = new Registry({ now: () => now, settleMs: 5 });
    try {
      const agent = registry.hook({ hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Fatto: la release è online.' });
      const finished = agent.completedAt;
      now += 60_000;
      registry.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: PROMPT });
      expect(agent).toMatchObject({ state: 'working', lastPrompt: PROMPT, completedAt: undefined });
      now += 600;
      expect(registry.refusePrompt(agent.id, T0 + 1000, REASON)).toBe(false);
      expect(registry.refusePrompt(agent.id, T0 + 60_000, REASON)).toBe(true);
      expect(agent).toMatchObject({ state: 'idle', completedAt: finished, lastPrompt: undefined, refusedPrompt: { text: PROMPT, reason: REASON } });
      expect(agent.summary?.text).toContain('la release è online');
      // Sent again, it goes through: the turn is on, and the refusal is forgotten.
      now += 5000;
      registry.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: PROMPT });
      expect(agent.refusedPrompt).toBeUndefined();
      registry.hook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/p/a.ts' } });
      expect(registry.refusePrompt(agent.id, now, REASON)).toBe(false);
      expect(agent.state).toBe('working');
    } finally {
      registry.dispose();
    }
  });
});
