import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CrewTemplates, RolePresets } from '../src/daemon/crews.ts';
import { BUILTIN_ROLES, BUILTIN_TEMPLATES, cleanRolePreset, cleanTemplate } from '../src/shared/crew.ts';
import {
  addNode,
  addTemplate,
  connect,
  docOfTemplate,
  emptyDoc,
  fieldsOf,
  leadKey,
  NODE_H,
  NODE_W,
  nodeAt,
  problems,
  removeNode,
  specOfDoc,
  type StudioDoc,
  templateOfDoc,
  tidy,
  uniqueName,
  updateLink,
} from '../src/ui/studio-model.ts';
import { tempDir } from './helpers.ts';

// The studio of teams: boxes and arrows on a canvas that become a team, presets of agents, templates with a layout.

const temp = tempDir('studio');
afterAll(() => temp.cleanup());

const role = (name: string) => BUILTIN_ROLES.find((preset) => preset.name === name)!;

/** A canvas with the given presets, at made-up places; their keys in order. */
function canvas(...names: string[]): { doc: StudioDoc; keys: number[] } {
  let doc = { ...emptyDoc('/Users/dev/shop'), name: 'shop' };
  const keys: number[] = [];
  for (const [index, name] of names.entries()) {
    const added = addNode(doc, fieldsOf(role(name)), 100 + index * 300, 200);
    doc = added.doc;
    keys.push(added.key);
  }
  return { doc, keys };
}
const linked = (doc: StudioDoc, ...arrows: [number | 'you', number][]): StudioDoc =>
  arrows.reduce((current, [from, to]) => {
    const result = connect(current, from, to);
    if ('error' in result) throw new Error(result.error);
    return result.doc;
  }, doc);

