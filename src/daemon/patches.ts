import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { SessionEdit } from '../shared/agent.ts';
import { ensurePrivateDir } from '../shared/paths.ts';
import type { HookPayload } from './state.ts';

// What a session itself wrote, change by change: the panel of its changes shows these next to the git diff, which
// also holds what others changed in the same file. Claude Code puts the patch of each write in the response of
// the tool (seen with 2.1.322): `structuredPatch` for Edit, MultiEdit and a Write over a file, the whole content for
// a Write that creates one. They are appended to var/patches/<agent>.jsonl (readable by this user only), read when
// the panel opens, and deleted when the session leaves the list.

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
/** Lines kept for one change; the rest is cut. */
const MAX_LINES = 2000;
/** Bytes kept for one session: past this, changes are no longer recorded. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

type Hunk = SessionEdit['hunks'][number];

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function hunksOf(value: unknown): Hunk[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      oldStart: num(item.oldStart),
      oldLines: num(item.oldLines),
      newStart: num(item.newStart),
      newLines: num(item.newLines),
      lines: Array.isArray(item.lines) ? item.lines.filter((line): line is string => typeof line === 'string') : [],
    }));
}

/** Cuts a change to MAX_LINES lines in all. */
function capped(hunks: Hunk[]): { hunks: Hunk[]; truncated: boolean } {
  let left = MAX_LINES;
  const out: Hunk[] = [];
  for (const hunk of hunks) {
    if (left <= 0) return { hunks: out, truncated: true };
    if (hunk.lines.length > left) {
      out.push({ ...hunk, lines: hunk.lines.slice(0, left) });
      return { hunks: out, truncated: true };
    }
    out.push(hunk);
    left -= hunk.lines.length;
  }
  return { hunks: out, truncated: false };
}

/** The change a PostToolUse of a write tool made, or undefined for any other event. */
export function editOf(payload: HookPayload, cwd: string | undefined, at: number): SessionEdit | undefined {
  if (payload.hook_event_name !== 'PostToolUse' || !payload.tool_name || !WRITE_TOOLS.has(payload.tool_name)) return undefined;
  const response = (payload.tool_response ?? {}) as Record<string, unknown>;
  const input = (payload.tool_input ?? {}) as Record<string, unknown>;
  const raw = typeof response.filePath === 'string' ? response.filePath : typeof input.file_path === 'string' ? input.file_path : undefined;
  const base = cwd ?? payload.cwd;
  if (!raw || (!isAbsolute(raw) && !base)) return undefined;
  const file = isAbsolute(raw) ? resolve(raw) : resolve(base!, raw);
  let hunks = hunksOf(response.structuredPatch);
  let created = false;
  if (hunks.length === 0 && response.type === 'create' && typeof response.content === 'string') {
    // A new file: all of it is added.
    const lines = response.content.replace(/\n$/, '').split('\n');
    hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((line) => `+${line}`) }];
    created = true;
  }
  if (hunks.length === 0) return undefined;
  const cut = capped(hunks);
  return { at, tool: payload.tool_name, file, hunks: cut.hunks, created: created || undefined, truncated: cut.truncated || undefined };
}

export class Patches {
  constructor(private readonly dir: string) {}

  private fileOf(agentId: string): string | undefined {
    // Agent ids are UUIDs: anything else does not name a file here.
    return /^[0-9a-f-]{36}$/i.test(agentId) ? join(this.dir, `${agentId}.jsonl`) : undefined;
  }

  add(agentId: string, edit: SessionEdit): void {
    const file = this.fileOf(agentId);
    if (!file) return;
    ensurePrivateDir(this.dir);
    if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) return;
    appendFileSync(file, `${JSON.stringify(edit)}\n`, { mode: 0o600 });
  }

  /** The changes of a session to each file, oldest first. */
  byFile(agentId: string): Map<string, SessionEdit[]> {
    const out = new Map<string, SessionEdit[]>();
    const file = this.fileOf(agentId);
    if (!file || !existsSync(file)) return out;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const edit = JSON.parse(line) as SessionEdit;
        if (typeof edit.file !== 'string' || !Array.isArray(edit.hunks)) continue;
        const list = out.get(edit.file) ?? [];
        list.push(edit);
        out.set(edit.file, list);
      } catch {
        // A line cut by a crash: the others still count.
      }
    }
    return out;
  }

  forget(agentIds: readonly string[]): void {
    for (const id of agentIds) {
      const file = this.fileOf(id);
      if (file) rmSync(file, { force: true });
    }
  }
}
