import { type AgentTools, type ToolLimitId, toolLimitById } from './agent-tools.ts';
import { type CrewMemberSpec, type CrewSpec, effectiveWorktree } from './crew.ts';

// What in a team works against itself, seen before it starts: a member that writes and cannot commit, a reviewer
// that cannot see the commits or would fix them itself, a pull request no one can push, a deliverable no one will
// tell you about, two members that write in the same folder at the same time. Warnings, not errors: the team starts
// anyway. Only what follows from its settings, never a guess from the words of a role. The studio, the panel «New
// team», `forchetta team start` and "Describe…" show the same ones. No Node module here: the page uses it too.

export interface TeamCheck {
  /** What does not hold together, and how to fix it: a sentence or two. */
  text: string;
  /** The agents it is about, by name: the lead too; none when it is about the whole team. */
  who: string[];
}

/** What the checks read of a team: a template has it too. */
export type CheckedTeam = Pick<CrewSpec, 'lead' | 'members' | 'worktrees' | 'deliverable'>;

type Agent = { name: string; mode?: string; tools?: AgentTools };

const limited = (agent: Agent, id: ToolLimitId): boolean => agent.tools?.limits?.includes(id) === true;
const label = (id: ToolLimitId): string => `"${toolLimitById(id)?.label ?? id}"`;
/** It changes files: not "read only", not in plan mode. */
const writes = (agent: Agent): boolean => !limited(agent, 'read-only') && agent.mode !== 'plan';
const shell = (agent: Agent): boolean => !limited(agent, 'no-bash');
const pushes = (agent: Agent): boolean => shell(agent) && !limited(agent, 'no-push') && agent.mode !== 'plan';

/** A deliverable that has to be pushed: a pull request, a merge request, a branch pushed. */
const PUSHED_WORDS = /pull request|merge request|\bpush/i;
const PUSHED_SHORT = /\b(PR|MR)s?\b/;
const pushed = (deliverable: string): boolean => PUSHED_WORDS.test(deliverable) || PUSHED_SHORT.test(deliverable);

const quoted = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return `"${line.length > 60 ? `${line.slice(0, 59)}…` : line}"`;
};

/** "a", "a and b", "a, b and c". */
const listed = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** `upper` leads `lower`, directly or through the members between them. */
function leads(members: readonly CrewMemberSpec[], upper: string, lower: CrewMemberSpec): boolean {
  const seen = new Set<string>();
  for (let above = lower.reportsTo; above !== undefined && !seen.has(above); above = members.find((member) => member.name === above)?.reportsTo) {
    if (above === upper) return true;
    seen.add(above);
  }
  return false;
}

/** What does not hold together in a team, in the order of its agents; empty when nothing. */
export function teamChecks(team: CheckedTeam): TeamCheck[] {
  const out: TeamCheck[] = [];
  const lead = team.lead.kind === 'claude' ? team.lead : undefined;
  const agents: Agent[] = [...(lead ? [lead] : []), ...team.members];
  const leaderOf = (member: CrewMemberSpec): string => member.reportsTo ?? lead?.name ?? 'you';

  for (const member of team.members) {
    // In a worktree of its own, what it writes reaches the others only through its commits.
    if (effectiveWorktree(team, member) && writes(member) && !shell(member)) {
      out.push({
        who: [member.name],
        text: `${member.name} writes in a worktree of its own but has ${label('no-bash')}: it cannot commit, so ${leaderOf(member) === 'you' ? 'you never see' : `${leaderOf(member)} never sees`} its work. Take ${label('no-bash')} off, or take it out of the worktree.`,
      });
    }
    if (!member.reviews) continue;
    if (!shell(member)) {
      out.push({ who: [member.name], text: `${member.name} reviews but has ${label('no-bash')}: without git log and git diff it cannot see the commits it should approve. Take ${label('no-bash')} off.` });
    } else if (lead && !agents.some((agent) => agent !== member && writes(agent) && shell(agent))) {
      out.push({ who: [member.name], text: `${member.name} reviews, but no one else in the team can write and commit: it has nothing to review.` });
    }
    if (writes(member)) {
      out.push({ who: [member.name], text: `${member.name} reviews and can also change the files: it may fix the code itself instead of approving it or sending it back. Give it ${label('read-only')}.` });
    }
  }

  const deliverable = team.deliverable?.trim();
  if (deliverable && lead && pushed(deliverable) && !agents.some(pushes)) {
    out.push({
      who: [lead.name],
      text: `The team delivers ${quoted(deliverable)}, but no one in it can git push (${label('no-bash')} or ${label('no-push')} on every agent): it cannot hand it over. Let ${lead.name}, or one member, push.`,
    });
  }
  if (deliverable && !lead) {
    out.push({ who: [], text: `The team delivers ${quoted(deliverable)}, but you lead it: only a Claude lead says when the work is delivered, so no one will tell you. The members still know what it is.` });
  }

  // Two members that change files in the folder of the team, with no files of their own and neither leading the
  // other: they can work at the same time, on the same file. One above the other waits for the one below.
  const sharing = team.members.filter((member) => !effectiveWorktree(team, member) && writes(member) && (member.paths?.length ?? 0) === 0);
  const together = sharing.filter((member) => sharing.some((other) => other !== member && !leads(team.members, member.name, other) && !leads(team.members, other.name, member)));
  if (together.length >= 2) {
    out.push({
      who: together.map((member) => member.name),
      text: `${listed(together.map((member) => member.name))} change files in the folder of the team at the same time, none with files of its own: they can edit the same file at once. Give each its files, or a worktree of its own.`,
    });
  }
  return out;
}

/** What a team made from a description must avoid, for Claude: the checks above, in a sentence. */
export const TEAM_CHECKS_GUIDE =
  'Avoid what Forchetta warns about before a team starts: a member in a worktree of its own that writes but has no-bash (it cannot commit); a reviewer with no-bash (it cannot see the commits) or without read-only (it would fix the code itself); a deliverable to push (a pull request) when no agent can git push; a deliverable when the user leads (no one tells the user it is delivered); two members that write in the folder of the team at the same time, neither leading the other, without worktrees or files of their own (paths).';