describe('the canvas of the studio', () => {
  it('names a box after its preset, with a number when the name is taken', () => {
    const { doc } = canvas('senior', 'senior', 'senior');
    expect(doc.nodes.map((node) => node.name)).toEqual(['senior', 'senior 2', 'senior 3']);
    expect(uniqueName(doc, 'You')).toBe('You 2');
  });

  it('an arrow makes the second report to the first; a new one replaces the old; no circle, nothing onto itself', () => {
    const { doc, keys } = canvas('manager', 'senior', 'junior');
    const [manager, senior, junior] = keys as [number, number, number];
    let next = linked(doc, ['you', manager], [manager, senior], [senior, junior]);
    expect(connect(next, junior, manager)).toEqual({ error: 'manager is above junior: an arrow cannot make a circle.' });
    expect(connect(next, junior, junior)).toEqual({ error: 'An arrow goes from one box to another.' });
    const moved = connect(next, manager, junior);
    expect(moved).toMatchObject({ replaced: true });
    next = (moved as { doc: StudioDoc }).doc;
    expect(next.links.filter((link) => link.to === junior)).toEqual([{ from: manager, to: junior, relation: '' }]);
  });

  it('the one box You point at, when it leads others, is the Claude lead; otherwise you lead', () => {
    const { doc, keys } = canvas('manager', 'senior', 'junior');
    const [manager, senior, junior] = keys as [number, number, number];
    expect(leadKey(linked(doc, ['you', manager], [manager, senior]))).toBe(manager);
    expect(leadKey(linked(doc, ['you', manager]))).toBeUndefined();
    expect(leadKey(linked(doc, ['you', manager], ['you', senior], [senior, junior]))).toBeUndefined();
  });

  it('becomes the team it draws: the lead, who reports to whom, → / ⇄ and the prompt of each arrow', () => {
    const { doc, keys } = canvas('manager', 'senior', 'junior');
    const [manager, senior, junior] = keys as [number, number, number];
    let next = linked(doc, ['you', manager], [manager, senior], [senior, junior]);
    next = updateLink(next, senior, { relation: 'Reports when reviewed.' });
    next = updateLink(next, junior, { talk: 'oneway', relation: 'One step at a time.' });
    const result = specOfDoc(next);
    expect('spec' in result && result.spec).toMatchObject({
      name: 'shop',
      cwd: '/Users/dev/shop',
      lead: { kind: 'claude', name: 'manager', model: 'opus' },
      members: [
        { name: 'senior', relation: 'Reports when reviewed.' },
        { name: 'junior', reportsTo: 'senior', talk: 'oneway', relation: 'One step at a time.', model: 'sonnet' },
      ],
    });
    expect(problems(next)).toEqual([]);
  });

  it('when you lead, the boxes you point at are the top of the team', () => {
    const { doc, keys } = canvas('frontend', 'backend', 'junior');
    const [frontend, backend, junior] = keys as [number, number, number];
    const result = specOfDoc(linked(doc, ['you', frontend], ['you', backend], [backend, junior]));
    expect('spec' in result && result.spec.lead).toEqual({ kind: 'you' });
    expect('spec' in result && result.spec.members.map((member) => `${member.name}<${member.reportsTo ?? 'you'}`)).toEqual(['frontend<you', 'backend<you', 'junior<backend']);
  });

  it('says what keeps it from being a team', () => {
    expect(problems(emptyDoc())).toEqual(['Drag an agent from the left onto the canvas.']);
    const { doc, keys } = canvas('manager', 'senior');
    expect(problems(doc)).toEqual(['Drag an arrow from You to the lead of the team, or to each member you lead.']);
    expect(problems(linked(doc, ['you', keys[0]!]))).toEqual(['senior is not connected: drag an arrow to it from the one it reports to.']);
    expect(problems({ ...linked(doc, ['you', keys[0]!], [keys[0]!, keys[1]!]), name: ' ' })).toEqual(['give the team a name']);
  });

  it('a box taken away leaves the ones it led to the one above it', () => {
    const { doc, keys } = canvas('manager', 'senior', 'junior');
    const [manager, senior, junior] = keys as [number, number, number];
    const next = removeNode(linked(doc, ['you', manager], [manager, senior], [senior, junior]), senior);
    expect(next.links).toEqual([
      { from: 'you', to: manager, relation: '' },
      { from: manager, to: junior, relation: '' },
    ]);
  });

  it('tidies up as a tree: each one centered over the ones it leads, a row per level, the loose ones at the bottom', () => {
    const { doc, keys } = canvas('manager', 'senior', 'junior', 'developer', 'writer');
    const [manager, senior, junior, developer] = keys as [number, number, number, number];
    const laid = tidy(linked(doc, ['you', manager], [manager, senior], [senior, junior], [senior, developer]));
    const at = (key: number) => laid.nodes.find((node) => node.key === key)!;
    expect(at(junior).y).toBe(at(developer).y);
    expect(at(senior).y).toBeLessThan(at(junior).y);
    expect(at(senior).x + NODE_W / 2).toBe(Math.round((at(junior).x + at(developer).x + NODE_W) / 2));
    expect(at(manager).x).toBe(at(senior).x);
    expect(laid.nodes.at(-1)!.y).toBeGreaterThan(at(junior).y);
    expect(nodeAt(laid, at(junior).x + 5, at(junior).y + NODE_H - 5)?.key).toBe(junior);
  });
});

describe('templates in the studio', () => {
  const chain = BUILTIN_TEMPLATES.find((template) => template.name === 'manager › senior › junior')!;

  it('opens a template as boxes and arrows, and saves it back the same, with where the boxes stand', () => {
    const doc = docOfTemplate(chain, '/Users/dev/shop');
    expect(doc.nodes.map((node) => node.name)).toEqual(['manager', 'senior', 'junior']);
    expect(leadKey(doc)).toBe(doc.nodes[0]!.key);
    const saved = templateOfDoc(doc);
    if ('error' in saved) throw new Error(saved.error);
    const { builtin: _builtin, ...expected } = chain;
    expect({ ...saved.template, layout: undefined }).toEqual({ ...expected, layout: undefined, talk: 'twoway' });
    expect(Object.keys(saved.template.layout!)).toEqual(['you', 'manager', 'senior', 'junior']);
    // Opened again, the boxes are where they were left.
    const moved = { ...saved.template, layout: { ...saved.template.layout!, junior: [700, 640] as [number, number] } };
    expect(docOfTemplate(moved).nodes.find((node) => node.name === 'junior')).toMatchObject({ x: 700, y: 640 });
  });

  it('a template dropped on a canvas with boxes adds its own, renamed where needed, under You', () => {
    const { doc } = canvas('senior');
    const next = addTemplate(doc, chain, 600, 300);
    expect(next.nodes.map((node) => node.name)).toEqual(['senior', 'manager', 'senior 2', 'junior']);
    const spec = specOfDoc(linked(next, [next.links.find((link) => link.from !== 'you')!.from as number, doc.nodes[0]!.key]));
    expect('spec' in spec && spec.spec.members.find((member) => member.name === 'junior')!.reportsTo).toBe('senior 2');
    expect(Math.min(...next.nodes.slice(1).map((node) => node.x))).toBe(600);
  });

  it('keeps the layout of a template, only for its own names and with numbers', () => {
    const checked = cleanTemplate({ ...chain, layout: { you: [10, 20], manager: [1.6, 2], ghost: [1, 1], junior: ['a', 1] } });
    expect('template' in checked && checked.template.layout).toEqual({ you: [10, 20], manager: [2, 2] });
  });
});

