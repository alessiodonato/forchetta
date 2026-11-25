import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Order } from '../src/daemon/order.ts';
import type { Agent } from '../src/shared/agent.ts';
import { MAX_PLACES, moveBefore, placesFor, sortAgents } from '../src/shared/order.ts';
import { dropAt, moveKey, type Slot } from '../src/ui/reorder.ts';
import { tempDir } from './helpers.ts';

const temp = tempDir('order');
afterAll(() => temp.cleanup());

const agent = (id: string, createdAt: number, more: Partial<Agent> = {}): Agent => ({ id, createdAt, cwd: `/p/${id}`, state: 'idle', project: id, pastSessionIds: [], control: { kind: 'tmux', session: id }, lastEvent: { name: '', at: 0 }, ...more }) as Agent;
const ids = (agents: readonly Agent[]): string[] => agents.map((one) => one.id);
const key = (id: string): string => `/p/${id}\n`;

describe('the order of the boxes', () => {
  const abc = [agent('a', 1), agent('b', 2), agent('c', 3)];

  it('is the one they started in, until you drag one', () => {
    expect(ids(sortAgents([abc[2]!, abc[0]!, abc[1]!]))).toEqual(['a', 'b', 'c']);
    expect(ids(sortAgents(abc, []))).toEqual(['a', 'b', 'c']);
  });

  it('is the one you dragged them into; a new session goes last', () => {
    const places = placesFor(['c', 'a', 'b'], abc, []);
    expect(ids(sortAgents(abc, places))).toEqual(['c', 'a', 'b']);
    expect(ids(sortAgents([...abc, agent('d', 4)], places))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('keeps the place of a session that went away for the next one with its folder and its name', () => {
    const places = placesFor(['c', 'a', 'b'], abc, []);
    const again = agent('a2', 9, { cwd: '/p/a' });
    expect(ids(sortAgents([abc[1]!, abc[2]!, again], places))).toEqual(['c', 'a2', 'b']);
    // Another name in the same folder is another session.
    expect(ids(sortAgents([abc[1]!, abc[2]!, agent('a3', 9, { cwd: '/p/a', team: { label: 'tests' } })], places))).toEqual(['c', 'b', 'a3']);
    // The one that ended still shows: the new one comes right after it.
    expect(ids(sortAgents([agent('a', 1, { state: 'ended' }), abc[1]!, abc[2]!, again], places))).toEqual(['c', 'a', 'a2', 'b']);
    // Two in that folder: one place, one session.
    expect(ids(sortAgents([abc[1]!, abc[2]!, again, agent('a4', 10, { cwd: '/p/a' })], places))).toEqual(['c', 'a2', 'b', 'a4']);
  });

  it('a place taken by another session is of that one, and the places of those that are gone stay next to their neighbour', () => {
    const places = placesFor(['c', 'a', 'b'], abc, []);
    const again = agent('a2', 9, { cwd: '/p/a' });
    expect(placesFor(['b', 'c', 'a2'], [abc[1]!, abc[2]!, again], places).map((place) => place.id)).toEqual(['b', 'c', 'a2']);
    // a is not here: after c, as before.
    expect(placesFor(['b', 'c'], [abc[1]!, abc[2]!], places).map((place) => place.id)).toEqual(['b', 'c', 'a']);
    expect(placesFor(['b'], [abc[1]!], places).map((place) => place.id)).toEqual(['c', 'a', 'b']);
  });

  it('takes ids that are not sessions, twice the same, and too few of them', () => {
    expect(placesFor(['x', 'b', 'b'], abc, []).map((place) => place.id)).toEqual(['b', 'a', 'c']);
    const gone = Array.from({ length: MAX_PLACES + 20 }, (_, index) => ({ id: `g${index}`, key: key(`g${index}`) }));
    const many = placesFor(['a', 'b', 'c'], abc, gone);
    expect(many).toHaveLength(MAX_PLACES);
    expect(['a', 'b', 'c'].every((id) => many.some((place) => place.id === id))).toBe(true);
  });

  it('moves some before another one, or to the end', () => {
    expect(moveBefore(['a', 'b', 'c', 'd'], ['d'], 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveBefore(['a', 'b', 'c', 'd'], ['a', 'c'], undefined)).toEqual(['b', 'd', 'a', 'c']);
    expect(moveBefore(['a', 'b'], ['a'], 'a')).toEqual(['a', 'b']);
    expect(moveBefore(['a', 'b'], ['a'], 'gone')).toEqual(['a', 'b']);
  });

  it('is there the next time, and a file that is not valid starts again', () => {
    const file = join(temp.dir, 'order.json');
    new Order(file, () => {}).set(['c', 'a', 'b'], abc);
    expect(ids(sortAgents(abc, new Order(file, () => {}).list()))).toEqual(['c', 'a', 'b']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
    writeFileSync(file, JSON.stringify({ places: [{ id: 1 }, null, { id: 'b', key: 'k', more: 'x' }] }));
    expect(new Order(file, () => {}).list()).toEqual([{ id: 'b', key: 'k' }]);
    writeFileSync(file, '{ nope');
    rmBackup(file);
    expect(new Order(file, () => {}).list()).toEqual([]);
  });
});

function rmBackup(file: string): void {
  writeFileSync(`${file}.bak`, '{ nope');
}

describe('the drag', () => {
  // Two rows of three, 100 wide, 60 high, 10 between.
  const grid: Slot[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({ id, left: (index % 3) * 110, top: Math.floor(index / 3) * 70, right: (index % 3) * 110 + 100, bottom: Math.floor(index / 3) * 70 + 60 }));
  it('drops next to the nearest box, on the side of the mouse', () => {
    expect(dropAt(grid, 'a', 250, 30, false)).toEqual({ id: 'c', side: 'before', before: 'c' });
    expect(dropAt(grid, 'a', 300, 30, false)).toEqual({ id: 'c', side: 'after', before: 'd' });
    expect(dropAt(grid, 'a', 900, 400, false)).toEqual({ id: 'f', side: 'after', before: undefined });
    expect(dropAt(grid, 'f', 5, 5, false)).toEqual({ id: 'a', side: 'before', before: 'a' });
  });
  it('is nothing where the box already is', () => {
    expect(dropAt(grid, 'b', 60, 30, false)).toBeUndefined();
    expect(dropAt(grid, 'b', 230, 30, false)).toBeUndefined();
    expect(dropAt([grid[0]!], 'a', 0, 0, false)).toBeUndefined();
  });
  it('in the column counts the height', () => {
    const column: Slot[] = ['a', 'b', 'c'].map((id, index) => ({ id, left: 0, top: index * 50, right: 200, bottom: index * 50 + 40 }));
    expect(dropAt(column, 'a', 100, 135, true)).toEqual({ id: 'c', side: 'after', before: undefined });
    expect(dropAt(column, 'c', 100, 5, true)).toEqual({ id: 'a', side: 'before', before: 'a' });
  });
  it('from the keyboard is Option and an arrow, with nothing else', () => {
    const press = (key: string, more = {}) => moveKey({ key, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...more });
    expect([press('ArrowLeft'), press('ArrowUp'), press('ArrowRight'), press('ArrowDown')]).toEqual([-1, -1, 1, 1]);
    expect(press('ArrowLeft', { altKey: false })).toBeUndefined();
    expect(press('ArrowLeft', { metaKey: true })).toBeUndefined();
    expect(press('a')).toBeUndefined();
  });
});
