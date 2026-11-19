import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import { CREW_MAX_MEMBERS, CREW_NAME_MAX, type CrewSpec, type CrewTemplate, MEMBER_NAME_MAX, PATH_MAX, PATHS_MAX, pathsText, RELATION_MAX, ROLE_MAX, type Talk, treeOrder } from '../shared/crew.ts';
import { shell } from './connection.ts';
import { lastPart, MODELS, MODES, recentFolders } from './NewSession.tsx';
import type { Store } from './store.ts';

// A new team of agents (shared/crew.ts): a name, a folder, a lead (Claude or you) and its members. For each member
// a name and what it does in a sentence; under it, its relation with the one it reports to: who that is (the lead,
// or another member, so the chart can have more levels), how it talks with it (→ it executes, ⇄ it also answers),
// and the prompt of the relation, how the two work together. "+ report" adds a member under it. The members show
// as the chart will, each under the one it reports to. Model, permissions, worktree, its files and whether it
// reviews wait behind "more". The daemon starts every session in the tmux of Forchetta.

interface MemberDraft {
  key: number;
  name: string;
  role: string;
  /** Undefined: the default of the team. */
  talk?: Talk;
  model: string;
  mode: string;
  /** Undefined: the choice of the team. */
  worktree?: boolean;
  /** Its files, as written: "src/ui/, docs/"; empty for none. */
  paths: string;
  /** It reviews: it approves commits, and the lead merges only those. */
  reviews?: boolean;
  /** The member it reports to, by its key; undefined: the lead. */
  reportsTo?: number;
  /** The prompt of its relation with the one it reports to. */
  relation: string;
  /** Its skills, from a template: the studio changes them, this panel keeps them. */
  skills?: string[];
  more: boolean;
}

export const TALK_TEXT: Record<Talk, string> = { twoway: '⇄ answers', oneway: '→ executes' };
const TALK_TITLE: Record<Talk, string> = {
  twoway: 'When it finishes a request, its final answer goes back to the one it reports to, and it can ask it questions. Click: it only executes.',
  oneway: 'It executes the requests; nothing goes back to the one it reports to. Click: it also answers.',
};

let nextKey = 0;
const member = (name: string, reportsTo?: number): MemberDraft => ({ key: ++nextKey, name, role: '', model: '', mode: '', paths: '', relation: '', more: false, ...(reportsTo !== undefined ? { reportsTo } : {}) });

/** The members as the chart will show them: each one under the one it reports to, with how deep it is. */
export const draftTree = <D extends { key: number; reportsTo?: number }>(drafts: readonly D[]): { item: D; depth: number }[] =>
  treeOrder(drafts, (draft) => draft.key, (draft) => draft.reportsTo);

/** Whether a member is under another one, at any depth: it cannot be the one that other reports to. */
export function isUnder(drafts: readonly Pick<MemberDraft, 'key' | 'reportsTo'>[], key: number, above: number): boolean {
  const seen = new Set<number>();
  for (let at = drafts.find((draft) => draft.key === key)?.reportsTo; at !== undefined && !seen.has(at); at = drafts.find((draft) => draft.key === at)?.reportsTo) {
    if (at === above) return true;
    seen.add(at);
  }
  return false;
}

/** A member taken out: the ones that reported to it now report to the one above it. */
export const withoutDraft = <D extends { key: number; reportsTo?: number }>(drafts: readonly D[], key: number): D[] => {
  const gone = drafts.find((draft) => draft.key === key);
  return drafts
    .filter((draft) => draft.key !== key)
    .map((draft) => {
      if (draft.reportsTo !== key) return draft;
      const { reportsTo: _gone, ...rest } = draft;
      return (gone?.reportsTo !== undefined ? { ...rest, reportsTo: gone.reportsTo } : rest) as D;
    });
};

/** The files of a member as the daemon gets them: the list as written, which it checks. */
const pathsOf = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((path) => path.trim())
    .filter(Boolean);

