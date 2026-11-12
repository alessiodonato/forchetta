import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { changesOf } from './diffs.ts';
import { editOf, Patches } from './patches.ts';
import { runRecall } from './recall.ts';
import { folderOf, inGitRepo, spawnSession } from './spawn.ts';
import { Teams } from './teams.ts';
import { crewApi, CrewTemplates, Crews } from './crews.ts';
import { cleanCrewSpec, templateOf } from '../shared/crew.ts';
import { Hub } from './hub.ts';
import { Permissions } from './permissions.ts';
import { isInteractiveCommand, readCommandLine } from './process.ts';
import { Registry } from './registry.ts';
import { createDaemonServer } from './server.ts';
import { addArtifact, mergeArtifacts } from '../shared/artifacts.ts';
import { artifactsInTranscript } from './transcript-artifacts.ts';
import { anySubagentActive, applySubagentHook, checkSubagents, readSubagentThread } from './subagents.ts';
import { subagentKey } from '../shared/present.ts';
import { PANE_MODES_FORMAT, paneModes, scrolledBack } from './scrollback.ts';
import type { Agent } from './state.ts';
import { haikuComplete, Summarizer } from './summarizer.ts';
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

/** Events after which context and cache change: arricurdAI is read again soon. */
const CONTEXT_EVENTS = new Set(['Stop', 'StopFailure', 'PostCompact', 'SessionStart']);

function main(): void {
  process.title = 'forchetta-daemon';
  ensurePrivateDir(paths.varDir);
  const config = loadConfig();
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
    const temporary = `${paths.state}.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({ savedAt: Date.now(), agents: registry.list(), writes: conflicts.dump() })}\n`, { mode: 0o600 });
    renameSync(temporary, paths.state);
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
  const conflicts = new Conflicts();
  const teams = new Teams(paths.teams, log);
  const crews = new Crews(paths.crews, log);
  const templates = new CrewTemplates(paths.crewTemplates, log);
  crews.agent = (agentId) => registry.agents.get(agentId);
  crews.inGit = inGitRepo;
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
  // The tools of a team: Claude Code starts this server for each session that gets them (see mcp/team.ts).
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
      teams.forget(ids);
      patches.forget(ids);
    },
    onUnknownPid: reconcileSoon,
  });
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
  try {
    if (existsSync(paths.state)) {
      const saved = JSON.parse(readFileSync(paths.state, 'utf8')) as { agents?: Agent[]; writes?: unknown };
      registry.restore(saved.agents ?? []);
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
    onSpawn: (input) => spawnSession({ tmux, registry, claude, log }, input),
    crews: () => crews.summaries(),
    onCrewRequest: (crewId, to, text) => crews.request(crewId, to, text),
    crewThread: (crewId) => crews.thread(crewId),
    templates: () => templates.list(),
    onTemplate: (message) => {
      if (message.type === 'deleteCrewTemplate') return templates.delete(message.name);
      // From an existing team: the daemon has its roles and models, the page does not.
      const crew = message.crewId ? crews.get(message.crewId) : undefined;
      if (message.crewId && !crew) return { ok: false, error: 'unknown team' };
      return templates.save(crew ? templateOf(crew) : message.template);
    },
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
    crew: (route, input) => crewApi(crews, route, input),
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
      if (applySubagentHook(agent, payload, Date.now())) registry.touch(agent);
      const file = writtenFile(payload, agent.cwd);
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.on('error', (error: NodeJS.ErrnoException) => {
    log(error.code === 'EADDRINUSE' ? `la porta ${config.port} è già in uso: un altro daemon è attivo?` : `server: ${String(error)}`);
    process.exit(1);
  });

  server.listen(config.port, '127.0.0.1', () => {
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
      }, SWEEP_MS),
    );
    void reconcile('avvio');
  });
}

main();
