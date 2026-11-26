import { execFile, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { daemonEnv, envFileText, paneEnv, withUtf8 } from '../src/cli/pane-env.ts';
import { defaultVarDir, paths } from '../src/shared/paths.ts';
import { PLATFORM } from '../src/shared/platform.ts';
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

// The hooks talk on the socket of the private folder: in the tests always one of their own, never the folder of
// this checkout, where a daemon may be running.
const NOWHERE = join(temp.dir, 'no-daemon');
mkdirSync(NOWHERE, { recursive: true });
const BASE_ENV = { PATH: '/usr/bin:/bin', FORCHETTA_VAR: NOWHERE };

let sockets = 0;
/** A server on the socket of a private folder of its own, as the daemon listens for the hooks; that folder. */
async function onSocket(server: { listen: (path: string, done: () => void) => unknown }): Promise<string> {
  const dir = join(temp.dir, `sock-${++sockets}`);
  mkdirSync(dir, { recursive: true });
  await new Promise<void>((resolve) => server.listen(join(dir, 'hooks.sock'), resolve));
  return dir;
}

describe('the private folder of the scripts', () => {
  it('is the one of the daemon, for an installed copy too', async () => {
    const app = join(temp.dir, 'installed');
    const home = join(temp.dir, 'home');
    const script = join(app, 'bin', 'forchetta-statusline');
    mkdirSync(join(app, 'bin'), { recursive: true });
    copyFileSync(paths.statusScript, script);
    chmodSync(script, 0o755);
    const env = { PATH: '/usr/bin:/bin', HOME: home };
    expect((await run(script, ['1'], env, '{}')).stdout).toBe('');
    // A daemon ran there, and is off now: the status line says so.
    const data = defaultVarDir(app, {}, existsSync, home);
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'data-version'), '1\n');
    expect((await run(script, ['1'], env, '{}')).stdout).toContain('Forchetta is off');
  });

  it('is found the same way by each of them', () => {
    const rule = (file: string): string | undefined => /root=\$\(cd[\s\S]*?\nfi\nsocket=.*\n/.exec(readFileSync(file, 'utf8'))?.[0];
    expect(rule(paths.hookScript)).toBeDefined();
    for (const file of [paths.permissionScript, paths.guardScript, paths.statusScript]) expect(rule(file)).toBe(rule(paths.hookScript));
  });
});

describe('bin/forchetta-hook', () => {
  it('prints nothing and exits 0 at once when the daemon is not running', async () => {
    const result = await run(paths.hookScript, ['1'], BASE_ENV, '{"hook_event_name":"SessionStart","session_id":"x"}');
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.ms).toBeLessThan(1500);
  });

  it('talks on the port to a daemon from before the socket, never once a newer one has run in the folder', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? '');
      req.resume();
      req.on('end', () => res.end());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = String((server.address() as { port: number }).port);
    const input = '{"hook_event_name":"Stop","session_id":"abc"}';
    // A folder where only an older daemon ran: no socket, no data-version.
    const older = join(temp.dir, 'older-daemon');
    mkdirSync(older, { recursive: true });
    await run(paths.hookScript, [port], { ...BASE_ENV, FORCHETTA_VAR: older }, input);
    expect(seen).toEqual(['/forchetta/hook']);
    // A newer daemon ran here and is off now: nothing goes to the port, whoever listens there.
    const newer = join(temp.dir, 'newer-daemon');
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(newer, 'data-version'), '1\n');
    const guard = await run(paths.guardScript, [port], { ...BASE_ENV, FORCHETTA_VAR: newer }, '{"hook_event_name":"PreToolUse","session_id":"abc","tool_name":"Edit"}');
    await run(paths.hookScript, [port], { ...BASE_ENV, FORCHETTA_VAR: newer }, input);
    await new Promise((resolve) => server.close(resolve));
    expect(seen).toEqual(['/forchetta/hook']);
    expect(guard).toMatchObject({ code: 0, stdout: '' });
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
    const varDir = await onSocket(server);
    const input = '{"hook_event_name":"SessionStart","session_id":"abc","source":"startup"}';
    const result = await run(paths.hookScript, ['1'], { ...BASE_ENV, FORCHETTA_VAR: varDir, TMUX_PANE: '%5', FORCHETTA_AGENT: 'agent-1', CLAUDE_PID: '777' }, input);
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

