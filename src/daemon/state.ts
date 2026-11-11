import { type Agent, type AgentState, projectOf } from '../shared/agent.ts';
import { activeTask, clip, firstQuestion, opening, toolLabel } from './labels.ts';

// The state of one Claude Code process, and how each hook event changes it. Pure functions: the registry
// finds the agent an event belongs to, these decide what the event means.

export type { Action, Agent, AgentState, Control, Waiting } from '../shared/agent.ts';
export { projectOf, STATE_LABEL } from '../shared/agent.ts';

const RECENT_ACTIONS = 8;

/** The fields of the hook input that Forchetta reads. Everything else is left out on arrival. */
export interface HookPayload {
  hook_event_name: string;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  reason?: string;
  model?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  notification_type?: string;
  message?: string;
  last_assistant_message?: string;
  error?: unknown;
  error_details?: unknown;
  trigger?: string;
  agent_id?: string;
  agent_type?: string;
  /** PermissionRequest: the "always" choices of its dialog. */
  permission_suggestions?: unknown;
  /** PostToolUse of a write tool only: the patch Claude Code reports (daemon/patches.ts). */
  tool_response?: unknown;
}

export function newAgent(init: Partial<Agent> & Pick<Agent, 'id' | 'control'>, now: number): Agent {
  return {
    pastSessionIds: [],
    project: projectOf(init.cwd),
    state: 'starting',
    lastEvent: { name: 'creata', at: now },
    createdAt: now,
    ...init,
  };
}

/** One tool call, by tool and input: a PermissionRequest and the PostToolUse of the same call have the same key. */
export const keyOf = (tool: string | undefined, input: unknown): string => `${tool ?? ''}\u0000${JSON.stringify(input ?? null)}`;

function startWork(agent: Agent): void {
  agent.state = 'working';
  agent.waiting = undefined;
  agent.error = undefined;
  agent.completedAt = undefined;
}

function leaveCompaction(agent: Agent): void {
  agent.state = agent.beforeCompact === 'working' ? 'working' : 'idle';
  agent.beforeCompact = undefined;
  agent.compactTrigger = undefined;
}

export function markEnded(agent: Agent, reason: string, now: number): void {
  agent.state = 'ended';
  agent.endedAt = now;
  agent.endReason = reason;
  agent.waiting = undefined;
  agent.action = undefined;
  agent.pendingSwitchAt = undefined;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
    return JSON.stringify(value);
  }
  return undefined;
}

