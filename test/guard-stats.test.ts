import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GuardStats, KEPT_DAYS, readStats, statsOver } from '../src/daemon/guard-stats.ts';
import { Guard } from '../src/daemon/guard.ts';
import { type Agent, newAgent } from '../src/daemon/state.ts';
import { parseDays, statsCommand, statsText } from '../src/cli/stats.ts';
import { commandHelp } from '../src/cli/help.ts';
import { makeStyle } from '../src/cli/style.ts';
import { dayOf, guardTotal, shortSummary, statLines, statsTitle } from '../src/shared/guard-stats.ts';
import { MACHINE } from '../src/shared/machine.ts';
import { tempDir } from './helpers.ts';

// What the guard did, counted by day on this Mac: the top line of the app and `forchetta stats`.

const temp = tempDir('guard-stats');
afterAll(() => temp.cleanup());
afterEach(() => vi.useRealTimers());

const NOV_17 = new Date(2026, 10, 17, 10, 0).getTime();
const DAY = 86_400_000;

describe('the counts', () => {
  it('go by day, and are written a moment later in a private file', () => {
    vi.useFakeTimers();
    const file = join(temp.dir, 'a.json');
    let now = NOV_17;
    let changes = 0;
    const stats = new GuardStats(file, { now: () => now, onChange: () => changes++ });
    stats.count('held');
    stats.count('held');
    stats.count('tests');
    now -= DAY;
    stats.count('git');
    expect(changes).toBe(4);
    expect(readStats(file)).toBeUndefined();
    vi.advanceTimersByTime(2_000);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, days: { '2026-11-17': { held: 2, tests: 1 }, '2026-11-16': { git: 1 } } });
    now = NOV_17;
    // The counts started yesterday, within the week: the week says since when.
    expect(stats.info()).toEqual({ days: 7, counts: { held: 2, tests: 1, git: 1 }, today: { held: 2, tests: 1 }, since: '2026-11-16', byDay: [0, 0, 0, 0, 0, 1, 3] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A new daemon finds them.
    expect(new GuardStats(file, { now: () => now }).info().counts).toEqual({ held: 2, tests: 1, git: 1 });
  });

  it('a week is the last 7 days, today included; "since" when the counts started within them', () => {
    const byDay = { '2026-11-01': { held: 9 }, '2026-11-11': { held: 1 }, '2026-11-17': { lane: 2 } };
    expect(statsOver(byDay, 7, NOV_17)).toEqual({ days: 7, counts: { held: 1, lane: 2 }, today: { lane: 2 } });
    expect(statsOver(byDay, 30, NOV_17)).toEqual({ days: 30, counts: { held: 10, lane: 2 }, today: { lane: 2 }, since: '2026-11-01' });
    expect(statsOver({ '2026-11-15': { git: 1 } }, 7, NOV_17).since).toBe('2026-11-15');
    expect(statsOver({}, 1, NOV_17)).toEqual({ days: 1, counts: {}, today: {} });
  });

  it('give the top line what it counts for each day, the oldest first, and the days move with the clock', () => {
    let now = NOV_17;
    const stats = new GuardStats(undefined, { now: () => now });
    stats.count('held', 2);
    // What the top line leaves out of its total is out of the days too.
    stats.count('letThrough', 5);
    stats.count('freed', 4);
    now += 2 * DAY;
    stats.count('tests');
    const info = stats.info();
    expect(info.byDay).toEqual([0, 0, 0, 0, 2, 0, 1]);
    expect(info.byDay?.reduce((sum, value) => sum + value, 0)).toBe(guardTotal(info.counts));
    now += 5 * DAY;
    expect(stats.info().byDay).toEqual([0, 1, 0, 0, 0, 0, 0]);
    expect(stats.info(2).byDay).toEqual([0, 0]);
    // The hour that goes back on 25 October: no day twice, none missing.
    const clock = new Date(2026, 9, 26, 0, 30).getTime();
    const autumn = new GuardStats(undefined, { now: () => clock });
    autumn.count('held', 3);
    expect(autumn.info().byDay).toEqual([0, 0, 0, 0, 0, 0, 3]);
  });

  it('keep the last 120 days', () => {
    let now = NOV_17;
    const stats = new GuardStats(undefined, { now: () => now });
    for (let i = 0; i < KEPT_DAYS + 5; i++) {
      stats.count('held');
      now += DAY;
    }
    expect(stats.info(200).counts.held).toBe(KEPT_DAYS);
  });

  it('a file that cannot be read is no counts; what is not a count is dropped', () => {
    const bad = join(temp.dir, 'bad.json');
    writeFileSync(bad, '{nope');
    expect(readStats(bad)).toBeUndefined();
    const odd = join(temp.dir, 'odd.json');
    writeFileSync(odd, JSON.stringify({ version: 1, days: { '2026-11-17': { held: 2, git: -1, tests: 'x', lane: 1.6 }, yesterday: { held: 1 } } }));
    expect(readStats(odd)).toEqual({ '2026-11-17': { held: 2, lane: 2 } });
  });

  it('read as lines, a total and a short summary', () => {
    const counts = { held: 5, freed: 4, tests: 1, loop: 2, letThrough: 1 };
    expect(statLines(counts).map((line) => `${line.count} ${line.text}`)).toEqual([
      '5 edits stopped while another session was changing the file',
      '4 sessions went on by themselves when the file was free',
      '1 note before tests: other sessions halfway through files',
      '2 sessions going in circles, flagged',
      '1 time you let a session through',
    ]);
    // What the top line counts: what it stopped, asked or told; not the sessions it let go on, nor yours.
    expect(guardTotal(counts)).toBe(6);
    expect(shortSummary(counts)).toBe('5 stops, 1 note');
    expect(shortSummary({})).toBe('nothing');
    expect(statsTitle({ days: 7, counts, today: { held: 1 } })).toBe(
      [
        'What the guard did in the last 7 days:',
        '5 edits stopped while another session was changing the file',
        '4 sessions went on by themselves when the file was free',
        '1 note before tests: other sessions halfway through files',
        '2 sessions going in circles, flagged',
        '1 time you let a session through',
        '',
        'Today: 1 stop.',
        `Counted on this ${MACHINE} only. forchetta stats lists them.`,
      ].join('\n'),
    );
    expect(dayOf(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
  });
});

describe('forchetta stats', () => {
  const style = makeStyle(0);
  const io = () => {
    const out: string[] = [];
    return { out, io: { stdout: (text: string) => out.push(text), stderr: () => {}, style } as never };
  };

  it('lists what the guard did, the most important first', () => {
    const file = join(temp.dir, 'cli.json');
    writeFileSync(file, JSON.stringify({ version: 1, days: { '2026-11-17': { held: 12, tests: 3 }, '2026-11-14': { commit: 1 } } }));
    const t = io();
    expect(statsCommand({ days: 7, json: false }, t.io, file, NOV_17)).toBe(0);
    expect(t.out.join('')).toBe(
      [
        'What the guard did in the last 7 days (counted since 2026-11-14)',
        "  12  edits stopped while another session was changing the file",
        "   1  git add -A or commit -a kept from taking other sessions' changes",
        '   3  notes before tests: other sessions halfway through files',
        '',
        '  Today: 12 stops, 3 notes.',
        '',
      ].join('\n'),
    );
    const json = io();
    statsCommand({ days: 1, json: true }, json.io, file, NOV_17);
    expect(JSON.parse(json.out.join(''))).toEqual({ days: 1, counts: { held: 12, tests: 3 }, today: { held: 12, tests: 3 } });
  });

  it('says when nothing was counted yet, or nothing in those days', () => {
    const none = io();
    statsCommand({ days: 7, json: false }, none.io, join(temp.dir, 'missing.json'), NOV_17);
    expect(none.out.join('')).toContain('Nothing counted yet.');
    expect(statsText({ days: 7, counts: {}, today: {} }, { style })).toContain('The guard did nothing in the last 7 days.');
  });

  it('takes --days from 1 to 120, and has its help', () => {
    expect(parseDays('30')).toBe(30);
    expect(() => parseDays('0')).toThrow('from 1 to 120');
    expect(() => parseDays('7.5')).toThrow('from 1 to 120');
    expect(() => parseDays(undefined)).toThrow('--days needs a number');
    expect(commandHelp('stats', style)).toContain('forchetta stats [--days N] [--json]');
  });
});

describe('the guard counts what it does', () => {
  it('a stop, its end, git asked, a commit stopped, a note before tests, a let-through', async () => {
    const REPO = '/p/shop';
    let now = 1_000_000;
    const agents: Agent[] = [];
    const counted: string[] = [];
    const writes = new Map<string, Array<{ path: string; at: number; repo?: string }>>();
    const guard = new Guard({
      agents: () => agents,
      repoOf: (dir) => (dir.startsWith(REPO) ? REPO : undefined),
      writesOf: (id) => writes.get(id) ?? [],
      enabled: () => ({ files: true, git: true, notes: true }),
      touch: () => {},
      dirty: async () => [{ path: `${REPO}/src/api.ts`, untracked: false }],
      count: (kind) => counted.push(kind),
      now: () => now,
    });
    const add = (id: string): Agent => {
      const agent = newAgent({ id, cwd: REPO, control: { kind: 'tmux', session: `fk-${id}` }, state: 'working' }, now);
      agents.push(agent);
      return agent;
    };
    const alpha = add('alpha');
    const beta = add('beta');
    guard.wrote(alpha, `${REPO}/src/api.ts`);
    writes.set('alpha', [{ path: `${REPO}/src/api.ts`, at: now, repo: REPO }]);
    const edit = () => guard.decide(beta, { hook_event_name: 'PreToolUse', session_id: 'beta', tool_name: 'Edit', tool_input: { file_path: `${REPO}/src/api.ts`, old_string: 'a', new_string: 'b' } });
    const bash = (command: string) => guard.decide(beta, { hook_event_name: 'PreToolUse', session_id: 'beta', tool_name: 'Bash', tool_input: { command } });
    edit();
    edit();
    expect(counted).toEqual(['held']);
    guard.letThrough('beta', `${REPO}/src/api.ts`);
    guard.letThrough('beta', `${REPO}/src/api.ts`);
    expect(counted).toEqual(['held', 'letThrough']);
    bash('npm test');
    bash('git checkout main');
    await guard.decideCommit(beta, { hook_event_name: 'PreToolUse', session_id: 'beta', tool_name: 'Bash', tool_input: { command: 'git add -A' } });
    guard.hook(alpha, { hook_event_name: 'Stop', session_id: 'alpha' });
    expect(counted).toEqual(['held', 'letThrough', 'tests', 'git', 'commit', 'freed']);
    now += 1;
  });
});
