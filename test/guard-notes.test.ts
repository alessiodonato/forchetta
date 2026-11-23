import { describe, expect, it } from 'vitest';
import { Coherence } from '../src/daemon/coherence.ts';
import { type DirtyFile, Guard, hookOutput, parseStatus, sweepOf } from '../src/daemon/guard.ts';
import { type Agent, newAgent } from '../src/daemon/state.ts';
import { MACHINE } from '../src/shared/machine.ts';

// The guard tells Claude what it should know: before tests, which files other sessions are halfway through; and it
// stops once what would undo the work of another session: lines it added, its changes in a git add -A.

const REPO = '/p/shop';
const MIN = 60_000;

function setup(options: { notes?: boolean; dirty?: DirtyFile[]; text?: string } = {}) {
  let now = 1_000_000;
  const agents: Agent[] = [];
  const writes = new Map<string, Array<{ path: string; at: number; repo?: string }>>();
  const coherence = new Coherence({ now: () => now });
  const guard = new Guard({
    agents: () => agents,
    repoOf: (dir) => (dir === REPO || dir.startsWith(`${REPO}/`) ? REPO : undefined),
    writesOf: (id) => writes.get(id) ?? [],
    enabled: () => ({ files: true, git: true, notes: options.notes ?? true }),
    touch: () => {},
    addedByOthers: (id, file, removed) => coherence.addedByOthers(id, file, removed),
    changedByOthers: (id, file) => coherence.changedByOthers(id, file),
    readText: () => options.text,
    dirty: async () => options.dirty,
    now: () => now,
  });
  const add = (id: string, state: Agent['state'] = 'working'): Agent => {
    const agent = newAgent({ id, cwd: REPO, control: { kind: 'tmux', session: `fk-${id}` }, state }, now);
    agent.name = id;
    agents.push(agent);
    return agent;
  };
  /** A write that went through, with the lines it added. */
  const write = (agent: Agent, path: string, added: string[] = []): void => {
    guard.wrote(agent, path);
    coherence.wrote(agent.id, path, { at: now, tool: 'Edit', file: path, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: added.length, lines: added.map((line) => `+${line}`) }] });
    writes.set(agent.id, [...(writes.get(agent.id) ?? []), { path, at: now, repo: REPO }]);
  };
  const pre = (agent: Agent, tool: string, input: Record<string, unknown>) => ({ hook_event_name: 'PreToolUse', session_id: agent.id, tool_name: tool, tool_input: input });
  const bash = (agent: Agent, command: string) => guard.decide(agent, pre(agent, 'Bash', { command }));
  const commit = (agent: Agent, command: string) => guard.decideCommit(agent, pre(agent, 'Bash', { command }));
  const edit = (agent: Agent, file: string, oldString: string, newString: string) => guard.decide(agent, pre(agent, 'Edit', { file_path: file, old_string: oldString, new_string: newString }));
  return { guard, add, write, bash, commit, edit, advance: (ms: number) => (now += ms) };
}

describe('the answer of the guard', () => {
  it('can be a note that stops nothing', () => {
    expect(hookOutput({ context: 'hello' })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'hello' } });
  });
});

describe('before tests', () => {
  it('tells Claude which files other sessions are halfway through, once for the same files', () => {
    const t = setup();
    const alpha = t.add('retries');
    const beta = t.add('rate-limit');
    t.write(alpha, `${REPO}/src/api.ts`);
    t.write(alpha, `${REPO}/src/retry.ts`);
    const answer = t.bash(beta, 'pnpm test');
    expect(answer?.decision).toBeUndefined();
    expect(answer?.context).toContain('"retries" is in the middle of changing src/api.ts and src/retry.ts');
    expect(answer?.context).toContain("it is probably their unfinished work, not yours: don't fix it");
    expect(t.bash(beta, 'pnpm test')).toBeUndefined();
    // A file more: said again.
    t.write(alpha, `${REPO}/src/client.ts`);
    expect(t.bash(beta, 'cd src && npx vitest run')?.context).toContain('src/api.ts, src/client.ts and src/retry.ts');
  });

  it('says nothing when the others are between turns, for other commands, or when turned off', () => {
    const t = setup();
    const alpha = t.add('retries');
    const beta = t.add('rate-limit');
    t.write(alpha, `${REPO}/src/api.ts`);
    expect(t.bash(beta, 'ls src')).toBeUndefined();
    alpha.state = 'idle';
    expect(t.bash(beta, 'pnpm test')).toBeUndefined();
    const off = setup({ notes: false });
    const gamma = off.add('retries');
    off.write(gamma, `${REPO}/src/api.ts`);
    expect(off.bash(off.add('rate-limit'), 'pnpm test')).toBeUndefined();
  });
});

