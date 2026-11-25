import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from '../shared/fspath.ts';
import type { Agent } from '../shared/agent.ts';
import { readDataJson, writeDataJson } from '../shared/data-file.ts';
import { parseTask, type ScheduledOutcome, type ScheduledRun, type ScheduledTask, taskOfPrompt } from '../shared/scheduled.ts';
import { MAX_PROMPT, type SpawnResult } from './spawn.ts';

// The scheduled tasks of the Claude desktop app (shared/scheduled.ts): read from their folder when somebody looks, never
// written. A session whose first prompt has the instructions of one is a run of it, whoever started it: the last run of
// each is kept in var/scheduled.json, with the session, the folder and how it went; not the prompt.

const MAX_TASKS = 100;
const MAX_FILE = 256 * 1024;
/** How much of the instructions the page gets. */
const MAX_SHOWN = 4000;

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

export interface ScheduledOptions {
  /** ~/.claude/scheduled-tasks. */
  folder: string;
  file?: string;
  log: Log;
  agent: (agentId: string) => Agent | undefined;
  spawn: (input: { cwd: string; prompt: string }, extras: { name?: string }) => Promise<SpawnResult>;
  onChange: () => void;
  now?: () => number;
}

const OUTCOMES: readonly ScheduledOutcome[] = ['working', 'waiting', 'done', 'error', 'ended'];

function runOf(raw: unknown): ScheduledRun | undefined {
  const run = raw as Partial<ScheduledRun> | undefined;
  if (!run || typeof run.at !== 'number' || (run.by !== 'forchetta' && run.by !== 'app') || !OUTCOMES.includes(run.outcome as ScheduledOutcome)) return undefined;
  return {
    at: run.at,
    by: run.by,
    outcome: run.outcome as ScheduledOutcome,
    ...(typeof run.cwd === 'string' ? { cwd: run.cwd } : {}),
    ...(typeof run.agentId === 'string' ? { agentId: run.agentId } : {}),
  };
}

/** How a run goes, from its session. */
function outcomeOf(agent: Agent, before: ScheduledOutcome): ScheduledOutcome {
  switch (agent.state) {
    case 'waiting':
      return 'waiting';
    case 'error':
      return 'error';
    case 'idle':
      // At rest before its first turn, too: only a turn that ended is done.
      return agent.completedAt !== undefined ? 'done' : before;
    case 'ended':
      return before === 'error' ? before : 'ended';
    default:
      return 'working';
  }
}

export class Scheduled {
  private runs: Record<string, ScheduledRun> = {};
  private cache: { key: string; tasks: ScheduledTask[] } | undefined;

