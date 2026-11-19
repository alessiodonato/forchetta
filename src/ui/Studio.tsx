import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import { CREW_MAX_MEMBERS, CREW_NAME_MAX, type CrewTemplate, MEMBER_NAME_MAX, PATH_MAX, PATHS_MAX, RELATION_MAX, ROLE_MAX, type RolePreset, type Talk } from '../shared/crew.ts';
import { SKILL_GROUPS, type SkillInfo, SKILLS, SKILLS_PER_AGENT_MAX, skillById, skillUrl } from '../shared/skills.ts';
import { openLink } from './Artifacts.tsx';
import { shell } from './connection.ts';
import { lastPart, MODELS, MODES, recentFolders } from './NewSession.tsx';
import { TALK_TEXT } from './NewTeam.tsx';
import type { Store } from './store.ts';
import {
  addNode,
  addSkill,
  addTemplate,
  canvasSize,
  connect,
  curve,
  docOfTemplate,
  emptyDoc,
  fieldsOf,
  type From,
  fromName,
  incoming,
  leadKey,
  linkEnds,
  NODE_H,
  NODE_W,
  nodeAt,
  nodeOf,
  presetOfNode,
  problems,
  removeLink,
  removeNode,
  skillsOf,
  specOfDoc,
  type StudioDoc,
  type StudioNode,
  templateOfDoc,
  tidy,
  updateLink,
  updateNode,
  YOU_H,
  YOU_W,
} from './studio-model.ts';

// The studio of teams: a team drawn instead of written. On the left the presets, agents and whole teams, to drag
// onto the canvas, and the open-source skills of the catalog (shared/skills.ts), to drop on an agent; on the canvas You and a box for each agent, moved where you like; from the dot under a box (or
// under You) an arrow to the agent it leads, and on release, its relation: → / ⇄ and its prompt. On the right, what
// is selected: a box, an arrow, a preset, or the team itself. "Create team" starts it as the panel would; "Save as
// template" keeps it, with where the boxes stand. The model is in studio-model.ts.

/** The canvas you were drawing, kept while the window lives: closing the studio does not lose it. */
let draft: StudioDoc | undefined;

type Selection = { kind: 'node'; key: number } | { kind: 'link'; to: number } | { kind: 'role'; name: string } | { kind: 'team'; name: string } | { kind: 'skill'; id: string } | undefined;

type Drag =
  | { kind: 'move'; what: number | 'you'; dx: number; dy: number; x0: number; y0: number; moved: boolean }
  | { kind: 'link'; from: From; x: number; y: number }
  | { kind: 'role'; preset: RolePreset; x0: number; y0: number; x: number; y: number; moved: boolean }
  | { kind: 'team'; template: CrewTemplate; x0: number; y0: number; x: number; y: number; moved: boolean }
  | { kind: 'skill'; skill: SkillInfo; x0: number; y0: number; x: number; y: number; moved: boolean };

/** Past this many pixels a press becomes a drag. */
const SLOP = 4;

const firstLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function Select({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void }) {
  return (
    <label class="studio-field">
      <span>{label}</span>
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

function Text({ label, value, onInput, max, placeholder, area, mono }: { label: string; value: string; onInput: (value: string) => void; max: number; placeholder?: string; area?: boolean; mono?: boolean }) {
  return (
    <label class="studio-field">
      <span>{label}</span>
      {area ? (
        <textarea class="command-input" rows={4} value={value} maxLength={max} placeholder={placeholder} onInput={(event) => onInput((event.target as HTMLTextAreaElement).value)} />
      ) : (
        <input class={`command-input${mono ? ' mono' : ''}`} type="text" value={value} maxLength={max} placeholder={placeholder} spellcheck={false} onInput={(event) => onInput((event.target as HTMLInputElement).value)} />
      )}
    </label>
  );
}

/** What an agent is and how it runs: the fields of a box, and of a preset. */
type AgentFields = Pick<StudioNode, 'name' | 'role' | 'model' | 'mode' | 'worktree' | 'paths' | 'reviews' | 'skills'>;

/** `lead`: the box is the Claude lead, which stays in the folder of the team, reviews nothing and has no files of its own. */
function AgentForm({ fields, worktrees, lead, onChange }: { fields: AgentFields; worktrees: boolean; lead?: boolean; onChange: (patch: Partial<AgentFields>) => void }) {
  return (
    <>
      <Text label="Name" value={fields.name} max={MEMBER_NAME_MAX} placeholder="senior" onInput={(name) => onChange({ name })} />
      <Text label="Role" area value={fields.role} max={ROLE_MAX} placeholder="What it does, in the third person: the others read it too" onInput={(role) => onChange({ role })} />
      <div class="studio-row">
        <Select label="Model" value={fields.model} options={MODELS} onChange={(model) => onChange({ model })} />
        <Select label="Permissions" value={fields.mode} options={MODES} onChange={(mode) => onChange({ mode })} />
      </div>
      {lead ? <p class="studio-hint">As the lead it works in the folder of the team, with no worktree and no files of its own.</p> : <MemberOptions fields={fields} worktrees={worktrees} onChange={onChange} />}
      <SkillsField skills={fields.skills} onChange={(skills) => onChange({ skills })} />
    </>
  );
}

/** The skills of an agent: each one removable, one more from the catalog; dropping one on its box does the same. */
function SkillsField({ skills, onChange }: { skills: readonly string[]; onChange: (skills: string[]) => void }) {
  const left = SKILLS.filter((skill) => !skills.includes(skill.id));
  return (
    <div class="studio-field">
      <span>
        Skills <span class="studio-hint">· for this agent only, downloaded when the team starts</span>
      </span>
      {skills.length > 0 && (
        <div class="studio-chips">
          {skills.map((id) => (
            <span key={id} class="studio-skill-chip" title={skillById(id)?.summary}>
              {id}
              <button type="button" class="quiet" aria-label={`Remove the skill ${id}`} onClick={() => onChange(skills.filter((other) => other !== id))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {skills.length < SKILLS_PER_AGENT_MAX && (
        <select
          value=""
          aria-label="Add a skill"
          onChange={(event) => {
            const id = (event.target as HTMLSelectElement).value;
            if (id) onChange([...skills, id]);
          }}
        >
          <option value="">+ add a skill…</option>
          {SKILL_GROUPS.map(([group, label]) => (
            <optgroup key={group} label={label}>
              {left
                .filter((skill) => skill.group === group)
                .map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.id}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      )}
    </div>
  );
}

/** A skill of the catalog: what it does, where it comes from, what it weighs. */
function SkillCard({ skill }: { skill: SkillInfo }) {
  return (
    <>
      <p class="studio-title">
        {skill.id}
        <span class="studio-tag">{SKILL_GROUPS.find(([group]) => group === skill.group)?.[1]}</span>
      </p>
      <p class="studio-hint studio-strong">{skill.summary}</p>
      <ul class="studio-list">
        <li>
          From{' '}
          <a
            href={skillUrl(skill)}
            onClick={(event) => {
              event.preventDefault();
              openLink(skillUrl(skill));
            }}
          >
            {skill.repo}
          </a>
          , at commit {skill.commit.slice(0, 7)}
        </li>
        <li>License {skill.license}</li>
        <li>
          {skill.kb >= 1000 ? `${(skill.kb / 1024).toFixed(1)} MB` : `${skill.kb} KB`} in {skill.files} {skill.files === 1 ? 'file' : 'files'}
        </li>
      </ul>
      <p class="studio-hint">
        Nothing is downloaded now. The first time a team uses it, Forchetta fetches only this folder, at that commit, into its own folder (not into your project), and keeps it for the next teams. Each agent gets only its own skills, for its session only.
      </p>
      <p class="studio-hint">Drag it onto an agent, or add it from the agent's skills.</p>
    </>
  );
}

function MemberOptions({ fields, worktrees, onChange }: { fields: AgentFields; worktrees: boolean; onChange: (patch: Partial<AgentFields>) => void }) {
  return (
    <>
      <label class="studio-check" title="A git worktree of its own: it works on a copy, on its own branch">
        <input type="checkbox" checked={fields.worktree ?? worktrees} onChange={() => onChange({ worktree: !(fields.worktree ?? worktrees) })} />
        own worktree
      </label>
      <label class="studio-check" title="It reviews the commits of the others: the lead merges only what it approved">
        <input type="checkbox" checked={fields.reviews === true} onChange={() => onChange({ reviews: !fields.reviews })} />
        reviews
      </label>
      <Text label="Files" mono value={fields.paths} max={PATHS_MAX * (PATH_MAX + 2)} placeholder="src/ui/, *.css — empty: any file no one else has" onInput={(paths) => onChange({ paths })} />
    </>
  );
}

/** The relation an arrow carries: → / ⇄ and its prompt; for the arrow from You to the Claude lead, what that is. */
function RelationForm({ doc, to, onChange, onRemove, onDone }: { doc: StudioDoc; to: number; onChange: (doc: StudioDoc) => void; onRemove: () => void; onDone?: () => void }) {
  const link = incoming(doc, to);
  const target = nodeOf(doc, to);
  if (!link || !target) return null;
  const above = fromName(doc, link.from);
  const below = target.name.trim() || 'this agent';
  const talk = link.talk ?? doc.talk;
  const isLead = leadKey(doc) === to;
  return (
    <div class="studio-relation">
      <p class="studio-title">
        {above} → {below}
      </p>
      {isLead ? (
        <p class="studio-hint">
          {below} is the lead of the team: it gets your requests and answers you in the panel of the team. An arrow from You to a second agent makes you the lead instead.
        </p>
      ) : (
        <>
          <p class="studio-hint">
            {below} reports to {above}: {above === 'you' ? 'you give' : `${above} gives`} it requests
            {talk === 'twoway' ? ', and get' + (above === 'you' ? '' : 's') + ' its answers and its questions.' : '; it only executes, nothing comes back.'}
          </p>
          <span class="view-switch" role="group" aria-label="How it talks">
            {(['twoway', 'oneway'] as const).map((value) => (
              <button key={value} type="button" class={talk === value ? 'on' : undefined} onClick={() => onChange(updateLink(doc, to, { talk: value }))}>
                {TALK_TEXT[value]}
              </button>
            ))}
          </span>
          <Text
            label="The prompt of the relation (optional)"
            area
            value={link.relation}
            max={RELATION_MAX}
            placeholder={`How ${below} works with ${above}: what is asked and how, what comes back and in what form, when to ask. Both read it.`}
            onInput={(relation) => onChange(updateLink(doc, to, { relation }))}
          />
        </>
      )}
      <div class="studio-actions">
        <button type="button" class="quiet" onClick={onRemove}>
          Remove arrow
        </button>
        {onDone && (
          <button type="button" class="primary" onClick={onDone}>
            OK
          </button>
        )}
      </div>
    </div>
  );
}

/** A preset of agent, to change: your version of one of Forchetta, or one of yours. */
function RoleEditor({ preset, store, onAdd, onRenamed }: { preset: RolePreset; store: Store; onAdd: () => void; onRenamed: (name: string) => void }) {
  const [fields, setFields] = useState<AgentFields>(() => fieldsOf(preset));
  useEffect(() => setFields(fieldsOf(preset)), [preset.name, preset.modified]);
  const [armed, setArmed] = useState(false);
  const saving = store.state.crewEdit?.action === 'saveRolePreset' ? store.state.crewEdit : undefined;
  const save = (): void => {
    const next = presetOfNode({ ...fields, key: 0, x: 0, y: 0 });
    store.saveRole(next, preset.name);
    if (next.name !== preset.name) onRenamed(next.name);
  };
  const duplicate = (): void => {
    const names = new Set(store.state.roles.map((role) => role.name.toLowerCase()));
    let name = `${preset.name} copy`.slice(0, MEMBER_NAME_MAX);
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${preset.name.slice(0, MEMBER_NAME_MAX - 6)} copy ${n}`;
    store.saveRole({ ...presetOfNode({ ...fieldsOf(preset), key: 0, x: 0, y: 0 }), name });
    onRenamed(name);
  };
  return (
    <>
      <p class="studio-title">
        Preset {preset.name}
        {preset.builtin && <span class="studio-tag">{preset.modified ? 'yours, from Forchetta' : 'Forchetta'}</span>}
      </p>
      <p class="studio-hint">
        {preset.builtin && !preset.modified ? 'A preset of Forchetta: what you save here is your version of it, and you can restore theirs.' : 'Saving changes the preset, not the boxes already on the canvas.'}
      </p>
      <AgentForm fields={fields} worktrees={false} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))} />
      <div class="studio-actions">
        <button type="button" onClick={onAdd}>
          Add to canvas
        </button>
        <button type="button" onClick={duplicate}>
          Duplicate
        </button>
        {(!preset.builtin || preset.modified) &&
          (armed ? (
            <button
              type="button"
              class="danger"
              onClick={() => {
                setArmed(false);
                store.deleteRole(preset.name);
              }}
            >
              {preset.builtin ? 'restore theirs?' : 'delete?'}
            </button>
          ) : (
            <button type="button" class="quiet" onClick={() => setArmed(true)}>
              {preset.builtin ? 'Restore' : 'Delete'}
            </button>
          ))}
        <button type="button" class="primary" disabled={!fields.name.trim()} onClick={save}>
          Save preset
        </button>
      </div>
      {saving?.error && <p class="studio-note error">{saving.error}</p>}
    </>
  );
}

/** A team preset (a template): who is in it, and what to do with it. */
function TeamCard({ template, store, onOpen, onAdd }: { template: CrewTemplate; store: Store; onOpen: () => void; onAdd: () => void }) {
  const [armed, setArmed] = useState<'open' | 'delete' | undefined>(undefined);
  const duplicate = (): void => {
    const names = new Set(store.state.templates.map((other) => other.name.toLowerCase()));
    let name = `${template.name} copy`.slice(0, CREW_NAME_MAX);
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${template.name.slice(0, CREW_NAME_MAX - 7)} copy ${n}`;
    const { builtin: _builtin, modified: _modified, ...rest } = template;
    store.saveTemplate({ template: { ...rest, name } });
  };
  return (
    <>
      <p class="studio-title">
        Team {template.name}
        {template.builtin && <span class="studio-tag">{template.modified ? 'yours, from Forchetta' : 'Forchetta'}</span>}
      </p>
      <ul class="studio-list">
        <li>{template.lead.kind === 'claude' ? `${template.lead.name} — lead` : 'you — lead'}</li>
        {template.members.map((member) => (
          <li key={member.name}>
            {member.reportsTo ? '↳ ' : ''}
            {member.name}
            {member.reportsTo ? <span class="studio-hint"> under {member.reportsTo}</span> : null}
          </li>
        ))}
      </ul>
      <p class="studio-hint">Open it to change it: "Save as template" with the same name saves it{template.builtin ? ' as your version' : ''}.</p>
      <div class="studio-actions">
        <button type="button" onClick={onAdd}>
          Add to canvas
        </button>
        {armed === 'open' ? (
          <button type="button" class="danger" onClick={onOpen}>
            replace the canvas?
          </button>
        ) : (
          <button type="button" class="primary" onClick={() => setArmed('open')}>
            Open
          </button>
        )}
        <button type="button" onClick={duplicate}>
          Duplicate
        </button>
        {(!template.builtin || template.modified) &&
          (armed === 'delete' ? (
            <button
              type="button"
              class="danger"
              onClick={() => {
                setArmed(undefined);
                store.deleteTemplate(template.name);
              }}
            >
              {template.builtin ? 'restore theirs?' : 'delete?'}
            </button>
          ) : (
            <button type="button" class="quiet" onClick={() => setArmed('delete')}>
              {template.builtin ? 'Restore' : 'Delete'}
            </button>
          ))}
      </div>
    </>
  );
}

export function Studio({ agents, store, onClose }: { agents: readonly Agent[]; store: Store; onClose: () => void }) {
  const recent = useMemo(() => recentFolders(agents), [agents]);
  const [doc, setDocState] = useState<StudioDoc>(() => draft ?? emptyDoc(recent[0] ?? ''));
  /** A change of the canvas: kept for the next opening; the last note goes, unless the change sets its own after. */
  const setDoc = (next: StudioDoc | ((current: StudioDoc) => StudioDoc)): void => {
    const value = typeof next === 'function' ? next(docRef.current) : next;
    draft = value;
    docRef.current = value;
    setDocState(value);
    setNote(undefined);
  };
  const [selection, setSelection] = useState<Selection>(undefined);
  const [popover, setPopover] = useState<{ to: number; x: number; y: number } | undefined>(undefined);
  const [drag, setDrag] = useState<Drag | undefined>(undefined);
  const [note, setNote] = useState<{ text: string; error?: boolean } | undefined>(undefined);
  const [clearArmed, setClearArmed] = useState(false);
  const [skillFilter, setSkillFilter] = useState('');
  const surface = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | undefined>(undefined);
  const docRef = useRef(doc);
  docRef.current = doc;

  const spawn = store.state.crewSpawn;
  const edit = store.state.crewEdit;
  const issues = problems(doc);
  const lead = leadKey(doc);
  const size = canvasSize(doc);
  const members = doc.nodes.length - (lead !== undefined ? 1 : 0);

  useEffect(() => {
    window.forchettaFolder = (path: string) => setDoc((current) => ({ ...current, folder: path }));
    return () => {
      window.forchettaFolder = undefined;
    };
  }, []);
  useEffect(() => {
    if (!clearArmed) return;
    const timer = setTimeout(() => setClearArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [clearArmed]);
  // The result of saving a template or a preset, said once.
  useEffect(() => {
    if (!edit || edit.busy) return;
    if (edit.action === 'saveCrewTemplate') setNote(edit.ok ? { text: 'Saved: it is among the teams on the left, and in "Start from".' } : { text: edit.error ?? 'not saved', error: true });
    if (edit.action === 'saveRolePreset' && edit.ok) setNote({ text: 'Preset saved: it is among the agents on the left.' });
  }, [edit?.at, edit?.busy]);

  /** A point of the window on the canvas. */
  const toCanvas = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = surface.current?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: 0, y: 0 };
  };
  const overCanvas = (clientX: number, clientY: number): boolean => {
    const rect = viewport.current?.getBoundingClientRect();
    return !!rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  };
  /** A free place for a box added with a click: under the last one, or at the top. */
  const freeSpot = (): { x: number; y: number } => {
    const last = doc.nodes.at(-1);
    return last ? { x: last.x + NODE_W + 32, y: last.y } : { x: doc.you.x - NODE_W / 2 + YOU_W / 2, y: doc.you.y + YOU_H + 72 };
  };

  const addPreset = (preset: RolePreset, at = freeSpot()): void => {
    const added = addNode(docRef.current, fieldsOf(preset), at.x, at.y);
    setDoc(added.doc);
    setSelection({ kind: 'node', key: added.key });
    setNote({ text: `Drag an arrow from the dot under the one that leads ${added.doc.nodes.at(-1)!.name} onto its box.` });
  };
  const addTeam = (template: CrewTemplate, at = freeSpot()): void => {
    const current = docRef.current;
    const added = addTemplate(current, template, at.x, at.y);
    // On an empty canvas it is the team: its name and its choices too.
    setDoc(current.nodes.length > 0 ? added : { ...added, name: current.name.trim() || template.name, talk: template.talk, worktrees: template.worktrees === true });
    setNote({ text: `${template.name} is on the canvas.` });
  };
  const openTeam = (template: CrewTemplate): void => {
    setDoc(docOfTemplate(template, docRef.current.folder));
    setSelection(undefined);
    setPopover(undefined);
    setNote({ text: `Opened ${template.name}: change it, then "Save as template" with the same name keeps your version.` });
  };

  // The drags: a box or You moved, an arrow drawn, a preset dropped. The window listens from the press itself, so
  // that a quick click is not lost; the handlers of the last render do the work.
  const update = (next: Drag | undefined): void => {
    dragRef.current = next;
    setDrag(next);
  };
  const handlers = useRef({ move: (_event: PointerEvent): void => {}, up: (_event: PointerEvent): void => {} });
  handlers.current = {
    move: (event: PointerEvent): void => {
      const current = dragRef.current;
      if (!current) return;
      if (current.kind === 'move') {
        const point = toCanvas(event.clientX, event.clientY);
        const moved = current.moved || Math.abs(event.clientX - current.x0) + Math.abs(event.clientY - current.y0) > SLOP;
        if (!moved) return;
        const x = Math.max(0, Math.round(point.x - current.dx));
        const y = Math.max(0, Math.round(point.y - current.dy));
        setDoc((doc) => (current.what === 'you' ? { ...doc, you: { x, y } } : updateNode(doc, current.what, { x, y })));
        update({ ...current, moved: true });
      } else if (current.kind === 'link') {
        const point = toCanvas(event.clientX, event.clientY);
        update({ ...current, x: point.x, y: point.y });
      } else {
        const moved = current.moved || Math.abs(event.clientX - current.x0) + Math.abs(event.clientY - current.y0) > SLOP;
        update({ ...current, x: event.clientX, y: event.clientY, moved });
      }
    },
    up: (event: PointerEvent): void => {
      const current = dragRef.current;
      update(undefined);
      if (!current) return;
      const doc = docRef.current;
      if (current.kind === 'move') {
        if (!current.moved && current.what !== 'you') setSelection({ kind: 'node', key: current.what });
        if (!current.moved && current.what === 'you') setSelection(undefined);
        return;
      }
      if (current.kind === 'link') {
        const point = toCanvas(event.clientX, event.clientY);
        const target = nodeAt(doc, point.x, point.y);
        if (!target) return;
        const result = connect(doc, current.from, target.key);
        if ('error' in result) {
          setNote({ text: result.error, error: true });
          return;
        }
        setDoc(result.doc);
        setSelection(undefined);
        setPopover({ to: target.key, x: Math.min(point.x + 16, size.width - 320), y: point.y + 8 });
        setNote(result.replaced ? { text: `${target.name} now reports to ${fromName(result.doc, current.from)}.` } : undefined);
        return;
      }
      if (!current.moved) {
        setSelection(current.kind === 'role' ? { kind: 'role', name: current.preset.name } : current.kind === 'team' ? { kind: 'team', name: current.template.name } : { kind: 'skill', id: current.skill.id });
        return;
      }
      if (!overCanvas(event.clientX, event.clientY)) return;
      const point = toCanvas(event.clientX, event.clientY);
      if (current.kind === 'skill') {
        const target = nodeAt(doc, point.x, point.y);
        const result = target ? addSkill(doc, target.key, current.skill.id) : { error: 'Drop a skill on an agent: it is for that agent only.' };
        if ('error' in result) return setNote({ text: result.error, error: true });
        setDoc(result.doc);
        setSelection({ kind: 'node', key: target!.key });
        setNote({ text: `${target!.name} has ${current.skill.id}: it is downloaded when the team starts, outside the project.` });
        return;
      }
      if (current.kind === 'role') addPreset(current.preset, { x: Math.max(0, point.x - NODE_W / 2), y: Math.max(0, point.y - 20) });
      else addTeam(current.template, { x: Math.max(0, point.x - NODE_W / 2), y: Math.max(0, point.y - 20) });
    },
  };
  const begin = (initial: Drag): void => {
    update(initial);
    const move = (event: PointerEvent): void => handlers.current.move(event);
    const up = (event: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      handlers.current.up(event);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startMove = (event: PointerEvent, what: number | 'you'): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = toCanvas(event.clientX, event.clientY);
    const at = what === 'you' ? doc.you : nodeOf(doc, what)!;
    setPopover(undefined);
    begin({ kind: 'move', what, dx: point.x - at.x, dy: point.y - at.y, x0: event.clientX, y0: event.clientY, moved: false });
  };
  const startLink = (event: PointerEvent, from: From): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setPopover(undefined);
    const point = toCanvas(event.clientX, event.clientY);
    begin({ kind: 'link', from, x: point.x, y: point.y });
  };
  const startPalette = (event: PointerEvent, item: { preset: RolePreset } | { template: CrewTemplate } | { skill: SkillInfo }): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const base = { x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, moved: false };
    begin('preset' in item ? { kind: 'role', preset: item.preset, ...base } : 'template' in item ? { kind: 'team', template: item.template, ...base } : { kind: 'skill', skill: item.skill, ...base });
  };

  const remove = (): void => {
    if (selection?.kind === 'node') {
      setDoc(removeNode(doc, selection.key));
      setSelection(undefined);
    } else if (selection?.kind === 'link') {
      setDoc(removeLink(doc, selection.to));
      setSelection(undefined);
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    const field = (event.target as HTMLElement).closest('input, textarea, select');
    if (event.key === 'Escape') {
      if (popover) setPopover(undefined);
      else if (selection) setSelection(undefined);
      else onClose();
      return;
    }
    if (!field && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      remove();
    }
  };

  const create = (): void => {
    const checked = specOfDoc(doc);
    if ('error' in checked) return setNote({ text: checked.error, error: true });
    store.createCrew(checked.spec);
  };
  const saveTemplate = (): void => {
    const checked = templateOfDoc(doc);
    if ('error' in checked) return setNote({ text: checked.error, error: true });
    store.saveTemplate({ template: checked.template });
  };

  const selectedNode = selection?.kind === 'node' ? nodeOf(doc, selection.key) : undefined;
  const selectedRole = selection?.kind === 'role' ? store.state.roles.find((role) => role.name === selection.name) : undefined;
  const selectedTeam = selection?.kind === 'team' ? store.state.templates.find((template) => template.name === selection.name) : undefined;
  const ghost = drag && (drag.kind === 'role' || drag.kind === 'team' || drag.kind === 'skill') && drag.moved ? drag : undefined;
  const selectedSkill = selection?.kind === 'skill' ? skillById(selection.id) : undefined;
  const skillsUsed = skillsOf(doc);
  const drawing = drag?.kind === 'link' ? drag : undefined;
  const drawFrom = drawing ? (drawing.from === 'you' ? { x: doc.you.x + YOU_W / 2, y: doc.you.y + YOU_H } : (() => {
    const node = nodeOf(doc, drawing.from as number);
    return node ? { x: node.x + NODE_W / 2, y: node.y + NODE_H } : undefined;
  })()) : undefined;

  return (
    <section class="broadcast studio" aria-label="Team studio" onKeyDown={onKey} tabIndex={-1}>
      <header class="studio-top">
        <span class="studio-name">Team studio</span>
        <input
          class="command-input studio-team-name"
          type="text"
          value={doc.name}
          maxLength={CREW_NAME_MAX}
          placeholder="name of the team"
          spellcheck={false}
          aria-label="Name of the team"
          onInput={(event) => setDoc({ ...doc, name: (event.target as HTMLInputElement).value })}
        />
        <span class="studio-count">
          {lead !== undefined ? `${nodeOf(doc, lead)?.name} leads · ` : doc.links.some((link) => link.from === 'you') ? 'you lead · ' : ''}
          {members} {members === 1 ? 'member' : 'members'} of {CREW_MAX_MEMBERS}
        </span>
        <span class="studio-spacer" />
        <button type="button" title="Lay the boxes out as a tree, each one under the one that leads it" disabled={doc.nodes.length === 0} onClick={() => setDoc(tidy(doc))}>
          Tidy up
        </button>
        {clearArmed ? (
          <button
            type="button"
            class="danger"
            onClick={() => {
              setClearArmed(false);
              setDoc(emptyDoc(doc.folder));
              setSelection(undefined);
              setPopover(undefined);
            }}
          >
            empty the canvas?
          </button>
        ) : (
          <button type="button" class="quiet" disabled={doc.nodes.length === 0} onClick={() => setClearArmed(true)}>
            New
          </button>
        )}
        <button type="button" disabled={doc.nodes.length === 0 || !doc.name.trim()} title="Keep this team, with where its boxes stand, among the teams on the left and in 'Start from'" onClick={saveTemplate}>
          Save as template
        </button>
        <button type="button" class="primary" disabled={issues.length > 0 || spawn?.busy === true || !doc.folder.trim()} onClick={create}>
          {spawn?.busy ? 'Starting…' : 'Create team'}
        </button>
        <button type="button" class="quiet" title="Close the studio: the canvas stays as it is until you come back" onClick={onClose}>
          Close
        </button>
      </header>

      <aside class="studio-palette" aria-label="Presets">
        <p class="studio-section">Agents</p>
        {store.state.roles.map((preset) => (
          <div
            key={preset.name}
            class={`studio-preset${selection?.kind === 'role' && selection.name === preset.name ? ' on' : ''}`}
            title={`${preset.role}\n\nDrag it onto the canvas; click it to change it.`}
            onPointerDown={(event) => startPalette(event, { preset })}
          >
            <strong>{preset.name}</strong>
            {preset.builtin && preset.modified && <span class="studio-dot" title="Your version" />}
            <span>{[preset.model, preset.reviews ? 'reviews' : undefined].filter(Boolean).join(' · ') || firstLine(preset.role).slice(0, 28)}</span>
          </div>
        ))}
        <p class="studio-section">Teams</p>
        {store.state.templates.map((template) => (
          <div
            key={template.name}
            class={`studio-preset${selection?.kind === 'team' && selection.name === template.name ? ' on' : ''}`}
            title="Drag it onto the canvas to add it; click it to open, duplicate or delete it."
            onPointerDown={(event) => startPalette(event, { template })}
          >
            <strong>{template.name}</strong>
            {template.builtin && template.modified && <span class="studio-dot" title="Your version" />}
            <span>
              {(template.lead.kind === 'claude' ? 1 : 0) + template.members.length} agents{template.members.some((member) => member.reportsTo) ? ' · levels' : ''}
            </span>
          </div>
        ))}
        <p class="studio-section" title="Open-source skills of Claude Code, chosen and pinned to a commit: drop one on an agent. Nothing is downloaded until a team uses it.">
          Skills
        </p>
        <input
          class="command-input studio-filter"
          type="search"
          value={skillFilter}
          placeholder="filter skills"
          spellcheck={false}
          aria-label="Filter the skills"
          onInput={(event) => setSkillFilter((event.target as HTMLInputElement).value)}
        />
        {SKILL_GROUPS.map(([group, label]) => {
          const words = skillFilter.trim().toLowerCase();
          const shown = SKILLS.filter((skill) => skill.group === group && (!words || `${skill.id} ${skill.summary} ${skill.repo}`.toLowerCase().includes(words)));
          if (shown.length === 0) return null;
          return (
            <div key={group} class="studio-skill-group">
              <span class="studio-skill-group-name">{label}</span>
              {shown.map((skill) => (
                <div
                  key={skill.id}
                  class={`studio-preset studio-skill${selection?.kind === 'skill' && selection.id === skill.id ? ' on' : ''}`}
                  title={`${skill.summary}\n\n${skill.repo} · ${skill.license}. Drag it onto an agent; click it for more.`}
                  onPointerDown={(event) => startPalette(event, { skill })}
                >
                  <strong>{skill.id}</strong>
                  <span>
                    {skill.repo.split('/')[0]} · {skill.kb >= 1000 ? `${(skill.kb / 1024).toFixed(1)} MB` : `${skill.kb} KB`}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </aside>

      <div ref={viewport} class="studio-canvas" onPointerDown={(event) => event.target === surface.current && (setSelection(undefined), setPopover(undefined))}>
        <div ref={surface} class="studio-surface" style={{ width: `${size.width}px`, height: `${size.height}px` }}>
          <svg class="studio-links" width={size.width} height={size.height} aria-hidden="true">
            <defs>
              <marker id="studio-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" class="studio-arrowhead" />
              </marker>
              <marker id="studio-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" class="studio-arrowhead on" />
              </marker>
            </defs>
            {doc.links.map((link) => {
              const ends = linkEnds(doc, link);
              if (!ends) return null;
              const on = (selection?.kind === 'link' && selection.to === link.to) || popover?.to === link.to;
              const d = curve(ends.x1, ends.y1, ends.x2, ends.y2);
              return (
                <g key={link.to}>
                  <path d={d} class={`studio-link${on ? ' on' : ''}${(link.talk ?? doc.talk) === 'oneway' ? ' oneway' : ''}`} marker-end={`url(#${on ? 'studio-arrow-on' : 'studio-arrow'})`} />
                  <path
                    d={d}
                    class="studio-link-hit"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      setPopover(undefined);
                      setSelection({ kind: 'link', to: link.to });
                    }}
                  />
                </g>
              );
            })}
            {drawing && drawFrom && <path d={curve(drawFrom.x, drawFrom.y, drawing.x, drawing.y)} class="studio-link drawing" />}
          </svg>
          {doc.links.map((link) => {
            const ends = linkEnds(doc, link);
            if (!ends) return null;
            const isLead = lead === link.to;
            const talk = link.talk ?? doc.talk;
            return (
              <button
                key={link.to}
                type="button"
                class={`studio-link-label${selection?.kind === 'link' && selection.to === link.to ? ' on' : ''}`}
                style={{ left: `${(ends.x1 + ends.x2) / 2}px`, top: `${(ends.y1 + ends.y2) / 2}px` }}
                title={isLead ? 'The lead of the team' : `${talk === 'twoway' ? 'Answers' : 'Executes only'}${link.relation.trim() ? `: ${firstLine(link.relation)}` : ''}. Click to change.`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  setPopover(undefined);
                  setSelection({ kind: 'link', to: link.to });
                }}
              >
                {isLead ? 'lead' : talk === 'twoway' ? '⇄' : '→'}
                {!isLead && link.relation.trim() ? ' ✎' : ''}
              </button>
            );
          })}
          <div class="studio-you" style={{ left: `${doc.you.x}px`, top: `${doc.you.y}px`, width: `${YOU_W}px`, height: `${YOU_H}px` }} onPointerDown={(event) => startMove(event, 'you')}>
            You{lead === undefined && doc.links.some((link) => link.from === 'you') ? <span> · lead</span> : null}
            <span class="studio-handle" title="Drag onto the lead of the team, or onto each member you lead" onPointerDown={(event) => startLink(event, 'you')} />
          </div>
          {doc.nodes.map((node) => {
            const member = lead !== node.key;
            const traits = [
              node.model,
              node.mode,
              member && node.reviews ? 'reviews' : undefined,
              member && (node.worktree ?? doc.worktrees) ? 'worktree' : undefined,
              member && node.paths.trim() ? 'files' : undefined,
              node.skills.length > 0 ? `${node.skills.length} ${node.skills.length === 1 ? 'skill' : 'skills'}` : undefined,
            ].filter(Boolean);
            const loose = !incoming(doc, node.key);
            return (
              <div
                key={node.key}
                class={`studio-node${selection?.kind === 'node' && selection.key === node.key ? ' on' : ''}${loose ? ' loose' : ''}`}
                style={{ left: `${node.x}px`, top: `${node.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }}
                data-target={
                  (drawing && nodeAt(doc, drawing.x, drawing.y)?.key === node.key) || (ghost?.kind === 'skill' && (() => {
                    const point = toCanvas(ghost.x, ghost.y);
                    return overCanvas(ghost.x, ghost.y) && nodeAt(doc, point.x, point.y)?.key === node.key;
                  })())
                    ? ''
                    : undefined
                }
                onPointerDown={(event) => startMove(event, node.key)}
              >
                <div class="studio-node-head">
                  <strong>{node.name.trim() || 'unnamed'}</strong>
                  {lead === node.key && <span class="studio-tag">lead</span>}
                </div>
                <p class="studio-node-role">{firstLine(node.role) || 'No role yet: click to write it'}</p>
                <div class="studio-node-traits">{traits.join(' · ') || 'default model and permissions'}</div>
                <span class="studio-handle" title="Drag onto an agent it leads" onPointerDown={(event) => startLink(event, node.key)} />
              </div>
            );
          })}
          {popover && nodeOf(doc, popover.to) && incoming(doc, popover.to) && (
            <div class="studio-popover" style={{ left: `${popover.x}px`, top: `${popover.y}px` }} onPointerDown={(event) => event.stopPropagation()}>
              <RelationForm
                doc={doc}
                to={popover.to}
                onChange={setDoc}
                onRemove={() => {
                  setDoc(removeLink(doc, popover.to));
                  setPopover(undefined);
                }}
                onDone={() => setPopover(undefined)}
              />
            </div>
          )}
          {doc.nodes.length === 0 && (
            <div class="studio-empty" style={{ left: `${doc.you.x + YOU_W / 2}px`, top: `${doc.you.y + YOU_H + 60}px` }}>
              Drag an agent or a whole team from the left. Then pull an arrow from the dot under You, or under a box, onto the agent it leads.
            </div>
          )}
        </div>
      </div>

      <aside class="studio-props" aria-label="Properties">
        {selectedNode ? (
          <>
            <p class="studio-title">
              {selectedNode.name.trim() || 'Agent'}
              {lead === selectedNode.key && <span class="studio-tag">lead</span>}
            </p>
            <p class="studio-hint">
              {incoming(doc, selectedNode.key)
                ? `Reports to ${fromName(doc, incoming(doc, selectedNode.key)!.from)}.`
                : 'Not connected yet: drag an arrow onto it from the one it reports to.'}
            </p>
            <AgentForm
              fields={selectedNode}
              worktrees={doc.worktrees}
              lead={lead === selectedNode.key}
              onChange={(patch) => setDoc(updateNode(doc, selectedNode.key, patch))}
            />
            <div class="studio-actions">
              <button type="button" class="quiet" onClick={remove}>
                Remove box
              </button>
              <button
                type="button"
                title="Keep this agent among the presets on the left, to use it in other teams"
                disabled={!selectedNode.name.trim()}
                onClick={() => store.saveRole(presetOfNode(selectedNode))}
              >
                Save as preset
              </button>
            </div>
          </>
        ) : selection?.kind === 'link' && incoming(doc, selection.to) ? (
          <RelationForm doc={doc} to={selection.to} onChange={setDoc} onRemove={remove} />
        ) : selectedRole ? (
          <RoleEditor
            preset={selectedRole}
            store={store}
            onAdd={() => addPreset(selectedRole)}
            onRenamed={(name) => setSelection({ kind: 'role', name })}
          />
        ) : selectedTeam ? (
          <TeamCard template={selectedTeam} store={store} onOpen={() => openTeam(selectedTeam)} onAdd={() => addTeam(selectedTeam)} />
        ) : selectedSkill ? (
          <SkillCard skill={selectedSkill} />
        ) : (
          <>
            <p class="studio-title">The team</p>
            <label class="studio-field">
              <span>Folder</span>
              <div class="studio-row">
                <input
                  class="command-input mono"
                  type="text"
                  value={doc.folder}
                  placeholder="~/projects/app"
                  spellcheck={false}
                  onInput={(event) => setDoc({ ...doc, folder: (event.target as HTMLInputElement).value })}
                />
                {shell() && (
                  <button type="button" onClick={() => shell()?.postMessage({ type: 'chooseFolder', folder: doc.folder })}>
                    Choose…
                  </button>
                )}
              </div>
            </label>
            {recent.length > 0 && (
              <div class="studio-chips">
                {recent.map((path) => (
                  <button key={path} type="button" class={`chip${path === doc.folder ? ' on' : ''}`} title={path} onClick={() => setDoc({ ...doc, folder: path })}>
                    {lastPart(path)}
                  </button>
                ))}
              </div>
            )}
            <label class="studio-field">
              <span>An arrow, by default</span>
              <span class="view-switch" role="group" aria-label="How an agent talks with the one above it, by default">
                {(['twoway', 'oneway'] as const).map((value: Talk) => (
                  <button key={value} type="button" class={doc.talk === value ? 'on' : undefined} onClick={() => setDoc({ ...doc, talk: value })}>
                    {TALK_TEXT[value]}
                  </button>
                ))}
              </span>
            </label>
            <label class="studio-check" title="Each member works in a git worktree of its own; the folder must be in a git repository">
              <input type="checkbox" checked={doc.worktrees} onChange={() => setDoc({ ...doc, worktrees: !doc.worktrees })} />
              members in own worktree
            </label>
            <p class="studio-section">{issues.length > 0 ? 'Before it can start' : 'Ready'}</p>
            {issues.length > 0 ? (
              <ul class="studio-list">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : (
              <p class="studio-hint">
                {doc.folder.trim() ? `"Create team" starts ${doc.nodes.length} sessions in ${lastPart(doc.folder)}.` : 'Choose its folder, then "Create team".'}
              </p>
            )}
            {skillsUsed.ids.length > 0 && (
              <p class="studio-hint">
                Skills: {skillsUsed.ids.length} ({skillsUsed.kb >= 1000 ? `${(skillsUsed.kb / 1024).toFixed(1)} MB` : `${skillsUsed.kb} KB`}), downloaded the first time a team uses them, into Forchetta and not into the project; then kept for the next teams.
              </p>
            )}
            <p class="studio-hint">Click a box or an arrow to change it. Delete removes what is selected.</p>
          </>
        )}
      </aside>

      <footer class="studio-foot">
        <span class={`broadcast-note${spawn?.error || note?.error ? ' error' : ''}`}>
          {spawn?.error ?? note?.text ?? (issues.length > 0 ? issues[0] : 'Ready: "Create team" starts it, "Save as template" keeps it.')}
        </span>
      </footer>

      {ghost && (
        <div class="studio-ghost" style={{ left: `${ghost.x}px`, top: `${ghost.y}px` }}>
          {ghost.kind === 'role' ? ghost.preset.name : ghost.kind === 'team' ? `${ghost.template.name} (team)` : `${ghost.skill.id} (skill)`}
        </div>
      )}
    </section>
  );
}

