import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, TokenUsage } from '../shared/agent.ts';
import { addTokens, noTokens, tokensTotal } from '../shared/present.ts';

// The ledger: what the sessions and the teams did, on this Mac, one line of JSON each, never rewritten
// (var/ledger/<year>-<month>.jsonl). `forchetta report` reads it: cost and tokens by team, session, project, model or
// day; turns and how long they took; files written; what the guard stopped, asked or noted; the verdicts of the
// reviewers; the requests of the teams. Costs are those of the status line of Claude Code (dollars at API prices);
// tokens are counted for the sessions of the teams, from their transcripts.

/** Who did it: a session, by its box. */
export interface LedgerWho {
  agent: string;
  /** The folder, as its last part. */
  project: string;
  /** The team of agents and the member, for a session of a team. */
  team?: string;
  member?: string;
  model?: string;
}

export type LedgerEntry =
  /** What a session cost since the entry before: its status line, its transcripts. */
  | ({ t: number; kind: 'cost'; usd: number; tokens?: TokenUsage } & LedgerWho)
  /** A turn that ended: how long, and the files it wrote (as paths in its folder). */
  | ({ t: number; kind: 'turn'; ms?: number; files?: string[]; failed?: boolean } & LedgerWho)
  /** The guard stopped (deny), asked (ask) or told Claude something (note). */
  | ({ t: number; kind: 'guard'; decision: 'deny' | 'ask' | 'note'; tool?: string } & LedgerWho)
  | { t: number; kind: 'review'; team: string; by: string; verdict: 'approved' | 'changes'; commit: string }
  | { t: number; kind: 'request'; team: string; n: number; from: string; to: string[] }
  | ({ t: number; kind: 'session'; event: 'start' | 'end' } & LedgerWho);

/** The file of a month: 2026-11.jsonl, in local time. */
export const ledgerFile = (dir: string, at: number): string => {
  const date = new Date(at);
  return join(dir, `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}.jsonl`);
};

/** Who a session is, for the ledger. */
export function whoOf(agent: Agent, team?: string): LedgerWho {
  return {
    agent: agent.id,
    project: agent.project,
    ...(team ? { team } : {}),
    ...(team && agent.team?.label ? { member: agent.team.label } : {}),
    ...(agent.model ? { model: agent.model } : {}),
  };
}

const MAX_FILES = 50;

export class Ledger {
  /** What was written of each session: its cost and tokens, to write only what came since. */
  private readonly counted = new Map<string, { usd: number; tokens?: TokenUsage }>();
  /** The files written in the turn of each session. */
  private readonly files = new Map<string, Set<string>>();
  private failed = false;

  constructor(
    private readonly dir: string,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {}

  append(entry: LedgerEntry): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(ledgerFile(this.dir, entry.t), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      this.failed = false;
    } catch (error) {
      // Said once, until it works again: the daemon goes on without it.
      if (!this.failed) this.log(`ledger: not written (${String(error)})`, 'warn');
      this.failed = true;
    }
  }

  /**
   * Where the counting of a session starts: what it had already cost when the daemon (re)started, kept in the state
   * of the daemon so that a restart does not count it twice.
   */
  prime(agentId: string, counted: { usd: number; tokens?: TokenUsage } | undefined): void {
    if (counted) this.counted.set(agentId, counted);
  }

  /** What was counted of a session, to keep with it across a restart. */
  countedOf(agentId: string): { usd: number; tokens?: TokenUsage } | undefined {
    return this.counted.get(agentId);
  }

