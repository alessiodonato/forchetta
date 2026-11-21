import { type AgentTools, hasTools, mcpServerById } from '../shared/agent-tools.ts';
import { cleanBudget, cleanCrewSpec, type CrewMemberSpec, type CrewSpec, type CrewTemplate, MEMBER_NAME_MAX, missingParams, paramsText, paramsUsed, pathsText, type RolePreset, type Talk, type TeamParam } from '../shared/crew.ts';
import { skillById, SKILLS_PER_AGENT_MAX } from '../shared/skills.ts';

// The studio of teams (Studio.tsx draws it): a canvas with "You" on top and a box for each agent, linked by arrows.
// An arrow goes from the one who leads to the one who reports to it, and carries the relation of the two: → / ⇄ and
// its prompt. Each box has one arrow coming in at most, and no circle. It becomes a team (shared/crew.ts) this way:
// when You point at one box only, and that box leads others, it is the Claude lead; otherwise you lead, and the
// boxes you point at are the members at the top. No DOM here: the tests use it.

/** The size of a box and of You on the canvas, for the arrows and the layout. */
export const NODE_W = 224;
export const NODE_H = 104;
export const YOU_W = 120;
export const YOU_H = 44;
const GAP_X = 32;
const GAP_Y = 72;
const MARGIN = 32;

export interface StudioNode {
  key: number;
  x: number;
  y: number;
  name: string;
  role: string;
  model: string;
  mode: string;
  /** Undefined: the choice of the team. */
  worktree?: boolean;
  /** Its files, as written: "src/ui/, docs/". */
  paths: string;
  reviews?: boolean;
  /** Its skills, from the catalog (shared/skills.ts). */
  skills: string[];
  /** Its tools: limits, MCP servers of the catalog (shared/agent-tools.ts). */
  tools?: AgentTools;
}

/** Where an arrow starts: a box, or You. */
export type From = number | 'you';

export interface StudioLink {
  from: From;
  to: number;
  /** Undefined: the default of the team. */
  talk?: Talk;
  relation: string;
  /** The requests sent along it wait for your approval. */
  approve?: boolean;
}

export interface StudioDoc {
  name: string;
  folder: string;
  /** For the relations with no choice of their own. */
  talk: Talk;
  worktrees: boolean;
  you: { x: number; y: number };
  nodes: StudioNode[];
  links: StudioLink[];
  /** The rules of the whole team: every session gets them (CrewSpec.rules). */
  rules: string;
  /** What the team may cost before you are told, in dollars, as written (CrewSpec.budgetUsd); empty for none. */
  budget?: string;
  /** Notes on the canvas, for whoever opens the team after you. */
  notes: StudioNote[];
  /** What the team hands over when its work is done (CrewSpec.deliverable). */
  deliverable?: string;
  /** What each parameter of its texts is ({ticket}), and its default. */
  params?: TeamParam[];
  /** The values of its parameters for the next start: not kept in a template. */
  values?: Record<string, string>;
  /** The first request of the next start, to the lead (to every member when you lead): not kept in a template. */
  goal?: string;
}

/** A note on the canvas: a text where you put it. */
export interface StudioNote {
  key: number;
  x: number;
  y: number;
  text: string;
}

export const NOTE_W = 200;

let lastKey = 0;
export const newKey = (): number => ++lastKey;
/** A canvas brought back from elsewhere (the browser): the next boxes get keys after its own. */
export function reserveKeys(doc: Pick<StudioDoc, 'nodes' | 'notes'>): void {
  lastKey = Math.max(lastKey, ...doc.nodes.map((node) => node.key), ...(doc.notes ?? []).map((note) => note.key));
}

export const emptyDoc = (folder = ''): StudioDoc => ({ name: '', folder, talk: 'twoway', worktrees: true, you: { x: 400, y: MARGIN }, nodes: [], links: [], rules: '', notes: [] });

/** A note added at a place; its key. */
export function addNote(doc: StudioDoc, x: number, y: number, text = ''): { doc: StudioDoc; key: number } {
  const key = newKey();
  return { doc: { ...doc, notes: [...doc.notes, { key, x: Math.round(x), y: Math.round(y), text }] }, key };
}

