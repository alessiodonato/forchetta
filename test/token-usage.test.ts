import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TokenCounter, usageOfLine } from '../src/daemon/token-usage.ts';
import type { Agent } from '../src/shared/agent.ts';
import { crewUsage, tokensDetail, tokensTotal } from '../src/shared/present.ts';
import { tempDir } from './helpers.ts';

// The tokens of the sessions of a team, from their transcripts: each answer once, read a little at a time.

const temp = tempDir('token-usage');
afterAll(() => temp.cleanup());

/** A line of a transcript as Claude Code writes it for one block of an answer (trimmed). */
const answer = (id: string, usage: { input?: number; write?: number; read?: number; output?: number }, text = 'ok'): string =>
  `${JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: usage.input ?? 0, cache_creation_input_tokens: usage.write ?? 0, cache_read_input_tokens: usage.read ?? 0, output_tokens: usage.output ?? 0, service_tier: 'standard' },
    },
  })}\n`;
const user = (text: string): string => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

describe('a line of a transcript', () => {
  it('gives the usage of an answer, by kind, and nothing for anything else', () => {
    expect(usageOfLine(answer('msg_1', { input: 3, write: 1200, read: 18000, output: 250 }).trim())).toEqual({
      id: 'msg_1',
      usage: { input: 3, cacheWrite: 1200, cacheRead: 18000, output: 250 },
    });
    expect(usageOfLine(user('the "usage" of the API').trim())).toBeUndefined();
    expect(usageOfLine('{"type":"assistant","message":{"usage":{"input_tokens":5}}}')).toBeUndefined();
    expect(usageOfLine('{"type":"assistant", "usage": broken')).toBeUndefined();
    expect(usageOfLine(JSON.stringify({ type: 'assistant', message: { id: 'm', usage: { input_tokens: -4, output_tokens: 'many' } } }))?.usage).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  });
});

describe('the tokens of a session', () => {
  it('counts each answer once, though Claude Code writes it on a line per block', async () => {
    const file = join(temp.dir, 'once.jsonl');
    writeFileSync(file, user('hello') + answer('msg_1', { input: 3, write: 1000, read: 20000, output: 40 }, 'thinking') + answer('msg_1', { input: 3, write: 1000, read: 20000, output: 40 }, 'text') + answer('msg_2', { input: 1, read: 21000, output: 300 }));
    expect(await new TokenCounter().of(file)).toEqual({ input: 4, cacheWrite: 1000, cacheRead: 41000, output: 340 });
  });

  it('reads only what was added since the last time, and a line only once it is whole', async () => {
    const file = join(temp.dir, 'grows.jsonl');
    writeFileSync(file, answer('a', { output: 10 }));
    const counter = new TokenCounter();
    expect((await counter.of(file))?.output).toBe(10);
    const next = answer('b', { output: 20 });
    appendFileSync(file, next.slice(0, 30));
    expect((await counter.of(file))?.output).toBe(10);
    appendFileSync(file, next.slice(30) + answer('c', { output: 5 }));
    expect((await counter.of(file))?.output).toBe(35);
    // The same answer again (a later block of it) adds nothing.
    appendFileSync(file, answer('c', { output: 5 }));
    expect((await counter.of(file))?.output).toBe(35);
  });

  it('adds the transcripts of its subagents', async () => {
    const file = join(temp.dir, 'with-subagents.jsonl');
    writeFileSync(file, answer('main', { read: 1000, output: 100 }));
    mkdirSync(join(temp.dir, 'with-subagents', 'subagents'), { recursive: true });
    writeFileSync(join(temp.dir, 'with-subagents', 'subagents', 'agent-x1.jsonl'), answer('sub1', { write: 500, output: 60 }));
    writeFileSync(join(temp.dir, 'with-subagents', 'subagents', 'agent-x1.meta.json'), '{}');
    expect(await new TokenCounter().of(file)).toEqual({ input: 0, cacheWrite: 500, cacheRead: 1000, output: 160 });
  });

  it('starts again on a file written anew, and gives nothing for one that is not there', async () => {
    const file = join(temp.dir, 'rewritten.jsonl');
    writeFileSync(file, answer('a', { output: 900 }) + answer('b', { output: 900 }));
    const counter = new TokenCounter();
    expect((await counter.of(file))?.output).toBe(1800);
    writeFileSync(file, answer('z', { output: 7 }));
    expect((await counter.of(file))?.output).toBe(7);
    expect(await counter.of(join(temp.dir, 'missing.jsonl'))).toBeUndefined();
    expect(await counter.of(undefined)).toBeUndefined();
  });

  it('reads a transcript larger than a chunk, with characters of several bytes', async () => {
    const file = join(temp.dir, 'large.jsonl');
    // Past the first chunk (512 KB), with characters of two and three bytes on every line.
    const lines: string[] = [];
    for (let i = 0; i < 1400; i++) lines.push(answer(`m${i}`, { output: 1 }, `è già così — ${'à€'.repeat(120)}`));
    writeFileSync(file, lines.join(''));
    expect((await new TokenCounter().of(file))?.output).toBe(1400);
  });
});

describe('what a team used', () => {
  const agent = (tokens?: Agent['tokens'], usd?: number): Agent => ({ ...(tokens ? { tokens } : {}), ...(usd !== undefined ? { usage: { usd, at: 1 } } : {}) }) as Agent;

  it('adds its sessions: their tokens, and the cost of those whose status line said it', () => {
    const used = crewUsage([agent({ input: 1, cacheWrite: 10, cacheRead: 100, output: 5 }, 0.5), agent({ input: 2, cacheWrite: 20, cacheRead: 200, output: 7 }), agent(undefined, 0.25), agent()]);
    expect(used).toEqual({ tokens: { input: 3, cacheWrite: 30, cacheRead: 300, output: 12 }, usd: 0.75, sessions: 3 });
    expect(tokensTotal(used!.tokens)).toBe(345);
    expect(crewUsage([agent()])).toBeUndefined();
    expect(tokensDetail({ input: 2104, cacheWrite: 210880, cacheRead: 1030400, output: 40946 })).toBe('1,284,330 tokens: 2,104 input, 210,880 cache writes, 1,030,400 cache reads, 40,946 output.');
  });
});
