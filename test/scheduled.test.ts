import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Scheduled } from '../src/daemon/scheduled.ts';
import type { Agent } from '../src/shared/agent.ts';
import { parseTask, taskOfPrompt } from '../src/shared/scheduled.ts';
import { tempDir } from './helpers.ts';

const temp = tempDir('scheduled');
afterAll(() => temp.cleanup());

const BODY = 'Read the open issues and write a short summary of what changed since yesterday.';

describe('a SKILL.md of a scheduled task', () => {
  it('has a name, a description and the instructions', () => {
    expect(parseTask('morning', `---\nname: Morning report\ndescription: "What \\"changed\\""\n---\n\n${BODY}\n`)).toEqual({ id: 'morning', name: 'Morning report', description: 'What "changed"', instructions: BODY });
    expect(parseTask('morning', `---\r\nname: 'It''s morning'\r\ndescription: >\r\n  Two\r\n  lines\r\n---\r\n${BODY}`)).toEqual({ id: 'morning', name: "It's morning", description: 'Two lines', instructions: BODY });
  });
  it('is its folder and its text when it has no frontmatter', () => {
    expect(parseTask('plain', BODY)).toEqual({ id: 'plain', name: 'plain', instructions: BODY });
    expect(parseTask('open', `---\nname: x\n${BODY}`)).toMatchObject({ name: 'open' });
  });
});

describe('a prompt that starts a task', () => {
  const tasks = [{ id: 'a', instructions: BODY }, { id: 'b', instructions: `${BODY} Then send it.` }, { id: 'c', instructions: 'Say hello' }];
  it('has its instructions in it, whatever is around them', () => {
    expect(taskOfPrompt(`<scheduled-task name="a">\n${BODY.replace(' and ', '\n and ')}\n</scheduled-task>`, tasks)).toMatchObject({ id: 'a' });
    expect(taskOfPrompt(`${BODY} Then send it.`, tasks)).toMatchObject({ id: 'b' });
  });
  it('is not one that only says something like it', () => {
    expect(taskOfPrompt('Read the open issues', tasks)).toBeUndefined();
    expect(taskOfPrompt('Say hello to the team', tasks)).toBeUndefined();
    expect(taskOfPrompt(' Say  hello ', tasks)).toMatchObject({ id: 'c' });
    expect(taskOfPrompt('', tasks)).toBeUndefined();
  });
});

