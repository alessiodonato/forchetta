import { appendFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Server as NetServer } from 'node:net';
import type { Hub } from './hub.ts';
import { isLocalHost, isOwnOrigin } from './origin.ts';
import type { Permissions } from './permissions.ts';
import type { Terminals } from './terminals.ts';
import type { HookMeta, Registry, StatusContext, StatusLine } from './registry.ts';
import type { Agent, HookPayload } from './state.ts';
import { isFullPath } from '../shared/agent.ts';
import { serveStatic } from './static.ts';
import { ownPaths } from './windows-payload.ts';
import { artifactOf } from '../shared/artifacts.ts';
import { subagentResultOf } from './subagents.ts';
import { type RateLimits, rateLimitsOf } from './limits.ts';

// The HTTP side of the daemon, on 127.0.0.1 only.
//
// /forchetta/hook takes the hook events that bin/forchetta-hook forwards. It answers 200 with an empty body,
// always: Forchetta only listens. Requests with an Origin header come from a web page and are refused.
//
// /forchetta/permission takes the PermissionRequest of bin/forchetta-permission the same way, and answers with
// a ticket when the box may answer the dialog; the hook then waits on /forchetta/permission/<ticket> for the
// decision (daemon/permissions.ts). The ticket is the only key to the answer.
//
// /forchetta/guard takes the PreToolUse of bin/forchetta-guard, which Claude waits for, and answers at once with
// the decision of the guard as Claude Code reads it, or with an empty body (daemon/guard.ts). It applies nothing:
// the same event comes through /forchetta/hook too.
//
// /api/* is for the CLI and the app, with the token of var/daemon.json. /open gives that token to a page in a browser,
// for a code of `forchetta open` (daemon/open-codes.ts).

export const HOOK_PATH = '/forchetta/hook';
export const PERMISSION_PATH = '/forchetta/permission';
export const GUARD_PATH = '/forchetta/guard';
/** The input of the status line, from bin/forchetta-statusline: the cost of the session. */
export const STATUS_PATH = '/forchetta/status';
/** Where the page of a browser trades the code of `forchetta open` for the token. */
export const OPEN_PATH = '/open';
const TICKET = /^[0-9a-f]{32}$/;
const MAX_BODY = 32 * 1024 * 1024;

