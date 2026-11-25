import type { Agent } from '../shared/agent.ts';
import { readDataJson, writeDataJson } from '../shared/data-file.ts';
import { MAX_PLACES, type Place, placesFor } from '../shared/order.ts';

// The order of the boxes (shared/order.ts), kept in var/order.json.

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

export class Order {
  private places: Place[] = [];

  constructor(
    private readonly file: string | undefined,
    private readonly log: Log,
  ) {
    if (!file) return;
    const raw = readDataJson(file, 'order of the boxes', log) as { places?: unknown } | undefined;
    this.places = (Array.isArray(raw?.places) ? (raw.places as Partial<Place>[]) : [])
      .filter((place): place is Place => typeof place?.id === 'string' && typeof place.key === 'string')
      .slice(0, MAX_PLACES)
      .map(({ id, key }) => ({ id, key }));
  }

  list(): Place[] {
    return this.places;
  }

  /** The boxes took this order. */
  set(ids: readonly string[], agents: readonly Agent[]): void {
    this.places = placesFor(ids, agents, this.places);
    if (!this.file) return;
    try {
      writeDataJson(this.file, { version: 1, places: this.places });
    } catch (error) {
      this.log(`order of the boxes not saved: ${String(error)}`, 'error');
    }
  }
}
