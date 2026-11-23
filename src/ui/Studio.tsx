import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Agent, STATE_LABEL } from '../shared/agent.ts';
import { MACHINE } from '../shared/machine.ts';
import { crewUsage, shortTokens, tokensTotal, usdText } from '../shared/present.ts';
import { type LinkKind, linkStates } from './org-lines.ts';
import { type AgentTools, hasTools, MCP_SERVERS, type McpServerInfo, mcpServerById, TOOL_LIMITS, type ToolLimitId, toolsText } from '../shared/agent-tools.ts';
import { cleanBudget, CREW_NAME_MAX, type CrewTemplate, DELIVERABLE_MAX, MEMBER_NAME_MAX, NOTE_MAX, PARAM_HINT_MAX, PATH_MAX, PATHS_MAX, RELATION_MAX, ROLE_MAX, type RolePreset, RULES_MAX, type Talk, VALUE_MAX } from '../shared/crew.ts';
import { DESCRIBE_MAX, describeChatPrompt } from '../shared/describe.ts';
import { eventLine, type ReplayData, replayAt, type ReplayEvent } from '../shared/replay.ts';
import { allSkills, SKILL_GROUPS, type SkillInfo, SKILLS_PER_AGENT_MAX, skillById, skillUrl } from '../shared/skills.ts';
import { openLink } from './Artifacts.tsx';
import { lastPart, MODELS, MODES, recentFolders } from './NewSession.tsx';
import { TALK_TEXT } from './NewTeam.tsx';
import { useReturnFocus } from './focus.ts';
import { keyText } from './platform.ts';
import { canOpen, type Store } from './store.ts';
import {
  addNode,
  addNote,
  addSkill,
  addTemplate,
  addTool,
  canvasSize,
  checksOfDoc,
  clampZoom,
  clipOf,
  contentBox,
  connect,
  curve,
  docOfTemplate,
  emptyDoc,
  emptyHistory,
  fieldsOf,
  fitZoom,
  type From,
  fromName,
  incoming,
  leadKey,
  linkEnds,
  NODE_H,
  NODE_W,
  NOTE_W,
  nodeAt,
  nodeOf,
  nodesIn,
  pasteClip,
  pathsOf,
  reserveKeys,
  noteOf,
  paramsOfDoc,
  presetOfNode,
  problems,
  redoStep,
  remember,
  removeLink,
  removeNode,
  removeNodes,
  skillsOf,
  specOfDoc,
  type StudioClip,
  type StudioDoc,
  type StudioHistory,
  type StudioLink,
  type StudioNode,
  templateOfDoc,
  tidy,
  undoStep,
  updateLink,
  updateNode,
  updateParam,
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
/** The boxes copied (⌘C), for ⌘V here or in a canvas opened later; and how far the next paste goes. */
let clipboard: StudioClip | undefined;
let pasteShift = 0;
/** The zoom of the canvas, kept until the page reloads. */
let zoomSaved = 1;
/** Told of every change of the canvas: the studio of forchetta.dev saves it in the browser. */
let draftWatcher: ((doc: StudioDoc) => void) | undefined;

/** A canvas kept elsewhere (the browser), to open the studio on. */
export function restoreDraft(doc: StudioDoc): void {
  const complete: StudioDoc = { ...emptyDoc(doc.folder ?? ''), ...doc, rules: doc.rules ?? '', notes: doc.notes ?? [] };
  reserveKeys(complete);
  draft = complete;
}

export function watchDraft(watch: (doc: StudioDoc) => void): void {
  draftWatcher = watch;
}
/** The canvas of each running team opened in the studio: where you put its boxes, and the agents not added yet. */
const liveDocs = new Map<string, StudioDoc>();
/** Its undo and redo, kept with it until the page reloads. */
let history: StudioHistory = emptyHistory();

type Selection =
  | { kind: 'node'; key: number }
  | { kind: 'link'; to: number }
  | { kind: 'role'; name: string }
  | { kind: 'new-role' }
  | { kind: 'team'; name: string }
  | { kind: 'skill'; id: string }
  | { kind: 'new-skill' }
  | { kind: 'tool'; id: string }
  | { kind: 'note'; key: number }
  | { kind: 'import' }
  | { kind: 'describe' }
  | { kind: 'nodes'; keys: number[] }
  | undefined;

/** What you wrote to have a team drawn, kept while the window lives. */
let describing = '';
/** The drawn team last opened on the canvas, by when it came: each one opens once. */
let describedOpened: number | undefined;

/** "+ new agent" in the palette: dragged, a box to fill on the canvas; clicked, a preset of your own to write. */
const BLANK_AGENT: RolePreset = { name: 'agent', role: '' };

type Drag =
  | { kind: 'move'; what: number | 'you'; note?: boolean; dx: number; dy: number; x0: number; y0: number; moved: boolean }
  | { kind: 'link'; from: From; x: number; y: number }
  | { kind: 'role'; preset: RolePreset; x0: number; y0: number; x: number; y: number; moved: boolean }
  | { kind: 'team'; template: CrewTemplate; x0: number; y0: number; x: number; y: number; moved: boolean }
  | { kind: 'skill'; skill: SkillInfo; x0: number; y0: number; x: number; y: number; moved: boolean }
  | { kind: 'tool'; tool: McpServerInfo; x0: number; y0: number; x: number; y: number; moved: boolean }
  /** Several boxes moved together, from where each one was. */
  | { kind: 'group'; key: number; starts: Map<number, { x: number; y: number }>; px: number; py: number; x0: number; y0: number; moved: boolean }
  /** A rectangle drawn from an empty spot, to select the boxes it touches (canvas points). */
  | { kind: 'band'; ax: number; ay: number; bx: number; by: number };

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
type AgentFields = Pick<StudioNode, 'name' | 'role' | 'model' | 'mode' | 'worktree' | 'paths' | 'reviews' | 'skills' | 'tools'>;

/** The tools of an agent as chosen: only what is on, undefined for nothing. */
function toolsOf(limits: readonly ToolLimitId[], mcp: readonly string[], strictMcp: boolean): AgentTools | undefined {
  const tools: AgentTools = {
    ...(limits.length > 0 ? { limits: TOOL_LIMITS.filter((limit) => limits.includes(limit.id)).map((limit) => limit.id) } : {}),
    ...(mcp.length > 0 ? { mcp: MCP_SERVERS.filter((server) => mcp.includes(server.id)).map((server) => server.id) } : {}),
    ...(strictMcp ? { strictMcp: true } : {}),
  };
  return hasTools(tools) ? tools : undefined;
}

/** What an agent may not do, and the MCP servers it has: for its session only. */
function ToolsField({ tools, onChange }: { tools: AgentTools | undefined; onChange: (tools: AgentTools | undefined) => void }) {
  const limits = tools?.limits ?? [];
  const mcp = tools?.mcp ?? [];
  const strict = tools?.strictMcp === true;
  const left = MCP_SERVERS.filter((server) => !mcp.includes(server.id));
  return (
    <div class="studio-field">
      <span>
        Tools <span class="studio-hint">· for this agent only</span>
      </span>
      <div class="studio-checks">
        {TOOL_LIMITS.map((limit) => (
          <label key={limit.id} class="studio-check" title={limit.summary}>
            <input
              type="checkbox"
              checked={limits.includes(limit.id)}
              onChange={() => onChange(toolsOf(limits.includes(limit.id) ? limits.filter((id) => id !== limit.id) : [...limits, limit.id], mcp, strict))}
            />
            {limit.label}
          </label>
        ))}
      </div>
      {mcp.length > 0 && (
        <div class="studio-chips">
          {mcp.map((id) => (
            <span key={id} class="studio-skill-chip studio-tool-chip" title={mcpServerById(id)?.summary}>
              {mcpServerById(id)?.label ?? id}
              <button type="button" class="quiet" aria-label={`Remove the tool ${id}`} onClick={() => onChange(toolsOf(limits, mcp.filter((other) => other !== id), strict))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {left.length > 0 && (
        <select
          value=""
          aria-label="Add an MCP server"
          onChange={(event) => {
            const id = (event.target as HTMLSelectElement).value;
            if (id) onChange(toolsOf(limits, [...mcp, id], strict));
          }}
        >
          <option value="">+ add a tool (MCP server)…</option>
          {left.map((server) => (
            <option key={server.id} value={server.id}>
              {server.label} ({server.id})
            </option>
          ))}
        </select>
      )}
      <label class="studio-check" title="It starts with only its own MCP servers and those of the team: none of the MCP servers of your Claude Code">
        <input type="checkbox" checked={strict} onChange={() => onChange(toolsOf(limits, mcp, !strict))} />
        none of your MCP servers
      </label>
    </div>
  );
}

/** An MCP server of the catalog: what it does, where it comes from, what it talks to. */
function ToolCard({ tool }: { tool: McpServerInfo }) {
  const url = `https://github.com/${tool.repo}`;
  return (
    <>
      <p class="studio-title">
        {tool.label}
        <span class="studio-tag">MCP server</span>
      </p>
      <p class="studio-hint studio-strong">{tool.summary}</p>
      <ul class="studio-list">
        <li>
          <code>
            {tool.package}@{tool.version}
          </code>
          , from{' '}
          <a
            href={url}
            onClick={(event) => {
              event.preventDefault();
              openLink(url);
            }}
          >
            {tool.repo}
          </a>
        </li>
        <li>License {tool.license}</li>
        <li>Its tools: mcp__{tool.id}__…</li>
        {tool.network && <li>Beyond this {MACHINE}: {tool.network}</li>}
      </ul>
      <p class="studio-hint">
        Only the agents you give it to have it, for their session: npx runs it at this version when the session starts (the first time it downloads it), and its tools are allowed without asking for those agents. It is in no
        file of your project and in none of your settings.
      </p>
      <p class="studio-hint">Drag it onto an agent, or add it from the tools of the agent.</p>
    </>
  );
}

/**
 * A team from a sentence. In the app Claude draws it (your Claude Code, with no tools): it opens on the canvas, in
 * place of what is there. In the browser there is no Claude of Forchetta: the prompt is copied, for a chat with
 * Claude, and its answer goes into "Import".
 */
function DescribeForm({ store, maker, roles, onImport }: { store: Store; maker?: boolean; roles: readonly RolePreset[]; onImport: () => void }) {
  const [text, setText] = useState(describing);
  const [copied, setCopied] = useState(false);
  const busy = store.state.describe?.busy === true;
  const state = store.state.describe;
  return (
    <>
      <p class="studio-title">Describe the team</p>
      <p class="studio-hint">
        {maker
          ? 'Say what the team is for, and who does what if you know. The prompt for Claude is copied: paste it in a chat with Claude, then its answer in Import, and the team is on the canvas.'
          : 'Say what the team is for, and who does what if you know: Claude draws it on the canvas, with roles, models, skills, tools and arrows, for you to change. It runs your Claude Code alone: no tools, none of your files, settings or memory. It takes half a minute or so, and a few cents. Nothing starts until you press "Create team".'}
      </p>
      <Text
        label="The team you want"
        area
        value={text}
        max={DESCRIBE_MAX}
        placeholder="A team to move the frontend to React 19: a lead that plans, two developers on separate folders, a tester with a browser, a reviewer that approves before the merge."
        onInput={(value) => {
          describing = value;
          setText(value);
        }}
      />
      <div class="studio-actions">
        {maker ? (
          <>
            <button
              type="button"
              class="primary"
              disabled={!text.trim()}
              onClick={() => {
                void navigator.clipboard?.writeText(describeChatPrompt(text, roles)).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              Copy the prompt for Claude
            </button>
            <button type="button" onClick={onImport}>
              Import the answer
            </button>
          </>
        ) : (
          <button type="button" class="primary" disabled={!text.trim() || busy} onClick={() => store.describeTeam(text)}>
            {busy ? 'Claude is drawing it…' : 'Draw it'}
          </button>
        )}
      </div>
      {maker && copied && <p class="studio-hint">Copied: paste it in a chat with Claude, then paste its answer in Import.</p>}
      {!maker && busy && <p class="studio-hint">Usually 20 to 60 seconds. The canvas stays as it is until the team comes.</p>}
      {!maker && state && !state.busy && state.error && <p class="studio-note error">{state.error}</p>}
    </>
  );
}

/**
 * The parameters of the team: each {name} its texts use, with what it is and its default (kept in the template), and
 * its value for the next start (not kept).
 */
function ParamsFields({ doc, maker, onChange }: { doc: StudioDoc; maker?: boolean; onChange: (doc: StudioDoc) => void }) {
  const params = paramsOfDoc(doc);
  if (params.length === 0)
    return <p class="studio-hint">Parameters: write {'{ticket}'} in a role, a relation, the rules or what it delivers, and it is filled each time the team starts.</p>;
  return (
    <div class="studio-field">
      <span>Parameters</span>
      {params.map((param) => (
        <div key={param.name} class={`studio-param${maker ? '' : ' values'}`}>
          <code>{`{${param.name}}`}</code>
          <input
            class="command-input"
            type="text"
            value={param.hint ?? ''}
            maxLength={PARAM_HINT_MAX}
            placeholder="what it is: the ticket, like APP-123"
            aria-label={`What {${param.name}} is`}
            onInput={(event) => onChange(updateParam(doc, param.name, { hint: (event.target as HTMLInputElement).value }))}
          />
          <input
            class="command-input mono"
            type="text"
            value={param.default ?? ''}
            maxLength={VALUE_MAX}
            placeholder="default"
            aria-label={`The default of {${param.name}}`}
            onInput={(event) => onChange(updateParam(doc, param.name, { default: (event.target as HTMLInputElement).value }))}
          />
          {!maker && (
            <input
              class="command-input mono"
              type="text"
              value={doc.values?.[param.name] ?? ''}
              maxLength={VALUE_MAX}
              placeholder={param.default ? `this time: ${param.default}` : 'value, this time'}
              aria-label={`The value of {${param.name}} for this start`}
              onInput={(event) => onChange({ ...doc, values: { ...doc.values, [param.name]: (event.target as HTMLInputElement).value } })}
            />
          )}
        </div>
      ))}
      <p class="studio-hint">
        {maker
          ? 'What each one is, and its default, go with the template: whoever starts the team fills them.'
          : 'What each one is and its default go with the template; the value is for this start only, and fills the texts and your goal.'}
      </p>
    </div>
  );
}

const clockOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The replay of a run: back to the start, one event back, play, one event forward, and the time on a bar. */
function ReplayBar({ data, t, playing, onTime, onPlay, onClose }: { data: ReplayData; t: number; playing: boolean; onTime: (t: number) => void; onPlay: () => void; onClose: () => void }) {
  const frame = replayAt(data, t);
  const step = (forward: boolean): void => {
    const events = data.events;
    if (forward) {
      const next = events.find((event) => event.t > t);
      if (next) onTime(next.t);
    } else {
      const before = [...events].reverse().find((event) => event.t < t);
      onTime(before ? before.t : data.start);
    }
  };
  const current: ReplayEvent | undefined = frame.index >= 0 ? data.events[frame.index] : undefined;
  return (
    <div class="studio-replay" role="group" aria-label="Replay of the run">
      <button type="button" class="quiet" title="Back to the start" aria-label="Back to the start" onClick={() => onTime(data.start)}>
        ⏮
      </button>
      <button type="button" class="quiet" title="One event back" aria-label="One event back" onClick={() => step(false)}>
        ◀
      </button>
      <button type="button" class="primary" title={playing ? 'Pause' : 'Play: one event after the other'} aria-label={playing ? 'Pause' : 'Play'} onClick={onPlay}>
        {playing ? '❚❚' : '▶'}
      </button>
      <button type="button" class="quiet" title="One event forward" aria-label="One event forward" onClick={() => step(true)}>
        ▶︎|
      </button>
      <input
        type="range"
        class="studio-replay-range"
        min={data.start}
        max={Math.max(data.end, data.start + 1)}
        step={1000}
        value={t}
        aria-label="Time of the run"
        onInput={(event) => onTime(Number((event.target as HTMLInputElement).value))}
      />
      <span class="studio-replay-time">{clockOf(t)}</span>
      <span class="studio-replay-event" title={current ? eventLine(current) : undefined}>
        {current ? eventLine(current) : 'The team starts: ▶ plays the run, one event after the other.'}
      </span>
      <span class="studio-replay-count">
        {frame.index + 1}/{data.events.length}
      </span>
      <button type="button" class="quiet" title="Back to the team as it is now" onClick={onClose}>
        Live
      </button>
    </div>
  );
}

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
      <ToolsField tools={fields.tools} onChange={(tools) => onChange({ tools })} />
    </>
  );
}

/** The skills of an agent: each one removable, one more from the catalog; dropping one on its box does the same. */
function SkillsField({ skills, onChange }: { skills: readonly string[]; onChange: (skills: string[]) => void }) {
  const left = allSkills().filter((skill) => !skills.includes(skill.id));
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
          {SKILL_GROUPS.filter(([group]) => left.some((skill) => skill.group === group)).map(([group, label]) => (
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

/** A skill: what it does, where it comes from, what it weighs; one of yours can be taken away. */
function SkillCard({ skill, store }: { skill: SkillInfo; store: Store }) {
  const [armed, setArmed] = useState(false);
  const yours = skill.group === 'yours';
  const edit = store.state.skillEdit?.action === 'remove' ? store.state.skillEdit : undefined;
  const size = `${skill.kb >= 1000 ? `${(skill.kb / 1024).toFixed(1)} MB` : `${skill.kb} KB`} in ${skill.files} ${skill.files === 1 ? 'file' : 'files'}`;
  return (
    <>
      <p class="studio-title">
        {skill.id}
        <span class="studio-tag">{SKILL_GROUPS.find(([group]) => group === skill.group)?.[1]}</span>
      </p>
      {skill.summary && <p class="studio-hint studio-strong">{skill.summary}</p>}
      <ul class="studio-list">
        {skill.local ? (
          <li>
            From your folder <span class="studio-path">{skill.local}</span>
          </li>
        ) : (
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
        )}
        {!skill.local && <li>{skill.license === 'unknown' ? 'License: see its repository' : `License ${skill.license}`}</li>}
        <li>{size}</li>
      </ul>
      <p class="studio-hint">
        {skill.local
          ? 'Used where it is, never copied: what you change in the folder counts from the next session that has it. Each agent gets only its own skills, for its session only.'
          : yours
            ? 'Kept at that commit, so it does not change by itself: the folder is in the cache of Forchetta already, not in your project. Each agent gets only its own skills, for its session only.'
            : 'Nothing is downloaded now. The first time a team uses it, Forchetta fetches only this folder, at that commit, into its own folder (not into your project), and keeps it for the next teams. Each agent gets only its own skills, for its session only.'}
      </p>
      <p class="studio-hint">Drag it onto an agent, or add it from the agent's skills.</p>
      {yours && (
        <div class="studio-actions">
          {armed ? (
            <button
              type="button"
              class="danger"
              onClick={() => {
                setArmed(false);
                store.removeSkill(skill.id);
              }}
            >
              take it away?
            </button>
          ) : (
            <button type="button" class="quiet" onClick={() => setArmed(true)}>
              Take away
            </button>
          )}
        </div>
      )}
      {yours && edit?.error && <p class="studio-note error">{edit.error}</p>}
    </>
  );
}

/** A member of a running team, selected: what it is doing and what it used; its files, or taking it away. */
function LiveMember({
  node,
  lead,
  above,
  agent,
  store,
  onPaths,
  onRemove,
}: {
  node: StudioNode;
  lead: boolean;
  above: string | undefined;
  agent: Agent | undefined;
  store: Store;
  onPaths: (paths: string) => void;
  onRemove: () => void;
}) {
  const [paths, setPaths] = useState(node.paths);
  const [armed, setArmed] = useState(false);
  useEffect(() => setPaths(node.paths), [node.key, node.paths]);
  const used = agent ? crewUsage([agent]) : undefined;
  const total = used ? tokensTotal(used.tokens) : 0;
  return (
    <>
      <p class="studio-title">
        {node.name.trim()}
        {lead && <span class="studio-tag">lead</span>}
        {agent && <span class="studio-tag">{STATE_LABEL[agent.state]}</span>}
      </p>
      <p class="studio-hint">{lead ? 'The lead of the running team.' : `In the running team, reporting to ${above ?? 'the lead'}.`}</p>
      <ul class="studio-list">
        {agent && (agent.state === 'working' ? <li>Now: {agent.action?.label ?? 'thinking…'}</li> : agent.summary?.text ? <li>Last: {agent.summary.text.slice(0, 140)}</li> : null)}
        {used && (used.usd > 0 || total > 0) && (
          <li>
            Used {used.usd > 0 ? `≈ ${usdText(used.usd)}` : ''}
            {total > 0 ? `${used.usd > 0 ? ', ' : ''}${shortTokens(total)} tokens (${shortTokens(used.tokens.output)} written)` : ''}
          </li>
        )}
        <li>Model {node.model || 'default'}, permissions {node.mode || 'default'}</li>
        {node.skills.length > 0 && <li>Skills: {node.skills.join(', ')}</li>}
      </ul>
      <p class="studio-hint studio-strong">{node.role}</p>
      {!lead && (
        <>
          <label class="studio-field">
            <span>Files</span>
            <div class="studio-row">
              <input class="command-input mono" type="text" value={paths} placeholder="src/ui/, *.css — empty: any file not of another member" spellcheck={false} onInput={(event) => setPaths((event.target as HTMLInputElement).value)} />
              <button type="button" disabled={paths === node.paths} onClick={() => onPaths(paths)}>
                Apply
              </button>
            </div>
          </label>
          <div class="studio-actions">
            {agent && canOpen(agent) && (
              <button type="button" onClick={() => store.open(agent.id)}>
                Open its terminal
              </button>
            )}
            {armed ? (
              <button
                type="button"
                class="danger"
                onClick={() => {
                  setArmed(false);
                  onRemove();
                }}
              >
                close its session?
              </button>
            ) : (
              <button type="button" class="quiet" onClick={() => setArmed(true)}>
                Remove from the team
              </button>
            )}
          </div>
        </>
      )}
      {lead && agent && canOpen(agent) && (
        <div class="studio-actions">
          <button type="button" onClick={() => store.open(agent.id)}>
            Open its terminal
          </button>
        </div>
      )}
      <p class="studio-hint">A running session keeps its role, model and skills: change them in a template, for the next start.</p>
    </>
  );
}

/** The whole canvas, small, in a corner, when it does not fit in the view: where you are, and a click to go elsewhere. */
function Minimap({ doc, size, zoom, view }: { doc: StudioDoc; size: { width: number; height: number }; zoom: number; view: HTMLDivElement | null }) {
  if (!view || doc.nodes.length === 0) return null;
  const visible = { x: view.scrollLeft / zoom, y: view.scrollTop / zoom, width: view.clientWidth / zoom, height: view.clientHeight / zoom };
  const box = contentBox(doc);
  if (box.left >= visible.x && box.top >= visible.y && box.right <= visible.x + visible.width && box.bottom <= visible.y + visible.height) return null;
  const scale = Math.min(170 / size.width, 120 / size.height);
  const go = (event: PointerEvent): void => {
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    view.scrollLeft = (x - visible.width / 2) * zoom;
    view.scrollTop = (y - visible.height / 2) * zoom;
  };
  return (
    <svg
      class="studio-minimap"
      width={Math.round(size.width * scale)}
      height={Math.round(size.height * scale)}
      aria-label="Map of the canvas: click to go there"
      onPointerDown={(event) => {
        event.preventDefault();
        (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
        go(event);
      }}
      onPointerMove={(event) => event.buttons === 1 && go(event)}
    >
      <rect class="studio-minimap-you" x={doc.you.x * scale} y={doc.you.y * scale} width={YOU_W * scale} height={YOU_H * scale} />
      {doc.nodes.map((node) => (
        <rect key={node.key} class="studio-minimap-node" x={node.x * scale} y={node.y * scale} width={NODE_W * scale} height={NODE_H * scale} />
      ))}
      <rect class="studio-minimap-view" x={visible.x * scale} y={visible.y * scale} width={visible.width * scale} height={visible.height * scale} />
    </svg>
  );
}

/** A team from its file: dropped on the studio, or its text pasted here. */
function ImportTeam({ store }: { store: Store }) {
  const [text, setText] = useState('');
  const file = store.state.teamFile?.action === 'import' ? store.state.teamFile : undefined;
  const busy = file?.busy === true;
  // The skills of GitHub it brings are code someone else chose: they are fetched only when you say so.
  if (file?.ask && !busy)
    return (
      <>
        <p class="studio-title">This team brings skills</p>
        <p class="studio-hint">
          {file.ask.length === 1 ? 'One skill' : `${file.ask.length} skills`} from GitHub, that this {MACHINE} does not have. A skill is instructions and files that Claude reads and may run: open each to see what it holds, at the commit the team names, before fetching it.
        </p>
        <ul class="studio-ask">
          {file.ask.map((skill) => (
            <li key={skill.id}>
              <strong>{skill.id}</strong>{' '}
              <a href={`https://github.com/${skill.repo}/tree/${skill.commit}/${skill.path}`} target="_blank" rel="noreferrer">
                {skill.repo}/{skill.path}
              </a>{' '}
              <code>{skill.commit.slice(0, 7)}</code>
            </li>
          ))}
        </ul>
        <div class="studio-actions">
          <button type="button" class="primary" onClick={() => store.answerImport('fetch')}>
            Fetch them and open
          </button>
          <button type="button" onClick={() => store.answerImport('skip')}>
            Open without them
          </button>
          <button type="button" class="quiet" onClick={() => store.answerImport('cancel')}>
            Cancel
          </button>
        </div>
      </>
    );
  return (
    <>
      <p class="studio-title">Open a team from its file</p>
      <p class="studio-hint">
        Drop the file of a team (<code>.forchetta-team.json</code>) anywhere on the studio, or paste its text here. It opens on the canvas, in place of what is there; {keyText('⌘Z')} brings that back. Skills of GitHub it needs are added; skills that were a folder of the other computer are left out.
      </p>
      <Text label="Its text" area value={text} max={512 * 1024} placeholder='{ "kind": "forchetta-team", … }' onInput={setText} mono />
      <div class="studio-actions">
        <button type="button" class="primary" disabled={!text.trim() || busy} onClick={() => store.importTeam(text)}>
          {busy ? 'Opening…' : 'Open'}
        </button>
      </div>
    </>
  );
}

/** A skill of yours: the link of its folder on GitHub, or a folder of this Mac. */
function AddSkill({ store, onChoose, onAdded }: { store: Store; onChoose?: (current: string, put: (path: string) => void) => void; onAdded: (id: string) => void }) {
  const [source, setSource] = useState('');
  const edit = store.state.skillEdit?.action === 'add' ? store.state.skillEdit : undefined;
  const [sentAt, setSentAt] = useState<number | undefined>(undefined);
  // Added: it is selected, with its card.
  useEffect(() => {
    if (sentAt !== undefined && edit && !edit.busy && edit.at >= sentAt && edit.ok && edit.id) onAdded(edit.id);
  }, [edit?.at, edit?.busy]);
  const add = (): void => {
    if (!source.trim() || edit?.busy) return;
    setSentAt(Date.now());
    store.addSkill(source.trim());
  };
  return (
    <>
      <p class="studio-title">Add a skill of yours</p>
      <p class="studio-hint">
        From GitHub: the link of the folder of the skill, with its SKILL.md. Forchetta keeps the commit of now, so the skill does not change by itself, and fetches only that folder, outside your projects. From a folder of this {MACHINE}: it is used where it is, never copied.
      </p>
      <label class="studio-field">
        <span>Link or folder</span>
        <div class="studio-row">
          <input
            class="command-input mono"
            type="text"
            value={source}
            placeholder="https://github.com/owner/repo/tree/main/skills/name"
            spellcheck={false}
            onInput={(event) => setSource((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => event.key === 'Enter' && add()}
          />
          {onChoose && (
            <button type="button" title="Choose the folder of a skill" onClick={() => onChoose(source.startsWith('/') || source.startsWith('~') ? source : '', setSource)}>
              Choose…
            </button>
          )}
        </div>
      </label>
      <div class="studio-actions">
        <button type="button" class="primary" disabled={!source.trim() || edit?.busy === true} onClick={add}>
          {edit?.busy ? 'Adding…' : 'Add skill'}
        </button>
      </div>
      {sentAt !== undefined && edit && !edit.busy && edit.at >= sentAt && edit.error && <p class="studio-note error">{edit.error}</p>}
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
function RelationForm({
  doc,
  to,
  onChange,
  onRemove,
  onDone,
  onTalk,
  onApprove,
}: {
  doc: StudioDoc;
  to: number;
  onChange: (doc: StudioDoc) => void;
  onRemove: () => void;
  onDone?: () => void;
  /** A member of a running team: → / ⇄ changes in the team itself; its prompt and its place stay. */
  onTalk?: (talk: Talk) => void;
  /** A member of a running team: whether its requests wait for your approval, from now on. */
  onApprove?: (approve: boolean) => void;
}) {
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
              <button
                key={value}
                type="button"
                class={talk === value ? 'on' : undefined}
                aria-pressed={talk === value}
                onClick={() => {
                  onChange(updateLink(doc, to, { talk: value }));
                  onTalk?.(value);
                }}
              >
                {TALK_TEXT[value]}
              </button>
            ))}
          </span>
          {link.from !== 'you' && (
            <label class="studio-check" title={`Each request ${above} sends to ${below} waits for your yes (in the panel of the team): you approve it, change it, or send it back with a note`}>
              <input
                type="checkbox"
                checked={link.approve === true}
                onChange={() => {
                  onChange(updateLink(doc, to, { approve: !link.approve }));
                  onApprove?.(!link.approve);
                }}
              />
              you approve its requests first
            </label>
          )}
          {onTalk ? (
            <p class="studio-hint">
              {link.relation.trim() ? `Its prompt: ${link.relation.trim()}` : 'No prompt of its own.'} A running session keeps its prompt; → / ⇄ counts from the next request.
            </p>
          ) : (
            <Text
              label="The prompt of the relation (optional)"
              area
              value={link.relation}
              max={RELATION_MAX}
              placeholder={`How ${below} works with ${above}: what is asked and how, what comes back and in what form, when to ask. Both read it.`}
              onInput={(relation) => onChange(updateLink(doc, to, { relation }))}
            />
          )}
        </>
      )}
      <div class="studio-actions">
        {!onTalk && (
          <button type="button" class="quiet" onClick={onRemove}>
            Remove arrow
          </button>
        )}
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
function RoleEditor({ preset, fresh, store, onAdd, onRenamed }: { preset: RolePreset; fresh?: boolean; store: Store; onAdd: (preset: RolePreset) => void; onRenamed: (name: string) => void }) {
  const initial = (): AgentFields => (fresh ? { ...fieldsOf(preset), name: '' } : fieldsOf(preset));
  const [fields, setFields] = useState<AgentFields>(initial);
  useEffect(() => setFields(initial()), [preset.name, preset.modified, fresh]);
  const [armed, setArmed] = useState(false);
  const saving = store.state.crewEdit?.action === 'saveRolePreset' ? store.state.crewEdit : undefined;
  const name = fields.name.trim();
  // A new one, saved: it is selected when the daemon has it, so that an error stays here, under its fields.
  const [pending, setPending] = useState<string | undefined>(undefined);
  useEffect(() => {
    const saved = pending ? store.state.roles.find((role) => role.name.toLowerCase() === pending.toLowerCase()) : undefined;
    if (saved) {
      setPending(undefined);
      onRenamed(saved.name);
    }
  }, [store.state.roles, pending]);
  // Saving under the name of another agent would replace it: a new name, or this one's own.
  const taken = store.state.roles.find(
    (role) => role.name.toLowerCase() !== pending?.toLowerCase() && role.name.toLowerCase() === name.toLowerCase() && (fresh || role.name.toLowerCase() !== preset.name.toLowerCase()),
  );
  const current = (): RolePreset => presetOfNode({ ...fields, name: name || preset.name, key: 0, x: 0, y: 0 });
  const save = (): void => {
    const next = presetOfNode({ ...fields, key: 0, x: 0, y: 0 });
    store.saveRole(next, fresh ? undefined : preset.name);
    if (fresh) setPending(next.name);
    else if (next.name !== preset.name) onRenamed(next.name);
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
        {fresh ? 'New agent' : `Preset ${preset.name}`}
        {preset.builtin && <span class="studio-tag">{preset.modified ? 'yours, from Forchetta' : 'Forchetta'}</span>}
      </p>
      <p class="studio-hint">
        {fresh
          ? 'An agent of your own: its name, what it does, its model and its skills. "Save preset" puts it with the agents on the left, for every team.'
          : preset.builtin && !preset.modified
            ? 'A preset of Forchetta: what you save here is your version of it, and you can restore theirs.'
            : 'Saving changes the preset, not the boxes already on the canvas.'}
      </p>
      <AgentForm fields={fields} worktrees={false} onChange={(patch) => setFields((current) => ({ ...current, ...patch }))} />
      {taken && <p class="studio-note error">There is an agent called {taken.name} already: give this one another name.</p>}
      <div class="studio-actions">
        <button type="button" onClick={() => onAdd(current())}>
          Add to canvas
        </button>
        {!fresh && (
          <button type="button" onClick={duplicate}>
            Duplicate
          </button>
        )}
        {!fresh && (!preset.builtin || preset.modified) &&
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
        <button type="button" class="primary" disabled={!name || !!taken} onClick={save}>
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
        <button type="button" title="Save it as a file, to give to someone else" onClick={() => store.exportTeam(template)}>
          Export
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

export function Studio({
  agents,
  store,
  onClose,
  live,
  maker,
}: {
  agents: readonly Agent[];
  store: Store;
  onClose: () => void;
  live?: string;
  /** The studio of forchetta.dev: a team is made to be exported as a file, not started; no folder of a Mac. */
  maker?: boolean;
}) {
  const recent = useMemo(() => recentFolders(agents), [agents]);
  const [doc, setDocState] = useState<StudioDoc>(() => (live ? liveDocs.get(live) : draft) ?? emptyDoc(live ? '' : (recent[0] ?? '')));
  // A running team (live): its sessions, by the names of the boxes.
  const crew = live ? store.state.crews.find((candidate) => candidate.id === live) : undefined;
  const recipientOf = (node: { name: string }) => crew?.recipients?.find((recipient) => recipient.name.toLowerCase() === node.name.trim().toLowerCase());
  const liveAgentOf = (node: { name: string }): Agent | undefined => {
    const id = recipientOf(node)?.agentId;
    return id ? store.state.agents.get(id) : undefined;
  };
  /** A box of a running team that is not in it yet: added on the canvas, to add to the team. */
  const pending = (node: { name: string }): boolean => !!live && !recipientOf(node);
  /** A change of the canvas: kept for the next opening; the last note goes, unless the change sets its own after. */
  const setDoc = (next: StudioDoc | ((current: StudioDoc) => StudioDoc), keepNote = false): void => {
    const value = typeof next === 'function' ? next(docRef.current) : next;
    if (live) liveDocs.set(live, value);
    else {
      if (value !== docRef.current) history = remember(history, docRef.current, Date.now());
      draft = value;
      draftWatcher?.(value);
    }
    docRef.current = value;
    setDocState(value);
    if (!keepNote) setNote(undefined);
  };
  const [selection, setSelection] = useState<Selection>(undefined);
  const [popover, setPopover] = useState<{ to: number; x: number; y: number } | undefined>(undefined);
  const popoverBox = useRef<HTMLDivElement>(null);
  // The relation opens where the arrow was dropped: moved, if it has to, so that all of it is in the visible part of
  // the canvas (a box near the right or the bottom edge would hide its OK).
  useLayoutEffect(() => {
    const box = popoverBox.current?.getBoundingClientRect();
    const view = viewport.current?.getBoundingClientRect();
    if (!popover || !box || !view) return;
    const margin = 8;
    let dx = Math.min(0, view.right - margin - box.right);
    dx = Math.max(dx, view.left + margin - box.left);
    let dy = Math.min(0, view.bottom - margin - box.bottom);
    dy = Math.max(dy, view.top + margin - box.top);
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) setPopover({ ...popover, x: Math.round(popover.x + dx / zoomRef.current), y: Math.round(popover.y + dy / zoomRef.current) });
  }, [popover]);
  const [drag, setDrag] = useState<Drag | undefined>(undefined);
  const [zoom, setZoomState] = useState(zoomSaved);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** Where the view should be after a zoom: the canvas point under `client` stays under it. */
  const zoomAnchor = useRef<{ client: { x: number; y: number }; point: { x: number; y: number } } | undefined>(undefined);
  const setZoom = (next: number, client?: { x: number; y: number }): void => {
    const value = clampZoom(next);
    const view = viewport.current?.getBoundingClientRect();
    const at = client ?? (view ? { x: view.left + view.width / 2, y: view.top + view.height / 2 } : undefined);
    if (at) zoomAnchor.current = { client: at, point: toCanvas(at.x, at.y) };
    zoomSaved = value;
    setZoomState(value);
  };
  const [menu, setMenu] = useState<{ x: number; y: number; items: { label: string; keys?: string; run: () => void }[] } | undefined>(undefined);
  const section = useRef<HTMLElement>(null);
  useReturnFocus(section, true, true);
  // The view follows the scroll, for the minimap.
  const [, setScrolled] = useState(0);
  const [note, setNote] = useState<{ text: string; error?: boolean } | undefined>(undefined);
  const [clearArmed, setClearArmed] = useState(false);
  const [skillFilter, setSkillFilter] = useState('');
  const surface = useRef<HTMLDivElement>(null);
  const links = useRef<SVGSVGElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | undefined>(undefined);
  const docRef = useRef(doc);
  docRef.current = doc;

  const spawn = store.state.crewSpawn;
  const edit = store.state.crewEdit;
  const issues = problems(maker ? { ...doc, folder: doc.folder.trim() || '/' } : doc, !maker && !live);
  // What does not hold together, worth a look before it starts: it does not stop it.
  const checks = checksOfDoc(doc);
  const checksOf = (key: number): string[] => checks.filter((check) => check.keys.includes(key)).map((check) => check.text);
  const lead = leadKey(doc);
  // What goes on along each arrow of a running team: a request in the queue or at work, an answer, a question.
  const lineStates = crew ? linkStates(crew) : new Map<string, LinkKind>();
  // The replay of a running team: its run from its file and the ledger, at a moment you choose.
  const [replaying, setReplaying] = useState(false);
  const [replayT, setReplayT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const replayData = replaying && live && store.state.crewReplay?.crewId === live ? store.state.crewReplay.replay : undefined;
  const frame = replayData ? replayAt(replayData, replayT) : undefined;
  const startReplay = (): void => {
    if (!live) return;
    setReplaying(true);
    setPlaying(false);
    setSelection(undefined);
    store.requestReplay(live);
  };
  const replayAsked = store.state.crewReplay?.at;
  useEffect(() => {
    if (replaying && replayData) setReplayT(replayData.start);
  }, [replayAsked]);
  // Playing: one event after the other, a little under a second each; at the end it stops.
  useEffect(() => {
    if (!playing || !replayData) return;
    const timer = setTimeout(() => {
      const next = replayData.events.find((event) => event.t > replayT);
      if (next) setReplayT(next.t);
      else setPlaying(false);
    }, 900);
    return () => clearTimeout(timer);
  }, [playing, replayT, replayData]);
  /** What goes along the arrow into a box: the run at the moment of the replay, or the team now. */
  const flowOf = (node: StudioNode): LinkKind | undefined => (frame ? frame.arrows.get(node.name.trim()) : crew ? lineStates.get(recipientOf(node)?.agentId ?? '') : undefined);
  const size = canvasSize(doc);
  const members = doc.nodes.length - (lead !== undefined ? 1 : 0);

  // The panel of macOS answers here: for the folder of a skill, when that asked; else for the folder of the team.
  const folderFor = useRef<((path: string) => void) | undefined>(undefined);
  const chooseFolder = (current: string, put?: (path: string) => void): void => {
    folderFor.current = put;
    store.chooseFolder(current);
  };
  useEffect(() => {
    window.forchettaFolder = (path: string) => {
      const put = folderFor.current;
      folderFor.current = undefined;
      if (put) put(path);
      else setDoc((current) => ({ ...current, folder: path }));
    };
    return () => {
      window.forchettaFolder = undefined;
    };
  }, []);
  useEffect(() => {
    if (!clearArmed) return;
    const timer = setTimeout(() => setClearArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [clearArmed]);
  // A running team: asked again whenever its members change; its canvas keeps where you put the boxes and the
  // agents you added there that are not in the team yet.
  const memberNames = (crew?.recipients ?? []).map((recipient) => recipient.name).join('\n');
  // Who has been in the team: a box of one taken away goes, while one you added and not started yet stays.
  const seenInTeam = useRef(new Set<string>());
  for (const recipient of crew?.recipients ?? []) seenInTeam.current.add(recipient.name.toLowerCase());
  useEffect(() => {
    if (live) store.requestCrewTemplate(live);
  }, [live, memberNames]);
  const liveTeam = store.state.liveTeam;
  useEffect(() => {
    if (!live || liveTeam?.crewId !== live || !liveTeam.template) return;
    const fresh = docOfTemplate(liveTeam.template, liveTeam.cwd ?? '');
    const old = docRef.current;
    if (old.nodes.length === 0) return setDoc(fresh, true);
    const before = new Map(old.nodes.map((node) => [node.name.trim().toLowerCase(), node]));
    const nodes = fresh.nodes.map((node) => {
      const was = before.get(node.name.trim().toLowerCase());
      return was ? { ...node, x: was.x, y: was.y } : node;
    });
    const inTeam = new Set(nodes.map((node) => node.name.trim().toLowerCase()));
    const kept = old.nodes.filter((node) => !inTeam.has(node.name.trim().toLowerCase()) && !seenInTeam.current.has(node.name.trim().toLowerCase()));
    const keyByName = new Map(nodes.map((node) => [node.name.trim().toLowerCase(), node.key]));
    const keptLinks = old.links
      .filter((link) => kept.some((node) => node.key === link.to))
      .map((link) => {
        if (link.from === 'you') return link;
        const from = old.nodes.find((node) => node.key === link.from);
        const key = from ? (keyByName.get(from.name.trim().toLowerCase()) ?? (kept.includes(from) ? from.key : undefined)) : undefined;
        return key === undefined ? undefined : { ...link, from: key };
      })
      .filter((link): link is StudioLink => link !== undefined);
    setDoc({ ...fresh, you: old.you, nodes: [...nodes, ...kept], links: [...fresh.links, ...keptLinks], notes: old.notes }, true);
  }, [liveTeam?.at]);
  /** The member of the running team that a box is, as the daemon names it (the lead included). */
  const editLive = store.state.crewEdit;
  useEffect(() => {
    if (!live || !editLive || editLive.busy) return;
    if (editLive.ok === false) setNote({ text: editLive.error ?? 'the team did not change', error: true });
    else if (editLive.action === 'add') setNote({ text: 'Added: its session starts in the team, with the others.' });
    else if (editLive.action === 'remove') setNote({ text: 'Taken away from the team: its session is closed.' });
  }, [editLive?.at, editLive?.busy]);
  const addToTeam = (node: StudioNode): void => {
    if (!live) return;
    const link = incoming(doc, node.key);
    if (!link) return setNote({ text: `Draw an arrow onto ${node.name} from the one it reports to first.`, error: true });
    const above = link.from === 'you' ? undefined : nodeOf(doc, link.from);
    if (above && pending(above)) return setNote({ text: `Add ${above.name} to the team first: ${node.name} reports to it.`, error: true });
    const isLead = above !== undefined && leadKey(doc) === above.key;
    const paths = pathsOf(node.paths);
    store.editCrew(live, {
      action: 'add',
      member: {
        name: node.name.trim(),
        role: node.role.trim(),
        ...(link.talk ? { talk: link.talk } : {}),
        ...(node.model ? { model: node.model } : {}),
        ...(node.mode ? { mode: node.mode } : {}),
        ...(node.worktree !== undefined ? { worktree: node.worktree } : {}),
        ...(paths.length > 0 ? { paths } : {}),
        ...(node.reviews ? { reviews: true } : {}),
        ...(node.skills.length > 0 ? { skills: node.skills } : {}),
        ...(above && !isLead ? { reportsTo: above.name.trim() } : {}),
        ...(link.relation.trim() ? { relation: link.relation.trim() } : {}),
      },
    });
  };

  // A team file: saved (where), or opened (on the canvas, in place of what was there, which ⌘Z brings back).
  const teamFile = store.state.teamFile;
  useEffect(() => {
    if (!teamFile || teamFile.busy) return;
    if (!teamFile.ok) return setNote({ text: teamFile.error ?? 'it did not work', error: true });
    if (teamFile.action === 'save') return setNote({ text: `Saved in ${teamFile.path}: give it to whoever should have the team.` });
    if (teamFile.ask) {
      setSelection({ kind: 'import' });
      return setNote({ text: 'This team brings skills from GitHub: look at them on the right before they are fetched.' });
    }
    if (teamFile.template) {
      setDoc(docOfTemplate(teamFile.template, docRef.current.folder));
      setSelection(undefined);
      setNote({ text: [`Opened ${teamFile.template.name} from its file: "Save as template" keeps it, ⌘Z brings back what was on the canvas.`, ...(teamFile.notes ?? [])].join(' · ') });
    }
  }, [teamFile?.at, teamFile?.busy]);
  const exportCanvas = (): void => {
    const checked = templateOfDoc(doc);
    if ('error' in checked) return setNote({ text: checked.error, error: true });
    store.exportTeam(checked.template);
  };
  // A team file dropped anywhere on the studio opens.
  const [dropping, setDropping] = useState(false);
  const hasFiles = (event: DragEvent): boolean => [...(event.dataTransfer?.types ?? [])].includes('Files');
  const dropFile = async (event: DragEvent): Promise<void> => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDropping(false);
    const file = event.dataTransfer?.files[0];
    if (file) store.importTeam(await file.text());
  };

  // A team drawn from a description: on the canvas, in place of what was there (⌘Z brings it back).
  const described = store.state.describe;
  // Each drawn team once (also when it came while the studio was closed), and never on the canvas of a running team.
  useEffect(() => {
    if (live || !described || described.at === describedOpened || described.busy || !described.ok || !described.template) return;
    describedOpened = described.at;
    setDoc(docOfTemplate(described.template, docRef.current.folder));
    setSelection(undefined);
    setPopover(undefined);
    setNote({
      text: described.note
        ? `${described.template.name} is on the canvas. ${described.note} ⌘Z brings back what was there.`
        : `Claude drew ${described.template.name}${described.usd ? ` (≈ ${usdText(described.usd)})` : ''}: change what you like, then "Create team" or "Save as template". ⌘Z brings back what was on the canvas.`,
    });
  }, [described?.at, described?.busy]);

  // The result of saving a template or a preset, said once.
  useEffect(() => {
    if (!edit || edit.busy) return;
    if (edit.action === 'saveCrewTemplate') setNote(edit.ok ? { text: 'Saved: it is among the teams on the left, and in "Start from".' } : { text: edit.error ?? 'not saved', error: true });
    if (edit.action === 'saveRolePreset' && edit.ok) setNote({ text: 'Preset saved: it is among the agents on the left.' });
  }, [edit?.at, edit?.busy]);

  /** A point of the window on the canvas. */
  const toCanvas = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = surface.current?.getBoundingClientRect();
    return rect ? { x: (clientX - rect.left) / zoomRef.current, y: (clientY - rect.top) / zoomRef.current } : { x: 0, y: 0 };
  };
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const view = viewport.current;
    zoomAnchor.current = undefined;
    if (!anchor || !view) return;
    const rect = view.getBoundingClientRect();
    view.scrollLeft = anchor.point.x * zoom - (anchor.client.x - rect.left);
    view.scrollTop = anchor.point.y * zoom - (anchor.client.y - rect.top);
  }, [zoom]);
  /** Everything in the view: the zoom that fits, and the scroll to its corner. */
  const fit = (): void => {
    const view = viewport.current;
    if (!view) return;
    const value = fitZoom(docRef.current, view.clientWidth, view.clientHeight);
    const box = contentBox(docRef.current);
    zoomSaved = value;
    setZoomState(value);
    requestAnimationFrame(() => {
      view.scrollLeft = Math.max(0, box.left * value - 40);
      view.scrollTop = Math.max(0, box.top * value - 40);
    });
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
        setDoc((doc) =>
          current.what === 'you'
            ? { ...doc, you: { x, y } }
            : current.note
              ? { ...doc, notes: doc.notes.map((note) => (note.key === current.what ? { ...note, x, y } : note)) }
              : updateNode(doc, current.what, { x, y }),
        );
        update({ ...current, moved: true });
      } else if (current.kind === 'group') {
        const point = toCanvas(event.clientX, event.clientY);
        const moved = current.moved || Math.abs(event.clientX - current.x0) + Math.abs(event.clientY - current.y0) > SLOP;
        if (!moved) return;
        const dx = point.x - current.px;
        const dy = point.y - current.py;
        setDoc((doc) => ({
          ...doc,
          nodes: doc.nodes.map((node) => {
            const start = current.starts.get(node.key);
            return start ? { ...node, x: Math.max(0, Math.round(start.x + dx)), y: Math.max(0, Math.round(start.y + dy)) } : node;
          }),
        }));
        update({ ...current, moved: true });
      } else if (current.kind === 'band') {
        const point = toCanvas(event.clientX, event.clientY);
        update({ ...current, bx: point.x, by: point.y });
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
      if (current.kind === 'group') {
        if (!current.moved) setSelection({ kind: 'node', key: current.key });
        return;
      }
      if (current.kind === 'band') {
        // A click on an empty spot selects nothing; a rectangle, the boxes it touches.
        if (Math.abs(current.bx - current.ax) + Math.abs(current.by - current.ay) < 6) return;
        const keys = nodesIn(doc, { x: current.ax, y: current.ay }, { x: current.bx, y: current.by });
        setSelection(keys.length === 0 ? undefined : keys.length === 1 ? { kind: 'node', key: keys[0]! } : { kind: 'nodes', keys });
        return;
      }
      if (current.kind === 'move') {
        if (!current.moved && current.what !== 'you') setSelection(current.note ? { kind: 'note', key: current.what } : { kind: 'node', key: current.what });
        if (!current.moved && current.what === 'you') setSelection(undefined);
        return;
      }
      if (current.kind === 'link') {
        const point = toCanvas(event.clientX, event.clientY);
        const target = nodeAt(doc, point.x, point.y);
        if (!target) return;
        if (live && !pending(target)) return setNote({ text: `${target.name} is in the running team: it keeps the one it reports to. An arrow goes to an agent you are adding.`, error: true });
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
        setSelection(
          current.kind === 'role'
            ? current.preset === BLANK_AGENT
              ? { kind: 'new-role' }
              : { kind: 'role', name: current.preset.name }
            : current.kind === 'team'
              ? { kind: 'team', name: current.template.name }
              : current.kind === 'tool'
                ? { kind: 'tool', id: current.tool.id }
                : { kind: 'skill', id: current.skill.id },
        );
        return;
      }
      if (!overCanvas(event.clientX, event.clientY)) return;
      const point = toCanvas(event.clientX, event.clientY);
      if (current.kind === 'skill') {
        const target = nodeAt(doc, point.x, point.y);
        if (target && live && !pending(target)) return setNote({ text: `${target.name} is running: its session keeps the skills it started with.`, error: true });
        const result = target ? addSkill(doc, target.key, current.skill.id) : { error: 'Drop a skill on an agent: it is for that agent only.' };
        if ('error' in result) return setNote({ text: result.error, error: true });
        setDoc(result.doc);
        setSelection({ kind: 'node', key: target!.key });
        setNote({ text: `${target!.name} has ${current.skill.id}: it is downloaded when the team starts, outside the project.` });
        return;
      }
      if (current.kind === 'tool') {
        const target = nodeAt(doc, point.x, point.y);
        if (target && live && !pending(target)) return setNote({ text: `${target.name} is running: its session keeps the tools it started with.`, error: true });
        const result = target ? addTool(doc, target.key, current.tool.id) : { error: 'Drop a tool on an agent: it is for that agent only.' };
        if ('error' in result) return setNote({ text: result.error, error: true });
        setDoc(result.doc);
        setSelection({ kind: 'node', key: target!.key });
        setNote({ text: `${target!.name} has the ${current.tool.label}: its session starts with it, and only its session.` });
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

  const startMove = (event: PointerEvent, what: number | 'you', note = false): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    section.current?.focus({ preventScroll: true });
    // ⇧-click: a box more in the selection, or one less.
    if (event.shiftKey && what !== 'you' && !note) {
      const keys = selectedKeys.includes(what) ? selectedKeys.filter((key) => key !== what) : [...selectedKeys, what];
      setSelection(keys.length === 0 ? undefined : keys.length === 1 ? { kind: 'node', key: keys[0]! } : { kind: 'nodes', keys });
      return;
    }
    if (what !== 'you' && !note && selectedKeys.length > 1 && selectedKeys.includes(what)) {
      const point = toCanvas(event.clientX, event.clientY);
      const starts = new Map(doc.nodes.filter((node) => selectedKeys.includes(node.key)).map((node) => [node.key, { x: node.x, y: node.y }]));
      setPopover(undefined);
      begin({ kind: 'group', key: what, starts, px: point.x, py: point.y, x0: event.clientX, y0: event.clientY, moved: false });
      return;
    }
    const point = toCanvas(event.clientX, event.clientY);
    const at = what === 'you' ? doc.you : note ? noteOf(doc, what)! : nodeOf(doc, what)!;
    setPopover(undefined);
    begin({ kind: 'move', what, ...(note ? { note: true } : {}), dx: point.x - at.x, dy: point.y - at.y, x0: event.clientX, y0: event.clientY, moved: false });
  };
  /** A note where there is room, in the part of the canvas you see; it is selected, to write it. */
  const newNote = (): void => {
    const view = viewport.current;
    const z = zoomRef.current;
    const x = ((view?.scrollLeft ?? 0) + Math.max(24, (view?.clientWidth ?? 800) - NOTE_W * z - 48)) / z;
    const y = ((view?.scrollTop ?? 0) + 40) / z + (docRef.current.notes.length % 6) * 24;
    const added = addNote(docRef.current, x, y);
    setDoc(added.doc);
    setSelection({ kind: 'note', key: added.key });
  };
  const startLink = (event: PointerEvent, from: From): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setPopover(undefined);
    const point = toCanvas(event.clientX, event.clientY);
    begin({ kind: 'link', from, x: point.x, y: point.y });
  };
  const startPalette = (event: PointerEvent, item: { preset: RolePreset } | { template: CrewTemplate } | { skill: SkillInfo } | { tool: McpServerInfo }): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const base = { x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, moved: false };
    begin(
      'preset' in item
        ? { kind: 'role', preset: item.preset, ...base }
        : 'template' in item
          ? { kind: 'team', template: item.template, ...base }
          : 'tool' in item
            ? { kind: 'tool', tool: item.tool, ...base }
            : { kind: 'skill', skill: item.skill, ...base },
    );
  };

  const remove = (): void => {
    const running = (key: number): boolean => {
      const node = nodeOf(doc, key);
      return !!node && !!live && !pending(node);
    };
    if (live && ((selection?.kind === 'node' && running(selection.key)) || (selection?.kind === 'nodes' && selection.keys.some(running)) || (selection?.kind === 'link' && running(selection.to)))) {
      return setNote({ text: 'A member of the running team is taken away from its panel ("Remove from the team"): its session closes.', error: true });
    }
    if (selection?.kind === 'nodes') {
      setDoc(removeNodes(doc, selection.keys));
      setSelection(undefined);
    } else if (selection?.kind === 'note') {
      setDoc({ ...doc, notes: doc.notes.filter((note) => note.key !== selection.key) });
      setSelection(undefined);
    } else if (selection?.kind === 'node') {
      setDoc(removeNode(doc, selection.key));
      setSelection(undefined);
    } else if (selection?.kind === 'link') {
      setDoc(removeLink(doc, selection.to));
      setSelection(undefined);
    }
  };
  // ⌘C, ⌘V, ⌘D, ⌘A: the selected boxes with the arrows between them; a paste comes a little lower each time.
  const selectedKeys = selection?.kind === 'nodes' ? selection.keys : selection?.kind === 'node' ? [selection.key] : [];
  const copy = (): void => {
    const clip = clipOf(docRef.current, selectedKeys);
    if (!clip) return;
    clipboard = clip;
    pasteShift = 0;
    setNote({ text: `Copied ${clip.nodes.length === 1 ? clip.nodes[0]!.name : `${clip.nodes.length} agents`}: ⌘V puts ${clip.nodes.length === 1 ? 'it' : 'them'} on the canvas.` });
  };
  const put = (clip: StudioClip, shift: number): void => {
    const pasted = pasteClip(docRef.current, clip, shift, shift);
    setDoc(pasted.doc);
    setSelection(pasted.keys.length === 1 ? { kind: 'node', key: pasted.keys[0]! } : { kind: 'nodes', keys: pasted.keys });
  };
  const paste = (): void => {
    if (!clipboard) return setNote({ text: 'Nothing copied yet: select boxes, then ⌘C.' });
    pasteShift += 32;
    put(clipboard, pasteShift);
  };
  const duplicate = (): void => {
    const clip = clipOf(docRef.current, selectedKeys);
    if (clip) put(clip, 32);
  };
  const selectAll = (): void => {
    const keys = docRef.current.nodes.map((node) => node.key);
    if (keys.length > 0) setSelection(keys.length === 1 ? { kind: 'node', key: keys[0]! } : { kind: 'nodes', keys });
  };
  /** The menu of the right button: on a box, a note, or an empty spot. */
  const openMenu = (event: MouseEvent, target: { node: number } | { note: number } | 'canvas'): void => {
    event.preventDefault();
    event.stopPropagation();
    setPopover(undefined);
    const items: { label: string; keys?: string; run: () => void }[] = [];
    if (target === 'canvas') {
      const at = toCanvas(event.clientX, event.clientY);
      if (clipboard) items.push({ label: 'Paste', keys: '⌘V', run: paste });
      items.push({
        label: 'Add a note here',
        run: () => {
          const added = addNote(docRef.current, at.x, at.y);
          setDoc(added.doc);
          setSelection({ kind: 'note', key: added.key });
        },
      });
      if (docRef.current.nodes.length > 0) items.push({ label: 'Select all', keys: '⌘A', run: selectAll }, { label: 'Tidy up', run: () => setDoc(tidy(docRef.current)) }, { label: 'Fit to the view', run: fit });
    } else if ('note' in target) {
      setSelection({ kind: 'note', key: target.note });
      items.push({ label: 'Remove note', keys: '⌫', run: () => setDoc({ ...docRef.current, notes: docRef.current.notes.filter((note) => note.key !== target.note) }) });
    } else {
      const keys = selectedKeys.includes(target.node) ? selectedKeys : [target.node];
      if (!selectedKeys.includes(target.node)) setSelection({ kind: 'node', key: target.node });
      const one = keys.length === 1 ? nodeOf(docRef.current, keys[0]!) : undefined;
      items.push(
        { label: keys.length === 1 ? 'Duplicate' : `Duplicate ${keys.length} agents`, keys: '⌘D', run: () => {
          const clip = clipOf(docRef.current, keys);
          if (clip) put(clip, 32);
        } },
        { label: 'Copy', keys: '⌘C', run: () => {
          clipboard = clipOf(docRef.current, keys);
          pasteShift = 0;
        } },
      );
      if (one) items.push({ label: 'Save as preset', run: () => store.saveRole(presetOfNode(one)) });
      items.push({ label: keys.length === 1 ? 'Remove' : `Remove ${keys.length} agents`, keys: '⌫', run: () => {
        setDoc(removeNodes(docRef.current, keys));
        setSelection(undefined);
      } });
    }
    setMenu({ x: event.clientX, y: event.clientY, items });
  };
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(undefined);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  // ⌘Z and ⇧⌘Z: the canvas a step back or forward. What is selected stays, if it is still there.
  const step = (back: boolean): void => {
    if (live) return;
    const moved = back ? undoStep(history, docRef.current) : redoStep(history, docRef.current);
    if (!moved) return;
    history = moved.history;
    draft = moved.doc;
    draftWatcher?.(moved.doc);
    docRef.current = moved.doc;
    setDocState(moved.doc);
    setPopover(undefined);
    setSelection((current) =>
      (current?.kind === 'node' && !nodeOf(moved.doc, current.key)) ||
      (current?.kind === 'link' && !incoming(moved.doc, current.to)) ||
      (current?.kind === 'note' && !noteOf(moved.doc, current.key)) ||
      (current?.kind === 'nodes' && current.keys.some((key) => !nodeOf(moved.doc, key)))
        ? undefined
        : current,
    );
    setNote({ text: back ? 'Undone: ⇧⌘Z does it again.' : 'Done again.' });
  };

  const onKey = (event: KeyboardEvent): void => {
    const field = (event.target as HTMLElement).closest('input, textarea, select');
    // In a field, ⌘Z undoes the typing there, as anywhere.
    if (!field && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      step(!event.shiftKey);
      return;
    }
    if (!field && (event.metaKey || event.ctrlKey)) {
      const key = event.key.toLowerCase();
      const act: Record<string, () => void> = { c: copy, v: paste, d: duplicate, a: selectAll, '=': () => setZoom(zoom * 1.2), '+': () => setZoom(zoom * 1.2), '-': () => setZoom(zoom / 1.2), '0': () => setZoom(1) };
      if (act[key]) {
        event.preventDefault();
        act[key]();
        return;
      }
    }
    if (event.key === 'Escape' && menu) {
      setMenu(undefined);
      return;
    }
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
    store.createCrew(checked.spec, doc.goal);
  };
  const saveTemplate = (): void => {
    const checked = templateOfDoc(doc);
    if ('error' in checked) return setNote({ text: checked.error, error: true });
    store.saveTemplate({ template: checked.template });
  };

  const selectedNode = selection?.kind === 'node' ? nodeOf(doc, selection.key) : undefined;
  const selectedRole = selection?.kind === 'role' ? store.state.roles.find((role) => role.name === selection.name) : undefined;
  const selectedTeam = selection?.kind === 'team' ? store.state.templates.find((template) => template.name === selection.name) : undefined;
  const ghost = drag && (drag.kind === 'role' || drag.kind === 'team' || drag.kind === 'skill' || drag.kind === 'tool') && drag.moved ? drag : undefined;
  const selectedSkill = selection?.kind === 'skill' ? skillById(selection.id) : undefined;
  const skillsUsed = skillsOf(doc);
  const drawing = drag?.kind === 'link' ? drag : undefined;
  const drawFrom = drawing ? (drawing.from === 'you' ? { x: doc.you.x + YOU_W / 2, y: doc.you.y + YOU_H } : (() => {
    const node = nodeOf(doc, drawing.from as number);
    return node ? { x: node.x + NODE_W / 2, y: node.y + NODE_H } : undefined;
  })()) : undefined;

  return (
    <section
      ref={section}
      class={`broadcast studio${dropping ? ' dropping' : ''}`}
      aria-label="Team studio"
      onKeyDown={onKey}
      tabIndex={-1}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => event.target === event.currentTarget && setDropping(false)}
      onDrop={(event) => void dropFile(event)}
    >
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
          {members} {members === 1 ? 'member' : 'members'}
        </span>
        <span class="studio-spacer" />
        {!live && (
          <button type="button" class="quiet studio-undo" title={keyText('Undo the last change of the canvas (⌘Z)')} aria-label="Undo" disabled={history.past.length === 0} onClick={() => step(true)}>
            ↶
          </button>
        )}
        {!live && (
          <button type="button" class="quiet studio-undo" title={keyText('Redo (⇧⌘Z)')} aria-label="Redo" disabled={history.future.length === 0} onClick={() => step(false)}>
            ↷
          </button>
        )}
        {!live && (
          <button type="button" class={`quiet${selection?.kind === 'describe' ? ' on' : ''}`} title="Say what the team is for: Claude draws it on the canvas" onClick={() => setSelection({ kind: 'describe' })}>
            Describe…
          </button>
        )}
        {live && (
          <button type="button" class={`quiet${replaying ? ' on' : ''}`} title="The run of the team again, step by step: what went along each arrow, what each agent cost and wrote" onClick={() => (replaying ? setReplaying(false) : startReplay())}>
            Replay
          </button>
        )}
        <button type="button" class="quiet" title="A note on the canvas, for whoever opens the team after you" onClick={newNote}>
          + note
        </button>
        <button type="button" title="Lay the boxes out as a tree, each one under the one that leads it" disabled={doc.nodes.length === 0} onClick={() => setDoc(tidy(doc))}>
          Tidy up
        </button>
        {live ? null : clearArmed ? (
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
        {!live && (
          <button type="button" class="quiet" title="Open a team from its file: drop the file on the studio, or paste it" onClick={() => setSelection({ kind: 'import' })}>
            Import
          </button>
        )}
        <button type="button" class={maker ? 'primary' : 'quiet'} disabled={doc.nodes.length === 0 || !doc.name.trim()} title="Save this team as a file, to open in Forchetta or give to someone else" onClick={exportCanvas}>
          Export
        </button>
        <button type="button" disabled={doc.nodes.length === 0 || !doc.name.trim()} title="Keep this team, with where its boxes stand, among the teams on the left and in 'Start from'" onClick={saveTemplate}>
          Save as template
        </button>
        {!live && !maker && (
          <button type="button" class="primary" disabled={issues.length > 0 || spawn?.busy === true || !doc.folder.trim()} onClick={create}>
            {spawn?.busy ? 'Starting…' : 'Create team'}
          </button>
        )}
        {maker ? (
          <a class="quiet studio-home" href="../">
            forchetta.dev
          </a>
        ) : (
          <button type="button" class="quiet" title="Close the studio: the canvas stays as it is until you come back" onClick={onClose}>
            Close
          </button>
        )}
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
        <div
          class={`studio-preset studio-new${selection?.kind === 'new-role' ? ' on' : ''}`}
          title="An agent of your own. Drag it onto the canvas and fill it there, or click it to make a preset you can use in every team."
          onPointerDown={(event) => startPalette(event, { preset: BLANK_AGENT })}
        >
          <strong>+ new agent</strong>
          <span>yours, from scratch</span>
        </div>
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
        <p class="studio-section" title="MCP servers, chosen and pinned to a version: drop one on an agent, and only its session has it.">
          Tools
        </p>
        {MCP_SERVERS.map((tool) => (
          <div
            key={tool.id}
            class={`studio-preset studio-skill${selection?.kind === 'tool' && selection.id === tool.id ? ' on' : ''}`}
            title={`${tool.summary}\n\n${tool.package}@${tool.version} · ${tool.license}. Drag it onto an agent; click it for more.`}
            onPointerDown={(event) => startPalette(event, { tool })}
          >
            <strong>{tool.label}</strong>
            <span>
              {tool.id} · {tool.license}
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
        <div
          class={`studio-preset studio-new${selection?.kind === 'new-skill' ? ' on' : ''}`}
          title={`A skill of yours: the link of its folder on GitHub, or a folder of this ${MACHINE}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            setSelection({ kind: 'new-skill' });
          }}
        >
          <strong>+ add a skill</strong>
          <span>from GitHub, or a folder</span>
        </div>
        {SKILL_GROUPS.map(([group, label]) => {
          const words = skillFilter.trim().toLowerCase();
          const shown = allSkills().filter((skill) => skill.group === group && (!words || `${skill.id} ${skill.summary} ${skill.repo} ${skill.local ?? ''}`.toLowerCase().includes(words)));
          if (shown.length === 0) return null;
          return (
            <div key={group} class="studio-skill-group">
              <span class="studio-skill-group-name">{label}</span>
              {shown.map((skill) => (
                <div
                  key={skill.id}
                  class={`studio-preset studio-skill${selection?.kind === 'skill' && selection.id === skill.id ? ' on' : ''}`}
                  title={`${skill.summary}\n\n${skill.local ?? `${skill.repo} · ${skill.license}`}. Drag it onto an agent; click it for more.`}
                  onPointerDown={(event) => startPalette(event, { skill })}
                >
                  <strong>{skill.id}</strong>
                  <span>
                    {skill.local ? 'your folder' : skill.repo.split('/')[0]} · {skill.kb >= 1000 ? `${(skill.kb / 1024).toFixed(1)} MB` : `${skill.kb} KB`}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </aside>

      <div class={`studio-stage${replaying ? ' replaying' : ''}`}>
      <div
        ref={viewport}
        class="studio-canvas"
        onPointerDown={(event) => {
          // An empty spot of the canvas: the surface, or the layer of the arrows over all of it, not an arrow. A drag
          // from there draws a rectangle that selects the boxes it touches.
          if (event.target === surface.current || event.target === links.current) {
            setSelection(undefined);
            setPopover(undefined);
            if (event.button !== 0) return;
            event.preventDefault();
            section.current?.focus({ preventScroll: true });
            const point = toCanvas(event.clientX, event.clientY);
            begin({ kind: 'band', ax: point.x, ay: point.y, bx: point.x, by: point.y });
          }
        }}
        onContextMenu={(event) => (event.target === surface.current || event.target === links.current) && openMenu(event, 'canvas')}
        onWheel={(event) => {
          // A pinch on the trackpad, or ⌘ and the wheel: zoom where the pointer is.
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          setZoom(zoomRef.current * Math.exp(-event.deltaY / 300), { x: event.clientX, y: event.clientY });
        }}
        onScroll={() => setScrolled((n) => n + 1)}
      >
        <div class="studio-sizer" style={{ width: `${size.width * zoom}px`, height: `${size.height * zoom}px` }}>
        <div ref={surface} class="studio-surface" style={{ width: `${size.width}px`, height: `${size.height}px`, transform: zoom === 1 ? undefined : `scale(${zoom})` }}>
          <svg ref={links} class="studio-links" width={size.width} height={size.height} aria-hidden="true">
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
              const target = nodeOf(doc, link.to);
              const flowing = target ? flowOf(target) : undefined;
              return (
                <g key={link.to}>
                  <path d={d} class={`studio-link${on ? ' on' : ''}${(link.talk ?? doc.talk) === 'oneway' ? ' oneway' : ''}${flowing ? ` live-${flowing}` : ''}`} marker-end={`url(#${on ? 'studio-arrow-on' : 'studio-arrow'})`} />
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
                title={
                  isLead
                    ? 'The lead of the team'
                    : `${talk === 'twoway' ? 'Answers' : 'Executes only'}${link.relation.trim() ? `: ${firstLine(link.relation)}` : ''}${link.approve ? '. Its requests wait for your approval' : ''}. Click to change.`
                }
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  setPopover(undefined);
                  setSelection({ kind: 'link', to: link.to });
                }}
              >
                {isLead ? 'lead' : talk === 'twoway' ? '⇄' : '→'}
                {!isLead && link.relation.trim() ? ' ✎' : ''}
                {!isLead && link.approve ? <span class="studio-approve-mark"> · you approve</span> : null}
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
              hasTools(node.tools) ? toolsText(node.tools) : undefined,
            ].filter(Boolean);
            const loose = !incoming(doc, node.key);
            const running = live ? liveAgentOf(node) : undefined;
            const waiting = live && pending(node);
            const then = frame?.agents.get(node.name.trim());
            if (frame) {
              traits.splice(
                0,
                traits.length,
                ...(then?.on !== undefined ? [`on #${then.on}`] : ['free']),
                ...(then && then.usd > 0 ? [`≈ ${usdText(then.usd)}`] : []),
                ...(then && then.files.length > 0 ? [`${then.files.length} ${then.files.length === 1 ? 'file' : 'files'}`] : []),
              );
            } else if (running) {
              const used = crewUsage([running]);
              const total = used ? tokensTotal(used.tokens) : 0;
              traits.splice(0, traits.length, STATE_LABEL[running.state], ...(used && used.usd > 0 ? [`≈ ${usdText(used.usd)}`] : []), ...(total > 0 ? [`${shortTokens(total)} tok`] : []));
            } else if (waiting) traits.splice(0, traits.length, 'not in the team yet');
            return (
              <div
                key={node.key}
                class={`studio-node${selectedKeys.includes(node.key) ? ' on' : ''}${loose ? ' loose' : ''}${waiting ? ' pending' : ''}`}
                data-live={frame ? (then?.on !== undefined ? 'working' : 'idle') : running?.state}
                style={{ left: `${node.x}px`, top: `${node.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }}
                data-target={
                  (drawing && nodeAt(doc, drawing.x, drawing.y)?.key === node.key) || ((ghost?.kind === 'skill' || ghost?.kind === 'tool') && (() => {
                    const point = toCanvas(ghost.x, ghost.y);
                    return overCanvas(ghost.x, ghost.y) && nodeAt(doc, point.x, point.y)?.key === node.key;
                  })())
                    ? ''
                    : undefined
                }
                onPointerDown={(event) => startMove(event, node.key)}
                onContextMenu={(event) => openMenu(event, { node: node.key })}
              >
                <div class="studio-node-head">
                  <strong>{node.name.trim() || 'unnamed'}</strong>
                  {lead === node.key && <span class="studio-tag">lead</span>}
                  {!frame && checksOf(node.key).length > 0 && (
                    <span class="studio-warn" title={checksOf(node.key).join('\n')} aria-label={`Worth checking: ${checksOf(node.key).join(' ')}`}>
                      ▲
                    </span>
                  )}
                </div>
                <p class="studio-node-role">{firstLine(node.role) || 'No role yet: click to write it'}</p>
                <div class="studio-node-traits">{traits.join(' · ') || 'default model and permissions'}</div>
                <span class="studio-handle" title="Drag onto an agent it leads" onPointerDown={(event) => startLink(event, node.key)} />
              </div>
            );
          })}
          {doc.notes.map((note) => (
            <div
              key={note.key}
              class={`studio-sticky${selection?.kind === 'note' && selection.key === note.key ? ' on' : ''}`}
              style={{ left: `${note.x}px`, top: `${note.y}px`, width: `${NOTE_W}px` }}
              onPointerDown={(event) => startMove(event, note.key, true)}
              onContextMenu={(event) => openMenu(event, { note: note.key })}
            >
              {note.text.trim() || <span class="studio-hint">An empty note: click it to write it.</span>}
            </div>
          ))}
          {popover && nodeOf(doc, popover.to) && incoming(doc, popover.to) && (
            <div ref={popoverBox} class="studio-popover" style={{ left: `${popover.x}px`, top: `${popover.y}px` }} onPointerDown={(event) => event.stopPropagation()}>
              <RelationForm
                doc={doc}
                to={popover.to}
                {...(live && !pending(nodeOf(doc, popover.to)!)
                  ? {
                      onTalk: (talk: Talk) => store.editCrew(live, { action: 'talk', name: nodeOf(doc, popover.to)!.name.trim(), talk }),
                      onApprove: (approve: boolean) => store.editCrew(live, { action: 'approve', name: nodeOf(doc, popover.to)!.name.trim(), approve }),
                    }
                  : {})}
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
          {drag?.kind === 'band' && (
            <div
              class="studio-band"
              style={{ left: `${Math.min(drag.ax, drag.bx)}px`, top: `${Math.min(drag.ay, drag.by)}px`, width: `${Math.abs(drag.bx - drag.ax)}px`, height: `${Math.abs(drag.by - drag.ay)}px` }}
            />
          )}
        </div>
        </div>
      </div>
      <div class="studio-zoom" role="group" aria-label="Zoom">
        <button type="button" class="quiet" title={keyText('Zoom out (⌘−)')} onClick={() => setZoom(zoom / 1.2)}>
          −
        </button>
        <button type="button" class="quiet studio-zoom-value" title={keyText('Back to 100% (⌘0)')} onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" class="quiet" title={keyText('Zoom in (⌘+); a pinch on the trackpad works too')} onClick={() => setZoom(zoom * 1.2)}>
          +
        </button>
        <button type="button" class="quiet" title="Everything in the view" disabled={doc.nodes.length === 0} onClick={fit}>
          Fit
        </button>
      </div>
      <Minimap doc={doc} size={size} zoom={zoom} view={viewport.current} />
      {replaying &&
        (replayData ? (
          <ReplayBar
            data={replayData}
            t={replayT}
            playing={playing}
            onTime={(t) => {
              setPlaying(false);
              setReplayT(t);
            }}
            onPlay={() => {
              if (!playing && !replayData.events.some((event) => event.t > replayT)) setReplayT(replayData.start);
              setPlaying(!playing);
            }}
            onClose={() => {
              setReplaying(false);
              setPlaying(false);
            }}
          />
        ) : (
          <div class="studio-replay">
            <span class="studio-replay-event">{store.state.crewReplay?.crewId === live ? 'Nothing to replay yet: the first request starts the run.' : 'Reading the run of the team…'}</span>
            <button type="button" class="quiet" onClick={() => setReplaying(false)}>
              Live
            </button>
          </div>
        ))}
      </div>

      <aside class="studio-props" aria-label="Properties">
        {selection?.kind === 'nodes' ? (
          <>
            <p class="studio-title">{selection.keys.length} agents</p>
            <ul class="studio-list">
              {selection.keys.map((key) => (
                <li key={key}>{nodeOf(doc, key)?.name ?? ''}</li>
              ))}
            </ul>
            <p class="studio-hint">Drag one of them to move them all. {keyText('⇧-click')} adds a box or takes it away; a rectangle from an empty spot selects the boxes it touches.</p>
            <div class="studio-actions">
              <button type="button" onClick={duplicate}>
                Duplicate
              </button>
              <button type="button" onClick={copy}>
                Copy
              </button>
              <button type="button" class="quiet" onClick={remove}>
                Remove
              </button>
            </div>
          </>
        ) : selection?.kind === 'import' ? (
          <ImportTeam store={store} />
        ) : selection?.kind === 'describe' ? (
          <DescribeForm store={store} maker={maker} roles={store.state.roles} onImport={() => setSelection({ kind: 'import' })} />
        ) : selection?.kind === 'tool' && mcpServerById(selection.id) ? (
          <ToolCard tool={mcpServerById(selection.id)!} />
        ) : selection?.kind === 'note' && noteOf(doc, selection.key) ? (
          <>
            <p class="studio-title">Note</p>
            <Text
              label="Text"
              area
              value={noteOf(doc, selection.key)!.text}
              max={NOTE_MAX}
              placeholder="What whoever opens this team should know: why it is made so, how to start it"
              onInput={(text) => setDoc({ ...doc, notes: doc.notes.map((note) => (note.key === selection.key ? { ...note, text } : note)) })}
            />
            <p class="studio-hint">Kept with the template, where it stands; the agents do not read it. The rules for them are in the panel of the team.</p>
            <div class="studio-actions">
              <button type="button" class="quiet" onClick={remove}>
                Remove note
              </button>
            </div>
          </>
        ) : selectedNode && live && !pending(selectedNode) ? (
          <LiveMember
            node={selectedNode}
            lead={lead === selectedNode.key}
            above={incoming(doc, selectedNode.key) ? fromName(doc, incoming(doc, selectedNode.key)!.from) : undefined}
            agent={liveAgentOf(selectedNode)}
            store={store}
            onPaths={(paths) => live && store.editCrew(live, { action: 'paths', name: selectedNode.name.trim(), paths })}
            onRemove={() => live && store.editCrew(live, { action: 'remove', name: selectedNode.name.trim() })}
          />
        ) : selectedNode ? (
          <>
            <p class="studio-title">
              {selectedNode.name.trim() || 'Agent'}
              {lead === selectedNode.key && <span class="studio-tag">lead</span>}
              {live && <span class="studio-tag">not in the team yet</span>}
            </p>
            <p class="studio-hint">
              {incoming(doc, selectedNode.key)
                ? `Reports to ${fromName(doc, incoming(doc, selectedNode.key)!.from)}.`
                : 'Not connected yet: drag an arrow onto it from the one it reports to.'}
            </p>
            {checksOf(selectedNode.key).length > 0 && (
              <ul class="studio-list studio-checks" aria-label="Worth checking">
                {checksOf(selectedNode.key).map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}
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
              {live && (
                <button type="button" class="primary" disabled={!selectedNode.name.trim() || editLive?.busy === true} title="Start its session in the running team, under the one its arrow comes from" onClick={() => addToTeam(selectedNode)}>
                  Add to the team
                </button>
              )}
            </div>
          </>
        ) : selection?.kind === 'link' && incoming(doc, selection.to) ? (
          <RelationForm
            doc={doc}
            to={selection.to}
            onChange={setDoc}
            onRemove={remove}
            {...(live && nodeOf(doc, selection.to) && !pending(nodeOf(doc, selection.to)!)
              ? {
                  onTalk: (talk: Talk) => store.editCrew(live, { action: 'talk', name: nodeOf(doc, selection.to)!.name.trim(), talk }),
                  onApprove: (approve: boolean) => store.editCrew(live, { action: 'approve', name: nodeOf(doc, selection.to)!.name.trim(), approve }),
                }
              : {})}
          />
        ) : selection?.kind === 'new-role' ? (
          <RoleEditor preset={BLANK_AGENT} fresh store={store} onAdd={(preset) => addPreset(preset)} onRenamed={(name) => setSelection({ kind: 'role', name })} />
        ) : selectedRole ? (
          <RoleEditor preset={selectedRole} store={store} onAdd={(preset) => addPreset(preset)} onRenamed={(name) => setSelection({ kind: 'role', name })} />
        ) : selectedTeam ? (
          <TeamCard template={selectedTeam} store={store} onOpen={() => openTeam(selectedTeam)} onAdd={() => addTeam(selectedTeam)} />
        ) : selection?.kind === 'new-skill' ? (
          <AddSkill store={store} onChoose={maker ? undefined : chooseFolder} onAdded={(id) => setSelection({ kind: 'skill', id })} />
        ) : selectedSkill ? (
          <SkillCard skill={selectedSkill} store={store} />
        ) : live && replayData ? (
          <>
            <p class="studio-title">
              Replay of {crew?.name ?? doc.name}
              <span class="studio-tag">{replayData.events.length} events</span>
            </p>
            <p class="studio-hint">
              Each arrow lights up while a request goes along it (orange; amber when it waits for your approval), green when an answer goes back. Each box shows what its agent had cost and written until then. Click an event to go there.
            </p>
            <ol class="studio-replay-list">
              {replayData.events.map((event, index) => (
                <li key={`${event.t}-${index}`} class={frame && index === frame.index ? 'on' : frame && index > frame.index ? 'later' : undefined}>
                  <button
                    type="button"
                    class="quiet"
                    onClick={() => {
                      setPlaying(false);
                      setReplayT(event.t);
                    }}
                  >
                    <span class="studio-replay-at">{clockOf(event.t)}</span> {eventLine(event)}
                  </button>
                </li>
              ))}
            </ol>
          </>
        ) : live ? (
          <>
            <p class="studio-title">
              Team {crew?.name ?? doc.name}
              <span class="studio-tag">running</span>
            </p>
            <p class="studio-hint">
              Its sessions, as they work: each box says what its agent is doing and what it used, each arrow what goes along it (orange, a request; green, an answer coming back; amber, a question).
            </p>
            <ul class="studio-list">
              <li>
                Folder <span class="studio-path">{doc.folder || '—'}</span>
              </li>
            </ul>
            {doc.rules.trim() && <p class="studio-hint">Its rules: {doc.rules.trim()}</p>}
            <p class="studio-hint">
              While it runs you can add an agent (drag it here, draw its arrow, "Add to the team"), change → / ⇄ on an arrow, change the files of a member, or take one away. Roles, models and skills stay as they started: "Save as template" keeps the team, with your changes, for its next start.
            </p>
          </>
        ) : (
          <>
            <p class="studio-title">The team</p>
            {maker && <p class="studio-hint">Make it here, then "Export": the file opens in Forchetta ("Import" in its studio, or drop the file there), where you choose its folder and start it.</p>}
            {!maker && (
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
                <button type="button" title="Choose the folder" onClick={() => chooseFolder(doc.folder)}>
                  Choose…
                </button>
              </div>
            </label>
            )}
            {!maker && recent.length > 0 && (
              <div class="studio-chips">
                {recent.map((path) => (
                  <button key={path} type="button" class={`chip${path === doc.folder ? ' on' : ''}`} title={path} aria-pressed={path === doc.folder} onClick={() => setDoc({ ...doc, folder: path })}>
                    {lastPart(path)}
                  </button>
                ))}
              </div>
            )}
            <Text
              label="Rules of the team"
              area
              value={doc.rules}
              max={RULES_MAX}
              placeholder="What every agent follows, whatever its role: the conventions of the project, how to commit, what never to do"
              onInput={(rules) => setDoc({ ...doc, rules })}
            />
            <p class="studio-hint">Every session of the team gets them with its role. Nothing is written in the folder of the project.</p>
            <Text
              label="It delivers"
              value={doc.deliverable ?? ''}
              max={DELIVERABLE_MAX}
              placeholder="What it hands over: a pull request, docs/report.md, a report"
              onInput={(deliverable) => setDoc({ ...doc, deliverable })}
            />
            <p class="studio-hint">The lead says when it is ready (the tool deliver), and you are told. Optional.</p>
            <ParamsFields doc={doc} maker={maker} onChange={setDoc} />
            {!maker && (
              <>
                <Text
                  label="Its first goal"
                  area
                  value={doc.goal ?? ''}
                  max={20_000}
                  placeholder="What to do first: it goes to the lead as soon as the team starts (to every member when you lead). Optional: you can write it in the panel of the team later."
                  onInput={(goal) => setDoc({ ...doc, goal })}
                />
              </>
            )}
            <Text label="Budget, in dollars" value={doc.budget ?? ''} max={12} placeholder="none: for example 20" mono onInput={(budget) => setDoc({ ...doc, budget })} />
            <p class="studio-hint">{doc.budget?.trim() && !cleanBudget(doc.budget) ? 'A number of dollars, like 20 or 12.50.' : 'When its sessions cost more, you are told once. Nothing stops: a warning, not a limit.'}</p>
            <label class="studio-field">
              <span>An arrow, by default</span>
              <span class="view-switch" role="group" aria-label="How an agent talks with the one above it, by default">
                {(['twoway', 'oneway'] as const).map((value: Talk) => (
                  <button key={value} type="button" class={doc.talk === value ? 'on' : undefined} aria-pressed={doc.talk === value} onClick={() => setDoc({ ...doc, talk: value })}>
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
            {checks.length > 0 && (
              <>
                <p class="studio-section">Worth checking</p>
                <ul class="studio-list studio-checks">
                  {checks.map((check) => (
                    <li key={check.text}>{check.text}</li>
                  ))}
                </ul>
                <p class="studio-hint">It starts anyway: these are what in its settings works against itself.</p>
              </>
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
          {spawn?.error ??
            (note ? keyText(note.text) : undefined) ??
            (live
              ? 'Running: a box says what its agent does, an arrow what goes along it. Add an agent by dragging it here and drawing its arrow.'
              : issues.length > 0
                ? issues[0]
                : checks.length > 0
                  ? `Ready, but worth checking${checks.length > 1 ? ` (${checks.length})` : ''}: ${checks[0]!.text}`
                  : maker
                    ? 'Ready: "Export" saves it as a file; in Forchetta, "Import" opens it. This browser keeps the canvas as you go.'
                    : 'Ready: "Create team" starts it, "Save as template" keeps it.')}
        </span>
      </footer>

      {ghost && (
        <div class="studio-ghost" style={{ left: `${ghost.x}px`, top: `${ghost.y}px` }}>
          {ghost.kind === 'role' ? ghost.preset.name : ghost.kind === 'team' ? `${ghost.template.name} (team)` : ghost.kind === 'tool' ? `${ghost.tool.label} (tool)` : `${ghost.skill.id} (skill)`}
        </div>
      )}
      {menu && (
        <div class="studio-menu" role="menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }} onPointerDown={(event) => event.stopPropagation()}>
          {menu.items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(undefined);
                item.run();
              }}
            >
              <span>{item.label}</span>
              {item.keys && <kbd>{keyText(item.keys)}</kbd>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

