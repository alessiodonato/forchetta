// The hooks of Forchetta in the settings of Claude Code. They are added as groups of their own next to the hooks
// already there (those of arricurdAI included), which stay exactly as they are; removing them takes out only
// these groups. Pure functions: the CLI reads and writes the file, shows the diff and asks first.
//
// Every event goes through bin/forchetta-hook, a command that prints nothing and always exits 0. An http hook
// would start no process, but when the daemon is not running Claude Code shows "hook error: connect
// ECONNREFUSED" for every event of every session (seen with 2.1.322), and no setting hides it.
//
// PermissionRequest goes through bin/forchetta-permission instead: it waits for an answer from the box, while
// Claude Code shows its dialog as usual.
//
// PreToolUse has a second hook of Forchetta, in a group of its own with a matcher: bin/forchetta-guard, before the
// tools that write files or run commands. Claude waits for it: the guard can stop the tool (daemon/guard.ts). For
// every other tool nothing waits.

type Json = Record<string, unknown>;

/** Sent in the background: Claude does not wait for them. */
export const ASYNC_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
] as const;

/** Sent before Claude goes on: the start links the session to its process, the end comes as Claude exits. */
export const SYNC_EVENTS = ['SessionStart', 'SessionEnd'] as const;

/** The permission dialog: its hook may answer it, so Claude waits for it, while the dialog is on screen too. */
export const PERMISSION_EVENT = 'PermissionRequest';

export const HOOK_EVENTS = [...SYNC_EVENTS, PERMISSION_EVENT, ...ASYNC_EVENTS] as const;

export const SYNC_TIMEOUT_S = 3;
/** One hour: the hook waits 3540 s at most (its default), then the dialog stays in the terminal only. */
export const PERMISSION_TIMEOUT_S = 3600;

/** The guard: before the tools that write files or run commands, a hook Claude waits for. */
export const GUARD_EVENT = 'PreToolUse';
export const GUARD_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'] as const;
/** Claude Code reads the matcher as a regular expression, not anchored: anchored here, or "Edit" would match "NotebookEdit" and any tool whose name holds it. */
export const GUARD_MATCHER = `^(${GUARD_TOOLS.join('|')})$`;
/** The script gives up on the daemon after 1 s; past this, Claude Code lets the tool go on by itself. */
export const GUARD_TIMEOUT_S = 3;

export interface HookTargets {
  port: number;
  /** Full path of bin/forchetta-hook. */
  hookScript: string;
  /** Full path of bin/forchetta-permission. */
  permissionScript: string;
  /** Full path of bin/forchetta-guard. */
  guardScript: string;
}

/** The http hooks of the first version of Forchetta: still recognised, so that install replaces them. */
const OUR_URL = /^http:\/\/127\.0\.0\.1:\d+\/forchetta\/hook$/;
const OUR_COMMAND = /(?:^|[/"'\s])forchetta-(hook|permission|guard)["']?(?:\s|$)/;

/** Which script of Forchetta a hook runs. */
type Kind = 'hook' | 'permission' | 'guard';

export class UnexpectedSettings extends Error {
  override name = 'UnexpectedSettings';
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function kindOf(hook: Json): Kind | undefined {
  if (hook.type === 'http') return typeof hook.url === 'string' && OUR_URL.test(hook.url) ? 'hook' : undefined;
  if (hook.type !== 'command' || typeof hook.command !== 'string') return undefined;
  return OUR_COMMAND.exec(hook.command)?.[1] as Kind | undefined;
}

/** A hook of Forchetta, from any copy of the folder and any port. */
export const isOurHook = (hook: Json): boolean => kindOf(hook) !== undefined;

const quoteIfNeeded = (path: string): string => (/^[\w/.@+-]+$/.test(path) ? path : `"${path.replace(/(["\\$`])/g, '\\$1')}"`);

/** A hook of Forchetta as it should be, and the matcher of its group (none: every tool). */
export interface WantedHook {
  kind: Kind;
  matcher?: string;
  hook: Json;
}

