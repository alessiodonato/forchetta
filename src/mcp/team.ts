import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { TeamTool } from '../shared/crew.ts';
import { paths } from '../shared/paths.ts';
import { VERSION } from '../shared/version.ts';

// The tools of a team of agents, for Claude Code: an MCP server on stdio (JSON-RPC 2.0, one message per line),
// started by Claude Code for the lead of a team and for its members that answer (daemon/crews.ts writes their MCP
// configuration). It knows its session by FORCHETTA_AGENT and its tools by FORCHETTA_TEAM_TOOLS, and asks the
// daemon, with the token of var/daemon.json, to do what a tool says: the daemon checks again who may do what.
// No SDK: the closed list of dependencies has none, and initialize, tools/list and tools/call are enough.

interface Tool {
  name: TeamTool;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: Record<TeamTool, Tool> = {
  team: {
    name: 'team',
    description:
      'Your team in Forchetta: who leads it, its members, what each one does, whether it answers its lead, and what each one is doing now (free, working, which requests wait for it).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  send_request: {
    name: 'send_request',
    description:
      'Give work to members of your team. Each one gets the request as a new prompt "Request #<n> from <you>:" as soon as its session is free: while it works the request waits in its queue, so you never need to wait for a member. A member that answers sends you its final message as a new prompt "Answer from <name> to request #<n>:"; a member that executes only does not. Write the request complete: the member sees only that.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The names of the members, or ["all"] for every member.' },
        request: { type: 'string', description: 'What to do, complete and on its own.' },
      },
      required: ['to', 'request'],
      additionalProperties: false,
    },
  },
  wait_for_answers: {
    name: 'wait_for_answers',
    description:
      'Wait for the answers of requests you sent, and get them all here, in this turn: it returns when every member has finished them, or when the time is up (at most 10 minutes). Without a list it waits for all your requests still open. Answers that come after the time is up reach you as new prompts, as usual. While you wait, the user cannot write to you.',
    inputSchema: {
      type: 'object',
      properties: {
        requests: { type: 'array', items: { type: 'integer' }, description: 'The numbers of the requests to wait for; none: all your requests still open.' },
        minutes: { type: 'number', minimum: 1, maximum: 10, description: 'How long to wait at most (default 5).' },
      },
      additionalProperties: false,
    },
  },
  ask_lead: {
    name: 'ask_lead',
    description:
      'Ask your lead a question about the request you are working on, when you cannot go on without the answer. The lead gets it as a new prompt "Question from <you> about request #<n>:". Then end your turn: the answer reaches you as a new request.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The question, with what the lead needs to answer it.' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
};

