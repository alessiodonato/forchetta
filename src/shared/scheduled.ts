// The scheduled tasks of the Claude desktop app, as Forchetta shows them. Each is a folder of ~/.claude/scheduled-tasks with
// a SKILL.md: a name, a description, and the instructions. When they start, in which folder and how they went is kept by the
// app, where no other program reads it: Forchetta knows the runs it saw. No Node module here: the page uses it too.

export type ScheduledOutcome = 'working' | 'waiting' | 'done' | 'error' | 'ended';

export interface ScheduledRun {
  at: number;
  /** Started from here, or by the app. */
  by: 'forchetta' | 'app';
  cwd?: string;
  /** Its session, while it is there. */
  agentId?: string;
  outcome: ScheduledOutcome;
}

export interface ScheduledTask {
  /** The name of its folder. */
  id: string;
  name: string;
  description?: string;
  instructions: string;
  /** Only their start is here: the page shows no more. */
  cut?: boolean;
  /** Too long for a first prompt: it cannot be started from here. */
  long?: boolean;
  lastRun?: ScheduledRun;
}

/** The frontmatter of a SKILL.md (name, description) and its body. */
export function parseTask(id: string, text: string): Pick<ScheduledTask, 'id' | 'name' | 'description' | 'instructions'> {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const instructions = (match ? text.slice(match[0].length) : text).trim();
  const field = (name: string): string | undefined => {
    const lines = (match?.[1] ?? '').split(/\r?\n/);
    const at = lines.findIndex((line) => line.startsWith(`${name}:`));
    if (at < 0) return undefined;
    let value = lines[at]!.slice(name.length + 1).trim();
    // A block (">" or "|"), or a text that goes on: the lines under it, indented.
    if (/^[>|][+-]?$/.test(value) || value === '') {
      const under: string[] = [];
      for (const line of lines.slice(at + 1)) {
        if (!/^\s+\S/.test(line)) break;
        under.push(line.trim());
      }
      value = under.join(' ');
    }
    const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[1] === '"' ? quoted[2]!.replace(/\\(["\\])/g, '$1') : quoted[2]!.replace(/''/g, "'");
    return value.trim().slice(0, 500) || undefined;
  };
  const description = field('description');
  return { id, name: field('name') ?? id, ...(description ? { description } : {}), instructions };
}

const squeezed = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The task a first prompt starts: its instructions are all in it. Undefined for any other prompt. */
export function taskOfPrompt<T extends Pick<ScheduledTask, 'instructions'>>(prompt: string, tasks: readonly T[]): T | undefined {
  const text = squeezed(prompt);
  return tasks
    .filter((task) => {
      const own = squeezed(task.instructions);
      // A few words could be in any prompt: those have to be all of it.
      return own.length >= 40 ? text.includes(own) : own.length > 0 && text === own;
    })
    .sort((a, b) => b.instructions.length - a.instructions.length)[0];
}

export const OUTCOME_TEXT: Record<ScheduledOutcome, string> = {
  working: 'at work now',
  waiting: 'waits for you',
  done: 'finished',
  error: 'stopped on an error',
  ended: 'ended before it finished',
};
