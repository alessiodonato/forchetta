import { statSync } from 'node:fs';
import { type Crew, type CrewSpec, type CrewTemplate, type ReviewRecord, cleanBudget, cleanCrewSpec, fillParams, leadName, templateOf, threadOf } from '../shared/crew.ts';
import type { Agent, AgentState, TokenUsage } from '../shared/agent.ts';
import { activity, sumTokens, tokensTotal } from '../shared/present.ts';
import { type Automation, type AutomationView, triggerText } from '../shared/automation.ts';
import { type LostSession, lostName } from '../shared/reopen.ts';
import { teamChecks } from '../shared/team-checks.ts';
import { teamFileName, teamFileOf } from '../shared/team-file.ts';
import type { CreateResult, Result } from './crews.ts';
import type { SkillToFetch } from './team-files.ts';

// The routes of `forchetta team`, on /api/ with the token: the teams that run, a team started from a template or
// from a team file (of .forchetta/teams in a repository, or anywhere), the file of a template, the thread of a team.

const OPEN = new Set(['queued', 'blocked', 'sent', 'working', 'delegated']);

export interface TeamMemberLine {
  name: string;
  lead?: boolean;
  agentId?: string;
  state?: AgentState;
  activity?: string;
  usd?: number;
  tokens?: number;
}

export interface TeamLine {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  /** The name of the Claude lead, or "you". */
  lead: string;
  members: TeamMemberLine[];
  requests: { total: number; open: number; done: number; failed: number };
  /** What its sessions cost, at API prices, as their status lines said. */
  usd: number;
  tokens: number;
  budgetUsd?: number;
}

export interface CliApiDeps {
  crews: {
    list(): Crew[];
    get(id: string): Crew | undefined;
    create(spec: CrewSpec): Promise<CreateResult>;
    request(crewId: string, to: readonly string[], text: string): Result<{ n: number; to: string[] }>;
    reviewsOf(crewId: string): ReviewRecord[];
  };
  templates: { list(): CrewTemplate[] };
  agent: (id: string) => Agent | undefined;
  importTeam: (text: string, choice: 'ask' | 'fetch' | 'skip') => Promise<{ ok: true; template: CrewTemplate; notes: string[] } | { ok: true; ask: SkillToFetch[] } | { ok: false; error: string }>;
  /** The folder as a team keeps it (~ resolved), or undefined when it is not one. */
  folderOf: (path: string) => string | undefined;
  /** The spec with the rules of .forchetta/rules.md of its repository. */
  withRepoRules: <T extends { cwd: string; rules?: string }>(spec: T) => T;
  log: (message: string) => void;
  /** The installation, for `forchetta doctor`. */
  system?: () => unknown;
  /** The sessions that ended with the Mac, for `forchetta reopen`. */
  reopen?: {
    list(): LostSession[];
    reopen(agentIds: readonly string[]): Promise<{ reopened: { agentId: string; newAgentId: string; name: string }[]; failed: { agentId: string; name: string; error: string }[] }>;
  };
  /** The teams that start by themselves, for `forchetta auto`. */
  automations?: {
    views(): AutomationView[];
    find(key: string): Automation | undefined;
    act(id: string, action: 'add' | 'pause' | 'resume', arg?: { text?: string }): { ok: true; added?: number } | { ok: false; error: string };
  };
}

/** The line of `forchetta auto ls` for an automation. */
export interface AutoLine {
  id: string;
  name: string;
  template: string;
  cwd: string;
  starts: string;
  kind: 'queue' | 'schedule' | 'github';
  paused?: string;
  wait?: string;
  nextAt?: number;
  running?: { label: string; team?: string; startedAt?: number; usd?: number };
  waiting: number;
  last?: { label: string; status: string; note?: string; usd?: number; endedAt?: number; where?: string };
  github?: { repo?: string; error?: string; at: number };
}

