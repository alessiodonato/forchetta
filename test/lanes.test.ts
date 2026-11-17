import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Crews } from '../src/daemon/crews.ts';
import { Guard, type LaneCheck } from '../src/daemon/guard.ts';
import { type Agent, newAgent } from '../src/daemon/state.ts';
import type { QueuedCommand } from '../src/shared/agent.ts';
import { cleanCrewSpec, cleanPaths, type CrewSpec, leadPrompt, memberPrompt, ownsPath, pathMatches, templateOf } from '../src/shared/crew.ts';
import { heldBackText } from '../src/ui/Guard.tsx';
import { draftsOf, specOf } from '../src/ui/NewTeam.tsx';
import { tempDir } from './helpers.ts';

// The files of the members of a team: each one changes its own, and the others stay off them. The guard stops an
// edit elsewhere, with whose files they are; you can let it through from the box, or change the files of a member.

const temp = tempDir('lanes');
afterAll(() => temp.cleanup());

const ROOT = '/p/shop';

const checked = (input: unknown): CrewSpec => {
  const result = cleanCrewSpec(input);
  if ('error' in result) throw new Error(result.error);
  return result.spec;
};

const squad = (patch: Record<string, unknown> = {}): CrewSpec =>
  checked({
    name: 'squad',
    cwd: ROOT,
    lead: { kind: 'claude', name: 'lead', role: 'Plan.' },
    talk: 'twoway',
    members: [
      { name: 'frontend', role: 'The page.', paths: 'src/ui/, *.css' },
      { name: 'backend', role: 'The server.', paths: ['src/server/', 'src/db/'] },
      { name: 'tester', role: 'The tests.' },
    ],
    ...patch,
  });

describe('the files of a member', () => {
  it('are a list, from the panel as a text or as a list: trimmed, without "./", without repeats', () => {
    expect(cleanPaths(' src/ui/ , ./docs,, src/ui/ \n *.css ')).toEqual({ paths: ['src/ui/', 'docs', '*.css'] });
    expect(cleanPaths(['src//server/', '.'])).toEqual({ paths: ['src/server/'] });
    expect(cleanPaths('')).toEqual({});
    expect(cleanPaths(undefined)).toEqual({});
  });

  it('stay inside the folder of the team', () => {
    expect(cleanPaths('/etc/hosts')).toEqual({ error: expect.stringContaining('relative to the folder of the team') });
    expect(cleanPaths('~/x')).toEqual({ error: expect.stringContaining('relative') });
    expect(cleanPaths('src/../../x')).toEqual({ error: expect.stringContaining('inside the folder') });
    expect(cleanPaths(Array.from({ length: 13 }, (_, i) => `d${i}/`))).toEqual({ error: expect.stringContaining('12 paths at most') });
  });

  it('a folder covers what is under it, a file itself, a pattern what it matches', () => {
    expect(pathMatches('src/ui/App.tsx', 'src/ui/')).toBe(true);
    expect(pathMatches('src/ui/App.tsx', 'src/ui')).toBe(true);
    expect(pathMatches('src/uikit/App.tsx', 'src/ui')).toBe(false);
    expect(pathMatches('README.md', 'README.md')).toBe(true);
    expect(pathMatches('docs/README.md', 'README.md')).toBe(false);
    // With no "/" a pattern matches the name, at any depth; with one, the whole path.
    expect(pathMatches('src/ui/styles.css', '*.css')).toBe(true);
    expect(pathMatches('src/api.test.ts', '*.test.ts')).toBe(true);
    expect(pathMatches('docs/a/b.md', 'docs/**')).toBe(true);
    expect(pathMatches('src/a/b/c.test.ts', 'src/**/*.test.ts')).toBe(true);
    expect(pathMatches('src/c.test.ts', 'src/**/*.test.ts')).toBe(true);
    expect(pathMatches('src/a/c.ts', 'src/*.ts')).toBe(false);
    expect(pathMatches('a.b.ts', 'a?b.ts')).toBe(true);
    expect(ownsPath(undefined, 'x')).toBe(false);
  });

  it('are kept in the spec, in templates and in the panel', () => {
    const crew = squad();
    expect(crew.members.map((member) => member.paths)).toEqual([['src/ui/', '*.css'], ['src/server/', 'src/db/'], undefined]);
    expect(templateOf(crew).members[0]).toEqual({ name: 'frontend', role: 'The page.', paths: ['src/ui/', '*.css'] });
    const drafts = draftsOf(templateOf(crew));
    expect(drafts[0]).toMatchObject({ paths: 'src/ui/, *.css', more: true });
    expect(drafts[2]).toMatchObject({ paths: '', more: false });
    const again = specOf({ name: 'squad', folder: ROOT, leadKind: 'claude', leadName: 'lead', leadRole: 'Plan.', leadModel: '', leadMode: '', talk: 'twoway', members: drafts });
    expect(again.members.map((member) => member.paths)).toEqual([['src/ui/', '*.css'], ['src/server/', 'src/db/'], undefined]);
    expect((cleanCrewSpec({ ...again, members: [{ name: 'x', paths: '../up' }] }) as { error: string }).error).toContain('x: "../up"');
  });

  it('are in the prompts: the lead splits the work by them, each member knows its own and those of the others', () => {
    const crew = squad();
    const lead = leadPrompt(crew);
    expect(lead).toContain('- frontend (answers you): The page. — files: src/ui/, *.css');
    expect(lead).toContain('Forchetta stops its edits of other files, and the edits of the other members there');
    const front = memberPrompt(crew, crew.members[0]!);
    expect(front).toContain('Your files in the team, relative to its folder: src/ui/, *.css. Change only those');
    expect(front).toContain('- backend: The server. — files: src/server/, src/db/');
    const tester = memberPrompt(crew, crew.members[2]!);
    expect(tester).toContain('The files of the other members are theirs');
    expect(memberPrompt(squad({ members: [{ name: 'a' }, { name: 'b' }] }), { name: 'a', role: 'x' })).not.toContain('files');
  });
});

