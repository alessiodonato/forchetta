import { describe, expect, it } from 'vitest';
import { activity, ago, renderList } from '../src/cli/ls.ts';
import { makeStyle, plain, visibleLength } from '../src/cli/style.ts';
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
      plain,
    );
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^PROJECT\s+STATE\s+ACTIVITY\s+CONTEXT\s+CACHE\s+LAST\s+CONTROL\s+PID\s+SESSION$/);
    expect(lines[1]).toMatch(/^progetto\s+working\s+.*357k ≈36%\s+42 min\s+12 s\s+read only\s+123\s+abcdef12$/);
    expect(lines[2]).toMatch(/waiting\s+.*—\s+—\s+3 min\s+tmux\s+—\s+—$/);
    expect(lines.at(-1)).toBe('2 sessions running · 1 waits for you');
    expect(renderList([], NOW, 100, plain)).toBe('No Claude Code session running.\n');
  });

  it('on a terminal, marks each state and keeps the columns where they were', () => {
    const agents = [
      agent({ state: 'working', lastEvent: { name: 'PreToolUse', at: NOW - 12_000 } }),
      agent({ id: 'y', state: 'waiting', waiting: { kind: 'permesso', detail: 'Bash rm -rf dist', since: NOW } }),
      agent({ id: 'z', state: 'error', error: { kind: 'rate_limit', at: NOW } }),
    ];
    const painted = renderList(agents, NOW, 140, makeStyle(1));
    const lines = painted.trimEnd().split('\n');
    expect(lines[1]).toContain('● working');
    expect(lines[2]).toContain('\u001b[38;5;215m◆ waiting');
    expect(lines[3]).toContain('\u001b[38;5;203m✗ error');
    // Without the escape codes, the header is the same and every row is as wide: the columns did not move.
    const bare = renderList(agents, NOW, 140, plain).trimEnd().split('\n');
    const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');
    expect(strip(lines[0]!)).toBe(bare[0]);
    for (const index of [1, 2, 3]) expect(visibleLength(lines[index]!)).toBe(bare[index]!.length);
    expect(lines.at(-1)).toContain('1 waits for you');
    expect(lines.at(-1)).toContain('1 with an error');
  });

  it('writes durations in short English', () => {
    expect(ago(4_000)).toBe('4 s');
    expect(ago(125_000)).toBe('2 min');
    expect(ago(3_900_000)).toBe('1 h 5 min');
    expect(ago(200_000_000)).toBe('2 d');
  });
});
