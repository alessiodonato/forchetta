import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { migrateData, readDataJson, writeDataJson } from '../shared/data-file.ts';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { contextWindowOf, detectArricurdai, loadConfig, resolveTool } from '../shared/config.ts';
import { claudeConfigDir, ensurePrivateDir, paths, ROOT } from '../shared/paths.ts';
import { listPanes, Tmux } from '../shared/tmux.ts';
import { VERSION } from '../shared/version.ts';
import { ArricurdaiNotes, ArricurdaiPoller, readArricurdaiStatus } from './arricurdai.ts';
import { isAlive, readClaudeAgents } from './claude-agents.ts';
import { ClaudeUpdates } from './claude-update.ts';
import { QuickPrompts } from './prompts.ts';
import { SelectionReader } from './selection.ts';
import { Commander } from './commands.ts';
import { Attention } from './attention.ts';
import { Conflicts, writtenFile } from './conflicts.ts';
import { type GuardDecision, Guard, hookOutput, otherName, parseStatus } from './guard.ts';
import { GuardStats } from './guard-stats.ts';
import { Loops } from './loops.ts';
import { changedNote, Coherence } from './coherence.ts';
import { Servers } from './servers.ts';
import { changesOf } from './diffs.ts';
import { editOf, Patches } from './patches.ts';
import { runRecall } from './recall.ts';
import { folderOf, inGitRepo, spawnSession } from './spawn.ts';
import { Teams } from './teams.ts';
import { crewApi, CrewTemplates, Crews, RolePresets, templateApi } from './crews.ts';
import { CustomSkills, skillUsers } from './custom-skills.ts';
import { FolderChooser } from './folder-chooser.ts';
import { importTeam, saveTeamFile } from './team-files.ts';
import { TokenCounter } from './token-usage.ts';
import { gitRunner, SkillCache } from './skills.ts';
import { cleanCrewSpec, templateOf } from '../shared/crew.ts';
import { mcpConfigFile } from '../shared/mcp-config.ts';
import { Hub } from './hub.ts';
import { Permissions } from './permissions.ts';
import { isInteractiveCommand, readCommandLine } from './process.ts';
import { Registry } from './registry.ts';
import { createDaemonServer } from './server.ts';
import { addArtifact, mergeArtifacts } from '../shared/artifacts.ts';
import { artifactsInTranscript } from './transcript-artifacts.ts';
import { promptEndingIn, transcriptTail } from './prompt-ending.ts';
import { anySubagentActive, applySubagentHook, checkSubagents, readSubagentThread } from './subagents.ts';
import { sameTokens, subagentKey, sumTokens } from '../shared/present.ts';
import { PANE_MODES_FORMAT, paneModes, scrolledBack } from './scrollback.ts';
import { type Agent, startsTurn } from './state.ts';
import { displayName, type GuardHold } from '../shared/agent.ts';
import { haikuComplete, Summarizer } from './summarizer.ts';
import { Limits } from './limits.ts';
import { Terminals } from './terminals.ts';

// forchetta-daemon: one process, driven by events. It never ends a Claude process or a tmux session: when it
// stops, the sessions go on, and the next daemon finds them again.

const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);

const LIVENESS_MS = 5_000;
const QUIET_CHECK_MS = 10_000;
const QUIET_RECONCILE_MIN_MS = 30_000;
const QUIET_RECONCILE_MAX_MS = 5 * 60_000;
const SWEEP_MS = 60_000;
/** How often the panes open in the app are checked for the copy mode of tmux (daemon/scrollback.ts). */
const SCROLL_CHECK_MS = 1_000;
/** How often the meta.json of the subagents at work are read: the end of one in the background shows only there. */
const SUBAGENT_CHECK_MS = 5_000;
/** How often the tokens of the sessions of the teams are counted again (only those with new events). */
const TOKENS_CHECK_MS = 10_000;
/** After a prompt, while nothing else comes, when to look whether a hook refused it (daemon/prompt-ending.ts). */
const REFUSAL_CHECKS_MS = [1_000, 3_000, 8_000];

/** Events after which context and cache change: arricurdAI is read again soon. */
const CONTEXT_EVENTS = new Set(['Stop', 'StopFailure', 'PostCompact', 'SessionStart']);

