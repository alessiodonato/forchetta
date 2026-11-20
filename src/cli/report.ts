import { join } from 'node:path';
import { UserError } from '../shared/errors.ts';
import { paths } from '../shared/paths.ts';
import { shortTokens, tokensTotal, usdText } from '../shared/present.ts';
import { type LedgerEntry, parseSince, readLedger, report, REPORT_BY, type ReportBy, reportCsv, type ReportRow } from '../daemon/ledger.ts';
import { parseArgs } from './args.ts';
import { closest, code } from './help.ts';
import type { RunIO } from './run.ts';
import { visibleLength } from './style.ts';

// `forchetta report`: what the sessions and the teams did and cost, from the ledger of this Mac (var/ledger). It
// reads files only: the daemon need not run.

const minutes = (ms: number): string => {
  const total = Math.round(ms / 60_000);
  return total < 60 ? `${total} min` : `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')}`;
};

/** The table of the rows, with a line for all of them. */
export function renderReport(rows: readonly ReportRow[], by: ReportBy, io: RunIO, period: string): string {
  const s = io.style;
  if (rows.length === 0) return `${s.mark('○', 'gray', `Nothing in the ledger ${period}.`)}\n  ${code('Forchetta writes the ledger from the version that brought this command on: earlier work is not in it.', s)}\n`;
  const head = [by.toUpperCase(), 'COST', 'TOKENS', 'TURNS', 'TIME', 'FILES', 'GUARD', 'REVIEWS', 'REQUESTS'];
  const cells = rows.map((row) => [
    row.key,
    usdText(row.usd),
    tokensTotal(row.tokens) > 0 ? shortTokens(tokensTotal(row.tokens)) : '—',
    row.turns ? `${row.turns}${row.failedTurns ? ` (${row.failedTurns} failed)` : ''}` : '—',
    row.ms ? minutes(row.ms) : '—',
    row.files ? String(row.files) : '—',
    row.guard.deny + row.guard.ask + row.guard.note ? `${row.guard.deny} stopped · ${row.guard.ask} asked · ${row.guard.note} notes` : '—',
    row.reviews.approved + row.reviews.changes ? `${row.reviews.approved} ✓ · ${row.reviews.changes} ✗` : '—',
    row.requests ? String(row.requests) : '—',
  ]);
  const sum = (pick: (row: ReportRow) => number): number => rows.reduce((total, row) => total + pick(row), 0);
  const total = [
    'all',
    usdText(sum((row) => row.usd)),
    sum((row) => tokensTotal(row.tokens)) > 0 ? shortTokens(sum((row) => tokensTotal(row.tokens))) : '—',
    String(sum((row) => row.turns)),
    minutes(sum((row) => row.ms)),
    '',
    `${sum((row) => row.guard.deny)} stopped · ${sum((row) => row.guard.ask)} asked · ${sum((row) => row.guard.note)} notes`,
    `${sum((row) => row.reviews.approved)} ✓ · ${sum((row) => row.reviews.changes)} ✗`,
    String(sum((row) => row.requests)),
  ];
  const widths = head.map((title, column) => Math.min(column === 0 ? 34 : 40, Math.max(title.length, ...[...cells, total].map((row) => visibleLength(row[column] ?? '')))));
  const line = (row: readonly string[], paint: (text: string, column: number) => string = (text) => text): string =>
    row
      .map((text, column) => {
        const width = widths[column]!;
        const fitted = text.length > width ? `${text.slice(0, width - 1)}…` : text;
        const padded = column === 0 ? fitted.padEnd(width) : fitted.padStart(width);
        return paint(padded, column);
      })
      .join('  ')
      .trimEnd();
  return [
    line(head, (text) => s.dim(text)),
    ...cells.map((row) => line(row, (text, column) => (column === 0 ? s.bold(text) : text.trim() === '—' ? s.dim(text) : text))),
    line(total, (text) => s.dim(text)),
    '',
    s.dim(`Costs: from the status line of Claude Code, at API prices. Tokens: for the sessions of teams. ${period}.`),
    '',
  ].join('\n');
}

export async function reportCommand(args: readonly string[], io: RunIO, now = Date.now(), dir = join(paths.varDir, 'ledger')): Promise<number> {
  const { positional, values, flags } = parseArgs('report', args, { values: ['--since', '--by', '--team'], flags: ['--json', '--csv'] });
  if (positional.length > 0) throw new UserError(`report takes no ${positional[0]}`, 'see `forchetta report --help`');
  const sinceText = values.get('--since') ?? '7d';
  const since = parseSince(sinceText, now);
  if (since === undefined) throw new UserError(`--since takes 24h, 7d, 4w or a date like 2026-11-01, not "${sinceText}"`);
  const byText = values.get('--by') ?? 'team';
  if (!(REPORT_BY as readonly string[]).includes(byText)) {
    const near = closest(byText, REPORT_BY);
    throw new UserError(`--by is one of ${REPORT_BY.join(', ')}`, near ? `did you mean \`--by ${near}\`?` : undefined);
  }
  const by = byText as ReportBy;
  const team = values.get('--team')?.toLowerCase();
  const entries = readLedger(dir, since, now + 1).filter((entry: LedgerEntry) => !team || ('team' in entry && entry.team?.toLowerCase() === team));
  const rows = report(entries, by);
  if (flags.has('--json')) {
    io.stdout(`${JSON.stringify({ since, until: now, by, rows }, null, 2)}\n`);
    return 0;
  }
  if (flags.has('--csv')) {
    io.stdout(reportCsv(rows, by));
    return 0;
  }
  const from = new Date(since).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  io.stdout(renderReport(rows, by, io, `since ${from}${team ? `, team ${values.get('--team')}` : ''}`));
  return 0;
}
