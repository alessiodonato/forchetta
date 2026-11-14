import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Teams } from '../src/daemon/teams.ts';
import { newAgent } from '../src/daemon/state.ts';
import { cleanTeam, displayName } from '../src/shared/agent.ts';
import { groupsOf, roleText } from '../src/ui/Team.tsx';
import { tempDir } from './helpers.ts';

// Names, groups and roles of the sessions, and the chart they make.

const temp = tempDir('teams');
afterAll(() => temp.cleanup());

const agent = (id: string, cwd = `/p/${id}`) => newAgent({ id, cwd, control: { kind: 'readonly', reason: 'fuori-tmux' } }, Number(id.replace(/\D/g, '')) || 0);

describe('team fields', () => {
  it('are trimmed and cut, empty ones go, and a head needs a group', () => {
    expect(cleanTeam({ label: '  Revisore  capo ', group: 'backend', role: '', lead: true })).toEqual({ label: 'Revisore capo', group: 'backend', lead: true });
    expect(cleanTeam({ label: 'x'.repeat(60) })!.label).toHaveLength(40);
    expect(cleanTeam({ lead: true })).toBeUndefined();
    expect(cleanTeam({ label: ' ', group: '' })).toBeUndefined();
    expect(cleanTeam(null)).toBeUndefined();
  });

  it('a color is one of the palette, or none', () => {
    expect(cleanTeam({ label: '', color: 'cyan', group: '' })).toEqual({ color: 'cyan' });
    expect(cleanTeam({ label: 'Rita', color: 'red' })).toEqual({ label: 'Rita' });
    expect(cleanTeam({ color: '#ff0000' })).toBeUndefined();
  });

  it('name and role as the box shows them', () => {
    const a = { ...agent('a1'), team: { label: 'Rita', role: 'revisione', lead: true, group: 'g' } };
    expect(displayName(a)).toBe('Rita');
    expect(displayName(agent('a2'))).toBe('a2');
    expect(roleText(a)).toBe('lead · revisione');
    expect(roleText({ ...a, team: { group: 'g', lead: true } })).toBe('lead');
  });
});

describe('teams remembered for the folder', () => {
  it('a new session in the same folder finds its team; a cleared one is not given back', () => {
    const file = join(temp.dir, 'teams.json');
    const teams = new Teams(file);
    const first = agent('a1', '/p/app');
    teams.set(first, { label: 'Rita', color: 'violet', group: 'backend', role: 'revisione', lead: false });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ '/p/app': { label: 'Rita', color: 'violet', group: 'backend', role: 'revisione' } });

    // The next day: a new daemon, a new process in the same folder.
    const again = new Teams(file);
    const second = agent('a2', '/p/app');
    expect(again.apply(second)).toBe(true);
    expect(second.team).toEqual({ label: 'Rita', color: 'violet', group: 'backend', role: 'revisione' });
    expect(again.apply(second)).toBe(false);

    again.set(second, null);
    expect(second.team).toBeUndefined();
    const third = agent('a3', '/p/app');
    expect(again.apply(third)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
  });

  it('a member of a team of agents takes a color and keeps its team, and nothing goes to the folder', () => {
    const file = join(temp.dir, 'crew-teams.json');
    const teams = new Teams(file);
    const member = { ...agent('a1', '/p/crew'), team: { label: 'tester', crew: 'c1', talk: 'twoway' as const } };
    teams.set(member, { label: 'tester', color: 'pink', group: '', role: '', lead: false });
    expect(member.team).toEqual({ label: 'tester', color: 'pink', crew: 'c1', talk: 'twoway' });
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('a session with a team of its own keeps it', () => {
    const teams = new Teams(undefined);
    const one = agent('a1', '/p/x');
    teams.set(one, { label: 'Uno', group: '', role: '', lead: false });
    const two = { ...agent('a2', '/p/x'), team: { label: 'Due' } };
    expect(teams.apply(two)).toBe(false);
    expect(two.team).toEqual({ label: 'Due' });
  });
});

describe('the chart', () => {
  it('groups in alphabetical order, the sessions with no group last, the heads apart', () => {
    const agents = [
      agent('a1'),
      { ...agent('a2'), team: { group: 'zeta' } },
      { ...agent('a3'), team: { group: 'alfa', lead: true } },
      { ...agent('a4'), team: { group: 'alfa', role: 'test' } },
      { ...agent('a5'), team: { group: 'alfa' } },
    ];
    const groups = groupsOf(agents).map((group) => ({ name: group.name, leads: group.leads.map((a) => a.id), members: group.members.map((a) => a.id) }));
    expect(groups).toEqual([
      { name: 'alfa', leads: ['a3'], members: ['a4', 'a5'] },
      { name: 'zeta', leads: [], members: ['a2'] },
      { name: undefined, leads: [], members: ['a1'] },
    ]);
  });
});