/** The hooks of Forchetta for one event, in the order they go in. */
export function wantedHooks(event: string, targets: HookTargets): WantedHook[] {
  if (event === PERMISSION_EVENT) {
    return [{ kind: 'permission', hook: { type: 'command', command: `${quoteIfNeeded(targets.permissionScript)} ${targets.port}`, timeout: PERMISSION_TIMEOUT_S } }];
  }
  const command = `${quoteIfNeeded(targets.hookScript)} ${targets.port}`;
  const sync = (SYNC_EVENTS as readonly string[]).includes(event);
  const wanted: WantedHook[] = [{ kind: 'hook', hook: sync ? { type: 'command', command, timeout: SYNC_TIMEOUT_S } : { type: 'command', command, async: true } }];
  if (event === GUARD_EVENT) {
    wanted.push({ kind: 'guard', matcher: GUARD_MATCHER, hook: { type: 'command', command: `${quoteIfNeeded(targets.guardScript)} ${targets.port}`, timeout: GUARD_TIMEOUT_S } });
  }
  return wanted;
}

function hooksOf(settings: Json): Json {
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) throw new UnexpectedSettings('"hooks" is not an object');
  return hooks;
}

function groupsOf(hooks: Json, event: string): Json[] {
  const groups = hooks[event] ?? [];
  if (!Array.isArray(groups) || !groups.every(isObject)) throw new UnexpectedSettings(`the hooks of ${event} are not a list of groups`);
  return groups;
}

function handlersOf(group: Json, event: string): Json[] {
  const handlers = group.hooks ?? [];
  if (!Array.isArray(handlers) || !handlers.every(isObject)) throw new UnexpectedSettings(`a group of ${event} has no list of hooks`);
  return handlers;
}

const describe = (hook: Json): string =>
  hook.type === 'http'
    ? `http ${String(hook.url)}`
    : `command ${String(hook.command)}${hook.async === true ? ' (async)' : typeof hook.timeout === 'number' ? ` (waits, timeout ${hook.timeout} s)` : ''}`;

/** The event, with the matcher of the group when it has one: "PreToolUse [^(Edit|Write)$]". */
const where = (event: string, matcher: unknown): string => (typeof matcher === 'string' && matcher ? `${event} [${matcher}]` : event);

/**
 * The settings with every hook of Forchetta in place, and one line for each change. Each wanted hook takes the place
 * of one of ours already there: the one with the same script, or else any other of ours (the PermissionRequest hook
 * of 0.4 ran forchetta-hook). With none, it gets a group of its own at the end.
 */
export function withForchettaHooks(settings: Json, targets: HookTargets): { settings: Json; changes: string[] } {
  const next = structuredClone(settings);
  const hooks = hooksOf(next);
  const changes: string[] = [];
  for (const event of HOOK_EVENTS) {
    let groups = groupsOf(hooks, event);
    const ours = groups.flatMap((group) => handlersOf(group, event).map((hook) => ({ group, hook })).filter(({ hook }) => isOurHook(hook)));
    const taken = new Set<Json>();
    for (const wanted of wantedHooks(event, targets)) {
      const found = ours.find(({ hook }) => !taken.has(hook) && kindOf(hook) === wanted.kind) ?? ours.find(({ hook }) => !taken.has(hook));
      if (!found) {
        groups = [...groups, wanted.matcher ? { matcher: wanted.matcher, hooks: [wanted.hook] } : { hooks: [wanted.hook] }];
        changes.push(`+ ${where(event, wanted.matcher)}: ${describe(wanted.hook)}`);
        continue;
      }
      taken.add(found.hook);
      const handlers = handlersOf(found.group, event);
      const index = handlers.indexOf(found.hook);
      const matcher = found.group.matcher || undefined;
      if (JSON.stringify(found.hook) !== JSON.stringify(wanted.hook)) {
        handlers[index] = wanted.hook;
        changes.push(`~ ${where(event, matcher)}: ${describe(found.hook)} → ${describe(wanted.hook)}`);
      }
      if (matcher === wanted.matcher) continue;
      // The group of this hook has another matcher. Alone in it, the group takes the right one; next to hooks of
      // yours, it moves to a group of its own, and yours keep theirs.
      if (handlers.length === 1) {
        if (wanted.matcher) found.group.matcher = wanted.matcher;
        else delete found.group.matcher;
      } else {
        handlers.splice(index, 1);
        groups = [...groups, wanted.matcher ? { matcher: wanted.matcher, hooks: [wanted.hook] } : { hooks: [wanted.hook] }];
      }
      changes.push(`~ ${where(event, matcher)}: ${describe(wanted.hook)} now in ${where(event, wanted.matcher)}`);
    }
    hooks[event] = groups;
  }
  next.hooks = hooks;
  return { settings: next, changes };
}