  /**
   * The cost of a session since its last entry, written when there is some. A cost lower than the one counted is a
   * new process (its status line starts from zero again): all of it is new.
   */
  cost(agent: Agent, who: LedgerWho, now = Date.now()): void {
    const usd = agent.usage?.usd ?? 0;
    const tokens = agent.tokens;
    const before = this.counted.get(agent.id) ?? { usd: 0 };
    const usdDelta = usd >= before.usd ? usd - before.usd : usd;
    let tokenDelta: TokenUsage | undefined;
    if (tokens) {
      const was = before.tokens ?? noTokens();
      const lower = tokensTotal(tokens) < tokensTotal(was);
      tokenDelta = lower
        ? tokens
        : { input: tokens.input - was.input, cacheWrite: tokens.cacheWrite - was.cacheWrite, cacheRead: tokens.cacheRead - was.cacheRead, output: tokens.output - was.output };
      if (tokensTotal(tokenDelta) <= 0) tokenDelta = undefined;
    }
    this.counted.set(agent.id, { usd, ...(tokens ? { tokens } : {}) });
    // Below a hundredth of a cent and no tokens: nothing worth a line.
    if (usdDelta < 0.0001 && !tokenDelta) return;
    this.append({ t: now, kind: 'cost', ...who, usd: Math.round(usdDelta * 10_000) / 10_000, ...(tokenDelta ? { tokens: tokenDelta } : {}) });
  }

  /** A file a session wrote in its turn. */
  wrote(agentId: string, file: string): void {
    let files = this.files.get(agentId);
    if (!files) {
      files = new Set();
      this.files.set(agentId, files);
    }
    if (files.size < MAX_FILES) files.add(file);
  }

  /** The end of a turn: how long it took, the files it wrote, and its cost. */
  turn(agent: Agent, who: LedgerWho, options: { failed?: boolean; now?: number } = {}): void {
    const now = options.now ?? Date.now();
    const files = [...(this.files.get(agent.id) ?? [])];
    this.files.delete(agent.id);
    const ms = agent.turnStartedAt && agent.turnStartedAt <= now ? now - agent.turnStartedAt : undefined;
    this.append({ t: now, kind: 'turn', ...who, ...(ms !== undefined ? { ms } : {}), ...(files.length > 0 ? { files } : {}), ...(options.failed ? { failed: true } : {}) });
    this.cost(agent, who, now);
  }

  forget(agentId: string): void {
    this.counted.delete(agentId);
    this.files.delete(agentId);
  }
}