export interface ServerOptions {
  registry: Registry;
  token: string;
  /** The folder of the page (dist/ui), served at /. */
  uiDir?: string;
  /** The WebSocket of the page. */
  hub?: Hub;
  /** The WebSockets of the terminals, one per open pane. */
  terminals?: Terminals;
  /** The permission dialogs the box can answer. */
  permissions?: Pick<Permissions, 'open' | 'attach'>;
  /** Reads `arricurdai status` again, for /api/agents?fresh=1. */
  refreshContext?: () => Promise<void>;
  /** The port the server listens on, for the Host check; read after listen when 0 was asked. */
  port: () => number;
  /** Appends every hook input here, for the tests built from real events. */
  recordFile?: string;
  onShutdown: () => void;
  onHook?: (agent: Agent, payload: HookPayload) => void;
  /** The limits of the Claude plan, from an input of the status line that carries them (daemon/limits.ts). */
  onRateLimits?: (limits: RateLimits, agent?: Agent) => void;
  /** The guard: what to answer before a tool that writes files or runs a command; undefined lets it go. */
  guard?: (agent: Agent, payload: HookPayload) => object | undefined | Promise<object | undefined>;
  /**
   * The page in a browser, where there is no app (Linux, WSL): the codes of `forchetta open`, made for the CLI and
   * traded once by the page for the token; at localhost too, in WSL. Undefined on a Mac: the app has the token.
   */
  browser?: {
    codes: { create(): string; redeem(code: unknown): boolean };
    localhost: boolean;
    /** On Linux: whether who trades a code is of the user of the daemon (daemon/peer.ts). */
    sameUser?: (socket: { remotePort?: number; localPort?: number }) => boolean;
  };
  /** The routes of the MCP server of a team: /api/crew/<route>, POST with JSON. */
  crew?: (route: string, input: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
  /** The other routes of /api/ (the commands of the CLI: teams, templates, diagnostics); undefined: not one. */
  api?: (method: string, path: string, query: URLSearchParams, input: Record<string, unknown>) => Promise<{ status: number; body: unknown } | undefined>;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  info: () => Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status, { 'Content-Length': '0' });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

/** The body, or undefined when it is larger than the limit. */
function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? undefined : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What forchetta-hook adds to every event: the pid of claude, its tmux pane, its Forchetta id. */
export function hookMeta(headers: IncomingHttpHeaders): HookMeta {
  const meta: HookMeta = {};
  const pid = Number(header(headers, 'x-forchetta-claude-pid') ?? header(headers, 'x-forchetta-pid'));
  if (Number.isInteger(pid) && pid > 1) meta.pid = pid;
  const pane = header(headers, 'x-forchetta-pane');
  // %3 of tmux; on Windows the session itself.
  if (pane && /^(?:%\d+|fk-[0-9a-f]{8})$/.test(pane)) meta.pane = pane;
  const agent = header(headers, 'x-forchetta-agent');
  if (agent && UUID.test(agent)) meta.agentId = agent.toLowerCase();
  return meta;
}

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The tools whose response Forchetta keeps: their patch is what the session wrote. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** The fields Forchetta reads; tool responses and the rest are dropped on arrival. */
export function slimPayload(raw: unknown): HookPayload | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  const event = optionalString(input.hook_event_name);
  const session = optionalString(input.session_id);
  if (!event || session === undefined) return undefined;
  return {
    hook_event_name: event,
    session_id: session,
    transcript_path: optionalString(input.transcript_path),
    cwd: optionalString(input.cwd),
    source: optionalString(input.source),
    reason: optionalString(input.reason),
    model: optionalString(input.model),
    prompt: optionalString(input.prompt),
    tool_name: optionalString(input.tool_name),
    tool_input: input.tool_input,
    notification_type: optionalString(input.notification_type),
    message: optionalString(input.message),
    last_assistant_message: optionalString(input.last_assistant_message),
    error: input.error,
    error_details: input.error_details,
    is_interrupt: input.is_interrupt === true ? true : undefined,
    trigger: optionalString(input.trigger),
    agent_id: optionalString(input.agent_id),
    agent_type: optionalString(input.agent_type),
    tool_use_id: optionalString(input.tool_use_id),
    subagent_result: input.hook_event_name === 'PostToolUse' ? subagentResultOf(input.tool_name, input.tool_response) : undefined,
    permission_suggestions: input.hook_event_name === 'PermissionRequest' ? input.permission_suggestions : undefined,
    // The response of the other tools (outputs of commands, files read) is not kept.
    tool_response: input.hook_event_name === 'PostToolUse' && typeof input.tool_name === 'string' && WRITE_TOOLS.has(input.tool_name) ? input.tool_response : undefined,
    artifact: input.hook_event_name === 'PostToolUse' ? artifactOf(input.tool_name, input.tool_input, input.tool_response) : undefined,
  };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The context of the session from `context_window` of the status line. Null when Claude Code says there is none
 * yet: before the first call, and after /compact until the next one. Undefined when it does not say: without
 * `used_percentage` (Claude Code before 2.1.6) the context is left to arricurdAI.
 */
export function statusContext(value: unknown): StatusContext | null | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const window = value as Record<string, unknown>;
  if (!('used_percentage' in window)) return undefined;
  if (window.used_percentage === null || window.current_usage === null) return null;
  const size = window.context_window_size;
  if (!finite(window.used_percentage) || !finite(size) || size <= 0) return undefined;
  let tokens = window.total_input_tokens;
  if (!finite(tokens) || tokens < 0) {
    // The same count from the parts of the last call: what was read from the cache, written to it, and the rest.
    const usage = (window.current_usage ?? {}) as Record<string, unknown>;
    const part = (key: string): number => (finite(usage[key]) && (usage[key] as number) > 0 ? (usage[key] as number) : 0);
    tokens = part('input_tokens') + part('cache_creation_input_tokens') + part('cache_read_input_tokens');
  }
  return { tokens: Math.round(tokens as number), window: size, percent: Math.min(100, Math.max(0, Math.round(window.used_percentage))) };
}

/** Session, cost and context from the input of the status line; undefined when it carries neither. */
export function statusUsage(body: Buffer): ({ sessionId: string } & StatusLine) | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as { session_id?: unknown; cost?: { total_cost_usd?: unknown }; context_window?: unknown };
  if (typeof input.session_id !== 'string') return undefined;
  const cost = input.cost?.total_cost_usd;
  const usd = finite(cost) && cost >= 0 ? cost : undefined;
  const context = statusContext(input.context_window);
  if (usd === undefined && context === undefined) return undefined;
  return { sessionId: input.session_id, ...(usd !== undefined && { usd }), ...(context !== undefined && { context }) };
}

/** A hook input for the record: tool responses cut short, the rest as it came. */
function forRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...raw };
  if (copy.tool_response !== undefined) {
    const text = JSON.stringify(copy.tool_response);
    copy.tool_response = text.length > 300 ? `${text.slice(0, 300)}…` : copy.tool_response;
  }
  return copy;
}