describe('the scheduled tasks of a computer', () => {
  let count = 0;
  function scene() {
    const dir = join(temp.dir, `s${++count}`);
    const folder = join(dir, 'scheduled-tasks');
    const file = join(dir, 'scheduled.json');
    mkdirSync(folder, { recursive: true });
    const write = (id: string, text: string): void => {
      mkdirSync(join(folder, id), { recursive: true });
      writeFileSync(join(folder, id, 'SKILL.md'), text);
    };
    const agents = new Map<string, Agent>();
    const agent = (id: string, state: Agent['state'], more: Partial<Agent> = {}): Agent => {
      const one = { id, sessionId: `s-${id}`, state, cwd: '/p/shop', project: 'shop', ...more } as Agent;
      agents.set(id, one);
      return one;
    };
    const spawned: { cwd: string; prompt: string; name?: string }[] = [];
    let changes = 0;
    let at = 1000;
    const make = () =>
      new Scheduled({
        folder,
        file,
        log: () => {},
        agent: (id) => agents.get(id),
        spawn: async (input, extras) => {
          spawned.push({ ...input, ...extras });
          if (input.cwd === '/gone') return { ok: false, error: 'the folder /gone does not exist' };
          agent('new', 'starting', { cwd: input.cwd });
          return { ok: true, agentId: 'new' };
        },
        onChange: () => changes++,
        now: () => at,
      });
    return { dir, folder, file, write, agent, spawned, make, changes: () => changes, tick: (by: number) => (at += by) };
  }

  it('are read from their folder, by name; what is not one is left alone', () => {
    const { folder, write, make, dir } = scene();
    write('zeta', `---\nname: Zeta\n---\n${BODY}`);
    write('alpha', BODY);
    write('.hidden', BODY);
    write('empty', '---\nname: x\n---\n');
    mkdirSync(join(folder, 'no-file'));
    mkdirSync(join(dir, 'elsewhere'));
    writeFileSync(join(dir, 'elsewhere', 'SKILL.md'), 'a secret');
    // A junction on Windows, where a link needs an administrator.
    symlinkSync(join(dir, 'elsewhere'), join(folder, 'linked'), 'junction');
    expect(make().list().map((task) => task.name)).toEqual(['alpha', 'Zeta']);
    expect(new Scheduled({ folder: join(dir, 'none'), log: () => {}, agent: () => undefined, spawn: async () => ({ ok: false, error: '' }), onChange: () => {} }).list()).toEqual([]);
  });

  it('are read again when they change', () => {
    const { write, make } = scene();
    write('a', BODY);
    const scheduled = make();
    expect(scheduled.list()).toHaveLength(1);
    write('a', `${BODY} And more.`);
    write('b', BODY);
    expect(scheduled.list().map((task) => task.instructions)).toEqual([`${BODY} And more.`, BODY]);
  });

  it('keep the last run seen: who started it, where, and how it went, not the prompt', () => {
    const { write, make, agent, file, tick } = scene();
    write('a', BODY);
    const scheduled = make();
    const run = agent('x', 'working');
    scheduled.prompt(run, `A run:\n${BODY}`);
    expect(scheduled.list()[0]!.lastRun).toEqual({ at: 1000, by: 'app', outcome: 'working', agentId: 'x', cwd: '/p/shop' });
    tick(5);
    scheduled.agentChanged({ ...run, state: 'waiting' } as Agent);
    expect(scheduled.list()[0]!.lastRun).toMatchObject({ outcome: 'waiting' });
    scheduled.agentChanged({ ...run, state: 'idle', completedAt: 1005 } as Agent);
    expect(scheduled.list()[0]!.lastRun).toMatchObject({ outcome: 'done' });
    // What you ask in its session afterwards is yours.
    scheduled.agentChanged({ ...run, state: 'error' } as Agent);
    expect(scheduled.list()[0]!.lastRun).toMatchObject({ outcome: 'done' });
    scheduled.forget(['x']);
    expect(scheduled.list()[0]!.lastRun).toEqual({ at: 1000, by: 'app', outcome: 'done', cwd: '/p/shop' });
    expect(readFileSync(file, 'utf8')).not.toContain('issues');
    expect(make().list()[0]!.lastRun).toMatchObject({ outcome: 'done', by: 'app' });
  });

  it('only the first prompt of a conversation starts one', () => {
    const { write, make, agent } = scene();
    write('a', BODY);
    const scheduled = make();
    const one = agent('x', 'working');
    scheduled.prompt(one, 'something else');
    scheduled.prompt(one, BODY);
    expect(scheduled.list()[0]!.lastRun).toBeUndefined();
    // /clear: a new conversation in the same box.
    scheduled.prompt({ ...one, sessionId: 'other' } as Agent, BODY);
    expect(scheduled.list()[0]!.lastRun).toMatchObject({ agentId: 'x' });
  });

  it('a run cut short is ended, also when the daemon was not there', () => {
    const { write, make, agent } = scene();
    write('a', BODY);
    const scheduled = make();
    const run = agent('x', 'working');
    scheduled.prompt(run, BODY);
    scheduled.agentChanged({ ...run, state: 'ended' } as Agent);
    expect(scheduled.list()[0]!.lastRun).toMatchObject({ outcome: 'ended' });
    const other = scene();
    other.write('a', BODY);
    writeFileSync(other.file, JSON.stringify({ runs: { a: { at: 1, by: 'app', outcome: 'working', agentId: 'gone' }, b: { at: 'x' } } }));
    expect(other.make().list()[0]!.lastRun).toMatchObject({ outcome: 'ended' });
  });

  it('start now as a session with their instructions, in the folder you say', async () => {
    const { write, make, spawned, agent } = scene();
    write('a', `---\nname: Morning\n---\n${BODY}`);
    const scheduled = make();
    expect(await scheduled.run('a', '/p/shop')).toEqual({ ok: true, agentId: 'new' });
    expect(spawned).toEqual([{ cwd: '/p/shop', prompt: BODY, name: 'Morning' }]);
    expect(scheduled.list()[0]!.lastRun).toMatchObject({ by: 'forchetta', agentId: 'new', outcome: 'working' });
    // Its own first prompt is the same run, and at rest before its first turn it is not done.
    scheduled.prompt(agent('new', 'idle'), BODY);
    scheduled.agentChanged(agent('new', 'idle'));
    expect(scheduled.list()[0]!.lastRun).toMatchObject({ by: 'forchetta', outcome: 'working' });
    expect(await scheduled.run('nope', '/p')).toMatchObject({ ok: false });
    expect(await scheduled.run('a', '/gone')).toMatchObject({ ok: false, error: expect.stringContaining('/gone') });
  });

  it('too long for a prompt cannot start from here, and only the start of long ones goes to the page', async () => {
    const { write, make } = scene();
    write('a', 'word '.repeat(6000));
    const scheduled = make();
    expect(scheduled.list()[0]).toMatchObject({ long: true, cut: true });
    expect(scheduled.list()[0]!.instructions).toHaveLength(4000);
    expect(await scheduled.run('a', '/p')).toMatchObject({ ok: false, error: expect.stringContaining('longer') });
  });
});
