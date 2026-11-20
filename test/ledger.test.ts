import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderReport, reportCommand } from '../src/cli/report.ts';
import { plain } from '../src/cli/style.ts';
import { Ledger, ledgerFile, parseSince, readLedger, report, reportCsv, whoOf } from '../src/daemon/ledger.ts';
import type { Agent } from '../src/shared/agent.ts';
import { tempDir } from './helpers.ts';

// The ledger: what the sessions and the teams did, a line each, and `forchetta report` on top of it.

const temp = tempDir('ledger');
afterAll(() => temp.cleanup());

let dirs = 0;
const folder = (): string => join(temp.dir, `l-${++dirs}`);
const T = new Date(2026, 10, 20, 10, 0, 0).getTime();

const agent = (id: string, extra: Partial<Agent> = {}): Agent =>
  ({ id, project: 'shop', pastSessionIds: [], control: { kind: 'none' }, state: 'working', lastEvent: { name: 'PreToolUse', at: T }, createdAt: T, model: 'claude-sonnet-5-5', ...extra }) as Agent;

const io = () => {
  let out = '';
  return { io: { stdout: (text: string) => void (out += text), stderr: () => {}, style: plain, errorStyle: plain }, out: () => out };
};

describe('the ledger', () => {
  it('writes what a session cost since the line before; a new process counts from zero again', () => {
    const dir = folder();
    const ledger = new Ledger(dir);
    const session = agent('a1', { usage: { usd: 0.5, at: T } });
    ledger.cost(session, whoOf(session), T);
    session.usage = { usd: 0.8, at: T };
    ledger.cost(session, whoOf(session), T + 1000);
    // Nothing new: no line.
    ledger.cost(session, whoOf(session), T + 2000);
    session.usage = { usd: 0.1, at: T };
    ledger.cost(session, whoOf(session), T + 3000);
    const costs = readLedger(dir, 0).map((entry) => (entry.kind === 'cost' ? entry.usd : undefined));
    expect(costs).toEqual([0.5, 0.3, 0.1]);
    expect(statSync(ledgerFile(dir, T)).mode & 0o777).toBe(0o600);
    expect(ledgerFile(dir, T)).toMatch(/2026-11\.jsonl$/);
  });

  it('a turn: how long, the files it wrote, its cost; the tokens of a session of a team', () => {
    const dir = folder();
    const ledger = new Ledger(dir);
    const member = agent('a2', { turnStartedAt: T - 90_000, usage: { usd: 1.25, at: T }, tokens: { input: 100, cacheWrite: 10, cacheRead: 1000, output: 50 }, team: { crew: 'c1', label: 'dev' } });
    ledger.wrote('a2', 'src/orders.ts');
    ledger.wrote('a2', 'src/orders.ts');
    ledger.wrote('a2', 'test/orders.test.ts');
    ledger.turn(member, whoOf(member, 'Shop squad'), { now: T });
    const entries = readLedger(dir, 0);
    expect(entries[0]).toMatchObject({ kind: 'turn', team: 'Shop squad', member: 'dev', ms: 90_000, files: ['src/orders.ts', 'test/orders.test.ts'] });
    expect(entries[1]).toMatchObject({ kind: 'cost', usd: 1.25, tokens: { input: 100, cacheRead: 1000 } });
    // Primed after a restart: what was counted is not counted again.
    const again = new Ledger(dir);
    again.prime('a2', ledger.countedOf('a2'));
    again.cost(member, whoOf(member, 'Shop squad'), T + 5000);
    expect(readLedger(dir, 0)).toHaveLength(2);
  });

  it('a line cut short is left out; only the period asked is read', () => {
    const dir = folder();
    const ledger = new Ledger(dir);
    ledger.append({ t: T - 40 * 86_400_000, kind: 'request', team: 'Shop squad', n: 1, from: 'the user', to: ['lead'] });
    ledger.append({ t: T, kind: 'request', team: 'Shop squad', n: 2, from: 'the user', to: ['lead'] });
    appendFileSync(ledgerFile(dir, T), '{"t": 17');
    expect(readLedger(dir, T - 86_400_000).map((entry) => (entry.kind === 'request' ? entry.n : 0))).toEqual([2]);
    expect(readLedger(join(dir, 'missing'), 0)).toEqual([]);
  });
});

