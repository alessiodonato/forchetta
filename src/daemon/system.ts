import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../shared/config.ts';
import { claudeConfigDir, paths } from '../shared/paths.ts';
import { isOurStatusLine, withForchettaHooks } from '../shared/settings.ts';
import { type EditableSettings, newerThanTested, type OptionalFeature, PROTOCOL, type SetupCheck, type SystemInfo, TESTED_CLAUDE } from '../shared/system.ts';
import { VERSION } from '../shared/version.ts';
import { launchAgentFile } from './launch-agent.ts';
import { opensAtLogin } from './open-at-login.ts';

// What the daemon knows of the installation, for the checklist of the first start, the settings of the app and
// `forchetta doctor` (shared/system.ts).

export interface SystemInputs {
  config: Config;
  tmux?: string;
  claude?: string;
  claudeVersion?: string;
  arricurdai?: readonly string[];
  notesSupported: boolean;
  haikuOn: boolean;
  /** The socket of the hooks listens. */
  socket: boolean;
  /** A hook reached this daemon since it started. */
  hookSeen: boolean;
  /** Sessions the daemon knows, running. */
  sessions: number;
  /** ~/.claude/settings.json as text, when it can be read. */
  settingsText?: string;
}

const tilde = (path: string): string => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

/** ~/.claude/settings.json, read again each time: hooks installed while the daemon runs are seen. */
export function readClaudeSettings(): string | undefined {
  try {
    return readFileSync(join(claudeConfigDir(), 'settings.json'), 'utf8');
  } catch {
    return undefined;
  }
}

export function setupChecks(inputs: SystemInputs): SetupCheck[] {
  let settings: Record<string, unknown> | undefined;
  try {
    const parsed = inputs.settingsText ? (JSON.parse(inputs.settingsText) as unknown) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    settings = undefined;
  }
  const file = tilde(join(claudeConfigDir(), 'settings.json'));
  let hooksOk = false;
  if (settings) {
    try {
      hooksOk =
        withForchettaHooks(settings, { port: inputs.config.port, hookScript: paths.hookScript, permissionScript: paths.permissionScript, guardScript: paths.guardScript }).changes.length === 0;
    } catch {
      hooksOk = false;
    }
  }
  const statusLine = Boolean(settings && isOurStatusLine(settings.statusLine));
  return [
    {
      id: 'hooks',
      ok: hooksOk,
      label: `Hooks in ${file}`,
      detail: hooksOk ? 'installed, for this copy of Forchetta' : settings ? 'missing, or of another copy of Forchetta' : `${file} is not valid JSON`,
      ...(hooksOk ? {} : { fix: 'forchetta hooks install' }),
    },
    {
      id: 'statusline',
      ok: statusLine,
      label: 'Status line',
      detail: statusLine ? 'gives the context, the cost and the limits of each session' : 'without it, context and cost come from arricurdAI, if you use it',
      ...(statusLine ? {} : { fix: 'forchetta hooks install' }),
    },
    {
      id: 'tmux',
      ok: Boolean(inputs.tmux),
      label: 'tmux',
      detail: inputs.tmux ? tilde(inputs.tmux) : 'not found: the sessions cannot open in the app',
      ...(inputs.tmux ? {} : { fix: 'brew install tmux' }),
    },
    {
      id: 'claude',
      ok: Boolean(inputs.claude),
      label: 'Claude Code',
      detail: inputs.claude ? `${tilde(inputs.claude)}${inputs.claudeVersion ? ` · ${inputs.claudeVersion}` : ''}` : 'not found: install Claude Code, then restart the daemon',
    },
    {
      id: 'socket',
      ok: inputs.socket,
      label: 'Socket of the hooks',
      detail: inputs.socket ? tilde(paths.hooksSocket) : `not listening: see ${tilde(paths.log)}`,
    },
    {
      id: 'events',
      ok: inputs.hookSeen || inputs.sessions === 0,
      label: 'Events from the sessions',
      detail: inputs.hookSeen
        ? 'the hooks reach the daemon'
        : inputs.sessions === 0
          ? 'no session yet'
          : 'none yet: sessions started before the hooks were installed send none (start them again)',
    },
  ];
}

export function optionalFeatures(inputs: SystemInputs): OptionalFeature[] {
  const link = 'https://github.com/alessiodonato/arricurdai';
  return [
    inputs.arricurdai
      ? { id: 'arricurdai', on: true, label: 'arricurdAI', why: 'the prompt cache of each session, the cost of today, search through earlier sessions', link }
      : {
          id: 'arricurdai',
          on: false,
          label: 'arricurdAI',
          why: 'not found: no prompt cache, cost of today and search through earlier sessions',
          how: 'install arricurdAI; Forchetta finds it in the PATH or in the hooks of Claude Code, after a restart of the daemon',
          link,
        },
    {
      id: 'notes',
      on: inputs.notesSupported,
      label: 'A note before /clear',
      why: inputs.notesSupported ? 'the new conversation gets a note on the old one' : 'needs arricurdAI 0.5.0 or later',
      ...(inputs.notesSupported ? {} : { how: 'update arricurdAI, then restart the daemon', link }),
    },
    {
      id: 'haiku',
      on: inputs.haikuOn,
      label: 'One-line summaries by Haiku',
      why: inputs.haikuOn ? 'a short summary of what each session does, written by a Haiku model' : 'off: the line of each box comes from its events',
      ...(inputs.haikuOn ? {} : { how: 'turn it on in Settings and set FORCHETTA_ANTHROPIC_API_KEY for the daemon; it calls the Anthropic API' }),
    },
    {
      id: 'keepalive',
      on: existsSync(launchAgentFile()),
      label: 'Daemon kept alive by macOS',
      why: existsSync(launchAgentFile()) ? 'macOS starts it at login and again if it stops by mistake' : 'off: the app or the CLI start the daemon when they need it',
      ...(existsSync(launchAgentFile()) ? {} : { how: 'forchetta daemon keepalive on' }),
    },
  ];
}

export const editableSettings = (config: Config, platform: NodeJS.Platform = process.platform): EditableSettings => ({
  guard: { ...config.guard },
  stallMin: config.stallMin,
  endedRetentionMin: config.endedRetentionMin,
  autoRestart: config.restarts.auto,
  checkUpdates: config.updates.check,
  replace: config.panes.replace,
  hotkey: config.hotkey,
  port: config.port,
  haiku: config.summaries.haiku,
  // Not in the file: the LaunchAgent is there or not.
  ...(platform === 'darwin' ? { openAtLogin: opensAtLogin() } : {}),
});

export function systemInfo(inputs: SystemInputs): SystemInfo {
  return {
    version: VERSION,
    protocol: PROTOCOL,
    checks: setupChecks(inputs),
    features: optionalFeatures(inputs),
    claude: { ...(inputs.claudeVersion ? { installed: inputs.claudeVersion } : {}), tested: TESTED_CLAUDE, ...(newerThanTested(inputs.claudeVersion) ? { newer: newerThanTested(inputs.claudeVersion) } : {}) },
    settings: editableSettings(inputs.config),
    varDir: tilde(paths.varDir),
    logFile: tilde(paths.log),
  };
}
