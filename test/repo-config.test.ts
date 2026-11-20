import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.ts';
import { findTeamSource, repoRoot } from '../src/cli/team.ts';
import { cliApi, findCrew, teamLine, threadMarkdown } from '../src/daemon/cli-api.ts';
import { parseRepoGuard, RepoConfig, repoTeamFiles, withRepoRules } from '../src/daemon/repo-config.ts';
import type { Agent } from '../src/shared/agent.ts';
import { type Crew, type CrewSpec, type CrewTemplate, cleanBudget, cleanCrewSpec } from '../src/shared/crew.ts';
import { teamFileOf } from '../src/shared/team-file.ts';
import { tempDir } from './helpers.ts';

// The settings of a repository in .forchetta/ (teams, rules, guard), and `forchetta team` on top of them.

const temp = tempDir('repo-config');
afterAll(() => temp.cleanup());

let repos = 0;
/** A repository with .git and .forchetta/teams. */
function repo(): string {
  const root = join(temp.dir, `repo-${++repos}`);
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.forchetta', 'teams'), { recursive: true });
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  return root;
}

const shop: CrewTemplate = { name: 'Shop squad', lead: { kind: 'claude', name: 'lead', role: 'Leads.' }, talk: 'twoway', members: [{ name: 'dev', role: 'Writes code.' }], rules: 'Small commits.' };

describe('.forchetta/guard.json', () => {
  it('names the parts of the guard on or off; the rest stays as configured', () => {
    expect(parseRepoGuard('{"files": false, "servers": true, "other": 1, "git": "no"}')).toEqual({ files: false, servers: true });
    expect(parseRepoGuard('[1]')).toMatchObject({ error: expect.any(String) });
    expect(parseRepoGuard('{ nope')).toMatchObject({ error: 'it is not JSON' });
  });

  it('is read again only when it changes, and a broken one is said once', () => {
    const root = repo();
    const file = join(root, '.forchetta', 'guard.json');
    const logs: string[] = [];
    const config = new RepoConfig((line) => logs.push(line));
    expect(config.guard(root)).toEqual({});
    writeFileSync(file, '{"git": false}');
    expect(config.guard(root)).toEqual({ git: false });
    writeFileSync(file, '{ broken');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(config.guard(root)).toEqual({});
    expect(config.guard(root)).toEqual({});
    expect(logs).toHaveLength(1);
    expect(config.guard(undefined)).toEqual({});
  });
});

describe('.forchetta/rules.md', () => {
  it('comes before the rules of the team, once', () => {
    expect(withRepoRules('Small commits.', 'Tests before each commit.')).toBe('Tests before each commit.\n\nSmall commits.');
    expect(withRepoRules(undefined, 'Tests before each commit.')).toBe('Tests before each commit.');
    expect(withRepoRules('Tests before each commit.\n\nSmall commits.', 'Tests before each commit.')).toBe('Tests before each commit.\n\nSmall commits.');
    expect(withRepoRules('Small commits.', undefined)).toBe('Small commits.');
    const root = repo();
    writeFileSync(join(root, '.forchetta', 'rules.md'), '\r\nUse pnpm.\r\n');
    expect(new RepoConfig().rulesOf(root)).toBe('Use pnpm.');
  });
});

describe('.forchetta/teams', () => {
  it('a team is found by its file name or by its name, from a folder inside the repository', () => {
    const root = repo();
    writeFileSync(join(root, '.forchetta', 'teams', 'shop-squad.forchetta-team.json'), JSON.stringify(teamFileOf(shop)));
    writeFileSync(join(root, '.forchetta', 'teams', 'notes.txt'), 'not a team');
    expect(repoTeamFiles(root).map((file) => file.key)).toEqual(['shop-squad']);
    expect(repoRoot(join(root, 'src', 'deep'))).toBe(root);
    expect(findTeamSource('shop-squad', join(root, 'src', 'deep'))).toMatchObject({ path: join(root, '.forchetta', 'teams', 'shop-squad.forchetta-team.json') });
    expect(findTeamSource('Shop Squad', root)).toMatchObject({ text: expect.stringContaining('"Shop squad"') });
    expect(findTeamSource('Feature squad', root)).toEqual({ template: 'Feature squad' });
    // A path to a file anywhere.
    const elsewhere = join(temp.dir, 'given.forchetta-team.json');
    writeFileSync(elsewhere, JSON.stringify(teamFileOf(shop)));
    expect(findTeamSource(elsewhere, root)).toMatchObject({ path: elsewhere });
  });
});

