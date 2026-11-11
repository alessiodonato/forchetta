import { describe, expect, it } from 'vitest';
import { newAgent } from '../src/daemon/state.ts';
import { type Complete, Summarizer, summaryPrompt } from '../src/daemon/summarizer.ts';
import type { Agent } from '../src/shared/agent.ts';
import { sleep } from './helpers.ts';

const agent = (init: Partial<Agent>): Agent => ({
  ...newAgent({ id: 'a1', control: { kind: 'readonly', reason: 'fuori-tmux' }, cwd: '/p/forchetta' }, 0),
  lastPrompt: 'Aggiungi i test del daemon',
  recentActions: ['Edit src/daemon/main.ts', 'Bash pnpm test'],
  ...init,
});

function summarizer(complete: Complete, summaries: string[], logs: string[] = []): Summarizer {
  return new Summarizer({ complete, minIntervalMs: 60, settleMs: 5, onSummary: (_id, text) => summaries.push(text), log: (line) => logs.push(line) });
}

describe('Haiku summary (optional)', () => {
  it('sends only what the box already shows', () => {
    const text = summaryPrompt(agent({ state: 'idle', lastReply: 'Fatto: 12 test aggiunti.' }));
    expect(text).toContain('Project: forchetta');
    expect(text).toContain('State: idle');
    expect(text).toContain('Aggiungi i test del daemon');
    expect(text).toContain('Edit src/daemon/main.ts; Bash pnpm test');
    expect(text).toContain('Fatto: 12 test aggiunti.');
  });

  it('asks only when the state changes, and at most once per interval', async () => {
    let calls = 0;
    const summaries: string[] = [];
    const s = summarizer(async () => `riga ${++calls}`, summaries);
    s.changed(agent({ state: 'working' }));
    s.changed(agent({ state: 'working' }));
    await sleep(20);
    expect(calls).toBe(1);
    s.changed(agent({ state: 'idle' }));
    await sleep(20);
    expect(calls).toBe(1);
    await sleep(70);
    expect(calls).toBe(2);
    expect(summaries).toEqual(['riga 1', 'riga 2']);
    s.stop();
  });

  it('keeps the summary of the events when the model declines, and stops with a bad key', async () => {
    const summaries: string[] = [];
    const logs: string[] = [];
    const declining = summarizer(async () => undefined, summaries);
    declining.changed(agent({ state: 'working' }));
    await sleep(20);
    expect(summaries).toEqual([]);

    let calls = 0;
    const badKey = summarizer(async () => {
      calls++;
      throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
    }, summaries, logs);
    badKey.changed(agent({ id: 'b', state: 'working' }));
    await sleep(20);
    badKey.changed(agent({ id: 'b', state: 'idle' }));
    await sleep(100);
    expect(calls).toBe(1);
    expect(logs[0]).toContain('non è valida');
  });

  it('says nothing for a session with nothing to summarize', async () => {
    let calls = 0;
    const s = summarizer(async () => `x${++calls}`, []);
    s.changed(newAgent({ id: 'empty', control: { kind: 'readonly', reason: 'fuori-tmux' }, state: 'idle' }, 0));
    await sleep(20);
    expect(calls).toBe(0);
  });
});