/** The routes of the hooks of Claude Code: only on the socket of the private folder (DaemonServer.hooks). */
const isHookRoute = (path: string): boolean => path === HOOK_PATH || path === PERMISSION_PATH || path === GUARD_PATH || path === STATUS_PATH || path.startsWith(`${PERMISSION_PATH}/`);

/**
 * The server of the daemon on 127.0.0.1 (the page, its WebSocket, /api with the token), and `hooks`: the same
 * routes for the hooks of Claude Code, on a Unix socket in the private folder of Forchetta (0700). The hooks talk
 * only there: no other user or app can open that socket, nor be there in its place when the daemon is off, so
 * what a hook prints to Claude Code (a decision of the guard, the answer to a permission) comes from this daemon.
 */
export type DaemonServer = Server & {
  hooks: Server;
  /** Windows: the pipe whose connections go to `hooks`, once they proved to be of Forchetta (shared/pipe.ts). */
  pipe?: NetServer;
};

export function createDaemonServer(options: ServerOptions): DaemonServer {
  const { registry, token, log } = options;

  /** A hook input: recorded if asked, applied to its agent, passed on. Undefined when it is not one. */
  function takeHook(body: Buffer | undefined, headers: IncomingHttpHeaders): { agent: Agent; payload: HookPayload } | undefined {
    if (!body) {
      log('hook: body too large, ignored', 'warn');
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      log('hook: invalid JSON', 'warn');
      return undefined;
    }
    const slim = slimPayload(raw);
    if (!slim) {
      log('hook: input without hook_event_name or session_id', 'warn');
      return undefined;
    }
    const payload = ownPaths(slim);
    const meta = hookMeta(headers);
    if (options.recordFile) {
      try {
        const pids = { ppid: header(headers, 'x-forchetta-pid'), claudePid: header(headers, 'x-forchetta-claude-pid') };
        appendFileSync(options.recordFile, `${JSON.stringify({ at: Date.now(), meta, pids, payload: forRecord(raw as Record<string, unknown>) })}\n`, { mode: 0o600 });
      } catch (error) {
        log(`recording: ${String(error)}`, 'warn');
      }
    }
    const agent = registry.hook(payload, meta);
    options.onHook?.(agent, payload);
    return { agent, payload };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, viaSocket: boolean): Promise<void> {
    const port = options.port();
    // Over the socket there is no host to check (no browser reaches it); over TCP the host stops DNS rebinding.
    if (!viaSocket && !isLocalHost(req.headers.host, port)) return send(res, 403);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    // The hooks only over the socket; the socket only for the hooks.
    if (viaSocket !== isHookRoute(url.pathname)) return send(res, viaSocket ? 404 : 403);

    if (url.pathname === HOOK_PATH || url.pathname === PERMISSION_PATH) {
      if (req.method !== 'POST') return send(res, 405);
      if (req.headers.origin !== undefined) return send(res, 403);
      const type = req.headers['content-type'];
      if (type !== undefined && !/^application\/json\b/i.test(type)) return send(res, 415);
      const body = await readBody(req);
      const permission = url.pathname === PERMISSION_PATH;
      // An event only informs: the hook gets its empty answer at once.
      if (!permission) send(res, 200);
      const taken = takeHook(body, req.headers);
      if (!permission) return;
      let ticket: string | undefined;
      if (taken && taken.payload.hook_event_name === 'PermissionRequest' && options.permissions) {
        ticket = await options.permissions.open(taken.agent, taken.payload, Number(header(req.headers, 'x-forchetta-wait')));
      }
      if (!ticket) return send(res, 200);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': ticket.length, 'Cache-Control': 'no-store' });
      res.end(ticket);
      return;
    }

    if (url.pathname === GUARD_PATH) {
      if (req.method !== 'POST') return send(res, 405);
      if (req.headers.origin !== undefined) return send(res, 403);
      const type = req.headers['content-type'];
      if (type !== undefined && !/^application\/json\b/i.test(type)) return send(res, 415);
      const body = await readBody(req);
      let decision: object | undefined;
      try {
        const slim = body ? slimPayload(JSON.parse(body.toString('utf8'))) : undefined;
        const payload = slim ? ownPaths(slim) : undefined;
        const agent = payload ? registry.lookup(payload, hookMeta(req.headers)) : undefined;
        if (payload && agent) decision = await options.guard?.(agent, payload);
      } catch (error) {
        // A broken input, or a fault of the guard: the tool goes on as usual.
        log(`guard: ${String(error)}`, 'error');
      }
      return decision ? send(res, 200, decision) : send(res, 200);
    }

    if (url.pathname === STATUS_PATH) {
      if (req.method !== 'POST') return send(res, 405);
      if (req.headers.origin !== undefined) return send(res, 403);
      const type = req.headers['content-type'];
      if (type !== undefined && !/^application\/json\b/i.test(type)) return send(res, 415);
      const body = await readBody(req);
      send(res, 200);
      const status = body ? statusUsage(body) : undefined;
      const agent = status ? registry.status(status.sessionId, hookMeta(req.headers), status) : undefined;
      const limits = body && options.onRateLimits ? rateLimitsOf(body) : undefined;
      if (limits) options.onRateLimits?.(limits, agent);
      return;
    }

    if (url.pathname.startsWith(`${PERMISSION_PATH}/`)) {
      if (req.method !== 'GET') return send(res, 405);
      if (req.headers.origin !== undefined) return send(res, 403);
      const ticket = url.pathname.slice(PERMISSION_PATH.length + 1);
      if (!TICKET.test(ticket) || !options.permissions) return send(res, 404);
      options.permissions.attach(ticket, res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin !== undefined && !isOwnOrigin(origin, port, options.browser?.localhost)) return send(res, 403);
      if (!tokenMatches(req.headers.authorization, token)) return send(res, 401);

      if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, ...options.info() });
      if (url.pathname === '/api/agents' && req.method === 'GET') {
        if (url.searchParams.get('fresh') === '1' && options.refreshContext) await options.refreshContext();
        return send(res, 200, { agents: registry.list(), now: Date.now() });
      }
      if (url.pathname === '/api/agents' && req.method === 'POST') {
        const body = await readBody(req);
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(body?.toString('utf8') ?? '') as Record<string, unknown>;
        } catch {
          return send(res, 400, { error: 'invalid JSON' });
        }
        const { id, cwd, tmuxSession } = input;
        if (typeof id !== 'string' || !UUID.test(id) || typeof cwd !== 'string' || !isFullPath(cwd) || typeof tmuxSession !== 'string' || !/^fk-[0-9a-f]{8}$/.test(tmuxSession)) {
          return send(res, 400, { error: 'invalid fields' });
        }
        return send(res, 200, { agent: registry.register({ id: id.toLowerCase(), cwd, tmuxSession }) });
      }
      if (url.pathname.startsWith('/api/crew/') && req.method === 'POST' && options.crew) {
        const body = await readBody(req);
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(body?.toString('utf8') || '{}') as Record<string, unknown>;
        } catch {
          return send(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const result = await options.crew(url.pathname.slice('/api/crew/'.length), input);
        return send(res, result.status, result.body);
      }
      if (url.pathname === '/api/open' && req.method === 'POST' && options.browser) return send(res, 200, { code: options.browser.codes.create() });
      if (url.pathname === '/api/shutdown' && req.method === 'POST') {
        send(res, 200, { ok: true });
        setImmediate(options.onShutdown);
        return;
      }
      if (options.api && (req.method === 'GET' || req.method === 'POST')) {
        let input: Record<string, unknown> = {};
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (!body) return send(res, 413);
          try {
            const parsed = JSON.parse(body.toString('utf8') || '{}') as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
          } catch {
            return send(res, 400, { ok: false, error: 'invalid JSON' });
          }
        }
        const answer = await options.api(req.method, url.pathname, url.searchParams, input);
        if (answer) return send(res, answer.status, answer.body);
      }
      return send(res, 404);
    }

    // The page itself, opened by `forchetta open`: its origin, JSON, and a code not used yet.
    if (url.pathname === OPEN_PATH && req.method === 'POST' && options.browser) {
      if (!isOwnOrigin(req.headers.origin, port, options.browser.localhost)) return send(res, 403);
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415);
      // Not spent: it is still good for who it was made for.
      if (options.browser.sameUser && !options.browser.sameUser(req.socket)) {
        log('open: refused, not from a program of this user', 'warn');
        return send(res, 403);
      }
      const body = await readBody(req);
      let code: unknown;
      try {
        code = (JSON.parse(body?.toString('utf8') ?? '') as { code?: unknown } | null)?.code;
      } catch {
        return send(res, 400);
      }
      return options.browser.codes.redeem(code) ? send(res, 200, { token }) : send(res, 403);
    }

    if (req.method === 'GET' && options.uiDir && serveStatic(options.uiDir, url.pathname, port, res, options.browser)) return;
    return send(res, 404);
  }

  const handler =
    (viaSocket: boolean) =>
    (req: IncomingMessage, res: ServerResponse): void => {
      handle(req, res, viaSocket).catch((error: unknown) => {
        log(`request ${req.method} ${req.url}: ${String(error)}`, 'error');
        if (!res.headersSent) send(res, 500);
      });
    };
  const server = createServer(handler(false)) as DaemonServer;
  server.hooks = createServer(handler(true));
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/term' && options.terminals) options.terminals.handleUpgrade(req, socket, head);
    else if (path === '/ws' && options.hub) options.hub.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  return server;
}
