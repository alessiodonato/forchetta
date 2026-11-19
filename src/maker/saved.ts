import type { CrewTemplates, RolePresets } from '../daemon/crews.ts';
import { customSkills, setCustomSkills, type SkillInfo } from '../shared/skills.ts';
import type { StudioDoc } from '../ui/studio-model.ts';

// What the studio of forchetta.dev keeps in this browser (localStorage): the canvas, the agents and the teams you
// saved, the skills you added. Nothing leaves the browser; a private window, or cleared site data, starts empty.

const KEY = 'forchetta.maker';

interface Saved {
  canvas?: StudioDoc;
  templates?: unknown[];
  roles?: unknown[];
  skills?: SkillInfo[];
}

function read(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' ? (raw as Saved) : {};
  } catch {
    return {};
  }
}

let daemon: { templates: CrewTemplates; roles: RolePresets } | undefined;
let canvas: StudioDoc | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The canvas kept last time, if any. */
export const savedCanvas = (): StudioDoc | undefined => read().canvas;

/** Puts back in the daemon of the page what this browser kept: the skills first, which the others may use. */
export function loadSaved(into: { templates: CrewTemplates; roles: RolePresets }): void {
  daemon = into;
  const saved = read();
  canvas = saved.canvas;
  if (Array.isArray(saved.skills)) setCustomSkills(saved.skills.filter((skill) => skill && typeof skill.id === 'string' && skill.group === 'yours' && !skill.local));
  for (const role of saved.roles ?? []) into.roles.save(role);
  for (const template of saved.templates ?? []) into.templates.save(template, { override: true });
}

/** The canvas changed: kept with the rest, a moment later. */
export function keepCanvas(doc: StudioDoc): void {
  canvas = doc;
  saveSoon();
}

/** Writes it all, half a second after the last change. */
export function saveSoon(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    const saved: Saved = {
      ...(canvas ? { canvas } : {}),
      templates: daemon?.templates.list().filter((template) => !template.builtin || template.modified) ?? [],
      roles: daemon?.roles.list().filter((role) => !role.builtin || role.modified) ?? [],
      skills: [...customSkills()],
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      // Full, or storage off: the page works the same, and forgets at its next load.
    }
  }, 500);
}