export const noteOf = (doc: StudioDoc, key: number): StudioNote | undefined => doc.notes.find((note) => note.key === key);

export const nodeOf = (doc: StudioDoc, key: number): StudioNode | undefined => doc.nodes.find((node) => node.key === key);
/** The arrow that comes into a box: from the one it reports to. */
export const incoming = (doc: StudioDoc, key: number): StudioLink | undefined => doc.links.find((link) => link.to === key);
const below = (doc: StudioDoc, from: From): StudioLink[] => doc.links.filter((link) => link.from === from);

/** The box that is the Claude lead: the only one You point at, when it leads others. */
export function leadKey(doc: StudioDoc): number | undefined {
  const top = below(doc, 'you');
  return top.length === 1 && below(doc, top[0]!.to).length > 0 ? top[0]!.to : undefined;
}

/** The name of where an arrow starts. */
export const fromName = (doc: StudioDoc, from: From): string => (from === 'you' ? 'you' : (nodeOf(doc, from)?.name.trim() ?? '?'));

/** A name no box has yet: "senior", "senior 2", "senior 3"… */
export function uniqueName(doc: Pick<StudioDoc, 'nodes'>, base: string, except?: number): string {
  const taken = new Set(doc.nodes.filter((node) => node.key !== except).map((node) => node.name.trim().toLowerCase()));
  taken.add('you');
  const whole = base.trim().slice(0, MEMBER_NAME_MAX) || 'agent';
  if (!taken.has(whole.toLowerCase())) return whole;
  // "senior 2" taken too: "senior 3", not "senior 2 2".
  const root = whole.replace(/ \d+$/, '') || whole;
  for (let n = 2; ; n++) {
    const name = `${root.slice(0, MEMBER_NAME_MAX - String(n).length - 1)} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** The fields of a box from a preset, or from a member or the lead of a template. */
export const fieldsOf = (preset: Partial<Omit<RolePreset, 'name'>> & { name: string }): Omit<StudioNode, 'key' | 'x' | 'y'> => ({
  name: preset.name,
  role: preset.role ?? '',
  model: preset.model ?? '',
  mode: preset.mode ?? '',
  ...(preset.worktree !== undefined ? { worktree: preset.worktree } : {}),
  paths: preset.paths ? pathsText(preset.paths) : '',
  ...(preset.reviews ? { reviews: true } : {}),
  skills: [...(preset.skills ?? [])],
  ...(hasTools(preset.tools) ? { tools: copyTools(preset.tools) } : {}),
});

/** The tools of an agent, as a copy of its own. */
export const copyTools = (tools: AgentTools): AgentTools => ({
  ...(tools.limits ? { limits: [...tools.limits] } : {}),
  ...(tools.mcp ? { mcp: [...tools.mcp] } : {}),
  ...(tools.strictMcp ? { strictMcp: true } : {}),
});

/** An MCP server of the catalog given to a box: once. */
export function addTool(doc: StudioDoc, key: number, id: string): { doc: StudioDoc } | { error: string } {
  const node = nodeOf(doc, key);
  const server = mcpServerById(id);
  if (!node || !server) return { error: 'Drop the tool on an agent.' };
  if (node.tools?.mcp?.includes(id)) return { error: `${node.name} has the ${server.label} already.` };
  return { doc: updateNode(doc, key, { tools: { ...node.tools, mcp: [...(node.tools?.mcp ?? []), id] } }) };
}

/** A skill given to a box: once, at most 8. */
export function addSkill(doc: StudioDoc, key: number, id: string): { doc: StudioDoc } | { error: string } {
  const node = nodeOf(doc, key);
  const skill = skillById(id);
  if (!node || !skill) return { error: 'Drop the skill on an agent.' };
  if (node.skills.includes(id)) return { error: `${node.name} has ${id} already.` };
  if (node.skills.length >= SKILLS_PER_AGENT_MAX) return { error: `${SKILLS_PER_AGENT_MAX} skills at most for one agent: each one adds to what its session carries.` };
  return { doc: updateNode(doc, key, { skills: [...node.skills, id] }) };
}

/** The skills of the canvas, each once, and what the first use downloads: the KB of those. */
export function skillsOf(doc: StudioDoc): { ids: string[]; kb: number } {
  const ids = [...new Set(doc.nodes.flatMap((node) => node.skills))];
  return { ids, kb: ids.reduce((sum, id) => sum + (skillById(id)?.kb ?? 0), 0) };
}

/** A preset from a box: what it does and how it runs, without its place in a team. */
export function presetOfNode(node: StudioNode): Omit<RolePreset, 'builtin' | 'modified'> {
  const paths = pathsOf(node.paths);
  return {
    name: node.name.trim(),
    role: node.role.trim(),
    ...(node.model ? { model: node.model } : {}),
    ...(node.mode ? { mode: node.mode } : {}),
    ...(node.worktree !== undefined ? { worktree: node.worktree } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(node.reviews ? { reviews: true } : {}),
    ...(node.skills.length > 0 ? { skills: [...node.skills] } : {}),
    ...(hasTools(node.tools) ? { tools: copyTools(node.tools) } : {}),
  };
}

export const pathsOf = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((path) => path.trim())
    .filter(Boolean);

/** A box dropped on the canvas: its name made unique. */
export function addNode(doc: StudioDoc, fields: Omit<StudioNode, 'key' | 'x' | 'y'>, x: number, y: number): { doc: StudioDoc; key: number } {
  const key = newKey();
  return { doc: { ...doc, nodes: [...doc.nodes, { ...fields, name: uniqueName(doc, fields.name), key, x: Math.round(x), y: Math.round(y) }] }, key };
}

export function updateNode(doc: StudioDoc, key: number, patch: Partial<Omit<StudioNode, 'key'>>): StudioDoc {
  return { ...doc, nodes: doc.nodes.map((node) => (node.key === key ? { ...node, ...patch } : node)) };
}

export function updateLink(doc: StudioDoc, to: number, patch: Partial<Pick<StudioLink, 'talk' | 'relation' | 'approve'>>): StudioDoc {
  return { ...doc, links: doc.links.map((link) => (link.to === to ? { ...link, ...patch } : link)) };
}

/**
 * An arrow from one to another: the second reports to the first. One already coming into the second is replaced
 * (it moves under the new one). Refused: onto itself, onto You, and a circle (the first is under the second).
 */
export function connect(doc: StudioDoc, from: From, to: number): { doc: StudioDoc; replaced: boolean } | { error: string } {
  if (from === to) return { error: 'An arrow goes from one box to another.' };
  const target = nodeOf(doc, to);
  if (!target || (from !== 'you' && !nodeOf(doc, from))) return { error: 'Drop the arrow on a box.' };
  for (let at: From | undefined = from, seen = 0; at !== undefined && at !== 'you' && seen <= doc.nodes.length; seen++) {
    if (at === to) return { error: `${target.name} is above ${fromName(doc, from)}: an arrow cannot make a circle.` };
    at = incoming(doc, at)?.from;
  }
  const replaced = incoming(doc, to) !== undefined;
  return { doc: { ...doc, links: [...doc.links.filter((link) => link.to !== to), { from, to, relation: '' }] }, replaced };
}

export const removeLink = (doc: StudioDoc, to: number): StudioDoc => ({ ...doc, links: doc.links.filter((link) => link.to !== to) });

/** A box taken away: the ones it led go to the one above it, with their relations. */
export function removeNode(doc: StudioDoc, key: number): StudioDoc {
  const above = incoming(doc, key)?.from;
  return {
    ...doc,
    nodes: doc.nodes.filter((node) => node.key !== key),
    links: doc.links.filter((link) => link.to !== key).flatMap((link) => (link.from !== key ? [link] : above !== undefined ? [{ ...link, from: above }] : [])),
  };
}

/** The boxes You reach following the arrows. */
function reached(doc: StudioDoc): Set<number> {
  const out = new Set<number>();
  const visit = (from: From): void => {
    for (const link of below(doc, from)) {
      if (out.has(link.to)) continue;
      out.add(link.to);
      visit(link.to);
    }
  };
  visit('you');
  return out;
}

/** What keeps the canvas from being a team, in order; empty when it is one. `start`: also the values it needs to start. */
export function problems(doc: StudioDoc, start = false): string[] {
  if (doc.nodes.length === 0) return ['Drag an agent from the left onto the canvas.'];
  const out: string[] = [];
  if (below(doc, 'you').length === 0) out.push('Drag an arrow from You to the lead of the team, or to each member you lead.');
  const linked = reached(doc);
  for (const node of doc.nodes) if (!linked.has(node.key) && below(doc, 'you').length > 0) out.push(`${node.name.trim() || 'A box'} is not connected: drag an arrow to it from the one it reports to.`);
  if (out.length > 0) return out;
  const checked = specOfDoc(doc);
  if ('error' in checked) return [checked.error];
  const missing = start ? missingParams(checked.spec) : [];
  return missing.length > 0 ? [`Give a value to ${paramsText(missing)}: the team needs ${missing.length === 1 ? 'it' : 'them'} to start.`] : [];
}

/** The parameters the texts of the canvas use, with what each one is and its default. */
export function paramsOfDoc(doc: StudioDoc): TeamParam[] {
  const lead = leadKey(doc);
  const leadNode = lead !== undefined ? nodeOf(doc, lead) : undefined;
  const names = paramsUsed({
    lead: leadNode ? { kind: 'claude', name: leadNode.name, role: leadNode.role } : { kind: 'you' },
    members: doc.nodes.filter((node) => node.key !== lead).map((node) => ({ name: node.name, role: node.role, relation: incoming(doc, node.key)?.relation ?? '' })),
    rules: doc.rules,
    deliverable: doc.deliverable ?? '',
  });
  return names.map((name) => doc.params?.find((param) => param.name === name) ?? { name });
}

/** What a parameter is, or its default, changed on the canvas. */
export function updateParam(doc: StudioDoc, name: string, patch: Partial<Omit<TeamParam, 'name'>>): StudioDoc {
  const current = paramsOfDoc(doc).find((param) => param.name === name) ?? { name };
  const next: TeamParam = { ...current, ...patch };
  if (!next.hint?.trim()) delete next.hint;
  if (!next.default?.trim()) delete next.default;
  const others = (doc.params ?? []).filter((param) => param.name !== name);
  return { ...doc, params: [...others, next] };
}

/** The team the canvas makes, as the daemon checks it; or what is wrong with it. */
export function specOfDoc(doc: StudioDoc): { spec: CrewSpec } | { error: string } {
  const lead = leadKey(doc);
  const leadNode = lead !== undefined ? nodeOf(doc, lead) : undefined;
  const name = (key: From): string | undefined => (key === 'you' || key === lead ? undefined : nodeOf(doc, key)?.name.trim());
  const members = doc.nodes
    .filter((node) => node.key !== lead)
    .map((node): CrewMemberSpec => {
      const link = incoming(doc, node.key);
      const above = link ? name(link.from) : undefined;
      const paths = pathsOf(node.paths);
      return {
        name: node.name.trim(),
        role: node.role.trim(),
        ...(link?.talk ? { talk: link.talk } : {}),
        ...(node.model ? { model: node.model } : {}),
        ...(node.mode ? { mode: node.mode } : {}),
        ...(node.worktree !== undefined ? { worktree: node.worktree } : {}),
        ...(paths.length > 0 ? { paths } : {}),
        ...(node.reviews ? { reviews: true } : {}),
        ...(node.skills.length > 0 ? { skills: node.skills } : {}),
        ...(hasTools(node.tools) ? { tools: node.tools } : {}),
        ...(above ? { reportsTo: above } : {}),
        ...(link?.relation.trim() ? { relation: link.relation.trim() } : {}),
        ...(link?.approve && link.from !== 'you' ? { approve: true } : {}),
      };
    });
  const params = paramsOfDoc(doc).filter((param) => param.hint || param.default);
  return cleanCrewSpec({
    name: doc.name,
    cwd: doc.folder,
    talk: doc.talk,
    ...(doc.worktrees ? { worktrees: true } : {}),
    ...(doc.rules.trim() ? { rules: doc.rules } : {}),
    ...(cleanBudget(doc.budget) ? { budgetUsd: cleanBudget(doc.budget) } : {}),
    ...(doc.deliverable?.trim() ? { deliverable: doc.deliverable } : {}),
    ...(params.length > 0 ? { params } : {}),
    ...(doc.values && Object.keys(doc.values).length > 0 ? { values: doc.values } : {}),
    lead: leadNode
      ? {
          kind: 'claude',
          name: leadNode.name.trim(),
          role: leadNode.role.trim(),
          ...(leadNode.model ? { model: leadNode.model } : {}),
          ...(leadNode.mode ? { mode: leadNode.mode } : {}),
          ...(leadNode.skills.length > 0 ? { skills: leadNode.skills } : {}),
          ...(hasTools(leadNode.tools) ? { tools: leadNode.tools } : {}),
        }
      : { kind: 'you' },
    members,
  });
}

/** The canvas as a template: the team without its folder, with where each box stands. */
export function templateOfDoc(doc: StudioDoc): { template: Omit<CrewTemplate, 'builtin' | 'modified'> } | { error: string } {
  const checked = specOfDoc({ ...doc, folder: doc.folder.trim() || '/', values: {} });
  if ('error' in checked) return checked;
  const { cwd: _cwd, values: _values, ...rest } = checked.spec;
  const layout: Record<string, [number, number]> = { you: [doc.you.x, doc.you.y] };
  for (const node of doc.nodes) layout[node.name.trim()] = [node.x, node.y];
  const notes = doc.notes.filter((note) => note.text.trim()).map((note) => ({ x: note.x, y: note.y, text: note.text.trim() }));
  return { template: { ...rest, layout, ...(notes.length > 0 ? { notes } : {}) } };
}

/**
 * A template as boxes and arrows, added to a canvas (an empty one, to open it): its lead under You, its members
 * under the one they report to. Names already on the canvas get a number. Where the template has no layout, it is
 * laid out as a tree at (x, y).
 */
export function addTemplate(doc: StudioDoc, template: Pick<CrewTemplate, 'lead' | 'members' | 'layout' | 'talk'>, x: number, y: number): StudioDoc {
  const keys = new Map<string, number>();
  let next = doc;
  const place = (fields: Omit<StudioNode, 'key' | 'x' | 'y'>): number => {
    const added = addNode(next, fields, 0, 0);
    next = added.doc;
    keys.set(fields.name.toLowerCase(), added.key);
    return added.key;
  };
  const lead = template.lead.kind === 'claude' ? place(fieldsOf(template.lead)) : undefined;
  for (const member of template.members) place(fieldsOf(member));
  const links: StudioLink[] = [];
  if (lead !== undefined) links.push({ from: 'you', to: lead, relation: '' });
  for (const member of template.members) {
    const above = member.reportsTo !== undefined ? keys.get(member.reportsTo.toLowerCase()) : lead;
    // The → / ⇄ of the template stays: a template made with another default keeps each member as it was.
    links.push({
      from: above ?? 'you',
      to: keys.get(member.name.toLowerCase())!,
      ...(member.talk || template.talk !== next.talk ? { talk: member.talk ?? template.talk } : {}),
      relation: member.relation ?? '',
      ...(member.approve ? { approve: true } : {}),
    });
  }
  const added = new Set(keys.values());
  next = { ...next, links: [...next.links, ...links] };
  // Its own layout, when it has one for every box; otherwise a tree. Either way, its corner at (x, y).
  const saved = savedPositions(template, keys);
  const laid = saved ?? new Map(tidy({ ...next, nodes: next.nodes.filter((node) => added.has(node.key)), links: next.links.filter((link) => added.has(link.to)) }).nodes.map((node) => [node.key, { x: node.x, y: node.y }]));
  const left = Math.min(...[...laid.values()].map((position) => position.x));
  const top = Math.min(...[...laid.values()].map((position) => position.y));
  return { ...next, nodes: next.nodes.map((node) => (laid.has(node.key) ? { ...node, x: Math.round(x + laid.get(node.key)!.x - left), y: Math.round(y + laid.get(node.key)!.y - top) } : node)) };
}

/** Where the layout of a template puts each of its boxes, by key; undefined when it misses one. */
function savedPositions(template: Pick<CrewTemplate, 'layout'>, keys: ReadonlyMap<string, number>): Map<number, { x: number; y: number }> | undefined {
  const layout = Object.fromEntries(Object.entries(template.layout ?? {}).map(([name, at]) => [name.toLowerCase(), at]));
  const out = new Map<number, { x: number; y: number }>();
  for (const [name, key] of keys) {
    const at = layout[name];
    if (!at) return undefined;
    out.set(key, { x: at[0], y: at[1] });
  }
  return out;
}

/** A template opened in the studio: its boxes and arrows on an empty canvas, where it keeps them, with its name and choices. */
export function docOfTemplate(template: CrewTemplate, folder = ''): StudioDoc {
  const base: StudioDoc = {
    ...emptyDoc(folder),
    name: template.name,
    talk: template.talk,
    worktrees: template.worktrees === true,
    rules: template.rules ?? '',
    ...(template.budgetUsd ? { budget: String(template.budgetUsd) } : {}),
    ...(template.deliverable ? { deliverable: template.deliverable } : {}),
    ...(template.params ? { params: template.params.map((param) => ({ ...param })) } : {}),
    notes: (template.notes ?? []).map((note) => ({ ...note, key: newKey() })),
  };
  const you = template.layout?.you;
  const doc = addTemplate(base, template, 0, 0);
  const keys = new Map(doc.nodes.map((node) => [node.name.toLowerCase(), node.key]));
  const saved = you ? savedPositions(template, keys) : undefined;
  if (!you || !saved) return tidy(doc);
  return { ...doc, you: { x: you[0], y: you[1] }, nodes: doc.nodes.map((node) => ({ ...node, ...saved.get(node.key)! })) };
}

/**
 * Tidy up: You on top, each box centered over the ones it leads, a row for each level; the boxes no arrow
 * reaches in a row at the bottom.
 */
export function tidy(doc: StudioDoc): StudioDoc {
  const positions = new Map<number, { x: number; y: number }>();
  const width = new Map<number, number>();
  const kids = (from: From): number[] => doc.nodes.filter((node) => incoming(doc, node.key)?.from === from).map((node) => node.key);
  const seen = new Set<number>();
  const measure = (key: number): number => {
    if (seen.has(key)) return NODE_W;
    seen.add(key);
    const children = kids(key);
    const total = children.reduce((sum, child) => sum + measure(child), 0) + GAP_X * Math.max(0, children.length - 1);
    const own = Math.max(NODE_W, total);
    width.set(key, own);
    return own;
  };
  const place = (key: number, left: number, top: number): void => {
    const own = width.get(key) ?? NODE_W;
    positions.set(key, { x: Math.round(left + (own - NODE_W) / 2), y: top });
    const children = kids(key);
    const total = children.reduce((sum, child) => sum + (width.get(child) ?? NODE_W), 0) + GAP_X * Math.max(0, children.length - 1);
    let at = left + (own - total) / 2;
    for (const child of children) {
      if (positions.has(child)) continue;
      place(child, at, top + NODE_H + GAP_Y);
      at += (width.get(child) ?? NODE_W) + GAP_X;
    }
  };
  const tops = kids('you');
  const total = tops.reduce((sum, key) => sum + measure(key), 0) + GAP_X * Math.max(0, tops.length - 1);
  const span = Math.max(total, YOU_W);
  const you = { x: Math.round(MARGIN + (span - YOU_W) / 2), y: MARGIN };
  let at = MARGIN + (span - total) / 2;
  for (const key of tops) {
    place(key, at, MARGIN + YOU_H + GAP_Y);
    at += (width.get(key) ?? NODE_W) + GAP_X;
  }
  // What no arrow from You reaches: whole chains of their own, then a row at the bottom.
  const bottom = Math.max(MARGIN + YOU_H, ...[...positions.values()].map((position) => position.y + NODE_H)) + GAP_Y;
  let left = MARGIN;
  for (const node of doc.nodes) {
    if (positions.has(node.key) || incoming(doc, node.key)) continue;
    measure(node.key);
    place(node.key, left, bottom);
    left += (width.get(node.key) ?? NODE_W) + GAP_X;
  }
  for (const node of doc.nodes) {
    if (positions.has(node.key)) continue;
    positions.set(node.key, { x: left, y: bottom });
    left += NODE_W + GAP_X;
  }
  return { ...doc, you, nodes: doc.nodes.map((node) => ({ ...node, ...positions.get(node.key)! })) };
}

/** Where an arrow starts and ends on the canvas: the bottom of the one above, the top of the one below. */
export function linkEnds(doc: StudioDoc, link: Pick<StudioLink, 'from' | 'to'>): { x1: number; y1: number; x2: number; y2: number } | undefined {
  const target = nodeOf(doc, link.to);
  const source = link.from === 'you' ? { x: doc.you.x, y: doc.you.y, w: YOU_W, h: YOU_H } : (() => {
    const node = nodeOf(doc, link.from);
    return node ? { x: node.x, y: node.y, w: NODE_W, h: NODE_H } : undefined;
  })();
  if (!target || !source) return undefined;
  return { x1: source.x + source.w / 2, y1: source.y + source.h, x2: target.x + NODE_W / 2, y2: target.y };
}

/** The curve of an arrow, from (x1, y1) down to (x2, y2). */
export function curve(x1: number, y1: number, x2: number, y2: number): string {
  const bend = Math.max(36, Math.abs(y2 - y1) / 2);
  return `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`;
}

/** The box under a point of the canvas, if any. */
export const nodeAt = (doc: StudioDoc, x: number, y: number): StudioNode | undefined =>
  [...doc.nodes].reverse().find((node) => x >= node.x && x <= node.x + NODE_W && y >= node.y && y <= node.y + NODE_H);

/** How big the canvas is: what it holds, and room around. */
export function canvasSize(doc: StudioDoc): { width: number; height: number } {
  const right = Math.max(doc.you.x + YOU_W, ...doc.nodes.map((node) => node.x + NODE_W), ...doc.notes.map((note) => note.x + NOTE_W));
  const bottom = Math.max(doc.you.y + YOU_H, ...doc.nodes.map((node) => node.y + NODE_H), ...doc.notes.map((note) => note.y + 120));
  return { width: Math.max(1200, right + 480), height: Math.max(800, bottom + 360) };
}

// ---- Undo and redo (⌘Z, ⇧⌘Z) ----

/** The canvas as it was before each change, and the changes undone, for redo. */
export interface StudioHistory {
  past: StudioDoc[];
  future: StudioDoc[];
  /** When the last change came: changes in a row (typing a role, dragging a box) are one step. */
  at: number;
}

export const HISTORY_MAX = 100;
/** A pause this long between two changes makes the second one a step of its own. */
export const HISTORY_PAUSE_MS = 600;

export const emptyHistory = (): StudioHistory => ({ past: [], future: [], at: 0 });

/** A change of the canvas, from `previous`: a new step after a pause, else part of the step under way. */
export function remember(history: StudioHistory, previous: StudioDoc, now: number): StudioHistory {
  const step = history.past.length === 0 || now - history.at > HISTORY_PAUSE_MS;
  return { past: step ? [...history.past, previous].slice(-HISTORY_MAX) : history.past, future: [], at: now };
}

/** The canvas one step back, and the history after it; undefined with nothing to undo. */
export function undoStep(history: StudioHistory, current: StudioDoc): { doc: StudioDoc; history: StudioHistory } | undefined {
  const doc = history.past.at(-1);
  if (!doc) return undefined;
  return { doc, history: { past: history.past.slice(0, -1), future: [...history.future, current], at: 0 } };
}

/** The canvas one step forward again; undefined with nothing to redo. */
export function redoStep(history: StudioHistory, current: StudioDoc): { doc: StudioDoc; history: StudioHistory } | undefined {
  const doc = history.future.at(-1);
  if (!doc) return undefined;
  return { doc, history: { past: [...history.past, current].slice(-HISTORY_MAX), future: history.future.slice(0, -1), at: 0 } };
}

// ---- Copy, paste, duplicate; the boxes in a rectangle; zoom ----

/** Boxes copied: their fields where they stood, and the arrows between them (by their place in `nodes`). */
export interface StudioClip {
  nodes: Omit<StudioNode, 'key'>[];
  links: { from: number; to: number; talk?: Talk; relation: string; approve?: boolean }[];
}

/** The boxes of these keys, with the arrows that go from one of them to another. */
export function clipOf(doc: StudioDoc, keys: readonly number[]): StudioClip | undefined {
  const chosen = doc.nodes.filter((node) => keys.includes(node.key));
  if (chosen.length === 0) return undefined;
  const index = new Map(chosen.map((node, at) => [node.key, at]));
  return {
    nodes: chosen.map(({ key: _key, ...fields }) => ({ ...fields, skills: [...fields.skills], ...(fields.tools ? { tools: copyTools(fields.tools) } : {}) })),
    links: doc.links
      .filter((link) => link.from !== 'you' && index.has(link.from) && index.has(link.to))
      .map((link) => ({ from: index.get(link.from as number)!, to: index.get(link.to)!, ...(link.talk ? { talk: link.talk } : {}), relation: link.relation, ...(link.approve ? { approve: true } : {}) })),
  };
}

/** The boxes of a clip on the canvas, moved by dx and dy, with names of their own; their keys. */
export function pasteClip(doc: StudioDoc, clip: StudioClip, dx: number, dy: number): { doc: StudioDoc; keys: number[] } {
  let next = doc;
  const keys: number[] = [];
  for (const node of clip.nodes) {
    const added = addNode(next, { ...node, skills: [...node.skills], ...(node.tools ? { tools: copyTools(node.tools) } : {}) }, Math.max(0, node.x + dx), Math.max(0, node.y + dy));
    next = added.doc;
    keys.push(added.key);
  }
  for (const link of clip.links) {
    const result = connect(next, keys[link.from]!, keys[link.to]!);
    if ('error' in result) continue;
    next = updateLink(result.doc, keys[link.to]!, { relation: link.relation, ...(link.talk ? { talk: link.talk } : {}), ...(link.approve ? { approve: true } : {}) });
  }
  return { doc: next, keys };
}

/** The boxes a rectangle of the canvas touches, in any direction it was drawn. */
export function nodesIn(doc: StudioDoc, a: { x: number; y: number }, b: { x: number; y: number }): number[] {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  return doc.nodes.filter((node) => node.x < right && node.x + NODE_W > left && node.y < bottom && node.y + NODE_H > top).map((node) => node.key);
}

/** Takes away several boxes; those they led go up to the one above them, as for one. */
export function removeNodes(doc: StudioDoc, keys: readonly number[]): StudioDoc {
  return keys.reduce((current, key) => (nodeOf(current, key) ? removeNode(current, key) : current), doc);
}

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 1.6;
export const clampZoom = (zoom: number): number => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) * 100) / 100;

/** Where everything on the canvas is: You, the boxes, the notes. */
export function contentBox(doc: StudioDoc): { left: number; top: number; right: number; bottom: number } {
  const xs = [doc.you.x, ...doc.nodes.map((node) => node.x), ...doc.notes.map((note) => note.x)];
  const ys = [doc.you.y, ...doc.nodes.map((node) => node.y), ...doc.notes.map((note) => note.y)];
  const rights = [doc.you.x + YOU_W, ...doc.nodes.map((node) => node.x + NODE_W), ...doc.notes.map((note) => note.x + NOTE_W)];
  const bottoms = [doc.you.y + YOU_H, ...doc.nodes.map((node) => node.y + NODE_H), ...doc.notes.map((note) => note.y + 80)];
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...rights), bottom: Math.max(...bottoms) };
}

/** The zoom that shows everything in a view of this size, with a margin; never larger than 1. */
export function fitZoom(doc: StudioDoc, width: number, height: number, margin = 40): number {
  const box = contentBox(doc);
  return clampZoom(Math.min(1, (width - 2 * margin) / Math.max(1, box.right - box.left), (height - 2 * margin) / Math.max(1, box.bottom - box.top)));
}
