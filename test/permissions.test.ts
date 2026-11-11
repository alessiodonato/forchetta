import type { AddressInfo } from 'node:net';
import { type ClientRequest, request, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DENY_MESSAGE, decisionOutput, Permissions } from '../src/daemon/permissions.ts';
import { isInteractiveCommand } from '../src/daemon/process.ts';
import { Registry } from '../src/daemon/registry.ts';
import { createDaemonServer, HOOK_PATH, PERMISSION_PATH } from '../src/daemon/server.ts';
import { http, sleep } from './helpers.ts';

// The permission dialog answered from the box, through the real HTTP routes: bin/forchetta-permission posts the
// request, gets a ticket and waits on it; the box answers; or the terminal does first.

const json = { 'content-type': 'application/json' };
const SESSION = 's-perm';

let server: Server;
let port = 0;
let registry: Registry;
let permissions: Permissions;
let interactive = true;
let status: string | undefined = 'waiting';
let statusCalls = 0;

beforeEach(async () => {
  interactive = true;
  status = 'waiting';
  statusCalls = 0;
  registry = new Registry({ settleMs: 5, onChange: (agent) => permissions?.agentChanged(agent) });
  permissions = new Permissions({
    registry,
    interactive: async () => interactive,
    status: async () => {
      statusCalls++;
      return status;
    },
    log: () => {},
    attachMs: 300,
    marginMs: 0,
    minWaitS: 0,
  });
  server = createDaemonServer({
    registry,
    token: 'a'.repeat(64),
    permissions,
    port: () => port,
    log: () => {},
    info: () => ({}),
    onShutdown: () => {},
    onHook: (agent, payload) => permissions.hook(agent, payload),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  // A session that is working: its pid comes with the hook, as from bin/forchetta-hook.
  await hook({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, cwd: '/tmp/progetto', prompt: 'crea il file' });
});

afterEach(async () => {
  permissions.stop();
  registry.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const agent = () => registry.list().find((candidate) => candidate.sessionId === SESSION)!;

function hook(body: Record<string, unknown>) {
  return http(port, { method: 'POST', path: HOOK_PATH, headers: { ...json, 'x-forchetta-claude-pid': '4321' }, body: JSON.stringify(body) });
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PermissionRequest',
  session_id: SESSION,
  cwd: '/tmp/progetto',
  tool_name: 'Bash',
  tool_input: { command, description: 'prova' },
  ...extra,
});

function ask(body: Record<string, unknown>, wait = '60') {
  return http(port, { method: 'POST', path: PERMISSION_PATH, headers: { ...json, 'x-forchetta-claude-pid': '4321', 'x-forchetta-wait': wait }, body: JSON.stringify(body) });
}

/** The hook waiting on its ticket: the answer, or the moment its connection is cut. */
function wait(ticket: string): { reply: Promise<{ status: number; body: string }>; cut: () => void } {
  let req: ClientRequest | undefined;
  const reply = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req = request({ host: '127.0.0.1', port, path: `${PERMISSION_PATH}/${ticket}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
  reply.catch(() => {});
  return { reply, cut: () => req?.destroy() };
}

describe('a request the box can answer', () => {
  it('gets a ticket, and the box shows the whole command', async () => {
    const reply = await ask(bash('touch a.txt &&\nls -l a.txt'));
    expect(reply.status).toBe(200);
    expect(reply.body).toMatch(/^[0-9a-f]{32}$/);
    expect(agent().state).toBe('waiting');
    expect(agent().permission).toMatchObject({ ticket: reply.body, tool: 'Bash', detail: 'touch a.txt &&\nls -l a.txt' });
  });

  it('Consenti: the hook prints allow, and the session works again', async () => {
    const ticket = (await ask(bash('touch a.txt'))).body;
    const hookWaits = wait(ticket);
    await sleep(30);
    expect(await permissions.decide(agent().id, ticket, 'allow')).toBe(true);
    const reply = await hookWaits.reply;
    expect(JSON.parse(reply.body)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(agent()).toMatchObject({ state: 'working', permission: undefined });
    expect(agent().permissionOutcome?.text).toBe('Allowed from Forchetta: touch a.txt');
    expect(statusCalls).toBe(1);
  });

  it('Rifiuta: the hook prints deny with a message and stops Claude, as No in the terminal', async () => {
    const ticket = (await ask(bash('rm -rf build'))).body;
    const hookWaits = wait(ticket);
    await sleep(30);
    await permissions.decide(agent().id, ticket, 'deny');
    const decision = JSON.parse((await hookWaits.reply).body).hookSpecificOutput.decision;
    expect(decision).toEqual({ behavior: 'deny', message: DENY_MESSAGE, interrupt: true });
    expect(agent()).toMatchObject({ state: 'idle', permission: undefined, waiting: undefined });
  });

  it('sempre…: the choice goes back to Claude Code as it came, in updatedPermissions', async () => {
    const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' };
    const ticket = (await ask(bash('npm test', { permission_suggestions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }, rule] }))).body;
    // The mode that turns every dialog off is not offered: the only choice left is the rule, at index 0.
    expect(agent().permission?.always).toEqual([{ label: 'Always allow Bash(npm test:*)', where: 'in this project, only for you' }]);
    const hookWaits = wait(ticket);
    await sleep(30);
    expect(await permissions.decide(agent().id, ticket, 'allow', 0)).toBe(true);
    expect(JSON.parse((await hookWaits.reply).body).hookSpecificOutput.decision).toEqual({ behavior: 'allow', updatedPermissions: [rule] });
    expect(agent().permissionOutcome?.text).toBe('Always allow Bash(npm test:*) (in this project, only for you): npm test');
  });

  it('sempre…: a choice that is not there is refused, and the request stays open', async () => {
    const ticket = (await ask(bash('npm test'))).body;
    expect(agent().permission?.always).toBeUndefined();
    expect(await permissions.decide(agent().id, ticket, 'allow', 3)).toBe(false);
    expect(agent().permission?.ticket).toBe(ticket);
  });

  it('an answer given before the hook is back reaches it when it asks', async () => {
    const ticket = (await ask(bash('touch b.txt'))).body;
    await permissions.decide(agent().id, ticket, 'allow');
    expect(agent().permission).toBeUndefined();
    expect(JSON.parse((await wait(ticket).reply).body).hookSpecificOutput.decision.behavior).toBe('allow');
  });
});

describe('the terminal answers first', () => {
  it('Yes in the terminal: the PostToolUse of the same call closes the request, and the hook ends empty', async () => {
    const ticket = (await ask(bash('touch c.txt'))).body;
    const hookWaits = wait(ticket);
    await sleep(30);
    await hook({ hook_event_name: 'PostToolUse', session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'touch c.txt', description: 'prova' } });
    expect(await hookWaits.reply).toEqual({ status: 200, body: '' });
    expect(agent()).toMatchObject({ state: 'working', permission: undefined });
  });

  it('a new request hides the outcome of the previous answer', async () => {
    const first = (await ask(bash('touch n1.txt'))).body;
    await permissions.decide(agent().id, first, 'allow');
    await wait(first).reply;
    expect(agent().permissionOutcome).toBeDefined();
    await ask(bash('touch n2.txt'));
    expect(agent().permissionOutcome).toBeUndefined();
  });

  it('Yes in the terminal: the next request of the same session closes the previous one', async () => {
    const first = (await ask(bash('touch d1.txt'))).body;
    const firstWaits = wait(first);
    await sleep(30);
    const second = (await ask(bash('touch d2.txt'))).body;
    expect((await firstWaits.reply).body).toBe('');
    expect(agent().permission?.ticket).toBe(second);
  });

  it('No or Esc in the terminal: Claude ends the hook, and the session stops waiting', async () => {
    const ticket = (await ask(bash('touch e.txt'))).body;
    const hookWaits = wait(ticket);
    await sleep(30);
    hookWaits.cut();
    await sleep(50);
    expect(agent()).toMatchObject({ state: 'idle', permission: undefined, waiting: undefined });
  });

  it('a click after the terminal answered is not sent: claude agents says the session no longer waits', async () => {
    const ticket = (await ask(bash('touch f.txt'))).body;
    const hookWaits = wait(ticket);
    await sleep(30);
    status = 'busy';
    expect(await permissions.decide(agent().id, ticket, 'deny')).toBe(false);
    expect((await hookWaits.reply).body).toBe('');
    expect(agent().permissionOutcome?.text).toBe('Already answered in the terminal');
    expect(agent().permission).toBeUndefined();
  });

  it('a ticket that is no longer open gets nothing', async () => {
    const ticket = (await ask(bash('touch g.txt'))).body;
    await hook({ hook_event_name: 'Stop', session_id: SESSION });
    expect(await permissions.decide(agent().id, ticket, 'allow')).toBe(false);
    expect(statusCalls).toBe(0);
    expect(await wait(ticket).reply).toEqual({ status: 200, body: '' });
  });
});

describe('requests Forchetta does not hold', () => {
  it('claude -p and the SDK: no ticket, so the hook ends at once and the run goes on', async () => {
    interactive = false;
    expect((await ask(bash('touch h.txt'))).body).toBe('');
    expect(agent().permission).toBeUndefined();
    // The event still counts: the box says that the session waits.
    expect(agent().state).toBe('waiting');
  });

  it('a question or a plan to approve: they are not a yes or no', async () => {
    for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
      expect((await ask({ ...bash('x'), tool_name: tool, tool_input: { questions: [] } })).body).toBe('');
    }
    expect(agent().permission).toBeUndefined();
  });

  it('a hook without its wait, or another event on this route', async () => {
    expect((await ask(bash('touch i.txt'), 'nope')).body).toBe('');
    expect((await ask({ ...bash('x'), hook_event_name: 'PreToolUse' })).body).toBe('');
  });

  it('a hook that never comes back for its ticket: the request is dropped', async () => {
    await ask(bash('touch j.txt'));
    expect(agent().permission).toBeDefined();
    await sleep(900);
    expect(agent().permission).toBeUndefined();
  });

  it('time runs out: the hook ends empty and the dialog stays in the terminal', async () => {
    const ticket = (await ask(bash('touch k.txt'), '0.2')).body;
    const reply = await wait(ticket).reply;
    expect(reply.body).toBe('');
    expect(agent().permissionOutcome?.text).toBe('Timed out: answer in the terminal');
  });
});

describe('the waiting route', () => {
  it('refuses web pages and unknown tickets', async () => {
    const ticket = (await ask(bash('touch l.txt'))).body;
    expect((await http(port, { path: `${PERMISSION_PATH}/${ticket}`, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await http(port, { path: `${PERMISSION_PATH}/zz` })).status).toBe(404);
    expect((await http(port, { path: `${PERMISSION_PATH}/${'0'.repeat(32)}` })).body).toBe('');
    expect((await http(port, { method: 'POST', path: PERMISSION_PATH, headers: { ...json, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
  });

  it('at shutdown every waiting hook ends empty', async () => {
    const ticket = (await ask(bash('touch m.txt'))).body;
    const hookWaits = wait(ticket);
    await sleep(30);
    permissions.stop();
    expect((await hookWaits.reply).body).toBe('');
  });
});

describe('decision output', () => {
  it('is the JSON Claude Code reads on stdout', () => {
    expect(JSON.parse(decisionOutput('allow'))).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });
});

describe('interactive claude', () => {
  it('knows -p, --print and the SDK streams from the command line', () => {
    expect(isInteractiveCommand('claude')).toBe(true);
    expect(isInteractiveCommand('/Users/a/.local/bin/claude --model haiku --permission-mode default --settings /x/s.json')).toBe(true);
    expect(isInteractiveCommand('claude --resume 61df571e-08f1-4c4e-aa0f-86ca083ef837')).toBe(true);
    expect(isInteractiveCommand('claude -p --model haiku fai qualcosa')).toBe(false);
    expect(isInteractiveCommand('claude --print ciao')).toBe(false);
    expect(isInteractiveCommand('claude -cp ciao')).toBe(false);
    expect(isInteractiveCommand('claude --output-format stream-json --verbose --input-format stream-json')).toBe(false);
    expect(isInteractiveCommand('claude --output-format=json')).toBe(false);
    // When in doubt, not held: the dialog stays in the terminal.
    expect(isInteractiveCommand(undefined)).toBe(false);
  });
});