/** A route of the daemon (/api/crew/<route>): its JSON answer, also for a refusal. */
export type Call = (route: string, body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type Reply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const text = (value: string, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

/** The answer to one message; undefined for a notification. */
export function createHandler(options: { agent: string; tools: readonly TeamTool[]; call: Call }): (message: Message) => Promise<Reply | undefined> {
  const tools = options.tools.filter((name) => name in TOOLS);
  return async (message) => {
    if (message.id === undefined || message.id === null) return undefined;
    const id = message.id;
    const ok = (result: unknown): Reply => ({ jsonrpc: '2.0', id, result });
    switch (message.method) {
      case 'initialize': {
        const asked = message.params?.protocolVersion;
        return ok({
          // Only tools, in the shape every version has: the version the client asks is fine.
          protocolVersion: typeof asked === 'string' ? asked : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'forchetta', version: VERSION },
          instructions: 'The tools of your team of agents in Forchetta.',
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: tools.map((name) => TOOLS[name]) });
      case 'tools/call': {
        const name = message.params?.name as TeamTool;
        const input = (message.params?.arguments ?? {}) as Record<string, unknown>;
        if (!tools.includes(name)) return ok(text(`This session has no tool ${String(name)}.`, true));
        try {
          if (name === 'team') {
            const result = await options.call('team', { agent: options.agent });
            return ok(result.ok ? text(String(result.text)) : text(result.error ?? 'no answer from Forchetta', true));
          }
          if (name === 'wait_for_answers') return ok(await waitForAnswers(options, input));
          if (name === 'send_request') {
            const to = Array.isArray(input.to) ? input.to : typeof input.to === 'string' ? [input.to] : [];
            const result = await options.call('request', { agent: options.agent, to, text: input.request });
            if (!result.ok) return ok(text(result.error ?? 'the request did not go', true));
            const names = (result.to as string[] | undefined)?.join(', ') ?? '';
            return ok(text(`Request #${result.n} is in the queue of ${names}. Each one gets it as soon as its session is free; the members that answer send you their final message as a new prompt.`));
          }
          const result = await options.call('question', { agent: options.agent, text: input.question });
          if (!result.ok) return ok(text(result.error ?? 'the question did not go', true));
          const to = result.to === 'the user' ? 'the user, in the Forchetta app' : String(result.to);
          return ok(text(`Your question about request #${result.n} is on its way to ${to}. End your turn now: the answer reaches you as a new request.`));
        } catch (error) {
          return ok(text(`Forchetta does not answer (${error instanceof Error ? error.message : String(error)}): is its app or daemon running?`, true));
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(message.method)}` } };
    }
  };
}

type Answer = { n: number; from: string; status: string; talk?: string; answer?: string; reason?: string };

/** The answers of a wait, as the lead reads them. */
export function answersText(answers: readonly Answer[], open: readonly string[]): string {
  const lines = answers.map((item) => {
    const head = `- ${item.from}, request #${item.n}`;
    if (item.status === 'failed' || item.status === 'cancelled') return `${head}: ${item.status}${item.reason ? ` (${item.reason})` : ''}`;
    if (item.answer) return `${head}:\n${item.answer.trim()}`;
    if (item.talk === 'oneway') return `${head}: finished (it executes only: no answer)`;
    return `${head}: finished (its answer already reached you as a prompt)`;
  });
  return [
    answers.length > 0 ? 'Answers:' : 'No request finished in time.',
    ...lines,
    ...(open.length > 0 ? ['', `Still open, they will reach you as new prompts: ${open.join(', ')}.`] : []),
  ].join('\n');
}

/** wait_for_answers: starts a wait in the daemon, then asks it again until it is over (each ask waits up to 50 s). */
async function waitForAnswers(options: { agent: string; call: Call }, input: Record<string, unknown>): Promise<ReturnType<typeof text>> {
  const started = await options.call('wait', { agent: options.agent, requests: input.requests, minutes: input.minutes });
  if (!started.ok) return text(started.error ?? 'the wait did not start', true);
  const requests = (started.requests as number[] | undefined) ?? [];
  if (requests.length === 0) return text('No request of yours is open: there is nothing to wait for.');
  for (;;) {
    const polled = await options.call('wait-poll', { agent: options.agent, id: started.id });
    if (!polled.ok) return text(polled.error ?? 'the wait ended', true);
    if (polled.done) return text(answersText((polled.answers as Answer[]) ?? [], (polled.open as string[]) ?? []));
  }
}

/** The daemon, read again at each call: after a restart it has another port and token. */
const daemonCall: Call = async (route, body) => {
  const info = JSON.parse(readFileSync(paths.daemonInfo, 'utf8')) as { port: number; token: string };
  const response = await fetch(`http://127.0.0.1:${info.port}/api/crew/${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // A poll of a wait is held by the daemon up to 50 s.
    signal: AbortSignal.timeout(route === 'wait-poll' ? 75_000 : 10_000),
  });
  return (await response.json()) as { ok: boolean; error?: string };
};

async function main(): Promise<void> {
  const handle = createHandler({
    agent: process.env.FORCHETTA_AGENT ?? '',
    tools: (process.env.FORCHETTA_TEAM_TOOLS ?? '').split(',').filter(Boolean) as TeamTool[],
    call: daemonCall,
  });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      continue;
    }
    const reply = await handle(message);
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  }
}

// Run as the server, not when a test imports it.
if (process.argv[1]?.endsWith('team-mcp.js')) void main();
