import { describe, expect, it } from 'vitest';
import type { GuardHold } from '../src/shared/agent.ts';
import { changesWorkingTree, gitCommands, Guard, HOLD_AFTER_TURN_MS, hookOutput, shellCommands, targetFile } from '../src/daemon/guard.ts';
import { type Agent, type HookPayload, newAgent } from '../src/daemon/state.ts';

// The guard: a session that holds a file in its turn, another that is stopped, and git commands that would change
// the files under another session.

const REPO = '/p/shop';
const OTHER_REPO = '/p/shop-wt';

function setup(options: { files?: boolean; git?: boolean } = {}) {
  let now = 1_000_000;
  const agents: Agent[] = [];
  const touched: string[] = [];
  const freed: Array<{ waiter: string; files: GuardHold[]; by: string }> = [];
  const writes = new Map<string, Array<{ path: string; at: number; repo?: string }>>();
  const guard = new Guard({
    agents: () => agents,
    repoOf: (dir) => (dir === REPO || dir.startsWith(`${REPO}/`) ? REPO : dir === OTHER_REPO || dir.startsWith(`${OTHER_REPO}/`) ? OTHER_REPO : undefined),
    writesOf: (id) => writes.get(id) ?? [],
    enabled: () => ({ files: options.files ?? true, git: options.git ?? true }),
    touch: (agent) => touched.push(agent.id),
    onFree: (waiter, files, by) => freed.push({ waiter: waiter.id, files, by: by.id }),
    now: () => now,
  });
  const add = (id: string, cwd = REPO, state: Agent['state'] = 'working'): Agent => {
    const agent = newAgent({ id, cwd, control: { kind: 'tmux', session: `fk-${id}` }, state }, now);
    agents.push(agent);
    return agent;
  };
  /** A write that went through: what the daemon tells the guard and the conflicts. */
  const write = (agent: Agent, path: string): void => {
    guard.wrote(agent, path);
    writes.set(agent.id, [...(writes.get(agent.id) ?? []), { path, at: now, repo: path.startsWith(REPO) ? REPO : undefined }]);
  };
  const edit = (agent: Agent, file: string) =>
    guard.decide(agent, { hook_event_name: 'PreToolUse', session_id: agent.id, tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });
  const bash = (agent: Agent, command: string) => guard.decide(agent, { hook_event_name: 'PreToolUse', session_id: agent.id, tool_name: 'Bash', tool_input: { command } });
  const event = (agent: Agent, payload: Partial<HookPayload> & { hook_event_name: string }): void => guard.hook(agent, { session_id: agent.id, ...payload });
  return { guard, add, write, edit, bash, event, touched, freed, agents, advance: (ms: number) => (now += ms) };
}

describe('the file of a tool', () => {
  it('is the file it writes, made absolute; nothing for the tools that write none', () => {
    expect(targetFile('Edit', { file_path: 'src/a.ts' }, REPO)).toBe(`${REPO}/src/a.ts`);
    expect(targetFile('Write', { file_path: '/x/../y/b.ts' }, REPO)).toBe('/y/b.ts');
    expect(targetFile('NotebookEdit', { notebook_path: 'n.ipynb' }, REPO)).toBe(`${REPO}/n.ipynb`);
    expect(targetFile('Read', { file_path: 'src/a.ts' }, REPO)).toBeUndefined();
    expect(targetFile('Edit', { file_path: 'a.ts' }, undefined)).toBeUndefined();
  });
});

