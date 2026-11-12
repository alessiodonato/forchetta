import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Agent, Subagent, SubagentStep } from '../shared/agent.ts';
import { clip, toolLabel } from './labels.ts';
import type { HookPayload } from './state.ts';

// The subagents of a session: those it starts with the Agent tool, while they work and after. Claude Code says it
// in three places (seen with 2.1.322):
// - the hooks of the session: the PreToolUse of the Agent call has its input (type, description, task, model,
//   background), its PostToolUse the result ({ status: 'async_launched' | 'completed', agentId, resolvedModel,
//   totalTokens… }); every event of the subagent carries its agent_id and agent_type;
// - next to the transcript of the session, <session>/subagents/agent-<id>.meta.json: written when it starts
//   ({ agentType, description, toolUseId, requestShape: 'foreground' | 'background', model }), with
//   "finished": true added when it stops, taken away when it starts again. The only sign of the end of a subagent
//   in the background, without hooks of their own (SubagentStop) that Forchetta does not install. "finished" also
//   comes when it only stops to wait for work of its own in the background (a command with run_in_background):
//   Claude Code then says it "is waiting on its own background work", and starts it again when that work ends. A
//   subagent ends by sending its report (SubagentHandback): one that stops after starting work in the background,
//   and without a report, is waiting, not done;
// - agent-<id>.jsonl beside it: its transcript, read for its panel.

export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** How many subagents a session keeps: the finished ones go first. */
export const SUBAGENTS_KEPT = 20;
const PROMPT_MAX = 1500;
/** A subagent in the foreground still at work this long after the turn of its session ended: it was stopped. */
export const FOREGROUND_ORPHAN_MS = 60_000;

/** What Forchetta keeps of the result of an Agent call (server.ts takes it from the hook input). */
export interface SubagentResult {
  status?: string;
  agentId?: string;
  model?: string;
  tokens?: number;
  async?: boolean;
}

/** The meta.json of a subagent: what Forchetta reads of it. */
export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  background?: boolean;
  model?: string;
  finished?: boolean;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const fieldsOf = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {});

/** The result of an Agent call, from the tool response of its PostToolUse: undefined for any other tool. */
export function subagentResultOf(tool: unknown, response: unknown): SubagentResult | undefined {
  if (typeof tool !== 'string' || !SUBAGENT_TOOLS.has(tool)) return undefined;
  const fields = fieldsOf(response);
  const result: SubagentResult = {
    status: text(fields.status),
    agentId: text(fields.agentId),
    model: text(fields.resolvedModel),
    tokens: typeof fields.totalTokens === 'number' && Number.isFinite(fields.totalTokens) ? fields.totalTokens : undefined,
    async: fields.isAsync === true || fields.status === 'async_launched' ? true : undefined,
  };
  for (const key of Object.keys(result) as (keyof SubagentResult)[]) if (result[key] === undefined) delete result[key];
  return result;
}

/**
 * The transcript of a subagent: <session>/subagents/agent-<id>.jsonl, next to the transcript of the session
 * (<session>.jsonl). From the transcript of a subagent too, in case an event names that one.
 */
export function subagentFile(transcriptPath: string | undefined, id: string): string | undefined {
  if (!transcriptPath || !/^[\w-]+$/.test(id)) return undefined;
  const nested = /^(.*\/subagents)\/[^/]+\.jsonl$/.exec(transcriptPath);
  if (nested) return `${nested[1]}/agent-${id}.jsonl`;
  if (!transcriptPath.endsWith('.jsonl')) return undefined;
  return `${transcriptPath.slice(0, -'.jsonl'.length)}/subagents/agent-${id}.jsonl`;
}

export const metaFileOf = (transcript: string): string => transcript.replace(/\.jsonl$/, '.meta.json');

/** Reads the meta.json of a subagent; undefined when it is not there (yet) or not readable. */
export function readSubagentMeta(transcript: string): SubagentMeta | undefined {
  const file = metaFileOf(transcript);
  try {
    const fields = fieldsOf(JSON.parse(readFileSync(file, 'utf8')));
    const shape = text(fields.requestShape);
    return {
      agentType: text(fields.agentType),
      description: text(fields.description),
      toolUseId: text(fields.toolUseId),
      background: shape === undefined ? undefined : shape === 'background',
      model: text(fields.model),
      finished: fields.finished === true,
    };
  } catch {
    return undefined;
  }
}

/** The task of a subagent as the box keeps it: whole lines, cut at PROMPT_MAX. */
function promptText(value: unknown): string | undefined {
  const prompt = text(value);
  if (!prompt) return undefined;
  return prompt.length <= PROMPT_MAX ? prompt : `${prompt.slice(0, PROMPT_MAX - 1).trimEnd()}…`;
}

