import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { envFileText, paneEnv } from '../src/cli/pane-env.ts';
import { paths } from '../src/shared/paths.ts';
import { tempDir } from './helpers.ts';

const temp = tempDir('scripts');
afterAll(() => temp.cleanup());

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(file, args, { env, timeout: 10_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), ms: Date.now() - started });
    });
    child.stdin?.end(input ?? '');
  });
}

const BASE_ENV = { PATH: '/usr/bin:/bin' };

describe('bin/forchetta-hook', () => {
  it('prints nothing and exits 0 at once when the daemon is not running', async () => {
    const result = await run(paths.hookScript, ['1'], BASE_ENV, '{"hook_event_name":"SessionStart","session_id":"x"}');
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.ms).toBeLessThan(1500);
  });

  it('sends the input with pid, pane and agent', async () => {
    let received: { url?: string; headers: IncomingHttpHeaders; body: string } | undefined;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received = { url: req.url, headers: req.headers, body };
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const input = '{"hook_event_name":"SessionStart","session_id":"abc","source":"startup"}';
    const result = await run(paths.hookScript, [String(port)], { ...BASE_ENV, TMUX_PANE: '%5', FORCHETTA_AGENT: 'agent-1', CLAUDE_PID: '777' }, input);
    await new Promise((resolve) => server.close(resolve));
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(received?.url).toBe('/forchetta/hook');
    expect(received?.body).toBe(input);
    expect(received?.headers['content-type']).toBe('application/json');
    expect(received?.headers['x-forchetta-pane']).toBe('%5');
    expect(received?.headers['x-forchetta-agent']).toBe('agent-1');
    expect(received?.headers['x-forchetta-claude-pid']).toBe('777');
    expect(Number(received?.headers['x-forchetta-pid'])).toBe(process.pid);
  });
});

describe('bin/forchetta-statusline', () => {
  it('runs the status line you had, saved in the private folder of Forchetta', async () => {
    const data = join(temp.dir, 'dati con spazi');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'statusline-command'), 'read line; echo "prima: $line"');
    const result = await run(paths.statusScript, ['1'], { ...BASE_ENV, FORCHETTA_VAR: data }, '{"x":1}\n');
    expect(result).toMatchObject({ code: 0, stdout: 'prima: {"x":1}\n' });
  });
});

describe('bin/forchetta-permission', () => {
  const input = '{"hook_event_name":"PermissionRequest","session_id":"abc","tool_name":"Bash","tool_input":{"command":"ls"}}';
  const TICKET = 'ab'.repeat(16);

  it('prints nothing and exits 0 at once when the daemon is not running: the dialog goes on as usual', async () => {
    const result = await run(paths.permissionScript, ['1'], BASE_ENV, input);
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.ms).toBeLessThan(1500);
  });

  it('prints nothing when the daemon gives no ticket', async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.end());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const result = await run(paths.permissionScript, [String(port)], BASE_ENV, input);
    await new Promise((resolve) => server.close(resolve));
    expect(result).toMatchObject({ code: 0, stdout: '' });
  });

  it('sends the request, waits on its ticket and prints the decision', async () => {
    const seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: string }> = [];
    const decision = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.method === 'POST') res.end(TICKET);
        else setTimeout(() => res.end(decision), 300);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const result = await run(paths.permissionScript, [String(port), '30'], { ...BASE_ENV, CLAUDE_PID: '777', FORCHETTA_AGENT: 'agent-1' }, input);
    await new Promise((resolve) => server.close(resolve));
    expect(result).toMatchObject({ code: 0, stdout: decision });
    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual(['POST /forchetta/permission', `GET /forchetta/permission/${TICKET}`]);
    expect(seen[0]?.body).toBe(input);
    expect(seen[0]?.headers['x-forchetta-wait']).toBe('30');
    expect(seen[0]?.headers['x-forchetta-claude-pid']).toBe('777');
  });

  it('ends its wait when Claude Code ends it, so the daemon sees the connection close', async () => {
    let closed: () => void = () => {};
    let waiting: () => void = () => {};
    const connectionClosed = new Promise<void>((resolve) => (closed = resolve));
    const hookWaits = new Promise<void>((resolve) => (waiting = resolve));
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.method === 'POST') return res.end(TICKET);
        res.on('close', () => closed());
        waiting();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const child = spawn(paths.permissionScript, [String(port), '30'], { env: BASE_ENV });
    child.stdin.end(input);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await hookWaits;
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    await connectionClosed;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    expect(stdout).toBe('');
  });
});

describe('environment of a pane', () => {
  it('keeps the terminal, drops what belongs to tmux, the outer window and a running Claude session', () => {
    const env = paneEnv(
      { PATH: '/bin', HOME: '/h', TERM: 'xterm', TMUX: 'x', TERM_SESSION_ID: 'w', CLAUDECODE: '1', CLAUDE_PID: '9', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', FORCHETTA_ANTHROPIC_API_KEY: 'k', 'BAD-NAME': 'x' },
      'id-1',
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', FORCHETTA_AGENT: 'id-1' });
  });

  it('survives quotes, newlines and shell characters through bin/forchetta-exec', async () => {
    const file = join(temp.dir, 'pane.env');
    const tricky = `it's "quoted" $HOME \`date\` \\ ; | & \n second line ✓`;
    writeFileSync(file, envFileText({ PATH: '/usr/bin:/bin', TRICKY: tricky, FORCHETTA_AGENT: 'id-2' }), { mode: 0o600 });
    const result = await run(
      '/bin/sh',
      [paths.execScript, file, '--', '/bin/sh', '-c', 'printf "%s|%s|%s|%s|%s" "$TRICKY" "$FORCHETTA_AGENT" "$TMUX_PANE" "$TERM" "${OUTER_ONLY:-none}"'],
      { ...BASE_ENV, TMUX_PANE: '%9', TERM: 'screen-256color', OUTER_ONLY: 'leak' },
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${tricky}|id-2|%9|screen-256color|none`);
    expect(existsSync(file)).toBe(false);
  });
});
