// The artifacts of claude.ai that a session published or opened, for its box: their link and title, from the
// PostToolUse of the Artifact tool of Claude Code. Its response carries them (`{ url, title, … }` for a publish,
// `{ opened: true, url, title }` for an open); its text says the same ("Published … at https://claude.ai/artifact/…"),
// for when the object is not there. Nothing else of the response is kept: an artifact link is private, and stays
// in the folder of Forchetta.

export interface ArtifactLink {
  url: string;
  title?: string;
  /** When the session last published or opened it. */
  at: number;
  /** Only opened by this session, never published by it. */
  opened?: boolean;
}

/** The artifacts a box keeps, the most recent first. */
export const MAX_ARTIFACTS = 20;
const MAX_TITLE = 120;

/** A link of an artifact: claude.ai/artifact/<id> or claude.ai/code/artifact/<uuid>, nothing after it. */
const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]{6,64}$/;
const IN_TEXT = /\b(Published|Opened the Artifact)\b[^\n]*?\bat (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]{6,64})\b/;

const textOf = (response: unknown): string => {
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) return response.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('\n');
  return '';
};

const cleanTitle = (title: unknown): string | undefined => {
  if (typeof title !== 'string') return undefined;
  const flat = title.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length <= MAX_TITLE ? flat : `${flat.slice(0, MAX_TITLE - 1).trimEnd()}…`;
};

/**
 * The artifact a tool call published or opened, or undefined. Only the Artifact tool, and only a publish of a page
 * (no asset upload) or an open: a read, a list or a quickstart shows the user nothing.
 */
export function artifactOf(toolName: unknown, toolInput: unknown, toolResponse: unknown): Omit<ArtifactLink, 'at'> | undefined {
  if (toolName !== 'Artifact') return undefined;
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as { action?: unknown; asset?: unknown };
  const action = input.action === undefined ? 'publish' : input.action;
  if ((action !== 'publish' && action !== 'open') || input.asset === true) return undefined;
  const response = (toolResponse && typeof toolResponse === 'object' && !Array.isArray(toolResponse) ? toolResponse : {}) as { url?: unknown; title?: unknown; opened?: unknown };
  if (typeof response.url === 'string' && ARTIFACT_URL.test(response.url)) {
    const title = cleanTitle(response.title);
    return { url: response.url, ...(title ? { title } : {}), ...(action === 'open' ? { opened: true } : {}) };
  }
  const match = IN_TEXT.exec(textOf(toolResponse));
  if (!match) return undefined;
  return { url: match[2]!, ...(match[1] === 'Opened the Artifact' ? { opened: true } : {}) };
}

/** The list of a box with one more: the same link moves to the top, once; a publish wins over an open. */
export function addArtifact(list: readonly ArtifactLink[] | undefined, link: ArtifactLink, max = MAX_ARTIFACTS): ArtifactLink[] {
  const before = list?.find((item) => item.url === link.url);
  const title = link.title ?? before?.title;
  const opened = link.opened === true && (before === undefined || before.opened === true);
  const merged: ArtifactLink = { url: link.url, at: link.at, ...(title ? { title } : {}), ...(opened ? { opened: true } : {}) };
  return [merged, ...(list ?? []).filter((item) => item.url !== link.url)].slice(0, max);
}

/** Two lists in one, by time: the same link once, with its last time, and a publish wins over an open. */
export function mergeArtifacts(list: readonly ArtifactLink[] | undefined, found: readonly ArtifactLink[], max = MAX_ARTIFACTS): ArtifactLink[] {
  return [...(list ?? []), ...found].sort((a, b) => a.at - b.at).reduce<ArtifactLink[]>((out, link) => addArtifact(out, link, max), []);
}

/**
 * Whether Forchetta may open a link in the browser: https anywhere, http only on this Mac (a dev server). The app
 * checks it again before it opens anything.
 */
export function openableUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return url.hostname.length > 0;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
}

/** The links in a line of terminal text, with where they start; a trailing period or bracket is not part of one. */
export function linksIn(text: string): { url: string; index: number }[] {
  const out: { url: string; index: number }[] = [];
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/g)) {
    let url = match[0];
    // Punctuation that ends a sentence, or closes a bracket the link did not open.
    while (/[.,;:!?)\]}]$/.test(url)) {
      const last = url.at(-1)!;
      const opener = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : undefined;
      if (opener && url.split(opener).length > url.split(last).length - 1) break;
      url = url.slice(0, -1);
    }
    if (openableUrl(url)) out.push({ url, index: match.index ?? 0 });
  }
  return out;
}