describe('files', () => {
  it('stops a session from editing a file another one is changing in its turn, and says why to Claude', () => {
    const t = setup();
    const alpha = t.add('alpha');
    const beta = t.add('beta');
    alpha.team = { label: 'billing-api' };
    t.write(alpha, `${REPO}/src/api.ts`);
    const decision = t.edit(beta, `${REPO}/src/api.ts`);
    expect(decision?.decision).toBe('deny');
    expect(decision?.reason).toContain('"billing-api", another Claude Code session on this Mac, is changing src/api.ts');
    expect(decision?.reason).toContain('You will be told when the file is free.');
    expect(hookOutput(decision!)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision!.reason } });
    // Both boxes say it.
    expect(beta.heldBack).toEqual([{ file: 'src/api.ts', path: `${REPO}/src/api.ts`, with: 'alpha', withName: 'billing-api', since: expect.any(Number) }]);
    expect(alpha.holding).toEqual([{ file: 'src/api.ts', path: `${REPO}/src/api.ts`, with: 'beta', withName: 'shop', since: expect.any(Number) }]);
    expect(t.touched).toEqual(expect.arrayContaining(['alpha', 'beta']));
  });

  it('lets through another file, the same session, and the same file in another worktree', () => {
    const t = setup();
    const alpha = t.add('alpha');
    const beta = t.add('beta');
    const gamma = t.add('gamma', OTHER_REPO);
    t.write(alpha, `${REPO}/src/api.ts`);
    expect(t.edit(beta, `${REPO}/src/other.ts`)).toBeUndefined();
    expect(t.edit(alpha, `${REPO}/src/api.ts`)).toBeUndefined();
    expect(t.edit(gamma, `${OTHER_REPO}/src/api.ts`)).toBeUndefined();
    expect(beta.heldBack).toBeUndefined();
  });

  it('frees the file at the end of the turn, and tells the session that waited', () => {
    const t = setup();
    const alpha = t.add('alpha');
    const beta = t.add('beta');
    t.write(alpha, `${REPO}/src/api.ts`);
    t.edit(beta, `${REPO}/src/api.ts`);
    // A subagent that stops does not end the turn.
    t.event(alpha, { hook_event_name: 'Stop', agent_id: 'sub-1' });
    expect(t.edit(beta, `${REPO}/src/api.ts`)?.decision).toBe('deny');
    alpha.state = 'idle';
    t.event(alpha, { hook_event_name: 'Stop' });
    expect(t.freed).toEqual([{ waiter: 'beta', by: 'alpha', files: [expect.objectContaining({ file: 'src/api.ts', withName: 'shop' })] }]);
    expect(beta.heldBack).toBeUndefined();
    expect(alpha.holding).toBeUndefined();
    expect(t.edit(beta, `${REPO}/src/api.ts`)).toBeUndefined();
  });

  it('frees it on an error, a /clear, the end of the session', () => {
    for (const end of [{ hook_event_name: 'StopFailure' }, { hook_event_name: 'SessionStart', source: 'clear' }, { hook_event_name: 'SessionEnd' }]) {
      const t = setup();
      const alpha = t.add('alpha');
      const beta = t.add('beta');
      t.write(alpha, `${REPO}/a.ts`);
      expect(t.edit(beta, `${REPO}/a.ts`)?.decision).toBe('deny');
      t.event(alpha, end);
      alpha.state = 'idle';
      expect(t.edit(beta, `${REPO}/a.ts`)).toBeUndefined();
    }
  });

  it('between turns, holds a file written in the background for two minutes only', () => {
    const t = setup();
    const alpha = t.add('alpha', REPO, 'idle');
    const beta = t.add('beta');
    t.write(alpha, `${REPO}/a.ts`);
    expect(t.edit(beta, `${REPO}/a.ts`)?.decision).toBe('deny');
    t.advance(HOLD_AFTER_TURN_MS);
    expect(t.edit(beta, `${REPO}/a.ts`)).toBeUndefined();
    expect(beta.heldBack).toBeUndefined();
  });

  it('an ended session holds nothing, and waits for nothing', () => {
    const t = setup();
    const alpha = t.add('alpha');
    const beta = t.add('beta');
    t.write(alpha, `${REPO}/a.ts`);
    t.edit(beta, `${REPO}/a.ts`);
    beta.state = 'ended';
    t.guard.ended(beta);
    expect(beta.heldBack).toBeUndefined();
    expect(alpha.holding).toBeUndefined();
    const gamma = t.add('gamma');
    alpha.state = 'ended';
    t.guard.ended(alpha);
    expect(t.edit(gamma, `${REPO}/a.ts`)).toBeUndefined();
  });

  it('let through from the box: both go on that file until the turn ends', () => {
    const t = setup();
    const alpha = t.add('alpha');
    const beta = t.add('beta');
    t.write(alpha, `${REPO}/a.ts`);
    t.edit(beta, `${REPO}/a.ts`);
    expect(t.guard.letThrough('beta', `${REPO}/a.ts`)).toBe(true);
    expect(beta.heldBack?.[0]?.letThrough).toBe(true);
    expect(t.edit(beta, `${REPO}/a.ts`)).toBeUndefined();
    t.write(beta, `${REPO}/a.ts`);
    // More writes of beta, and alpha after beta wrote it last: no stop.
    expect(t.edit(beta, `${REPO}/a.ts`)).toBeUndefined();
    expect(t.edit(alpha, `${REPO}/a.ts`)).toBeUndefined();
    // The end of the turn of alpha closes it, and tells beta nothing more: it went on already.
    alpha.state = 'idle';
    t.event(alpha, { hook_event_name: 'Stop' });
    expect(beta.heldBack).toBeUndefined();
    expect(t.guard.letThrough('beta', `${REPO}/a.ts`)).toBe(false);
  });

  it('a session that wrote the file anyway (the hook ran late) no longer waits for it', () => {
    const t = setup();
    const alpha = t.add('alpha');
    const beta = t.add('beta');
    t.write(alpha, `${REPO}/a.ts`);
    t.edit(beta, `${REPO}/a.ts`);
    t.write(beta, `${REPO}/a.ts`);
    expect(beta.heldBack).toBeUndefined();
    expect(alpha.holding).toBeUndefined();
  });

  it('turned off in the configuration, it says nothing', () => {
    const t = setup({ files: false });
    const alpha = t.add('alpha');
    const beta = t.add('beta');
    t.write(alpha, `${REPO}/a.ts`);
    expect(t.edit(beta, `${REPO}/a.ts`)).toBeUndefined();
  });
});

