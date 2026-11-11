import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Agent, TEAM_TEXT_MAX } from '../shared/agent.ts';
import type { CrewSummary } from '../shared/crew.ts';
import type { Store } from './store.ts';

// Names, groups and roles: a team of agents seen as a chart. The box sets them (TeamEditor); the daemon keeps
// them, also for the folder of the session (daemon/teams.ts). The chart shows each group with its heads above
// and the others below.

/**
 * "lead · revisione", "lead", "revisione": the role in the head of a box, "lead" first so that a long role cut short
 * still says it. A member of a team of agents shows how it talks with its lead first: "⇄ tests", "→ formats".
 */
export function roleText(agent: Agent): string | undefined {
  const team = agent.team;
  if (!team) return undefined;
  if (team.role && team.lead) return `lead · ${team.role}`;
  if (team.lead) return 'lead';
  const talk = team.talk === 'twoway' ? '⇄' : team.talk === 'oneway' ? '→' : undefined;
  if (talk) return team.role ? `${talk} ${team.role}` : talk;
  return team.role;
}

export interface Group {
  /** Undefined: the sessions with no group. */
  name?: string;
  leads: Agent[];
  members: Agent[];
  /** The team of agents of its sessions, when they were started as one. */
  crew?: string;
}

/** The groups in alphabetical order, the sessions with no group last; in each, the heads apart. */
export function groupsOf(agents: readonly Agent[]): Group[] {
  const byName = new Map<string | undefined, Group>();
  for (const agent of agents) {
    const name = agent.team?.group;
    let group = byName.get(name);
    if (!group) {
      group = { name, leads: [], members: [] };
      byName.set(name, group);
    }
    group.crew ??= agent.team?.crew;
    (agent.team?.lead ? group.leads : group.members).push(agent);
  }
  return [...byName.values()].sort((a, b) => (a.name === undefined ? 1 : b.name === undefined ? -1 : a.name.localeCompare(b.name)));
}

export const hasGroups = (agents: readonly Agent[]): boolean => agents.some((agent) => agent.team?.group !== undefined);

const stop = (event: Event): void => event.stopPropagation();

export function TeamEditor({ agent, agents, store, onClose }: { agent: Agent; agents: readonly Agent[]; store: Store; onClose: () => void }) {
  const [label, setLabel] = useState(agent.team?.label ?? '');
  const [group, setGroup] = useState(agent.team?.group ?? '');
  const [role, setRole] = useState(agent.team?.role ?? '');
  const [lead, setLead] = useState(agent.team?.lead === true);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const groups = useMemo(() => [...new Set(agents.map((other) => other.team?.group).filter((name): name is string => !!name))].sort(), [agents]);
  const roles = useMemo(() => [...new Set(agents.map((other) => other.team?.role).filter((name): name is string => !!name))].sort(), [agents]);
  const listId = `team-${agent.id}`;

  const save = (): void => {
    store.setTeam(agent.id, { label, group, role, lead });
    onClose();
  };
  const onKey = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === 'Enter') save();
    if (event.key === 'Escape') onClose();
  };
  const field = (name: string, value: string, set: (value: string) => void, placeholder: string, list?: string, ref?: typeof first) => (
    <label class="team-field">
      <span>{name}</span>
      <input
        ref={ref}
        class="command-input"
        type="text"
        value={value}
        maxLength={TEAM_TEXT_MAX}
        placeholder={placeholder}
        list={list}
        spellcheck={false}
        onInput={(event) => set((event.target as HTMLInputElement).value)}
        onKeyDown={onKey}
      />
    </label>
  );

  return (
    <div class="team-editor" onClick={stop} onMouseDown={stop}>
      {field('Name', label, setLabel, agent.project, undefined, first)}
      {field('Group', group, setGroup, 'none', `${listId}-groups`)}
      {field('Role', role, setRole, 'none', `${listId}-roles`)}
      <datalist id={`${listId}-groups`}>
        {groups.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id={`${listId}-roles`}>
        {roles.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <label class="team-lead" title={group.trim() ? undefined : 'Choose a group first'}>
        <input type="checkbox" checked={lead && group.trim() !== ''} disabled={group.trim() === ''} onChange={() => setLead(!lead)} />
        lead of the group
      </label>
      <div class="team-actions">
        <span class="team-note">Also remembered for its folder.</span>
        {agent.team && (
          <button
            type="button"
            class="quiet"
            onClick={() => {
              store.setTeam(agent.id, undefined);
              onClose();
            }}
          >
            Remove
          </button>
        )}
        <button type="button" class="quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="button" class="primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

/** Whether the lead of a group is you: a team of agents started with no Claude lead. */
export const ledByYou = (group: Group, crews: readonly CrewSummary[]): boolean =>
  group.crew !== undefined && crews.some((crew) => crew.id === group.crew && crew.lead === undefined);

/** The chart: one section per group, its heads above, the others below. A team led by you has you on top. */
export function OrgChart({ agents, crews = [], render }: { agents: readonly Agent[]; crews?: readonly CrewSummary[]; render: (agent: Agent) => preact.ComponentChild }) {
  const groups = groupsOf(agents);
  return (
    <main class="org">
      {groups.map((group) => {
        const you = ledByYou(group, crews);
        return (
          <section key={group.name ?? ''} class="org-group" data-linked={(group.leads.length > 0 || you) && group.members.length > 0 ? '' : undefined}>
            <h3 class="org-title">
              {group.name ?? 'No group'}
              <span class="org-count">{group.leads.length + group.members.length}</span>
            </h3>
            {(group.leads.length > 0 || you) && (
              <div class="org-leads">
                {you && (
                  <div class="org-you" title="You lead this team: you write to the members">
                    you <span>· lead</span>
                  </div>
                )}
                {group.leads.map(render)}
              </div>
            )}
            {group.members.length > 0 && <div class="org-members">{group.members.map(render)}</div>}
          </section>
        );
      })}
    </main>
  );
}

