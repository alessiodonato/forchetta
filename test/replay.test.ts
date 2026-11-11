import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type HookMeta, Registry } from '../src/daemon/registry.ts';
import type { AgentState, HookPayload } from '../src/daemon/state.ts';

// The hook events of the Phase 1 test with two real sessions (Claude Code 2.1.322, Haiku 5.5), in the order the
// daemon received them: two `forchetta run claude`, a short answer, a question with AskUserQuestion, a /clear, a
// Bash command, and /exit in both.

interface Recorded {
  at: number;
  meta: HookMeta;
  payload: HookPayload;
}

const events: Recorded[] = readFileSync(join(import.meta.dirname, 'fixtures', 'e2e-phase1.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Recorded);

const ALPHA = '53d5da5f-7026-4d9d-bc9f-2889d446c838';
const BETA = '94cdb621-d0ff-49ee-977d-f4e6c4ca7e75';

let registry: Registry;
afterEach(() => registry?.dispose());

describe('replay of two real sessions', () => {
  it('ends with each session in its own box, with the states it went through', () => {
    let clock = events[0]!.at;
    registry = new Registry({ now: () => clock, settleMs: 60_000 });
    const states = new Map<string, AgentState[]>();
    for (const event of events) {
      clock = event.at;
      const agent = registry.hook(event.payload, event.meta);
      const seen = states.get(agent.id) ?? [];
      if (seen.at(-1) !== agent.state) seen.push(agent.state);
      states.set(agent.id, seen);
    }

    expect(registry.agents.size).toBe(2);
    expect(states.get(ALPHA)).toEqual(['starting', 'working', 'idle', 'ended']);
    expect(states.get(BETA)).toEqual(['starting', 'working', 'waiting', 'working', 'idle', 'working', 'idle', 'ended']);

    const alpha = registry.agents.get(ALPHA)!;
    expect(alpha).toMatchObject({
      pid: 37423,
      project: 'alpha',
      control: { kind: 'tmux', session: 'fk-53d5da5f', paneId: '%0' },
      sessionId: 'cf2327f2-0622-4526-a96e-ba1ac38959c1',
      pastSessionIds: ['9b82b7b9-72d4-44a3-9e06-1f0bb517e177'],
      endReason: 'prompt_input_exit',
      model: 'claude-haiku-5-5',
    });
    const beta = registry.agents.get(BETA)!;
    expect(beta).toMatchObject({ pid: 37530, control: { paneId: '%1' }, summary: { text: 'uno' }, endReason: 'prompt_input_exit' });
  });

  it('shows the question as a question, through PermissionRequest and the notification', () => {
    let clock = events[0]!.at;
    registry = new Registry({ now: () => clock, settleMs: 60_000 });
    for (const event of events) {
      clock = event.at;
      registry.hook(event.payload, event.meta);
      if (event.payload.hook_event_name === 'Notification' && event.payload.notification_type === 'permission_prompt') break;
    }
    expect(registry.agents.get(BETA)).toMatchObject({ state: 'waiting', waiting: { kind: 'domanda', detail: 'Preferisci il rosso o il blu?' } });
  });
});
