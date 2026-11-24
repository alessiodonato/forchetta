import type { Agent } from '../shared/agent.ts';
import { systemTool } from '../shared/platform.ts';
import { type GuardDecision, ONCE_MS, otherName } from './guard.ts';
import { shellLine } from './powershell.ts';
import { windowsLook } from './windows-processes.ts';
import { WINDOWS } from '../shared/fspath.ts';
import { isDevServerCommand, killTargets, placedCommands } from './shell.ts';
import type { HookPayload } from './state.ts';

// One dev server for a folder, shared by its sessions. With worktrees each agent needs its own server on its own
// port; in one folder they can all use the same one, which reloads by itself when any of them changes a file. So
// before a command that starts a dev server, the guard looks for a server already listening whose folder is that
// one: if there is, Claude is told its address and who started it, once (the same command again goes through, for a
// second server on another port). And before kill, pkill, killall or the kill of a port, it looks at what would be
// stopped: a process started by another Claude Code session (its dev server, or the session itself) asks you first.
//
// Which session started a process: the Claude Code process of a session among its parents (ps). A server started in
// the background of a shell that ended has no parent left but launchd: it counts as started outside Claude Code. On
// Windows the folder of a process is not told: what its command line names is (daemon/windows-processes.ts).

// On a Mac lsof is in /usr/sbin, on Linux in /usr/bin, if it is installed at all: without it nothing is found.
const LSOF = systemTool('lsof');
const PS = systemTool('ps');
const PGREP = systemTool('pgrep');

export interface ProcessRow {
  ppid: number;
  name: string;
}

/** `ps -axo pid=,ppid=,comm=`: each process with its parent and the name of its program. */
export function parsePs(text: string): Map<number, ProcessRow> {
  const out = new Map<number, ProcessRow>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) out.set(Number(match[1]), { ppid: Number(match[2]), name: match[3]!.split('/').at(-1) ?? match[3]! });
  }
  return out;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: the TCP ports each process listens on. */
export function parseListening(text: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let pid: number | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined) {
      const port = /:(\d+)$/.exec(line);
      if (!port) continue;
      const ports = out.get(pid) ?? [];
      if (!ports.includes(Number(port[1]))) ports.push(Number(port[1]));
      out.set(pid, ports);
    }
  }
  return out;
}

/** `lsof -a -p <pids> -d cwd -Fn`: the folder each process works in. */
export function parseCwds(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined) out.set(pid, line.slice(1));
  }
  return out;
}

/** The session whose Claude Code process is this process or one of its parents. */
export function ownerOf(pid: number, processes: ReadonlyMap<number, ProcessRow>, agents: Iterable<Agent>): Agent | undefined {
  const byPid = new Map<number, Agent>();
  for (const agent of agents) if (agent.pid !== undefined && agent.state !== 'ended') byPid.set(agent.pid, agent);
  let current: number | undefined = pid;
  for (let steps = 0; current !== undefined && current > 1 && steps < 64; steps++) {
    const agent = byPid.get(current);
    if (agent) return agent;
    current = processes.get(current)?.ppid;
  }
  return undefined;
}

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

/** How the processes are looked at: with lsof, ps and pgrep; on Windows with its own programs (daemon/windows-processes.ts). */
export interface Look {
  listening(): Promise<Map<number, number[]>>;
  processes(): Promise<Map<number, ProcessRow>>;
  /** The processes when the folders need them too: Windows. Empty elsewhere. */
  table(): Promise<Map<number, ProcessRow>>;
  /** The folder each process works in, as far as it is known. */
  folders(pids: number[], scope: string, table: ReadonlyMap<number, ProcessRow>): Promise<Map<number, string>>;
  /** The processes a kill by name or pattern would stop, as pgrep takes them. */
  matching(pattern: string[]): Promise<number[]>;
}

