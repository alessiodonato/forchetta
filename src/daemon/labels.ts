import { homedir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import type { ToolFamily } from '../shared/agent.ts';

// Short texts for the box, built from the hook input alone: "Edit src/api.ts", "Bash npm test", and the
// first sentences of the last reply. No model, no cost.

export type { ToolFamily } from '../shared/agent.ts';

const FAMILY: Record<string, ToolFamily> = {
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  PowerShell: 'shell',
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  LS: 'read',
  NotebookRead: 'read',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'agent',
  Agent: 'agent',
};

/** One line, at most `max` characters, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

function shortPath(path: string, cwd: string | undefined): string {
  if (cwd) {
    const inside = relative(cwd, path);
    if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return inside;
  }
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function hostAndPath(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

export interface ToolLabel {
  label: string;
  family: ToolFamily;
}

/** What a tool call does, in a few words: the tool and its main argument. */
export function toolLabel(tool: string, input: unknown, cwd?: string): ToolLabel {
  const fields = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  // The call a subagent ends with: its report goes back to its session.
  if (tool === 'SubagentHandback') return { label: 'sending its report', family: 'agent' };
  if (tool.startsWith('mcp__')) {
    const [, server, name] = tool.split('__');
    return { label: clip(`${server ?? 'mcp'} · ${name ?? tool}`, 80), family: 'other' };
  }
  const family = FAMILY[tool] ?? 'other';
  let detail: string | undefined;
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      detail = str(fields.command)?.split('\n')[0];
      break;
    case 'Grep':
      detail = str(fields.pattern) && `"${String(fields.pattern)}"`;
      break;
    case 'Glob':
      detail = str(fields.pattern);
      break;
    case 'WebFetch':
      detail = hostAndPath(str(fields.url));
      break;
    case 'WebSearch':
      detail = str(fields.query) && `"${String(fields.query)}"`;
      break;
    case 'Task':
    case 'Agent':
      detail = str(fields.description) ?? str(fields.subagent_type);
      break;
    default: {
      const path = str(fields.file_path) ?? str(fields.notebook_path) ?? str(fields.path);
      if (path) detail = shortPath(path, cwd);
    }
  }
  return { label: clip(detail ? `${tool} ${detail}` : tool, 80), family };
}

/** The task in progress of a TodoWrite call, in its "doing" form. */
export function activeTask(tool: string, input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const fields = input as Record<string, unknown>;
  const pick = (item: Record<string, unknown>): string | undefined => str(item.activeForm) ?? str(item.content) ?? str(item.subject);
  if (tool === 'TodoWrite' && Array.isArray(fields.todos)) {
    const current = (fields.todos as unknown[]).find(
      (item): item is Record<string, unknown> => item !== null && typeof item === 'object' && (item as Record<string, unknown>).status === 'in_progress',
    );
    return current ? pick(current) : undefined;
  }
  if (fields.status === 'in_progress') return pick(fields);
  return undefined;
}

/** The first question of an AskUserQuestion call. */
export function firstQuestion(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const questions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return undefined;
  const first = questions[0] as Record<string, unknown> | undefined;
  return first ? str(first.question) : undefined;
}

/** Markdown as plain text on one line: no code blocks, links, headings, list marks or emphasis. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The opening of a reply, for the box: whole sentences until there are at least `min` characters, so that a
 * bare "Fatto." takes the next sentence with it, then cut at `max`.
 */
export function opening(markdown: string, max = 140, min = 40): string {
  const text = plainText(markdown);
  // A sentence ends with . ! ? or … followed by a space: "src/api.ts" does not end one.
  const sentence = /\S.*?(?:[.!?…]+(?=\s|$)|$)/g;
  let taken = '';
  for (const match of text.matchAll(sentence)) {
    const part = match[0].trim();
    if (!part) continue;
    taken = taken ? `${taken} ${part}` : part;
    if (taken.length >= min) break;
  }
  return clip(taken || text, max);
}

const DETAIL_MAX = 2000;

/**
 * What a permission dialog asks, in full, for the box that answers it: the whole command, the file, the address,
 * or the input of the tool. Unlike toolLabel, it keeps every line.
 */
export function permissionDetail(tool: string, input: unknown, cwd?: string): string {
  const fields = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  let detail: string | undefined;
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      detail = str(fields.command);
      break;
    case 'WebFetch':
      detail = str(fields.url);
      break;
    case 'WebSearch':
      detail = str(fields.query);
      break;
    default: {
      const path = str(fields.file_path) ?? str(fields.notebook_path) ?? str(fields.path);
      if (path) detail = shortPath(path, cwd);
      else if (input !== undefined && input !== null && Object.keys(fields).length > 0) detail = JSON.stringify(input);
    }
  }
  const text = (detail ?? tool).trim();
  return text.length <= DETAIL_MAX ? text : `${text.slice(0, DETAIL_MAX - 1)}…`;
}
