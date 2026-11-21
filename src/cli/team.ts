import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { STATE_LABEL } from '../shared/agent.ts';
import { api, apiAnswer, type DaemonInfo, runningDaemon } from '../shared/daemon-client.ts';
import { UserError } from '../shared/errors.ts';
import { usdText } from '../shared/present.ts';
import { parseTeamFile } from '../shared/team-file.ts';
import { REPO_DIR, repoTeamFiles } from '../daemon/repo-config.ts';
import type { TeamLine } from '../daemon/cli-api.ts';
import type { SkillToFetch } from '../daemon/team-files.ts';
import { parseArgs } from './args.ts';
import { closest, code } from './help.ts';
import { ask } from './hooks.ts';
import type { RunIO } from './run.ts';
import { tildify } from './style.ts';

// `forchetta team`: the teams from the command line, and from the repository. A team file in .forchetta/teams of
// the repository (written by Export in the studio, or by `forchetta team export`) is reviewed and shared like the
// code; `forchetta team start <name> --goal "…"` starts it, from a script too.

/** The root of the git repository of a folder (where .git is), or the folder itself outside git. */
export function repoRoot(dir: string): string {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return resolve(dir);
  }
}

async function daemon(): Promise<DaemonInfo> {
  const info = await runningDaemon();
  if (!info) throw new UserError('the Forchetta daemon is not running', 'start it with `forchetta daemon start`, or open the app');
  // A daemon from before these routes: said, instead of a 404.
  try {
    await api(info, 'GET', '/api/templates');
  } catch {
    throw new UserError('the daemon that runs is older than this command', 'restart it: `forchetta daemon stop && forchetta daemon start` (the sessions go on)');
  }
  return info;
}

/** What `team start` was given: a file (a path, or a name in .forchetta/teams), or the name of a template. */
export function findTeamSource(arg: string, cwd: string): { text: string; path: string } | { template: string } {
  const asPath = resolve(cwd, arg);
  if ((arg.includes('/') || arg.endsWith('.json')) && existsSync(asPath) && statSync(asPath).isFile()) return { text: readFileSync(asPath, 'utf8'), path: asPath };
  const files = repoTeamFiles(repoRoot(cwd));
  const wanted = arg.toLowerCase().replace(/\.forchetta-team\.json$/, '');
  const byKey = files.find((file) => file.key.toLowerCase() === wanted);
  const byName =
    byKey ??
    files.find((file) => {
      const parsed = parseTeamFile(file.text);
      return 'file' in parsed && typeof parsed.file.template.name === 'string' && parsed.file.template.name.toLowerCase() === arg.toLowerCase();
    });
  return byName ? { text: byName.text, path: byName.path } : { template: arg };
}

function stateMark(state: string | undefined, io: RunIO): string {
  const s = io.style;
  switch (state) {
    case 'working':
      return s.bold('●');
    case 'waiting':
      return s.amber('◆');
    case 'error':
      return s.red('✗');
    case 'ended':
    case undefined:
      return s.dim('◌');
    default:
      return s.dim('○');
  }
}

