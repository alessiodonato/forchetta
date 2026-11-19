import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { crewApi, Crews, mergeRefs, reviewLine } from '../src/daemon/crews.ts';
import { type Call, createHandler, TOOLS } from '../src/mcp/team.ts';
import { BUILTIN_TEMPLATES, cleanCrewSpec, type CrewSpec, leadPrompt, memberPrompt, teamToolsFor, templateOf, threadOf } from '../src/shared/crew.ts';
import { entryHead, entryTag } from '../src/ui/TeamRequests.tsx';
import { draftsOf, specOf } from '../src/ui/NewTeam.tsx';
import { tempDir } from './helpers.ts';

// A member that reviews: it approves a commit, or asks for changes, with the tool review. Before a git merge of the
// branch of a member, the guard asks you when commits no approval covers would come in.

const temp = tempDir('reviews');
afterAll(() => temp.cleanup());

const ROOT = '/p/shop';

const checked = (input: unknown): CrewSpec => {
  const result = cleanCrewSpec(input);
  if ('error' in result) throw new Error(result.error);
  return result.spec;
};

const team = (patch: Record<string, unknown> = {}): CrewSpec =>
  checked({
    name: 'pair',
    cwd: ROOT,
    lead: { kind: 'claude', name: 'lead', role: 'Lead.' },
    talk: 'twoway',
    worktrees: true,
    members: [
      { name: 'developer', role: 'Code.' },
      { name: 'reviewer', role: 'Review.', reviews: true },
    ],
    ...patch,
  });

/** A repository with a branch of the developer, worktree-dev: c1, then c2 on top; HEAD of the folder is before both. */
const COMMITS = [
  { sha: 'c1'.padEnd(40, '1'), short: 'c111111', subject: 'add retries' },
  { sha: 'c2'.padEnd(40, '2'), short: 'c222222', subject: 'fix the test' },
];

function fakeGit(crewId: string) {
  const calls: Array<{ dir: string; args: string[] }> = [];
  const devTree = `${ROOT}/.claude/worktrees/pair-developer-${crewId.slice(0, 6)}`;
  const git = async (dir: string, args: string[]): Promise<string | undefined> => {
    calls.push({ dir, args });
    if (args[0] === 'show') {
      const wanted = args.at(-1)!.replace('^{commit}', '');
      const found = COMMITS.find((commit) => commit.sha.startsWith(wanted) || commit.short === wanted || (wanted === 'worktree-dev' && commit === COMMITS[1]));
      return found ? `${found.sha}\n${found.short}\n${found.subject}\n` : undefined;
    }
    if (args[0] === 'worktree') {
      return [
        `worktree ${ROOT}\nHEAD ${'0'.repeat(40)}\nbranch refs/heads/main`,
        `worktree ${devTree}\nHEAD ${COMMITS[1]!.sha}\nbranch refs/heads/worktree-dev`,
        `worktree ${ROOT}/.claude/worktrees/pair-reviewer-${crewId.slice(0, 6)}\nHEAD ${'0'.repeat(40)}\nbranch refs/heads/worktree-rev`,
        '',
      ].join('\n\n');
    }
    if (args[0] === 'log') {
      // The commits of the branch not in HEAD, without those an approval covers (an approval of c2 covers c1).
      const excluded = new Set(args.filter((arg) => arg.startsWith('^') && arg !== '^HEAD').map((arg) => arg.slice(1)));
      if (excluded.has(COMMITS[1]!.sha)) return '';
      const left = excluded.has(COMMITS[0]!.sha) ? [COMMITS[1]!] : [COMMITS[1]!, COMMITS[0]!];
      return `${left.map((commit) => `${commit.sha} ${commit.short} ${commit.subject}`).join('\n')}\n`;
    }
    return undefined;
  };
  return { git, calls, devTree };
}

const started = async (crew = team()) => {
  const crews = new Crews(join(temp.dir, `reviews-${Math.random()}`));
  crews.inGit = () => true;
  crews.gitInfo = () => ({ root: ROOT });
  let next = 0;
  const result = await crews.create(crew, async () => ({ ok: true as const, agentId: `agent-${++next}` }));
  const crewId = result.crewId!;
  const fake = fakeGit(crewId);
  crews.git = fake.git;
  // agent-1 lead, agent-2 developer, agent-3 reviewer.
  return { crews, crewId, ...fake };
};

