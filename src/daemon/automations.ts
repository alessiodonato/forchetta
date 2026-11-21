import { randomUUID } from 'node:crypto';
import type { Agent, UsageLimits } from '../shared/agent.ts';
import {
  AUTO_DELIVERABLE,
  AUTO_HISTORY_MAX,
  AUTO_QUEUE_MAX,
  type AutoItem,
  type Automation,
  type AutomationView,
  autoNote,
  GITHUB_NOTE,
  cleanAutomation,
  dateOf,
  FIVE_HOUR_STOP,
  fieldsOf,
  fillFields,
  GITHUB_EVERY_MS,
  itemLabel,
  lastSlot,
  nextSlot,
  queueItems,
  runName,
  runValues,
  templateFor,
  timeOf,
  WEEK_STOP,
} from '../shared/automation.ts';
import { cleanCrewSpec, CREW_NAME_MAX, type CrewSpec, type CrewTemplate } from '../shared/crew.ts';
import { readDataJson, writeDataJson } from '../shared/data-file.ts';
import type { Crews } from './crews.ts';
import type { GithubResult } from './github.ts';

// The teams that start by themselves (shared/automation.ts): their queues, the run at work, the last runs. Every
// few seconds (tick) each automation that is not paused gets what its schedule or GitHub adds, and when it has no
// run at work and nothing to wait for, its next item starts: a new team from its template, in its folder, with the
// goal sent to its lead. A run is over when its lead delivers; it fails when it costs more than its budget, takes
// longer than its time (not counting the waits for your approval), or its sessions end first. A run delivered is
// stopped (Crews.stop) and, if chosen, its sessions end with /exit. A run that failed, or that you stopped, is
// stopped too, so that nothing more goes to its sessions, but they stay for you to look at (the panel ends them when
// you say), and its automation pauses: nothing more starts until you look. Kept in var/automations.json.

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

export interface AutomationsDeps {
  file?: string;
  log: Log;
  crews: Pick<Crews, 'create' | 'request' | 'get' | 'list' | 'stop' | 'costOf' | 'setEnded' | 'archive' | 'markAuto' | 'trusted'>;
  templates: () => readonly CrewTemplate[];
  /** The rules of the repository of a folder, before those of the team (daemon/repo-config.ts). */
  withRepoRules?: (spec: CrewSpec) => CrewSpec;
  agent: (agentId: string) => Agent | undefined;
  /** What a session cost, at API prices (its status line). */
  costOf: (agentId: string) => number;
  limits: () => UsageLimits | undefined;
  /** /exit into the queue of a session (Commander.enqueueExit). */
  exit: (agentId: string) => boolean;
  /** Takes a command back from the queue of a session (Commander.cancel). */
  cancel: (agentId: string, commandId: string) => void;
  isFolder: (dir: string) => boolean;
  /** The issues or pull requests of GitHub; none in the demo. */
  github?: (cwd: string, trigger: Extract<Automation['trigger'], { kind: 'github' }>) => Promise<GithubResult>;
  notify: (notice: { agentId?: string; title: string; body: string }) => void;
  onChange: () => void;
  now?: () => number;
}

export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

export type AutoAction = 'pause' | 'resume' | 'add' | 'cancel' | 'stop' | 'retry' | 'close';
export const AUTO_ACTIONS: readonly AutoAction[] = ['pause', 'resume', 'add', 'cancel', 'stop', 'retry', 'close'];
/** How often the automations look at their runs, their schedules and GitHub. */
export const AUTO_TICK_MS = 20_000;

/** The sessions of a run that is over get this long to end before the next run in the same folder starts anyway. */
const CLOSING_HOLD_MS = 10 * 60_000;
/** /exit is asked again of a session still open this long after, up to EXIT_TRIES times. */
const EXIT_AGAIN_MS = 3 * 60_000;
const EXIT_TRIES = 3;
/** The sessions of a run that just started may not be known yet: no "ended" before this. */
const START_GRACE_MS = 60_000;
/** Numbers of GitHub kept as taken, at most. */
const SEEN_MAX = 2000;

