import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import { CREW_MAX_MEMBERS, CREW_NAME_MAX, type CrewSpec, type CrewTemplate, MEMBER_NAME_MAX, ROLE_MAX, type Talk } from '../shared/crew.ts';
import { shell } from './connection.ts';
import { lastPart, MODELS, MODES, recentFolders } from './NewSession.tsx';
import type { Store } from './store.ts';

// A new team of agents (shared/crew.ts): a name, a folder, a lead (Claude or you) and its members. For each member
// a name, what it does in a sentence, and how it talks with the lead: → it executes, ⇄ it also answers. Model,
// permissions and worktree wait behind "more". The daemon starts every session in the tmux of Forchetta.

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
  more: boolean;
}

export const TALK_TEXT: Record<Talk, string> = { twoway: '⇄ answers', oneway: '→ executes' };
const TALK_TITLE: Record<Talk, string> = {
  twoway: 'When it finishes a request, its final answer goes back to the lead. Click: it only executes.',
  oneway: 'It executes the requests; nothing goes back to the lead. Click: it also answers.',
};

let nextKey = 0;
const member = (name: string): MemberDraft => ({ key: ++nextKey, name, role: '', model: '', mode: '', more: false });

/** The members of a template as rows of the panel. */
export const draftsOf = (template: Pick<CrewTemplate, 'members'>): MemberDraft[] =>
  template.members.map((spec) => ({
    ...member(spec.name),
    role: spec.role,
    ...(spec.talk ? { talk: spec.talk } : {}),
    model: spec.model ?? '',
    mode: spec.mode ?? '',
    ...(spec.worktree !== undefined ? { worktree: spec.worktree } : {}),
    more: Boolean(spec.model || spec.mode || spec.worktree !== undefined),
  }));

/** The spec the daemon checks, from what the panel holds. */
export function specOf(input: {
  name: string;
  folder: string;
  leadKind: 'claude' | 'you';
  leadName: string;
  leadRole: string;
  leadModel: string;
  leadMode: string;
  talk: Talk;
  worktrees?: boolean;
  members: readonly Pick<MemberDraft, 'name' | 'role' | 'talk' | 'model' | 'mode' | 'worktree'>[];
}): CrewSpec {
  return {
    name: input.name.trim(),
    cwd: input.folder.trim(),
    lead:
      input.leadKind === 'you'
        ? { kind: 'you' }
        : { kind: 'claude', name: input.leadName.trim() || 'lead', role: input.leadRole.trim(), ...(input.leadModel ? { model: input.leadModel } : {}), ...(input.leadMode ? { mode: input.leadMode } : {}) },
    talk: input.talk,
    ...(input.worktrees ? { worktrees: true } : {}),
    members: input.members.map((draft) => ({
      name: draft.name.trim(),
      role: draft.role.trim(),
      ...(draft.talk ? { talk: draft.talk } : {}),
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.mode ? { mode: draft.mode } : {}),
      ...(draft.worktree !== undefined ? { worktree: draft.worktree } : {}),
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

export function NewTeamPanel({ agents, store, onClose }: { agents: readonly Agent[]; store: Store; onClose: () => void }) {
  const recent = useMemo(() => recentFolders(agents), [agents]);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(recent[0] ?? '');
  const [leadKind, setLeadKind] = useState<'claude' | 'you'>('claude');
  const [leadName, setLeadName] = useState('lead');
  const [leadRole, setLeadRole] = useState('');
  const [leadModel, setLeadModel] = useState('');
  const [leadMode, setLeadMode] = useState('');
  const [talk, setTalk] = useState<Talk>('twoway');
  // Each member in a git worktree of its own: on by default, the members do not touch each other's files.
  const [worktrees, setWorktrees] = useState(true);
  const [members, setMembers] = useState<MemberDraft[]>(() => [member('developer'), member('reviewer')]);
  const first = useRef<HTMLInputElement>(null);
  const state = store.state.crewSpawn;
  const busy = state?.busy === true;
  const [applied, setApplied] = useState<string | undefined>(undefined);
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
    }
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
  const create = (): void => {
    if (busy || !ready) return;
    store.createCrew(specOf({ name, folder, leadKind, leadName, leadRole, leadModel, leadMode, talk, worktrees, members }));
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') onClose();
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) create();
  };

  const saveTemplate = (): void => {
    if (!ready && !(name.trim() && members.every((draft) => draft.name.trim()))) return;
    const { cwd: _cwd, ...template } = specOf({ name, folder: folder || '/', leadKind, leadName, leadRole, leadModel, leadMode, talk, worktrees, members });
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
              {!template.builtin && (
                <button type="button" class="quiet template-delete" title={`Delete the template "${template.name}"`} onClick={() => store.deleteTemplate(template.name)}>
                  ×
                </button>
              )}
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
            <button key={value} type="button" class={talk === value ? 'on' : undefined} title={value === 'twoway' ? 'By default a member answers the lead' : 'By default a member only executes'} onClick={() => setTalk(value)}>
              {TALK_TEXT[value]}
            </button>
          ))}
        </span>
        <label class="spawn-option" title="Each member works in a git worktree of its own (a copy of the repository, on its own branch), and commits its work; the lead merges the branches. The folder must be in a git repository.">
          <input type="checkbox" checked={worktrees} onChange={() => setWorktrees(!worktrees)} />
          members in own worktree
        </label>
      </div>
      {members.map((draft, index) => {
        const effective = draft.talk ?? talk;
        return (
          <div key={draft.key} class="member">
            <div class="broadcast-row">
              <span class="broadcast-label member-index">{index + 1}</span>
              <input
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
                aria-label={`Role of ${draft.name || `member ${index + 1}`}`}
                onInput={(event) => change(draft.key, { role: (event.target as HTMLInputElement).value })}
              />
              <button
                type="button"
                class={`talk-toggle${draft.talk ? ' chosen' : ''}`}
                data-talk={effective}
                title={TALK_TITLE[effective]}
                onClick={() => change(draft.key, { talk: (draft.talk ?? talk) === 'twoway' ? 'oneway' : 'twoway' })}
              >
                {TALK_TEXT[effective]}
              </button>
              <button type="button" class={`quiet${draft.more ? ' on' : ''}`} title="Model, permissions, worktree" onClick={() => change(draft.key, { more: !draft.more })}>
                more
              </button>
              <button type="button" class="quiet" title="Remove this member" disabled={members.length === 1} onClick={() => setMembers((current) => current.filter((other) => other.key !== draft.key))}>
                ×
              </button>
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
              </div>
            )}
          </div>
        );
      })}
      <div class="broadcast-row">
        <span class="broadcast-label" />
        <button type="button" disabled={members.length >= CREW_MAX_MEMBERS} onClick={() => setMembers((current) => [...current, member('')])}>
          + member
        </button>
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
