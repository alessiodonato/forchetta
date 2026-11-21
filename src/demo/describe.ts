import { BUILTIN_ROLES, type CrewMemberSpec, type CrewTemplate, type RolePreset } from '../shared/crew.ts';
import { templateOfAnswer } from '../shared/describe.ts';

// "Describe…" in the demo: no Claude in a browser, so the team is made of the presets your words name (a tester for
// "tests", a reviewer for "review"…), under a lead, and opens on the canvas like one Claude drew. On a Mac, Claude
// draws it (daemon/describe.ts).

const WORDS: readonly [RegExp, string][] = [
  [/\b(senior|junior)\b/, 'senior'],
  [/\b(front ?end|ui|interface|react|css|design)/, 'frontend'],
  [/\b(back ?end|api|server|database|db)\b/, 'backend'],
  [/\b(test|tests|tester|qa|e2e)\b/, 'tester'],
  [/\b(review|reviewer|revisor|revisione|approv)/, 'reviewer'],
  [/\b(research|ricerca|ricercatore|facts|sources)/, 'researcher'],
  [/\b(write|writer|docs|documentation|documentazione|scrive)/, 'writer'],
];

export function demoDescribe(text: string, roles: readonly RolePreset[] = BUILTIN_ROLES): { ok: boolean; template?: CrewTemplate; error?: string; note?: string } {
  const words = text.toLowerCase();
  if (!words.trim()) return { ok: false, error: 'describe the team first: what it is for, who does what' };
  const preset = (name: string): RolePreset => roles.find((role) => role.name === name) ?? BUILTIN_ROLES.find((role) => role.name === name)!;
  const names = [...new Set(WORDS.filter(([pattern]) => pattern.test(words)).map(([, name]) => name))];
  if (names.length === 0 || names.every((name) => name === 'reviewer' || name === 'tester')) names.unshift('developer');
  const member = (name: string, extra: Partial<CrewMemberSpec> = {}): CrewMemberSpec => {
    const { builtin: _builtin, modified: _modified, ...fields } = preset(name);
    return { ...fields, ...extra };
  };
  const approve = /approv|\bcheck(point)?s?\b|\bok\b/.test(words);
  const members: CrewMemberSpec[] = names.flatMap((name) => (name === 'senior' ? [member('senior', approve ? { approve: true } : {}), member('junior', { reportsTo: 'senior' })] : [member(name, approve && name !== 'reviewer' ? { approve: true } : {})]));
  // "A team to add a CSV export to the orders page…" → "add a CSV export".
  const words2 = text
    .trim()
    .replace(/^(an?|the|un|una)\s+(team|squad)\s+(to|for|per|che)\s+/i, '')
    .replace(/[^\p{L}\p{N} ._-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const title = words2.slice(0, 4).join(' ').slice(0, 40) || 'drawn team';
  const checked = templateOfAnswer({
    name: title,
    lead: { kind: 'claude', name: 'lead', model: 'opus', role: `Turns the goal into requests for the members (${names.join(', ')}), follows their work, checks it and tells the user what is done.` },
    talk: 'twoway',
    worktrees: true,
    members,
    ...(/pull request|\bpr\b/.test(words) ? { deliverable: 'a pull request with the change, its tests passing' } : {}),
  });
  if ('error' in checked) return { ok: false, error: checked.error };
  return { ok: true, template: checked.template, note: 'In this demo the team is made of the presets your words name. On your Mac, Claude draws it from what you write.' };
}
