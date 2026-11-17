import { describe, expect, it } from 'vitest';
import { ownerOf, parseCwds, parseListening, parsePs, Servers } from '../src/daemon/servers.ts';
import { type Agent, newAgent } from '../src/daemon/state.ts';

// One dev server for a folder: a session about to start a second one is told the address of the first; a kill of a
// process another session started asks you first.

const REPO = '/p/shop';

/** What lsof, ps and pgrep say on this pretend Mac: vite (4242) started by the session of pid 100, node of pid 7000 elsewhere. */
const PS = ['    1     0 /sbin/launchd', '  100     1 /Users/me/.local/bin/claude', '  200     1 /Users/me/.local/bin/claude', ' 4000   100 /bin/zsh', ' 4242  4000 node', ' 7000     1 /usr/local/bin/node'].join('\n');
const LISTEN = ['p4242', 'f23', 'n*:5173', 'f24', 'n[::1]:5173', 'p7000', 'f20', 'n127.0.0.1:8080'].join('\n');
const CWDS = ['p4242', 'fcwd', `n${REPO}/apps/web`, 'p7000', 'fcwd', 'n/Users/me/other'].join('\n');

function setup() {
  let now = 1_000_000;
  const agents: Agent[] = [];
  const calls: string[] = [];
  const servers = new Servers({
    agents: () => agents,
    repoOf: (dir) => (dir === REPO || dir.startsWith(`${REPO}/`) ? REPO : undefined),
    enabled: () => true,
    run: async (file, args) => {
      calls.push([file.split('/').at(-1), ...args].join(' '));
      if (file.endsWith('ps')) return PS;
      if (file.endsWith('pgrep')) return args.includes('vite') ? '4242\n' : undefined;
      if (args.includes('cwd')) return CWDS;
      return LISTEN;
    },
    now: () => now,
  });
  const add = (id: string, pid: number, cwd = REPO): Agent => {
    const agent = newAgent({ id, cwd, control: { kind: 'tmux', session: `fk-${id}` }, state: 'working' }, now);
    agent.name = id;
    agent.pid = pid;
    agents.push(agent);
    return agent;
  };
  const bash = (agent: Agent, command: string) => servers.decide(agent, { hook_event_name: 'PreToolUse', session_id: agent.id, tool_name: 'Bash', tool_input: { command } });
  return { add, bash, calls, advance: (ms: number) => (now += ms) };
}

describe('reading the processes', () => {
  it('reads ps, the listening ports and the folders', () => {
    expect(parsePs(PS).get(4242)).toEqual({ ppid: 4000, name: 'node' });
    expect(parseListening(LISTEN)).toEqual(new Map([[4242, [5173]], [7000, [8080]]]));
    expect(parseCwds(CWDS).get(4242)).toBe(`${REPO}/apps/web`);
  });

  it('finds the session that started a process among its parents', () => {
    const alpha = newAgent({ id: 'a', cwd: REPO, control: { kind: 'tmux', session: 'fk-a' }, state: 'working' }, 0);
    alpha.pid = 100;
    expect(ownerOf(4242, parsePs(PS), [alpha])).toBe(alpha);
    expect(ownerOf(7000, parsePs(PS), [alpha])).toBeUndefined();
    alpha.state = 'ended';
    expect(ownerOf(4242, parsePs(PS), [alpha])).toBeUndefined();
  });
});

describe('the daemon itself', () => {
  it('is no dev server of the folder, also when it runs from a clone of Forchetta in that folder', async () => {
    const servers = new Servers({
      agents: () => [],
      repoOf: (dir) => (dir.startsWith(REPO) ? REPO : undefined),
      enabled: () => true,
      self: 9999,
      run: async (file, args) => (file.endsWith('ps') ? ' 9999     1 forchetta-daemon' : args.includes('cwd') ? ['p9999', 'fcwd', `n${REPO}`].join('\n') : ['p9999', 'f20', 'n127.0.0.1:47821'].join('\n')),
    });
    const agent = newAgent({ id: 'a', cwd: REPO, control: { kind: 'tmux', session: 'fk-a' }, state: 'working' }, 0);
    expect(await servers.decide(agent, { hook_event_name: 'PreToolUse', session_id: 'a', tool_name: 'Bash', tool_input: { command: 'pnpm dev' } })).toBeUndefined();
  });
});

describe('a second dev server', () => {
  it('is stopped once, with the address of the one running and who started it', async () => {
    const t = setup();
    t.add('retries', 100);
    const beta = t.add('rate-limit', 200);
    const answer = await t.bash(beta, 'cd apps/web && pnpm dev');
    expect(answer?.decision).toBe('deny');
    expect(answer?.reason).toContain('a dev server of this folder is already running: http://localhost:5173 (node 4242, started by "retries", another Claude Code session)');
    expect(answer?.reason).toContain('use it rather than starting another one');
    expect(await t.bash(beta, 'cd apps/web && pnpm dev')).toBeUndefined();
  });

  it('is let go for another app of the repository, a folder with no server, or a command that starts none', async () => {
    const t = setup();
    t.add('retries', 100);
    const beta = t.add('rate-limit', 200);
    expect(await t.bash(beta, 'cd apps/api && pnpm dev')).toBeUndefined();
    const gamma = t.add('docs', 300, '/p/docs');
    expect(await t.bash(gamma, 'npm run dev')).toBeUndefined();
    const before = t.calls.length;
    expect(await t.bash(beta, 'pnpm build')).toBeUndefined();
    expect(t.calls.length).toBe(before);
  });

  it('counts a server started by the same session, or outside Claude Code', async () => {
    const t = setup();
    const alpha = t.add('retries', 100);
    expect((await t.bash(alpha, 'cd apps/web && npx vite'))?.reason).toContain('started by you earlier');
  });
});

describe('a kill', () => {
  it('asks you before stopping a process another session started, or the session itself', async () => {
    const t = setup();
    t.add('retries', 100);
    const beta = t.add('rate-limit', 200);
    const byPort = await t.bash(beta, 'lsof -ti:5173 | xargs kill -9');
    expect(byPort?.decision).toBe('ask');
    expect(byPort?.reason).toBe('Forchetta: this would stop node (pid 4242), started by "retries", another Claude Code session.');
    expect((await t.bash(beta, 'pkill -f vite'))?.decision).toBe('ask');
    expect((await t.bash(beta, 'kill 100'))?.reason).toContain('the Claude Code session "retries" itself (pid 100)');
  });

  it('lets go a kill of its own processes, or of processes no session started', async () => {
    const t = setup();
    const alpha = t.add('retries', 100);
    t.add('rate-limit', 200);
    expect(await t.bash(alpha, 'kill 4242')).toBeUndefined();
    expect(await t.bash(alpha, 'kill 7000')).toBeUndefined();
  });
});
