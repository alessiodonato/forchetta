import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Agent, GuardHold } from '../shared/agent.ts';
import { displayName } from '../shared/agent.ts';
import type { HookPayload } from './state.ts';
import { removedLines } from './coherence.ts';
import { commandStart, isCheckCommand, placedCommands, shellCommands } from './shell.ts';

export { shellCommands } from './shell.ts';

// The guard: sessions that do not step on each other. bin/forchetta-guard asks the daemon before every Edit, Write,
// MultiEdit, NotebookEdit and Bash of every session, and Claude waits for the answer (daemon/server.ts).
//
// Files. A session holds a file it wrote in the turn it works on now, until that turn ends (Stop, StopFailure, a
// /clear, the end of the session). Another session that wants to write that file gets "deny", with a reason for
// Claude: work on something else, or end the turn and wait. Two worktrees are two different folders: nothing in
// common to hold. You can let a session through from its box.
//
// git. Before a Bash command with a git that changes the files of a working tree (checkout, reset --hard, stash…),
// if another live session works in that same working tree, the answer is "ask": you decide, with the reason in
// the dialog. The command is read as well as a plain reading of a shell line allows; what cannot be read is let go.
//
// It also tells Claude what it should know, without stopping anything: before tests or a build, that another session
// is halfway through some files, so the errors there are probably its work in progress. And it stops once what
// would undo the work of another session without knowing: taking away lines another session added in the last hour,
// or a git add -A / commit -a that would take the changes of another session into this one's commit. The same call
// again goes through: Claude was told, and means it.
//
// The guard answers from memory, at once (the files of a commit need one git status). With nothing to say it says
// nothing, and the tool goes on as usual.

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/**
 * A file stays held this long after its last write when the session is between turns: a subagent in the
 * background can still be changing it. In a turn, it is held until the turn ends.
 */
export const HOLD_AFTER_TURN_MS = 2 * 60_000;
/** A session that changed files in a working tree this recently still works there, for the git guard. */
export const WORKS_THERE_MS = 60 * 60_000;

/** A warning that stops a session once: the same call again within this time goes through. */
export const ONCE_MS = 10 * 60_000;
/** The note before tests is said again for the same files only after this long. */
export const CHECK_NOTE_AGAIN_MS = 15 * 60_000;

export interface GuardDecision {
  /** Absent: the tool goes on, and Claude reads the context with its result. */
  decision?: 'deny' | 'ask';
  /** For "deny" Claude reads it; for "ask" you do, in the dialog. */
  reason?: string;
  /** A note for Claude that stops nothing (additionalContext): it comes with the result of the tool. */
  context?: string;
}

/** What Claude Code reads on the stdout of a PreToolUse hook. */
export const hookOutput = (answer: GuardDecision): object => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    ...(answer.decision && { permissionDecision: answer.decision, permissionDecisionReason: answer.reason }),
    ...(answer.context && { additionalContext: answer.context }),
  },
});

/** A file git sees as changed in a working tree (git status): absolute, and whether git does not track it yet. */
export interface DirtyFile {
  path: string;
  untracked: boolean;
}

/** The file a tool is about to write, absolute; undefined for any other tool. */
export function targetFile(tool: string | undefined, input: unknown, cwd: string | undefined): string | undefined {
  if (!tool || !FILE_TOOLS.has(tool) || !input || typeof input !== 'object') return undefined;
  const fields = input as Record<string, unknown>;
  const path = typeof fields.file_path === 'string' ? fields.file_path : typeof fields.notebook_path === 'string' ? fields.notebook_path : undefined;
  if (!path) return undefined;
  if (isAbsolute(path)) return resolve(path);
  return cwd ? resolve(cwd, path) : undefined;
}

/** A session in a turn: it works, waits for you inside the turn, or compacts. */
const inTurn = (agent: Agent): boolean => agent.state === 'working' || agent.state === 'waiting' || agent.state === 'compacting';

/** How a box calls another session: its name, or its folder; the name of the session when they share the folder. */
export function otherName(other: Agent, agent: Agent): string {
  return other.team?.label ?? (other.name && other.project === agent.project ? other.name : displayName(other));
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 1 ? 'just now' : min === 1 ? '1 min ago' : `${min} min ago`;
}

