import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CrewTemplates, RolePresets } from '../src/daemon/crews.ts';
import { BUILTIN_ROLES, BUILTIN_TEMPLATES, cleanCrewSpec, cleanRolePreset, cleanTemplate, type CrewSpec, leadPrompt, memberPrompt, RULES_MAX, tooLong } from '../src/shared/crew.ts';
import {
  addNode,
  addNote,
  addTemplate,
  clampZoom,
  clipOf,
  connect,
  docOfTemplate,
  emptyDoc,
  emptyHistory,
  fieldsOf,
  fitZoom,
  HISTORY_MAX,
  HISTORY_PAUSE_MS,
  leadKey,
  NODE_H,
  NODE_W,
  nodeAt,
  nodesIn,
  pasteClip,
  problems,
  redoStep,
  remember,
  removeNode,
  removeNodes,
  specOfDoc,
  type StudioDoc,
  templateOfDoc,
  tidy,
  undoStep,
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

describe('undo and redo in the studio', () => {
  it('makes changes in a row one step, and a pause starts the next one', () => {
    const one = canvas('manager').doc;
    const two = canvas('manager', 'senior').doc;
    const three = canvas('manager', 'senior', 'junior').doc;
    // Typing a role: three changes in a row, then one after a pause.
    let history = remember(emptyHistory(), one, 1_000);
    history = remember(history, two, 1_000 + HISTORY_PAUSE_MS / 2);
    history = remember(history, three, 1_000 + HISTORY_PAUSE_MS);
    expect(history.past).toEqual([one]);
    history = remember(history, three, 1_000 + 3 * HISTORY_PAUSE_MS);
    expect(history.past).toEqual([one, three]);
  });

  it('goes back and forth, and a new change after an undo forgets what could be redone', () => {
    const one = canvas('manager').doc;
    const two = canvas('manager', 'senior').doc;
    const three = canvas('manager', 'senior', 'junior').doc;
    let history = remember(remember(emptyHistory(), one, 0), two, 10_000);
    expect(undoStep(emptyHistory(), three)).toBeUndefined();
    const back = undoStep(history, three)!;
    expect(back.doc).toBe(two);
    const backAgain = undoStep(back.history, back.doc)!;
    expect(backAgain.doc).toBe(one);
    expect(undoStep(backAgain.history, one)).toBeUndefined();
    const forward = redoStep(backAgain.history, one)!;
    expect(forward.doc).toBe(two);
    expect(redoStep(forward.history, two)!.doc).toBe(three);
    // A change right after an undo is a step of its own, and there is nothing to redo any more.
    history = remember(back.history, back.doc, 10_001);
    expect(history.future).toEqual([]);
    expect(history.past).toEqual([one, two]);
  });

  it('keeps the last 100 steps', () => {
    let history = emptyHistory();
    const docs = Array.from({ length: HISTORY_MAX + 20 }, (_, i) => ({ ...emptyDoc(''), name: `step ${i}` }));
    for (const [i, doc] of docs.entries()) history = remember(history, doc, i * 10_000);
    expect(history.past).toHaveLength(HISTORY_MAX);
    expect(history.past[0]!.name).toBe('step 20');
  });
});

describe('the rules of a team, and the notes on its canvas', () => {
  it('every session gets the rules, after what it is told about the team; nothing is written in the project', () => {
    const checked = cleanCrewSpec({ name: 'shop', cwd: '/Users/dev/shop', talk: 'twoway', rules: '  Commit with Conventional Commits.\nNever touch infra/.  ', lead: { kind: 'claude', name: 'lead', role: 'Leads.' }, members: [{ name: 'dev', role: 'Codes.' }] });
    const spec = (checked as { spec: CrewSpec }).spec;
    expect(spec.rules).toBe('Commit with Conventional Commits.\nNever touch infra/.');
    for (const prompt of [leadPrompt(spec), memberPrompt(spec, spec.members[0]!)]) {
      expect(prompt.endsWith('The rules of the whole team, for you as for every other session of it:\nCommit with Conventional Commits.\nNever touch infra/.')).toBe(true);
    }
    const none = (cleanCrewSpec({ name: 'shop', cwd: '/x', lead: { kind: 'you' }, members: [{ name: 'dev' }] }) as { spec: CrewSpec }).spec;
    expect(none.rules).toBeUndefined();
    expect(memberPrompt(none, none.members[0]!)).not.toContain('rules of the whole team');
    expect(tooLong({ name: 'shop', rules: 'x'.repeat(RULES_MAX + 1) })).toBe(`the rules of the team are ${RULES_MAX + 1} characters: ${RULES_MAX} at most`);
  });

  it('a template keeps the rules and the notes of its canvas, and the studio opens them again', () => {
    let { doc } = canvas('manager', 'senior');
    doc = linked(doc, ['you', doc.nodes[0]!.key], [doc.nodes[0]!.key, doc.nodes[1]!.key]);
    doc = { ...doc, name: 'shop', rules: 'Small commits.' };
    doc = addNote(doc, 900, 40, '  Start it on a fresh branch.  ').doc;
    doc = addNote(doc, 900, 200).doc;
    const made = templateOfDoc(doc);
    if ('error' in made) throw new Error(made.error);
    expect(made.template.rules).toBe('Small commits.');
    expect(made.template.notes).toEqual([{ x: 900, y: 40, text: 'Start it on a fresh branch.' }]);
    const saved = cleanTemplate(made.template);
    if ('error' in saved) throw new Error(saved.error);
    expect(saved.template.rules).toBe('Small commits.');
    expect(saved.template.notes).toEqual([{ x: 900, y: 40, text: 'Start it on a fresh branch.' }]);
    const opened = docOfTemplate(saved.template, '/Users/dev/shop');
    expect(opened.rules).toBe('Small commits.');
    expect(opened.notes.map(({ x, y, text }) => ({ x, y, text }))).toEqual([{ x: 900, y: 40, text: 'Start it on a fresh branch.' }]);
    expect(specOfDoc(opened)).toMatchObject({ spec: { rules: 'Small commits.' } });
    // Notes with nothing in them, or in no place, are left out; 30 at most.
    const many = cleanTemplate({ ...saved.template, notes: [{ x: 1, y: 1, text: ' ' }, { x: 'a', y: 1, text: 'x' }, ...Array.from({ length: 40 }, (_, i) => ({ x: i, y: i, text: `n${i}` }))] });
    expect((many as { template: { notes: unknown[] } }).template.notes).toHaveLength(30);
  });
});

describe('a canvas for large teams', () => {
  it('copies boxes with the arrows between them, and pastes them with names of their own', () => {
    let { doc, keys } = canvas('manager', 'senior', 'junior');
    doc = linked(doc, ['you', keys[0]!], [keys[0]!, keys[1]!], [keys[1]!, keys[2]!]);
    doc = updateLink(doc, keys[2]!, { talk: 'oneway', relation: 'One step at a time.' });
    // The senior and its junior: the arrow between them comes, the one from the manager does not.
    const clip = clipOf(doc, [keys[1]!, keys[2]!])!;
    expect(clip.nodes.map((node) => node.name)).toEqual(['senior', 'junior']);
    expect(clip.links).toEqual([{ from: 0, to: 1, talk: 'oneway', relation: 'One step at a time.' }]);
    const pasted = pasteClip(doc, clip, 40, 40);
    const [senior2, junior2] = pasted.keys.map((key) => pasted.doc.nodes.find((node) => node.key === key)!);
    expect([senior2!.name, junior2!.name]).toEqual(['senior 2', 'junior 2']);
    expect(senior2!.x).toBe(doc.nodes[1]!.x + 40);
    expect(pasted.doc.links.find((link) => link.to === junior2!.key)).toEqual({ from: senior2!.key, to: junior2!.key, talk: 'oneway', relation: 'One step at a time.' });
    expect(pasted.doc.links.find((link) => link.to === senior2!.key)).toBeUndefined();
    expect(clipOf(doc, [])).toBeUndefined();
    // A copy of a copy takes the next number, not a second one.
    const again = pasteClip(pasted.doc, clipOf(pasted.doc, [senior2!.key])!, 40, 40);
    expect(again.doc.nodes.find((node) => node.key === again.keys[0])!.name).toBe('senior 3');
  });

  it('selects the boxes a rectangle touches, and takes several away at once', () => {
    const { doc, keys } = canvas('manager', 'senior', 'junior');
    // Boxes at x 100, 400, 700, y 200.
    expect(nodesIn(doc, { x: 650, y: 250 }, { x: 150, y: 210 })).toEqual([keys[0], keys[1]]);
    expect(nodesIn(doc, { x: 0, y: 0 }, { x: 50, y: 50 })).toEqual([]);
    const left = removeNodes(linked(doc, ['you', keys[0]!], [keys[0]!, keys[1]!], [keys[1]!, keys[2]!]), [keys[0]!, keys[1]!]);
    expect(left.nodes.map((node) => node.name)).toEqual(['junior']);
    expect(left.links).toEqual([expect.objectContaining({ from: 'you', to: keys[2] })]);
  });

  it('zooms between 30% and 160%, and fits everything in the view', () => {
    expect(clampZoom(0.1)).toBe(0.3);
    expect(clampZoom(2)).toBe(1.6);
    expect(clampZoom(0.756)).toBe(0.76);
    const { doc } = canvas('manager', 'senior', 'junior', 'developer', 'reviewer', 'tester');
    expect(fitZoom(doc, 5000, 3000)).toBe(1);
    expect(fitZoom(doc, 900, 600)).toBeLessThan(1);
    expect(fitZoom(doc, 100, 100)).toBe(0.3);
  });
});
