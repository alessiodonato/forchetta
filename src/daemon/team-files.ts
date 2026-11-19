import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanTemplate, type CrewTemplate } from '../shared/crew.ts';
import { skillById } from '../shared/skills.ts';
import { parseTeamFile, skillsOfTemplate, TEAM_FILE_MAX, teamFileName, withoutSkills } from '../shared/team-file.ts';

// A team as a file (shared/team-file.ts), on this Mac: saved in your Downloads (the window of the app cannot save a
// file by itself), and opened again, with the skills of GitHub it needs added on the way.

/** Saves the text of a team file in a folder (your Downloads), with a number when the name is taken; its path. */
export function saveTeamFile(name: string, text: string, dir = join(homedir(), 'Downloads')): { ok: true; path: string } | { ok: false; error: string } {
  if (text.length > TEAM_FILE_MAX) return { ok: false, error: 'this team is too large for a file' };
  try {
    mkdirSync(dir, { recursive: true });
    const base = teamFileName(name).replace(/\.forchetta-team\.json$/, '');
    let path = join(dir, `${base}.forchetta-team.json`);
    for (let n = 2; existsSync(path); n++) path = join(dir, `${base} ${n}.forchetta-team.json`);
    writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o644 });
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: `not saved: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * A team file opened: its template, checked; the skills of GitHub it needs and this Mac does not have are added
 * (at their commit); those that cannot come (a folder of the other Mac, or a fetch that failed) are left out, and
 * said in the notes.
 */
export async function importTeam(
  text: string,
  addSkill: (link: string) => Promise<{ ok: boolean; error?: string }>,
): Promise<{ ok: true; template: CrewTemplate; notes: string[] } | { ok: false; error: string }> {
  const parsed = parseTeamFile(text);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const { template, skills = [] } = parsed.file;
  const notes: string[] = [];
  const gone = new Set<string>();
  for (const id of skillsOfTemplate(template)) {
    if (skillById(id)) continue;
    const source = skills.find((skill) => skill.id === id);
    if (!source) {
      gone.add(id);
      notes.push(`${id} is left out: it was a skill from a folder of the Mac the team comes from`);
      continue;
    }
    const added = await addSkill(`https://github.com/${source.repo}/tree/${source.commit}/${source.path}`);
    if (added.ok && skillById(id)) notes.push(`added the skill ${id}, from ${source.repo} at ${source.commit.slice(0, 7)}`);
    else {
      gone.add(id);
      notes.push(`${id} is left out: ${added.error ?? 'it could not be added'}`);
    }
  }
  const checked = cleanTemplate(gone.size > 0 ? withoutSkills(template, gone) : template);
  if ('error' in checked) return { ok: false, error: checked.error };
  return { ok: true, template: checked.template, notes };
}