describe('lines of another session', () => {
  const added = ['  const delay = 2 ** attempt * 100;', '  await sleep(delay);'];

  it('stops once an edit that takes them away, with the lines; the same edit again goes through', () => {
    const t = setup();
    const alpha = t.add('retries');
    const beta = t.add('rate-limit');
    t.write(alpha, `${REPO}/src/api.ts`, added);
    alpha.state = 'idle';
    t.advance(6 * MIN);
    const old = ['for (let attempt = 0; attempt < 3; attempt++) {', ...added, '}'].join('\n');
    const answer = t.edit(beta, `${REPO}/src/api.ts`, old, 'await limiter.take();');
    expect(answer?.decision).toBe('deny');
    expect(answer?.reason).toContain(`takes away lines that "retries", another Claude Code session on this ${MACHINE}, added to src/api.ts 6 min ago:`);
    expect(answer?.reason).toContain('    + await sleep(delay);');
    expect(answer?.reason).toContain('make the same change again: it will go through');
    expect(t.edit(beta, `${REPO}/src/api.ts`, old, 'await limiter.take();')).toBeUndefined();
  });

  it('lets through an edit that only changes them, and a Write that keeps them', () => {
    const t = setup({ text: ['x', ...added].join('\n') });
    const alpha = t.add('retries', 'idle');
    const beta = t.add('rate-limit');
    t.write(alpha, `${REPO}/src/api.ts`, added);
    t.advance(HOLD_GONE);
    expect(t.edit(beta, `${REPO}/src/api.ts`, added.join('\n'), ['  const delay = 2 ** attempt * 250;', '  await sleep(delay, signal);'].join('\n'))).toBeUndefined();
    expect(t.guard.decide(beta, { hook_event_name: 'PreToolUse', session_id: 'b', tool_name: 'Write', tool_input: { file_path: `${REPO}/src/api.ts`, content: ['y', ...added].join('\n') } })).toBeUndefined();
    expect(t.guard.decide(beta, { hook_event_name: 'PreToolUse', session_id: 'b', tool_name: 'Write', tool_input: { file_path: `${REPO}/src/api.ts`, content: 'y' } })?.decision).toBe('deny');
  });
});

/** Past the two minutes a file stays held after the turn of the session that wrote it. */
const HOLD_GONE = 3 * MIN;

describe('commits', () => {
  const dirty: DirtyFile[] = [
    { path: `${REPO}/src/api.ts`, untracked: false },
    { path: `${REPO}/src/retry.ts`, untracked: true },
    { path: `${REPO}/src/billing.ts`, untracked: false },
    { path: `${REPO}/src/shared.ts`, untracked: false },
  ];

  it('stops once a git add -A that would take the changes of another session, with the files to add instead', async () => {
    const t = setup({ dirty });
    const alpha = t.add('retries');
    const beta = t.add('rate-limit');
    t.write(alpha, `${REPO}/src/api.ts`);
    t.write(alpha, `${REPO}/src/retry.ts`);
    t.write(alpha, `${REPO}/src/shared.ts`);
    t.write(beta, `${REPO}/src/billing.ts`);
    t.write(beta, `${REPO}/src/shared.ts`);
    const answer = await t.commit(beta, 'git add -A && git commit -m "Rate limit"');
    expect(answer?.decision).toBe('deny');
    expect(answer?.reason).toContain('"git add -A" would also take changes of other Claude Code sessions working in this folder ("retries", in the middle of its turn): src/api.ts, src/retry.ts.');
    expect(answer?.reason).toContain('src/shared.ts has changes of yours and of the other session: add only your part (git add -p)');
    expect(answer?.reason).toContain('Add only your own files: git add src/billing.ts');
    expect(await t.commit(beta, 'git add -A && git commit -m "Rate limit"')).toBeUndefined();
  });

  it('counts only tracked files for commit -a, and says nothing for files named one by one', async () => {
    const t = setup({ dirty: dirty.filter((file) => file.path.endsWith('retry.ts') || file.path.endsWith('billing.ts')) });
    const alpha = t.add('retries');
    const beta = t.add('rate-limit');
    t.write(alpha, `${REPO}/src/retry.ts`);
    t.write(beta, `${REPO}/src/billing.ts`);
    expect(await t.commit(beta, 'git commit -am "Rate limit"')).toBeUndefined();
    expect(await t.commit(beta, 'git add src/billing.ts')).toBeUndefined();
    expect((await t.commit(beta, 'git add .'))?.decision).toBe('deny');
  });

  it('says nothing when no other session changed files there, or it ended', async () => {
    const t = setup({ dirty });
    const alpha = t.add('retries');
    const beta = t.add('rate-limit');
    expect(await t.commit(beta, 'git add -A')).toBeUndefined();
    t.write(alpha, `${REPO}/src/api.ts`);
    alpha.state = 'ended';
    expect(await t.commit(beta, 'git add -A')).toBeUndefined();
  });

  it('reads what a git command would sweep in', () => {
    const at = (text: string) => {
      const [, sub, ...args] = text.split(' ');
      return sweepOf({ sub: sub!, args, dir: `${REPO}/src`, text });
    };
    expect(at('git add -A')).toEqual({ under: ['/'], tracked: false });
    expect(at('git add -u')).toEqual({ under: ['/'], tracked: true });
    expect(at('git add .')).toEqual({ under: [`${REPO}/src`], tracked: false });
    expect(at('git add lib/')).toEqual({ under: [`${REPO}/src/lib`], tracked: false });
    expect(at('git add api.ts')).toBeUndefined();
    expect(at('git commit -am msg')).toEqual({ under: ['/'], tracked: true });
    expect(at('git commit -m msg')).toBeUndefined();
    expect(at('git commit --amend')).toBeUndefined();
  });

  it('reads git status, renames included', () => {
    const text = [' M src/api.ts', '?? src/new.ts', 'R  src/to.ts', 'src/from.ts', ''].join('\0');
    expect(parseStatus(text, REPO)).toEqual([
      { path: `${REPO}/src/api.ts`, untracked: false },
      { path: `${REPO}/src/new.ts`, untracked: true },
      { path: `${REPO}/src/to.ts`, untracked: false },
    ]);
  });
});