export function autoLine(view: AutomationView): AutoLine {
  const running = view.items.find((item) => item.status === 'running');
  const last = view.items.filter((item) => item.status !== 'waiting' && item.status !== 'running').at(-1);
  return {
    id: view.id,
    name: view.name,
    template: view.template,
    cwd: view.cwd,
    starts: triggerText(view.trigger),
    kind: view.trigger.kind,
    ...(view.paused ? { paused: view.paused.reason } : {}),
    ...(view.wait ? { wait: view.wait } : {}),
    ...(view.nextAt ? { nextAt: view.nextAt } : {}),
    ...(running ? { running: { label: running.label, ...(running.crewName ? { team: running.crewName } : {}), ...(running.startedAt ? { startedAt: running.startedAt } : {}), ...(view.usd !== undefined ? { usd: view.usd } : {}) } } : {}),
    waiting: view.items.filter((item) => item.status === 'waiting').length,
    ...(last
      ? {
          last: {
            label: last.label,
            status: last.status,
            ...(last.note ? { note: last.note } : {}),
            ...(last.usd !== undefined ? { usd: last.usd } : {}),
            ...(last.endedAt ? { endedAt: last.endedAt } : {}),
            ...(last.delivered?.where ? { where: last.delivered.where } : {}),
          },
        }
      : {}),
    ...(view.poll ? { github: view.poll } : {}),
  };
}

type Answer = { status: number; body: unknown };

export const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const ok = (body: object): Answer => ({ status: 200, body: { ok: true, ...body } });
const fail = (error: string, status = 400): Answer => ({ status, body: { ok: false, error } });

/** A team by its id, or by its name (any case). */
export function findCrew(crews: readonly Crew[], key: string): Crew | undefined {
  const wanted = key.trim().toLowerCase();
  return crews.find((crew) => crew.id === key) ?? crews.find((crew) => crew.name.toLowerCase() === wanted);
}

/** The line of `forchetta team ls` for a team. */
export function teamLine(crew: Crew, agent: (id: string) => Agent | undefined): TeamLine {
  const member = (name: string, agentId: string | undefined, lead = false): TeamMemberLine => {
    const session = agentId ? agent(agentId) : undefined;
    return {
      name,
      ...(lead ? { lead: true } : {}),
      ...(agentId ? { agentId } : {}),
      ...(session ? { state: session.state, activity: activity(session) } : {}),
      ...(session?.usage ? { usd: session.usage.usd } : {}),
      ...(session?.tokens ? { tokens: tokensTotal(session.tokens) } : {}),
    };
  };
  const members = [...(crew.lead.kind === 'claude' ? [member(crew.lead.name, crew.agents.lead, true)] : []), ...crew.members.map((one) => member(one.name, crew.agents[one.name]))];
  const deliveries = (crew.requests ?? []).flatMap((request) => request.deliveries);
  const tokens: TokenUsage[] = members.flatMap((one) => {
    const session = one.agentId ? agent(one.agentId) : undefined;
    return session?.tokens ? [session.tokens] : [];
  });
  return {
    id: crew.id,
    name: crew.name,
    cwd: crew.cwd,
    createdAt: crew.createdAt,
    lead: crew.lead.kind === 'claude' ? crew.lead.name : 'you',
    members,
    requests: {
      total: (crew.requests ?? []).length,
      open: deliveries.filter((delivery) => OPEN.has(delivery.status)).length,
      done: deliveries.filter((delivery) => delivery.status === 'done').length,
      failed: deliveries.filter((delivery) => delivery.status === 'failed').length,
    },
    usd: members.reduce((sum, one) => sum + (one.usd ?? 0), 0),
    tokens: tokens.length > 0 ? tokensTotal(sumTokens(tokens)) : 0,
    ...(crew.budgetUsd ? { budgetUsd: crew.budgetUsd } : {}),
  };
}

