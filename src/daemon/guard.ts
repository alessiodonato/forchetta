import { isAbsolute, relative, resolve } from 'node:path';
import type { Agent, GuardHold } from '../shared/agent.ts';
import { displayName } from '../shared/agent.ts';
import type { HookPayload } from './state.ts';

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
// The guard answers from memory, at once. With nothing to say it says nothing, and the tool goes on as usual.

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/**
 * A file stays held this long after its last write when the session is between turns: a subagent in the
 * background can still be changing it. In a turn, it is held until the turn ends.
 */
export const HOLD_AFTER_TURN_MS = 2 * 60_000;
/** A session that changed files in a working tree this recently still works there, for the git guard. */
export const WORKS_THERE_MS = 60 * 60_000;

export interface GuardDecision {
  decision: 'deny' | 'ask';
  /** For "deny" Claude reads it; for "ask" you do, in the dialog. */
  reason: string;
}

/** What Claude Code reads on the stdout of a PreToolUse hook. */
export const hookOutput = (decision: GuardDecision): object => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.decision, permissionDecisionReason: decision.reason },
});

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

/**
 * The words of a shell line, split into simple commands at ;, &, |, &&, || and newlines, with quotes and
 * backslashes taken away. A plain reading: no expansions, no subshells. Undefined when a quote is left open.
 */
export function shellCommands(line: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\') {
      if (i + 1 < line.length && line[i + 1] !== '\n') {
        word += line[++i];
        inWord = true;
      } else i++;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && j + 1 < line.length) word += line[++j];
        else word += line[j];
      }
      if (j >= line.length) return undefined;
      inWord = true;
      i = j;
    } else if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') {
      endCommand();
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
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
    let i = 0;
    // VAR=value before the command, and the words that only run it: command, exec, env, nice, time.
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || ['command', 'exec', 'env', 'nice', 'time', 'nohup'].includes(words[i]!))) i++;
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
  /** What is on, from var/config.json. */
  enabled: () => { files: boolean; git: boolean };
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
    if (file) return enabled.files ? this.decideFile(agent, file) : undefined;
    if (payload.tool_name === 'Bash' && enabled.git && cwd) {
      const command = (payload.tool_input as { command?: unknown } | undefined)?.command;
      if (typeof command === 'string') return this.decideGit(agent, command, cwd);
    }
    return undefined;
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