/** The teams as `forchetta team ls` writes them: a line for the team, one for each session. */
export function renderTeams(teams: readonly TeamLine[], io: RunIO, width = 120): string {
  const s = io.style;
  if (teams.length === 0) return `${s.mark('○', 'gray', 'No team running.')}\n  ${code('Start one with `forchetta team start <template> --goal "…"`, or from the app.', s)}\n`;
  const lines: string[] = [];
  for (const team of teams) {
    const cost = team.budgetUsd ? `${usdText(team.usd)} of ${usdText(team.budgetUsd)}` : usdText(team.usd);
    const over = team.budgetUsd !== undefined && team.usd >= team.budgetUsd;
    const requests = `${team.requests.total} ${team.requests.total === 1 ? 'request' : 'requests'}${team.requests.open ? `, ${team.requests.open} open` : ''}`;
    lines.push(`${s.bold(team.name)}  ${s.dim(tildify(team.cwd))}  ${s.dim('·')} ${requests} ${s.dim('·')} ${over ? s.amber(`${cost} — over its budget`) : cost}`);
    const nameWidth = Math.max(...team.members.map((member) => member.name.length + (member.lead ? 7 : 0)), 4);
    for (const member of team.members) {
      const name = `${member.name}${member.lead ? ' (lead)' : ''}`.padEnd(nameWidth);
      const state = (member.state ? STATE_LABEL[member.state] : 'stopped').padEnd(10);
      const room = Math.max(10, width - nameWidth - 20);
      const what = member.activity ? (member.activity.length > room ? `${member.activity.slice(0, room - 1)}…` : member.activity) : '';
      lines.push(`  ${stateMark(member.state, io)} ${name}  ${s.dim(state)} ${what}`.trimEnd());
    }
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

async function listTeams(args: readonly string[], io: RunIO): Promise<number> {
  const { flags } = parseArgs('team ls', args, { flags: ['--json', '--templates'] });
  const info = await daemon();
  if (flags.has('--templates')) {
    const { templates } = await api<{ templates: { name: string; members: number; lead: string; builtin?: boolean; modified?: boolean }[] }>(info, 'GET', '/api/templates');
    const root = repoRoot(process.cwd());
    const files = repoTeamFiles(root).map((file) => {
      const parsed = parseTeamFile(file.text);
      return { key: file.key, path: file.path, name: 'file' in parsed ? parsed.file.template.name : undefined, error: 'error' in parsed ? parsed.error : undefined };
    });
    if (flags.has('--json')) {
      io.stdout(`${JSON.stringify({ repository: files.map((file) => ({ key: file.key, name: file.name, path: file.path, ...(file.error ? { error: file.error } : {}) })), templates }, null, 2)}\n`);
      return 0;
    }
    const s = io.style;
    if (files.length > 0) {
      io.stdout(`${s.bold(`In ${tildify(join(root, REPO_DIR, 'teams'))}`)}\n`);
      for (const file of files) io.stdout(`  ${s.claude(file.key)}${file.name && file.name.toLowerCase() !== file.key.toLowerCase() ? s.dim(`  "${file.name}"`) : ''}${file.error ? s.red(`  ${file.error}`) : ''}\n`);
      io.stdout('\n');
    }
    io.stdout(`${s.bold('Templates')}\n`);
    for (const template of templates) {
      const tag = template.builtin ? (template.modified ? 'yours, from Forchetta' : 'Forchetta') : 'yours';
      io.stdout(`  ${s.claude(template.name)}  ${s.dim(`${template.members} ${template.members === 1 ? 'member' : 'members'}, lead ${template.lead} · ${tag}`)}\n`);
    }
    return 0;
  }
  const { teams } = await api<{ teams: TeamLine[] }>(info, 'GET', '/api/teams');
  if (flags.has('--json')) io.stdout(`${JSON.stringify(teams, null, 2)}\n`);
  else io.stdout(renderTeams(teams, io, process.stdout.columns || 120));
  return 0;
}

type StartAnswer =
  | { ok: true; ask: SkillToFetch[] }
  | { ok: true; crewId: string; name: string; agentIds: string[]; notes: string[]; warning?: string; checks?: string[]; goal?: { n: number; to: string[] }; goalError?: string }
  | { ok: false; error: string };

/**
 * The values of the parameters of a team, from `--set ticket=APP-123` (as many as it has), taken out of the
 * arguments; the rest of them as they were.
 */
export function takeValues(args: readonly string[]): { rest: string[]; values: Record<string, string> } {
  const rest: string[] = [];
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      rest.push(...args.slice(index));
      break;
    }
    if (arg !== '--set' && !arg.startsWith('--set=')) {
      rest.push(arg);
      continue;
    }
    const pair = arg === '--set' ? args[++index] : arg.slice('--set='.length);
    const equals = pair?.indexOf('=') ?? -1;
    if (!pair || equals <= 0) throw new UserError('--set takes a parameter and its value: --set ticket=APP-123');
    values[pair.slice(0, equals).trim().replace(/^\{|\}$/g, '')] = pair.slice(equals + 1);
  }
  return { rest, values };
}