describe('the presets of the studio', () => {
  it('a preset is checked like a member, without its place in a team', () => {
    expect(cleanRolePreset({ name: ' qa ', role: 'Tests.', model: 'haiku', reportsTo: 'x', talk: 'oneway', relation: 'r' })).toEqual({ preset: { name: 'qa', role: 'Tests.', model: 'haiku' } });
    expect(cleanRolePreset({ name: '-x' })).toMatchObject({ error: expect.stringContaining('start with a letter') });
    expect(cleanRolePreset({ name: 'a', model: 'gpt' })).toEqual({ error: 'a: invalid model' });
  });

  it('yours replace the ones of Forchetta until you restore them; yours are kept in a private file', () => {
    const file = join(temp.dir, 'roles.json');
    const roles = new RolePresets(file);
    expect(roles.list().map((preset) => preset.name)).toEqual(BUILTIN_ROLES.map((preset) => preset.name));
    expect(roles.save({ name: 'tester', role: 'Writes Playwright tests.' })).toEqual({ ok: true, name: 'tester' });
    expect(roles.list().find((preset) => preset.name === 'tester')).toEqual({ name: 'tester', role: 'Writes Playwright tests.', builtin: true, modified: true });
    expect(roles.save({ name: 'qa', role: 'Checks.' }).ok).toBe(true);
    // Renamed: the old one of yours goes; a renamed preset of Forchetta stays.
    expect(roles.save({ name: 'qa lead', role: 'Checks.' }, 'qa').ok).toBe(true);
    expect(roles.save({ name: 'writer 2', role: 'Writes.' }, 'writer').ok).toBe(true);
    expect(new RolePresets(file).list().map((preset) => preset.name).slice(BUILTIN_ROLES.length)).toEqual(['qa lead', 'writer 2']);
    expect(roles.list().some((preset) => preset.name === 'writer' && !preset.modified)).toBe(true);
    expect(roles.delete('tester')).toEqual({ ok: true });
    expect(roles.list().find((preset) => preset.name === 'tester')!.modified).toBeUndefined();
    expect(roles.delete('tester')).toEqual({ ok: false, error: 'unknown preset' });
    expect(JSON.parse(readFileSync(file, 'utf8')).map((preset: { name: string }) => preset.name)).toEqual(['qa lead', 'writer 2']);
  });

  it('from the app a template of Forchetta can be changed, and restored; a session still cannot', () => {
    const templates = new CrewTemplates(join(temp.dir, 'templates.json'));
    const pair = BUILTIN_TEMPLATES[0]!;
    const { builtin: _builtin, ...mine } = pair;
    expect(templates.save({ ...mine, talk: 'oneway' })).toMatchObject({ ok: false });
    expect(templates.save({ ...mine, talk: 'oneway' }, { override: true })).toEqual({ ok: true, name: pair.name, replaced: false });
    expect(templates.list()[0]).toMatchObject({ name: pair.name, talk: 'oneway', builtin: true, modified: true });
    expect(templates.list().filter((template) => template.name === pair.name)).toHaveLength(1);
    expect(templates.delete(pair.name)).toEqual({ ok: true });
    expect(templates.list()[0]).toEqual(pair);
  });
});
