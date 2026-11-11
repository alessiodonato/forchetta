import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { type Agent, cleanTeam, type TeamInfo } from '../shared/agent.ts';

// Names, groups and roles of the sessions, for the chart of a team of agents. They are set from the box of a
// session and remembered for its folder in var/teams.json: a session that starts again in the same folder (a
// new process, the next day) finds its place in the team again. A session that has its own already keeps it.

export class Teams {
  private byFolder: Record<string, TeamInfo> = {};
  /** The agents already looked up: a team you cleared is not given back. */
  private readonly checked = new Set<string>();

  constructor(
    private readonly file: string | undefined,
    private readonly log: (message: string) => void = () => {},
  ) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const [folder, team] of Object.entries(saved)) {
        const clean = cleanTeam(team);
        if (clean && folder.startsWith('/')) this.byFolder[folder] = clean;
      }
    } catch {
      // No file yet, or one that cannot be read: no team remembered.
    }
  }

  /** Gives a new session the team remembered for its folder. Returns whether it changed the agent. */
  apply(agent: Agent): boolean {
    if (!agent.cwd || this.checked.has(agent.id)) return false;
    this.checked.add(agent.id);
    if (agent.team || agent.state === 'ended') return false;
    const team = this.byFolder[agent.cwd];
    if (!team) return false;
    agent.team = { ...team };
    return true;
  }

  /** From the box: the new team of a session, or none; remembered for its folder. */
  set(agent: Agent, input: unknown): void {
    const team = cleanTeam(input);
    this.checked.add(agent.id);
    const crew = agent.team?.crew;
    if (crew) {
      // A member of a team of agents: name and role can change, its team and how it talks stay. Nothing is
      // remembered for the folder, where the other members live too. "Remove" takes it out of the team.
      const talk = agent.team?.talk;
      agent.team = team ? { ...team, crew, ...(talk ? { talk } : {}) } : undefined;
      return;
    }
    agent.team = team;
    if (!agent.cwd) return;
    if (team) this.byFolder[agent.cwd] = team;
    else delete this.byFolder[agent.cwd];
    this.save();
  }

  /** The groups in use, for the suggestions of the box. */
  groups(agents: Iterable<Agent>): string[] {
    const names = new Set<string>();
    for (const agent of agents) if (agent.team?.group) names.add(agent.team.group);
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) this.checked.delete(id);
  }

  private save(): void {
    if (!this.file) return;
    try {
      const temporary = `${this.file}.${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(this.byFolder, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      this.log(`team non salvati: ${String(error)}`);
    }
  }
}
