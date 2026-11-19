import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { CREW_MAX_MEMBERS, CREW_NAME_MAX, MEMBER_NAME_MAX, MODELS, MODES, PATHS_MAX, RELATION_MAX, ROLE_MAX, RULES_MAX, type TeamTool, TEMPLATE_TOOLS } from '../shared/crew.ts';
import { SKILLS, SKILLS_PER_AGENT_MAX } from '../shared/skills.ts';
import { paths } from '../shared/paths.ts';
import { VERSION } from '../shared/version.ts';

// The tools of Forchetta for Claude Code: an MCP server on stdio (JSON-RPC 2.0, one message per line), started by
// Claude Code for the lead of a team and for its members that answer or lead others, with the tools of the team, and for every
// other session Forchetta starts, with the tools of the templates of teams (shared/mcp-config.ts writes the
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
      'Your team in Forchetta: who leads it, its members, who each one reports to, what each one does, whether it answers, and what each one is doing now (free, working, which requests wait for it).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  send_request: {
    name: 'send_request',
    description:
      'Give work to the members of your team that report to you. Each one gets the request as a new prompt "Request #<n> from <you>:" as soon as its session is free: while it works the request waits in its queue, so you never need to wait for a member. A member that answers sends you its final message as a new prompt "Answer from <name> to request #<n>:"; a member that executes only does not. A member that leads others answers when their work is done too. Write the request complete: the member sees only that.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The names of members that report to you, or ["all"] for all of them.' },
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
      'Ask your lead (whoever sent you the request you are working on) a question about it, when you cannot go on without the answer. It gets it as a new prompt "Question from <you> about request #<n>:". Then end your turn: the answer reaches you as a new request.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The question, with what the lead needs to answer it.' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
  review: {
    name: 'review',
    description:
      'Record your verdict on a commit you reviewed: "approve" when it is good, or "changes" with what to fix. An approval covers that commit and those before it on its branch: the lead merges only what you approved, and Forchetta asks the user before a merge of anything else. A commit made after it is not covered: review it too. Your lead and the user see the verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        commit: { type: 'string', description: 'The hash of the commit you reviewed (the last one you checked on the branch).' },
        verdict: { type: 'string', enum: ['approve', 'changes'], description: '"approve", or "changes" when something must be fixed first.' },
        note: { type: 'string', description: 'What you found: for "changes", what to fix, precisely; for "approve", a line on what you checked.' },
      },
      required: ['commit', 'verdict', 'note'],
      additionalProperties: false,
    },
  },
  list_team_templates: {
    name: 'list_team_templates',
    description:
      'The templates of teams of agents in Forchetta: the ones that come with it and the ones the user saved, with lead, members and models. With a name, that template in full, in the shape save_team_template takes: to change it and save it again.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The name of one template, to get it in full; none: all of them, one line each.' } },
      additionalProperties: false,
    },
  },
  save_team_template: {
    name: 'save_team_template',
    description: [
      'Save a team of agents as a template of Forchetta: a lead and its members, each one a Claude Code session with its role, model and permissions. Use it when the user asks to create or set up a team in Forchetta, also from a document that describes the roles and their prompts: read the document, then save one template per team.',
      'A template starts nothing: the user starts the team from the Forchetta app, choosing its folder, and sees the roles and permissions there first. Tell the user so.',
      'Forchetta adds by itself who the lead and the members are and how requests, answers and questions travel between them (the tools send_request, wait_for_answers and ask_lead): the roles say only what each one does. Rules the whole team shares, longer than a role (the conventions of the project, how to commit, what never to do), go in rules: every session of the team gets them in its system prompt, and nothing is written in the folder of the project.',
      'The org chart can have more levels: a member reports to the lead, or to another member (reportsTo), which then leads it, gives it requests and gets its answers; a junior under a senior under the lead. Each one talks only with the one it reports to and with those that report to it: follow the chart of the document. The relation of a member with the one it reports to can have its own prompt (relation): how the two work together, what goes down, what comes back, when to ask; both read it. Put there what the document says about that link (formats of requests and reports, rules), not in the roles.',
      'Forchetta checks the template as its panel does: what is wrong comes back as an error, to fix and save again.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: CREW_NAME_MAX, description: `The name of the template, also the name the team gets; ${CREW_NAME_MAX} characters at most.` },
        lead: {
          type: 'object',
          description: 'The lead: a Claude session that splits the work into requests to the members, or the user, who writes the requests from the app.',
          properties: {
            kind: { type: 'string', enum: ['claude', 'you'], description: '"claude": a lead session; "you": the user leads, from the app, and no lead session starts (name, role, model and mode are then ignored).' },
            ...{
  name: { type: 'string', maxLength: MEMBER_NAME_MAX, description: `Its name, also in the requests and in Claude Code: letters, digits, spaces, ".", "_" and "-", starting with a letter or a digit; ${MEMBER_NAME_MAX} characters at most, each one different.` },
  role: {
    type: 'string',
    maxLength: ROLE_MAX,
    description: `What it does: it goes into its system prompt after "Your role:", and the lead and the other members read it too, so write it in the third person ("Reviews the code…", not "You review…"). ${ROLE_MAX} characters at most.`,
  },
  model: { type: 'string', enum: [...MODELS], description: 'Its model; none: the model of the user.' },
  mode: { type: 'string', enum: [...MODES], description: 'The permission mode of its session; none: the one of the user.' },
  skills: {
    type: 'array',
    items: { type: 'string' },
    maxItems: SKILLS_PER_AGENT_MAX,
    description: `Skills of Claude Code for this agent only, by name; Forchetta fetches them when the team starts, outside the project. ${SKILLS_PER_AGENT_MAX} at most; only what the role needs, or none. The open-source catalog of Forchetta: ${SKILLS.map((skill) => `${skill.id} (${skill.summary.replace(/\.$/, '')})`).join('; ')}. The skills the user added in the studio are allowed too: list_team_templates names them.`,
  },
},
          },
          required: ['kind'],
          additionalProperties: false,
        },
        talk: {
          type: 'string',
          enum: ['twoway', 'oneway'],
          description:
            'How the members talk with the one they report to, unless a member says otherwise: "twoway", the final message of each request goes back and the member can ask questions; "oneway", the member executes only. Default "twoway". Follow the document when it says; otherwise choose for each member (its own talk).',
        },
        worktrees: { type: 'boolean', description: 'Each member in a git worktree of its own (only in a git repository), unless a member says otherwise; the lead merges their branches. Default false: all in the folder of the team.' },
        rules: {
          type: 'string',
          maxLength: RULES_MAX,
          description: `What every agent of the team follows, whatever its role: the conventions, how to commit, what never to do, the shared context of the document. Every session gets them in its system prompt. ${RULES_MAX} characters at most; leave it out when there is nothing shared.`,
        },
        members: {
          type: 'array',
          minItems: 1,
          maxItems: CREW_MAX_MEMBERS,
          description: 'The members, the lead aside: as many as the team needs, on as many levels as it has (reportsTo).',
          items: {
            type: 'object',
            properties: {
              ...{
  name: { type: 'string', maxLength: MEMBER_NAME_MAX, description: `Its name, also in the requests and in Claude Code: letters, digits, spaces, ".", "_" and "-", starting with a letter or a digit; ${MEMBER_NAME_MAX} characters at most, each one different.` },
  role: {
    type: 'string',
    maxLength: ROLE_MAX,
    description: `What it does: it goes into its system prompt after "Your role:", and the lead and the other members read it too, so write it in the third person ("Reviews the code…", not "You review…"). ${ROLE_MAX} characters at most.`,
  },
  model: { type: 'string', enum: [...MODELS], description: 'Its model; none: the model of the user.' },
  mode: { type: 'string', enum: [...MODES], description: 'The permission mode of its session; none: the one of the user.' },
  skills: {
    type: 'array',
    items: { type: 'string' },
    maxItems: SKILLS_PER_AGENT_MAX,
    description: `Skills of Claude Code for this agent only, by name; Forchetta fetches them when the team starts, outside the project. ${SKILLS_PER_AGENT_MAX} at most; only what the role needs, or none. The open-source catalog of Forchetta: ${SKILLS.map((skill) => `${skill.id} (${skill.summary.replace(/\.$/, '')})`).join('; ')}. The skills the user added in the studio are allowed too: list_team_templates names them.`,
  },
},
              talk: {
                type: 'string',
                enum: ['twoway', 'oneway'],
                description:
                  'Its own way of talking with the one it reports to; none: the one of the team. "twoway" when that one needs something back from it: a report, a verdict, facts or an answer to go on with, or when it may need to ask. "oneway" when its work shows in the files and no report is needed (formatting, running a fixed step, writing a text nobody checks): it costs no turn above it, but it cannot ask questions.',
              },
              reportsTo: {
                type: 'string',
                maxLength: MEMBER_NAME_MAX,
                description: 'The name of the member it reports to, which leads it and gives it requests; none: the lead. No circles: each chain goes up to the lead.',
              },
              relation: {
                type: 'string',
                maxLength: RELATION_MAX,
                description: `The prompt of its relation with the one it reports to: how the two work together (what is asked and how, what comes back and in what form, when to ask). Both read it, so write it about the two of them in the third person ("The senior gives…, the junior reports…"). None: just the roles. ${RELATION_MAX} characters at most.`,
              },
              worktree: { type: 'boolean', description: 'Its own choice of a git worktree; none: the one of the team.' },
              paths: {
                type: 'array',
                items: { type: 'string' },
                maxItems: PATHS_MAX,
                description: 'The only files it may change, relative to the folder of the team: folders ("src/ui/"), files, or patterns ("*.test.ts", "docs/**"). Forchetta stops its edits elsewhere, and the edits of the other members there. None: any file no other member has.',
              },
              reviews: { type: 'boolean', description: 'It reviews the commits of the others and records a verdict on each; the lead merges only what it approved.' },
            },
            required: ['name', 'role'],
            additionalProperties: false,
          },
        },
        replace: { type: 'boolean', description: 'Replace a template of the user with the same name. Only when the user asked to change that template; otherwise a name already taken is refused.' },
      },
      required: ['name', 'lead', 'members'],
      additionalProperties: false,
    },
  },
};