async function startTeam(all: readonly string[], io: RunIO): Promise<number> {
  const { rest: args, values: params } = takeValues(all);
  const { positional, values, flags } = parseArgs('team start', args, { values: ['--goal', '--cwd', '--name', '--budget', '--skills'], flags: ['--json'] });
  const what = positional[0];
  if (!what || positional.length > 1) throw new UserError(what ? 'team start takes one team: put the goal in --goal "…"' : 'say which team to start', 'see `forchetta team ls --templates`');
  const skills = values.get('--skills');
  if (skills !== undefined && skills !== 'fetch' && skills !== 'skip') throw new UserError('--skills is fetch or skip');
  const cwd = resolve(values.get('--cwd') ?? process.cwd());
  const source = findTeamSource(what, process.cwd());
  const info = await daemon();
  const s = io.style;
  const body: Record<string, unknown> = {
    cwd,
    ...('text' in source ? { text: source.text } : { template: source.template }),
    ...(values.has('--goal') ? { goal: values.get('--goal') } : {}),
    ...(values.has('--name') ? { name: values.get('--name') } : {}),
    ...(values.has('--budget') ? { budgetUsd: values.get('--budget') } : {}),
    ...(skills ? { skills } : {}),
    ...(Object.keys(params).length > 0 ? { values: params } : {}),
  };
  // Starting the sessions and fetching skills can take a while.
  const send = (): Promise<StartAnswer> => apiAnswer<StartAnswer>(info, 'POST', '/api/teams/start', body, 120_000);
  let answer = await send();
  if (answer.ok && 'ask' in answer) {
    io.stdout(`${s.mark('▲', 'amber', 'This team brings skills from GitHub: code someone else chose, fetched at its commit.')}\n`);
    for (const skill of answer.ask) io.stdout(`  ${s.claude(skill.id)}  ${s.dim(`https://github.com/${skill.repo}/tree/${skill.commit}/${skill.path}`)}\n`);
    let choice: 'fetch' | 'skip';
    if (!process.stdin.isTTY) {
      throw new UserError('look at them, then say what to do', `run it again with \`--skills fetch\` (fetch them) or \`--skills skip\` (start without them)`);
    }
    const reply = await ask('Fetch them?', '[y = fetch, n = start without them, anything else = cancel]', io);
    if (reply === 'y' || reply === 'yes') choice = 'fetch';
    else if (reply === 'n' || reply === 'no') choice = 'skip';
    else {
      io.stdout(`${s.mark('○', 'gray', 'Nothing started.')}\n`);
      return 1;
    }
    body.skills = choice;
    answer = await send();
  }
  if (!answer.ok) {
    const hint = /already exists/.test(answer.error) ? 'give it another name with `--name "…"`' : /no template is called/.test(answer.error) ? 'see `forchetta team ls --templates`' : undefined;
    throw new UserError(answer.error.replace(/: see `[^`]+`$/, ''), hint);
  }
  if ('ask' in answer) throw new UserError('the daemon asked again about the skills');
  if (flags.has('--json')) {
    io.stdout(`${JSON.stringify(answer, null, 2)}\n`);
    return answer.goalError ? 1 : 0;
  }
  const from = 'text' in source ? ` from ${tildify(source.path)}` : '';
  io.stdout(`${s.mark('✓', 'green', `Team ${s.bold(answer.name)} started in ${tildify(cwd)}${s.dim(from)}: ${answer.agentIds.length} ${answer.agentIds.length === 1 ? 'session' : 'sessions'}.`)}\n`);
  for (const note of answer.notes) io.stdout(`  ${s.dim('·')} ${note}\n`);
  if (answer.warning) io.stdout(`${s.mark('▲', 'amber', answer.warning)}\n`);
  // What does not hold together in the team: it started anyway.
  for (const check of answer.checks ?? []) io.stdout(`${s.mark('▲', 'amber', check)}\n`);
  if (answer.goal) io.stdout(`${s.mark('→', 'claude', `Goal sent to ${answer.goal.to.join(', ')} (request #${answer.goal.n}).`)}\n`);
  if (answer.goalError) io.stdout(`${s.mark('✗', 'red', `The goal was not sent: ${answer.goalError}`)}\n`);
  io.stdout(`  ${code('Follow it in the app, or with `forchetta team ls`.', s)}\n`);
  return answer.goalError ? 1 : 0;
}

async function exportTeam(args: readonly string[], io: RunIO): Promise<number> {
  const { positional, values, flags } = parseArgs('team export', args, { values: ['--out'], flags: ['--stdout', '--force'] });
  const name = positional.join(' ').trim();
  if (!name) throw new UserError('say which template or team to export', 'see `forchetta team ls --templates`');
  const info = await daemon();
  let file: { name: string; fileName: string; text: string };
  try {
    file = await api<{ name: string; fileName: string; text: string }>(info, 'GET', `/api/templates/file?name=${encodeURIComponent(name)}`);
  } catch {
    throw new UserError(`no template and no team is called "${name}"`, 'see `forchetta team ls --templates` and `forchetta team ls`');
  }
  if (flags.has('--stdout')) {
    io.stdout(file.text);
    return 0;
  }
  const out = values.get('--out');
  const target = out ? (out.endsWith('.json') ? resolve(out) : join(resolve(out), file.fileName)) : join(repoRoot(process.cwd()), REPO_DIR, 'teams', file.fileName);
  if (existsSync(target) && !flags.has('--force')) throw new UserError(`${tildify(target)} is already there`, 'add `--force` to write over it');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.text, { mode: 0o644 });
  const s = io.style;
  io.stdout(`${s.mark('✓', 'green', `${s.bold(file.name)} written to ${tildify(target)}`)}\n`);
  if (!out) io.stdout(`  ${code(`Commit it with the code; start it with \`forchetta team start ${file.fileName.replace(/\.forchetta-team\.json$/, '')}\`.`, s)}\n`);
  return 0;
}

async function teamThread(args: readonly string[], io: RunIO): Promise<number> {
  const { positional, flags } = parseArgs('team thread', args, { flags: ['--json'] });
  const name = positional.join(' ').trim();
  if (!name) throw new UserError('say which team', 'see `forchetta team ls`');
  const info = await daemon();
  let thread: { markdown: string; requests: unknown[]; reviews: unknown[]; team: string };
  try {
    thread = await api(info, 'GET', `/api/teams/thread?team=${encodeURIComponent(name)}`);
  } catch {
    throw new UserError(`no team is called "${name}"`, 'see `forchetta team ls`');
  }
  io.stdout(flags.has('--json') ? `${JSON.stringify({ team: thread.team, requests: thread.requests, reviews: thread.reviews }, null, 2)}\n` : thread.markdown);
  return 0;
}

export const TEAM_ACTIONS = ['ls', 'start', 'export', 'thread'] as const;

export async function teamCommand(args: readonly string[], io: RunIO): Promise<number> {
  const [action, ...rest] = args;
  switch (action) {
    case 'ls':
      return listTeams(rest, io);
    case 'start':
      return startTeam(rest, io);
    case 'export':
      return exportTeam(rest, io);
    case 'thread':
      return teamThread(rest, io);
    case undefined:
      return listTeams([], io);
    default: {
      const near = closest(action, TEAM_ACTIONS);
      throw new UserError(`unknown action "${action}" for team`, near ? `did you mean \`forchetta team ${near}\`?` : 'see `forchetta team --help`');
    }
  }
}