describe('a member that reviews', () => {
  it('gets the tool review, with team; and ask_lead when it answers', () => {
    expect(teamToolsFor({ talk: 'twoway', members: [] }, { name: 'r', reviews: true })).toEqual(['team', 'ask_lead', 'review']);
    expect(teamToolsFor({ talk: 'oneway', members: [] }, { name: 'r', reviews: true })).toEqual(['team', 'review']);
    expect(teamToolsFor({ talk: 'oneway', members: [] }, { name: 'r' })).toEqual([]);
    expect(TOOLS.review.inputSchema).toMatchObject({ required: ['commit', 'verdict', 'note'] });
  });

  it('the template developer + reviewer has one, and the panel keeps the choice', () => {
    const template = BUILTIN_TEMPLATES.find((candidate) => candidate.name === 'developer + reviewer')!;
    expect(template.members.find((member) => member.name === 'reviewer')?.reviews).toBe(true);
    expect('spec' in cleanCrewSpec({ ...template, cwd: ROOT })).toBe(true);
    const drafts = draftsOf(template);
    expect(drafts[1]).toMatchObject({ reviews: true, more: true });
    const spec = specOf({ name: 'x', folder: ROOT, leadKind: 'claude', leadName: 'lead', leadRole: '', leadModel: '', leadMode: '', talk: 'twoway', members: drafts });
    expect(spec.members.map((member) => member.reviews)).toEqual([undefined, true]);
    expect(templateOf(team()).members[1]).toEqual({ name: 'reviewer', role: 'Review.', reviews: true });
  });

  it('the prompts say how verdicts work: the reviewer records them, the lead merges only what was approved', () => {
    const crew = team();
    expect(memberPrompt(crew, crew.members[1]!)).toContain('record your verdict with the tool review of the server "forchetta"');
    expect(memberPrompt(crew, crew.members[0]!)).not.toContain('tool review');
    const lead = leadPrompt(crew);
    expect(lead).toContain('- reviewer (answers you, own worktree, reviews): Review.');
    expect(lead).toContain('Merge a branch only up to the last commit it approved');
    expect(leadPrompt(team({ members: [{ name: 'a' }] }))).not.toContain('reviews');
  });
});

describe('a verdict', () => {
  it('is recorded on the commit git finds in the folder of the reviewer, with its note', async () => {
    const { crews, crewId, calls } = await started();
    crews.agent = (id) => (id === 'agent-3' ? ({ id, cwd: `${ROOT}/.claude/worktrees/rev` } as never) : undefined);
    const result = await crews.review('agent-3', 'c111', 'approve', 'Retries look right; tests cover the backoff.', 5_000);
    expect(result).toEqual({ ok: true, short: 'c111111', subject: 'add retries', verdict: 'approved' });
    expect(calls[0]).toEqual({ dir: `${ROOT}/.claude/worktrees/rev`, args: ['show', '-s', '--format=%H%n%h%n%s', 'c111^{commit}'] });
    expect(crews.reviewsOf(crewId)).toEqual([
      { sha: COMMITS[0]!.sha, short: 'c111111', subject: 'add retries', by: 'reviewer', verdict: 'approved', note: 'Retries look right; tests cover the backoff.', at: 5_000 },
    ]);
  });

  it('is refused to anyone that does not review, and when it says too little', async () => {
    const { crews } = await started();
    expect(await crews.review('agent-2', 'c111', 'approve', 'mine')).toEqual({ ok: false, error: 'only a member that reviews can record a verdict' });
    expect(await crews.review('agent-1', 'c111', 'approve', 'x')).toMatchObject({ ok: false });
    expect(await crews.review('agent-3', '', 'approve', 'x')).toEqual({ ok: false, error: 'give the hash of the commit you reviewed' });
    expect(await crews.review('agent-3', '--all', 'approve', 'x')).toMatchObject({ ok: false });
    expect(await crews.review('agent-3', 'c111; rm -rf /', 'approve', 'x')).toMatchObject({ ok: false });
    expect(await crews.review('agent-3', 'c111', 'maybe', 'x')).toEqual({ ok: false, error: 'the verdict is "approve" or "changes"' });
    expect(await crews.review('agent-3', 'c111', 'changes', '  ')).toEqual({ ok: false, error: 'say in the note what to fix' });
    expect(await crews.review('agent-3', 'deadbeef', 'approve', 'x')).toMatchObject({ ok: false, error: expect.stringContaining('git does not know the commit "deadbeef"') });
  });

  it('shows in the thread of the team and in the tool team', async () => {
    const { crews, crewId } = await started();
    await crews.review('agent-3', 'c222', 'changes', 'The test does not wait for the retry.', 6_000);
    const entries = threadOf([], crews.reviewsOf(crewId));
    expect(entries).toEqual([{ kind: 'review', at: 6_000, n: 0, from: 'reviewer', short: 'c222222', subject: 'fix the test', verdict: 'changes', text: 'The test does not wait for the retry.' }]);
    expect(entryHead(entries[0]!)).toBe('reviewer · reviewed c222222 fix the test');
    expect(entryTag(entries[0]!)).toBe('changes asked');
    expect(crews.teamText('agent-1')).toContain('Last verdicts of the reviewers, newest last:\n- c222222 fix the test: changes asked by reviewer, ');
    expect(reviewLine({ sha: 'x', short: 'abc1234', by: 'r', verdict: 'approved', at: 0 })).toMatch(/^abc1234: approved by r, \d\d:\d\d/);
  });

  it('comes from the route of the MCP server, and the tool says what was recorded', async () => {
    const { crews } = await started();
    const answer = await crewApi(crews, 'review', { agent: 'agent-3', commit: 'c222', verdict: 'approve', note: 'Good.' });
    expect(answer).toEqual({ status: 200, body: { ok: true, short: 'c222222', subject: 'fix the test', verdict: 'approved' } });
    const routed: Array<{ route: string; body: Record<string, unknown> }> = [];
    const call: Call = async (route, body) => {
      routed.push({ route, body });
      return body.verdict === 'approve' ? { ok: true, short: 'c222222', subject: 'fix the test', verdict: 'approved' } : { ok: false, error: 'say in the note what to fix' };
    };
    const handle = createHandler({ agent: 'agent-3', tools: ['team', 'review'], call });
    const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((listed?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(['team', 'review']);
    const ok = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'review', arguments: { commit: 'c222', verdict: 'approve', note: 'Good.' } } });
    expect(routed[0]).toEqual({ route: 'review', body: { agent: 'agent-3', commit: 'c222', verdict: 'approve', note: 'Good.' } });
    expect((ok?.result as { content: { text: string }[] }).content[0]!.text).toBe('Recorded: you approved c222222 (fix the test). The lead can merge its branch up to it.');
    const refused = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'review', arguments: { commit: 'c222', verdict: 'changes', note: '' } } });
    expect(refused?.result).toMatchObject({ isError: true, content: [{ text: 'say in the note what to fix' }] });
  });
});

