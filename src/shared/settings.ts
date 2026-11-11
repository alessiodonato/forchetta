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

export interface HookTargets {
  port: number;
  /** Full path of bin/forchetta-hook. */
  hookScript: string;
  /** Full path of bin/forchetta-permission. */
  permissionScript: string;
}

/** The http hooks of the first version of Forchetta: still recognised, so that install replaces them. */
const OUR_URL = /^http:\/\/127\.0\.0\.1:\d+\/forchetta\/hook$/;
const OUR_COMMAND = /(?:^|[/"'\s])forchetta-(?:hook|permission)["']?(?:\s|$)/;

export class UnexpectedSettings extends Error {
  override name = 'UnexpectedSettings';
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A hook of Forchetta, from any copy of the folder and any port. */
export function isOurHook(hook: Json): boolean {
  if (hook.type === 'http') return typeof hook.url === 'string' && OUR_URL.test(hook.url);
  if (hook.type === 'command') return typeof hook.command === 'string' && OUR_COMMAND.test(hook.command);
  return false;
}

const quoteIfNeeded = (path: string): string => (/^[\w/.@+-]+$/.test(path) ? path : `"${path.replace(/(["\\$`])/g, '\\$1')}"`);

export function wantedHook(event: string, targets: HookTargets): Json {
  if (event === PERMISSION_EVENT) return { type: 'command', command: `${quoteIfNeeded(targets.permissionScript)} ${targets.port}`, timeout: PERMISSION_TIMEOUT_S };
  const command = `${quoteIfNeeded(targets.hookScript)} ${targets.port}`;
  if ((SYNC_EVENTS as readonly string[]).includes(event)) return { type: 'command', command, timeout: SYNC_TIMEOUT_S };
  return { type: 'command', command, async: true };
}

function hooksOf(settings: Json): Json {
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) throw new UnexpectedSettings('"hooks" non è un oggetto');
  return hooks;
}

function groupsOf(hooks: Json, event: string): Json[] {
  const groups = hooks[event] ?? [];
  if (!Array.isArray(groups) || !groups.every(isObject)) throw new UnexpectedSettings(`gli hook di ${event} non sono una lista di gruppi`);
  return groups;
}

function handlersOf(group: Json, event: string): Json[] {
  const handlers = group.hooks ?? [];
  if (!Array.isArray(handlers) || !handlers.every(isObject)) throw new UnexpectedSettings(`un gruppo di ${event} non ha una lista di hook`);
  return handlers;
}

const describe = (hook: Json): string =>
  hook.type === 'http'
    ? `http ${String(hook.url)}`
    : `command ${String(hook.command)}${hook.async === true ? ' (async)' : typeof hook.timeout === 'number' ? ` (attende, timeout ${hook.timeout} s)` : ''}`;

/** The settings with every hook of Forchetta in place, and one line for each change. */
export function withForchettaHooks(settings: Json, targets: HookTargets): { settings: Json; changes: string[] } {
  const next = structuredClone(settings);
  const hooks = hooksOf(next);
  const changes: string[] = [];
  for (const event of HOOK_EVENTS) {
    const groups = groupsOf(hooks, event);
    const wanted = wantedHook(event, targets);
    let found = false;
    for (const group of groups) {
      const handlers = handlersOf(group, event);
      handlers.forEach((hook, index) => {
        if (!isOurHook(hook)) return;
        found = true;
        if (JSON.stringify(hook) === JSON.stringify(wanted)) return;
        handlers[index] = wanted;
        changes.push(`~ ${event}: ${describe(hook)} → ${describe(wanted)}`);
      });
    }
    if (!found) {
      hooks[event] = [...groups, { hooks: [wanted] }];
      changes.push(`+ ${event}: ${describe(wanted)}`);
    }
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
        changes.push(`- ${event}: ${describe(hook)}`);
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
  if (current !== undefined && !isObject(current)) throw new UnexpectedSettings('"statusLine" non è un oggetto');
  if (isOurStatusLine(current)) {
    if (current!.command === command) return { settings: next, changes: [] };
    next.statusLine = { ...current, command };
    return { settings: next, changes: [`~ statusLine: ${String(current!.command)} → ${command}`] };
  }
  const original = isObject(current) && typeof current.command === 'string' && current.command.trim() ? current.command : undefined;
  next.statusLine = { ...(isObject(current) ? current : {}), type: 'command', command };
  return {
    settings: next,
    changes: [original ? `~ statusLine: ${command}, che poi esegue il tuo comando di prima` : `+ statusLine: ${command} (prima non c'era)`],
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
    return { settings: next, changes: [`~ statusLine: di nuovo ${original}`] };
  }
  delete next.statusLine;
  return { settings: next, changes: ['- statusLine'] };
}