export const unixLook = (run: ServersOptions['run']): Look => ({
  listening: async () => parseListening((await run(LSOF, ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])) ?? ''),
  processes: async () => parsePs((await run(PS, ['-axo', 'pid=,ppid=,comm='])) ?? ''),
  table: async () => new Map(),
  folders: async (pids) => parseCwds((await run(LSOF, ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'])) ?? ''),
  matching: async (pattern) => ((await run(PGREP, pattern)) ?? '').split(/\s+/).filter((word) => /^\d+$/.test(word)).map(Number),
});

export interface ServersOptions {
  agents: () => Iterable<Agent>;
  /** The working tree of a folder (daemon/conflicts.ts). */
  repoOf: (dir: string) => string | undefined;
  /** On for this session: var/config.json, and .forchetta/guard.json of its repository. */
  enabled: (agent: Agent) => boolean;
  /** Runs a program and gives its output, also when it exits with an error; undefined when it cannot run. */
  run: (file: string, args: string[]) => Promise<string | undefined>;
  look?: Look;
  /** The pid of the daemon: it listens too, and in a clone of Forchetta it works in the folder, but it is no dev server. */
  self?: number;
  now?: () => number;
}

export class Servers {
  private readonly warned = new Map<string, number>();
  private readonly now: () => number;
  private readonly look: Look;

  constructor(private readonly options: ServersOptions) {
    this.now = options.now ?? Date.now;
    this.look = options.look ?? (WINDOWS ? windowsLook(options.run) : unixLook(options.run));
  }

  async decide(agent: Agent, payload: HookPayload): Promise<GuardDecision | undefined> {
    const line = shellLine(payload);
    if (payload.hook_event_name !== 'PreToolUse' || line === undefined || agent.state === 'ended' || !this.options.enabled(agent)) return undefined;
    const cwd = agent.cwd ?? payload.cwd;
    if (!cwd) return undefined;
    const kill = await this.decideKill(agent, line);
    if (kill) return kill;
    const start = placedCommands(line, cwd).find((command) => isDevServerCommand(command.words));
    return start ? this.decideStart(agent, line, start.dir) : undefined;
  }

  /** A dev server about to start where one already listens: its address, once. */
  private async decideStart(agent: Agent, line: string, dir: string): Promise<GuardDecision | undefined> {
    const scope = this.options.repoOf(dir) ?? dir;
    const listening = await this.look.listening();
    if (listening.size === 0) return undefined;
    const table = await this.look.table();
    const cwds = await this.look.folders([...listening.keys()], scope, table);
    // A server of this folder: it works inside the working tree, in the folder of the command, above it or under it.
    const servers = [...listening].filter(([pid]) => {
      if (pid === (this.options.self ?? process.pid)) return false;
      const where = cwds.get(pid);
      return where !== undefined && inside(where, scope) && (inside(where, dir) || inside(dir, where));
    });
    if (servers.length === 0) return undefined;
    if (!this.firstTime(agent.id, `start\n${line}`)) return undefined;
    const processes = table.size > 0 ? table : await this.look.processes();
    const described = servers.slice(0, 3).map(([pid, ports]) => {
      const owner = ownerOf(pid, processes, this.options.agents());
      const by = !owner ? 'started outside Claude Code' : owner.id === agent.id ? 'started by you earlier' : `started by "${otherName(owner, agent)}", another Claude Code session`;
      const urls = ports
        .sort((a, b) => a - b)
        .slice(0, 3)
        .map((port) => `http://localhost:${port}`)
        .join(', ');
      return `${urls} (${processes.get(pid)?.name ?? 'pid'} ${pid}, ${by})`;
    });
    return {
      decision: 'deny',
      reason:
        `Forchetta: a dev server of this folder is already running: ${described.join('; ')}. ` +
        'It picks up changes to the files by itself: use it rather than starting another one. ' +
        'If you do need a second server, start it on another port with the same command again: it will go through.',
    };
  }

  /** A kill of processes that another Claude Code session started, or of the session itself: you decide. */
  private async decideKill(agent: Agent, line: string): Promise<GuardDecision | undefined> {
    const targets = killTargets(line);
    if (!targets) return undefined;
    const pids = new Set(targets.pids);
    for (const pattern of targets.patterns) for (const pid of await this.look.matching(pattern)) pids.add(pid);
    if (targets.ports.length > 0) {
      const listening = await this.look.listening();
      for (const [pid, ports] of listening) if (ports.some((port) => targets.ports.includes(port))) pids.add(pid);
    }
    if (pids.size === 0) return undefined;
    const processes = await this.look.processes();
    const hit: string[] = [];
    for (const pid of pids) {
      const owner = ownerOf(pid, processes, this.options.agents());
      if (!owner || owner.id === agent.id) continue;
      const name = processes.get(pid)?.name ?? 'a process';
      hit.push(owner.pid === pid ? `the Claude Code session "${otherName(owner, agent)}" itself (pid ${pid})` : `${name} (pid ${pid}), started by "${otherName(owner, agent)}", another Claude Code session`);
    }
    if (hit.length === 0) return undefined;
    return {
      decision: 'ask',
      reason: `Forchetta: this would stop ${hit.slice(0, 3).join('; ')}${hit.length > 3 ? ` and ${hit.length - 3} more` : ''}.`,
    };
  }

  private firstTime(agentId: string, key: string): boolean {
    const now = this.now();
    for (const [known, at] of this.warned) if (now - at >= ONCE_MS) this.warned.delete(known);
    const full = `${agentId}\n${key}`;
    if (this.warned.delete(full)) return false;
    this.warned.set(full, now);
    return true;
  }
}