describe('which files a member may write', () => {
  const started = async (crew = squad(), options: { root?: string } = {}) => {
    const crews = new Crews(join(temp.dir, `lanes-${Math.random()}`));
    crews.gitInfo = () => ({ root: options.root ?? ROOT });
    let next = 0;
    const result = await crews.create(crew, async () => ({ ok: true as const, agentId: `agent-${++next}` }));
    return { crews, crewId: result.crewId! };
  };

  it('a member writes its own files, and those no other member has; not those of another member', async () => {
    const { crews } = await started();
    // agent-1 lead, agent-2 frontend, agent-3 backend, agent-4 tester.
    expect(crews.laneCheck('agent-2', `${ROOT}/src/ui/App.tsx`, ROOT)).toBeUndefined();
    expect(crews.laneCheck('agent-2', `${ROOT}/src/server/api.ts`, ROOT)).toEqual({
      team: 'squad',
      rel: 'src/server/api.ts',
      mine: ['src/ui/', '*.css'],
      owner: { name: 'backend', agentId: 'agent-3', paths: ['src/server/', 'src/db/'] },
    });
    // Outside its files, and nobody else's: still not its own.
    expect(crews.laneCheck('agent-2', `${ROOT}/package.json`, ROOT)).toEqual({ team: 'squad', rel: 'package.json', mine: ['src/ui/', '*.css'] });
    // A member with no files of its own: anything but the files of the others.
    expect(crews.laneCheck('agent-4', `${ROOT}/test/api.test.ts`, ROOT)).toBeUndefined();
    expect(crews.laneCheck('agent-4', `${ROOT}/src/db/schema.sql`, ROOT)).toMatchObject({ rel: 'src/db/schema.sql', owner: { name: 'backend' } });
    expect(crews.laneCheck('agent-4', `${ROOT}/src/db/schema.sql`, ROOT)?.mine).toBeUndefined();
  });

  it('a file that is also in its own files is its own, even when another member has it too', async () => {
    const crew = squad({ members: [{ name: 'backend', paths: 'src/server/' }, { name: 'tester', paths: '*.test.ts' }] });
    const { crews } = await started(crew);
    expect(crews.laneCheck('agent-3', `${ROOT}/src/server/api.test.ts`, ROOT)).toBeUndefined();
    expect(crews.laneCheck('agent-2', `${ROOT}/src/server/api.test.ts`, ROOT)).toBeUndefined();
  });

  it('the lead, a session out of the team, a file outside the folder of the team: no rule', async () => {
    const { crews } = await started();
    expect(crews.laneCheck('agent-1', `${ROOT}/src/server/api.ts`, ROOT)).toBeUndefined();
    expect(crews.laneCheck('someone', `${ROOT}/src/server/api.ts`, ROOT)).toBeUndefined();
    expect(crews.laneCheck('agent-2', '/elsewhere/notes.md', '/elsewhere')).toBeUndefined();
  });

  it('in a worktree the folder of the team is the same place under its root; a team in a subfolder too', async () => {
    const tree = `${ROOT}/.claude/worktrees/squad-frontend-abcdef`;
    const { crews } = await started();
    expect(crews.laneCheck('agent-2', `${tree}/src/ui/App.tsx`, tree)).toBeUndefined();
    expect(crews.laneCheck('agent-2', `${tree}/src/server/api.ts`, tree)).toMatchObject({ rel: 'src/server/api.ts', owner: { name: 'backend' } });
    // The team works in web/ of the repository: its files are relative to web/, in the worktrees too.
    const sub = await started(squad({ cwd: `${ROOT}/web` }));
    expect(sub.crews.laneCheck('agent-2', `${tree}/web/src/server/api.ts`, tree)).toMatchObject({ rel: 'src/server/api.ts' });
    expect(sub.crews.laneCheck('agent-2', `${tree}/README.md`, tree)).toBeUndefined();
  });

  it('change from the panel: the guard follows at once, the member learns them with its next request, the lead too', async () => {
    const { crews, crewId } = await started();
    const queued: { agentId: string; text: string }[] = [];
    crews.enqueue = (agentId, text, link) => {
      queued.push({ agentId, text });
      return { ok: true, command: { id: `c${queued.length}`, kind: 'request', arg: text, request: link, status: 'in-coda', createdAt: 0 } as QueuedCommand };
    };
    expect(crews.setPaths(crewId, 'frontend', 'src/ui/, src/server/routes/')).toEqual({ ok: true, paths: ['src/ui/', 'src/server/routes/'] });
    expect(crews.laneCheck('agent-2', `${ROOT}/src/server/routes/a.ts`, ROOT)).toBeUndefined();
    expect(crews.setPaths(crewId, 'frontend', '../x')).toMatchObject({ ok: false });
    expect(crews.setPaths(crewId, 'nobody', 'x')).toEqual({ ok: false, error: 'unknown member' });
    crews.request(crewId, ['frontend', 'tester'], 'Add the page.');
    expect(queued[0]!.text).toContain('(Your files in the team changed: from now on change only src/ui/, src/server/routes/.)');
    expect(queued[1]!.text).not.toContain('Your files');
    crews.request(crewId, ['frontend'], 'Again.');
    expect(queued[2]!.text).not.toContain('Your files');
    crews.request(crewId, ['lead'], 'Status?');
    expect(queued[3]!.text).toContain('frontend now works only on src/ui/, src/server/routes/');
    // No files at all: any file no other member has.
    expect(crews.setPaths(crewId, 'frontend', '')).toEqual({ ok: true });
    expect(crews.laneCheck('agent-2', `${ROOT}/package.json`, ROOT)).toBeUndefined();
    crews.request(crewId, ['frontend'], 'Next.');
    expect(queued.at(-1)!.text).toContain('from now on you may change any file that no other member has');
  });

  it('the panel shows the files of each member', async () => {
    const { crews } = await started();
    expect(crews.summaries()[0]!.recipients!.find((recipient) => recipient.name === 'backend')).toMatchObject({ paths: ['src/server/', 'src/db/'] });
  });
});

