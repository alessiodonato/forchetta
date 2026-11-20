import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CrewTemplates, RolePresets } from '../src/daemon/crews.ts';
import { keepRejected, migrateData, readDataJson, writeDataJson } from '../src/shared/data-file.ts';
import { tempDir } from './helpers.ts';

// What you made stays: files written whole, the version before kept, a broken file set aside instead of written over.

const temp = tempDir('data-file');
afterAll(() => temp.cleanup());

let folders = 0;
const folder = (): string => {
  const dir = join(temp.dir, `f-${++folders}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const NOW = new Date('2026-11-20T10:31:02Z');

describe('a data file', () => {
  it('is written whole, private, with the version before kept as .bak', () => {
    const file = join(folder(), 'templates.json');
    writeDataJson(file, [1]);
    expect(existsSync(`${file}.bak`)).toBe(false);
    writeDataJson(file, [1, 2]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([1, 2]);
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual([1]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // No temporary file left behind.
    expect(readdirSync(join(file, '..')).sort()).toEqual(['templates.json', 'templates.json.bak']);
  });

  it('that cannot be read is set aside, and the version before is read in its place', () => {
    const file = join(folder(), 'templates.json');
    writeDataJson(file, ['good']);
    writeDataJson(file, ['newer']);
    writeFileSync(file, '{ broken');
    const logs: string[] = [];
    expect(readDataJson(file, 'modelli', (line) => logs.push(line), NOW)).toEqual(['good']);
    expect(readFileSync(`${file}.corrupt-2026-11-20T10-31-02`, 'utf8')).toBe('{ broken');
    expect(existsSync(file)).toBe(false);
    expect(logs).toEqual([expect.stringContaining('messo da parte come templates.json.corrupt-2026-11-20T10-31-02'), 'modelli: ripresa la versione precedente (templates.json.bak)']);
    // None at all: nothing.
    expect(readDataJson(join(folder(), 'none.json'), 'x', () => {})).toBeUndefined();
  });

  it('keeps the entries that are not valid any more, each once', () => {
    const file = join(folder(), 'skills.json');
    const logs: string[] = [];
    keepRejected(file, [{ id: 'a' }], 'skill', (line) => logs.push(line));
    keepRejected(file, [{ id: 'a' }, { id: 'b' }], 'skill', (line) => logs.push(line));
    keepRejected(file, [], 'skill', (line) => logs.push(line));
    expect(JSON.parse(readFileSync(`${file}.rejected.json`, 'utf8'))).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(logs).toHaveLength(2);
  });
});

describe('templates and presets', () => {
  it('a broken file of templates is not written over by the next save', () => {
    const file = join(folder(), 'crew-templates.json');
    writeFileSync(file, '[{ "name": "Mine", broken');
    const templates = new CrewTemplates(file, () => {});
    expect(templates.save({ name: 'New one', lead: { kind: 'you' }, members: [{ name: 'dev', role: 'Writes code.' }] })).toMatchObject({ ok: true });
    const aside = readdirSync(join(file, '..')).find((name) => name.startsWith('crew-templates.json.corrupt-'));
    expect(readFileSync(join(file, '..', aside!), 'utf8')).toBe('[{ "name": "Mine", broken');
  });

  it('a template that is not valid any more is kept aside, not lost at the next save', () => {
    const file = join(folder(), 'crew-roles.json');
    const odd = { name: '', role: 'no name' };
    writeFileSync(file, JSON.stringify([odd, { name: 'Tester', role: 'Tests.' }]));
    const presets = new RolePresets(file, () => {});
    expect(presets.list().some((preset) => preset.name === 'Tester')).toBe(true);
    expect(JSON.parse(readFileSync(`${file}.rejected.json`, 'utf8'))).toEqual([odd]);
  });
});

describe('the version of the data', () => {
  it('is written the first time, and a newer one stops the daemon', () => {
    const dir = folder();
    expect(migrateData(dir, () => {})).toEqual({ ok: true });
    expect(readFileSync(join(dir, 'data-version'), 'utf8')).toBe('1\n');
    writeFileSync(join(dir, 'data-version'), '7\n');
    expect(migrateData(dir, () => {})).toMatchObject({ ok: false, error: expect.stringContaining('più nuova di Forchetta') });
  });

  it('takes older data through each step', () => {
    const dir = folder();
    writeFileSync(join(dir, 'data-version'), '1\n');
    const done: string[] = [];
    const step = (name: string) => (varDir: string) => void done.push(`${name} ${varDir === dir}`);
    expect(migrateData(dir, () => {}, 3, [step('1→2'), step('2→3')])).toEqual({ ok: true });
    expect(done).toEqual(['1→2 true', '2→3 true']);
    expect(readFileSync(join(dir, 'data-version'), 'utf8')).toBe('3\n');
    expect(migrateData(dir, () => {}, 3, [])).toEqual({ ok: true });
  });
});
