import { toolsText } from './agent-tools.ts';
import { BUILTIN_ROLES, type CrewTemplate, cleanTemplate, type RolePreset } from './crew.ts';
import { MACHINE } from './machine.ts';
import { TEMPLATE_GUIDE, TEMPLATE_SCHEMA } from './team-schema.ts';
import { TEAM_FILE_KIND } from './team-file.ts';

// A team drawn from a sentence: "a team to move the frontend to React 19, with tests and a review". In the app the
// daemon asks Claude Code (daemon/describe.ts), with no tools, for a template in the shape of save_team_template;
// in the studio of the browser, which has no Claude, the whole prompt is copied for a chat with Claude, whose answer
// is a team file to paste in "Import". Either way the studio opens it on the canvas, and Forchetta checks it as it
// checks every template: nothing starts until you press "Create team". No Node module here: the page uses it too.

export const DESCRIBE_MAX = 4000;

/** Who Claude is for this, and what makes a good team. */
export const DESCRIBE_SYSTEM = [
  `You design teams of Claude Code agents for Forchetta, an app that runs several Claude Code sessions as a team on the ${MACHINE} of the user, in one folder of a project.`,
  'From the description of the user, write one team as a template, in the JSON shape you are given, and nothing else: no question back, no text around it.',
  'A team has a lead (a Claude session that splits the goal into requests for the members, checks what comes back and tells the user; or the user, lead kind "you", when the description says the user leads) and members, each one a Claude Code session with a role, a model, skills and tools; a member can report to another member, which leads it (more levels).',
  TEMPLATE_GUIDE,
  'Keep the team as small as the work needs: two to six agents for most work, more only when the description asks for them. Models: opus for those who plan, lead or review, sonnet for those who build or test, haiku only for simple fixed steps.',
  'Use the presets of the user where one fits: its name, model, skills and tools, and its role adapted to this team. Write roles, relations, rules and the deliverable in the language of the description; names short and lowercase (developer, tester, reviewer).',
].join('\n\n');

/** The prompt: the presets to start from, then the team the user wants. */
export function describePrompt(text: string, roles: readonly RolePreset[] = BUILTIN_ROLES): string {
  return [
    'The presets of agents in the studio of the user, to start from when one fits (name, model, skills, tools: role):',
    ...roles.map(
      (role) =>
        `- ${role.name}${role.model ? ` (${role.model})` : ''}${role.reviews ? ', reviews' : ''}${role.skills?.length ? `; skills: ${role.skills.join(', ')}` : ''}${toolsText(role.tools) ? `; tools: ${toolsText(role.tools)}` : ''}: ${role.role.replace(/\s+/g, ' ')}`,
    ),
    '',
    'The team the user wants:',
    text.trim(),
  ].join('\n');
}

/** The whole prompt for a chat with Claude, from the studio of the browser: the answer is a team file, for "Import". */
export function describeChatPrompt(text: string, roles: readonly RolePreset[] = BUILTIN_ROLES): string {
  return [
    DESCRIBE_SYSTEM,
    '',
    `Answer with one JSON object only, a team file of Forchetta: {"kind": "${TEAM_FILE_KIND}", "version": 1, "template": <the template>}, where the template follows this JSON Schema:`,
    JSON.stringify(TEMPLATE_SCHEMA),
    '',
    describePrompt(text, roles),
  ].join('\n');
}

/**
 * The template in what Claude wrote: an object, or a text with JSON in it (in a fence, or a team file around it),
 * checked as the panel checks one; or what is wrong with it.
 */
export function templateOfAnswer(answer: unknown): { template: CrewTemplate } | { error: string } {
  let raw = answer;
  if (typeof raw === 'string') {
    const text = raw.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { error: 'Claude did not write a team' };
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      return { error: 'what Claude wrote is not a team (not JSON)' };
    }
  }
  if (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === TEAM_FILE_KIND) raw = (raw as { template?: unknown }).template;
  const checked = cleanTemplate(raw);
  if ('error' in checked) return checked;
  const { builtin: _builtin, modified: _modified, ...template } = checked.template;
  return { template };
}
