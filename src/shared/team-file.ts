import type { CrewTemplate } from './crew.ts';
import { type SkillInfo, skillById } from './skills.ts';

// A team as a file, to give to someone else: its template (roles, models, relations, rules, where its boxes and
// notes stand) and, for the skills you added from GitHub, where they come from, so that the other Mac adds them too.
// A skill from a folder of your Mac cannot travel: the other one gets the team without it, and is told so. No Node
// module here: the page writes the file, the daemon reads it.

export const TEAM_FILE_KIND = 'forchetta-team';
export const TEAM_FILE_MAX = 512 * 1024;

export type PortableTemplate = Omit<CrewTemplate, 'builtin' | 'modified'>;

export interface TeamFile {
  kind: typeof TEAM_FILE_KIND;
  version: 1;
  template: PortableTemplate;
  /** The skills you added that the team uses, from GitHub: where to fetch them, at their commit. */
  skills?: { id: string; repo: string; path: string; commit: string }[];
}

/** Every skill a template gives to an agent, each once. */
export function skillsOfTemplate(template: Pick<CrewTemplate, 'lead' | 'members'>): string[] {
  const all = [...(template.lead.kind === 'claude' ? (template.lead.skills ?? []) : []), ...template.members.flatMap((member) => member.skills ?? [])];
  return [...new Set(all)];
}

/** The file of a template: the skills of yours it uses, from GitHub, go with it. */
export function teamFileOf(template: CrewTemplate, skillOf: (id: string) => SkillInfo | undefined = skillById): TeamFile {
  const { builtin: _builtin, modified: _modified, ...portable } = template;
  const skills = skillsOfTemplate(template)
    .map((id) => skillOf(id))
    .filter((skill): skill is SkillInfo => skill !== undefined && skill.group === 'yours' && !skill.local)
    .map((skill) => ({ id: skill.id, repo: skill.repo, path: skill.path, commit: skill.commit }));
  return { kind: TEAM_FILE_KIND, version: 1, template: portable, ...(skills.length > 0 ? { skills } : {}) };
}

/** checkout → checkout.forchetta-team.json */
export const teamFileName = (name: string): string => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team'}.forchetta-team.json`;

/** A file as read: a team of Forchetta, or what is wrong with it. The template is checked by whoever opens it. */
export function parseTeamFile(text: string): { file: TeamFile } | { error: string } {
  if (text.length > TEAM_FILE_MAX) return { error: 'this file is too large for a team' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'this is not a file of a team of Forchetta (it is not JSON)' };
  }
  const file = raw as Partial<TeamFile> | undefined;
  if (!file || file.kind !== TEAM_FILE_KIND || !file.template || typeof file.template !== 'object') return { error: 'this is not a file of a team of Forchetta' };
  if (file.version !== 1) return { error: 'this team was saved by a newer Forchetta: update it to open the team' };
  const skills = (Array.isArray(file.skills) ? file.skills : []).filter(
    (skill): skill is NonNullable<TeamFile['skills']>[number] =>
      !!skill && typeof skill.id === 'string' && typeof skill.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(skill.repo) && typeof skill.path === 'string' && typeof skill.commit === 'string' && /^[0-9a-f]{40}$/.test(skill.commit),
  );
  return { file: { kind: TEAM_FILE_KIND, version: 1, template: file.template as PortableTemplate, ...(skills.length > 0 ? { skills } : {}) } };
}

/** The template without some skills (those that could not come with it). */
export function withoutSkills<T extends Pick<CrewTemplate, 'lead' | 'members'>>(template: T, gone: ReadonlySet<string>): T {
  const keep = (skills: string[] | undefined): { skills?: string[] } => {
    const left = (skills ?? []).filter((id) => !gone.has(id));
    return left.length > 0 ? { skills: left } : {};
  };
  const { skills: _leadSkills, ...lead } = template.lead as CrewTemplate['lead'] & { skills?: string[] };
  return {
    ...template,
    lead: template.lead.kind === 'claude' ? { ...lead, ...keep((template.lead as { skills?: string[] }).skills) } : template.lead,
    members: template.members.map(({ skills, ...member }) => ({ ...member, ...keep(skills) })),
  };
}