/** The thread of a team as Markdown: each request, question, answer and verdict, in order. */
export function threadMarkdown(crew: Crew, reviews: readonly ReviewRecord[]): string {
  const time = (at: number): string => new Date(at).toISOString().replace('T', ' ').slice(0, 16);
  const quote = (text: string): string =>
    text
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
      .join('\n');
  const lines = [`# ${crew.name}`, '', `Folder: ${crew.cwd}  `, `Lead: ${leadName(crew)}  `, `Started: ${time(crew.createdAt)}`, ''];
  if (crew.deliverable) lines.push(`Delivers: ${fillParams(crew.deliverable, crew.values)}  `, '');
  if (crew.values) lines.push(`Values: ${Object.entries(crew.values).map(([name, value]) => `${name} = ${value}`).join(', ')}`, '');
  for (const entry of threadOf(crew.requests ?? [], reviews, crew.delivered ?? [])) {
    if (entry.kind === 'request') {
      const to = entry.deliveries.map((delivery) => `${delivery.to} (${delivery.status})`).join(', ');
      lines.push(`## #${entry.n} · ${entry.from} → ${to}${entry.parent !== undefined ? ` · from #${entry.parent}` : ''}`, `*${time(entry.at)}*`, '', quote(entry.text), '');
    } else if (entry.kind === 'question') {
      lines.push(`**Question from ${entry.from} to ${entry.to}** (#${entry.n}, ${time(entry.at)})`, '', quote(entry.text), '');
    } else if (entry.kind === 'answer') {
      lines.push(`**Answer from ${entry.from} to ${entry.to}** (#${entry.n}, ${time(entry.at)})`, '', entry.text ? quote(entry.text) : '> (no text)', '');
    } else if (entry.kind === 'approval') {
      lines.push(`**${entry.decision === 'approved' ? `You approved #${entry.n} for ${entry.to}${entry.edited ? ', changed' : ''}` : `You sent back #${entry.n} to ${entry.to}`}** (${time(entry.at)})`, '', ...(entry.text ? [quote(entry.text), ''] : []));
    } else if (entry.kind === 'delivered') {
      lines.push(`**Delivered by ${entry.from}**${entry.where ? `: ${entry.where}` : ''} (${time(entry.at)})`, '', quote(entry.text), '');
    } else {
      lines.push(`**Review by ${entry.from}**: ${entry.verdict === 'approved' ? 'approved' : 'changes asked'} ${entry.short}${entry.subject ? ` (${entry.subject})` : ''} · ${time(entry.at)}`, '', ...(entry.text ? [quote(entry.text), ''] : []));
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The routes of `forchetta team`; undefined for a route that is not one of them. */
export function cliApi(deps: CliApiDeps): (method: string, path: string, query: URLSearchParams, input: Record<string, unknown>) => Promise<Answer | undefined> {
  return async (method, path, query, input) => {
    if (method === 'GET' && path === '/api/system' && deps.system) return ok({ system: deps.system() });
    // The runs of automations that ended are not teams at work any more: their threads stay (team thread).
    if (method === 'GET' && path === '/api/teams') return ok({ teams: deps.crews.list().filter((crew) => !crew.endedAt).map((crew) => teamLine(crew, deps.agent)) });

    if (path === '/api/reopen' && deps.reopen) {
      const sessions = deps.reopen.list();
      if (method === 'GET') return ok({ sessions });
      if (method !== 'POST') return undefined;
      // All of them, or those named: a name of the window, a folder, or a team (all its sessions).
      const names = Array.isArray(input.names) ? input.names.filter((name): name is string => typeof name === 'string').map((name) => name.trim().toLowerCase()) : [];
      const wanted = input.all === true ? sessions : sessions.filter((one) => names.some((name) => [lostName(one), one.project, one.team?.group ?? ''].some((key) => key.toLowerCase() === name)));
      if (wanted.length === 0) return fail(sessions.length === 0 ? 'no session ended with the Mac is waiting to reopen' : 'no session to reopen is called so: see `forchetta reopen`', 404);
      return ok(await deps.reopen.reopen(wanted.map((one) => one.agentId)));
    }

    if (path === '/api/auto' || path.startsWith('/api/auto/')) {
      const automations = deps.automations;
      if (!automations) return fail('this daemon has no automations', 404);
      if (method === 'GET' && path === '/api/auto') return ok({ automations: automations.views().map(autoLine) });
      const action = path.slice('/api/auto/'.length);
      if (method !== 'POST' || (action !== 'add' && action !== 'pause' && action !== 'resume')) return undefined;
      const auto = automations.find(typeof input.name === 'string' ? input.name : '');
      if (!auto) return fail('no automation is called so: see `forchetta auto ls`', 404);
      const items = Array.isArray(input.items) ? input.items.filter((item): item is string => typeof item === 'string') : [];
      const result = automations.act(auto.id, action, action === 'add' ? { text: items.join('\n') } : undefined);
      if (!result.ok) return fail(result.error);
      return ok({ name: auto.name, kind: auto.trigger.kind, ...(result.added !== undefined ? { added: result.added } : {}) });
    }

    if (method === 'GET' && path === '/api/teams/thread') {
      const crew = findCrew(deps.crews.list(), query.get('team') ?? '');
      if (!crew) return fail('no team is called so: see `forchetta team ls`', 404);
      const reviews = deps.crews.reviewsOf(crew.id);
      return ok({ team: crew.name, requests: crew.requests ?? [], reviews, markdown: threadMarkdown(crew, reviews) });
    }

    if (method === 'GET' && path === '/api/templates') {
      return ok({ templates: deps.templates.list().map((template) => ({ name: template.name, members: template.members.length, lead: template.lead.kind === 'claude' ? template.lead.name : 'you', ...(template.builtin ? { builtin: true } : {}), ...(template.modified ? { modified: true } : {}) })) });
    }

    if (method === 'GET' && path === '/api/templates/file') {
      // A template by name, or a team that runs (its roles and rules as they are now).
      const key = (query.get('name') ?? '').trim().toLowerCase();
      const template = deps.templates.list().find((one) => one.name.toLowerCase() === key);
      const crew = template ? undefined : findCrew(deps.crews.list(), key);
      const found = template ?? (crew ? templateOf(crew) : undefined);
      if (!found) return fail('no template and no team is called so: see `forchetta team ls --templates`', 404);
      return ok({ name: found.name, fileName: teamFileName(found.name), text: `${JSON.stringify(teamFileOf(found), null, 2)}\n` });
    }

    if (method === 'POST' && path === '/api/teams/start') {
      const cwd = typeof input.cwd === 'string' ? deps.folderOf(input.cwd) : undefined;
      if (!cwd || !isFolder(cwd)) return fail(`the folder ${typeof input.cwd === 'string' ? input.cwd : ''} does not exist`.replace('  ', ' '));
      let template: CrewTemplate | undefined;
      let notes: string[] = [];
      if (typeof input.text === 'string') {
        const choice = input.skills === 'fetch' || input.skills === 'skip' ? input.skills : 'ask';
        const opened = await deps.importTeam(input.text, choice);
        if (!opened.ok) return fail(opened.error);
        if ('ask' in opened) return ok({ ask: opened.ask });
        template = opened.template;
        notes = opened.notes;
      } else if (typeof input.template === 'string') {
        const key = input.template.trim().toLowerCase();
        template = deps.templates.list().find((one) => one.name.toLowerCase() === key);
        if (!template) return fail(`no template is called "${input.template}": see \`forchetta team ls --templates\``, 404);
      } else return fail('say which team: a template or a team file');
      const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : template.name;
      const budget = input.budgetUsd === undefined ? template.budgetUsd : cleanBudget(input.budgetUsd);
      if (input.budgetUsd !== undefined && budget === undefined) return fail('the budget is a number of dollars, like 20 or 12.50');
      // The values of its parameters ({ticket}), from --set: the daemon says which are missing.
      const values = input.values && typeof input.values === 'object' && !Array.isArray(input.values) ? input.values : undefined;
      const checked = cleanCrewSpec({ ...template, name, cwd, ...(budget ? { budgetUsd: budget } : {}), ...(values ? { values } : {}) });
      if ('error' in checked) return fail(checked.error);
      const created = await deps.crews.create(deps.withRepoRules(checked.spec));
      if (!created.ok || !created.crewId) return fail(created.error ?? 'the team did not start');
      let goal: { n: number; to: string[] } | undefined;
      let goalError: string | undefined;
      const text = typeof input.goal === 'string' ? input.goal.trim() : '';
      if (text) {
        // The goal goes to the lead; when you lead, to every member.
        const crew = deps.crews.get(created.crewId);
        const sent = deps.crews.request(created.crewId, crew?.lead.kind === 'claude' ? [crew.lead.name] : [], text);
        if (sent.ok) goal = { n: sent.n, to: sent.to };
        else goalError = sent.error;
      }
      deps.log(`team "${name}" started from the command line in ${cwd}${goal ? ` with its goal (#${goal.n})` : ''}`);
      // What does not hold together in it (shared/team-checks.ts): it started anyway.
      const checks = teamChecks(checked.spec).map((check) => check.text);
      return ok({
        crewId: created.crewId,
        name,
        agentIds: created.agentIds ?? [],
        notes,
        ...(created.error ? { warning: created.error } : {}),
        ...(checks.length > 0 ? { checks } : {}),
        ...(goal ? { goal } : {}),
        ...(goalError ? { goalError } : {}),
      });
    }
    return undefined;
  };
}
