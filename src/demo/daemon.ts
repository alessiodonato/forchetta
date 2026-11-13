// The daemon of the demo: the modules of the real daemon, put together as daemon/main.ts does, around fake
// sessions. Registry, Hub, Guard, Conflicts, Commander, Permissions, Crews, Attention and the changes of the files
// are the real ones; tmux and Claude Code are the fakes of this folder, and the files live in memory.

import type { Agent, GuardHold, SubagentStep } from '../shared/agent.ts';
import { displayName } from '../shared/agent.ts';
import { addArtifact, artifactOf } from '../shared/artifacts.ts';
import { cleanCrewSpec } from '../shared/crew.ts';
import { subagentKey } from '../shared/present.ts';
import { tmuxSessionName } from '../shared/tmux.ts';
import { Attention } from '../daemon/attention.ts';
import { Commander } from '../daemon/commands.ts';
import { Conflicts, writtenFile } from '../daemon/conflicts.ts';
import { crewApi, Crews, CrewTemplates } from '../daemon/crews.ts';
import { changesOf } from '../daemon/diffs.ts';
import { Guard } from '../daemon/guard.ts';
import { Hub } from '../daemon/hub.ts';
import { editOf, Patches } from '../daemon/patches.ts';
import { Permissions } from '../daemon/permissions.ts';
import { Registry } from '../daemon/registry.ts';
import { claudeArgs, folderOf, type SpawnExtras, type SpawnResult } from '../daemon/spawn.ts';
import type { HookPayload } from '../daemon/state.ts';
import { applySubagentHook, subagentResultOf } from '../daemon/subagents.ts';
import { Teams } from '../daemon/teams.ts';
import { type ClaudeHost, FakeClaude, type PermissionHandle, type SubagentScript, type TeamTools } from './claude.ts';
import { commit, repoRoot } from './git.ts';
import { existsSync, filesUnder, isDir, putFile, readText } from './shims/fs.ts';
import { type DemoSocket, HubSide, routeSockets } from './socket.ts';
import { FakeTerminal } from './terminal.ts';
import { FakeTmux } from './tmux.ts';

const TOKEN = 'demo';
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A response of node:http, enough for Permissions: the hook of a permission waits on it. */
class HookResponse {
  writableEnded = false;
  headersSent = false;
  private readonly closers: Array<() => void> = [];
  constructor(private readonly done: (text: string) => void) {}
  writeHead(): this {
    this.headersSent = true;
    return this;
  }
  end(text = ''): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.done(text);
  }
  on(event: string, handler: () => void): this {
    if (event === 'close') this.closers.push(handler);
    return this;
  }
  /** The hook went away: No or Esc in the terminal. */
  drop(): void {
    if (this.writableEnded) return;
    for (const handler of this.closers) handler();
    this.writableEnded = true;
  }
}

export interface DemoEvents {
  /** A notification of macOS, as the app would show it. */
  notify?: (notice: { agentId: string; kind: string; title: string; body: string }) => void;
}