describe('the options of a command', () => {
  it('values, flags, the rest; an unknown option is said with the one meant', () => {
    expect(parseArgs('team start', ['shop', '--goal', 'Add a CSV export', '--budget=20', '--json'], { values: ['--goal', '--budget'], flags: ['--json'] })).toEqual({
      positional: ['shop'],
      values: new Map([
        ['--goal', 'Add a CSV export'],
        ['--budget', '20'],
      ]),
      flags: new Set(['--json']),
    });
    expect(() => parseArgs('team start', ['--gaol', 'x'], { values: ['--goal'] })).toThrow(/unknown option --gaol/);
    expect(() => parseArgs('team start', ['--goal'], { values: ['--goal'] })).toThrow(/needs a value/);
  });
});

describe('a budget', () => {
  it('is a positive number of dollars, kept with the team and its template', () => {
    expect(cleanBudget(20)).toBe(20);
    expect(cleanBudget('$12.505')).toBe(12.51);
    expect(cleanBudget(-1)).toBeUndefined();
    expect(cleanBudget('soon')).toBeUndefined();
    const checked = cleanCrewSpec({ ...shop, cwd: '/x', budgetUsd: 15 });
    expect('spec' in checked && checked.spec.budgetUsd).toBe(15);
  });
});

describe('the routes of `forchetta team`', () => {
  const now = 1_700_000_000_000;
  function setup() {
    const crews: Crew[] = [];
    const sent: { crewId: string; to: readonly string[]; text: string }[] = [];
    const agents = new Map<string, Agent>();
    const handle = cliApi({
      crews: {
        list: () => crews,
        get: (id) => crews.find((crew) => crew.id === id),
        create: async (spec: CrewSpec) => {
          if (crews.some((crew) => crew.name === spec.name)) return { ok: false, error: `a team called "${spec.name}" already exists: give this one another name` };
          const crew: Crew = { ...spec, id: `crew-${crews.length + 1}`, createdAt: now, agents: { lead: 'a1', dev: 'a2' } };
          crews.push(crew);
          return { ok: true, crewId: crew.id, agentIds: ['a1', 'a2'] };
        },
        request: (crewId, to, text) => {
          sent.push({ crewId, to, text });
          return { ok: true, n: 1, to: [...to] };
        },
        reviewsOf: () => [],
      },
      templates: { list: () => [shop] },
      agent: (id) => agents.get(id),
      importTeam: async () => ({ ok: true, ask: [{ id: 'release-notes', repo: 'someone/skills', path: 'skills/release-notes', commit: 'a'.repeat(40) }] }),
      folderOf: (path) => path,
      withRepoRules: (spec) => ({ ...spec, rules: withRepoRules(spec.rules, 'Use pnpm.') }),
      log: () => {},
    });
    return { crews, sent, agents, handle };
  }
  const query = (text = ''): URLSearchParams => new URLSearchParams(text);

  it('starts a template with its goal for the lead, the rules of the repository and a budget', async () => {
    const { crews, sent, handle } = setup();
    const answer = await handle('POST', '/api/teams/start', query(), { template: 'shop SQUAD', cwd: temp.dir, goal: ' Add a CSV export ', budgetUsd: '20' });
    expect(answer).toMatchObject({ status: 200, body: { ok: true, crewId: 'crew-1', name: 'Shop squad', goal: { n: 1, to: ['lead'] } } });
    expect(crews[0]).toMatchObject({ cwd: temp.dir, rules: 'Use pnpm.\n\nSmall commits.', budgetUsd: 20 });
    expect(sent).toEqual([{ crewId: 'crew-1', to: ['lead'], text: 'Add a CSV export' }]);
    // Twice the same name: said, with what to do.
    expect(await handle('POST', '/api/teams/start', query(), { template: 'Shop squad', cwd: temp.dir })).toMatchObject({ status: 400, body: { error: expect.stringContaining('already exists') } });
    expect(await handle('POST', '/api/teams/start', query(), { template: 'Nobody', cwd: temp.dir })).toMatchObject({ status: 404 });
    expect(await handle('POST', '/api/teams/start', query(), { template: 'Shop squad', cwd: join(temp.dir, 'missing') })).toMatchObject({ status: 400, body: { error: expect.stringContaining('does not exist') } });
    expect(await handle('POST', '/api/teams/start', query(), { template: 'Shop squad', cwd: temp.dir, name: 'Other', budgetUsd: 'lots' })).toMatchObject({ status: 400 });
  });

  it('a file with skills of GitHub asks first, and starts nothing', async () => {
    const { crews, handle } = setup();
    expect(await handle('POST', '/api/teams/start', query(), { text: '{}', cwd: temp.dir })).toMatchObject({ status: 200, body: { ok: true, ask: [{ id: 'release-notes' }] } });
    expect(crews).toHaveLength(0);
  });

  it('lists the teams with their sessions and what they cost; gives the thread and the file of a template', async () => {
    const { handle, agents } = setup();
    await handle('POST', '/api/teams/start', query(), { template: 'Shop squad', cwd: temp.dir, budgetUsd: 1 });
    agents.set('a1', { id: 'a1', state: 'working', usage: { usd: 0.75, at: now }, tokens: { input: 10, cacheWrite: 0, cacheRead: 100, output: 5 }, lastEvent: { name: 'PreToolUse', at: now }, project: 'shop', pastSessionIds: [], control: { kind: 'none' }, createdAt: now } as unknown as Agent);
    agents.set('a2', { id: 'a2', state: 'idle', usage: { usd: 0.5, at: now }, lastEvent: { name: 'Stop', at: now }, project: 'shop', pastSessionIds: [], control: { kind: 'none' }, createdAt: now } as unknown as Agent);
    const listed = (await handle('GET', '/api/teams', query(), {}))!.body as { teams: ReturnType<typeof teamLine>[] };
    expect(listed.teams[0]).toMatchObject({ name: 'Shop squad', lead: 'lead', usd: 1.25, tokens: 115, budgetUsd: 1, members: [{ name: 'lead', lead: true, state: 'working' }, { name: 'dev', state: 'idle' }] });
    expect(await handle('GET', '/api/teams/thread', query('team=shop squad'), {})).toMatchObject({ status: 200, body: { team: 'Shop squad', markdown: expect.stringContaining('# Shop squad') } });
    expect(await handle('GET', '/api/teams/thread', query('team=nobody'), {})).toMatchObject({ status: 404 });
    const file = (await handle('GET', '/api/templates/file', query('name=shop squad'), {}))!.body as { fileName: string; text: string };
    expect(file.fileName).toBe('shop-squad.forchetta-team.json');
    expect(JSON.parse(file.text)).toMatchObject({ kind: 'forchetta-team', template: { name: 'Shop squad' } });
    expect(await handle('GET', '/api/other', query(), {})).toBeUndefined();
  });

  it('writes the thread as Markdown, oldest first', () => {
    const crew: Crew = {
      ...shop,
      cwd: '/x',
      id: 'c',
      createdAt: now,
      agents: {},
      requests: [{ n: 1, from: 'the user', text: 'Add a CSV export', createdAt: now, deliveries: [{ to: 'lead', status: 'done', at: now + 60_000, answer: 'Done: the button is on the orders page.' }] }],
    };
    const text = threadMarkdown(crew, [{ sha: 'b'.repeat(40), short: 'bbbbbbb', subject: 'Add the export', by: 'dev', verdict: 'approved', at: now + 30_000 }]);
    expect(text).toContain('## #1 · the user → lead (done)');
    expect(text.indexOf('Review by dev')).toBeLessThan(text.indexOf('Answer from lead'));
    expect(text).toContain('> Done: the button is on the orders page.');
    expect(findCrew([crew], 'SHOP SQUAD')?.id).toBe('c');
  });
});
