import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { migrateData, readDataJson, writeDataJson } from '../shared/data-file.ts';
import { homedir, uptime } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { contextWindowOf, detectArricurdai, loadConfig, resolveTool, saveConfig, which } from '../shared/config.ts';
import { claudeConfigDir, ensurePrivateDir, paths, ROOT } from '../shared/paths.ts';
import { listPanes, Tmux } from '../shared/tmux.ts';
import { VERSION } from '../shared/version.ts';
import { ArricurdaiNotes, ArricurdaiPoller, readArricurdaiStatus } from './arricurdai.ts';
import { isAlive, readClaudeAgents, readSessionFile } from './claude-agents.ts';
import { ClaudeUpdates } from './claude-update.ts';
import { QuickPrompts } from './prompts.ts';
import { SelectionReader } from './selection.ts';
import { Commander } from './commands.ts';
import { Attention } from './attention.ts';
import { Conflicts, shellWrittenFiles, writtenFile } from './conflicts.ts';
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
import { type GuardParts, RepoConfig, withRepoRules } from './repo-config.ts';
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
import { cliApi, isFolder } from './cli-api.ts';
import { AUTO_ACTIONS, AUTO_TICK_MS, type AutoAction, Automations } from './automations.ts';
import { ghRunner, githubItems } from './github.ts';
import { Ledger, readLedger, whoOf } from './ledger.ts';
import { describeTeam } from './describe.ts';
import { createLog } from './log.ts';
import { editableSettings, readClaudeSettings, systemInfo } from './system.ts';
import { cleanSettings, needsRestart } from '../shared/system.ts';
import { versionIn } from './claude-update.ts';
import { readDaemonInfo } from '../shared/daemon-client.ts';
import { addArtifact, mergeArtifacts } from '../shared/artifacts.ts';
import { artifactsInTranscript } from './transcript-artifacts.ts';
import { promptEndingIn, transcriptTail } from './prompt-ending.ts';
import { anySubagentActive, applySubagentHook, checkSubagents, readSubagentThread } from './subagents.ts';
import { sameTokens, subagentKey, sumTokens } from '../shared/present.ts';
import { PANE_MODES_FORMAT, paneModes, scrolledBack } from './scrollback.ts';
import { type Agent, markEnded, startsTurn } from './state.ts';
import { Reopener } from './reopen.ts';
import { Restarter } from './restarts.ts';
import { endedAtShutdown, endedByRestart } from '../shared/reopen.ts';
import { displayName, type GuardHold } from '../shared/agent.ts';
import { haikuComplete, Summarizer } from './summarizer.ts';
import { Limits } from './limits.ts';
import { Terminals } from './terminals.ts';

// forchetta-daemon: one process, driven by events. It never ends a Claude process or a tmux session: when it
// stops, the sessions go on, and the next daemon finds them again.

// The log of the daemon, in its file (daemon/log.ts): written and rotated by the daemon itself.
const { log, close: closeLog } = createLog(paths.log);

