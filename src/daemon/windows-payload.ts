import { fromGitBash, fromOutside, isAbsolute, slashes, WINDOWS } from '../shared/fspath.ts';
import type { HookPayload } from './state.ts';

// A hook of Claude Code on Windows, with its paths as Forchetta keeps them (shared/fspath.ts): one file has one name,
// whichever way a session wrote it. Every hook comes through here, before anything reads it. Elsewhere it stays as it is.

/** The fields of a tool that are a path of a file or a folder. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;

/** A full path, in any of the ways Windows has; a relative one stays, for who knows from where. */
export const ofWindows = (path: string, real: (path: string) => string = fromOutside): string => {
  const text = fromGitBash(path);
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(text) ? real(text) : isAbsolute(text) ? slashes(text) : text.replace(/\\/g, '/');
};

export function windowsPayload(payload: HookPayload, real: (path: string) => string = fromOutside): HookPayload {
  const out: HookPayload = { ...payload };
  if (out.cwd) out.cwd = ofWindows(out.cwd, real);
  if (out.transcript_path) out.transcript_path = slashes(out.transcript_path);
  const input = out.tool_input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const copy = { ...(input as Record<string, unknown>) };
    let changed = false;
    for (const field of PATH_FIELDS) {
      const value = copy[field];
      if (typeof value !== 'string' || !value) continue;
      copy[field] = ofWindows(value, real);
      changed = true;
    }
    if (changed) out.tool_input = copy;
  }
  const response = out.tool_response;
  if (response && typeof response === 'object' && !Array.isArray(response) && typeof (response as Record<string, unknown>).filePath === 'string') {
    out.tool_response = { ...(response as Record<string, unknown>), filePath: ofWindows((response as { filePath: string }).filePath, real) };
  }
  return out;
}

/** The payload as the daemon reads it. */
export const ownPaths = (payload: HookPayload): HookPayload => (WINDOWS ? windowsPayload(payload) : payload);