/** Applies one hook event to its agent. */
export function applyHook(agent: Agent, payload: HookPayload, now: number): void {
  const event = payload.hook_event_name;
  agent.lastEvent = { name: event, at: now };
  if (payload.transcript_path) agent.transcriptPath = payload.transcript_path;
  if (payload.cwd && !agent.cwd) {
    agent.cwd = payload.cwd;
    agent.project = projectOf(payload.cwd);
  }
  if (agent.state === 'ended') return;
  const fromSubagent = typeof payload.agent_id === 'string' && payload.agent_id !== '';

  switch (event) {
    case 'SessionStart': {
      const switched = agent.sessionId !== undefined && payload.session_id !== agent.sessionId;
      if (payload.session_id && payload.session_id !== agent.sessionId) {
        if (agent.sessionId) agent.pastSessionIds.push(agent.sessionId);
        agent.sessionId = payload.session_id;
      }
      if (payload.model) agent.model = payload.model;
      agent.pendingSwitchAt = undefined;
      if (payload.source === 'compact') {
        if (agent.state === 'compacting') leaveCompaction(agent);
      } else if ((payload.source === 'clear' || payload.source === 'resume') && switched) {
        // /clear or /resume inside the same process: a fresh conversation in the same box.
        agent.state = 'idle';
        agent.waiting = undefined;
        agent.action = undefined;
        agent.error = undefined;
        agent.summary = undefined;
        agent.completedAt = undefined;
        agent.context = undefined;
        agent.cache = undefined;
        agent.lastPrompt = undefined;
        agent.recentActions = undefined;
        agent.lastReply = undefined;
      } else if (agent.state !== 'working' && agent.state !== 'waiting') {
        agent.state = 'starting';
      }
      break;
    }

    case 'UserPromptSubmit': {
      const prompt = (payload.prompt ?? '').trim();
      // A command or a shell line: no turn of the model starts here. A command that becomes a prompt shows
      // up with its first tool call or with Stop.
      if (prompt.startsWith('/') || prompt.startsWith('!')) break;
      startWork(agent);
      agent.action = undefined;
      agent.summary = { text: prompt ? `Sta lavorando a: ${clip(prompt, 100)}` : 'Sta lavorando', source: 'eventi', at: now };
      agent.lastPrompt = prompt ? clip(prompt, 600) : undefined;
      agent.recentActions = [];
      break;
    }

    case 'PreToolUse': {
      const tool = payload.tool_name ?? '?';
      if (!fromSubagent && tool === 'AskUserQuestion') {
        agent.state = 'waiting';
        agent.waiting = { kind: 'domanda', tool, detail: firstQuestion(payload.tool_input), since: now };
        agent.completedAt = undefined;
        break;
      }
      if (!fromSubagent && tool === 'ExitPlanMode') {
        agent.state = 'waiting';
        agent.waiting = { kind: 'dialogo', tool, detail: 'piano da approvare', since: now };
        agent.completedAt = undefined;
        break;
      }
      const { label, family } = toolLabel(tool, payload.tool_input, agent.cwd ?? payload.cwd);
      agent.action = { tool, label, family, subagent: fromSubagent ? payload.agent_type || 'subagente' : undefined, at: now };
      agent.recentActions = [...(agent.recentActions ?? []), label].slice(-RECENT_ACTIONS);
      // A subagent that works while the main agent waits for you, or after its turn ended, changes the
      // action shown, not the state.
      if (!fromSubagent || agent.state === 'starting' || agent.state === 'working' || agent.state === 'error') startWork(agent);
      const task = activeTask(tool, payload.tool_input);
      if (task) agent.summary = { text: clip(task, 140), source: 'eventi', at: now };
      break;
    }

    case 'PermissionRequest': {
      const tool = payload.tool_name ?? '?';
      const key = keyOf(tool, payload.tool_input);
      const since = agent.state === 'waiting' && agent.waiting ? agent.waiting.since : now;
      agent.state = 'waiting';
      // AskUserQuestion and ExitPlanMode ask for permission too (seen with 2.1.322): they stay a question
      // and a plan to approve, not a permission.
      if (tool === 'AskUserQuestion') agent.waiting = { kind: 'domanda', tool, detail: firstQuestion(payload.tool_input), key, since };
      else if (tool === 'ExitPlanMode') agent.waiting = { kind: 'dialogo', tool, detail: 'piano da approvare', key, since };
      else agent.waiting = { kind: 'permesso', tool, detail: toolLabel(tool, payload.tool_input, agent.cwd ?? payload.cwd).label, key, since };
      agent.completedAt = undefined;
      break;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (agent.state === 'waiting') {
        const waiting = agent.waiting;
        const sameCall = waiting?.key !== undefined && waiting.key === keyOf(payload.tool_name, payload.tool_input);
        const answered =
          (waiting?.kind === 'domanda' && payload.tool_name === 'AskUserQuestion') ||
          (waiting?.kind === 'dialogo' && payload.tool_name === 'ExitPlanMode');
        // Another tool finished while a dialog is still open: still waiting.
        if (!sameCall && !answered) break;
      }
      if (fromSubagent && agent.state === 'idle') break;
      if (agent.state !== 'compacting') startWork(agent);
      break;
    }

    case 'Notification': {
      const detail = payload.message ? clip(payload.message, 80) : undefined;
      switch (payload.notification_type) {
        case 'permission_prompt':
          if (agent.state !== 'waiting') {
            agent.state = 'waiting';
            agent.waiting = { kind: 'permesso', detail, since: now };
          }
          break;
        case 'elicitation_dialog':
        case 'elicitation_url_dialog':
        case 'agent_needs_input':
          agent.state = 'waiting';
          agent.waiting = { kind: 'dialogo', detail, since: now };
          break;
        case 'elicitation_complete':
        case 'elicitation_response':
          if (agent.state === 'waiting' && agent.waiting?.kind === 'dialogo') startWork(agent);
          break;
        case 'idle_prompt':
          // Claude finished a while ago: a turn that ended without Stop (an interrupt) ends here.
          if (agent.state === 'working') {
            agent.state = 'idle';
            agent.action = undefined;
          }
          break;
      }
      break;
    }

    case 'Stop': {
      if (fromSubagent) break;
      agent.state = 'idle';
      agent.waiting = undefined;
      agent.error = undefined;
      agent.action = undefined;
      agent.completedAt = now;
      const reply = payload.last_assistant_message;
      if (reply && reply.trim()) {
        agent.summary = { text: opening(reply), source: 'eventi', at: now };
        agent.lastReply = clip(reply, 1500);
      }
      break;
    }

    case 'StopFailure': {
      const kind = typeof payload.error === 'string' && payload.error ? payload.error : 'unknown';
      const text = errorText(payload.error_details) ?? payload.last_assistant_message;
      agent.state = 'error';
      agent.error = { kind, message: text ? clip(text, 160) : undefined, at: now };
      agent.waiting = undefined;
      agent.completedAt = undefined;
      break;
    }

    case 'PreCompact':
      if (agent.state !== 'compacting') agent.beforeCompact = agent.state;
      agent.state = 'compacting';
      agent.compactTrigger = payload.trigger;
      agent.completedAt = undefined;
      break;

    case 'PostCompact':
      if (agent.state === 'compacting') leaveCompaction(agent);
      break;

    case 'SessionEnd':
      if (payload.reason === 'clear' || payload.reason === 'resume') {
        agent.pendingSwitchAt = now;
        break;
      }
      markEnded(agent, payload.reason ?? 'other', now);
      break;
  }
}

