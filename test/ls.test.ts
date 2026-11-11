import { describe, expect, it } from 'vitest';
import { activity, ago, renderList } from '../src/cli/ls.ts';
import { type Agent, newAgent } from '../src/daemon/state.ts';

const NOW = 2_000_000;

function agent(init: Partial<Agent>): Agent {
  return { ...newAgent({ id: 'x', control: { kind: 'readonly', reason: 'fuori-tmux' }, cwd: '/Users/dev/progetto' }, NOW - 12_000), ...init };
}

describe('forchetta ls', () => {
  it('says what each state means', () => {
    expect(activity(agent({ state: 'working', action: { tool: 'Bash', label: 'Bash npm test', family: 'shell', at: NOW } }))).toBe('Bash npm test');
    expect(activity(agent({ state: 'working', action: { tool: 'Grep', label: 'Grep "x"', family: 'read', subagent: 'Explore', at: NOW } }))).toBe('↳ Explore: Grep "x"');
    expect(activity(agent({ state: 'waiting', waiting: { kind: 'permesso', detail: 'Bash rm -rf dist', since: NOW } }))).toBe('Permission: Bash rm -rf dist');
    expect(activity(agent({ state: 'idle', summary: { text: 'Fatto.', source: 'eventi', at: NOW } }))).toBe('Fatto.');
    expect(activity(agent({ state: 'error', error: { kind: 'rate_limit', at: NOW } }))).toBe('Error: rate_limit');
    expect(activity(agent({ state: 'compacting', compactTrigger: 'auto' }))).toBe('compacting, automatically');
  });

  it('prints one line per session and a count', () => {
    const text = renderList(
      [
        agent({
          state: 'working',
          pid: 123,
          sessionId: 'abcdef12-0000',
          lastEvent: { name: 'PreToolUse', at: NOW - 12_000 },
          context: { tokens: 357_310, window: 1_000_000, percent: 36, lastCallAt: NOW, at: NOW },
          cache: { expiresAt: NOW + 42.5 * 60_000, live: true, guardWillStop: false },
        }),
        agent({ id: 'y', state: 'waiting', control: { kind: 'tmux', session: 'fk-1' }, lastEvent: { name: 'PermissionRequest', at: NOW - 180_000 } }),
      ],
      NOW,
      140,
      false,
    );
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^PROGETTO\s+STATO\s+ATTIVITÀ\s+CONTESTO\s+CACHE\s+ULTIMO\s+CONTROLLO\s+PID\s+SESSIONE$/);
    expect(lines[1]).toMatch(/^progetto\s+working\s+.*357k ≈36%\s+42 min\s+12 s\s+read only\s+123\s+abcdef12$/);
    expect(lines[2]).toMatch(/waiting\s+.*—\s+—\s+3 min\s+tmux\s+—\s+—$/);
    expect(lines.at(-1)).toBe('2 sessioni attive · 1 ti aspetta');
    expect(renderList([], NOW, 100, false)).toBe('Nessuna sessione Claude Code attiva.\n');
  });

  it('writes durations in Italian', () => {
    expect(ago(4_000)).toBe('4 s');
    expect(ago(125_000)).toBe('2 min');
    expect(ago(3_900_000)).toBe('1 h 5 min');
    expect(ago(200_000_000)).toBe('2 d');
  });
});