  constructor(private readonly options: ScheduledOptions) {
    const raw = options.file ? (readDataJson(options.file, 'runs of the scheduled tasks', options.log) as { runs?: Record<string, unknown> } | undefined) : undefined;
    for (const [id, one] of Object.entries(raw?.runs && typeof raw.runs === 'object' ? raw.runs : {})) {
      const run = runOf(one);
      if (run) this.runs[id] = run;
    }
    // At work when the daemon stopped, with a session that is not there any more: how it went is not known.
    for (const run of Object.values(this.runs)) if ((run.outcome === 'working' || run.outcome === 'waiting') && !(run.agentId && options.agent(run.agentId))) run.outcome = 'ended';
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The tasks on the disk, the ones that did not change read once. */
  private read(): ScheduledTask[] {
    const found: { id: string; file: string; size: number; stamp: string }[] = [];
    try {
      for (const entry of readdirSync(this.options.folder)) {
        if (found.length >= MAX_TASKS) break;
        // A name of a folder, not a path; and no link out of there.
        if (!/^[^/\\.][^/\\]*$/.test(entry)) continue;
        const file = join(this.options.folder, entry, 'SKILL.md');
        try {
          if (lstatSync(join(this.options.folder, entry)).isSymbolicLink() || !lstatSync(file).isFile()) continue;
          const { size, mtimeMs } = statSync(file);
          if (size <= MAX_FILE) found.push({ id: entry, file, size, stamp: `${entry}:${size}:${mtimeMs}` });
        } catch {
          // No SKILL.md there.
        }
      }
    } catch {
      return [];
    }
    const key = found.map((one) => one.stamp).join('|');
    if (this.cache?.key !== key) {
      const tasks: ScheduledTask[] = [];
      for (const { id, file } of found) {
        try {
          const task = parseTask(id, readFileSync(file, 'utf8'));
          if (task.instructions) tasks.push({ ...task, ...(task.instructions.length > MAX_PROMPT ? { long: true } : {}) });
        } catch (error) {
          this.options.log(`scheduled task ${id} not read: ${String(error)}`, 'warn');
        }
      }
      this.cache = { key, tasks: tasks.sort((a, b) => a.name.localeCompare(b.name)) };
    }
    return this.cache.tasks;
  }

  list(): ScheduledTask[] {
    return this.read().map((task) => ({ ...task, ...(task.instructions.length > MAX_SHOWN ? { instructions: task.instructions.slice(0, MAX_SHOWN), cut: true } : {}), ...(this.runs[task.id] ? { lastRun: { ...this.runs[task.id]! } } : {}) }));
  }

  /** The conversations whose first prompt was looked at. */
  private readonly looked = new Set<string>();

  /** A session got a prompt: the instructions of a task, as its first one, make it a run of it. */
  prompt(agent: Agent, prompt: string): void {
    const conversation = agent.sessionId ?? agent.id;
    if (this.looked.has(conversation)) return;
    if (this.looked.size > 2000) this.looked.clear();
    this.looked.add(conversation);
    const task = taskOfPrompt(prompt, this.read());
    if (!task) return;
    // Started from here a moment ago: the same run.
    if (this.runs[task.id]?.agentId === agent.id) return;
    this.keep(task.id, { at: this.now(), by: 'app', outcome: 'working', agentId: agent.id, ...(agent.cwd ? { cwd: agent.cwd } : {}) });
    this.options.log(`scheduled task "${task.name}" seen at work`);
  }

  /** A session changed: the run it is, if it is one, goes as it goes. */
  agentChanged(agent: Agent): void {
    for (const [id, run] of Object.entries(this.runs)) {
      if (run.agentId !== agent.id) continue;
      // It finished: what you ask in its session afterwards is not the run any more.
      if (run.outcome === 'done') return;
      const outcome = outcomeOf(agent, run.outcome);
      if (outcome === run.outcome) return;
      this.keep(id, { ...run, outcome });
      return;
    }
  }

  /** The sessions that left the window: their runs stay, with no session to open. */
  forget(ids: readonly string[]): void {
    for (const [id, run] of Object.entries(this.runs)) {
      if (!run.agentId || !ids.includes(run.agentId)) continue;
      const { agentId: _gone, ...rest } = run;
      this.keep(id, rest.outcome === 'working' || rest.outcome === 'waiting' ? { ...rest, outcome: 'ended' } : rest);
    }
  }

  /** The instructions of a task as the first prompt of a new session of Forchetta, in a folder. */
  async run(id: string, cwd: string): Promise<SpawnResult> {
    const task = this.read().find((one) => one.id === id);
    if (!task) return { ok: false, error: 'this task is not there any more' };
    if (task.long) return { ok: false, error: `its instructions are longer than a first prompt can be (${MAX_PROMPT} characters): start it from the Claude app` };
    const started = this.now();
    const result = await this.options.spawn({ cwd, prompt: task.instructions }, { name: task.name.slice(0, 60) });
    if (!result.ok) return result;
    const agent = this.options.agent(result.agentId);
    this.keep(id, { at: started, by: 'forchetta', outcome: agent ? outcomeOf(agent, 'working') : 'working', agentId: result.agentId, cwd: agent?.cwd ?? cwd });
    return result;
  }

  private keep(id: string, run: ScheduledRun): void {
    this.runs[id] = run;
    if (this.options.file) {
      try {
        writeDataJson(this.options.file, { version: 1, runs: this.runs });
      } catch (error) {
        this.options.log(`runs of the scheduled tasks not saved: ${String(error)}`, 'error');
      }
    }
    this.options.onChange();
  }
}
