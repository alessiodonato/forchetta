import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseArricurdaiStatus, parseArricurdaiToday } from '../src/daemon/arricurdai.ts';
import { Registry } from '../src/daemon/registry.ts';
import { statusContext, statusUsage } from '../src/daemon/server.ts';
import { ROOT } from '../src/shared/paths.ts';
import { percentText, usdText } from '../src/shared/present.ts';
import { isOurStatusLine, withForchettaStatusLine, withoutForchettaStatusLine } from '../src/shared/settings.ts';
import { tempDir } from './helpers.ts';

// Cost: per session from the status line of Claude Code; cost and tokens of the day from arricurdAI.

/** The input of the status line, as Claude Code 2.1.322 gives it (trimmed). */
const STATUS_INPUT = {
  session_id: '104f8710-a72c-4554-8825-485d1e746f45',
  model: { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' },
  cost: { total_cost_usd: 0.0049203300000000005, total_duration_ms: 9083, total_api_duration_ms: 2706, total_lines_added: 0, total_lines_removed: 0 },
  context_window: { total_input_tokens: 51071, total_output_tokens: 7, context_window_size: 1000000 },
};

/** The same session of 2.1.323 at its start, and after its first answer (trimmed): the context comes with it. */
const START_INPUT = {
  session_id: 'b7c1e0d2-5a4f-4c8e-9f31-2d6a8e0c4b19',
  version: '2.1.323',
  model: { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' },
  cost: { total_cost_usd: 0, total_duration_ms: 3072, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
  context_window: { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 1000000, current_usage: null, used_percentage: null, remaining_percentage: null },
};
const ANSWERED_INPUT = {
  ...START_INPUT,
  cost: { total_cost_usd: 0.00267648, total_duration_ms: 16010, total_api_duration_ms: 12874, total_lines_added: 0, total_lines_removed: 0 },
  context_window: {
    total_input_tokens: 40449,
    total_output_tokens: 4,
    context_window_size: 1000000,
    current_usage: { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 11299, cache_read_input_tokens: 29148 },
    used_percentage: 4,
    remaining_percentage: 96,
  },
};

const input = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

describe('status line input', () => {
  it('gives session and cost; without used_percentage the context is left to arricurdAI', () => {
    expect(statusUsage(input(STATUS_INPUT))).toEqual({ sessionId: STATUS_INPUT.session_id, usd: 0.0049203300000000005 });
  });

  it('gives the context of Claude Code after the first answer, and none before it', () => {
    expect(statusUsage(input(ANSWERED_INPUT))).toEqual({ sessionId: START_INPUT.session_id, usd: 0.00267648, context: { tokens: 40449, window: 1_000_000, percent: 4 } });
    expect(statusUsage(input(START_INPUT))).toEqual({ sessionId: START_INPUT.session_id, usd: 0, context: null });
  });

  it('counts the context from the parts of the last call when the total is missing', () => {
    const { total_input_tokens: _total, ...rest } = ANSWERED_INPUT.context_window;
    expect(statusContext(rest)).toEqual({ tokens: 40449, window: 1_000_000, percent: 4 });
    expect(statusContext({ ...rest, used_percentage: 120 })).toMatchObject({ percent: 100 });
    expect(statusContext({ ...rest, context_window_size: 0 })).toBeUndefined();
    expect(statusContext('many')).toBeUndefined();
  });

  it('gives nothing without a session, or with neither a cost nor a context', () => {
    expect(statusUsage(Buffer.from('{nope'))).toBeUndefined();
    expect(statusUsage(input({ ...STATUS_INPUT, session_id: undefined }))).toBeUndefined();
    expect(statusUsage(input({ ...STATUS_INPUT, cost: {} }))).toBeUndefined();
    expect(statusUsage(input({ ...ANSWERED_INPUT, cost: {} }))).toEqual({ sessionId: START_INPUT.session_id, context: { tokens: 40449, window: 1_000_000, percent: 4 } });
  });

  it('updates the agent of the session, only when the numbers change, and never makes one up', () => {
    const changes: string[] = [];
    const registry = new Registry({ settleMs: 5, onChange: (agent) => changes.push(agent.id) });
    expect(registry.status('unknown', {}, { usd: 1 })).toBeUndefined();
    expect(registry.agents.size).toBe(0);
    const agent = registry.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: '/x/beta', prompt: 'ciao' });
    changes.length = 0;
    registry.status('s-1', {}, { usd: 0.42 });
    registry.status('s-1', {}, { usd: 0.42 });
    expect(agent.usage).toMatchObject({ usd: 0.42 });
    expect(changes).toEqual([agent.id]);
    registry.dispose();
  });
});

describe('context from the status line', () => {
  /** What `arricurdai status --json` says of the session s-1: 150k tokens, which a 1M window makes 15%. */
  const ARRICURDAI = parseArricurdaiStatus(
    JSON.stringify({
      sessions: [{ sessionId: 's-1', context: 150_000, lastCallAt: '2026-11-13T10:00:00.000Z', cacheExpiresAt: '2026-11-13T11:00:00.000Z', cacheLive: true, guardWillStop: false }],
    }),
  );
  const exact = { tokens: 40449, window: 200_000, percent: 20 };

  function session(): { registry: Registry; agent: ReturnType<Registry['hook']> } {
    const registry = new Registry({ settleMs: 5 });
    const agent = registry.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: '/x/beta', prompt: 'ciao' });
    return { registry, agent };
  }

  it('is Claude Code own number, with no ≈', () => {
    const { registry, agent } = session();
    registry.status('s-1', {}, { usd: 0.1, context: exact });
    expect(agent.context).toMatchObject({ ...exact, source: 'statusline' });
    expect(percentText(agent.context!)).toBe('20%');
    registry.dispose();
  });

  it('is not replaced by the estimate of arricurdAI, which still gives the cache', () => {
    const { registry, agent } = session();
    registry.status('s-1', {}, { context: exact });
    registry.applyArricurdai(ARRICURDAI, () => 1_000_000);
    expect(agent.context).toMatchObject({ ...exact, source: 'statusline' });
    expect(agent.cache).toMatchObject({ live: true });
    // The same numbers again: nothing changes.
    expect(registry.applyArricurdai(ARRICURDAI, () => 1_000_000)).toEqual([]);
    registry.dispose();
  });

  it('takes the place of the estimate of arricurdAI', () => {
    const { registry, agent } = session();
    registry.applyArricurdai(ARRICURDAI, () => 1_000_000);
    expect(percentText(agent.context!)).toBe('≈15%');
    registry.status('s-1', {}, { context: exact });
    expect(agent.context).toMatchObject({ ...exact, source: 'statusline' });
    registry.dispose();
  });

  it('empties when Claude Code has none yet (after /compact), and arricurdAI may fill it again', () => {
    const { registry, agent } = session();
    registry.status('s-1', {}, { context: exact });
    registry.status('s-1', {}, { context: null });
    expect(agent.context).toBeUndefined();
    registry.applyArricurdai(ARRICURDAI, () => 1_000_000);
    expect(agent.context).toMatchObject({ tokens: 150_000, percent: 15 });
    expect(agent.context?.source).toBeUndefined();
    // A null leaves the estimate of arricurdAI alone: it is all there is.
    registry.status('s-1', {}, { context: null });
    expect(agent.context).toMatchObject({ tokens: 150_000 });
    registry.dispose();
  });

  it('ignores a late status line of the conversation before a /clear', () => {
    const { registry, agent } = session();
    // The /clear of the same process: the hook says which agent it is, as for a session in the tmux of Forchetta.
    registry.hook({ hook_event_name: 'SessionStart', session_id: 's-2', cwd: '/x/beta', source: 'clear' }, { agentId: agent.id });
    expect(agent.sessionId).toBe('s-2');
    registry.status('s-1', { agentId: agent.id }, { usd: 3, context: exact });
    expect(agent.context).toBeUndefined();
    expect(agent.usage).toBeUndefined();
    registry.status('s-2', { agentId: agent.id }, { usd: 0.01, context: exact });
    expect(agent.context).toMatchObject({ source: 'statusline' });
    registry.dispose();
  });
});

