import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { type Config, detectArricurdai, loadConfig, saveConfig, which } from '../shared/config.ts';
import { UserError } from '../shared/errors.ts';
import { claudeConfigDir, ensurePrivateDir, paths } from '../shared/paths.ts';
import {
  formatSettings,
  isOurStatusLine,
  UnexpectedSettings,
  withForchettaHooks,
  withForchettaStatusLine,
  withoutForchettaHooks,
  withoutForchettaStatusLine,
} from '../shared/settings.ts';
import type { RunIO } from './run.ts';

// `forchetta hooks install|uninstall`: the only commands that change a file outside the Forchetta folder,
// ~/.claude/settings.json. They show the diff, ask first, keep a copy of the old file in var/backups, and
// refuse when the file changed while they were asking. Besides the hooks they put bin/forchetta-statusline in
// front of your status line (see shared/settings.ts), and take it away.

export interface HooksOptions {
  yes: boolean;
}

/** A unified diff of two texts, from the diff of the system. */
export function unifiedDiff(before: string, after: string, label: string): string {
  ensurePrivateDir(paths.tmpDir);
  const a = join(paths.tmpDir, `diff-a-${process.pid}`);
  const b = join(paths.tmpDir, `diff-b-${process.pid}`);
  writeFileSync(a, before, { mode: 0o600 });
  writeFileSync(b, after, { mode: 0o600 });
  try {
    const result = spawnSync('/usr/bin/diff', ['-u', '--label', `${label} (ora)`, '--label', `${label} (dopo)`, a, b], { encoding: 'utf8' });
    return result.stdout;
  } finally {
    rmSync(a, { force: true });
    rmSync(b, { force: true });
  }
}

async function confirm(question: string, io: RunIO): Promise<boolean> {
  if (!process.stdin.isTTY) {
    io.stdout('Nessuna modifica: non è un terminale interattivo. Per applicarle senza domanda: --yes\n');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(s|si|sì|y|yes)$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** Writes the file in one step, through a symbolic link if there is one, with the permissions of the old file. */
function writeSettings(file: string, text: string): string | undefined {
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(dirname(target), { recursive: true });
  let backup: string | undefined;
  if (existsSync(target)) {
    ensurePrivateDir(paths.backups);
    backup = join(paths.backups, `settings.json.${new Date().toISOString().replace(/[:.]/g, '-')}`);
    copyFileSync(target, backup);
    chmodSync(backup, 0o600);
  }
  const temporary = `${target}.forchetta-${process.pid}`;
  writeFileSync(temporary, text);
  if (existsSync(target)) chmodSync(temporary, statSync(target).mode & 0o777);
  renameSync(temporary, target);
  return backup;
}

/** The full paths of the tools, and the command of arricurdAI, for an app opened from the Finder with a short PATH. */
function withToolPaths(config: Config, settingsText: string | undefined): Config {
  return {
    ...config,
    paths: {
      node: config.paths.node ?? process.execPath,
      tmux: config.paths.tmux ?? which('tmux'),
      claude: config.paths.claude ?? which('claude'),
    },
    arricurdai: config.arricurdai ?? detectArricurdai(settingsText),
  };
}

export async function hooksCommand(action: 'install' | 'uninstall', options: HooksOptions, io: RunIO): Promise<number> {
  const file = join(claudeConfigDir(), 'settings.json');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  let settings: unknown;
  try {
    settings = before === undefined || before.trim() === '' ? {} : JSON.parse(before);
  } catch {
    throw new UserError(`${file} non è JSON valido: lo lascio com'è. Correggilo e riprova.`);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new UserError(`${file} non è un oggetto JSON: lo lascio com'è.`);

  const config = withToolPaths(loadConfig(), before);
  if (action === 'install') saveConfig(config);

  let plan: { settings: Record<string, unknown>; changes: string[] };
  /** The status line command to keep in var/statusline-command: a string to write, null to remove the file. */
  let saveCommand: string | null | undefined;
  try {
    if (action === 'install') {
      const hooks = withForchettaHooks(settings as Record<string, unknown>, { port: config.port, hookScript: paths.hookScript, permissionScript: paths.permissionScript });
      const status = withForchettaStatusLine(hooks.settings, { port: config.port, statusScript: paths.statusScript });
      plan = { settings: status.settings, changes: [...hooks.changes, ...status.changes] };
      // Only when the status line becomes ours now: a second install keeps the command saved the first time.
      if (status.changes.length > 0 && !isOurStatusLine(hooks.settings.statusLine)) saveCommand = status.original ?? null;
    } else {
      const saved = existsSync(paths.statusCommand) ? readFileSync(paths.statusCommand, 'utf8') : '';
      const hooks = withoutForchettaHooks(settings as Record<string, unknown>);
      const status = withoutForchettaStatusLine(hooks.settings, saved.trim() ? saved : undefined);
      plan = { settings: status.settings, changes: [...hooks.changes, ...status.changes] };
      if (status.changes.length > 0) saveCommand = null;
    }
  } catch (error) {
    if (error instanceof UnexpectedSettings) throw new UserError(`${file} lasciato com'è: ${error.message}.`);
    throw error;
  }

  if (plan.changes.length === 0) {
    io.stdout(action === 'install' ? `Gli hook di Forchetta sono già in ${file}.\n` : `Nessun hook di Forchetta in ${file}.\n`);
    return 0;
  }

  const after = formatSettings(plan.settings);
  io.stdout(`${action === 'install' ? 'Aggiungo' : 'Tolgo'} questi hook in ${file}:\n\n${plan.changes.map((line) => `  ${line}`).join('\n')}\n\n`);
  io.stdout(`Diff completo:\n\n${unifiedDiff(before ?? '', after, file)}\n`);
  if (before !== undefined && formatSettings(settings as Record<string, unknown>) !== before) {
    io.stdout('Nota: il file sarà riscritto con due spazi di rientro, come lo scrive Claude Code; il diff lo mostra.\n\n');
  }

  if (!options.yes && !(await confirm('Applico le modifiche? [s/N] ', io))) {
    if (process.stdin.isTTY) io.stdout('Nessuna modifica.\n');
    return 0;
  }
  const now = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (now !== before) throw new UserError(`${file} è cambiato nel frattempo: lo lascio com'è. Riesegui il comando.`);

  // The command you had goes in place before the status line that runs it.
  if (typeof saveCommand === 'string') {
    ensurePrivateDir(paths.varDir);
    writeFileSync(paths.statusCommand, saveCommand, { mode: 0o600 });
  }
  const backup = writeSettings(file, after);
  if (saveCommand === null) rmSync(paths.statusCommand, { force: true });
  io.stdout(
    `Fatto.${backup ? ` Copia del file precedente: ${backup}` : ''}\n` +
      (action === 'install'
        ? 'Claude Code rilegge gli hook da solo: valgono anche per le sessioni già aperte.\nPer toglierli: forchetta hooks uninstall\n'
        : ''),
  );
  return 0;
}