function main(): void {
  process.title = 'forchetta-daemon';
  ensurePrivateDir(paths.varDir);
  // Data of a newer Forchetta is not touched: this daemon would not understand it, and could write over it.
  const migrated = migrateData(paths.varDir, log);
  if (!migrated.ok) {
    log(migrated.error);
    process.stderr.write(`forchetta: ${migrated.error}\n`);
    process.exit(1);
  }
  const config = loadConfig(paths.config, log);
  const tmux = new Tmux(resolveTool('tmux', config), paths.tmuxSocket, paths.tmuxConf);
  let claude: string | undefined;
  try {
    claude = resolveTool('claude', config);
  } catch {
    log('claude non trovato: niente riconciliazione con claude agents --json');
  }
  let settingsText: string | undefined;
  try {
    settingsText = readFileSync(join(claudeConfigDir(), 'settings.json'), 'utf8');
  } catch {
    // No settings: arricurdAI is looked for in the PATH only.
  }
  const arricurdai = config.arricurdai ?? detectArricurdai(settingsText);
  log(arricurdai ? `arricurdAI: ${arricurdai.join(' ')}` : 'arricurdAI non trovato: contesto e cache non disponibili');

  const token = randomBytes(32).toString('hex');
  const startedAt = Date.now();

  // Snapshot of the agents, so that a restarted daemon keeps the boxes of `forchetta run`.
  let saveTimer: NodeJS.Timeout | undefined;
  const save = (): void => {
    saveTimer = undefined;
    writeDataJson(paths.state, { savedAt: Date.now(), agents: registry.list(), writes: conflicts.dump() }, false);
  };
  const saveSoon = (): void => {
    saveTimer ??= setTimeout(save, 1000);
  };

  let lastReconcile = 0;
  // An event from a session with no known pid: `claude agents --json` tells it, at most every 30 s.
  let reconcileTimer: NodeJS.Timeout | undefined;
  const reconcileSoon = (): void => {
    if (reconcileTimer || Date.now() - lastReconcile < QUIET_RECONCILE_MIN_MS) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = undefined;
      void reconcile('evento senza pid');
    }, 2000);
  };

  // Forward references: the registry reports changes to the hub, the poller and the summarizer made below.
  let hub: Hub | undefined;
  let poller: ArricurdaiPoller | undefined;
  let summarizer: Summarizer | undefined;
  let commander: Commander | undefined;
  let permissions: Permissions | undefined;
  const attention = new Attention({ notify: (notice) => hub?.notify(notice), stallMs: config.stallMin * 60_000 });
  // What the guard did, by day (var/guard-stats.json): the top line of the app and `forchetta stats`.
  const guardStats = new GuardStats(paths.guardStats, { onChange: () => hub?.setGuardStats(guardStats.info()), log });
  // Sessions going in circles: the same call failing the same way, again and again (daemon/loops.ts).
  const loops = new Loops();
  const conflicts = new Conflicts();
  let guard: Guard | undefined;
  // What each session read and what the others changed since (daemon/coherence.ts), for the notes of the guard.
  const coherence = new Coherence();
  /** Runs a program for the guard: quickly, its output also when it exits with an error. */
  const runQuick = (file: string, args: string[]): Promise<string | undefined> =>
    new Promise((done) => {
      execFile(file, args, { encoding: 'utf8', timeout: 700, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => done(stdout || (error ? undefined : '')));
    });
  const teams = new Teams(paths.teams, log);
  // The skills of the agents: fetched from GitHub the first time a team uses them, kept in var/skills. Yours are
  // read before the presets and the templates, which are checked against them.
  const skillCache = new SkillCache(join(paths.varDir, 'skills'), gitRunner(), log);
  const yourSkills = new CustomSkills(join(paths.varDir, 'skills', 'yours.json'), skillCache, gitRunner(), log);
  const crews = new Crews(paths.crews, log);
  const templates = new CrewTemplates(paths.crewTemplates, log);
  const roles = new RolePresets(paths.crewRoles, log);
  crews.agent = (agentId) => registry.agents.get(agentId);
  crews.inGit = inGitRepo;
  // The panel of macOS for a folder, for a page in a browser (the app has its own).
  const folderChooser = new FolderChooser();
  // The tokens of the sessions of the teams, from their transcripts: counted again when a session had new events.
  const tokenCounter = new TokenCounter();
  const tokensCountedAt = new Map<string, number>();
  let countingTokens = false;
  const countTokens = async (): Promise<void> => {
    if (countingTokens) return;
    countingTokens = true;
    try {
      for (const agent of [...registry.agents.values()]) {
        const file = agent.transcriptPath;
        if (!agent.team?.crew || !file || agent.state === 'ended') continue;
        if (tokensCountedAt.get(agent.id) === agent.lastEvent.at && agent.tokensByTranscript?.[file]) continue;
        tokensCountedAt.set(agent.id, agent.lastEvent.at);
        const tokens = await tokenCounter.of(file);
        if (!tokens || sameTokens(agent.tokensByTranscript?.[file], tokens)) continue;
        agent.tokensByTranscript = { ...agent.tokensByTranscript, [file]: tokens };
        agent.tokens = sumTokens(Object.values(agent.tokensByTranscript));
        registry.touch(agent);
      }
    } catch (error) {
      log(`token dei team: ${String(error)}`);
    } finally {
      countingTokens = false;
    }
  };
  crews.skills = { ensure: (ids) => skillCache.ensure(ids), plugin: (key, ids) => skillCache.plugin(key, ids) };
  // git for the verdicts of the reviewers and the merges: by its full path, briefly, its output or nothing.
  crews.git = (dir, args) =>
    new Promise((done) => {
      execFile('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => done(error ? undefined : stdout));
    });
  // The trust of Claude Code, read (never written) from its global configuration. Claude Code trusts a git
  // repository at its root (a folder inside a trusted repository asks nothing; a repository of its own inside a
  // trusted folder asks again, and refuses a worktree until then); outside git, a folder or one above it.
  crews.trusted = (dir) => {
    try {
      const file = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
      const projects = (JSON.parse(readFileSync(file, 'utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }).projects ?? {};
      const root = crews.gitInfo(dir).root;
      if (root) return projects[root]?.hasTrustDialogAccepted === true;
      for (let current = dir; ; current = dirname(current)) {
        if (projects[current]?.hasTrustDialogAccepted === true) return true;
        if (dirname(current) === current) return false;
      }
    } catch {
      // Not readable: try, and let the start of the session say how it went.
      return true;
    }
  };
  // The root of the repository of a folder and its branch, for the tool team: two small calls to git.
  crews.gitInfo = (dir) => {
    const git = (args: string[]): string | undefined => {
      // By its full path: the daemon started by the app has the short PATH of the Finder.
      const result = spawnSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 2000 });
      return result.status === 0 ? result.stdout.trim() || undefined : undefined;
    };
    return { root: git(['rev-parse', '--show-toplevel']), branch: git(['branch', '--show-current']) };
  };
  // The tools of a team, or of templates for the other sessions it starts: Claude Code starts this server for each
  // session (see mcp/team.ts).
  const teamMcp = { command: resolveTool('node', config), args: [paths.teamMcpJs] };
  crews.spawn = (choices, extras) => spawnSession({ tmux, registry, claude, log, teamMcp }, choices, extras);
  const patches = new Patches(paths.patches);
  // Conflicts are worked out again after a write, when a session ends, and every minute (old writes drop out).
  let conflictsTimer: NodeJS.Timeout | undefined;
  const updateConflicts = (): void => {
    conflictsTimer ??= setTimeout(() => {
      conflictsTimer = undefined;
      for (const agent of conflicts.update(registry.agents.values())) registry.touch(agent);
    }, 50);
  };
  const notes = new ArricurdaiNotes(arricurdai);
  let notesSupported = false;
  void notes.supported().then((supported) => {
    notesSupported = supported;
    log(supported ? 'arricurdAI prepara la nota della sessione prima di /clear (handoff --prepare)' : 'arricurdAI non ha handoff --prepare: /clear parte senza nota');
  });

  const registry = new Registry({
    onChange: (agent: Agent) => {
      saveSoon();
      hub?.agentChanged(agent);
      summarizer?.changed(agent);
      commander?.agentChanged(agent);
      permissions?.agentChanged(agent);
      attention.agentChanged(agent);
      if (agent.state === 'ended' && agent.conflicts) updateConflicts();
      if (agent.state === 'ended') guard?.ended(agent);
      // A session in a folder with a remembered team gets it: one more change, once.
      if (teams.apply(agent)) registry.touch(agent);
      if (CONTEXT_EVENTS.has(agent.lastEvent.name)) poller?.soon();
    },
    onRemove: (ids) => {
      saveSoon();
      hub?.agentsRemoved(ids);
      summarizer?.forget(ids);
      attention.forget(ids);
      for (const id of ids) conflicts.forget(id);
      for (const id of ids) tokensCountedAt.delete(id);
      coherence.forget(ids);
      loops.forget(ids);
      teams.forget(ids);
      patches.forget(ids);
      // Its MCP configuration (shared/mcp-config.ts): the session is over, nobody starts that server again.
      for (const id of ids) rmSync(mcpConfigFile(id), { force: true });
    },
    onUnknownPid: reconcileSoon,
  });
  // The notices of the guard waiting in the queue of a session, with their files: a session that writes one of
  // those files first went on by itself, and its notice goes.
  const notices = new Map<string, { commandId: string; paths: Set<string> }>();
  /** A file the guard held back is free: the session that waited is told, in its terminal when it can be. */
  const freed = (waiter: Agent, files: GuardHold[], by: Agent): void => {
    const names = files.map((file) => file.file);
    const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
    const byName = files[0]?.withName ?? displayName(by);
    log(`vigile: ${list} di nuovo libero per ${waiter.team?.label ?? waiter.project}`);
    if (waiter.control.kind === 'tmux') {
      const earlier = notices.get(waiter.id);
      if (earlier) commander?.cancel(waiter.id, earlier.commandId);
      const text = `Forchetta: ${list} ${names.length === 1 ? 'is' : 'are'} free now ("${byName}" ended its turn). You can go on.`;
      const result = commander?.enqueueFree(waiter.id, text);
      if (result?.ok) notices.set(waiter.id, { commandId: result.command.id, paths: new Set([...(earlier?.paths ?? []), ...files.map((file) => file.path)]) });
      return;
    }
    hub?.notify({ agentId: waiter.id, kind: 'free', title: `${displayName(waiter)} can go on`, body: `${list} ${names.length === 1 ? 'is' : 'are'} free: ${byName} ended its turn.` });
  };
  guard = new Guard({
    agents: () => registry.agents.values(),
    repoOf: (dir) => conflicts.repoOf(dir),
    writesOf: (agentId) => conflicts.filesOf(agentId),
    enabled: () => config.guard,
    touch: (agent) => registry.touch(agent),
    onFree: (waiter, files, by) => freed(waiter, files, by),
    // The files of the members of a team: their working tree tells where the folder of the team is for them.
    lane: (agent, file) => crews.laneCheck(agent.id, file, conflicts.repoOf(dirname(file))),
    onLaneThrough: (agent, _file, shown) => {
      const text = `Forchetta: the user lets you change ${shown}, outside your files in the team. You can go on.`;
      if (agent.control.kind === 'tmux') commander?.enqueueFree(agent.id, text);
      else hub?.notify({ agentId: agent.id, kind: 'free', title: `${displayName(agent)} can go on`, body: `You let it change ${shown}.` });
    },
    count: (kind) => guardStats.count(kind),
    addedByOthers: (agentId, file, removed) => coherence.addedByOthers(agentId, file, removed),
    changedByOthers: (agentId, file) => coherence.changedByOthers(agentId, file),
    readText: (path) => {
      try {
        return statSync(path).size <= 2_000_000 ? readFileSync(path, 'utf8') : undefined;
      } catch {
        return undefined;
      }
    },
    dirty: async (repo) => {
      const text = await runQuick('/usr/bin/git', ['-C', repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
      return text === undefined ? undefined : parseStatus(text, repo);
    },
  });
  const servers = new Servers({
    agents: () => registry.agents.values(),
    repoOf: (dir) => conflicts.repoOf(dir),
    enabled: () => config.guard.servers,
    run: runQuick,
  });
  /** A git merge of the branch of a member of a team, with commits its reviewer did not approve: you decide. */
  const mergeCheck = async (agent: Agent, payload: Parameters<Guard['decide']>[1]): Promise<GuardDecision | undefined> => {
    const command = (payload.tool_input as { command?: unknown } | undefined)?.command;
    const cwd = agent.cwd ?? payload.cwd;
    if (!config.guard.git || payload.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'Bash' || typeof command !== 'string' || !cwd || agent.state === 'ended') return undefined;
    const found = await crews.decideMerge(agent.id, command, cwd);
    if (found) guardStats.count('merge');
    return found;
  };
  /** A second dev server, or a kill of the process of another session (daemon/servers.ts). */
  const serverCheck = async (agent: Agent, payload: Parameters<Guard['decide']>[1]): Promise<GuardDecision | undefined> => {
    const found = await servers.decide(agent, payload);
    if (found?.decision) guardStats.count(found.decision === 'deny' ? 'server' : 'kill');
    return found;
  };
  /** The note of the files a session read that other sessions changed since; once for each change. */
  const changedFilesNote = (agent: Agent): string | undefined => {
    const found = coherence.changedSinceRead(agent.id);
    if (found.length === 0) return undefined;
    // Two sessions of one folder with no names of their own are both called after the folder: say which.
    const nameOf = (id: string): string => {
      const other = registry.agents.get(id);
      const name = other ? otherName(other, agent) : undefined;
      return name && name !== otherName(agent, agent) ? `"${name}"` : 'another session in this folder';
    };
    const shown = (file: string): string => {
      const base = conflicts.repoOf(dirname(file)) ?? agent.cwd;
      const rel = base ? relative(base, file) : file;
      return rel && !rel.startsWith('..') ? rel : file;
    };
    return changedNote(found, nameOf, shown, Date.now());
  };
  // The artifacts a session showed before Forchetta saw them come: read once from its transcript, one transcript at
  // a time (they can be tens of MB), when the daemon starts and when a session first sends an event.
  const transcriptsRead = new Set<string>();
  let reading = Promise.resolve();
  const readArtifacts = (agent: Agent): void => {
    const file = agent.transcriptPath;
    if (!file || transcriptsRead.has(file) || agent.state === 'ended') return;
    transcriptsRead.add(file);
    reading = reading.then(async () => {
      try {
        const found = await artifactsInTranscript(file);
        if (found.length === 0) return;
        agent.artifacts = mergeArtifacts(agent.artifacts, found);
        registry.touch(agent);
      } catch {
        // No transcript (yet), or one that cannot be read: the hooks bring the next ones.
      }
    });
  };
  // A prompt that a hook refused started no turn: the box goes back to what it was, and the commands of the box
  // do not wait for a turn that never comes. Claude Code says so only in the transcript, about half a second later.
  const checkRefused = async (agent: Agent, at: number, prompt: string): Promise<void> => {
    if (agent.lastEvent.name !== 'UserPromptSubmit' || agent.lastEvent.at !== at || !agent.transcriptPath) return;
    try {
      // A little before the hook: the refusal can be written before the hook of Forchetta reaches the daemon.
      const ending = promptEndingIn(await transcriptTail(agent.transcriptPath), at - 1_500, prompt);
      if (ending && registry.refusePrompt(agent.id, at, ending.reason)) {
        log(`prompt di ${agent.team?.label ?? agent.project} rifiutato da un hook (${ending.kind}): nessun turno`);
      }
    } catch {
      // No transcript to read: the reconciliation with claude agents corrects the state when the hooks are quiet.
    }
  };
  const watchPrompt = (agent: Agent, at: number, prompt: string): void => {
    for (const delay of REFUSAL_CHECKS_MS) setTimeout(() => void checkRefused(agent, at, prompt), delay).unref();
  };
  try {
    const saved = readDataJson(paths.state, 'stato salvato', log) as { agents?: Agent[]; writes?: unknown } | undefined;
    if (saved) {
      registry.restore(saved.agents ?? []);
      // What the guard held lives in its memory only: after a restart nothing is held, and the boxes say so.
      for (const agent of registry.agents.values()) {
        agent.heldBack = undefined;
        agent.holding = undefined;
        // What went in circles is known from the failures since this daemon started.
        agent.loop = undefined;
      }
      for (const agent of registry.agents.values()) readArtifacts(agent);
      conflicts.load(saved.writes);
      updateConflicts();
      attention.prime(registry.agents.values());
    }
  } catch (error) {
    log(`stato salvato illeggibile, ignorato: ${String(error)}`);
  }

  // A failed automatic update of Claude Code: read from its file at start and every minute, said in the top line.
  const claudeUpdates = new ClaudeUpdates({
    resultFile: join(claudeConfigDir(), '.last-update-result.json'),
    handledFile: paths.claudeUpdate,
    claude: () => claude,
    onChange: (info) => hub?.setClaudeUpdate(info),
    log,
  });
  claudeUpdates.check();
  // The menu of a selection in a pane: what tmux copied, and the quick prompts.
  const selections = new SelectionReader(tmux);
  const quickPrompts = new QuickPrompts(paths.prompts, log);

  hub = new Hub({
    token,
    port: () => config.port,
    snapshot: () => registry.list(),
    settings: () => ({ replace: config.panes.replace, arricurdaiNotes: notesSupported, stallMin: config.stallMin }),
    onCommand: (message) => {
      if (message.type === 'cancel') {
        commander?.cancel(message.agentId, message.commandId);
        return;
      }
      const result = commander?.enqueue(message.agentId, message.kind, message.arg, message.confirmed, message.fromSelection === true);
      if (result && !result.ok) log(`comando rifiutato: ${result.error}`);
    },
    onFiles: (agentId) => changesOf(conflicts.filesOf(agentId), patches.byFile(agentId)),
    onSubagent: async (agentId, key) => {
      const agent = registry.agents.get(agentId);
      const subagent = agent?.subagents?.find((candidate) => subagentKey(candidate) === key);
      if (!agent || !subagent) return { steps: [], note: 'Forchetta no longer keeps this subagent.' };
      const task = subagent.prompt ? [{ kind: 'prompt' as const, text: subagent.prompt }] : [];
      if (!subagent.transcript) return { steps: task, note: subagent.state === 'running' ? 'Its transcript is not there yet: it shows with its first step.' : 'Claude Code wrote no transcript for it.' };
      try {
        return await readSubagentThread(subagent.transcript, agent.cwd);
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        return { steps: task, note: missing ? 'Its transcript is not there (yet, or any more).' : `The transcript could not be read: ${String(error)}` };
      }
    },
    onScrollEnd: (agentId) => void scrollEnd(agentId),
    onLetThrough: (agentId, path) => {
      if (guard?.letThrough(agentId, path)) log(`vigile: lasciata passare ${registry.agents.get(agentId)?.project ?? agentId} su ${path}`);
    },
    onSpawn: (input) => spawnSession({ tmux, registry, claude, log, teamMcp }, input),
    crews: () => crews.summaries(),
    onCrewRequest: (crewId, to, text) => crews.request(crewId, to, text),
    crewThread: (crewId) => crews.thread(crewId),
    crewReviews: (crewId) => crews.reviewsOf(crewId),
    templates: () => templates.list(),
    onTemplate: (message) => {
      if (message.type === 'deleteCrewTemplate') return templates.delete(message.name);
      // From an existing team: the daemon has its roles and models, the page does not.
      const crew = message.crewId ? crews.get(message.crewId) : undefined;
      if (message.crewId && !crew) return { ok: false, error: 'unknown team' };
      // From the app, a template with the name of one of Forchetta is your version of it.
      return templates.save(crew ? templateOf(crew) : message.template, { override: true });
    },
    roles: () => roles.list(),
    onRole: (message) => (message.type === 'deleteRolePreset' ? roles.delete(message.name) : roles.save(message.preset, message.previous)),
    onChooseFolder: (folder) => folderChooser.choose(folder),
    customSkills: () => yourSkills.list(),
    crewTemplate: (crewId) => {
      const crew = crews.get(crewId);
      return crew ? { template: templateOf(crew), cwd: crew.cwd } : undefined;
    },
    onSaveTeamFile: (name, text) => {
      const saved = saveTeamFile(name, text);
      return saved.ok ? { ok: true, path: saved.path.replace(homedir(), '~') } : saved;
    },
    onImportTeam: (text, choice) => importTeam(text, (link) => yourSkills.add(link), choice),
    onAddSkill: async (source) => {
      const result = await yourSkills.add(source);
      return result.ok ? { ok: true, id: result.skill.id } : result;
    },
    onRemoveSkill: (id) => yourSkills.remove(id, skillUsers(id, roles.list(), templates.list(), crews.list())),
    onEditCrew: async (message) => {
      // The box and the chart follow a change of the place of a session in its team.
      const place = (agentId: string, team: Agent['team']): void => {
        const agent = registry.agents.get(agentId);
        if (!agent) return;
        agent.team = team;
        registry.touch(agent);
      };
      if (message.action === 'talk' && message.name && (message.talk === 'oneway' || message.talk === 'twoway')) {
        const result = crews.setTalk(message.crewId, message.name, message.talk);
        if (result.ok) for (const change of result.changes) place(change.agentId, { ...registry.agents.get(change.agentId)?.team, talk: change.talk });
        return result;
      }
      if (message.action === 'remove' && message.name) {
        const result = crews.removeMember(message.crewId, message.name, (agentId, commandId) => commander?.cancel(agentId, commandId));
        if (result.ok && result.agentId) place(result.agentId, undefined);
        return result;
      }
      if (message.action === 'add') {
        return crews.addMember(message.crewId, message.member);
      }
      if (message.action === 'paths' && message.name) {
        return crews.setPaths(message.crewId, message.name, message.paths);
      }
      return { ok: false, error: 'unknown change' };
    },
    onCreateCrew: async (input) => {
      const checked = cleanCrewSpec(input);
      if ('error' in checked) return { ok: false, error: checked.error };
      // The folder as the team keeps it: ~ and the rest resolved, like a session started from the panel.
      checked.spec.cwd = folderOf(checked.spec.cwd) ?? checked.spec.cwd;
      return crews.create(checked.spec);
    },
    onRecall: (project, query) => runRecall(arricurdai, project, query),
    onSelection: async (agentId, phase) => {
      if (phase === 'start') {
        selections.start(agentId);
        return undefined;
      }
      return selections.end(agentId);
    },
    onAsk: (agentId, text, fromSelection) => {
      const result = commander?.enqueueAsk(agentId, text, fromSelection) ?? { ok: false, error: 'the daemon is starting' };
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    onInsert: (agentId, text) => commander?.insert(agentId, text) ?? Promise.resolve({ ok: false, error: 'the daemon is starting' }),
    prompts: () => quickPrompts.list(),
    onSavePrompts: (prompts) => quickPrompts.save(prompts),
    claudeUpdate: () => claudeUpdates.info(),
    onClaudeUpdate: (action) => {
      if (action === 'dismiss') claudeUpdates.dismiss();
      else void claudeUpdates.update().catch((error: unknown) => log(`claude update: ${String(error)}`));
    },
    onTeam: (agentId, team) => {
      const agent = registry.agents.get(agentId);
      if (!agent) return;
      teams.set(agent, team);
      registry.touch(agent);
    },
    onPermission: (message) => {
      void permissions?.decide(message.agentId, message.ticket, message.behavior, message.always).then((sent) => {
        if (sent) log(`permesso: ${message.behavior === 'allow' ? (message.always !== undefined ? 'consentito sempre' : 'consentito') : 'rifiutato'} dal box`);
      });
    },
    log,
    onWatched: (watched) => {
      log(watched ? 'una finestra mostra le sessioni' : 'nessuna finestra visibile: letture di arricurdAI sospese');
      if (watched) void poller?.refresh();
      else poller?.schedule();
    },
  });

  hub.setGuardStats(guardStats.info());

  poller = new ArricurdaiPoller({
    watched: () => hub?.isWatched() ?? false,
    busy: () => registry.isBusy(),
    run: async () => {
      if (!arricurdai) return;
      try {
        const { sessions, today } = await readArricurdaiStatus(arricurdai);
        registry.applyArricurdai(sessions, (model) => contextWindowOf(model, config.contextWindows));
        if (today) hub?.setToday(today);
      } catch (error) {
        log(`arricurdai status non riuscito: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  if (config.summaries.haiku) {
    const key = process.env.FORCHETTA_ANTHROPIC_API_KEY;
    if (!key) {
      log('riassunti Haiku attivi nella configurazione, ma FORCHETTA_ANTHROPIC_API_KEY non è impostata: restano spenti');
    } else {
      void haikuComplete(key, config.summaries.model).then(
        (complete) => {
          summarizer = new Summarizer({
            complete,
            minIntervalMs: config.summaries.minIntervalSec * 1000,
            onSummary: (agentId, text) => registry.setModelSummary(agentId, text),
            log,
          });
          log(`riassunti Haiku attivi (${config.summaries.model}, al massimo ogni ${config.summaries.minIntervalSec} s per sessione)`);
        },
        (error: unknown) => log(`riassunti Haiku non disponibili: ${String(error)}`),
      );
    }
  }

  let reconciling = false;
  let quietInterval = QUIET_RECONCILE_MIN_MS;
  async function reconcile(reason: string): Promise<boolean> {
    if (reconciling) return false;
    reconciling = true;
    try {
      const panes = await listPanes(tmux);
      let entries: Awaited<ReturnType<typeof readClaudeAgents>> = [];
      if (claude) {
        try {
          entries = await readClaudeAgents(claude);
        } catch (error) {
          log(`claude agents --json non riuscito: ${String(error)}`);
        }
      }
      const changed = registry.reconcile(entries, panes, isAlive);
      lastReconcile = Date.now();
      log(`riconciliazione (${reason}): ${entries.length} sessioni da claude agents, ${panes.length} pane tmux${changed ? ', aggiornato' : ''}`);
      return changed;
    } finally {
      reconciling = false;
    }
  }

  crews.onChange = () => hub?.crewsChanged();
  const terminals = new Terminals({ token, port: () => config.port, registry, tmux, log });
  commander = new Commander({ registry, tmux, log, notes, onRequest: (_agent, command) => crews.commandChanged(command) });
  const queue = commander;
  crews.enqueue = (agentId, text, link) => queue.enqueueRequest(agentId, text, link);
  commander.restored();

  // Whether a claude process shows its dialogs in a terminal: read once per pid (see process.ts).
  const interactiveByPid = new Map<number, boolean>();
  permissions = new Permissions({
    registry,
    interactive: async (agent) => {
      if (!agent.pid) return false;
      const known = interactiveByPid.get(agent.pid);
      if (known !== undefined) return known;
      const interactive = isInteractiveCommand(await readCommandLine(agent.pid));
      if (interactiveByPid.size > 500) interactiveByPid.clear();
      interactiveByPid.set(agent.pid, interactive);
      return interactive;
    },
    status: async (agent) => {
      if (!claude) return undefined;
      const entries = await readClaudeAgents(claude);
      const entry = entries.find((candidate) => (agent.pid !== undefined && candidate.pid === agent.pid) || (agent.sessionId !== undefined && candidate.sessionId === agent.sessionId));
      return entry?.status;
    },
    log,
  });

  const limits = new Limits();
  const server = createDaemonServer({
    registry,
    token,
    uiDir: join(ROOT, 'dist', 'ui'),
    hub,
    terminals,
    permissions,
    refreshContext: () => poller?.refresh() ?? Promise.resolve(),
    port: () => config.port,
    recordFile: process.env.FORCHETTA_RECORD === '1' ? paths.payloads : undefined,
    log,
    crew: async (route, input) =>
      templateApi(templates, route, input, (name, replaced) => {
        hub?.templatesChanged();
        log(`modello di team ${replaced ? 'sostituito' : 'salvato'} da una sessione: "${name}"`);
      }) ?? (await crewApi(crews, route, input)),
    guard: async (agent, payload) => {
      const name = agent.team?.label ?? agent.project;
      const first = guard?.decide(agent, payload);
      let stop = first?.decision ? first : ((await guard?.decideCommit(agent, payload)) ?? (await mergeCheck(agent, payload)) ?? (await serverCheck(agent, payload)));
      // A merge the guard asks about already (another session works in that folder): the dialog also says what the
      // reviewer has not approved, in the same question.
      if (stop === first && first?.decision === 'ask') {
        const merge = await mergeCheck(agent, payload);
        if (merge?.reason) stop = { decision: 'ask', reason: `${first.reason}\n${merge.reason}` };
      }
      if (stop?.decision) {
        log(`guardia: ${stop.decision} per ${name} (${payload.tool_name})`);
        return hookOutput(stop);
      }
      // Notes that stop nothing: who else is halfway through what (once, at its first step), before tests, and the
      // files read that others changed. Those go to the session itself, not to its subagents: it is the session that
      // keeps what it read.
      const changed = config.guard.notes && !payload.agent_id ? changedFilesNote(agent) : undefined;
      if (changed) guardStats.count('changed');
      const arrival = guard?.arrival(agent, payload, Boolean(first?.context));
      const context = [arrival, first?.context, changed].filter(Boolean).join('\n\n');
      if (!context) return undefined;
      log(`vigile: nota per ${name} (${payload.tool_name}): ${context.split('\n')[0]!.slice(0, 160)}`);
      return hookOutput({ context });
    },
    onRateLimits: (windows, agent) => {
      const info = limits.take(windows, Date.now(), agent?.usage ? { agentId: agent.id, usd: agent.usage.usd } : undefined);
      if (info) hub?.setLimits(info);
    },
    onHook: (agent, payload) => {
      quietInterval = QUIET_RECONCILE_MIN_MS;
      commander?.hook(agent, payload);
      crews.hook(agent, payload);
      permissions?.hook(agent, payload);
      const edit = editOf(payload, agent.cwd, Date.now());
      if (edit) {
        try {
          patches.add(agent.id, edit);
        } catch (error) {
          log(`modifica di ${agent.id} non salvata: ${String(error)}`);
        }
      }
      if (payload.artifact) {
        agent.artifacts = addArtifact(agent.artifacts, { ...payload.artifact, at: Date.now() });
        registry.touch(agent);
      }
      readArtifacts(agent);
      if (startsTurn(payload) && !payload.agent_id) watchPrompt(agent, agent.lastEvent.at, payload.prompt ?? '');
      if (applySubagentHook(agent, payload, Date.now())) registry.touch(agent);
      const loopBefore = agent.loop?.since;
      if (loops.hook(agent, payload, Date.now())) {
        if (agent.loop && agent.loop.since !== loopBefore) {
          guardStats.count('loop');
          log(`${agent.team?.label ?? agent.project}: gira a vuoto su ${agent.loop.label} (${agent.loop.count} volte lo stesso errore)`);
        }
        registry.touch(agent);
      }
      // A file the session itself read (not one of its subagents): what it knows of it dates from now.
      if (payload.hook_event_name === 'PostToolUse' && payload.tool_name === 'Read' && !payload.agent_id) {
        const raw = (payload.tool_input as { file_path?: unknown } | undefined)?.file_path;
        const base = agent.cwd ?? payload.cwd;
        if (typeof raw === 'string' && (isAbsolute(raw) || base)) coherence.read(agent.id, isAbsolute(raw) ? resolve(raw) : resolve(base!, raw));
      }
      const file = writtenFile(payload, agent.cwd);
      if (file) {
        coherence.wrote(agent.id, file, edit && edit.file === file ? edit : undefined);
        guard?.wrote(agent, file);
        const notice = notices.get(agent.id);
        if (notice?.paths.has(file)) {
          commander?.cancel(agent.id, notice.commandId);
          notices.delete(agent.id);
        }
      }
      guard?.hook(agent, payload);
      if (file) {
        conflicts.wrote(agent.id, file);
        updateConflicts();
        const count = conflicts.count(agent.id);
        if (agent.filesChanged !== count) {
          agent.filesChanged = count;
          registry.touch(agent);
        }
      }
    },
    info: () => ({ pid: process.pid, port: config.port, startedAt, version: VERSION, agents: registry.agents.size, windows: hub?.size ?? 0, terminals: terminals.size }),
    onShutdown: () => shutdown('richiesta di arresto'),
  });

  /** Which panes open in the app are scrolled back in tmux (daemon/scrollback.ts): one list-panes, if any is open. */
  let checkingScroll = false;
  async function checkScroll(): Promise<void> {
    if (checkingScroll) return;
    const open = terminals.openSessions();
    // Asked to tmux only while a window shows a terminal; otherwise the marks still there go.
    const ask = (hub?.isWatched() ?? false) && open.size > 0;
    if (!ask && ![...registry.agents.values()].some((agent) => agent.scrolledBack)) return;
    checkingScroll = true;
    try {
      let modes = new Map<string, boolean>();
      if (ask) {
        const listed = await tmux.run('list-panes', ['-a', '-F', PANE_MODES_FORMAT]);
        if (listed.code !== 0) return;
        modes = paneModes(listed.stdout);
      }
      for (const agent of registry.agents.values()) {
        const scrolled = ask && scrolledBack(agent, open, modes);
        if (Boolean(agent.scrolledBack) === scrolled) continue;
        agent.scrolledBack = scrolled || undefined;
        registry.touch(agent);
      }
    } finally {
      checkingScroll = false;
    }
  }

  /** "back to the end" in the pane: out of copy mode, the keys go to Claude Code again. */
  async function scrollEnd(agentId: string): Promise<void> {
    const agent = registry.agents.get(agentId);
    if (!agent || agent.control.kind !== 'tmux') return;
    const target = agent.control.paneId ?? agent.control.session;
    const mode = await tmux.run('display-message', ['-p', '-t', target, '#{pane_in_mode}']);
    if (mode.code === 0 && mode.stdout.trim() === '1') {
      await tmux.run('send-keys', ['-t', target, '-X', 'cancel']);
      log(`${agent.project}: riquadro riportato in fondo (fuori dalla copy mode di tmux)`);
    }
    if (agent.scrolledBack) {
      agent.scrolledBack = undefined;
      registry.touch(agent);
    }
  }

  const timers: NodeJS.Timeout[] = [];
  function shutdown(reason: string): void {
    log(`arresto: ${reason}. Le sessioni tmux e i processi claude restano attivi.`);
    for (const timer of timers) clearInterval(timer);
    if (saveTimer) clearTimeout(saveTimer);
    if (reconcileTimer) clearTimeout(reconcileTimer);
    poller?.stop();
    summarizer?.stop();
    commander?.stop();
    permissions?.stop();
    attention.stop();
    guardStats.flush();
    if (conflictsTimer) clearTimeout(conflictsTimer);
    // The open panes are detached: their tmux clients get SIGHUP, the sessions go on.
    terminals.close();
    hub?.close();
    registry.dispose();
    try {
      save();
    } catch (error) {
      log(`salvataggio finale non riuscito: ${String(error)}`);
    }
    try {
      const info = JSON.parse(readFileSync(paths.daemonInfo, 'utf8')) as { pid?: number };
      if (info.pid === process.pid) rmSync(paths.daemonInfo, { force: true });
    } catch {
      // Already gone.
    }
    server.hooks.close();
    try {
      rmSync(paths.hooksSocket, { force: true });
    } catch {
      // Already gone.
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.on('error', (error: NodeJS.ErrnoException) => {
    log(error.code === 'EADDRINUSE' ? `la porta ${config.port} è già in uso: un altro daemon è attivo?` : `server: ${String(error)}`);
    process.exit(1);
  });

  // The hooks talk on a socket of the private folder: one left by a daemon that did not stop is taken away first
  // (this one holds the port, so no other daemon is running). macOS takes paths of 104 bytes at most.
  const listenForHooks = (): void => {
    const socket = paths.hooksSocket;
    if (Buffer.byteLength(socket) > 103) {
      log(`socket degli hook non creato: il percorso è troppo lungo (${socket})`);
      return;
    }
    try {
      rmSync(socket, { force: true });
    } catch {
      // Nothing there.
    }
    server.hooks.on('error', (error) => log(`socket degli hook: ${String(error)}`));
    server.hooks.listen(socket, () => {
      try {
        chmodSync(socket, 0o600);
      } catch {
        // The folder is 0700 anyway.
      }
    });
  };

  server.listen(config.port, '127.0.0.1', () => {
    listenForHooks();
    writeFileSync(paths.daemonInfo, `${JSON.stringify({ pid: process.pid, port: config.port, token, startedAt, version: VERSION })}\n`, { mode: 0o600 });
    log(`daemon ${VERSION} attivo su 127.0.0.1:${config.port} (pid ${process.pid})`);

    timers.push(
      setInterval(() => {
        registry.checkAlive(isAlive);
        // Sessions of `forchetta run` still without a pid: the tmux panes tell it, cheaply.
        if (registry.waitingForPid().length > 0) void listPanes(tmux).then((panes) => registry.reconcile([], panes, isAlive));
      }, LIVENESS_MS),
      setInterval(() => {
        // A command waits for a session that only claude agents can say is ready again: every 10 s, while it waits.
        if (commander?.waitsOnAgentView() && Date.now() - lastReconcile >= QUIET_CHECK_MS) {
          void reconcile('un comando aspetta la sessione');
          return;
        }
        if (!registry.hasQuietActivity() || Date.now() - lastReconcile < quietInterval) return;
        void reconcile('hook silenziosi').then((changed) => {
          quietInterval = changed ? QUIET_RECONCILE_MIN_MS : Math.min(quietInterval * 2, QUIET_RECONCILE_MAX_MS);
        });
      }, QUIET_CHECK_MS),
      setInterval(() => void reconcile('periodica'), config.reconcileIntervalMin * 60_000),
      setInterval(() => void countTokens(), TOKENS_CHECK_MS),
      setInterval(() => void checkScroll().catch((error: unknown) => log(`copy mode: ${String(error)}`)), SCROLL_CHECK_MS),
      setInterval(() => {
        if (!anySubagentActive(registry.agents.values())) return;
        const now = Date.now();
        for (const agent of registry.agents.values()) if (checkSubagents(agent, now)) registry.touch(agent);
      }, SUBAGENT_CHECK_MS),
      setInterval(() => {
        registry.sweep(config.endedRetentionMin * 60_000);
        updateConflicts();
        claudeUpdates.check();
        // The last days move with the clock: a day that leaves the week leaves the top line too.
        hub?.setGuardStats(guardStats.info());
      }, SWEEP_MS),
    );
    void reconcile('avvio');
  });
}

main();