/** The members of a template as rows of the panel. */
export function draftsOf(template: Pick<CrewTemplate, 'members'>): MemberDraft[] {
  const drafts = template.members.map((spec) => ({
    ...member(spec.name),
    role: spec.role,
    ...(spec.talk ? { talk: spec.talk } : {}),
    model: spec.model ?? '',
    mode: spec.mode ?? '',
    ...(spec.worktree !== undefined ? { worktree: spec.worktree } : {}),
    paths: spec.paths ? pathsText(spec.paths) : '',
    ...(spec.reviews ? { reviews: true } : {}),
    ...(spec.skills ? { skills: [...spec.skills] } : {}),
    relation: spec.relation ?? '',
    more: Boolean(spec.model || spec.mode || spec.worktree !== undefined || spec.paths || spec.reviews || spec.skills),
  }));
  const keyOf = new Map(drafts.map((draft) => [draft.name.toLowerCase(), draft.key]));
  return drafts.map((draft, index) => {
    const above = template.members[index]!.reportsTo;
    const key = above !== undefined ? keyOf.get(above.toLowerCase()) : undefined;
    return key !== undefined && key !== draft.key ? { ...draft, reportsTo: key } : draft;
  });
}

/** The spec the daemon checks, from what the panel holds. */
export function specOf(input: {
  name: string;
  folder: string;
  leadKind: 'claude' | 'you';
  leadName: string;
  leadRole: string;
  leadModel: string;
  leadMode: string;
  leadSkills?: readonly string[];
  talk: Talk;
  worktrees?: boolean;
  members: readonly (Pick<MemberDraft, 'name' | 'role' | 'talk' | 'model' | 'mode' | 'worktree' | 'reviews'> & { paths?: string; key?: number; reportsTo?: number; relation?: string; skills?: readonly string[] })[];
}): CrewSpec {
  const nameOf = new Map(input.members.filter((draft) => draft.key !== undefined).map((draft) => [draft.key!, draft.name.trim()]));
  return {
    name: input.name.trim(),
    cwd: input.folder.trim(),
    lead:
      input.leadKind === 'you'
        ? { kind: 'you' }
        : {
            kind: 'claude',
            name: input.leadName.trim() || 'lead',
            role: input.leadRole.trim(),
            ...(input.leadModel ? { model: input.leadModel } : {}),
            ...(input.leadMode ? { mode: input.leadMode } : {}),
            ...(input.leadSkills && input.leadSkills.length > 0 ? { skills: [...input.leadSkills] } : {}),
          },
    talk: input.talk,
    ...(input.worktrees ? { worktrees: true } : {}),
    members: input.members.map((draft) => ({
      name: draft.name.trim(),
      role: draft.role.trim(),
      ...(draft.talk ? { talk: draft.talk } : {}),
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.mode ? { mode: draft.mode } : {}),
      ...(draft.worktree !== undefined ? { worktree: draft.worktree } : {}),
      ...(draft.paths && pathsOf(draft.paths).length > 0 ? { paths: pathsOf(draft.paths) } : {}),
      ...(draft.reviews ? { reviews: true } : {}),
      ...(draft.reportsTo !== undefined && nameOf.get(draft.reportsTo) ? { reportsTo: nameOf.get(draft.reportsTo) } : {}),
      ...(draft.relation?.trim() ? { relation: draft.relation.trim() } : {}),
      ...(draft.skills && draft.skills.length > 0 ? { skills: [...draft.skills] } : {}),
    })),
  };
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void }) {
  return (
    <label class="spawn-option">
      {label}
      <select value={value} onChange={(event) => onChange((event.target as HTMLSelectElement).value)}>
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

export function NewTeamPanel({ agents, store, onClose, onStudio }: { agents: readonly Agent[]; store: Store; onClose: () => void; onStudio?: () => void }) {
  const recent = useMemo(() => recentFolders(agents), [agents]);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(recent[0] ?? '');
  const [leadKind, setLeadKind] = useState<'claude' | 'you'>('claude');
  const [leadName, setLeadName] = useState('lead');
  const [leadRole, setLeadRole] = useState('');
  const [leadModel, setLeadModel] = useState('');
  const [leadMode, setLeadMode] = useState('');
  // The skills of the lead of a template: the studio changes them, this panel keeps them.
  const [leadSkills, setLeadSkills] = useState<string[]>([]);
  const [talk, setTalk] = useState<Talk>('twoway');
  // Each member in a git worktree of its own: on by default, the members do not touch each other's files.
  const [worktrees, setWorktrees] = useState(true);
  const [members, setMembers] = useState<MemberDraft[]>(() => [member('developer'), member('reviewer')]);
  const first = useRef<HTMLInputElement>(null);
  /** The member just added with "+ report" or "+ member": its name field takes the focus. */
  const added = useRef<number | undefined>(undefined);
  const add = (reportsTo?: number): void => {
    const draft = member('', reportsTo);
    added.current = draft.key;
    setMembers((current) => [...current, draft]);
  };
  const state = store.state.crewSpawn;
  const busy = state?.busy === true;
  const [applied, setApplied] = useState<string | undefined>(undefined);
  // The template whose × was clicked once: the second click deletes it, within a few seconds.
  const [armed, setArmed] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(undefined), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  const saving = store.state.crewEdit?.action === 'saveCrewTemplate' ? store.state.crewEdit : undefined;

  /** Fills the panel with a template: everything but the folder; the name too, unless you wrote your own. */
  const apply = (template: CrewTemplate): void => {
    if (!name.trim() || name === applied) setName(template.name);
    setApplied(template.name);
    setLeadKind(template.lead.kind);
    if (template.lead.kind === 'claude') {
      setLeadName(template.lead.name);
      setLeadRole(template.lead.role);
      setLeadModel(template.lead.model ?? '');
      setLeadMode(template.lead.mode ?? '');
      setLeadSkills(template.lead.skills ?? []);
    } else setLeadSkills([]);
    setTalk(template.talk);
    setWorktrees(template.worktrees === true);
    setMembers(draftsOf(template));
  };

  useEffect(() => {
    first.current?.focus();
    window.forchettaFolder = (path: string) => setFolder(path);
    return () => {
      window.forchettaFolder = undefined;
    };
  }, []);

  // From the list as it is now, not as it was at the last render: two quick changes must both stay.
  const change = (key: number, patch: Partial<MemberDraft>): void => setMembers((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  const ready = name.trim() !== '' && folder.trim() !== '' && members.length > 0 && members.every((draft) => draft.name.trim() !== '');
  const leadLabel = leadKind === 'you' ? 'you' : leadName.trim() || 'lead';
  const nameOf = (key: number | undefined): string => {
    if (key === undefined) return leadLabel;
    const index = members.findIndex((draft) => draft.key === key);
    return members[index]?.name.trim() || `member ${index + 1}`;
  };
  const full = members.length >= CREW_MAX_MEMBERS;
  const create = (): void => {
    if (busy || !ready) return;
    store.createCrew(specOf({ name, folder, leadKind, leadName, leadRole, leadModel, leadMode, leadSkills, talk, worktrees, members }));
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') onClose();
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) create();
  };

  const saveTemplate = (): void => {
    if (!ready && !(name.trim() && members.every((draft) => draft.name.trim()))) return;
    const { cwd: _cwd, ...template } = specOf({ name, folder: folder || '/', leadKind, leadName, leadRole, leadModel, leadMode, leadSkills, talk, worktrees, members });
    store.saveTemplate({ template });
  };

  return (
    <section class="broadcast new-team" aria-label="New team" onKeyDown={onKey}>
      {store.state.templates.length > 0 && (
        <div class="broadcast-row">
          <span class="broadcast-label">Start from</span>
          {store.state.templates.map((template) => (
            <span key={template.name} class="template-chip">
              <button type="button" class={`chip${applied === template.name ? ' on' : ''}`} title={template.members.map((spec) => spec.name).join(', ')} onClick={() => apply(template)}>
                {template.name}
              </button>
              {(!template.builtin || template.modified) &&
                (armed === template.name ? (
                  <button
                    type="button"
                    class="quiet template-delete armed"
                    title={template.builtin ? `Click again to bring back the template "${template.name}" of Forchetta` : `Click again to delete the template "${template.name}"`}
                    onClick={() => store.deleteTemplate(template.name)}
                  >
                    {template.builtin ? 'restore?' : 'delete?'}
                  </button>
                ) : (
                  <button
                    type="button"
                    class="quiet template-delete"
                    title={template.builtin ? `Your version of "${template.name}": bring back the one of Forchetta` : `Delete the template "${template.name}"`}
                    onClick={() => setArmed(template.name)}
                  >
                    {template.builtin ? '↺' : '×'}
                  </button>
                ))}
            </span>
          ))}
        </div>
      )}
      <div class="broadcast-row">
        <span class="broadcast-label">Team</span>
        <input
          ref={first}
          class="command-input"
          type="text"
          value={name}
          maxLength={CREW_NAME_MAX}
          placeholder="checkout"
          spellcheck={false}
          onInput={(event) => setName((event.target as HTMLInputElement).value)}
        />
      </div>
      <div class="broadcast-row">
        <span class="broadcast-label">Folder</span>
        <input class="command-input mono" type="text" value={folder} placeholder="~/projects/app" spellcheck={false} onInput={(event) => setFolder((event.target as HTMLInputElement).value)} />
        {shell() && (
          <button type="button" onClick={() => shell()?.postMessage({ type: 'chooseFolder', folder })}>
            Choose…
          </button>
        )}
      </div>
      {recent.length > 0 && (
        <div class="broadcast-row">
          <span class="broadcast-label" />
          {recent.map((path) => (
            <button key={path} type="button" class={`chip${path === folder ? ' on' : ''}`} title={path} onClick={() => setFolder(path)}>
              {lastPart(path)}
            </button>
          ))}
        </div>
      )}

      <div class="broadcast-row">
        <span class="broadcast-label">Lead</span>
        <span class="view-switch" role="group" aria-label="Who leads">
          <button type="button" class={leadKind === 'claude' ? 'on' : undefined} onClick={() => setLeadKind('claude')}>
            Claude
          </button>
          <button type="button" class={leadKind === 'you' ? 'on' : undefined} onClick={() => setLeadKind('you')}>
            you
          </button>
        </span>
        {leadKind === 'claude' ? (
          <>
            <input
              class="command-input member-name"
              type="text"
              value={leadName}
              maxLength={MEMBER_NAME_MAX}
              placeholder="lead"
              spellcheck={false}
              aria-label="Name of the lead"
              onInput={(event) => setLeadName((event.target as HTMLInputElement).value)}
            />
            <Select label="model" value={leadModel} options={MODELS} onChange={setLeadModel} />
            <Select label="permissions" value={leadMode} options={MODES} onChange={setLeadMode} />
          </>
        ) : (
          <span class="team-hint">You lead: you write to the members, each in its terminal.</span>
        )}
      </div>
      {leadKind === 'claude' && (
        <div class="broadcast-row">
          <span class="broadcast-label" />
          <input
            class="command-input"
            type="text"
            value={leadRole}
            maxLength={ROLE_MAX}
            placeholder="What the lead does (optional): split the goal into requests, follow and check the work"
            onInput={(event) => setLeadRole((event.target as HTMLInputElement).value)}
          />
        </div>
      )}

      <div class="broadcast-row">
        <span class="broadcast-label">Members</span>
        <span class="team-hint">by default</span>
        <span class="view-switch" role="group" aria-label="How the members talk by default">
          {(['twoway', 'oneway'] as const).map((value) => (
            <button key={value} type="button" class={talk === value ? 'on' : undefined} title={value === 'twoway' ? 'By default a member answers the one it reports to' : 'By default a member only executes'} onClick={() => setTalk(value)}>
              {TALK_TEXT[value]}
            </button>
          ))}
        </span>
        <label class="spawn-option" title="Each member works in a git worktree of its own (a copy of the repository, on its own branch), and commits its work; the lead merges the branches. The folder must be in a git repository.">
          <input type="checkbox" checked={worktrees} onChange={() => setWorktrees(!worktrees)} />
          members in own worktree
        </label>
      </div>
      {draftTree(members).map(({ item: draft, depth }, index) => {
        const effective = draft.talk ?? talk;
        const above = nameOf(draft.reportsTo);
        const label = draft.name.trim() || `member ${index + 1}`;
        // Who it can report to: the lead, or a member that is not itself nor under it.
        const options: [string, string][] = [
          ['', leadKind === 'you' ? 'you' : `${leadLabel} (lead)`],
          ...members.filter((other) => other.key !== draft.key && !isUnder(members, other.key, draft.key)).map((other): [string, string] => [String(other.key), nameOf(other.key)]),
        ];
        return (
          <div key={draft.key} class="member" style={{ '--depth': depth }}>
            <div class="broadcast-row">
              <span class="broadcast-label member-index">{index + 1}</span>
              <input
                ref={(element) => {
                  if (element && added.current === draft.key) {
                    added.current = undefined;
                    element.focus();
                  }
                }}
                class="command-input member-name"
                type="text"
                value={draft.name}
                maxLength={MEMBER_NAME_MAX}
                placeholder="name"
                spellcheck={false}
                aria-label={`Name of member ${index + 1}`}
                onInput={(event) => change(draft.key, { name: (event.target as HTMLInputElement).value })}
              />
              <input
                class="command-input member-role"
                type="text"
                value={draft.role}
                maxLength={ROLE_MAX}
                placeholder="What it does, in a sentence: writes and runs the tests of what it is asked"
                aria-label={`Role of ${label}`}
                onInput={(event) => change(draft.key, { role: (event.target as HTMLInputElement).value })}
              />
              <button type="button" class="quiet" disabled={full} title={full ? `${CREW_MAX_MEMBERS} members at most` : `Add a member that reports to ${label}: ${label} leads it, gives it requests and gets its answers`} onClick={() => add(draft.key)}>
                + report
              </button>
              <button type="button" class={`quiet${draft.more ? ' on' : ''}`} title="Model, permissions, worktree, its files, review" onClick={() => change(draft.key, { more: !draft.more })}>
                more
              </button>
              <button
                type="button"
                class="quiet"
                title="Remove this member: the ones that report to it go up to the one above it"
                disabled={members.length === 1}
                onClick={() => setMembers((current) => withoutDraft(current, draft.key))}
              >
                ×
              </button>
            </div>
            <div class="broadcast-row member-relation">
              <span class="broadcast-label" />
              <span class="relation-arrow" aria-hidden="true">
                ↳
              </span>
              <Select label="reports to" value={draft.reportsTo === undefined ? '' : String(draft.reportsTo)} options={options} onChange={(value) => change(draft.key, { reportsTo: value ? Number(value) : undefined })} />
              <button
                type="button"
                class={`talk-toggle${draft.talk ? ' chosen' : ''}`}
                data-talk={effective}
                title={TALK_TITLE[effective]}
                onClick={() => change(draft.key, { talk: (draft.talk ?? talk) === 'twoway' ? 'oneway' : 'twoway' })}
              >
                {TALK_TEXT[effective]}
              </button>
              <input
                class="command-input member-relation-prompt"
                type="text"
                value={draft.relation}
                maxLength={RELATION_MAX}
                placeholder={`How ${label} works with ${above} (optional): what ${above} asks, what comes back, when to ask`}
                aria-label={`How ${label} works with ${above}`}
                title={`The prompt of this relation: both ${label} and ${above} read it in their system prompt.`}
                onInput={(event) => change(draft.key, { relation: (event.target as HTMLInputElement).value })}
              />
            </div>
            {draft.more && (
              <div class="broadcast-row">
                <span class="broadcast-label" />
                <Select label="model" value={draft.model} options={MODELS} onChange={(value) => change(draft.key, { model: value })} />
                <Select label="permissions" value={draft.mode} options={MODES} onChange={(value) => change(draft.key, { mode: value })} />
                <label class="spawn-option" title="Claude Code creates a new git worktree for this member: it works on a copy, on its own branch, without touching the files of the others">
                  <input type="checkbox" checked={draft.worktree ?? worktrees} onChange={() => change(draft.key, { worktree: !(draft.worktree ?? worktrees) })} />
                  own worktree
                </label>
                <label
                  class="spawn-option"
                  title="It reviews the work of the others: it approves a commit, or asks for changes, with a tool of the team. The lead merges a branch only up to what it approved: before a git merge of anything else, Forchetta asks you."
                >
                  <input type="checkbox" checked={draft.reviews === true} onChange={() => change(draft.key, { reviews: !draft.reviews })} />
                  reviews
                </label>
              </div>
            )}
            {draft.more && draft.skills && draft.skills.length > 0 && (
              <div class="broadcast-row">
                <span class="broadcast-label" />
                <span class="team-hint" title="Open-source skills of Claude Code, downloaded when the team starts, outside the project. Change them in the studio.">
                  skills: {draft.skills.join(', ')}
                </span>
              </div>
            )}
            {draft.more && (
              <div class="broadcast-row">
                <span class="broadcast-label" />
                <input
                  class="command-input mono member-files"
                  type="text"
                  value={draft.paths}
                  maxLength={PATHS_MAX * (PATH_MAX + 2)}
                  placeholder="Its files (optional): src/ui/, *.css — it changes only these, and the others stay off them"
                  spellcheck={false}
                  aria-label={`Files of ${label}`}
                  title="Relative to the folder of the team: folders (src/ui/), files, or patterns (*.test.ts, docs/**). The guard stops its edits of other files, and the edits of the other members here. Empty: any file no other member has."
                  onInput={(event) => change(draft.key, { paths: (event.target as HTMLInputElement).value })}
                />
              </div>
            )}
          </div>
        );
      })}
      <div class="broadcast-row">
        <span class="broadcast-label" />
        <button type="button" disabled={full} title={`Add a member that reports to ${leadLabel}`} onClick={() => add()}>
          + member
        </button>
        <span class="team-hint">To add levels, "+ report" puts a member under another one, who leads it.</span>
        {onStudio && (
          <button type="button" class="quiet" title="Draw the team on a canvas: agents and teams to drag, arrows between them" onClick={onStudio}>
            or draw it in the studio
          </button>
        )}
      </div>

      <div class="broadcast-row end">
        <span class={`broadcast-note${state?.error || saving?.error ? ' error' : ''}`}>
          {state?.error ??
            saving?.error ??
            (saving?.ok ? `Saved as the template "${name.trim()}": it is in "Start from".` : 'Each one starts in the tmux of Forchetta, in the folder of the team, knowing its role and its lead. ⌘↩ creates it.')}
        </span>
        <button type="button" class="quiet" title="Keep this team, without its folder, to start it again from 'Start from'" disabled={!name.trim() || members.some((draft) => !draft.name.trim())} onClick={saveTemplate}>
          Save as template
        </button>
        <button type="button" class="primary" disabled={busy || !ready} onClick={create}>
          {busy ? 'Starting…' : 'Create team'}
        </button>
        <button type="button" class="quiet" onClick={onClose}>
          {state?.createdId ? 'Close' : 'Cancel'}
        </button>
      </div>
    </section>
  );
}