/** A route of the daemon (/api/crew/<route>): its JSON answer, also for a refusal. */
export type Call = (route: string, body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** What Claude Code is told of the server, for the tools the session has. */
export function instructionsFor(tools: readonly TeamTool[]): string {
  const team = tools.some((tool) => !TEMPLATE_TOOLS.includes(tool));
  const templates = tools.some((tool) => TEMPLATE_TOOLS.includes(tool));
  return [
    ...(team ? ['The tools of your team of agents in Forchetta.'] : []),
    ...(templates
      ? [
          'Forchetta, the control center of the Claude Code sessions of the user, runs this session. When the user asks to create or set up a team of agents in Forchetta, also from a document or an artifact that describes the roles and their prompts, save it as a template with save_team_template: the user then starts it from the app.',
        ]
      : []),
  ].join(' ');
}
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
          instructions: instructionsFor(tools),
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
          if (name === 'list_team_templates') {
            const result = await options.call('templates', { agent: options.agent, ...(typeof input.name === 'string' ? { name: input.name } : {}) });
            return ok(result.ok ? text(String(result.text)) : text(result.error ?? 'no answer from Forchetta', true));
          }
          if (name === 'save_team_template') {
            const { replace, ...template } = input;
            const result = await options.call('template-save', { agent: options.agent, template, replace: replace === true });
            return ok(result.ok ? text(String(result.text)) : text(`The template was not saved: ${result.error ?? 'no answer from Forchetta'}`, true));
          }
          if (name === 'review') {
            const result = await options.call('review', { agent: options.agent, commit: input.commit, verdict: input.verdict, note: input.note });
            if (!result.ok) return ok(text(result.error ?? 'the verdict was not recorded', true));
            const what = `${String(result.short)}${result.subject ? ` (${String(result.subject)})` : ''}`;
            return ok(
              text(
                result.verdict === 'approved'
                  ? `Recorded: you approved ${what}. The lead can merge its branch up to it.`
                  : `Recorded: you asked for changes on ${what}. Say what to fix in your report too; review the new commit when it comes.`,
              ),
            );
          }
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
  let downSince: number | undefined;
  for (;;) {
    let polled: Awaited<ReturnType<Call>>;
    try {
      polled = await options.call('wait-poll', { agent: options.agent, id: started.id });
      downSince = undefined;
    } catch (error) {
      // The daemon restarts (an update, say): it keeps the wait, and this asks again until it is back.
      downSince ??= now();
      if (now() - downSince > WAIT_RETRY_MS) throw error;
      await sleep(RETRY_EVERY_MS);
      continue;
    }
    if (!polled.ok) return text(polled.error ?? 'the wait ended', true);
    if (polled.done) return text(answersText((polled.answers as Answer[]) ?? [], (polled.open as string[]) ?? []));
  }
}

/** How long a wait asks again for a daemon that does not answer (a restart takes a few seconds), and how often. */
export const WAIT_RETRY_MS = 90_000;
const RETRY_EVERY_MS = 2_000;
let now = (): number => Date.now();
let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** For the tests: a clock and a sleep of their own. */
export function setWaitClock(clock: () => number, wait: (ms: number) => Promise<void>): void {
  now = clock;
  sleep = wait;
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
