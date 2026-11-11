import { type Agent, STATE_LABEL } from '../shared/agent.ts';
import { api, runningDaemon } from '../shared/daemon-client.ts';
import { activity, ago, cacheText, controlLabel, hasEvents, percentText, shortTokens } from '../shared/present.ts';
import type { RunIO } from './run.ts';

// `forchetta ls`: the sessions the daemon knows, one line each, with context and cache from arricurdAI.

export { activity, ago } from '../shared/present.ts';

const fit = (text: string, width: number): string => (text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`);

const COLORS: Partial<Record<Agent['state'], string>> = {
  waiting: '\u001b[38;5;214m',
  error: '\u001b[31m',
  working: '\u001b[1m',
  ended: '\u001b[2m',
};

const contextCell = (agent: Agent): string => (agent.context ? `${shortTokens(agent.context.tokens)} ${percentText(agent.context)}` : '—');

export function renderList(agents: readonly Agent[], now: number, width: number, color: boolean): string {
  if (agents.length === 0) return 'No Claude Code session running.\n';
  const fixed = { project: 22, state: 13, context: 11, cache: 15, last: 9, control: 12, pid: 6, session: 8 };
  const gaps = 2 * 8;
  const used = Object.values(fixed).reduce((sum, value) => sum + value, 0);
  const flex = Math.max(20, width - used - gaps);
  const row = (cells: string[]): string => cells.join('  ').trimEnd();
  const lines = [
    row([
      fit('PROJECT', fixed.project),
      fit('STATE', fixed.state),
      fit('ACTIVITY', flex),
      fit('CONTEXT', fixed.context),
      fit('CACHE', fixed.cache),
      fit('LAST', fixed.last),
      fit('CONTROL', fixed.control),
      fit('PID', fixed.pid),
      'SESSION',
    ]),
  ];
  for (const agent of agents) {
    const state = fit(STATE_LABEL[agent.state], fixed.state);
    const paint = color && COLORS[agent.state];
    lines.push(
      row([
        fit(agent.project, fixed.project),
        paint ? `${paint}${state}\u001b[0m` : state,
        fit(activity(agent), flex),
        fit(contextCell(agent), fixed.context),
        fit(agent.cache ? cacheText(agent.cache, now).replace(/^cache /, '') : '—', fixed.cache),
        fit(hasEvents(agent) ? ago(now - agent.lastEvent.at) : '—', fixed.last),
        fit(controlLabel(agent), fixed.control),
        fit(agent.pid ? String(agent.pid) : '—', fixed.pid),
        agent.sessionId ? agent.sessionId.slice(0, 8) : '—',
      ]),
    );
  }
  const live = agents.filter((agent) => agent.state !== 'ended').length;
  const waiting = agents.filter((agent) => agent.state === 'waiting').length;
  lines.push('', `${live} ${live === 1 ? 'session running' : 'sessions running'}${waiting ? ` · ${waiting} ${waiting === 1 ? 'waits for you' : 'wait for you'}` : ''}`);
  return `${lines.join('\n')}\n`;
}

export async function listSessions(io: RunIO): Promise<number> {
  const daemon = await runningDaemon();
  if (!daemon) {
    io.stdout('The Forchetta daemon is not running. Start it with "forchetta daemon start" or "forchetta run claude".\n');
    return 1;
  }
  // fresh=1: the daemon reads `arricurdai status` again before answering, so context and cache are current.
  const { agents, now } = await api<{ agents: Agent[]; now: number }>(daemon, 'GET', '/api/agents?fresh=1', undefined, 30_000);
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  io.stdout(renderList(agents, now, process.stdout.columns || 160, color));
  return 0;
}