describe('today from arricurdAI', () => {
  it('adds up the tokens of every kind', () => {
    const stdout = JSON.stringify({
      sessions: [],
      today: { since: '2026-11-10T23:00:00.000Z', calls: 120, tokens: { input: 10, cacheWrite: 200, cacheRead: 3000, output: 40 }, usd: 12.4, unpricedCalls: 2, guardStops: 0 },
    });
    expect(parseArricurdaiToday(stdout)).toEqual({ since: Date.parse('2026-11-10T23:00:00.000Z'), calls: 120, tokens: 3250, usd: 12.4, unpricedCalls: 2 });
  });

  it('is missing when an older arricurdAI has no "today"', () => {
    expect(parseArricurdaiToday(JSON.stringify({ sessions: [] }))).toBeUndefined();
  });

  it('writes dollars as arricurdai status does', () => {
    expect(usdText(0.4249)).toBe('$0.42');
    expect(usdText(12.4)).toBe('$12.40');
    expect(usdText(1234.5)).toBe('$1,235');
    expect(usdText(0.004)).toBe('<$0.01');
    expect(usdText(0)).toBe('$0.00');
  });
});

describe('status line in the settings', () => {
  const targets = { port: 47821, statusScript: '/F/bin/forchetta-statusline' };
  const yours = { type: 'command', command: `input=$(cat); echo "$(whoami)"`, padding: 0 };

  it('goes in front of yours, keeps the other keys, and gives back your command to save', () => {
    const plan = withForchettaStatusLine({ theme: 'dark', statusLine: yours }, targets);
    expect(plan.settings).toEqual({ theme: 'dark', statusLine: { type: 'command', command: '/F/bin/forchetta-statusline 47821', padding: 0 } });
    expect(plan.original).toBe(yours.command);
    expect(plan.changes).toHaveLength(1);
    expect(isOurStatusLine(plan.settings.statusLine)).toBe(true);
  });

  it('changes nothing the second time, and saves nothing again', () => {
    const once = withForchettaStatusLine({ statusLine: yours }, targets).settings;
    const twice = withForchettaStatusLine(once, targets);
    expect(twice.changes).toEqual([]);
    expect(twice.original).toBeUndefined();
  });

  it('adds one when there was none', () => {
    const plan = withForchettaStatusLine({}, targets);
    expect(plan.settings.statusLine).toEqual({ type: 'command', command: '/F/bin/forchetta-statusline 47821' });
    expect(plan.original).toBeUndefined();
  });

  it('uninstall gives back yours, byte for byte, or none', () => {
    const before = { theme: 'dark', statusLine: yours };
    const installed = withForchettaStatusLine(before, targets).settings;
    expect(withoutForchettaStatusLine(installed, yours.command).settings).toEqual(before);
    expect(withoutForchettaStatusLine(withForchettaStatusLine({}, targets).settings, undefined).settings).toEqual({});
    // A status line that is not ours is left alone.
    expect(withoutForchettaStatusLine(before, undefined).changes).toEqual([]);
  });
});

