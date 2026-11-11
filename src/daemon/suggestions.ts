import { homedir } from 'node:os';

// The "always" choices of a permission dialog, for the box. Claude Code sends them with the request
// (permission_suggestions): the same ones its dialog offers, such as a rule for a command, a folder to add or a
// mode to switch to. An answer from the box can apply one (updatedPermissions in the decision).
//
// The box offers only those that stay inside the session or the project. A rule for every project would be
// written to ~/.claude/settings.json, and "bypassPermissions" turns off every dialog: those stay in the terminal.

export interface AlwaysOption {
  /** The suggestion as Claude Code sent it: it goes back as it came. */
  update: Record<string, unknown>;
  /** What it allows: "Consenti sempre Bash(npm test:*)". */
  label: string;
  /** Where Claude Code keeps it. */
  where: string;
}

const WHERE: Record<string, string> = {
  session: 'solo in questa sessione',
  localSettings: 'in questo progetto, solo per te',
  projectSettings: 'in questo progetto, per chi lo condivide',
};

const MODES: Record<string, string> = {
  acceptEdits: 'accetta modifiche',
  auto: 'auto',
  plan: 'piano',
  default: 'predefinita',
};

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

function shortPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function rule(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const fields = value as Record<string, unknown>;
  const tool = text(fields.toolName);
  if (!tool) return undefined;
  const content = text(fields.ruleContent);
  return content ? `${tool}(${content})` : tool;
}

/** One suggestion as the box shows it, or undefined when the box does not offer it. */
export function alwaysOption(value: unknown): AlwaysOption | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const update = value as Record<string, unknown>;
  const where = WHERE[String(update.destination)];
  if (!where) return undefined;
  switch (update.type) {
    case 'addRules': {
      if (update.behavior !== 'allow' || !Array.isArray(update.rules)) return undefined;
      const rules = update.rules.map(rule);
      if (rules.length === 0 || rules.some((item) => item === undefined)) return undefined;
      return { update, label: `Consenti sempre ${rules.join(', ')}`, where };
    }
    case 'addDirectories': {
      if (!Array.isArray(update.directories)) return undefined;
      const folders = update.directories.map(text);
      if (folders.length === 0 || folders.some((item) => item === undefined)) return undefined;
      return { update, label: `Consenti e aggiungi la cartella ${folders.map((folder) => shortPath(folder!)).join(', ')}`, where };
    }
    case 'setMode': {
      const mode = MODES[String(update.mode)];
      if (!mode) return undefined;
      return { update, label: `Consenti e passa alla modalità «${mode}»`, where };
    }
    default:
      return undefined;
  }
}

/** The choices the box offers for a request, in the order Claude Code sent them. */
export function alwaysOptions(suggestions: unknown): AlwaysOption[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.map(alwaysOption).filter((option): option is AlwaysOption => option !== undefined);
}
