import { type Agent, type AgentState, STATE_LABEL } from '../shared/agent.ts';
import { api, runningDaemon } from '../shared/daemon-client.ts';
import { activity, ago, cacheSoon, cacheText, controlLabel, hasEvents, percentText, shortTokens } from '../shared/present.ts';
import { code } from './help.ts';
import type { RunIO } from './run.ts';
import { plain, type Style } from './style.ts';

// `forchetta ls`: the sessions the daemon knows, one line each, with their context (from the status line of Claude
// Code, or estimated by arricurdAI) and cache (from arricurdAI). On a terminal each state has its symbol and, as in
// the app, amber is what waits for you and red what went wrong.

export { activity, ago } from '../shared/present.ts';

const fit = (text: string, width: number): string => (text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`);

/** The symbol of each state, and how it is painted. */
const LOOK: Record<AgentState, { glyph: string; paint: (style: Style) => (text: string) => string }> = {
  starting: { glyph: '◔', paint: () => (text) => text },
  working: { glyph: '●', paint: (style) => style.bold },
  waiting: { glyph: '◆', paint: (style) => style.amber },
  idle: { glyph: '○', paint: (style) => style.dim },
  compacting: { glyph: '◐', paint: () => (text) => text },
  error: { glyph: '✗', paint: (style) => style.red },
  ended: { glyph: '◌', paint: (style) => style.dim },
};

const contextCell = (agent: Agent): string => (agent.context ? `${shortTokens(agent.context.tokens)} ${percentText(agent.context)}` : '—');

export function renderList(agents: readonly Agent[], now: number, width: number, style: Style = plain): string {
  const s = style;
  if (agents.length === 0) return `${s.mark('○', 'gray', 'No Claude Code session running.')}\n${s.color ? `  ${code('Start one with `forchetta run claude`, or from the app.', s)}\n` : ''}`;
  const fixed = { project: 22, state: 13, context: 11, cache: 15, last: 10, control: 12, pid: 6, session: 8 };
  const gaps = 2 * 8;
  const used = Object.values(fixed).reduce((sum, value) => sum + value, 0);
  const flex = Math.max(20, width - used - gaps);
  const row = (cells: string[]): string => cells.join('  ').trimEnd();
  /** A cell padded to its width, then painted: escape codes do not count in the width. */
  const cell = (text: string, size: number, paint: (text: string) => string = (t) => t): string => {
    const fitted = fit(text, size);
    const trimmed = fitted.trimEnd();
    return text === '—' ? s.dim(trimmed) + fitted.slice(trimmed.length) : paint(trimmed) + fitted.slice(trimmed.length);
  };
  const head = (text: string, size?: number): string => (size === undefined ? s.dim(text) : cell(text, size, s.dim));
  const lines = [
    row([
      head('PROJECT', fixed.project),
      head('STATE', fixed.state),
      head('ACTIVITY', flex),
      head('CONTEXT', fixed.context),
      head('CACHE', fixed.cache),
      head('LAST', fixed.last),
      head('CONTROL', fixed.control),
      head('PID', fixed.pid),
      head('SESSION'),
    ]),
  ];
  for (const agent of agents) {
    const look = LOOK[agent.state];
    const paint = look.paint(s);
    const ended = agent.state === 'ended';
    const quiet = ended ? s.dim : (text: string) => text;
    const cache = agent.cache ? cacheText(agent.cache, now).replace(/^cache /, '') : '—';
    const high = (agent.context?.percent ?? 0) >= 80;
    lines.push(
      row([
        cell(agent.project, fixed.project, ended ? s.dim : s.bold),
        cell(s.color ? `${look.glyph} ${STATE_LABEL[agent.state]}` : STATE_LABEL[agent.state], fixed.state, paint),
        cell(activity(agent), flex, agent.state === 'waiting' || agent.state === 'error' ? paint : quiet),
        cell(contextCell(agent), fixed.context, high && !ended ? s.amber : quiet),
        cell(cache, fixed.cache, cacheSoon(agent, now) && !ended ? s.amber : cache === 'expired' ? s.dim : quiet),
        cell(hasEvents(agent) ? ago(now - agent.lastEvent.at) : '—', fixed.last, s.dim),
        cell(controlLabel(agent), fixed.control, agent.control.kind === 'tmux' ? quiet : s.dim),
        cell(agent.pid ? String(agent.pid) : '—', fixed.pid, s.dim),
        agent.sessionId ? s.dim(agent.sessionId.slice(0, 8)) : s.dim('—'),
      ]),
    );
  }
  const live = agents.filter((agent) => agent.state !== 'ended').length;
  const waiting = agents.filter((agent) => agent.state === 'waiting').length;
  const errors = agents.filter((agent) => agent.state === 'error').length;
  const summary = [`${s.bold(String(live))} ${live === 1 ? 'session running' : 'sessions running'}`];
  if (waiting) summary.push(s.amber(`${waiting} ${waiting === 1 ? 'waits for you' : 'wait for you'}`));
  if (errors) summary.push(s.red(`${errors} with an error`));
  lines.push('', summary.join(s.dim(' · ')));
  return `${lines.join('\n')}\n`;
}

export async function listSessions(io: RunIO, options: { json: boolean } = { json: false }): Promise<number> {
  const daemon = await runningDaemon();
  if (!daemon) {
    // With --json stdout stays empty, so that a script reads no half answer: the message goes to stderr.
    const s = options.json ? io.errorStyle : io.style;
    const write = options.json ? io.stderr : io.stdout;
    write(`${s.mark('○', 'gray', 'The Forchetta daemon is not running.')}\n  ${code('Start it with `forchetta daemon start` or `forchetta run claude`.', s)}\n`);
    return 1;
  }
  // fresh=1: the daemon reads `arricurdai status` again before answering, so context and cache are current.
  const { agents, now } = await api<{ agents: Agent[]; now: number }>(daemon, 'GET', '/api/agents?fresh=1', undefined, 30_000);
  // The sessions as the daemon knows them, for jq and scripts: times are milliseconds since 1970.
  if (options.json) io.stdout(`${JSON.stringify(agents, null, 2)}\n`);
  else io.stdout(renderList(agents, now, process.stdout.columns || 160, io.style));
  return 0;
}