function add(agent: Agent, subagent: Subagent): void {
  const list = [...(agent.subagents ?? []), subagent];
  // The oldest finished ones go first; those at work or waiting stay, however many.
  while (list.length > SUBAGENTS_KEPT) {
    const index = list.findIndex((candidate) => candidate.state !== 'running' && candidate.state !== 'waiting');
    if (index < 0) break;
    list.splice(index, 1);
  }
  agent.subagents = list;
}

function finish(subagent: Subagent, state: Subagent['state'], now: number): void {
  subagent.state = state;
  subagent.endedAt = now;
}

/** A subagent that stopped: done, or only waiting for work of its own in the background. */
function settle(subagent: Subagent, now: number): void {
  if (subagent.backgroundWork && !subagent.reported) subagent.state = 'waiting';
  else finish(subagent, 'done', now);
}

/** A call that leaves work going in the background: a command, a subagent, a monitor. */
const startsBackgroundWork = (tool: string, input: unknown): boolean => tool === 'Monitor' || fieldsOf(input).run_in_background === true;

/**
 * The subagent an event with this agent_id comes from. The first time, it is linked to the Agent call that started
 * it: by its meta.json (toolUseId), else to the oldest call of the same type not linked yet. One that Forchetta did
 * not see start (the daemon started after it) is added from its meta.json.
 */
function subagentOf(agent: Agent, payload: HookPayload, now: number, readMeta: (transcript: string) => SubagentMeta | undefined): { subagent: Subagent; linked: boolean } | undefined {
  const id = payload.agent_id;
  if (!id) return undefined;
  const known = agent.subagents?.find((candidate) => candidate.id === id);
  if (known) return { subagent: known, linked: false };
  const transcript = subagentFile(payload.transcript_path ?? agent.transcriptPath, id) ?? subagentFile(agent.transcriptPath, id);
  const meta = transcript ? readMeta(transcript) : undefined;
  const unlinked = (agent.subagents ?? []).filter((candidate) => candidate.id === undefined && candidate.state === 'running');
  let subagent =
    (meta?.toolUseId ? unlinked.find((candidate) => candidate.toolUseId === meta.toolUseId) : undefined) ??
    unlinked.find((candidate) => candidate.type === (payload.agent_type ?? meta?.agentType));
  if (!subagent) {
    subagent = {
      type: payload.agent_type ?? meta?.agentType ?? 'subagent',
      description: meta?.description,
      model: meta?.model,
      background: meta?.background,
      toolUseId: meta?.toolUseId,
      state: 'running',
      startedAt: now,
    };
    add(agent, subagent);
  }
  subagent.id = id;
  if (transcript) subagent.transcript = transcript;
  if (subagent.background === undefined && meta?.background !== undefined) subagent.background = meta.background;
  return { subagent, linked: true };
}