describe('reading a shell line', () => {
  it('splits it into simple commands, with quotes taken away', () => {
    expect(shellCommands(`cd "my dir" && git commit -m 'a; b' | cat; echo x\\ y`)).toEqual([['cd', 'my dir'], ['git', 'commit', '-m', 'a; b'], ['cat'], ['echo', 'x y']]);
    expect(shellCommands(`echo "open`)).toBeUndefined();
  });

  it('finds every git command, with the folder it runs in', () => {
    expect(gitCommands('git checkout main', REPO)).toEqual([{ sub: 'checkout', args: ['main'], dir: REPO, text: 'git checkout main' }]);
    expect(gitCommands('cd sub && GIT_TRACE=1 git -C ../other --no-pager stash', REPO)).toEqual([{ sub: 'stash', args: [], dir: '/p/shop/other', text: 'git stash' }]);
    expect(gitCommands('git --work-tree=/q status && /usr/bin/git pull', REPO).map((command) => [command.sub, command.dir])).toEqual([
      ['status', '/q'],
      ['pull', REPO],
    ]);
    expect(gitCommands('npm test && echo git checkout', REPO)).toEqual([]);
  });

  it('knows which git commands change the files of the folder', () => {
    const changes = (line: string): boolean => gitCommands(line, REPO).some(changesWorkingTree);
    for (const line of ['git checkout main', 'git checkout -- src/a.ts', 'git switch dev', 'git reset --hard', 'git stash', 'git stash pop', 'git clean -fd', 'git restore a.ts', 'git pull', 'git rebase main', 'git merge dev', 'git cherry-pick abc'])
      expect([line, changes(line)]).toEqual([line, true]);
    for (const line of ['git status', 'git log', 'git diff', 'git commit -m x', 'git checkout -b new', 'git switch -c new', 'git reset', 'git reset --soft HEAD~1', 'git stash list', 'git clean -n', 'git restore --staged a.ts', 'git push', 'git fetch'])
      expect([line, changes(line)]).toEqual([line, false]);
  });
});

describe('git', () => {
  it('asks before a git command that changes the files under another session', () => {
    const t = setup();
    const alpha = t.add('alpha');
    const beta = t.add('beta', REPO, 'idle');
    alpha.team = { label: 'billing-api' };
    t.write(alpha, `${REPO}/src/api.ts`);
    t.advance(4 * 60_000);
    const decision = t.bash(beta, 'git stash && git checkout main');
    expect(decision?.decision).toBe('ask');
    expect(decision?.reason).toBe('Forchetta: "billing-api", another Claude Code session, works in this same folder (it changed src/api.ts 4 min ago). "git stash" changes the files under it.');
  });

  it('asks too when the other one works there now and wrote nothing yet', () => {
    const t = setup();
    t.add('alpha');
    const beta = t.add('beta');
    expect(t.bash(beta, 'git reset --hard')?.reason).toContain('(it is working there now)');
  });

  it('says nothing for a git that changes no file, another folder, a session idle there for an hour, or when turned off', () => {
    const t = setup();
    const alpha = t.add('alpha');
    const beta = t.add('beta', OTHER_REPO);
    t.write(alpha, `${REPO}/a.ts`);
    expect(t.bash(beta, 'git checkout main')).toBeUndefined();
    expect(t.bash(beta, `git -C ${REPO} log`)).toBeUndefined();
    expect(t.bash(beta, `git -C ${REPO} checkout main`)?.decision).toBe('ask');
    alpha.state = 'idle';
    t.advance(60 * 60_000);
    expect(t.bash(beta, `git -C ${REPO} checkout main`)).toBeUndefined();

    const off = setup({ git: false });
    off.add('alpha');
    expect(off.bash(off.add('beta'), 'git reset --hard')).toBeUndefined();
  });
});