describe('bin/forchetta-statusline', () => {
  const temp = tempDir('statusline');
  afterAll(() => temp.cleanup());

  /** A copy of the script in a checkout of its own (.git), with its own var/statusline-command. */
  function install(command: string | undefined): string {
    const root = join(temp.dir, `root-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'var'), { recursive: true });
    const script = join(root, 'bin', 'forchetta-statusline');
    writeFileSync(script, readFileSync(join(ROOT, 'bin', 'forchetta-statusline')), { mode: 0o755 });
    if (command !== undefined) writeFileSync(join(root, 'var', 'statusline-command'), command);
    return script;
  }

  const run = (script: string, port: number, input: string) =>
    new Promise<{ code: number; stdout: string }>((resolve) => {
      const child = execFile(script, [String(port)], { env: { PATH: '/usr/bin:/bin' }, timeout: 10_000 }, (error, stdout) =>
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout) }),
      );
      child.stdin?.end(input);
    });

  it('prints your status line, made from the same input, and sends the input to the daemon', async () => {
    let received = '';
    const server = createServer((req, res) => {
      req.on('data', (chunk: Buffer) => (received += chunk.toString()));
      req.on('end', () => res.end());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const script = install(`input=$(cat); printf 'riga di %s' "$(printf '%s' "$input" | /usr/bin/sed -n 's/.*"display_name":"\\([^"]*\\)".*/\\1/p')"`);
    const result = await run(script, port, JSON.stringify(STATUS_INPUT));
    for (let round = 0; round < 40 && !received; round++) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => server.close(resolve));
    expect(result).toEqual({ code: 0, stdout: 'riga di Haiku 5.5' });
    expect(JSON.parse(received).cost.total_cost_usd).toBe(STATUS_INPUT.cost.total_cost_usd);
  });

  it('prints the same with the daemon off, at once', async () => {
    const script = install(`echo ciao`);
    expect(await run(script, 1, '{}')).toEqual({ code: 0, stdout: 'ciao\n' });
  });

  it('never waits for a daemon that does not answer', async () => {
    const script = install(`echo ciao`);
    // curl gives up after 1 s (--max-time 1). Here it waits 10 s, so that a busy Mac cannot make the script look
    // like it waited: what is checked is that curl runs in the background, not how fast the Mac is.
    const text = readFileSync(script, 'utf8');
    expect(text).toContain('--max-time 1 ');
    writeFileSync(script, text.replace('--max-time 1 ', '--max-time 10 '));
    // macOS checks a new script the first time it runs, which on a busy Mac takes a second or more: a first run,
    // against no daemon, gets that out of the way.
    await run(script, 1, '{}');
    // A daemon that takes the request and never answers: curl hangs up only when it gives up.
    let hungUp = false;
    const server = createServer(() => {});
    server.on('connection', (socket) => socket.on('close', () => (hungUp = true)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    expect(await run(script, port, '{}')).toEqual({ code: 0, stdout: 'ciao\n' });
    // curl runs in the background: the line is out while curl still waits. Had the script waited for it, curl
    // would have hung up already.
    expect(hungUp).toBe(false);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('prints nothing when there was no status line before', async () => {
    expect(await run(install(undefined), 1, '{}')).toEqual({ code: 0, stdout: '' });
  });
});