// ── git ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One git command found in a shell line: the subcommand, its arguments, and the folder it runs in. */
export interface GitCommand {
  sub: string;
  args: string[];
  dir: string;
  /** As written, for the dialog: "git checkout main". */
  text: string;
}

/** The options of git itself that take a value as the next word. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** The git commands of a shell line, each with the folder it runs in (cd and git -C followed). */
export function gitCommands(line: string, cwd: string): GitCommand[] {
  const commands = shellCommands(line);
  if (!commands) return [];
  const found: GitCommand[] = [];
  let dir = cwd;
  for (const words of commands) {
    // VAR=value before the command, and the words that only run it: command, exec, env, nice, time.
    let i = commandStart(words);
    const name = words[i];
    if (name === 'cd') {
      const to = words[i + 1];
      if (to && to !== '-' && !to.startsWith('~') && !to.includes('$')) dir = resolve(dir, to);
      continue;
    }
    if (name !== 'git' && !name?.endsWith('/git')) continue;
    let where = dir;
    let j = i + 1;
    for (; j < words.length; j++) {
      const word = words[j]!;
      if (!word.startsWith('-')) break;
      const [option, value] = word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined];
      if (!GIT_VALUE_OPTIONS.has(option)) continue;
      const given = value ?? words[++j];
      if (given === undefined) break;
      if (option === '-C' && !given.includes('$')) where = resolve(where, given);
      if (option === '--work-tree' && !given.includes('$')) where = resolve(where, given);
    }
    const sub = words[j];
    if (!sub) continue;
    const args = words.slice(j + 1);
    found.push({ sub, args, dir: where, text: ['git', sub, ...args].join(' ').slice(0, 120) });
  }
  return found;
}

/** Whether a git command changes the files of its working tree (not only the index, the refs or the remote). */
export function changesWorkingTree(command: Pick<GitCommand, 'sub' | 'args'>): boolean {
  const { sub, args } = command;
  const plain = args.filter((arg) => !arg.startsWith('-'));
  switch (sub) {
    case 'checkout':
      // A new branch from where you are: the files stay as they are.
      if ((args.includes('-b') || args.includes('-B')) && plain.length <= 1) return false;
      return args.length > 0;
    case 'switch':
      if ((args.includes('-c') || args.includes('-C') || args.includes('--create')) && plain.length <= 1) return false;
      return args.length > 0;
    case 'restore':
      // --staged alone touches the index only.
      return !(args.includes('--staged') || args.includes('-S')) || args.includes('--worktree') || args.includes('-W');
    case 'reset':
      return args.includes('--hard') || args.includes('--merge') || args.includes('--keep');
    case 'stash': {
      const action = plain[0];
      return action === undefined || ['push', 'save', 'pop', 'apply', 'branch'].includes(action);
    }
    case 'clean':
      return !args.some((arg) => arg === '-n' || arg === '--dry-run' || /^-[a-zA-Z]*n/.test(arg));
    case 'rebase':
    case 'pull':
    case 'merge':
    case 'cherry-pick':
    case 'revert':
    case 'am':
      return true;
    default:
      return false;
  }
}

// ── the guard ───────────────────────────────────────────────────────────────────────────────────────────────

export interface GuardOptions {
  /** Every agent the daemon knows. */
  agents: () => Iterable<Agent>;
  /** The working tree of a folder (daemon/conflicts.ts). */
  repoOf: (dir: string) => string | undefined;
  /** The files an agent wrote, with when and in which working tree (daemon/conflicts.ts). */
  writesOf: (agentId: string) => Array<{ path: string; at: number; repo?: string }>;
  /** What is on, from var/config.json: notes are those for Claude that stop nothing (before tests). */
  enabled: () => { files: boolean; git: boolean; notes?: boolean };
  /** Of the lines a session takes away from a file, those another session added in the last hour (daemon/coherence.ts). */
  addedByOthers?: (agentId: string, file: string, removed: string[]) => { agentId: string; at: number; lines: string[] } | undefined;
  /** Whether another session changed the file in the last hour: when not, the lines taken away are not even read. */
  changedByOthers?: (agentId: string, file: string) => boolean;
  /** The text of a file, for a Write over it; undefined when it cannot be read. */
  readText?: (path: string) => string | undefined;
  /** The changed files of a working tree, for git add -A and commit -a; undefined when git does not answer. */
  dirty?: (repo: string) => Promise<DirtyFile[] | undefined>;
  /** The lines of the guard of a box changed. */
  touch: (agent: Agent) => void;
  /** A file held back is free again: the session that waited for it may go on (daemon/main.ts). */
  onFree?: (waiter: Agent, files: GuardHold[], by: Agent) => void;
  now?: () => number;
}

