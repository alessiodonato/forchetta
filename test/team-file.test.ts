import { readFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { importTeam, saveTeamFile } from '../src/daemon/team-files.ts';
import { BUILTIN_TEMPLATES, type CrewTemplate } from '../src/shared/crew.ts';
import { setCustomSkills, type SkillInfo } from '../src/shared/skills.ts';
import { parseTeamFile, teamFileName, teamFileOf, withoutSkills } from '../src/shared/team-file.ts';
import { tempDir } from './helpers.ts';

// A team as a file, to give to someone else, and opened again on another Mac.

const temp = tempDir('team-file');
afterAll(() => temp.cleanup());
afterEach(() => setCustomSkills([]));

const mine = (id: string, extra: Partial<SkillInfo>): SkillInfo => ({ id, group: 'yours', repo: '', path: '', commit: '', license: 'unknown', kb: 1, files: 1, summary: '', ...extra });
const fromGitHub = mine('release-notes', { repo: 'someone/skills', path: 'skills/release-notes', commit: 'a'.repeat(40) });
const fromFolder = mine('house-style', { local: '/Users/dev/skills/house-style' });

const team: CrewTemplate = {
  name: 'Docs crew',
  lead: { kind: 'claude', name: 'editor', role: 'Edits.', skills: ['brainstorming', 'release-notes'] },
  talk: 'twoway',
  members: [{ name: 'writer', role: 'Writes.', skills: ['house-style', 'pdf'] }],
  rules: 'Plain English.',
  notes: [{ x: 10, y: 10, text: 'For the release notes.' }],
  layout: { you: [400, 24], editor: [400, 140], writer: [400, 300] },
  builtin: true,
};

describe('a team as a file', () => {
  it('carries the template, and where its skills of GitHub come from; not a folder of this Mac', () => {
    setCustomSkills([fromGitHub, fromFolder]);
    const file = teamFileOf(team);
    expect(file).toEqual({
      kind: 'forchetta-team',
      version: 1,
      template: { name: 'Docs crew', lead: team.lead, talk: 'twoway', members: team.members, rules: 'Plain English.', notes: team.notes, layout: team.layout },
      skills: [{ id: 'release-notes', repo: 'someone/skills', path: 'skills/release-notes', commit: 'a'.repeat(40) }],
    });
    expect(teamFileName('Docs crew')).toBe('docs-crew.forchetta-team.json');
    expect(teamFileName('…')).toBe('team.forchetta-team.json');
    expect(parseTeamFile(JSON.stringify(file))).toEqual({ file });
  });

  it('says what is wrong with a file that is not one', () => {
    expect(parseTeamFile('nope')).toEqual({ error: 'this is not a file of a team of Forchetta (it is not JSON)' });
    expect(parseTeamFile('{"kind":"other","template":{}}')).toEqual({ error: 'this is not a file of a team of Forchetta' });
    expect(parseTeamFile('{"kind":"forchetta-team","version":2,"template":{}}')).toMatchObject({ error: expect.stringContaining('newer Forchetta') });
    expect(parseTeamFile(`{"x":"${'y'.repeat(600_000)}"}`)).toEqual({ error: 'this file is too large for a team' });
    const odd = parseTeamFile(JSON.stringify({ kind: 'forchetta-team', version: 1, template: { name: 'x' }, skills: [{ id: 'a', repo: 'no repo', path: 'p', commit: 'b'.repeat(40) }, { id: 'b', repo: 'o/r', path: 'p', commit: 'short' }] }));
    expect(odd).toEqual({ file: { kind: 'forchetta-team', version: 1, template: { name: 'x' } } });
    expect(withoutSkills(team, new Set(['pdf', 'release-notes'])).members[0]!.skills).toEqual(['house-style']);
    expect(withoutSkills(team, new Set(['brainstorming', 'release-notes'])).lead).toEqual({ kind: 'claude', name: 'editor', role: 'Edits.' });
  });

  it('opened on another Mac: the skills of GitHub are added at their commit, a folder of the other Mac is left out', async () => {
    setCustomSkills([fromGitHub, fromFolder]);
    const text = JSON.stringify(teamFileOf(team));
    setCustomSkills([]);
    const links: string[] = [];
    const opened = await importTeam(text, async (link) => {
      links.push(link);
      setCustomSkills([fromGitHub]);
      return { ok: true };
    });
    expect(links).toEqual([`https://github.com/someone/skills/tree/${'a'.repeat(40)}/skills/release-notes`]);
    expect(opened).toMatchObject({
      ok: true,
      template: { name: 'Docs crew', rules: 'Plain English.', notes: [{ x: 10, y: 10, text: 'For the release notes.' }], lead: { skills: ['brainstorming', 'release-notes'] }, members: [{ name: 'writer', skills: ['pdf'] }] },
      notes: [`added the skill release-notes, from someone/skills at aaaaaaa`, 'house-style is left out: it was a skill from a folder of the Mac the team comes from'],
    });
    expect((opened as { template: CrewTemplate }).template.builtin).toBeUndefined();
    // A fetch that fails leaves the skill out too, and says why.
    setCustomSkills([]);
    const failed = await importTeam(text, async () => ({ ok: false, error: 'no network' }));
    expect(failed).toMatchObject({ ok: true, notes: ['release-notes is left out: no network', expect.stringContaining('house-style is left out')] });
    expect(await importTeam(JSON.stringify({ kind: 'forchetta-team', version: 1, template: { name: 'empty', lead: { kind: 'you' }, members: [] } }), async () => ({ ok: true }))).toEqual({ ok: false, error: 'add at least one member' });
  });

  it('is saved in the Downloads with a number when the name is taken', () => {
    const first = saveTeamFile('Docs crew', '{"a":1}', temp.dir);
    const second = saveTeamFile('Docs crew', '{"a":2}', temp.dir);
    expect(first).toEqual({ ok: true, path: `${temp.dir}/docs-crew.forchetta-team.json` });
    expect(second).toEqual({ ok: true, path: `${temp.dir}/docs-crew 2.forchetta-team.json` });
    expect(readFileSync((second as { path: string }).path, 'utf8')).toBe('{"a":2}\n');
  });
});