describe('bin/forchetta-guard', () => {
  const INPUT = '{"hook_event_name":"PreToolUse","session_id":"abc","tool_name":"Edit","tool_input":{"file_path":"/p/a.ts"}}';

  /** A daemon that answers the guard with this status and body. */
  async function daemon(status: number, body: string) {
    let received: { url?: string; headers: IncomingHttpHeaders; body: string } | undefined;
    const server = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString()));
      req.on('end', () => {
        received = { url: req.url, headers: req.headers, body: text };
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body);
      });
    });
    const varDir = await onSocket(server);
    return { varDir, received: () => received, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  it('prints nothing and exits 0 at once when the daemon is not running: the tool goes on', async () => {
    // macOS checks a script the first time it runs, which can take seconds on a busy Mac: that run is not timed.
    await run(paths.guardScript, ['1'], BASE_ENV, INPUT);
    const result = await run(paths.guardScript, ['1'], BASE_ENV, INPUT);
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.ms).toBeLessThan(1500);
  });

  it('prints the decision of the daemon, as it came, for Claude Code to read', async () => {
    const decision = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"busy"}}';
    const server = await daemon(200, decision);
    const result = await run(paths.guardScript, ['1'], { ...BASE_ENV, FORCHETTA_VAR: server.varDir, FORCHETTA_AGENT: 'agent-1', TMUX_PANE: '%3' }, INPUT);
    await server.close();
    expect(result).toMatchObject({ code: 0, stdout: decision, stderr: '' });
    expect(server.received()?.url).toBe('/forchetta/guard');
    expect(server.received()?.body).toBe(INPUT);
    expect(server.received()?.headers['x-forchetta-agent']).toBe('agent-1');
  });

  it('prints nothing when the daemon has nothing to say, or answers with an error', async () => {
    for (const [status, body] of [
      [200, ''],
      [500, '{"error":"x"}'],
    ] as const) {
      const server = await daemon(status, body);
      const result = await run(paths.guardScript, ['1'], { ...BASE_ENV, FORCHETTA_VAR: server.varDir }, INPUT);
      await server.close();
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    }
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
    const varDir = await onSocket(server);
    const result = await run(paths.permissionScript, ['1'], { ...BASE_ENV, FORCHETTA_VAR: varDir }, input);
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
    const varDir = await onSocket(server);
    const result = await run(paths.permissionScript, ['1', '30'], { ...BASE_ENV, FORCHETTA_VAR: varDir, CLAUDE_PID: '777', FORCHETTA_AGENT: 'agent-1' }, input);
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
    const varDir = await onSocket(server);
    const child = spawn(paths.permissionScript, ['1', '30'], { env: { ...BASE_ENV, FORCHETTA_VAR: varDir } });
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
      { PATH: '/bin', HOME: '/h', TERM: 'xterm', TMUX: 'x', TERM_SESSION_ID: 'w', CLAUDECODE: '1', CLAUDE_PID: '9', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', FORCHETTA_ANTHROPIC_API_KEY: 'k', 'BAD-NAME': 'x', LANG: 'it_IT.UTF-8' },
      'id-1',
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', LANG: 'it_IT.UTF-8', FORCHETTA_AGENT: 'id-1' });
  });

  it('gets a locale in UTF-8 when it has none, and keeps the one it has', () => {
    const lang = (env: NodeJS.ProcessEnv) => paneEnv(env, 'id-1').LANG;
    const utf8 = PLATFORM === 'macos' ? 'en_US.UTF-8' : 'C.UTF-8';
    expect(lang({})).toBe(utf8);
    expect(lang({ LANG: '', LC_ALL: '' })).toBe(utf8);
    expect(lang({ LANG: 'it_IT.UTF-8' })).toBe('it_IT.UTF-8');
    expect(lang({ LC_CTYPE: 'UTF-8' })).toBeUndefined();
  });

  it('the locale it gets is one its system has, and on Windows it gets none', () => {
    expect(withUtf8({}, 'macos')).toEqual({ LANG: 'en_US.UTF-8' });
    expect(withUtf8({}, 'linux')).toEqual({ LANG: 'C.UTF-8' });
    expect(withUtf8({}, 'wsl')).toEqual({ LANG: 'C.UTF-8' });
    expect(withUtf8({ LANG: 'it_IT.UTF-8' }, 'linux')).toEqual({ LANG: 'it_IT.UTF-8' });
    expect(withUtf8({}, 'windows')).toEqual({});
    expect(paneEnv({ LANG: '' }, 'id-1', true)).toEqual({ LANG: '', FORCHETTA_AGENT: 'id-1' });
  });

  it('the daemon, started from the shell of a session, keeps nothing of that session or of its tmux pane', () => {
    const env = daemonEnv({
      PATH: '/bin',
      TERM: 'screen-256color',
      TMUX: '/tmp/tmux-501/default,1,0',
      TMUX_PANE: '%3',
      FORCHETTA_AGENT: 'id-1',
      CLAUDECODE: '1',
      CLAUDE_PID: '9',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_USE_BEDROCK: '1',
      FORCHETTA_ANTHROPIC_API_KEY: 'k',
    });
    expect(env).toEqual({ PATH: '/bin', TERM: 'screen-256color', CLAUDE_CODE_USE_BEDROCK: '1', FORCHETTA_ANTHROPIC_API_KEY: 'k' });
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