describe('the report', () => {
  const entries = [
    { t: T, kind: 'cost' as const, agent: 'a1', project: 'shop', team: 'Shop squad', member: 'lead', model: 'claude-opus-5-5', usd: 2, tokens: { input: 10, cacheWrite: 0, cacheRead: 100, output: 5 } },
    { t: T, kind: 'cost' as const, agent: 'a2', project: 'shop', team: 'Shop squad', member: 'dev', model: 'claude-sonnet-5-5', usd: 1 },
    { t: T, kind: 'turn' as const, agent: 'a2', project: 'shop', team: 'Shop squad', member: 'dev', ms: 120_000, files: ['src/a.ts', 'src/b.ts'] },
    { t: T, kind: 'turn' as const, agent: 'a2', project: 'shop', team: 'Shop squad', member: 'dev', ms: 60_000, files: ['src/a.ts'], failed: true },
    { t: T, kind: 'guard' as const, agent: 'a2', project: 'shop', team: 'Shop squad', member: 'dev', decision: 'deny' as const, tool: 'Edit' },
    { t: T, kind: 'review' as const, team: 'Shop squad', by: 'reviewer', verdict: 'changes' as const, commit: 'abc1234' },
    { t: T, kind: 'request' as const, team: 'Shop squad', n: 1, from: 'the user', to: ['lead'] },
    { t: T + 86_400_000, kind: 'cost' as const, agent: 'a3', project: 'blog', usd: 0.5 },
  ];

  it('one row per team, session, project, model or day, the most expensive first', () => {
    const byTeam = report(entries, 'team');
    expect(byTeam.map((row) => [row.key, row.usd])).toEqual([
      ['Shop squad', 3],
      ['(no team)', 0.5],
    ]);
    expect(byTeam[0]).toMatchObject({ turns: 2, failedTurns: 1, ms: 180_000, files: 2, guard: { deny: 1 }, reviews: { changes: 1 }, requests: 1, sessions: 2 });
    expect(report(entries, 'session').map((row) => row.key)).toEqual(['Shop squad › lead', 'Shop squad › dev', 'blog (a3)', 'Shop squad › reviewer', 'Shop squad › the user']);
    expect(report(entries, 'model')[0]).toMatchObject({ key: 'claude-opus-5-5', usd: 2 });
    expect(report(entries, 'day').map((row) => row.key)).toEqual(['2026-11-20', '2026-11-21']);
    const csv = reportCsv(byTeam, 'team');
    expect(csv.split('\n')[0]).toBe('team,usd,tokens,input,cache_write,cache_read,output,sessions,turns,failed_turns,minutes,files,guard_deny,guard_ask,guard_note,reviews_approved,reviews_changes,requests');
    expect(csv.split('\n')[1]).toBe('Shop squad,3,115,10,0,100,5,2,2,1,3,2,1,0,0,0,1,1');
    expect(renderReport(byTeam, 'team', io().io, 'since today')).toContain('Shop squad');
  });

  it('`forchetta report` reads the folder, from a period, as a table, CSV or JSON', async () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    const ledger = new Ledger(dir);
    for (const entry of entries) ledger.append(entry);
    const table = io();
    expect(await reportCommand(['--since', '7d'], table.io, T + 2 * 86_400_000, dir)).toBe(0);
    expect(table.out()).toMatch(/TEAM\s+COST/);
    expect(table.out()).toContain('$3.00');
    const json = io();
    await reportCommand(['--by=day', '--json', '--team', 'shop squad'], json.io, T + 86_400_000, dir);
    expect(JSON.parse(json.out()).rows.map((row: { key: string }) => row.key)).toEqual(['2026-11-20']);
    const csv = io();
    await reportCommand(['--csv'], csv.io, T + 86_400_000, dir);
    expect(csv.out().split('\n')[0]).toMatch(/^team,usd/);
    await expect(reportCommand(['--by', 'modle'], io().io, T, dir)).rejects.toThrow(/--by is one of/);
    await expect(reportCommand(['--since', 'yesterday'], io().io, T, dir)).rejects.toThrow(/--since takes/);
    expect(readFileSync(ledgerFile(dir, T), 'utf8').split('\n').filter(Boolean)).toHaveLength(8);
  });

  it('a period: hours, days from midnight, weeks, a date', () => {
    const midnight = new Date(2026, 10, 20).getTime();
    expect(parseSince('24h', T)).toBe(T - 86_400_000);
    expect(parseSince('1d', T)).toBe(midnight);
    expect(parseSince('7d', T)).toBe(midnight - 6 * 86_400_000);
    expect(parseSince('2w', T)).toBe(midnight - 13 * 86_400_000);
    expect(parseSince('2026-11-01', T)).toBe(new Date(2026, 10, 1).getTime());
    expect(parseSince('soon', T)).toBeUndefined();
  });
});
