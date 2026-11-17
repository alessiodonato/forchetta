import type { Agent, LoopInfo } from '../shared/agent.ts';
import { clip, toolLabel } from './labels.ts';
import { type HookPayload, startsTurn } from './state.ts';

// A session going in circles: in the turn it is on, the same tool call fails in the same way again and again (npm
// test with the same error after each "fix", the same command with the same typo). The box says it, and a
// notification of macOS (daemon/attention.ts) brings you there: a hint from you usually ends it.
//
// Claude Code tells a failed call with PostToolUseFailure: the input of the call and its error ("Exit code 1" and
// the output, for Bash). The same call is the same tool with the same input (for Bash the command, not its
// description); the same error is the same text once times, dates and addresses are taken out of it. A call that then
// works, or fails another way, ends the episode; so does the end of the turn, or a new prompt of yours.

/** The failures in a row, the same each time, that make a session going in circles. */
export const LOOP_AFTER = 3;

/** The longest error kept to compare: its start and its end. */
const ERROR_KEPT = 4000;

interface Failure {
  error: string;
  count: number;
  since: number;
}

/** The call, as the same call is recognized: the tool, the subagent that makes it, and its input. */
export function callKey(tool: string, input: unknown, subagent = ''): string {
  const fields = input !== null && typeof input === 'object' ? { ...(input as Record<string, unknown>) } : {};
  if (tool === 'Bash' && typeof fields.command === 'string') return `${subagent}\u0000Bash\u0000${fields.command.replace(/\s+/g, ' ').trim()}`;
  // The description Claude gives a call changes from one try to the next: it is not the call.
  delete fields.description;
  return `${subagent}\u0000${tool}\u0000${JSON.stringify(fields)}`;
}

/** The error of a failure, without what changes from one run to the next: times, durations, dates, addresses. */
export function errorKey(error: unknown): string {
  const text = typeof error === 'string' ? error : error === undefined || error === null ? '' : JSON.stringify(error);
  const plain = text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, '<date>')
    .replace(/\b\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\b/g, '<time>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min|minutes)\b/gi, '<duration>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<addr>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\bpid[ =:]?\d+\b/gi, '<pid>')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return plain.length <= ERROR_KEPT ? plain : `${plain.slice(0, ERROR_KEPT / 2)}\n…\n${plain.slice(-ERROR_KEPT / 2)}`;
}

/** The error as the box shows it: "exit 1 · FAIL test/api.test.ts" for a command, else its first line. */
export function errorLine(error: unknown): string {
  const text = typeof error === 'string' ? error : '';
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const exit = /^Exit code (\d+)$/.exec(lines[0] ?? '');
  if (exit) return clip(lines[1] ? `exit ${exit[1]} · ${lines[1]}` : `exit ${exit[1]}`, 120);
  return clip(lines[0] ?? 'failed', 120);
}

/** The call as its box line says it: the command itself for Bash ("npm test"), else the label of the action. */
function callLabel(tool: string, input: unknown, cwd: string | undefined): string {
  const command = (input as { command?: unknown } | undefined)?.command;
  if (tool === 'Bash' && typeof command === 'string' && command.trim()) return clip(command, 80);
  return toolLabel(tool, input, cwd).label;
}

const turnEnds = (payload: HookPayload): boolean => {
  const event = payload.hook_event_name;
  return (
    (event === 'Stop' && !payload.agent_id) ||
    event === 'StopFailure' ||
    event === 'SessionEnd' ||
    (event === 'SessionStart' && (payload.source === 'clear' || payload.source === 'resume')) ||
    startsTurn(payload)
  );
};

export class Loops {
  /** By agent: the last failure of each call in this turn. */
  private readonly turns = new Map<string, Map<string, Failure>>();
  /** By agent: the call its box says it goes in circles on. */
  private readonly loopCall = new Map<string, string>();

  /** A hook of a session: whether its box changed (`agent.loop`). */
  hook(agent: Agent, payload: HookPayload, now: number): boolean {
    if (turnEnds(payload)) return this.reset(agent);
    const event = payload.hook_event_name;
    if ((event !== 'PostToolUse' && event !== 'PostToolUseFailure') || !payload.tool_name) return false;
    const key = callKey(payload.tool_name, payload.tool_input, payload.agent_id ? (payload.agent_type ?? 'subagent') : '');
    let calls = this.turns.get(agent.id);
    if (event === 'PostToolUse') {
      // It worked: whatever went in circles on this call is over.
      calls?.delete(key);
      return this.loopCall.get(agent.id) === key ? this.end(agent) : false;
    }
    // Stopped by you (Esc): not a failure of its own.
    if (payload.is_interrupt === true) return false;
    if (!calls) {
      calls = new Map();
      this.turns.set(agent.id, calls);
    }
    const error = errorKey(payload.error);
    const last = calls.get(key);
    const failure: Failure = last && last.error === error ? { error, count: last.count + 1, since: last.since } : { error, count: 1, since: now };
    calls.set(key, failure);
    if (failure.count < LOOP_AFTER) {
      // The same call, failing another way: it moves, it is not in circles.
      return this.loopCall.get(agent.id) === key ? this.end(agent) : false;
    }
    const loop: LoopInfo = {
      tool: payload.tool_name,
      label: callLabel(payload.tool_name, payload.tool_input, agent.cwd ?? payload.cwd),
      error: errorLine(payload.error),
      count: failure.count,
      since: failure.since,
      at: now,
      ...(payload.agent_id ? { subagent: payload.agent_type ?? 'subagent' } : {}),
    };
    this.loopCall.set(agent.id, key);
    agent.loop = loop;
    return true;
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) {
      this.turns.delete(id);
      this.loopCall.delete(id);
    }
  }

  private reset(agent: Agent): boolean {
    this.turns.delete(agent.id);
    return this.end(agent);
  }

  private end(agent: Agent): boolean {
    this.loopCall.delete(agent.id);
    if (!agent.loop) return false;
    agent.loop = undefined;
    return true;
  }
}
