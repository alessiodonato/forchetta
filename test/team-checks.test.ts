import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cliApi } from '../src/daemon/cli-api.ts';
import { describeTeam } from '../src/daemon/describe.ts';
import { demoDescribe } from '../src/demo/describe.ts';
import { BUILTIN_TEMPLATES, type Crew, type CrewMemberSpec, type CrewSpec, type CrewTemplate } from '../src/shared/crew.ts';
import { DESCRIBE_SYSTEM } from '../src/shared/describe.ts';
import { type CheckedTeam, TEAM_CHECKS_GUIDE, teamChecks } from '../src/shared/team-checks.ts';
import { TEMPLATE_GUIDE } from '../src/shared/team-schema.ts';
import { checksOfDoc, docOfTemplate } from '../src/ui/studio-model.ts';
import { tempDir } from './helpers.ts';

const temp = tempDir('team-checks');
afterAll(() => temp.cleanup());

const claudeLead = { kind: 'claude' as const, name: 'lead', role: 'Leads.' };
const team = (members: CrewMemberSpec[], extra: Partial<CheckedTeam> = {}): CheckedTeam => ({ lead: claudeLead, members, ...extra });
const texts = (checked: CheckedTeam): string[] => teamChecks(checked).map((check) => check.text);

describe('the checks before a team starts', () => {
  it('find nothing in the teams of Forchetta, nor in the teams the demo draws', () => {
    for (const template of BUILTIN_TEMPLATES) expect([template.name, texts(template)]).toEqual([template.name, []]);
    for (const words of [
      'A team to add a CSV export to the orders page: a senior that plans, tests in a browser, a reviewer that approves, and a pull request at the end.',
      'A frontend, a backend and a tester for the checkout.',
      'Research the sources and write the docs.',
      'A developer and a reviewer.',
    ]) {
      const drawn = demoDescribe(words);
      expect([words, texts(drawn.template!)]).toEqual([words, []]);
    }
    // "checkout" is not a checkpoint.
    expect(demoDescribe('A frontend, a backend and a tester for the checkout.').template!.members.some((member) => member.approve)).toBe(false);
    expect(demoDescribe('A developer, with a checkpoint before it starts.').template!.members.some((member) => member.approve)).toBe(true);
  });

  it('a member that writes in its own worktree without the shell cannot commit', () => {
    const coder: CrewMemberSpec = { name: 'coder', role: 'Builds.', tools: { limits: ['no-bash'] } };
    expect(teamChecks(team([coder], { worktrees: true }))).toEqual([
      { who: ['coder'], text: 'coder writes in a worktree of its own but has "no shell": it cannot commit, so lead never sees its work. Take "no shell" off, or take it out of the worktree.' },
    ]);
    expect(texts(team([coder], { lead: { kind: 'you' }, worktrees: true }))[0]).toContain('so you never see its work');
    // In the folder of the team, what it writes is there for all; one that writes nothing has nothing to commit.
    expect(texts(team([coder]))).toEqual([]);
    expect(texts(team([{ ...coder, worktree: false }], { worktrees: true }))).toEqual([]);
    expect(texts(team([{ ...coder, tools: { limits: ['read-only', 'no-bash'] } }], { worktrees: true }))).toEqual([]);
    expect(texts(team([{ ...coder, mode: 'plan' }], { worktrees: true }))).toEqual([]);
  });

  it('a reviewer needs the shell, someone else that commits, and no way to fix the code itself', () => {
    const dev: CrewMemberSpec = { name: 'dev', role: 'Builds.' };
    const reviewer: CrewMemberSpec = { name: 'rev', role: 'Reviews.', reviews: true, tools: { limits: ['read-only', 'no-push'] } };
    expect(texts(team([dev, reviewer], { worktrees: true }))).toEqual([]);
    expect(texts(team([dev, { ...reviewer, tools: { limits: ['read-only', 'no-bash'] } }]))).toEqual([
      'rev reviews but has "no shell": without git log and git diff it cannot see the commits it should approve. Take "no shell" off.',
    ]);
    expect(texts(team([dev, { ...reviewer, tools: undefined }], { worktrees: true }))).toEqual([
      'rev reviews and can also change the files: it may fix the code itself instead of approving it or sending it back. Give it "read only".',
    ]);
    // In plan mode it changes nothing.
    expect(texts(team([dev, { ...reviewer, tools: undefined, mode: 'plan' }], { worktrees: true }))).toEqual([]);
    // Nobody else writes and commits: the lead reads only, the other member has no shell.
    const quiet = team([{ ...dev, tools: { limits: ['no-bash'] } }, reviewer], { lead: { ...claudeLead, tools: { limits: ['read-only'] } } });
    expect(teamChecks(quiet)).toEqual([{ who: ['rev'], text: 'rev reviews, but no one else in the team can write and commit: it has nothing to review.' }]);
    // When you lead, the commits can be yours.
    expect(texts(team([reviewer], { lead: { kind: 'you' } }))).toEqual([]);
  });

  it('a pull request needs someone that can push; a deliverable needs a Claude lead to be told', () => {
    const nopush = { limits: ['no-push' as const] };
    const pr = team([{ name: 'dev', role: 'Builds.', tools: nopush }], { lead: { ...claudeLead, tools: nopush }, worktrees: true, deliverable: 'A PR with the change, its tests passing.' });
    expect(teamChecks(pr)).toEqual([
      {
        who: ['lead'],
        text: 'The team delivers "A PR with the change, its tests passing.", but no one in it can git push ("no shell" or "no git push" on every agent): it cannot hand it over. Let lead, or one member, push.',
      },
    ]);
    expect(texts({ ...pr, deliverable: 'a pull request' })).toHaveLength(1);
    expect(texts({ ...pr, deliverable: 'the branch pushed' })).toHaveLength(1);
    // A file is not pushed; "pr" in a word is not a pull request; one member that can push is enough.
    expect(texts({ ...pr, deliverable: 'docs/report.md' })).toEqual([]);
    expect(texts({ ...pr, deliverable: 'a PRD of the feature' })).toEqual([]);
    expect(texts({ ...pr, members: [...pr.members, { name: 'ops', role: 'Ships.' }] })).toEqual([]);
    expect(teamChecks(team([{ name: 'dev', role: 'Builds.' }], { lead: { kind: 'you' }, deliverable: 'docs/report.md' }))).toEqual([
      { who: [], text: 'The team delivers "docs/report.md", but you lead it: only a Claude lead says when the work is delivered, so no one will tell you. The members still know what it is.' },
    ]);
  });

  it('two members that write in the folder at the same time, with no files of their own', () => {
    const a: CrewMemberSpec = { name: 'a', role: 'Builds.' };
    const b: CrewMemberSpec = { name: 'b', role: 'Builds.' };
    expect(teamChecks(team([a, b]))).toEqual([
      { who: ['a', 'b'], text: 'a and b change files in the folder of the team at the same time, none with files of its own: they can edit the same file at once. Give each its files, or a worktree of its own.' },
    ]);
    // One above the other waits for the one below; files of its own, a worktree, or reading only: no clash.
    expect(texts(team([a, { ...b, reportsTo: 'a' }]))).toEqual([]);
    expect(texts(team([a, { ...b, paths: ['src/ui/'] }]))).toEqual([]);
    expect(texts(team([a, b], { worktrees: true }))).toEqual([]);
    expect(texts(team([a, { ...b, worktree: true }]))).toEqual([]);
    expect(texts(team([a, { ...b, tools: { limits: ['read-only'] } }]))).toEqual([]);
    // Under different leaders, any of them can be at work at once: a with b and with c, b leads c.
    expect(teamChecks(team([a, b, { name: 'c', role: 'Builds.', reportsTo: 'b' }]))[0]!.who).toEqual(['a', 'b', 'c']);
    expect(texts(team([a, b, { name: 'c', role: 'Builds.', reportsTo: 'b' }]))[0]).toMatch(/^a, b and c change files/);
  });

  it('the studio marks the boxes they are about, with or without a folder', () => {
    const template: CrewTemplate = { name: 'pair', lead: claudeLead, talk: 'twoway', members: [{ name: 'dev', role: 'Builds.' }, { name: 'rev', role: 'Reviews.', reviews: true }] };
    const doc = docOfTemplate(template);
    const rev = doc.nodes.find((node) => node.name === 'rev')!;
    expect(checksOfDoc(doc)).toEqual([
      { keys: [rev.key], text: expect.stringContaining('rev reviews and can also change the files') },
      { keys: doc.nodes.filter((node) => node.name !== 'lead').map((node) => node.key), text: expect.stringContaining('dev and rev change files') },
    ]);
    // Not a team yet: nothing to say.
    expect(checksOfDoc({ ...doc, links: [] })).toEqual([]);
  });

  it('Claude reads them when it draws a team, and gets one that works against itself back once', async () => {
    expect(TEMPLATE_GUIDE).toContain(TEAM_CHECKS_GUIDE);
    expect(DESCRIBE_SYSTEM).toContain(TEAM_CHECKS_GUIDE);
    const clashing = { name: 'squad', lead: claudeLead, talk: 'twoway', members: [{ name: 'a', role: 'Builds.' }, { name: 'b', role: 'Builds.' }] };
    const fixed = { ...clashing, worktrees: true };
    const worse = { ...clashing, members: [...clashing.members, { name: 'r', role: 'Reviews.', reviews: true }] };
    const draw = async (answers: unknown[]) => {
      const prompts: string[] = [];
      const result = await describeTeam('Two builders.', {
        claude: '/bin/claude',
        log: () => {},
        dir: join(temp.dir, 'describe'),
        run: async (_args, input) => {
          prompts.push(input);
          const answer = answers[prompts.length - 1];
          return { code: 0, stdout: JSON.stringify(answer === 'fail' ? { is_error: true, result: 'Overloaded' } : { is_error: false, structured_output: answer, total_cost_usd: 0.01 }), stderr: '' };
        },
      });
      return { result, prompts };
    };
    const once = await draw([clashing, fixed]);
    expect(once.result).toMatchObject({ ok: true, usd: 0.02, template: { worktrees: true } });
    expect(once.prompts[1]).toContain('Forchetta warns about your last answer');
    expect(once.prompts[1]).toContain('- a and b change files in the folder of the team at the same time');
    // A clean team at once is not asked again.
    expect((await draw([fixed])).prompts).toHaveLength(1);
    // A second answer that fails, or holds together less, leaves the first one.
    expect((await draw([clashing, 'fail'])).result).toMatchObject({ ok: true, template: { members: [{ name: 'a' }, { name: 'b' }] } });
    expect((await draw([clashing, { ...clashing, members: [] }])).result).toMatchObject({ ok: true, template: { name: 'squad' } });
    expect((await draw([clashing, worse])).result.template!.members).toHaveLength(2);
  });

  it('`forchetta team start` says them after the team started', async () => {
    const pair: CrewTemplate = { name: 'Pair', lead: claudeLead, talk: 'twoway', members: [{ name: 'dev', role: 'Builds.' }, { name: 'rev', role: 'Reviews.', reviews: true, tools: { limits: ['read-only'] } }], worktrees: true };
    const crews: Crew[] = [];
    const handle = cliApi({
      crews: {
        list: () => crews,
        get: (id) => crews.find((crew) => crew.id === id),
        create: async (spec: CrewSpec) => {
          crews.push({ ...spec, id: `crew-${crews.length + 1}`, createdAt: 0, agents: {} });
          return { ok: true, crewId: `crew-${crews.length}`, agentIds: [] };
        },
        request: (_crewId, to) => ({ ok: true, n: 1, to: [...to] }),
        reviewsOf: () => [],
      },
      templates: { list: () => [pair, { ...pair, name: 'Loose pair', members: [pair.members[0]!, { ...pair.members[1]!, tools: undefined }] }] },
      agent: () => undefined,
      importTeam: async () => ({ ok: false, error: 'no' }),
      folderOf: (path) => path,
      withRepoRules: (spec) => spec,
      log: () => {},
    });
    const clean = await handle('POST', '/api/teams/start', new URLSearchParams(), { template: 'Pair', cwd: temp.dir });
    expect(clean?.body).not.toHaveProperty('checks');
    const loose = await handle('POST', '/api/teams/start', new URLSearchParams(), { template: 'Loose pair', cwd: temp.dir });
    expect(loose?.body).toMatchObject({ ok: true, checks: [expect.stringContaining('rev reviews and can also change the files')] });
  });
});