/** Where a repository keeps the rules of its teams (daemon/repo-config.ts). */
const REPO_RULES = '.forchetta/rules.md';

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
    log('claude not found: no reconciliation with claude agents --json', 'warn');
  }
  let settingsText: string | undefined;
  try {
    settingsText = readFileSync(join(claudeConfigDir(), 'settings.json'), 'utf8');
  } catch {
    // No settings: arricurdAI is looked for in the PATH only.
  }
  const arricurdai = config.arricurdai ?? detectArricurdai(settingsText);
  log(arricurdai ? `arricurdAI: ${arricurdai.join(' ')}` : 'arricurdAI not found: no context and cache for the sessions');

  // What the page shows of the installation (daemon/system.ts): the version of Claude Code is read once, and again
  // after an update; a hook that arrives says the hooks work.
  let claudeVersion: string | undefined;
  let hookSeen = false;
  let haikuOn = false;
  const readClaudeVersion = (): void => {
    if (!claude) return;
    execFile(claude, ['--version'], { encoding: 'utf8', timeout: 10_000 }, (_error, stdout) => {
      const found = versionIn(stdout ?? '');
      if (!found || found === claudeVersion) return;
      claudeVersion = found;
      log(`Claude Code ${found}`);
      hub?.systemChanged();
    });
  };
  // Claude Code updates itself: another file behind the same path. Cheap to look at, every minute.
  let claudeFile: string | undefined;
  const checkClaudeFile = (): void => {
    if (!claude) return;
    try {
      const real = realpathSync(claude);
      const file = `${real} ${statSync(real).mtimeMs}`;
      if (file === claudeFile) return;
      const first = claudeFile === undefined;
      claudeFile = file;
      if (!first) readClaudeVersion();
    } catch {
      // An update is replacing it: the next minute.
    }
  };
  checkClaudeFile();
  readClaudeVersion();

  const token = randomBytes(32).toString('hex');
  const startedAt = Date.now();

  // Snapshot of the agents, so that a restarted daemon keeps the boxes of `forchetta run`.
  let saveTimer: NodeJS.Timeout | undefined;
  const save = (): void => {
    saveTimer = undefined;
    const counted = Object.fromEntries(
      [...registry.agents.keys()].flatMap((id) => {
        const known = ledger.countedOf(id);
        return known ? [[id, known]] : [];
      }),
    );
    writeDataJson(paths.state, { savedAt: Date.now(), agents: registry.list(), writes: conflicts.dump(), ledger: counted }, false);
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
      void reconcile('event without a pid');
    }, 2000);
  };

  // Forward references: the registry reports changes to the hub, the poller and the summarizer made below.
  let hub: Hub | undefined;
  let poller: ArricurdaiPoller | undefined;
  let summarizer: Summarizer | undefined;
  let commander: Commander | undefined;
  /** The teams that start by themselves: made once the queue of the commands and the limits are there. */
  let automations: Automations | undefined;
  let permissions: Permissions | undefined;
  const attention = new Attention({ notify: (notice) => hub?.notify(notice), stallMs: config.stallMin * 60_000 });
  // What the guard did, by day (var/guard-stats.json): the top line of the app and `forchetta stats`.
  const guardStats = new GuardStats(paths.guardStats, { onChange: () => hub?.setGuardStats(guardStats.info()), log });
  // Sessions going in circles: the same call failing the same way, again and again (daemon/loops.ts).
  const loops = new Loops();
  const conflicts = new Conflicts();
  // .forchetta/ of the repositories: the parts of the guard on or off there, the rules of their teams.
  const repoConfig = new RepoConfig(log);
  const rootOf = (dir: string | undefined): string | undefined => (dir ? (conflicts.repoOf(dir) ?? dir) : undefined);
  /** The guard for a session: var/config.json, then what its repository says. */
  const guardFor = (agent: Agent): GuardParts => ({ ...config.guard, ...repoConfig.guard(rootOf(agent.cwd)) });
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
  // What the sessions and the teams did, for `forchetta report` (daemon/ledger.ts).
  const ledger = new Ledger(join(paths.varDir, 'ledger'), log);
  crews.record = (entry) => ledger.append(entry);
  /** A session for the ledger: with its team, when it has one. */
  const who = (agent: Agent) => whoOf(agent, agent.team?.crew ? crews.get(agent.team.crew)?.name : undefined);
  /** The sessions whose end is in the ledger. */
  const endedInLedger = new Set<string>();
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
      log(`tokens of the teams: ${String(error)}`, 'warn');
    } finally {
      countingTokens = false;
    }
  };
  crews.skills = { ensure: (ids) => skillCache.ensure(ids), plugin: (key, ids) => skillCache.plugin(key, ids) };
  // git for the verdicts of the reviewers and the merges: by its full path, briefly, its output or nothing.
  crews.git = (dir, args) =>
    new Promise((done) => {
      execFile('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-C', dir, ...args], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => done(error ? undefined : stdout));
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
      const result = spawnSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-C', dir, ...args], { encoding: 'utf8', timeout: 2000 });
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
  /** A team started in a repository with .forchetta/rules.md follows those rules too, before its own. */
  const withRulesOfRepo = <T extends { cwd: string; rules?: string }>(spec: T): T => {
    const repoRules = repoConfig.rulesOf(rootOf(spec.cwd));
    if (!repoRules) return spec;
    const rules = withRepoRules(spec.rules, repoRules);
    if (rules !== spec.rules) log(`team in ${spec.cwd}: with the rules of ${REPO_RULES}`);
    return { ...spec, ...(rules ? { rules } : {}) };
  };
  const notes = new ArricurdaiNotes(arricurdai);
  let notesSupported = false;
  void notes.supported().then((supported) => {
    notesSupported = supported;
    log(supported ? 'arricurdAI writes the note of a session before /clear (handoff --prepare)' : 'arricurdAI has no handoff --prepare: /clear starts without a note');
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
      if (agent.state === 'ended' && !endedInLedger.has(agent.id)) {
        endedInLedger.add(agent.id);
        ledger.cost(agent, who(agent));
        ledger.append({ t: Date.now(), kind: 'session', event: 'end', ...who(agent) });
      }
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
      for (const id of ids) {
        ledger.forget(id);
        endedInLedger.delete(id);
      }
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
    log(`guard: ${list} free again for ${waiter.team?.label ?? waiter.project}`);
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
    enabled: guardFor,
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
      // core.fsmonitor=false: the configuration of a repository cannot make this run a program of its own.
      const text = await runQuick('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-C', repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
      return text === undefined ? undefined : parseStatus(text, repo);
    },
  });
  const servers = new Servers({
    agents: () => registry.agents.values(),
    repoOf: (dir) => conflicts.repoOf(dir),
    enabled: (agent) => guardFor(agent).servers,
    run: runQuick,
  });
  /** A git merge of the branch of a member of a team, with commits its reviewer did not approve: you decide. */
  const mergeCheck = async (agent: Agent, payload: Parameters<Guard['decide']>[1]): Promise<GuardDecision | undefined> => {
    const command = (payload.tool_input as { command?: unknown } | undefined)?.command;
    const cwd = agent.cwd ?? payload.cwd;
    if (!guardFor(agent).git || payload.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'Bash' || typeof command !== 'string' || !cwd || agent.state === 'ended') return undefined;
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
        log(`prompt of ${agent.team?.label ?? agent.project} refused by a hook (${ending.kind}): no turn`);
      }
    } catch {
      // No transcript to read: the reconciliation with claude agents corrects the state when the hooks are quiet.
    }
  };
  const watchPrompt = (agent: Agent, at: number, prompt: string): void => {
    for (const delay of REFUSAL_CHECKS_MS) setTimeout(() => void checkRefused(agent, at, prompt), delay).unref();
  };
  /** The state as the daemon last saved it, for the sessions the shutdown of the Mac ended (below). */
  let savedState: { savedAt?: number; agents?: Agent[] } | undefined;
  try {
    const saved = readDataJson(paths.state, 'saved state', log) as { savedAt?: number; agents?: Agent[]; writes?: unknown; ledger?: Record<string, { usd: number }> } | undefined;
    savedState = saved;
    if (saved) {
      registry.restore(saved.agents ?? []);
      // What the ledger counted of each session; a state from before the ledger: it counts from now.
      for (const agent of registry.agents.values()) {
        ledger.prime(agent.id, saved.ledger ? saved.ledger[agent.id] : { usd: agent.usage?.usd ?? 0, ...(agent.tokens ? { tokens: agent.tokens } : {}) });
        if (agent.state === 'ended') endedInLedger.add(agent.id);
      }
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
    log(`saved state not readable, ignored: ${String(error)}`, 'warn');
  }

  // The sessions a restart of the Mac ended: their processes are gone, and their last sign of life came before the
  // Mac started (their pid may already belong to another process). Said ended now, and offered to reopen, each on
  // its conversation.
  const reopener = new Reopener({
    file: paths.reopen,
    log,
    agent: (agentId) => registry.agents.get(agentId),
    agents: () => registry.agents.values(),
    isFolder,
    spawn: (input, extras) => spawnSession({ tmux, registry, claude, log, teamMcp }, input, extras),
    crewReopen: (crewId, agentId, sessionId, cwd) => crews.reopen(crewId, agentId, sessionId, cwd),
    forget: (agentId) => registry.forget(agentId),
    onChange: () => hub?.reopenChanged(),
  });
  {
    const bootAt = Date.now() - uptime() * 1000;
    const lost = endedByRestart([...registry.agents.values()], bootAt);
    // Those the shutdown ended while the daemon still listened: saved as ended, not on purpose.
    const atShutdown = typeof savedState?.savedAt === 'number' ? endedAtShutdown(savedState.agents ?? [], savedState.savedAt, bootAt) : [];
    const now = Date.now();
    for (const agent of lost) {
      markEnded(agent, 'the Mac restarted', now);
      if (!endedInLedger.has(agent.id)) {
        endedInLedger.add(agent.id);
        ledger.append({ t: now, kind: 'session', event: 'end', ...who(agent) });
      }
    }
    // The runs of automations are not offered: their automation says what to do with them ("again").
    const ended = [...lost, ...atShutdown];
    const offered = reopener.remember(ended.filter((agent) => !(agent.team?.crew && crews.get(agent.team.crew)?.auto)));
    if (ended.length > 0) log(`${ended.length} ${ended.length === 1 ? 'session' : 'sessions'} ended when the Mac restarted${offered ? `: ${offered} can be reopened` : ''}`);
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
  // The sessions on an older Claude Code than the one installed: they restart on it when you say so, or by themselves.
  const restarter = new Restarter({
    installed: () => claudeVersion,
    agents: () => registry.agents.values(),
    agent: (agentId) => registry.agents.get(agentId),
    enqueue: (agentId) => commander?.enqueueRestart(agentId) ?? { ok: false, error: 'the daemon is starting' },
    teamBusy: (agentId) => crews.hasOpenWork(agentId),
    auto: () => config.restarts.auto,
    touch: (agent) => registry.touch(agent),
    onChange: () => hub?.setRestarts(restarter.info()),
    log,
  });
  // The menu of a selection in a pane: what tmux copied, and the quick prompts.
  const selections = new SelectionReader(tmux);
  const quickPrompts = new QuickPrompts(paths.prompts, log);

  hub = new Hub({
    token,
    port: () => config.port,
    snapshot: () => registry.list(),
    settings: () => ({ replace: config.panes.replace, arricurdaiNotes: notesSupported, stallMin: config.stallMin }),
    system: () =>
      systemInfo({
        config,
        tmux: (() => {
          try {
            return resolveTool('tmux', config);
          } catch {
            return undefined;
          }
        })(),
        claude,
        claudeVersion,
        arricurdai,
        notesSupported,
        haikuOn,
        socket: server.hooks.listening,
        hookSeen,
        sessions: [...registry.agents.values()].filter((agent) => agent.state !== 'ended').length,
        settingsText: readClaudeSettings(),
      }),
    onSaveSettings: (input) => {
      const checked = cleanSettings(input);
      if ('error' in checked) return { ok: false, error: checked.error };
      const before = editableSettings(config);
      const next = checked.settings;
      // Saved over what the file has (paths of the tools, context windows…): only these fields change.
      const stored = loadConfig(paths.config, log);
      const saved = { ...stored, guard: next.guard, stallMin: next.stallMin, endedRetentionMin: next.endedRetentionMin, restarts: { auto: next.autoRestart }, panes: { replace: next.replace }, hotkey: next.hotkey, port: next.port, summaries: { ...stored.summaries, haiku: next.haiku } };
      try {
        saveConfig(saved);
      } catch (error) {
        return { ok: false, error: `not saved: ${String(error)}` };
      }
      // What takes effect now: the guard, the times, the panes. The port and Haiku wait for a restart.
      config.guard = next.guard;
      config.stallMin = next.stallMin;
      config.endedRetentionMin = next.endedRetentionMin;
      config.restarts = { auto: next.autoRestart };
      hub?.setRestarts(restarter.info());
      config.panes = { replace: next.replace };
      config.hotkey = next.hotkey;
      attention.setStallMs(next.stallMin * 60_000);
      const restart = needsRestart(before, next);
      log(`settings saved from the app${restart.length > 0 ? ` (after a restart: ${restart.join(', ')})` : ''}`);
      return { ok: true, restart };
    },
    onCommand: (message) => {
      if (message.type === 'cancel') {
        commander?.cancel(message.agentId, message.commandId);
        return;
      }
      const result = commander?.enqueue(message.agentId, message.kind, message.arg, message.confirmed, message.fromSelection === true);
      if (result && !result.ok) log(`command refused: ${result.error}`);
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
      if (guard?.letThrough(agentId, path)) log(`guard: ${registry.agents.get(agentId)?.project ?? agentId} let through on ${path}`);
    },
    onSpawn: (input) => spawnSession({ tmux, registry, claude, log, teamMcp }, input),
    crews: () => crews.summaries(),
    automations: () => automations?.views() ?? [],
    reopenList: () => reopener.list(),
    onReopen: (agentIds) => reopener.reopen(agentIds),
    onDismissReopen: (agentIds) => reopener.dismiss(agentIds),
    onSaveAutomation: (input, id) => {
      if (!automations) return { ok: false, error: 'the daemon is starting' };
      // The folder as a session started from the panel keeps it: ~ and the rest resolved.
      const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? (folderOf(raw.cwd.trim()) ?? raw.cwd) : raw.cwd;
      return automations.save({ ...raw, cwd }, id);
    },
    onDeleteAutomation: (id) => automations?.remove(id) ?? { ok: false, error: 'the daemon is starting' },
    onAutoAction: (id, action, arg) => {
      if (!automations) return { ok: false, error: 'the daemon is starting' };
      if (!AUTO_ACTIONS.includes(action as AutoAction)) return { ok: false, error: `unknown action: ${action}` };
      return automations.act(id, action as AutoAction, arg);
    },
    onCrewRequest: (crewId, to, text) => crews.request(crewId, to, text),
    crewThread: (crewId) => crews.thread(crewId),
    crewReviews: (crewId) => crews.reviewsOf(crewId),
    crewDelivered: (crewId) => crews.deliveredOf(crewId),
    onCrewDecide: (crewId, n, to, approve, options) => crews.decide(crewId, n, to, approve, options),
    crewReplay: (crewId) => {
      const crew = crews.get(crewId);
      return crew ? crews.replay(crewId, readLedger(join(paths.varDir, 'ledger'), crew.createdAt)) : undefined;
    },
    onDescribeTeam: (text) => describeTeam(text, { claude, log, templates: templates.list(), roles: roles.list() }),
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
      if (message.action === 'approve' && message.name) {
        return crews.setApprove(message.crewId, message.name, message.approve === true);
      }
      return { ok: false, error: 'unknown change' };
    },
    onCreateCrew: async (input) => {
      const checked = cleanCrewSpec(input);
      if ('error' in checked) return { ok: false, error: checked.error };
      // The folder as the team keeps it: ~ and the rest resolved, like a session started from the panel.
      checked.spec.cwd = folderOf(checked.spec.cwd) ?? checked.spec.cwd;
      return crews.create(withRulesOfRepo(checked.spec));
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
    restarts: () => restarter.info(),
    onRestart: (agentIds) => restarter.restart(agentIds),
    onRestartsGoOn: (goOn) => restarter.resume(goOn),
    claudeUpdate: () => claudeUpdates.info(),
    onClaudeUpdate: (action) => {
      if (action === 'dismiss') claudeUpdates.dismiss();
      else void claudeUpdates.update().then(readClaudeVersion, (error: unknown) => log(`claude update: ${String(error)}`, 'warn'));
    },
    onTeam: (agentId, team) => {
      const agent = registry.agents.get(agentId);
      if (!agent) return;
      teams.set(agent, team);
      registry.touch(agent);
    },
    onPermission: (message) => {
      void permissions?.decide(message.agentId, message.ticket, message.behavior, message.always).then((sent) => {
        if (sent) log(`permission: ${message.behavior === 'allow' ? (message.always !== undefined ? 'always allowed' : 'allowed') : 'denied'} from the box`);
      });
    },
    log,
    onWatched: (watched) => {
      log(watched ? 'a window shows the sessions' : 'no window can be seen: readings of arricurdAI paused');
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
        log(`arricurdai status failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      }
    },
  });

  if (config.summaries.haiku) {
    const key = process.env.FORCHETTA_ANTHROPIC_API_KEY;
    if (!key) {
      log('Haiku summaries are on in the configuration, but FORCHETTA_ANTHROPIC_API_KEY is not set: they stay off', 'warn');
    } else {
      void haikuComplete(key, config.summaries.model).then(
        (complete) => {
          haikuOn = true;
          summarizer = new Summarizer({
            complete,
            minIntervalMs: config.summaries.minIntervalSec * 1000,
            onSummary: (agentId, text) => registry.setModelSummary(agentId, text),
            log,
          });
          log(`Haiku summaries on (${config.summaries.model}, at most every ${config.summaries.minIntervalSec} s per session)`);
        },
        (error: unknown) => log(`Haiku summaries not available: ${String(error)}`, 'warn'),
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
          log(`claude agents --json failed: ${String(error)}`, 'warn');
        }
      }
      const changed = registry.reconcile(entries, panes, isAlive);
      lastReconcile = Date.now();
      log(`reconciliation (${reason}): ${entries.length} sessions from claude agents, ${panes.length} tmux panes${changed ? ', updated' : ''}`);
      return changed;
    } finally {
      reconciling = false;
    }
  }

  crews.onChange = () => hub?.crewsChanged();
  // A request that waits for your approval, and a team that delivered: you are told, as for a session that waits.
  crews.onApproval = (crew, request, delivery) => {
    const agentId = crew.agents[delivery.to] ?? crew.agents.lead;
    const first = request.text.split('\n').find((line) => line.trim())?.trim() ?? '';
    log(`team "${crew.name}": request #${request.n} from ${request.from} to ${delivery.to} waits for your approval`);
    if (agentId) hub?.notify({ agentId, kind: 'approval', title: `${crew.name}: #${request.n} waits for your approval`, body: `${request.from} → ${delivery.to}: ${first.slice(0, 140)}` });
  };
  crews.onDelivered = (crew, item) => {
    const agentId = crew.agents.lead ?? Object.values(crew.agents)[0];
    if (agentId) hub?.notify({ agentId, kind: 'delivered', title: `${crew.name} delivered`, body: `${item.where ? `${item.where}: ` : ''}${item.summary.split('\n')[0]!.slice(0, 160)}` });
    // A run of an automation is over: the next one need not wait for the next tick.
    if (crew.auto) setTimeout(() => void automations?.tick(), 1000);
  };
  const terminals = new Terminals({ token, port: () => config.port, registry, tmux, log });
  commander = new Commander({
    registry,
    tmux,
    log,
    notes,
    onRequest: (_agent, command) => crews.commandChanged(command),
    onRestart: (agent, command, refused) => restarter.commandChanged(agent, command, refused),
    sessionFile: (pid) => readSessionFile(pid),
  });
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
  const ghPath = which('gh');
  automations = new Automations({
    file: paths.automations,
    log,
    crews,
    templates: () => templates.list(),
    withRepoRules: withRulesOfRepo,
    agent: (agentId) => registry.agents.get(agentId),
    costOf: (agentId) => registry.agents.get(agentId)?.usage?.usd ?? 0,
    limits: () => limits.info,
    exit: (agentId) => commander?.enqueueExit(agentId).ok ?? false,
    cancel: (agentId, commandId) => void commander?.cancel(agentId, commandId),
    isFolder,
    github: (cwd, trigger) => {
      const gh = ghPath ?? which('gh');
      return gh ? githubItems(ghRunner(gh), cwd, trigger) : Promise.resolve({ ok: false as const, error: 'gh not found: install the GitHub CLI (brew install gh), then run gh auth login' });
    },
    notify: (notice) => {
      log(`${notice.title}: ${notice.body}`);
      hub?.notify({ agentId: notice.agentId ?? '', kind: 'auto', title: notice.title, body: notice.body });
    },
    onChange: () => hub?.automationsChanged(),
  });
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
        log(`team template ${replaced ? 'replaced' : 'saved'} by a session: "${name}"`);
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
      // A write the guard let through, and stopped after: what it claimed goes (daemon/guard.ts).
      if (stop?.decision === 'deny' && stop !== first) guard?.stopped(agent, payload);
      if (stop?.decision) {
        log(`guard: ${stop.decision} for ${name} (${payload.tool_name})`);
        if (stop.decision === 'deny' || stop.decision === 'ask') ledger.append({ t: Date.now(), kind: 'guard', decision: stop.decision, ...(payload.tool_name ? { tool: payload.tool_name } : {}), ...who(agent) });
        return hookOutput(stop);
      }
      // Notes that stop nothing: who else is halfway through what (once, at its first step), before tests, and the
      // files read that others changed. Those go to the session itself, not to its subagents: it is the session that
      // keeps what it read.
      const changed = guardFor(agent).notes && !payload.agent_id ? changedFilesNote(agent) : undefined;
      if (changed) guardStats.count('changed');
      const arrival = guard?.arrival(agent, payload, Boolean(first?.context));
      const context = [arrival, first?.context, changed].filter(Boolean).join('\n\n');
      if (!context) return undefined;
      ledger.append({ t: Date.now(), kind: 'guard', decision: 'note', ...(payload.tool_name ? { tool: payload.tool_name } : {}), ...who(agent) });
      log(`guard: note for ${name} (${payload.tool_name}): ${context.split('\n')[0]!.slice(0, 160)}`);
      return hookOutput({ context });
    },
    onRateLimits: (windows, agent) => {
      const info = limits.take(windows, Date.now(), agent?.usage ? { agentId: agent.id, usd: agent.usage.usd } : undefined);
      if (info) hub?.setLimits(info);
    },
    onHook: (agent, payload) => {
      quietInterval = QUIET_RECONCILE_MIN_MS;
      if (!hookSeen) {
        hookSeen = true;
        hub?.systemChanged();
      }
      commander?.hook(agent, payload);
      crews.hook(agent, payload);
      permissions?.hook(agent, payload);
      const edit = editOf(payload, agent.cwd, Date.now());
      if (edit) {
        try {
          patches.add(agent.id, edit);
        } catch (error) {
          log(`edit of ${agent.id} not saved: ${String(error)}`, 'warn');
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
          log(`${agent.team?.label ?? agent.project}: going in circles on ${agent.loop.label} (${agent.loop.count} times the same error)`);
        }
        registry.touch(agent);
      }
      // A file the session itself read (not one of its subagents): what it knows of it dates from now.
      if (payload.hook_event_name === 'PostToolUse' && payload.tool_name === 'Read' && !payload.agent_id) {
        const raw = (payload.tool_input as { file_path?: unknown } | undefined)?.file_path;
        const base = agent.cwd ?? payload.cwd;
        if (typeof raw === 'string' && (isAbsolute(raw) || base)) coherence.read(agent.id, isAbsolute(raw) ? resolve(raw) : resolve(base!, raw));
      }
      // The file of a write tool, or those a Bash command that went through wrote as its line tells (> f, sed -i f).
      const base = rootOf(agent.cwd ?? payload.cwd);
      const tool = writtenFile(payload, agent.cwd);
      const files = tool ? [tool] : shellWrittenFiles(payload, agent.cwd, base);
      for (const file of files) {
        const shown = base ? relative(base, file) : file;
        ledger.wrote(agent.id, shown && !shown.startsWith('..') ? shown : file);
      }
      if (!payload.agent_id && (payload.hook_event_name === 'Stop' || payload.hook_event_name === 'StopFailure')) {
        ledger.turn(agent, who(agent), { failed: payload.hook_event_name === 'StopFailure' });
      }
      for (const file of files) {
        coherence.wrote(agent.id, file, edit && edit.file === file ? edit : undefined);
        guard?.wrote(agent, file);
        const notice = notices.get(agent.id);
        if (notice?.paths.has(file)) {
          commander?.cancel(agent.id, notice.commandId);
          notices.delete(agent.id);
        }
      }
      guard?.hook(agent, payload);
      for (const file of files) conflicts.wrote(agent.id, file);
      if (files.length > 0) {
        updateConflicts();
        const count = conflicts.count(agent.id);
        if (agent.filesChanged !== count) {
          agent.filesChanged = count;
          registry.touch(agent);
        }
      }
    },
    api: cliApi({
      crews,
      templates,
      agent: (id) => registry.agents.get(id),
      importTeam: (text, choice) => importTeam(text, (link) => yourSkills.add(link), choice),
      folderOf,
      withRepoRules: withRulesOfRepo,
      log,
      system: () => hub?.system(),
      ...(automations ? { automations } : {}),
      reopen: reopener,
    }),
    info: () => ({ pid: process.pid, port: config.port, startedAt, version: VERSION, agents: registry.agents.size, windows: hub?.size ?? 0, terminals: terminals.size }),
    onShutdown: () => shutdown('asked to stop'),
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
      log(`${agent.project}: pane back to the end (out of the copy mode of tmux)`);
    }
    if (agent.scrolledBack) {
      agent.scrolledBack = undefined;
      registry.touch(agent);
    }
  }

  const timers: NodeJS.Timeout[] = [];
  function shutdown(reason: string): void {
    log(`stopping: ${reason}. The tmux sessions and the claude processes go on.`);
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
      log(`last save failed: ${String(error)}`, 'error');
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
    server.close(() => {
      closeLog();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // What nobody caught: said in the log. A promise is one call that went wrong, the daemon goes on; an exception
  // leaves it in a state nobody knows, so it saves what it can and stops (the app, or launchd, starts it again).
  process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`, 'error'));
  process.on('uncaughtException', (error) => {
    log(`uncaught exception, the daemon stops: ${error.stack ?? error.message}`, 'error');
    try {
      save();
    } catch {
      // What was saved last stays.
    }
    closeLog();
    process.exit(70);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    // Another daemon of this folder holds the port: this one is not needed (exit 0, so that launchd does not start
    // it again and again).
    const other = error.code === 'EADDRINUSE' ? readDaemonInfo() : undefined;
    if (other && other.pid !== process.pid && isAlive(other.pid)) {
      log(`another daemon is running (pid ${other.pid}): this one stops`);
      closeLog();
      process.exit(0);
    }
    log(error.code === 'EADDRINUSE' ? `the port ${config.port} is already in use: is another daemon running?` : `server: ${String(error)}`, 'error');
    process.exit(1);
  });

  // The hooks talk on a socket of the private folder: one left by a daemon that did not stop is taken away first
  // (this one holds the port, so no other daemon is running). macOS takes paths of 104 bytes at most.
  const listenForHooks = (): void => {
    const socket = paths.hooksSocket;
    if (Buffer.byteLength(socket) > 103) {
      log(`socket of the hooks not created: the path is too long (${socket})`, 'error');
      return;
    }
    try {
      rmSync(socket, { force: true });
    } catch {
      // Nothing there.
    }
    server.hooks.on('error', (error) => log(`socket of the hooks: ${String(error)}`, 'error'));
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
    log(`daemon ${VERSION} listening on 127.0.0.1:${config.port} (pid ${process.pid})`);

    timers.push(
      setInterval(() => {
        registry.checkAlive(isAlive);
        // Sessions of `forchetta run` still without a pid: the tmux panes tell it, cheaply.
        if (registry.waitingForPid().length > 0) void listPanes(tmux).then((panes) => registry.reconcile([], panes, isAlive));
      }, LIVENESS_MS),
      setInterval(() => {
        // A command waits for a session that only claude agents can say is ready again: every 10 s, while it waits.
        if (commander?.waitsOnAgentView() && Date.now() - lastReconcile >= QUIET_CHECK_MS) {
          void reconcile('a command waits for the session');
          return;
        }
        if (!registry.hasQuietActivity() || Date.now() - lastReconcile < quietInterval) return;
        void reconcile('quiet hooks').then((changed) => {
          quietInterval = changed ? QUIET_RECONCILE_MIN_MS : Math.min(quietInterval * 2, QUIET_RECONCILE_MAX_MS);
        });
      }, QUIET_CHECK_MS),
      setInterval(() => void reconcile('periodic'), config.reconcileIntervalMin * 60_000),
      setInterval(() => restarter.tick(), LIVENESS_MS),
      // The teams that start by themselves: their runs, their schedules, GitHub.
      setInterval(() => void automations?.tick(), AUTO_TICK_MS),
      setInterval(() => {
        void countTokens();
        // A team that passed its budget: you are told, once; nothing stops.
        for (const { crew, usd } of crews.overBudget((agentId) => registry.agents.get(agentId)?.usage?.usd ?? 0)) {
          const shown = (value: number): string => `$${value.toFixed(2)}`;
          log(`team "${crew.name}": ${shown(usd)}, over its budget of ${shown(crew.budgetUsd ?? 0)}`, 'warn');
          const agentId = crew.agents.lead ?? Object.values(crew.agents)[0];
          if (agentId) {
            hub?.notify({ agentId, kind: 'budget', title: `${crew.name} passed its budget`, body: `Its sessions cost ${shown(usd)}, its budget is ${shown(crew.budgetUsd ?? 0)}. Nothing stops: see its panel.` });
          }
        }
      }, TOKENS_CHECK_MS),
      setInterval(() => void checkScroll().catch((error: unknown) => log(`copy mode: ${String(error)}`, 'warn')), SCROLL_CHECK_MS),
      setInterval(() => {
        if (!anySubagentActive(registry.agents.values())) return;
        const now = Date.now();
        for (const agent of registry.agents.values()) if (checkSubagents(agent, now)) registry.touch(agent);
      }, SUBAGENT_CHECK_MS),
      setInterval(() => {
        registry.sweep(config.endedRetentionMin * 60_000);
        // What the sessions cost since their last entry in the ledger: also for a turn that goes on for long.
        for (const agent of registry.agents.values()) if (agent.state !== 'ended') ledger.cost(agent, who(agent));
        updateConflicts();
        claudeUpdates.check();
        checkClaudeFile();
        // The last days move with the clock: a day that leaves the week leaves the top line too.
        hub?.setGuardStats(guardStats.info());
      }, SWEEP_MS),
    );
    void reconcile('start');
    // The first look of the automations once the sessions are known again (a run at work, its sessions).
    setTimeout(() => void automations?.tick(), 15_000).unref?.();
  });
}

main();
