import type { Agent } from './agent.ts';

// The order of the boxes, as you dragged them. Until you drag one, they are in the order they started. The daemon keeps
// it (daemon/order.ts), so every window has the same one, and it is there the next time.

/** The place of a session: who has it, and what it is beyond its id (its folder and its name). */
export interface Place {
  id: string;
  key: string;
}

/** What the daemon keeps: the places of the sessions that are there, and of some that went away. */
export const MAX_PLACES = 300;

type Placed = Pick<Agent, 'id' | 'cwd' | 'team' | 'createdAt' | 'state'>;

/** The folder of a session and the name you gave it: a new one with both takes the place of one that went away. */
export const placeKey = (agent: Pick<Agent, 'cwd' | 'team'>): string => `${agent.cwd ?? ''}\n${agent.team?.label ?? ''}`;

/** The place of each session that has one: its own, or the one of a session gone (or ended) with its folder and its name. */
function claims(agents: readonly Placed[], places: readonly Place[]): Map<string, number> {
  const byId = new Map(places.map((place, index) => [place.id, index]));
  const found = new Map<string, number>();
  /** The places of sessions still at work: no other one takes them. */
  const held = new Set<number>();
  for (const agent of agents) {
    const own = byId.get(agent.id);
    if (own === undefined) continue;
    found.set(agent.id, own);
    if (agent.state !== 'ended') held.add(own);
  }
  for (const agent of agents) {
    if (found.has(agent.id) || agent.state === 'ended') continue;
    const key = placeKey(agent);
    const free = places.findIndex((place, index) => place.key === key && !held.has(index));
    if (free < 0) continue;
    found.set(agent.id, free);
    held.add(free);
  }
  return found;
}

/** The sessions in the order of the boxes: those with a place first, then the others as they started. */
export function sortAgents<T extends Placed>(agents: Iterable<T>, places: readonly Place[] = []): T[] {
  const list = [...agents].sort((a, b) => a.createdAt - b.createdAt);
  if (places.length === 0) return list;
  const at = claims(list, places);
  const rank = (agent: T): number => at.get(agent.id) ?? Number.MAX_SAFE_INTEGER;
  return list.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
}

/** The ids with some of them moved before another one, or to the end. */
export function moveBefore(ids: readonly string[], moving: readonly string[], before: string | undefined): string[] {
  if (before !== undefined && moving.includes(before)) return [...ids];
  const block = ids.filter((id) => moving.includes(id));
  const rest = ids.filter((id) => !moving.includes(id));
  const at = before === undefined ? rest.length : rest.indexOf(before);
  if (at < 0) return [...ids];
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/**
 * The places after the boxes took this order. The sessions that are not here keep theirs, next to the one that came
 * before them: the next one with their folder and name finds it.
 */
export function placesFor(order: readonly string[], agents: readonly Placed[], before: readonly Place[]): Place[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const known = order.filter((id, index) => byId.has(id) && order.indexOf(id) === index);
  // Those that came while you dragged: after the ones you saw.
  for (const agent of sortAgents(agents, before)) if (!known.includes(agent.id)) known.push(agent.id);
  const next: Place[] = known.map((id) => ({ id, key: placeKey(byId.get(id)!) }));
  const claimed = new Set([...claims(agents, before)].filter(([id, index]) => before[index]!.id !== id).map(([, index]) => index));
  let previous: string | undefined;
  for (const [index, place] of before.entries()) {
    if (!byId.has(place.id)) {
      // A place another session took is its place now.
      if (claimed.has(index)) continue;
      const at = previous === undefined ? 0 : next.findIndex((one) => one.id === previous) + 1;
      next.splice(at, 0, place);
    }
    previous = place.id;
  }
  // Too many: the ones gone, from the end.
  for (let index = next.length - 1; index >= 0 && next.length > MAX_PLACES; index--) if (!byId.has(next[index]!.id)) next.splice(index, 1);
  return next;
}