interface AutomationsFile {
  version: 1;
  automations: Automation[];
}

const usdText = (usd: number): string => `$${usd.toFixed(2)}`;

/** An item of the queue, from its fields. */
function newItem(source: AutoItem['source'], fields: Record<string, string>, now: number, number?: number): AutoItem {
  return { id: randomUUID(), label: itemLabel(source, fields), fields, source, status: 'waiting', addedAt: now, ...(number !== undefined ? { number } : {}) };
}

export class Automations {
  private automations: Automation[] = [];
  /** The look in progress, and the one asked meanwhile: it runs after it, and sees what changed since. */
  private ticking: Promise<void> | undefined;
  private again: Promise<void> | undefined;
  private readonly polling = new Set<string>();
  /** When a run started to wait for your approval, by item: that time does not count against its length. */
  private readonly approvalSince = new Map<string, number>();

  constructor(private readonly deps: AutomationsDeps) {
    if (!deps.file) return;
    const raw = readDataJson(deps.file, 'automations', deps.log) as Partial<AutomationsFile> | undefined;
    if (raw && Array.isArray(raw.automations)) {
      this.automations = raw.automations.filter((auto): auto is Automation => typeof auto?.id === 'string' && typeof auto.name === 'string' && Array.isArray(auto.items) && !!auto.trigger);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  list(): readonly Automation[] {
    return this.automations;
  }

  get(id: string): Automation | undefined {
    return this.automations.find((auto) => auto.id === id);
  }

  /** By id, or by name (any case): for `forchetta auto`. */
  find(key: string): Automation | undefined {
    const wanted = key.trim().toLowerCase();
    return this.automations.find((auto) => auto.id === key || auto.name.toLowerCase() === wanted);
  }

  /** What the page shows: every automation, why its next item waits, its next time, what the run at work cost. */
  views(): AutomationView[] {
    const now = this.now();
    return this.automations.map((auto) => {
      const { seen: _seen, ...rest } = auto;
      const running = auto.items.find((item) => item.status === 'running');
      const wait = auto.paused || running ? undefined : this.waitReason(auto, now);
      const next = auto.trigger.kind === 'schedule' && !auto.paused ? nextSlot(auto.trigger, now) : undefined;
      const usd = running?.crewId ? this.deps.crews.costOf(running.crewId, this.deps.costOf) : undefined;
      return { ...rest, items: auto.items.map((item) => ({ ...item })), ...(wait ? { wait } : {}), ...(next ? { nextAt: next } : {}), ...(usd !== undefined ? { usd } : {}) };
    });
  }

  /** A new automation, or a change of one (`id`): checked, with its folder and its name. */
  save(input: unknown, id?: string): Result<{ id: string }> {
    const now = this.now();
    const checked = cleanAutomation(input, this.deps.templates());
    if ('error' in checked) return { ok: false, error: checked.error };
    const spec = checked.spec;
    const old = id ? this.get(id) : undefined;
    if (id && !old) return { ok: false, error: 'this automation is gone' };
    if (this.automations.some((auto) => auto !== old && auto.name.toLowerCase() === spec.name.toLowerCase())) return { ok: false, error: `an automation called "${spec.name}" already exists` };
    if (!this.deps.isFolder(spec.cwd)) return { ok: false, error: `the folder ${spec.cwd} does not exist` };
    if (!this.deps.crews.trusted(spec.cwd)) {
      return { ok: false, error: 'Claude Code does not trust this folder yet, and a team that starts by itself has nobody to answer its trust dialog: open the folder once with claude, accept it, then save again' };
    }
    if (old) {
      const sameStart = JSON.stringify(old.trigger) === JSON.stringify(spec.trigger);
      // Items waiting with the fields of another way to start would leave {item} or {number} empty in the goal.
      if (fieldsOf(old.trigger).join() !== fieldsOf(spec.trigger).join()) {
        const dropped = old.items.filter((item) => item.status === 'waiting').length;
        old.items = old.items.filter((item) => item.status !== 'waiting');
        if (dropped > 0) this.deps.log(`automation "${old.name}": ${dropped} waiting items taken out (another way to start)`);
      }
      Object.assign(old, spec);
      if (!spec.values) delete old.values;
      if (!sameStart) {
        // Another way to start counts from now: the times already past and the numbers of another list do not.
        old.since = now;
        delete old.seen;
        delete old.poll;
        if (spec.trigger.kind === 'schedule') old.lastSlot = lastSlot(spec.trigger, now);
        else delete old.lastSlot;
      }
      this.deps.log(`automation "${old.name}" changed`);
      this.changed();
      return { ok: true, id: old.id };
    }
    const auto: Automation = { ...spec, id: randomUUID(), createdAt: now, since: now, items: [] };
    if (spec.trigger.kind === 'schedule') {
      const last = lastSlot(spec.trigger, now);
      if (last !== undefined) auto.lastSlot = last;
    }
    this.automations.push(auto);
    this.deps.log(`automation "${auto.name}" created: ${auto.template} in ${auto.cwd}`);
    this.changed();
    // GitHub: a first look now, not in five minutes.
    if (auto.trigger.kind === 'github') this.poll(auto, now, true);
    return { ok: true, id: auto.id };
  }

  /** An automation taken away: not while a run works; the teams of its runs that ended go with it. */
  remove(id: string): Result {
    const auto = this.get(id);
    if (!auto) return { ok: false, error: 'this automation is gone' };
    if (auto.items.some((item) => item.status === 'running')) return { ok: false, error: 'a run is at work: stop it first' };
    for (const item of auto.items) if (item.crewId && this.deps.crews.get(item.crewId)?.endedAt) this.deps.crews.archive(item.crewId);
    this.automations = this.automations.filter((candidate) => candidate !== auto);
    this.deps.log(`automation "${auto.name}" deleted`);
    this.changed();
    return { ok: true };
  }

  /**
   * pause, resume; add (items of the queue, one per line; for a schedule a run now; for GitHub a look now); cancel an
   * item that waits; stop the run at work (and pause); retry a run that failed or was stopped; close: end the sessions
   * of a run that is over and kept them.
   */
  act(id: string, action: AutoAction, arg?: { text?: string; itemId?: string }): Result<{ added?: number }> {
    const auto = this.get(id);
    if (!auto) return { ok: false, error: 'this automation is gone' };
    const now = this.now();
    switch (action) {
      case 'pause':
        if (!auto.paused) auto.paused = { at: now, by: 'you', reason: 'paused by you' };
        this.deps.log(`automation "${auto.name}" paused`);
        break;
      case 'resume':
        if (!auto.paused) return { ok: true };
        delete auto.paused;
        // The times that passed while it was paused do not start now.
        if (auto.trigger.kind === 'schedule') auto.lastSlot = lastSlot(auto.trigger, now) ?? auto.lastSlot;
        this.deps.log(`automation "${auto.name}" resumed`);
        if (auto.trigger.kind === 'github') this.poll(auto, now, true);
        break;
      case 'add': {
        if (auto.trigger.kind === 'github') {
          if (auto.paused) return { ok: false, error: 'it is paused: resume it, and it looks at GitHub' };
          this.poll(auto, now, true);
          return { ok: true };
        }
        const waiting = auto.items.filter((item) => item.status === 'waiting').length;
        const fields = auto.trigger.kind === 'queue' ? queueItems(arg?.text ?? '').map((item) => ({ item })) : [{ date: dateOf(now), time: timeOf(now) }];
        if (fields.length === 0) return { ok: false, error: 'write the items, one per line' };
        if (waiting + fields.length > AUTO_QUEUE_MAX) return { ok: false, error: `the queue holds ${AUTO_QUEUE_MAX} items at most: ${AUTO_QUEUE_MAX - waiting} more fit` };
        for (const one of fields) auto.items.push(newItem('you', one, now));
        this.deps.log(`automation "${auto.name}": ${fields.length} ${fields.length === 1 ? 'item' : 'items'} added`);
        this.changed();
        void this.tick();
        return { ok: true, added: fields.length };
      }
      case 'cancel': {
        const item = auto.items.find((candidate) => candidate.id === arg?.itemId);
        if (!item || item.status !== 'waiting') return { ok: false, error: 'this item does not wait in the queue' };
        auto.items = auto.items.filter((candidate) => candidate !== item);
        break;
      }
      case 'stop': {
        const item = auto.items.find((candidate) => candidate.status === 'running');
        if (!item) return { ok: false, error: 'no run is at work' };
        this.finish(auto, item, 'cancelled', 'stopped by you', now);
        auto.paused = { at: now, by: 'you', reason: `you stopped "${item.label}"` };
        break;
      }
      case 'close': {
        const item = auto.items.find((candidate) => candidate.id === arg?.itemId);
        const crew = item?.crewId ? this.deps.crews.get(item.crewId) : undefined;
        if (!item || item.status === 'waiting' || item.status === 'running' || !crew || item.closing === 'done') return { ok: false, error: 'no sessions of this run to end' };
        this.deps.crews.stop(crew.id, item.status === 'done' ? 'its work was delivered' : (item.note ?? 'stopped'), this.deps.cancel, now);
        item.closing = 'asked';
        item.exits = 0;
        this.exitAll(item, now);
        break;
      }
      case 'retry': {
        const item = auto.items.find((candidate) => candidate.id === arg?.itemId);
        if (!item || (item.status !== 'failed' && item.status !== 'cancelled')) return { ok: false, error: 'only a run that failed or was stopped can start again' };
        if (auto.items.filter((candidate) => candidate.status === 'waiting').length >= AUTO_QUEUE_MAX) return { ok: false, error: `the queue holds ${AUTO_QUEUE_MAX} items at most` };
        auto.items.push(newItem(item.source, { ...item.fields }, now, item.number));
        break;
      }
      default:
        return { ok: false, error: `unknown action: ${String(action)}` };
    }
    this.changed();
    void this.tick();
    return { ok: true };
  }

  /** Every few seconds: the runs at work and those that ended, what the schedules and GitHub add, the next runs. */
  tick(): Promise<void> {
    if (this.ticking) {
      this.again ??= this.ticking.then(() => {
        this.again = undefined;
        return this.tick();
      });
      return this.again;
    }
    this.ticking = this.look().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async look(): Promise<void> {
    try {
      for (const auto of [...this.automations]) {
        const now = this.now();
        const running = auto.items.find((item) => item.status === 'running');
        if (running) this.watch(auto, running, now);
        for (const item of auto.items) {
          if (item.closing === 'asked') this.close(auto, item, now);
          else if (item.closing === 'kept') this.kept(item, now);
        }
        if (auto.paused || !this.automations.includes(auto)) continue;
        this.feed(auto, now);
        if (auto.items.some((item) => item.status === 'running')) continue;
        const next = auto.items.find((item) => item.status === 'waiting');
        if (next && !this.waitReason(auto, now)) await this.start(auto, next, now);
      }
    } catch (error) {
      this.deps.log(`automations: ${String(error)}`, 'error');
    }
  }

  /** Why the next item of an automation does not start yet; undefined when it can. */
  private waitReason(auto: Automation, now: number): string | undefined {
    if (!auto.items.some((item) => item.status === 'waiting')) return undefined;
    for (const other of this.automations) {
      if (other.cwd !== auto.cwd) continue;
      for (const item of other.items) {
        const busy = item.status === 'running' || (item.closing === 'asked' && now - (item.endedAt ?? now) < CLOSING_HOLD_MS);
        if (!busy) continue;
        if (other === auto) return item.status === 'running' ? undefined : `waits for the sessions of "${item.label}" to end`;
        return `waits for "${other.name}", at work in the same folder`;
      }
    }
    const limits = this.deps.limits();
    const five = limits?.fiveHour;
    if (five && five.resetsAt > now && five.percent >= FIVE_HOUR_STOP) return `waits for the 5-hour limit (${Math.round(five.percent)}% used) to reset at ${timeOf(five.resetsAt)}`;
    const week = limits?.sevenDay;
    if (week && week.resetsAt > now && week.percent >= WEEK_STOP) return `waits for the weekly limit (${Math.round(week.percent)}% used) to reset on ${dateOf(week.resetsAt)} at ${timeOf(week.resetsAt)}`;
    return undefined;
  }

  /** What the schedule adds: the last time past, once, unless a run of the schedule still waits. */
  private feed(auto: Automation, now: number): void {
    if (auto.trigger.kind === 'github') {
      this.poll(auto, now, false);
      return;
    }
    if (auto.trigger.kind !== 'schedule') return;
    const slot = lastSlot(auto.trigger, now);
    if (slot === undefined || slot <= (auto.lastSlot ?? 0)) return;
    auto.lastSlot = slot;
    if (!auto.items.some((item) => item.status === 'waiting' && item.source === 'schedule')) {
      auto.items.push(newItem('schedule', { date: dateOf(slot), time: timeOf(slot) }, now));
      this.deps.log(`automation "${auto.name}": the run of ${dateOf(slot)} ${timeOf(slot)} is in the queue`);
    }
    this.changed();
  }

  /** GitHub, every few minutes (or now, `force`): what is new goes into the queue, each number once. */
  private poll(auto: Automation, now: number, force: boolean): void {
    if (auto.trigger.kind !== 'github' || this.polling.has(auto.id)) return;
    if (!force && auto.poll && now - auto.poll.at < GITHUB_EVERY_MS) return;
    const github = this.deps.github;
    if (!github) {
      if (!auto.poll?.error) {
        auto.poll = { at: now, error: 'GitHub is not checked here' };
        this.changed();
      }
      return;
    }
    const trigger = auto.trigger;
    this.polling.add(auto.id);
    void github(auto.cwd, trigger)
      .then((result) => this.polled(auto.id, JSON.stringify(trigger), result))
      .catch((error: unknown) => this.polled(auto.id, JSON.stringify(trigger), { ok: false, error: String(error) }))
      .finally(() => this.polling.delete(auto.id));
  }

  private polled(id: string, trigger: string, result: GithubResult): void {
    const auto = this.get(id);
    // Changed or paused while gh ran: this answer is for another list, or for later.
    if (!auto || auto.trigger.kind !== 'github' || JSON.stringify(auto.trigger) !== trigger || auto.paused) return;
    const now = this.now();
    if (!result.ok) {
      if (auto.poll?.error !== result.error) this.deps.log(`automation "${auto.name}": ${result.error}`, 'warn');
      auto.poll = { at: now, error: result.error };
      this.changed();
      return;
    }
    auto.poll = { at: now, repo: result.repo };
    const seen = new Set(auto.seen ?? []);
    const unlabelledPrs = auto.trigger.what === 'prs' && !auto.trigger.label;
    let added = 0;
    for (const found of result.items) {
      if (seen.has(found.number)) continue;
      seen.add(found.number);
      // Without a label, only the pull requests opened since the automation was saved.
      if (unlabelledPrs && (found.createdAt ?? 0) < auto.since) continue;
      if (auto.items.filter((item) => item.status === 'waiting').length >= AUTO_QUEUE_MAX) {
        seen.delete(found.number);
        break;
      }
      const fields: Record<string, string> = { number: String(found.number), title: found.title, url: found.url, ...(auto.trigger.what === 'prs' ? { branch: found.branch ?? '' } : {}) };
      auto.items.push(newItem('github', fields, now, found.number));
      added += 1;
    }
    auto.seen = [...seen].slice(-SEEN_MAX);
    if (added > 0) this.deps.log(`automation "${auto.name}": ${added} new from ${result.repo}`);
    this.changed();
    if (added > 0) void this.tick();
  }

  /** The next item starts: a team from the template, the goal to its lead. */
  private async start(auto: Automation, item: AutoItem, now: number): Promise<void> {
    const fail = (why: string): void => {
      item.status = 'running';
      this.finish(auto, item, 'failed', why, now);
    };
    const found = templateFor(this.deps.templates(), auto.template);
    if ('error' in found) return fail(found.error);
    if (!this.deps.isFolder(auto.cwd)) return fail(`the folder ${auto.cwd} does not exist`);
    if (!this.deps.crews.trusted(auto.cwd)) return fail('Claude Code does not trust the folder: open it once with claude and accept its trust dialog');
    const template = found.template;
    const taken = new Set(this.deps.crews.list().map((crew) => crew.name.toLowerCase()));
    const base = runName(auto.name, item.label);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, CREW_NAME_MAX - String(n).length - 1).trimEnd()} ${n}`;
    const { builtin: _builtin, modified: _modified, ...fields } = template;
    const checked = cleanCrewSpec({
      ...fields,
      name,
      cwd: auto.cwd,
      budgetUsd: auto.budgetUsd,
      deliverable: template.deliverable?.trim() || AUTO_DELIVERABLE,
      values: runValues(auto, template, item.fields),
    });
    if ('error' in checked) return fail(`the template does not make a team: ${checked.error}`);
    const spec = this.deps.withRepoRules ? this.deps.withRepoRules(checked.spec) : checked.spec;
    // At work from now: no other tick starts it again while its sessions start.
    item.status = 'running';
    item.startedAt = now;
    item.crewName = name;
    this.changed();
    this.deps.log(`automation "${auto.name}": "${item.label}" starts (${name})`);
    let created: Awaited<ReturnType<AutomationsDeps['crews']['create']>>;
    try {
      created = await this.deps.crews.create(spec);
    } catch (error) {
      created = { ok: false, error: String(error) };
    }
    // Stopped by you, or the automation taken away, while its sessions started: the new team stops at once.
    if (item.status !== 'running' || !this.automations.includes(auto)) {
      if (created.ok && created.crewId) {
        item.crewId = created.crewId;
        this.deps.crews.markAuto(created.crewId, { id: auto.id, name: auto.name });
        this.deps.crews.stop(created.crewId, 'stopped by you', this.deps.cancel, this.now());
        item.closing = 'asked';
        item.exits = 0;
        this.exitAll(item, this.now());
        this.changed();
      }
      return;
    }
    if (!created.ok || !created.crewId) return this.finish(auto, item, 'failed', `the team did not start: ${created.error ?? 'no session started'}`, this.now());
    item.crewId = created.crewId;
    if (created.error) item.note = created.error;
    this.deps.crews.markAuto(created.crewId, { id: auto.id, name: auto.name });
    const crew = this.deps.crews.get(created.crewId);
    const lead = crew?.lead.kind === 'claude' ? crew.lead.name : undefined;
    if (!crew || !lead) return this.finish(auto, item, 'failed', 'the team has no Claude lead', this.now());
    const goal = `${fillFields(auto.goal, item.fields)}\n\n${autoNote(auto.name)}${item.source === 'github' ? `\n${GITHUB_NOTE}` : ''}`;
    const sent = this.deps.crews.request(created.crewId, [lead], goal);
    if (!sent.ok) return this.finish(auto, item, 'failed', `the goal did not reach ${lead}: ${sent.error}`, this.now());
    this.changed();
    if (item.source !== 'you') this.deps.notify({ agentId: crew.agents.lead, title: `${auto.name}: ${item.label}`, body: `A run started by itself (${item.source === 'github' ? 'GitHub' : 'the schedule'}): ${crew.name}.` });
  }

  /** A run at work: delivered, over its budget, over its time, or with its sessions ended. */
  private watch(auto: Automation, item: AutoItem, now: number): void {
    if (!item.crewId) {
      // Started before a restart of the daemon, with no team yet: it never got one.
      if (now - (item.startedAt ?? now) > START_GRACE_MS * 5) this.finish(auto, item, 'failed', 'its team did not start', now);
      return;
    }
    const crew = this.deps.crews.get(item.crewId);
    if (!crew) return this.finish(auto, item, 'failed', 'its team is gone', now);
    item.usd = this.deps.crews.costOf(item.crewId, this.deps.costOf);
    const delivered = (crew.delivered ?? []).filter((one) => one.at >= (item.startedAt ?? 0)).at(-1);
    if (delivered) {
      item.delivered = { summary: delivered.summary, ...(delivered.where ? { where: delivered.where } : {}) };
      return this.finish(auto, item, 'done', undefined, now);
    }
    if (item.usd >= auto.budgetUsd) return this.finish(auto, item, 'failed', `it passed its budget: ≈ ${usdText(item.usd)} of ${usdText(auto.budgetUsd)}`, now);
    // Its length, without the time it waited for your approval.
    const waiting = (crew.requests ?? []).some((request) => request.deliveries.some((delivery) => delivery.status === 'approval'));
    const since = this.approvalSince.get(item.id);
    if (waiting && since === undefined) this.approvalSince.set(item.id, now);
    if (!waiting && since !== undefined) {
      this.approvalSince.delete(item.id);
      item.approvalMs = (item.approvalMs ?? 0) + (now - since);
      this.changed();
    }
    const length = now - (item.startedAt ?? now) - (item.approvalMs ?? 0);
    if (!waiting && length > auto.maxMinutes * 60_000) return this.finish(auto, item, 'failed', `it did not deliver in ${auto.maxMinutes} minutes`, now);
    const sessions = Object.values(crew.agents);
    const ended = sessions.length > 0 && sessions.every((agentId) => this.deps.agent(agentId)?.state === 'ended' || !this.deps.agent(agentId));
    if (ended && now - (item.startedAt ?? now) > START_GRACE_MS) this.finish(auto, item, 'failed', 'its sessions ended before it delivered', now);
  }

  /**
   * A run is over: done, failed or stopped by you. Its team stops and its sessions end (/exit), unless it was
   * delivered and the automation keeps them. A run that failed pauses its automation, and you are told.
   */
  private finish(auto: Automation, item: AutoItem, status: 'done' | 'failed' | 'cancelled', note: string | undefined, now: number): void {
    item.status = status;
    item.endedAt = now;
    this.approvalSince.delete(item.id);
    if (note) item.note = note;
    const crew = item.crewId ? this.deps.crews.get(item.crewId) : undefined;
    if (crew) {
      item.usd = this.deps.crews.costOf(crew.id, this.deps.costOf);
      if (status === 'done' && !auto.endSessions) item.closing = 'kept';
      else {
        // Nothing more goes to its sessions: what they work on they finish, then they wait.
        this.deps.crews.stop(crew.id, status === 'done' ? 'its work was delivered' : (note ?? 'stopped'), this.deps.cancel, now);
        if (status === 'done') {
          item.closing = 'asked';
          item.exits = 0;
          this.exitAll(item, now);
        } else item.closing = 'kept';
      }
    }
    this.deps.log(`automation "${auto.name}": "${item.label}" ${status}${note ? ` (${note})` : ''}${item.usd ? `, ≈ ${usdText(item.usd)}` : ''}`, status === 'failed' ? 'warn' : 'info');
    if (status === 'failed') {
      auto.paused = { at: now, by: 'forchetta', reason: `"${item.label}" failed: ${note ?? 'see its team'}` };
      this.deps.notify({ ...(crew?.agents.lead ? { agentId: crew.agents.lead } : {}), title: `${auto.name} is paused`, body: `"${item.label}" failed: ${note ?? 'see its team'}. Nothing more starts until you resume it.` });
    }
    this.trim(auto);
    this.changed();
  }

  /** /exit to each session of a run still open. */
  private exitAll(item: AutoItem, now: number): void {
    const crew = item.crewId ? this.deps.crews.get(item.crewId) : undefined;
    if (!crew) return;
    for (const agentId of Object.values(crew.agents)) {
      const agent = this.deps.agent(agentId);
      if (agent && agent.state !== 'ended') this.deps.exit(agentId);
    }
    item.exits = (item.exits ?? 0) + 1;
    item.exitAt = now;
  }

  /** The sessions of a run that is over: all ended, or /exit again for those still open whose /exit did not take. */
  private close(auto: Automation, item: AutoItem, now: number): void {
    const crew = item.crewId ? this.deps.crews.get(item.crewId) : undefined;
    const open = crew ? Object.values(crew.agents).filter((agentId) => { const agent = this.deps.agent(agentId); return agent !== undefined && agent.state !== 'ended'; }) : [];
    if (!crew || open.length === 0) {
      item.closing = 'done';
      if (crew) this.deps.crews.setEnded(crew.id, now);
      this.changed();
      return;
    }
    // A /exit still in a queue (the session at work) or just sent: wait for it.
    const pending = open.some((agentId) => this.deps.agent(agentId)?.commands?.some((command) => command.kind === 'exit' && ['in-coda', 'bloccato', 'inviato'].includes(command.status)));
    if (pending || now - (item.exitAt ?? 0) < EXIT_AGAIN_MS) return;
    if ((item.exits ?? 0) >= EXIT_TRIES) {
      item.closing = 'kept';
      item.note = `${item.note ? `${item.note}. ` : ''}${open.length === 1 ? 'a session' : `${open.length} sessions`} did not end: see ${open.length === 1 ? 'its terminal' : 'their terminals'}`;
      this.deps.log(`automation "${auto.name}": the sessions of "${item.label}" did not end`, 'warn');
      this.changed();
      return;
    }
    this.exitAll(item, now);
    this.changed();
  }

  /** A run stopped whose sessions were kept: once you ended them all, its team leaves the list of the teams. */
  private kept(item: AutoItem, now: number): void {
    const crew = item.crewId ? this.deps.crews.get(item.crewId) : undefined;
    if (!crew?.stoppedAt || crew.endedAt) return;
    const open = Object.values(crew.agents).some((agentId) => {
      const agent = this.deps.agent(agentId);
      return agent !== undefined && agent.state !== 'ended';
    });
    if (open) return;
    item.closing = 'done';
    this.deps.crews.setEnded(crew.id, now);
    this.changed();
  }

  /** The runs that ended, the last ones only: the older go, and their teams leave the daemon when they ended. */
  private trim(auto: Automation): void {
    const over = auto.items.filter((item) => item.status !== 'waiting' && item.status !== 'running');
    const extra = over.length - AUTO_HISTORY_MAX;
    if (extra <= 0) return;
    const gone = new Set(over.slice(0, extra).filter((item) => item.closing !== 'asked'));
    for (const item of gone) if (item.crewId && this.deps.crews.get(item.crewId)?.endedAt) this.deps.crews.archive(item.crewId);
    auto.items = auto.items.filter((item) => !gone.has(item));
  }

  private changed(): void {
    if (this.deps.file) {
      try {
        writeDataJson(this.deps.file, { version: 1, automations: this.automations } satisfies AutomationsFile);
      } catch (error) {
        this.deps.log(`automations not saved: ${String(error)}`, 'error');
      }
    }
    this.deps.onChange();
  }
}