export class DemoDaemon {
  readonly registry: Registry;
  readonly tmux = new FakeTmux();
  readonly claudes = new Map<string, FakeClaude>();
  readonly terminals = new Map<string, FakeTerminal>();
  readonly conflicts = new Conflicts({ hasGit: (dir) => existsSync(`${dir}/.git`) });
  readonly crews = new Crews(undefined);
  readonly templates = new CrewTemplates(undefined);
  readonly teams = new Teams(undefined);
  readonly patches = new Patches('/forchetta/var/patches');
  readonly guard: Guard;
  readonly commander: Commander;
  readonly permissions: Permissions;
  readonly attention: Attention;
  readonly hub: Hub;
  /** Turn the guard off, to see what happens without it. */
  guardOn = true;
  /** Permission dialogs answered, in the box or in the terminal: for the tour. */
  permissionsAnswered = 0;
  /** A session the guard held back was told its file is free: for the tour. */
  onFreed: (waiterId: string) => void = () => {};
  private nextPid = 51_000;
  private readonly notices = new Map<string, { commandId: string; paths: Set<string> }>();
  /** The transcripts of the subagents, by agent and subagent key. */
  private readonly threads = new Map<string, { steps: SubagentStep[]; model?: string }>();
  private conflictsTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly events: DemoEvents = {}) {
    this.registry = new Registry({
      onChange: (agent) => {
        this.hub?.agentChanged(agent);
        this.commander?.agentChanged(agent);
        this.permissions?.agentChanged(agent);
        this.attention?.agentChanged(agent);
        if (agent.state === 'ended' && agent.conflicts) this.updateConflicts();
        if (agent.state === 'ended') this.guard?.ended(agent);
        if (this.teams.apply(agent)) this.registry.touch(agent);
      },
      onRemove: (ids) => {
        this.hub?.agentsRemoved(ids);
        this.attention?.forget(ids);
        for (const id of ids) this.conflicts.forget(id);
        this.teams.forget(ids);
      },
    });
    this.guard = new Guard({
      agents: () => this.registry.agents.values(),
      repoOf: (dir) => this.conflicts.repoOf(dir),
      writesOf: (agentId) => this.conflicts.filesOf(agentId),
      enabled: () => ({ files: this.guardOn, git: this.guardOn }),
      touch: (agent) => this.registry.touch(agent),
      onFree: (waiter, files, by) => this.freed(waiter, files, by),
    });
    this.commander = new Commander({
      registry: this.registry,
      tmux: this.tmux,
      log: (message) => console.debug(`[demo] ${message}`),
      // Faster than in the app: the demo has no network and no slow terminal.
      pasteSettleMs: 400,
      settleMs: 600,
      typingQuietMs: 4000,
      onRequest: (_agent, command) => this.crews.commandChanged(command),
    });
    this.crews.inGit = (dir) => repoRoot(dir) !== undefined;
    this.crews.gitInfo = (dir) => ({ root: repoRoot(dir), branch: 'main' });
    this.crews.agent = (agentId) => this.registry.agents.get(agentId);
    this.crews.enqueue = (agentId, text, link) => this.commander.enqueueRequest(agentId, text, link);
    this.crews.onChange = () => this.hub.crewsChanged();
    this.permissions = new Permissions({
      registry: this.registry,
      interactive: async () => true,
      status: async (agent) => agent.state,
      log: (message) => console.debug(`[demo] ${message}`),
    });
    this.attention = new Attention({
      notify: (notice) => {
        this.hub.notify(notice);
        this.events.notify?.(notice);
      },
    });
    this.hub = new Hub({
      token: TOKEN,
      port: () => 0,
      snapshot: () => this.registry.list(),
      settings: () => ({ replace: 'lru', arricurdaiNotes: false }),
      log: (message) => console.debug(`[demo] ${message}`),
      onCommand: (message) => {
        if (message.type === 'cancel') return this.commander.cancel(message.agentId, message.commandId);
        this.commander.enqueue(message.agentId, message.kind, message.arg, message.confirmed, message.fromSelection === true);
      },
      onPermission: (message) => void this.permissions.decide(message.agentId, message.ticket, message.behavior, message.always),
      onLetThrough: (agentId, path) => void this.guard.letThrough(agentId, path),
      onSpawn: (input) => this.spawn(input),
      onTeam: (agentId, team) => {
        const agent = this.registry.agents.get(agentId);
        if (!agent) return;
        this.teams.set(agent, team);
        this.registry.touch(agent);
      },
      onFiles: (agentId) => changesOf(this.conflicts.filesOf(agentId), this.patches.byFile(agentId)),
      onSubagent: async (agentId, key) => {
        const thread = this.threads.get(`${agentId}:${key}`);
        return thread ? { steps: thread.steps, model: thread.model } : { steps: [], note: 'Its transcript is not there yet: it shows with its first step.' };
      },
      crews: () => this.crews.summaries(),
      crewThread: (crewId) => this.crews.thread(crewId),
      onCrewRequest: (crewId, to, text) => this.crews.request(crewId, to, text),
      templates: () => this.templates.list(),
      onTemplate: (message) => (message.type === 'deleteCrewTemplate' ? this.templates.delete(message.name) : this.templates.save(message.template)),
      onCreateCrew: async (input) => {
        const checked = cleanCrewSpec(input);
        if ('error' in checked) return { ok: false, error: checked.error };
        checked.spec.cwd = folderOf(checked.spec.cwd) ?? checked.spec.cwd;
        if (!isDir(checked.spec.cwd)) return { ok: false, error: `${checked.spec.cwd} does not exist: in the demo, use the folder of your project` };
        return this.crews.create(checked.spec, (start, extras) => this.spawn(start, extras));
      },
      onEditCrew: async (message) => {
        const place = (agentId: string, team: Agent['team']): void => {
          const agent = this.registry.agents.get(agentId);
          if (!agent) return;
          agent.team = team;
          this.registry.touch(agent);
        };
        if (message.action === 'talk' && message.name && (message.talk === 'oneway' || message.talk === 'twoway')) {
          const result = this.crews.setTalk(message.crewId, message.name, message.talk);
          if (result.ok) for (const change of result.changes) place(change.agentId, { ...this.registry.agents.get(change.agentId)?.team, talk: change.talk });
          return result;
        }
        if (message.action === 'remove' && message.name) {
          const result = this.crews.removeMember(message.crewId, message.name, (agentId, commandId) => this.commander.cancel(agentId, commandId));
          if (result.ok && result.agentId) place(result.agentId, undefined);
          return result;
        }
        if (message.action === 'add') return this.crews.addMember(message.crewId, message.member, (start, extras) => this.spawn(start, extras));
        return { ok: false, error: 'unknown change' };
      },
      onRecall: async () => ({ ok: false, error: 'Searching earlier sessions needs arricurdAI: not in the demo.' }),
      onSelection: async (agentId, phase) => (phase === 'end' ? (window.forchettaDebug?.terminals.get(agentId) as { getSelection?: () => string } | undefined)?.getSelection?.() || undefined : undefined),
      onAsk: (agentId, text, fromSelection) => {
        const result = this.commander.enqueueAsk(agentId, text, fromSelection);
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      },
      onInsert: (agentId, text) => this.commander.insert(agentId, text),
    });

    routeSockets((url, socket) => this.connect(url, socket));
  }

  // ---- The sockets of the page ---------------------------------------------------------------------------

  private connect(url: URL, socket: DemoSocket): void {
    if (url.searchParams.get('token') !== TOKEN) return socket.end(1008);
    if (url.pathname.endsWith('/ws')) {
      socket.open();
      // The real Hub takes the page from here, as after the upgrade of a WebSocket.
      (this.hub as unknown as { accept(ws: unknown): void }).accept(new HubSide(socket));
      return;
    }
    if (url.pathname.endsWith('/term')) {
      const terminal = this.terminals.get(url.searchParams.get('agent') ?? '');
      if (!terminal) return socket.end(4000);
      const cols = Number(url.searchParams.get('cols'));
      const rows = Number(url.searchParams.get('rows'));
      if (cols > 0 && rows > 0 && (cols !== terminal.cols || rows !== terminal.rows)) {
        terminal.cols = cols;
        terminal.rows = rows;
        terminal.onResize();
      }
      terminal.attach(socket);
      return;
    }
    socket.end(1008);
  }

  // ---- Sessions ------------------------------------------------------------------------------------------

  /** A name for a session, as ✎ in its box gives it, but not remembered for its folder: two sessions of the demo share one. */
  label(agentId: string, label: string): void {
    const agent = this.registry.agents.get(agentId);
    if (!agent) return;
    agent.team = { ...agent.team, label };
    this.registry.touch(agent);
  }

  /** A new session, as daemon/spawn.ts starts one: a pane of the fake tmux with a fake Claude in it. */
  async spawn(input: { cwd: string; prompt?: string; model?: unknown; mode?: unknown; worktree?: unknown }, extras: SpawnExtras = {}): Promise<SpawnResult> {
    const folder = folderOf(input.cwd);
    if (!folder) return { ok: false, error: 'the folder must be absolute or start with ~' };
    if (!isDir(folder)) return { ok: false, error: `${folder.replace('/Users/you', '~')} does not exist: in the demo, use the folder of your project` };
    const args = claudeArgs({ model: input.model, mode: input.mode, worktree: input.worktree });
    if ('error' in args) return { ok: false, error: args.error };
    let cwd = folder;
    const worktree = input.worktree === true ? `wt-${Math.random().toString(36).slice(2, 7)}` : typeof input.worktree === 'string' && input.worktree.trim() ? input.worktree.trim() : undefined;
    if (worktree) {
      const root = repoRoot(folder);
      if (!root) return { ok: false, error: 'a worktree needs a git repository' };
      cwd = this.worktree(root, worktree);
    }
    const id = crypto.randomUUID();
    const session = tmuxSessionName(id);
    const agent = this.registry.register({ id, cwd, tmuxSession: session });
    if (extras.team) {
      agent.team = { ...extras.team };
      this.registry.touch(agent);
    }
    const terminal = new FakeTerminal();
    const pid = this.nextPid++;
    const claude = new FakeClaude({ id, pid, cwd, terminal, host: this.host, name: extras.name, model: typeof input.model === 'string' ? input.model : undefined, mode: typeof input.mode === 'string' ? input.mode : undefined, firstPrompt: input.prompt?.trim() || undefined });
    const pane = this.tmux.add({ session, pid, terminal, type: (data) => terminal.onInput(data) });
    claude.pane = pane.pane;
    claude.session = session;
    this.terminals.set(id, terminal);
    this.claudes.set(id, claude);
    claude.start();
    return { ok: true, agentId: id };
  }

  /** A git worktree of the demo: a copy of the files of the repository, on a branch of its own. */
  private worktree(root: string, name: string): string {
    const dir = `${root}/.claude/worktrees/${name}`;
    if (existsSync(dir)) return dir;
    const files = new Map<string, string>();
    for (const path of filesUnder(root)) {
      const rel = path.slice(root.length + 1);
      if (rel.startsWith('.git/') || rel.startsWith('.claude/') || rel.startsWith('dist/')) continue;
      const text = readText(path) ?? '';
      putFile(`${dir}/${rel}`, text);
      files.set(rel, text);
    }
    putFile(`${dir}/.git`, `gitdir: ${root}/.git/worktrees/${name}\n`);
    commit(dir, files);
    return dir;
  }

  /** What the fake sessions ask of the daemon. */
  private readonly host: ClaudeHost = {
    hook: (claude, event, extra = {}) => this.hook(claude, event, extra),
    guard: (claude, tool, input) => {
      const agent = this.registry.agents.get(claude.id);
      if (!agent) return undefined;
      const decision = this.guard.decide(agent, { hook_event_name: 'PreToolUse', session_id: claude.sessionId, cwd: claude.cwd, tool_name: tool, tool_input: input });
      return decision && (decision.decision === 'deny' || decision.decision === 'ask') ? { decision: decision.decision, reason: decision.reason } : undefined;
    },
    permission: (claude, payload) => this.permission(claude, payload),
    status: (claude) => {
      const agent = this.registry.agents.get(claude.id);
      if (!agent || !claude.sessionId) return;
      const tokens = claude.contextTokens;
      this.registry.status(claude.sessionId, { pid: claude.pid, pane: claude.pane, agentId: claude.id }, { usd: claude.usd, context: tokens === null ? null : { tokens, window: claude.contextWindow, percent: Math.min(100, Math.round((tokens / claude.contextWindow) * 100)) } });
    },
    team: (claude) => this.teamTools(claude),
    subagent: (claude, script, toolUseId) => this.subagent(claude, script, toolUseId),
    ended: (claude) => {
      this.tmux.remove(claude.pane);
      this.claudes.delete(claude.id);
    },
  };

  /** A hook of a fake session, as the server of the daemon takes it, and what daemon/main.ts does after. */
  private hook(claude: FakeClaude, event: string, extra: Record<string, unknown>): void {
    const raw = { session_id: claude.sessionId, cwd: claude.cwd, transcript_path: `/Users/you/.claude/projects/demo/${claude.sessionId}.jsonl`, hook_event_name: event, ...extra };
    const payload = slim(raw);
    const agent = this.registry.hook(payload, { pid: claude.pid, pane: claude.pane, agentId: claude.id });
    this.commander.hook(agent, payload);
    this.crews.hook(agent, payload);
    this.permissions.hook(agent, payload);
    const edit = editOf(payload, agent.cwd, Date.now());
    if (edit) this.patches.add(agent.id, edit);
    if (payload.artifact) {
      agent.artifacts = addArtifact(agent.artifacts, { ...payload.artifact, at: Date.now() });
      this.registry.touch(agent);
    }
    if (applySubagentHook(agent, payload, Date.now(), () => undefined)) this.registry.touch(agent);
    const file = writtenFile(payload, agent.cwd);
    if (file) {
      this.guard.wrote(agent, file);
      const notice = this.notices.get(agent.id);
      if (notice?.paths.has(file)) {
        this.commander.cancel(agent.id, notice.commandId);
        this.notices.delete(agent.id);
      }
    }
    this.guard.hook(agent, payload);
    if (file) {
      this.conflicts.wrote(agent.id, file);
      this.updateConflicts();
      const count = this.conflicts.count(agent.id);
      if (agent.filesChanged !== count) {
        agent.filesChanged = count;
        this.registry.touch(agent);
      }
    }
  }

  private updateConflicts(): void {
    this.conflictsTimer ??= setTimeout(() => {
      this.conflictsTimer = undefined;
      for (const agent of this.conflicts.update(this.registry.agents.values())) this.registry.touch(agent);
    }, 50);
  }

  /** A file the guard held back is free: the session that waited is told, in its terminal (daemon/main.ts). */
  private freed(waiter: Agent, files: GuardHold[], by: Agent): void {
    const names = files.map((file) => file.file);
    const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
    const byName = files[0]?.withName ?? displayName(by);
    const earlier = this.notices.get(waiter.id);
    if (earlier) this.commander.cancel(waiter.id, earlier.commandId);
    const text = `Forchetta: ${list} ${names.length === 1 ? 'is' : 'are'} free now ("${byName}" ended its turn). You can go on.`;
    const result = this.commander.enqueueFree(waiter.id, text);
    this.onFreed(waiter.id);
    if (result.ok) this.notices.set(waiter.id, { commandId: result.command.id, paths: new Set([...(earlier?.paths ?? []), ...files.map((file) => file.path)]) });
  }

  /** A permission dialog, held by the real Permissions: the box answers through it, the terminal on its own. */
  private permission(claude: FakeClaude, extra: Record<string, unknown>): PermissionHandle {
    this.hook(claude, 'PermissionRequest', extra);
    let resolveAnswer: (answer: { behavior: 'allow' | 'deny'; always: boolean } | undefined) => void = () => {};
    const answer = new Promise<{ behavior: 'allow' | 'deny'; always: boolean } | undefined>((resolve) => (resolveAnswer = resolve));
    void answer.then((given) => {
      if (given) this.permissionsAnswered += 1;
    });
    let response: HookResponse | undefined;
    const agent = this.registry.agents.get(claude.id);
    if (agent) {
      const payload = slim({ session_id: claude.sessionId, cwd: claude.cwd, hook_event_name: 'PermissionRequest', ...extra });
      void this.permissions.open(agent, payload, 600).then((ticket) => {
        if (!ticket) return resolveAnswer(undefined);
        response = new HookResponse((text) => {
          if (!text) return resolveAnswer(undefined);
          try {
            const decision = (JSON.parse(text) as { hookSpecificOutput?: { decision?: { behavior?: string; updatedPermissions?: unknown[] } } }).hookSpecificOutput?.decision;
            resolveAnswer(decision?.behavior === 'allow' ? { behavior: 'allow', always: (decision.updatedPermissions?.length ?? 0) > 0 } : { behavior: 'deny', always: false });
          } catch {
            resolveAnswer(undefined);
          }
        });
        this.permissions.attach(ticket, response as never);
      });
    }
    return {
      answer,
      answeredInTerminal: (yes) => {
        // "Yes" leaves the hook waiting until the PostToolUse of the call; "No" ends it.
        this.permissionsAnswered += 1;
        if (!yes) response?.drop();
        resolveAnswer(undefined);
      },
    };
  }

  /** The tools of the team of a session, as the MCP server of a team gives them (daemon/crews.ts, crewApi). */
  private teamTools(claude: FakeClaude): TeamTools | undefined {
    const me = this.crews.whoami(claude.id);
    if (!me) return undefined;
    const call = async (route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => (await crewApi(this.crews, route, { agent: claude.id, ...body }, 1500)).body as Record<string, unknown>;
    return {
      members: () => (me.role === 'lead' ? me.crew.members.map((member) => ({ name: member.name, answers: (member.talk ?? me.crew.talk) === 'twoway' })) : []),
      send: (to, text) => {
        const result = this.crews.requestFromLead(claude.id, to, text);
        return result.ok ? { ok: true, n: result.n, to: result.to } : { ok: false, error: result.error };
      },
      wait: async (requests) => {
        const started = await call('wait', { requests, minutes: 10 });
        if (!started.ok) return String(started.error ?? 'the wait did not start');
        for (;;) {
          const polled = await call('wait-poll', { id: started.id });
          if (!polled.ok) return String(polled.error ?? 'the wait ended');
          if (polled.done) {
            const answers = (polled.answers ?? []) as Array<{ n: number; from: string; status: string; answer?: string }>;
            return answers.map((item) => `${item.from}, #${item.n}: ${item.answer ? `${item.answer.slice(0, 90).trim()}…` : item.status}`).join('\n') || 'No answer';
          }
          await wait(300);
        }
      },
      ask: (text) => {
        const result = this.crews.question(claude.id, text);
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      },
    };
  }

  /** A subagent at work: its hooks, as Claude Code sends them, and its transcript for the panel. */
  private async subagent(claude: FakeClaude, script: SubagentScript, toolUseId: string): Promise<string> {
    const agent = this.registry.agents.get(claude.id);
    const id = `a${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const subagent = agent?.subagents?.find((candidate) => candidate.toolUseId === toolUseId);
    const steps: SubagentStep[] = [{ kind: 'prompt', text: script.prompt, at: Date.now() }];
    if (agent && subagent) {
      subagent.id = id;
      subagent.transcript = `/Users/you/.claude/projects/demo/${claude.sessionId}/subagents/agent-${id}.jsonl`;
      this.threads.set(`${agent.id}:${subagentKey(subagent)}`, { steps, model: 'claude-haiku-5-5' });
      this.registry.touch(agent);
    }
    const base = { agent_id: id, agent_type: script.type };
    this.hook(claude, 'SubagentStart', base);
    await wait(900);
    for (const step of script.steps) {
      const stepId = `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      this.hook(claude, 'PreToolUse', { ...base, tool_name: step.tool, tool_input: step.input, tool_use_id: stepId });
      steps.push({ kind: 'tool', label: step.label, family: step.family, at: Date.now() });
      await wait(1700);
      const last = steps.at(-1);
      if (last?.kind === 'tool') last.result = step.result;
      this.hook(claude, 'PostToolUse', { ...base, tool_name: step.tool, tool_input: step.input, tool_use_id: stepId, tool_response: {} });
    }
    await wait(800);
    steps.push({ kind: 'report', text: script.report, at: Date.now() });
    this.hook(claude, 'SubagentStop', base);
    return id;
  }
}