interface Stop {
  holder: string;
  since: number;
  letThrough?: boolean;
}

export class Guard {
  /** For each agent: the files it holds, with its last write. */
  private readonly holds = new Map<string, Map<string, number>>();
  /** For each agent that was stopped: the files, and who held each. */
  private readonly stops = new Map<string, Map<string, Stop>>();
  /** The warnings that stop once, by agent and call: when they were said. */
  private readonly warned = new Map<string, number>();
  /** The last note before tests, by agent: its files, and when. */
  private readonly checkNotes = new Map<string, { key: string; at: number }>();
  private readonly now: () => number;

  constructor(private readonly options: GuardOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * A write of an agent went through (PostToolUse): it holds the file. If it had been stopped on it, the stop goes,
   * unless you let it through: that lasts until the other one's turn ends.
   */
  wrote(agent: Agent, file: string): void {
    let files = this.holds.get(agent.id);
    if (!files) {
      files = new Map();
      this.holds.set(agent.id, files);
    }
    files.set(file, this.now());
    const stops = this.stops.get(agent.id);
    const stop = stops?.get(file);
    if (!stops || !stop || stop.letThrough) return;
    stops.delete(file);
    if (stops.size === 0) this.stops.delete(agent.id);
    const holder = this.byId(stop.holder);
    this.refresh(holder ? [agent, holder] : [agent]);
  }

  /** After every hook: the end of a turn lets the files of the agent go. */
  hook(agent: Agent, payload: HookPayload): void {
    const event = payload.hook_event_name;
    const turnEnded =
      (event === 'Stop' && !payload.agent_id) ||
      event === 'StopFailure' ||
      event === 'SessionEnd' ||
      (event === 'SessionStart' && (payload.source === 'clear' || payload.source === 'resume'));
    if (turnEnded) this.release(agent);
  }

  /** A session that ended: it holds nothing and waits for nothing. */
  ended(agent: Agent): void {
    if (!this.holds.has(agent.id) && !this.stops.has(agent.id) && !agent.heldBack && !agent.holding) return;
    this.release(agent);
    const stops = this.stops.get(agent.id);
    this.stops.delete(agent.id);
    this.refresh([agent, ...(stops ? this.holdersOf(stops) : [])]);
  }

  /** You let a session through for one file, from its box: its next write of it goes. */
  letThrough(agentId: string, path: string): boolean {
    const stop = this.stops.get(agentId)?.get(path);
    const agent = this.byId(agentId);
    if (!stop || !agent) return false;
    stop.letThrough = true;
    const holder = this.byId(stop.holder);
    this.refresh(holder ? [agent, holder] : [agent]);
    return true;
  }

  /** The answer to a PreToolUse: a decision, or undefined to let the tool go on as usual. */
  decide(agent: Agent, payload: HookPayload): GuardDecision | undefined {
    if (payload.hook_event_name !== 'PreToolUse' || agent.state === 'ended') return undefined;
    const enabled = this.options.enabled();
    const cwd = agent.cwd ?? payload.cwd;
    const file = targetFile(payload.tool_name, payload.tool_input, cwd);
    if (file) return enabled.files ? (this.decideFile(agent, file) ?? this.decideUndo(agent, payload, file)) : undefined;
    const command = (payload.tool_input as { command?: unknown } | undefined)?.command;
    if (payload.tool_name !== 'Bash' || !cwd || typeof command !== 'string') return undefined;
    const git = enabled.git ? this.decideGit(agent, command, cwd) : undefined;
    if (git) return git;
    return enabled.notes !== false ? this.checkNote(agent, command, cwd) : undefined;
  }

  /**
   * The part of the answer that needs git: a git add -A or commit -a that would take the changes of other sessions
   * into this commit is stopped once, with the files of this session to add instead.
   */
  async decideCommit(agent: Agent, payload: HookPayload): Promise<GuardDecision | undefined> {
    if (payload.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'Bash' || agent.state === 'ended' || !this.options.enabled().git) return undefined;
    const line = (payload.tool_input as { command?: unknown } | undefined)?.command;
    const cwd = agent.cwd ?? payload.cwd;
    if (typeof line !== 'string' || !cwd || !this.options.dirty) return undefined;
    for (const command of gitCommands(line, cwd)) {
      const sweep = sweepOf(command);
      if (!sweep) continue;
      const repo = this.options.repoOf(command.dir);
      if (!repo) continue;
      const now = this.now();
      const recent = (id: string): Set<string> =>
        new Set(this.options.writesOf(id).filter((write) => write.repo === repo && now - write.at < WORKS_THERE_MS).map((write) => write.path));
      const others = [...this.options.agents()].filter((other) => other.id !== agent.id && other.state !== 'ended' && recent(other.id).size > 0);
      if (others.length === 0) continue;
      const dirty = await this.options.dirty(repo);
      if (!dirty) continue;
      const inScope = dirty.filter((file) => (sweep.tracked ? !file.untracked : true) && sweep.under.some((dir) => inside(file.path, dir)));
      const mine = recent(agent.id);
      const theirs = new Map<string, Agent[]>();
      for (const file of inScope) {
        for (const other of others) if (recent(other.id).has(file.path)) theirs.set(file.path, [...(theirs.get(file.path) ?? []), other]);
      }
      if (theirs.size === 0) continue;
      const key = `commit\n${command.text}`;
      if (!this.firstTime(agent.id, key)) return undefined;
      const rel = (path: string): string => relative(repo, path);
      const onlyTheirs = [...theirs.keys()].filter((path) => !mine.has(path));
      const both = [...theirs.keys()].filter((path) => mine.has(path));
      const own = inScope.map((file) => file.path).filter((path) => mine.has(path) && !theirs.has(path));
      const names = [...new Set([...theirs.values()].flat())].map((other) => `"${otherName(other, agent)}"${inTurn(other) ? ', in the middle of its turn' : ''}`);
      const listed = (paths: string[]): string => (paths.length <= 6 ? paths.map(rel).join(', ') : `${paths.slice(0, 6).map(rel).join(', ')} and ${paths.length - 6} more`);
      const parts = [
        `Forchetta: "${command.text}" would also take changes of other Claude Code sessions working in this folder (${names.join('; ')})` +
          (onlyTheirs.length > 0 ? `: ${listed(onlyTheirs)}.` : '.'),
        both.length > 0 ? `${listed(both)} ${both.length === 1 ? 'has' : 'have'} changes of yours and of the other session: add only your part (git add -p), or leave ${both.length === 1 ? 'it' : 'them'}.` : '',
        own.length > 0 ? `Add only your own files: git add ${own.map(rel).join(' ')}` : 'You changed no other file here yourself.',
        'Run the same command again only if you were asked to commit the work of every session.',
      ];
      return { decision: 'deny', reason: parts.filter(Boolean).join(' ') };
    }
    return undefined;
  }

  /**
   * True the first time a warning is said to an agent: it is stopped. The same call again within ONCE_MS goes
   * through, and the next one after that is stopped again.
   */
  private firstTime(agentId: string, key: string): boolean {
    const now = this.now();
    for (const [known, at] of this.warned) if (now - at >= ONCE_MS) this.warned.delete(known);
    const full = `${agentId}\n${key}`;
    if (this.warned.delete(full)) return false;
    this.warned.set(full, now);
    return true;
  }

  /** An edit that takes away lines another session added in the last hour: stopped once, with those lines. */
  private decideUndo(agent: Agent, payload: HookPayload, file: string): GuardDecision | undefined {
    if (!this.options.addedByOthers || this.options.changedByOthers?.(agent.id, file) === false) return undefined;
    const removed = removedBy(payload.tool_name, payload.tool_input, () => this.options.readText?.(file));
    if (removed.length === 0) return undefined;
    const found = this.options.addedByOthers(agent.id, file, removed);
    const other = found ? this.byId(found.agentId) : undefined;
    if (!found || !other) return undefined;
    if (!this.firstTime(agent.id, `undo\n${file}\n${found.lines.join('\n')}`)) return undefined;
    const shown = this.shownPath(file, agent);
    const lines = found.lines.slice(0, 8).map((line) => `    + ${line.trim().slice(0, 160)}`);
    const more = found.lines.length > 8 ? [`    … and ${found.lines.length - 8} more`] : [];
    return {
      decision: 'deny',
      reason: [
        `Forchetta: this change takes away lines that "${otherName(other, agent)}", another Claude Code session on this Mac, added to ${shown} ${ago(this.now() - found.at)}:`,
        ...lines,
        ...more,
        "If that is not on purpose, leave its lines and change only your part. If you do mean to take them away, make the same change again: it will go through.",
      ].join('\n'),
    };
  }

  /**
   * Before tests, a build or a linter: the files other sessions in this working tree are changing in the turn they
   * are on now, so that errors there are not taken for this session's own. Said again for the same files only after
   * a while.
   */
  private checkNote(agent: Agent, line: string, cwd: string): GuardDecision | undefined {
    const checks = placedCommands(line, cwd).filter((command) => isCheckCommand(command.words));
    if (checks.length === 0) return undefined;
    const repo = this.options.repoOf(checks[0]!.dir) ?? checks[0]!.dir;
    const now = this.now();
    const busy: Array<{ other: Agent; files: string[] }> = [];
    for (const other of this.options.agents()) {
      if (other.id === agent.id || other.state === 'ended' || !inTurn(other)) continue;
      const files = [...(this.holds.get(other.id)?.keys() ?? [])].filter((file) => file === repo || file.startsWith(`${repo}/`)).sort();
      if (files.length > 0) busy.push({ other, files });
    }
    if (busy.length === 0) return undefined;
    const key = busy.map((item) => `${item.other.id}:${item.files.join(',')}`).join('|');
    const last = this.checkNotes.get(agent.id);
    if (last && last.key === key && now - last.at < CHECK_NOTE_AGAIN_MS) return undefined;
    this.checkNotes.set(agent.id, { key, at: now });
    const and = (items: string[]): string => (items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`);
    const who = busy.map(({ other, files }) => {
      const shown = files.slice(0, 5).map((file) => this.shownPath(file, agent));
      return `"${otherName(other, agent)}" is in the middle of changing ${and(files.length > 5 ? [...shown, `${files.length - 5} more`] : shown)}`;
    });
    return {
      context:
        `Forchetta: other Claude Code sessions work in this folder right now: ${who.join('; ')}. ` +
        "If this fails in those files, or in code that uses them, it is probably their unfinished work, not yours: don't fix it. " +
        'Work on your part, run your own tests, and say so if you are blocked.',
    };
  }

  private decideFile(agent: Agent, file: string): GuardDecision | undefined {
    const holder = this.holderOf(file, agent);
    const stops = this.stops.get(agent.id);
    if (!holder) {
      // Held no more: what the box still showed goes.
      if (stops?.delete(file)) this.refresh([agent]);
      return undefined;
    }
    const known = stops?.get(file);
    if (known?.letThrough && known.holder === holder.id) return undefined;
    // You let the other one through on this file, while this one held it: they share it until the turn ends.
    const theirs = this.stops.get(holder.id)?.get(file);
    if (theirs?.letThrough && theirs.holder === agent.id) return undefined;
    if (!known || known.holder !== holder.id) {
      const map = stops ?? new Map<string, Stop>();
      map.set(file, { holder: holder.id, since: this.now() });
      this.stops.set(agent.id, map);
      this.refresh([agent, holder]);
    }
    const shown = this.shownPath(file, agent);
    return {
      decision: 'deny',
      reason:
        `Forchetta: "${otherName(holder, agent)}", another Claude Code session on this Mac, is changing ${shown} in the turn it is working on now. ` +
        `Don't edit this file yet and don't try again now: work on something else first, or end your turn saying that you are waiting for ${shown}. ` +
        'You will be told when the file is free.',
    };
  }

  private decideGit(agent: Agent, line: string, cwd: string): GuardDecision | undefined {
    const now = this.now();
    for (const command of gitCommands(line, cwd)) {
      if (!changesWorkingTree(command)) continue;
      const repo = this.options.repoOf(command.dir);
      if (!repo) continue;
      for (const other of this.options.agents()) {
        if (other.id === agent.id || other.state === 'ended') continue;
        const there = other.cwd !== undefined && this.options.repoOf(other.cwd) === repo;
        const last = this.options
          .writesOf(other.id)
          .filter((write) => write.repo === repo && now - write.at < WORKS_THERE_MS)
          .sort((a, b) => b.at - a.at)[0];
        if (!last && !(there && inTurn(other))) continue;
        const what = last ? `it changed ${relative(repo, last.path)} ${ago(now - last.at)}` : 'it is working there now';
        return {
          decision: 'ask',
          reason: `Forchetta: "${otherName(other, agent)}", another Claude Code session, works in this same folder (${what}). "${command.text}" changes the files under it.`,
        };
      }
    }
    return undefined;
  }

  /** The live session, other than this one, that holds a file now: the one that wrote it last. */
  private holderOf(file: string, agent: Agent): Agent | undefined {
    const now = this.now();
    let found: { agent: Agent; at: number } | undefined;
    for (const other of this.options.agents()) {
      if (other.id === agent.id || other.state === 'ended') continue;
      const at = this.holds.get(other.id)?.get(file);
      if (at === undefined) continue;
      if (!inTurn(other) && now - at >= HOLD_AFTER_TURN_MS) continue;
      if (!found || at > found.at) found = { agent: other, at };
    }
    return found?.agent;
  }

  /** The end of a turn of an agent: its files go free, and the sessions that waited for them are told. */
  private release(holder: Agent): void {
    this.holds.delete(holder.id);
    const touched: Agent[] = [];
    for (const [waiterId, stops] of this.stops) {
      const freed: GuardHold[] = [];
      for (const [path, stop] of stops) {
        if (stop.holder !== holder.id) continue;
        stops.delete(path);
        const waiter = this.byId(waiterId);
        if (waiter) freed.push(this.line(path, stop, holder, waiter));
      }
      if (stops.size === 0) this.stops.delete(waiterId);
      const waiter = this.byId(waiterId);
      if (waiter && freed.length > 0) {
        touched.push(waiter);
        this.options.onFree?.(waiter, freed, holder);
      }
    }
    this.refresh([holder, ...touched]);
  }

  private holdersOf(stops: Map<string, Stop>): Agent[] {
    return [...stops.values()].map((stop) => this.byId(stop.holder)).filter((agent): agent is Agent => agent !== undefined);
  }

  private byId(id: string): Agent | undefined {
    for (const agent of this.options.agents()) if (agent.id === id) return agent;
    return undefined;
  }

  /** The file as the box shows it: relative to its working tree, or to the folder of the session. */
  private shownPath(file: string, agent: Agent): string {
    const repo = this.options.repoOf(resolve(file, '..'));
    const base = repo ?? agent.cwd;
    if (!base) return file;
    const rel = relative(base, file);
    return rel && !rel.startsWith('..') ? rel : file;
  }

  /** One line of a box: the file, and the other session (for the waiter, who holds it). */
  private line(path: string, stop: Stop, other: Agent, viewer: Agent): GuardHold {
    return {
      file: this.shownPath(path, viewer),
      path,
      with: other.id,
      withName: otherName(other, viewer),
      since: stop.since,
      ...(stop.letThrough ? { letThrough: true } : {}),
    };
  }

  /** The lines of the guard of these boxes, worked out again; a box that changed is told. */
  private refresh(agents: Agent[]): void {
    const seen = new Set<string>();
    for (const agent of agents) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      const heldBack: GuardHold[] = [];
      for (const [path, stop] of this.stops.get(agent.id) ?? []) {
        const holder = this.byId(stop.holder);
        if (holder) heldBack.push(this.line(path, stop, holder, agent));
      }
      const holding: GuardHold[] = [];
      for (const [waiterId, stops] of this.stops) {
        const waiter = this.byId(waiterId);
        if (!waiter) continue;
        for (const [path, stop] of stops) if (stop.holder === agent.id) holding.push(this.line(path, stop, waiter, agent));
      }
      const nextHeldBack = heldBack.length > 0 ? heldBack : undefined;
      const nextHolding = holding.length > 0 ? holding : undefined;
      if (JSON.stringify(nextHeldBack) === JSON.stringify(agent.heldBack) && JSON.stringify(nextHolding) === JSON.stringify(agent.holding)) continue;
      agent.heldBack = nextHeldBack;
      agent.holding = nextHolding;
      this.options.touch(agent);
    }
  }
}

/** The lines an Edit, MultiEdit or Write takes away for good (the text of a Write's file is read only if needed). */
export function removedBy(tool: string | undefined, input: unknown, current: () => string | undefined): string[] {
  if (!input || typeof input !== 'object') return [];
  const fields = input as Record<string, unknown>;
  if (tool === 'Edit' && typeof fields.old_string === 'string' && typeof fields.new_string === 'string') return removedLines(fields.old_string, fields.new_string);
  if (tool === 'MultiEdit' && Array.isArray(fields.edits)) {
    return fields.edits.flatMap((item) => {
      const one = (item ?? {}) as Record<string, unknown>;
      return typeof one.old_string === 'string' && typeof one.new_string === 'string' ? removedLines(one.old_string, one.new_string) : [];
    });
  }
  if (tool === 'Write' && typeof fields.content === 'string') {
    const before = current();
    return before === undefined ? [] : removedLines(before, fields.content);
  }
  return [];
}

/**
 * What a git command would put in a commit beyond the files it names: git add -A, --all, -u, ., a folder, and git
 * commit -a. The folders it covers, and whether it takes only files git tracks (-u, commit -a). Undefined for the
 * others, and for git add of files by name.
 */
export function sweepOf(command: GitCommand): { under: string[]; tracked: boolean } | undefined {
  const { sub, args, dir } = command;
  // "/" is the whole working tree: commit -a, and add -A or -u with no path, take every changed file of it.
  if (sub === 'commit') {
    const all = args.some((arg) => arg === '--all' || (/^-[a-zA-Z]+$/.test(arg) && arg.includes('a')));
    return all ? { under: ['/'], tracked: true } : undefined;
  }
  if (sub !== 'add') return undefined;
  const paths = args.filter((arg) => !arg.startsWith('-'));
  const all = args.some((arg) => arg === '-A' || arg === '--all' || arg === '--no-ignore-removal');
  const update = args.some((arg) => arg === '-u' || arg === '--update');
  if (paths.length === 0) return all || update ? { under: ['/'], tracked: update && !all } : undefined;
  // git add . or a folder: what is under it. A path with a dot in its last part is taken for a file, named by itself.
  const folders = paths.filter((path) => path === '.' || path === ':/' || path.endsWith('/') || !/\.[^/]+$/.test(path.split('/').at(-1) ?? ''));
  if (folders.length === 0) return undefined;
  return { under: folders.map((path) => (path === ':/' ? '/' : resolve(dir, path))), tracked: update && !all };
}

/** Whether a path is a folder or under it; "/" holds everything. */
const inside = (path: string, dir: string): boolean => dir === '/' || path === dir || path.startsWith(`${dir}/`);

/** `git status --porcelain=v1 -z --untracked-files=all` of a working tree: its changed files, absolute. */
export function parseStatus(text: string, repo: string): DirtyFile[] {
  const out: DirtyFile[] = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    out.push({ path: join(repo, entry.slice(3)), untracked: code === '??' });
    // A rename or a copy: the old path follows, as an entry of its own.
    if (code[0] === 'R' || code[0] === 'C') i++;
  }
  return out;
}