/** What `claude agents --json` reports for a session. */
export interface AgentsEntry {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  kind?: string;
  name?: string;
  status?: string;
  waitingFor?: string;
  startedAt?: number;
}

export function stateFromStatus(status: string | undefined): AgentState {
  if (status === 'busy') return 'working';
  if (status === 'waiting') return 'waiting';
  return 'idle';
}

/**
 * Brings the state in line with `claude agents --json`, but only where the hooks have been quiet for
 * `quietMs`: a turn interrupted with Esc sends no Stop, and a permission given in the terminal sends nothing
 * until the tool ends. Returns whether the state changed.
 */
export function applyStatus(agent: Agent, entry: AgentsEntry, now: number, quietMs: number): boolean {
  if (agent.state === 'ended') return false;
  const quiet = now - agent.lastEvent.at >= quietMs;
  const before = agent.state;
  // A compaction that Claude Code gave up on ("Not enough messages to compact") sends PreCompact and no
  // PostCompact: when the hooks are quiet and the session waits for input, it is over.
  if (agent.state === 'compacting') {
    if (entry.status !== 'idle' || !quiet) return false;
    leaveCompaction(agent);
    agent.state = 'idle';
    return true;
  }
  switch (entry.status) {
    case 'idle':
      if (agent.state === 'starting' || ((agent.state === 'working' || agent.state === 'waiting') && quiet)) {
        agent.state = 'idle';
        agent.waiting = undefined;
        agent.action = undefined;
      }
      break;
    case 'busy':
      if (agent.state === 'starting' || ((agent.state === 'idle' || agent.state === 'waiting' || agent.state === 'error') && quiet)) startWork(agent);
      break;
    case 'waiting':
      if (agent.state !== 'waiting' && (agent.state === 'starting' || quiet)) {
        agent.state = 'waiting';
        agent.waiting = { kind: 'dialogo', detail: entry.waitingFor ? clip(entry.waitingFor, 80) : undefined, since: now, fromAgentView: true };
      }
      break;
  }
  return agent.state !== before;
}
