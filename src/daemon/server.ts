import { appendFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Hub } from './hub.ts';
import type { Permissions } from './permissions.ts';
import type { Terminals } from './terminals.ts';
import type { HookMeta, Registry } from './registry.ts';
import type { Agent, HookPayload } from './state.ts';
import { serveStatic } from './static.ts';
import { artifactOf } from '../shared/artifacts.ts';

// The HTTP side of the daemon, on 127.0.0.1 only.
//
// /forchetta/hook takes the hook events that bin/forchetta-hook forwards. It answers 200 with an empty body,
// always: Forchetta only listens. Requests with an Origin header come from a web page and are refused.
//
// /forchetta/permission takes the PermissionRequest of bin/forchetta-permission the same way, and answers with
// a ticket when the box may answer the dialog; the hook then waits on /forchetta/permission/<ticket> for the
// decision (daemon/permissions.ts). The ticket is the only key to the answer.
//
// /api/* is for the CLI and the app, with the token of var/daemon.json.

export const HOOK_PATH = '/forchetta/hook';
export const PERMISSION_PATH = '/forchetta/permission';
/** The input of the status line, from bin/forchetta-statusline: the cost of the session. */
export const STATUS_PATH = '/forchetta/status';
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
  /** The routes of the MCP server of a team: /api/crew/<route>, POST with JSON. */
  crew?: (route: string, input: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
  log: (message: string) => void;
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

const isLocalHost = (host: string | undefined, port: number): boolean => host === `127.0.0.1:${port}` || host === `localhost:${port}`;

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
  if (pane && /^%\d+$/.test(pane)) meta.pane = pane;
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
    trigger: optionalString(input.trigger),
    agent_id: optionalString(input.agent_id),
    agent_type: optionalString(input.agent_type),
    permission_suggestions: input.hook_event_name === 'PermissionRequest' ? input.permission_suggestions : undefined,
    // The response of the other tools (outputs of commands, files read) is not kept.
    tool_response: input.hook_event_name === 'PostToolUse' && typeof input.tool_name === 'string' && WRITE_TOOLS.has(input.tool_name) ? input.tool_response : undefined,
    artifact: input.hook_event_name === 'PostToolUse' ? artifactOf(input.tool_name, input.tool_input, input.tool_response) : undefined,
  };
}

/** Session and cost from the input of the status line; undefined when they are not there. */
export function statusUsage(body: Buffer): { sessionId: string; usd: number } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as { session_id?: unknown; cost?: { total_cost_usd?: unknown } };
  const usd = input.cost?.total_cost_usd;
  if (typeof input.session_id !== 'string' || typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return undefined;
  return { sessionId: input.session_id, usd };
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

export function createDaemonServer(options: ServerOptions): Server {
  const { registry, token, log } = options;

  /** A hook input: recorded if asked, applied to its agent, passed on. Undefined when it is not one. */
  function takeHook(body: Buffer | undefined, headers: IncomingHttpHeaders): { agent: Agent; payload: HookPayload } | undefined {
    if (!body) {
      log('hook: corpo troppo grande, ignorato');
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      log('hook: JSON non valido');
      return undefined;
    }
    const payload = slimPayload(raw);
    if (!payload) {
      log('hook: input senza hook_event_name o session_id');
      return undefined;
    }
    const meta = hookMeta(headers);
    if (options.recordFile) {
      try {
        const pids = { ppid: header(headers, 'x-forchetta-pid'), claudePid: header(headers, 'x-forchetta-claude-pid') };
        appendFileSync(options.recordFile, `${JSON.stringify({ at: Date.now(), meta, pids, payload: forRecord(raw as Record<string, unknown>) })}\n`, { mode: 0o600 });
      } catch (error) {
        log(`registrazione: ${String(error)}`);
      }
    }
    const agent = registry.hook(payload, meta);
    options.onHook?.(agent, payload);
    return { agent, payload };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = options.port();
    if (!isLocalHost(req.headers.host, port)) return send(res, 403);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const ownOrigin = `http://127.0.0.1:${port}`;

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

    if (url.pathname === STATUS_PATH) {
      if (req.method !== 'POST') return send(res, 405);
      if (req.headers.origin !== undefined) return send(res, 403);
      const type = req.headers['content-type'];
      if (type !== undefined && !/^application\/json\b/i.test(type)) return send(res, 415);
      const body = await readBody(req);
      send(res, 200);
      const usage = body ? statusUsage(body) : undefined;
      if (usage) registry.usage(usage.sessionId, hookMeta(req.headers), usage.usd);
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
      if (origin !== undefined && origin !== ownOrigin) return send(res, 403);
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
          return send(res, 400, { error: 'JSON non valido' });
        }
        const { id, cwd, tmuxSession } = input;
        if (typeof id !== 'string' || !UUID.test(id) || typeof cwd !== 'string' || !cwd.startsWith('/') || typeof tmuxSession !== 'string' || !/^fk-[0-9a-f]{8}$/.test(tmuxSession)) {
          return send(res, 400, { error: 'campi non validi' });
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
      if (url.pathname === '/api/shutdown' && req.method === 'POST') {
        send(res, 200, { ok: true });
        setImmediate(options.onShutdown);
        return;
      }
      return send(res, 404);
    }

    if (req.method === 'GET' && options.uiDir && serveStatic(options.uiDir, url.pathname, port, res)) return;
    return send(res, 404);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`richiesta ${req.method} ${req.url}: ${String(error)}`);
      if (!res.headersSent) send(res, 500);
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/term' && options.terminals) options.terminals.handleUpgrade(req, socket, head);
    else if (path === '/ws' && options.hub) options.hub.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  return server;
}