/** The settings without any hook of Forchetta, and with no empty group or list left where they were. */
export function withoutForchettaHooks(settings: Json): { settings: Json; changes: string[] } {
  const next = structuredClone(settings);
  if (next.hooks === undefined) return { settings: next, changes: [] };
  const hooks = hooksOf(next);
  const changes: string[] = [];
  for (const event of Object.keys(hooks)) {
    const kept: Json[] = [];
    for (const group of groupsOf(hooks, event)) {
      const handlers = handlersOf(group, event);
      const others = handlers.filter((hook) => {
        if (!isOurHook(hook)) return true;
        changes.push(`- ${where(event, group.matcher)}: ${describe(hook)}`);
        return false;
      });
      if (others.length === handlers.length) kept.push(group);
      else if (others.length > 0) kept.push({ ...group, hooks: others });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return { settings: next, changes };
}

/** The settings as Claude Code writes them: two spaces, a final newline. */
export const formatSettings = (settings: Json): string => `${JSON.stringify(settings, null, 2)}\n`;

// The status line. Claude Code gives it the cost of the session at every message (seen with 2.1.322), and
// nothing else gives it per session. Forchetta puts bin/forchetta-statusline in its place: the
// script sends them to the daemon and runs the command you had, saved in var/statusline-command, so the line at
// the bottom stays the same. The other keys of the status line (padding, …) stay as they are.

const OUR_STATUS = /(?:^|[/"'\s])forchetta-statusline["']?(?:\s|$)/;

export const isOurStatusLine = (value: unknown): boolean =>
  isObject(value) && typeof value.command === 'string' && OUR_STATUS.test(value.command);

export interface StatusLinePlan {
  settings: Json;
  changes: string[];
  /** The command to save and run after ours: undefined when there was no status line. */
  original?: string;
}

/** The settings with the status line of Forchetta in front of yours. */
export function withForchettaStatusLine(settings: Json, targets: { port: number; statusScript: string }): StatusLinePlan {
  const next = structuredClone(settings);
  const current = next.statusLine;
  const command = `${quoteIfNeeded(targets.statusScript)} ${targets.port}`;
  if (current !== undefined && !isObject(current)) throw new UnexpectedSettings('"statusLine" is not an object');
  if (isOurStatusLine(current)) {
    if (current!.command === command) return { settings: next, changes: [] };
    next.statusLine = { ...current, command };
    return { settings: next, changes: [`~ statusLine: ${String(current!.command)} → ${command}`] };
  }
  const original = isObject(current) && typeof current.command === 'string' && current.command.trim() ? current.command : undefined;
  next.statusLine = { ...(isObject(current) ? current : {}), type: 'command', command };
  return {
    settings: next,
    changes: [original ? `~ statusLine: ${command}, which then runs the command you had` : `+ statusLine: ${command} (there was none)`],
    original,
  };
}

/** The settings with your status line back: the saved command, or none if there was none. */
export function withoutForchettaStatusLine(settings: Json, original: string | undefined): { settings: Json; changes: string[] } {
  const next = structuredClone(settings);
  const current = next.statusLine;
  if (!isOurStatusLine(current)) return { settings: next, changes: [] };
  if (original) {
    next.statusLine = { ...(current as Json), command: original };
    return { settings: next, changes: [`~ statusLine: back to ${original}`] };
  }
  delete next.statusLine;
  return { settings: next, changes: ['- statusLine'] };
}