/** What a hook event says of the subagents of its session. True when something changed. */
export function applySubagentHook(agent: Agent, payload: HookPayload, now: number, readMeta: (transcript: string) => SubagentMeta | undefined = readSubagentMeta): boolean {
  const event = payload.hook_event_name;
  const tool = payload.tool_name;
  let changed = false;

  // A call of the Agent tool, by the session or by one of its subagents: a subagent starts.
  if (event === 'PreToolUse' && tool && SUBAGENT_TOOLS.has(tool)) {
    const input = fieldsOf(payload.tool_input);
    const repeated = payload.tool_use_id !== undefined && agent.subagents?.some((candidate) => candidate.toolUseId === payload.tool_use_id);
    if (!repeated) {
      const subagent: Subagent = {
        type: text(input.subagent_type) ?? 'general-purpose',
        description: text(input.description),
        prompt: promptText(input.prompt),
        model: text(input.model),
        background: input.run_in_background === true ? true : undefined,
        isolation: text(input.isolation),
        by: payload.agent_id ? (payload.agent_type ?? 'subagent') : undefined,
        toolUseId: payload.tool_use_id,
        state: 'running',
        startedAt: now,
      };
      for (const key of Object.keys(subagent) as (keyof Subagent)[]) if (subagent[key] === undefined) delete subagent[key];
      add(agent, subagent);
      changed = true;
    }
  }

  // The end of the call: the result of a subagent in the foreground, or the start of one in the background.
  if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && tool && SUBAGENT_TOOLS.has(tool)) {
    const result = payload.subagent_result;
    const list = agent.subagents ?? [];
    const subagent =
      (payload.tool_use_id ? list.find((candidate) => candidate.toolUseId === payload.tool_use_id) : undefined) ??
      (result?.agentId ? list.find((candidate) => candidate.id === result.agentId) : undefined);
    if (subagent) {
      if (result?.agentId && !subagent.id) {
        subagent.id = result.agentId;
        const transcript = subagentFile(agent.transcriptPath, result.agentId);
        if (transcript) subagent.transcript = transcript;
      }
      if (result?.model) subagent.model = result.model;
      if (event === 'PostToolUseFailure') {
        finish(subagent, 'failed', now);
        const error = typeof payload.error === 'string' ? payload.error : undefined;
        if (error) subagent.error = clip(error, 200);
      } else if (result?.async) {
        subagent.background = true;
      } else {
        // Its result came back with the call: it ran in the foreground, and it is done.
        subagent.background = false;
        if (subagent.state === 'running' || subagent.state === 'waiting') finish(subagent, 'done', now);
        if (result?.tokens !== undefined) subagent.tokens = result.tokens;
      }
      changed = true;
    }
  }

  // An event of the subagent itself: what it does now.
  if (payload.agent_id) {
    const found = subagentOf(agent, payload, now, readMeta);
    if (found) {
      const { subagent } = found;
      if (found.linked) changed = true;
      if (event === 'SubagentStop' && subagent.state === 'running') {
        settle(subagent, now);
        changed = true;
      } else if (event === 'PreToolUse' && tool) {
        // A new call of a subagent that stopped: its work in the background ended, or a message of the session
        // started it again (SendMessage), a new task. Only a new call: the hooks go in the background, and the
        // PostToolUse of its last call can come after it stopped.
        if (subagent.state !== 'running') {
          if (subagent.state !== 'waiting') subagent.backgroundWork = undefined;
          subagent.state = 'running';
          subagent.endedAt = undefined;
        }
        subagent.reported = tool === 'SubagentHandback' ? true : undefined;
        if (startsBackgroundWork(tool, payload.tool_input)) subagent.backgroundWork = true;
        const { label, family } = toolLabel(tool, payload.tool_input, agent.cwd);
        subagent.action = { label, family, at: now };
        subagent.tools = (subagent.tools ?? 0) + 1;
        changed = true;
      }
    }
  }

  // The turn of the session ended: a call in the foreground that never got a subagent did not start one.
  if (event === 'Stop' && !payload.agent_id) {
    for (const subagent of agent.subagents ?? []) {
      if (subagent.state === 'running' && !subagent.background && subagent.id === undefined) {
        finish(subagent, 'stopped', now);
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Subagents at work, checked against their meta.json: "finished" ends them. One in the foreground whose session has
 * not been at work for a while was stopped with it (an interrupt sends no hook). True when something changed.
 */
export function checkSubagents(agent: Agent, now: number, readMeta: (transcript: string) => SubagentMeta | undefined = readSubagentMeta): boolean {
  let changed = false;
  const sessionQuiet = agent.state !== 'working' && agent.state !== 'waiting' && agent.state !== 'compacting' && now - agent.lastEvent.at > FOREGROUND_ORPHAN_MS;
  for (const subagent of agent.subagents ?? []) {
    if (subagent.state !== 'running' && subagent.state !== 'waiting') continue;
    const meta = subagent.transcript ? readMeta(subagent.transcript) : undefined;
    if (subagent.state === 'waiting') {
      // Started again with no call seen yet: Claude Code took "finished" away.
      if (meta && !meta.finished) {
        subagent.state = 'running';
        changed = true;
      }
      continue;
    }
    // Claude Code takes "finished" away when the subagent starts again, and writes it back when it stops.
    if (meta?.finished) {
      settle(subagent, now);
      changed = true;
    } else if (!subagent.background && sessionQuiet && now - Math.max(subagent.startedAt, subagent.action?.at ?? 0) > FOREGROUND_ORPHAN_MS) {
      finish(subagent, 'stopped', now);
      changed = true;
    }
  }
  return changed;
}

/**
 * A new conversation in the same process (/clear, /resume): the subagents that ended belonged to the old one and
 * go; those still at work or waiting stay until they end. True when some went.
 */
export function forgetEndedSubagents(agent: Agent): boolean {
  const list = agent.subagents;
  if (!list) return false;
  const kept = list.filter((subagent) => subagent.state === 'running' || subagent.state === 'waiting');
  if (kept.length === list.length) return false;
  agent.subagents = kept.length > 0 ? kept : undefined;
  return true;
}

/** Whether any subagent of these sessions is at work, or waits: only then are their meta.json read. */
export const anySubagentActive = (agents: Iterable<Agent>): boolean => {
  for (const agent of agents) if (agent.subagents?.some((subagent) => subagent.state === 'running' || subagent.state === 'waiting')) return true;
  return false;
};

// The transcript of a subagent, for its panel. Claude Code writes each block of a message on a line of its own:
// { type: 'user', message: { content: '<the task>' } } first, then assistant lines (text, tool_use, thinking) and
// user lines with the tool results (tool_result, with tool_use_id). Lines of other types (attachment,
// api-request…) and the reminders of Claude Code (<system-reminder>) are not part of the work.

const STEP_TEXT_MAX = 6000;
const RESULT_MAX = 300;
export const STEPS_MAX = 400;

type Entry = { type?: unknown; timestamp?: unknown; message?: { model?: unknown; content?: unknown } };
type Part = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };

const longText = (value: string): string => (value.length <= STEP_TEXT_MAX ? value : `${value.slice(0, STEP_TEXT_MAX - 1).trimEnd()}…`);
const isReminder = (value: string): boolean => value.trimStart().startsWith('<system-reminder>');

/** A notice of Claude Code about work in the background (<task-notification>): its summary, or its status. */
function noticeOf(value: string): string | undefined {
  if (!value.includes('<task-notification>')) return undefined;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(value)?.[1]?.trim();
  const status = /<status>([\s\S]*?)<\/status>/.exec(value)?.[1]?.trim();
  return summary || (status ? `Work in the background: ${status}` : 'Work in the background ended');
}

/** A message the session sent to the subagent, without the words Claude Code puts around it. */
const messageText = (value: string): string =>
  value
    .replace(/^\s*The coordinator sent a message while you were working:\s*/, '')
    .replace(/\s*Address this before completing your current task\.\s*$/, '')
    .trim();

/** The text of a tool result: a string, or the text parts of a list. */
function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = (content as Part[]).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text as string);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export interface SubagentThread {
  steps: SubagentStep[];
  /** The model of its answers, from the transcript. */
  model?: string;
  /** Steps left out at the start, past STEPS_MAX. */
  skipped?: number;
}

/** The steps of a subagent, in order, from its transcript. */
export async function readSubagentThread(file: string, cwd?: string): Promise<SubagentThread> {
  const steps: SubagentStep[] = [];
  const tools = new Map<string, Extract<SubagentStep, { kind: 'tool' }>>();
  let model: string | undefined;
  let prompted = false;
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const parsedAt = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    const at = Number.isFinite(parsedAt) ? parsedAt : undefined;
    const content = entry.message?.content;
    if (entry.type === 'user') {
      const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? (content as Part[]).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text as string) : [];
      for (const value of texts) {
        if (!value.trim() || isReminder(value)) continue;
        const notice = noticeOf(value);
        if (notice) {
          steps.push({ kind: 'notice', text: clip(notice, 200), at });
          continue;
        }
        steps.push({ kind: prompted ? 'message' : 'prompt', text: longText(prompted ? messageText(value) : value.trim()), at });
        prompted = true;
      }
      if (Array.isArray(content)) {
        for (const part of content as Part[]) {
          if (part.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
          const step = tools.get(part.tool_use_id);
          if (!step) continue;
          const result = resultText(part.content);
          if (result?.trim()) step.result = clip(result, RESULT_MAX);
          if (part.is_error === true) step.error = true;
        }
      }
      continue;
    }
    if (typeof entry.message?.model === 'string' && !entry.message.model.startsWith('<')) model = entry.message.model;
    if (!Array.isArray(content)) continue;
    for (const part of content as Part[]) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        steps.push({ kind: 'text', text: longText(part.text.trim()), at });
      } else if (part.type === 'tool_use' && typeof part.name === 'string') {
        const message = text(fieldsOf(part.input).message);
        if (part.name === 'SubagentHandback' && message) {
          steps.push({ kind: 'report', text: longText(message), at });
          continue;
        }
        const { label, family } = toolLabel(part.name, part.input, cwd);
        const step: Extract<SubagentStep, { kind: 'tool' }> = { kind: 'tool', label, family, at };
        if (typeof part.id === 'string') tools.set(part.id, step);
        steps.push(step);
      }
    }
  }
  const skipped = Math.max(0, steps.length - STEPS_MAX);
  // The task stays: it says what the rest is about.
  const kept = skipped > 0 ? [...steps.slice(0, 1).filter((step) => step.kind === 'prompt'), ...steps.slice(-STEPS_MAX)] : steps;
  return { steps: kept, model, ...(skipped > 0 ? { skipped } : {}) };
}