describe('the guard and the files of a team', () => {
  function setup() {
    let now = 1_000_000;
    const agents: Agent[] = [];
    const counted: string[] = [];
    const through: Array<{ agent: string; shown: string }> = [];
    let lanes: (agent: Agent, file: string) => LaneCheck | undefined = () => undefined;
    const guard = new Guard({
      agents: () => agents,
      repoOf: (dir) => (dir === ROOT || dir.startsWith(`${ROOT}/`) ? ROOT : undefined),
      writesOf: () => [],
      enabled: () => ({ files: true, git: true }),
      touch: () => {},
      lane: (agent, file) => lanes(agent, file),
      onLaneThrough: (agent, _file, shown) => through.push({ agent: agent.id, shown }),
      count: (kind) => counted.push(kind),
      now: () => now,
    });
    const add = (id: string): Agent => {
      const agent = newAgent({ id, cwd: ROOT, control: { kind: 'tmux', session: `fk-${id}` }, state: 'working' }, now);
      agents.push(agent);
      return agent;
    };
    const edit = (agent: Agent, file: string) =>
      guard.decide(agent, { hook_event_name: 'PreToolUse', session_id: agent.id, tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });
    return {
      guard,
      add,
      edit,
      counted,
      through,
      setLanes: (next: typeof lanes) => (lanes = next),
      advance: (ms: number) => (now += ms),
    };
  }
  const backendFiles: LaneCheck = { team: 'squad', rel: 'src/server/api.ts', mine: ['src/ui/'], owner: { name: 'backend', agentId: 'b', paths: ['src/server/'] } };

  it('stops a member outside its files, and tells Claude whose they are and what to do', () => {
    const t = setup();
    const front = t.add('f');
    t.setLanes(() => backendFiles);
    const answer = t.edit(front, `${ROOT}/src/server/api.ts`);
    expect(answer?.decision).toBe('deny');
    expect(answer?.reason).toBe(
      'Forchetta: src/server/api.ts is outside your files in the team "squad" (src/ui/): it is one of the files of backend (src/server/). ' +
        "Don't change it, and don't try again: do the part of your request that is in your files, then end your turn saying what is needed in src/server/api.ts (for backend). If the user lets you through, you will be told.",
    );
    expect(front.heldBack).toEqual([{ file: 'src/server/api.ts', path: `${ROOT}/src/server/api.ts`, with: 'b', withName: 'backend', since: 1_000_000, lane: true }]);
    expect(heldBackText(front.heldBack![0]!)).toBe('src/server/api.ts belongs to backend');
    // Once in the counts, however many times it tries.
    t.edit(front, `${ROOT}/src/server/api.ts`);
    expect(t.counted).toEqual(['lane']);
  });

  it('a member with no files of its own, in the files of another one', () => {
    const t = setup();
    const tester = t.add('t');
    t.setLanes(() => ({ team: 'squad', rel: 'src/db/schema.sql', owner: { name: 'backend', paths: ['src/server/', 'src/db/'] } }));
    expect(t.edit(tester, `${ROOT}/src/db/schema.sql`)?.reason).toContain('src/db/schema.sql is one of the files of backend in the team "squad" (src/server/, src/db/).');
    expect(heldBackText({ ...tester.heldBack![0]!, withName: '' })).toBe('src/db/schema.sql outside its files');
  });

  it('let through from the box: the session is told it can go on, and writes it until the end of that turn', () => {
    const t = setup();
    const front = t.add('f');
    t.setLanes(() => backendFiles);
    t.edit(front, `${ROOT}/src/server/api.ts`);
    expect(t.guard.letThrough('f', `${ROOT}/src/server/api.ts`)).toBe(true);
    expect(t.through).toEqual([{ agent: 'f', shown: 'src/server/api.ts' }]);
    expect(front.heldBack![0]).toMatchObject({ lane: true, letThrough: true });
    expect(heldBackText(front.heldBack![0]!)).toBe('src/server/api.ts: let through, outside its files');
    expect(t.edit(front, `${ROOT}/src/server/api.ts`)).toBeUndefined();
    t.guard.wrote(front, `${ROOT}/src/server/api.ts`);
    expect(t.edit(front, `${ROOT}/src/server/api.ts`)).toBeUndefined();
    // Its turn ends: what it was let through on goes, and the next turn is stopped again.
    t.guard.hook(front, { hook_event_name: 'Stop', session_id: 'f' });
    expect(front.heldBack).toBeUndefined();
    expect(t.edit(front, `${ROOT}/src/server/api.ts`)?.decision).toBe('deny');
    expect(t.counted).toEqual(['lane', 'letThrough', 'lane']);
  });

  it('a stop it was not let through on stays in the box after its turn, then goes after a while or with /clear', () => {
    const t = setup();
    const front = t.add('f');
    t.setLanes(() => backendFiles);
    t.edit(front, `${ROOT}/src/server/api.ts`);
    t.guard.hook(front, { hook_event_name: 'Stop', session_id: 'f' });
    // After the turn you can still let it through: that is when it asks.
    expect(front.heldBack).toHaveLength(1);
    t.advance(31 * 60_000);
    t.guard.hook(front, { hook_event_name: 'PreToolUse', session_id: 'f' });
    expect(front.heldBack).toBeUndefined();
    t.edit(front, `${ROOT}/src/server/api.ts`);
    t.guard.hook(front, { hook_event_name: 'SessionStart', session_id: 'f2', source: 'clear' });
    expect(front.heldBack).toBeUndefined();
  });

  it('its files changed so that it may: the line goes at its next try, and the edit goes', () => {
    const t = setup();
    const front = t.add('f');
    t.setLanes(() => backendFiles);
    t.edit(front, `${ROOT}/src/server/api.ts`);
    t.setLanes(() => undefined);
    expect(t.edit(front, `${ROOT}/src/server/api.ts`)).toBeUndefined();
    expect(front.heldBack).toBeUndefined();
  });

  it('nothing with the guard of files off', () => {
    const counted: string[] = [];
    const guard = new Guard({
      agents: () => [],
      repoOf: () => ROOT,
      writesOf: () => [],
      enabled: () => ({ files: false, git: true }),
      touch: () => {},
      lane: () => backendFiles,
      count: (kind) => counted.push(kind),
    });
    const agent = newAgent({ id: 'f', cwd: ROOT, control: { kind: 'tmux', session: 'fk-f' }, state: 'working' }, 0);
    expect(guard.decide(agent, { hook_event_name: 'PreToolUse', session_id: 'f', tool_name: 'Write', tool_input: { file_path: `${ROOT}/src/server/api.ts`, content: '' } })).toBeUndefined();
    expect(counted).toEqual([]);
  });
});