describe('a merge of the branch of a member', () => {
  it('reads what git merge merges: its arguments, not its options and their values', () => {
    expect(mergeRefs(['--no-ff', 'worktree-dev'])).toEqual(['worktree-dev']);
    expect(mergeRefs(['-m', 'merge dev', 'worktree-dev', 'other'])).toEqual(['worktree-dev', 'other']);
    expect(mergeRefs(['--strategy', 'ours', '-X', 'theirs', '--squash', 'a'])).toEqual(['a']);
    expect(mergeRefs(['--abort'])).toEqual([]);
    expect(mergeRefs(['--', 'b'])).toEqual(['b']);
  });

  it('with nothing approved: you are asked, with the commits that would come in', async () => {
    const { crews } = await started();
    const answer = await crews.decideMerge('agent-1', 'git merge --no-ff worktree-dev', ROOT);
    expect(answer).toEqual({
      decision: 'ask',
      reason:
        'Forchetta: "git merge --no-ff worktree-dev" would bring in commits of developer that reviewer, who reviews in the team "pair", has not approved: c222222 fix the test; c111111 add retries. reviewer has approved nothing yet. Allow it only if you want them merged without that review.',
    });
  });

  it('an approval covers its commit and those before it: a commit after it is still asked', async () => {
    const { crews } = await started();
    await crews.review('agent-3', 'c111', 'approve', 'ok');
    const answer = await crews.decideMerge('agent-1', 'git merge worktree-dev', ROOT);
    expect(answer?.reason).toContain('has not approved: c222222 fix the test.');
    expect(answer?.reason).toContain('The last approval is of c111111 (add retries).');
    await crews.review('agent-3', 'c222', 'approve', 'ok');
    expect(await crews.decideMerge('agent-1', 'git merge worktree-dev', ROOT)).toBeUndefined();
  });

  it('says when the reviewer asked for changes on what would come in', async () => {
    const { crews } = await started();
    await crews.review('agent-3', 'c222', 'changes', 'The test does not wait for the retry.');
    expect((await crews.decideMerge('agent-1', 'cd /p/shop && git merge worktree-dev', ROOT))?.reason).toContain(
      'reviewer asked for changes on c222222: The test does not wait for the retry.',
    );
  });

  it('only the branches of the members, only in a team with a reviewer, only git merge', async () => {
    const { crews } = await started();
    expect(await crews.decideMerge('agent-1', 'git merge origin/main', ROOT)).toBeUndefined();
    expect(await crews.decideMerge('agent-1', 'git merge worktree-rev', ROOT)).toBeUndefined();
    expect(await crews.decideMerge('agent-1', 'git log worktree-dev', ROOT)).toBeUndefined();
    expect(await crews.decideMerge('someone', 'git merge worktree-dev', ROOT)).toBeUndefined();
    const plain = await started(team({ members: [{ name: 'developer' }, { name: 'tester' }] }));
    expect(await plain.crews.decideMerge('agent-1', 'git merge worktree-dev', ROOT)).toBeUndefined();
  });

  it('when git does not answer, it lets the merge go: the guard never blocks on its own failure', async () => {
    const { crews } = await started();
    crews.git = async () => undefined;
    expect(await crews.decideMerge('agent-1', 'git merge worktree-dev', ROOT)).toBeUndefined();
  });
});