/** The entries from `since` (and before `until`), oldest first; lines that cannot be read are left out. */
export function readLedger(dir: string, since: number, until = Number.POSITIVE_INFINITY): LedgerEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name));
  } catch {
    return [];
  }
  // Only the months that can hold entries of the period.
  const first = ledgerFile('', since).slice(-'2026-11.jsonl'.length);
  const out: LedgerEntry[] = [];
  for (const name of names.sort()) {
    if (name < first) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        if (typeof entry.t === 'number' && entry.t >= since && entry.t < until && typeof entry.kind === 'string') out.push(entry);
      } catch {
        // A line cut short (the Mac stopped while writing): the others count.
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export type ReportBy = 'team' | 'session' | 'project' | 'model' | 'day';
export const REPORT_BY: readonly ReportBy[] = ['team', 'session', 'project', 'model', 'day'];

export interface ReportRow {
  /** The team, the session ("team › member" or the project), the project, the model or the day. */
  key: string;
  usd: number;
  tokens: TokenUsage;
  turns: number;
  /** Time spent in turns. */
  ms: number;
  failedTurns: number;
  /** Files written, each once per row. */
  files: number;
  guard: { deny: number; ask: number; note: number };
  reviews: { approved: number; changes: number };
  requests: number;
  sessions: number;
}

const day = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/** The rows of `forchetta report`, the most expensive first (by day: in order of days). */
export function report(entries: readonly LedgerEntry[], by: ReportBy): ReportRow[] {
  const rows = new Map<string, ReportRow & { fileSet: Set<string>; sessionSet: Set<string> }>();
  const row = (key: string) => {
    let found = rows.get(key);
    if (!found) {
      found = {
        key,
        usd: 0,
        tokens: noTokens(),
        turns: 0,
        ms: 0,
        failedTurns: 0,
        files: 0,
        guard: { deny: 0, ask: 0, note: 0 },
        reviews: { approved: 0, changes: 0 },
        requests: 0,
        sessions: 0,
        fileSet: new Set(),
        sessionSet: new Set(),
      };
      rows.set(key, found);
    }
    return found;
  };
  const keyOf = (entry: LedgerEntry): string | undefined => {
    if (by === 'day') return day(entry.t);
    if (entry.kind === 'review' || entry.kind === 'request') return by === 'team' ? entry.team : by === 'session' ? `${entry.team} › ${entry.kind === 'review' ? entry.by : entry.from}` : undefined;
    if (by === 'team') return entry.team ?? '(no team)';
    if (by === 'session') return entry.team ? `${entry.team} › ${entry.member ?? entry.project}` : `${entry.project} (${entry.agent.slice(0, 8)})`;
    if (by === 'project') return entry.project;
    return entry.model ?? '(unknown model)';
  };
  for (const entry of entries) {
    const key = keyOf(entry);
    if (key === undefined) continue;
    const target = row(key);
    if ('agent' in entry) target.sessionSet.add(entry.agent);
    switch (entry.kind) {
      case 'cost':
        target.usd += entry.usd;
        if (entry.tokens) addTokens(target.tokens, entry.tokens);
        break;
      case 'turn':
        target.turns += 1;
        target.ms += entry.ms ?? 0;
        if (entry.failed) target.failedTurns += 1;
        for (const file of entry.files ?? []) target.fileSet.add(`${entry.project}/${file}`);
        break;
      case 'guard':
        target.guard[entry.decision] += 1;
        break;
      case 'review':
        target.reviews[entry.verdict] += 1;
        break;
      case 'request':
        target.requests += 1;
        break;
      case 'session':
        break;
    }
  }
  const out = [...rows.values()]
    .map(({ fileSet, sessionSet, ...rest }) => ({ ...rest, usd: Math.round(rest.usd * 100) / 100, files: fileSet.size, sessions: sessionSet.size }))
    // A row of sessions that only ended, with nothing else: nothing to report.
    .filter((row) => row.usd > 0 || tokensTotal(row.tokens) > 0 || row.turns > 0 || row.files > 0 || row.requests > 0 || row.reviews.approved + row.reviews.changes > 0 || row.guard.deny + row.guard.ask + row.guard.note > 0);
  return by === 'day' ? out.sort((a, b) => a.key.localeCompare(b.key)) : out.sort((a, b) => b.usd - a.usd || tokensTotal(b.tokens) - tokensTotal(a.tokens) || a.key.localeCompare(b.key));
}

/** The rows as CSV, for a spreadsheet. */
export function reportCsv(rows: readonly ReportRow[], by: ReportBy): string {
  const cell = (value: string | number): string => (typeof value === 'number' ? String(value) : /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const head = [by, 'usd', 'tokens', 'input', 'cache_write', 'cache_read', 'output', 'sessions', 'turns', 'failed_turns', 'minutes', 'files', 'guard_deny', 'guard_ask', 'guard_note', 'reviews_approved', 'reviews_changes', 'requests'];
  const lines = rows.map((row) =>
    [
      row.key,
      row.usd,
      tokensTotal(row.tokens),
      row.tokens.input,
      row.tokens.cacheWrite,
      row.tokens.cacheRead,
      row.tokens.output,
      row.sessions,
      row.turns,
      row.failedTurns,
      Math.round(row.ms / 60_000),
      row.files,
      row.guard.deny,
      row.guard.ask,
      row.guard.note,
      row.reviews.approved,
      row.reviews.changes,
      row.requests,
    ]
      .map(cell)
      .join(','),
  );
  return `${[head.join(','), ...lines].join('\n')}\n`;
}

/** "7d", "24h", "2w", or a date (2026-11-01): the start of the period; undefined when it is none of those. */
export function parseSince(text: string, now = Date.now()): number | undefined {
  const relative = /^(\d{1,4})\s*([hdw])$/i.exec(text.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    if (unit === 'h') return now - amount * 3_600_000;
    // Days count from midnight: "1d" is today, "7d" today and the 6 days before.
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.getTime() - (amount * (unit === 'w' ? 7 : 1) - 1) * 86_400_000;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
    const [year, month, date] = text.trim().split('-').map(Number) as [number, number, number];
    const start = new Date(year, month - 1, date).getTime();
    return Number.isFinite(start) ? start : undefined;
  }
  return undefined;
}