/** The hook input as daemon/server.ts keeps it (slimPayload): only what Forchetta reads. */
function slim(input: Record<string, unknown>): HookPayload {
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const event = String(input.hook_event_name);
  const tool = text(input.tool_name);
  return {
    hook_event_name: event,
    session_id: String(input.session_id),
    transcript_path: text(input.transcript_path),
    cwd: text(input.cwd),
    source: text(input.source),
    reason: text(input.reason),
    model: text(input.model),
    prompt: text(input.prompt),
    tool_name: tool,
    tool_input: input.tool_input,
    notification_type: text(input.notification_type),
    message: text(input.message),
    last_assistant_message: text(input.last_assistant_message),
    error: input.error,
    error_details: input.error_details,
    trigger: text(input.trigger),
    agent_id: text(input.agent_id),
    agent_type: text(input.agent_type),
    tool_use_id: text(input.tool_use_id),
    subagent_result: event === 'PostToolUse' ? subagentResultOf(tool, input.tool_response) : undefined,
    permission_suggestions: event === 'PermissionRequest' ? input.permission_suggestions : undefined,
    tool_response: event === 'PostToolUse' && tool && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) ? input.tool_response : undefined,
    artifact: event === 'PostToolUse' ? artifactOf(tool, input.tool_input, input.tool_response) : undefined,
  };
}
