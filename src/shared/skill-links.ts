// Reading where a skill comes from: a link of GitHub to the folder of a skill, and what its SKILL.md says of
// itself. No Node module here: the daemon uses it, and the studio of forchetta.dev too, in a browser.

/**
 * A folder of a repository as a skill may name it: parts of letters, digits, ".", "_" and "-", none of them "." or
 * "..", nothing absolute. Anything else could lead a download outside the folder it is made in.
 */
export const safeRepoPath = (path: string): boolean => path.length > 0 && path.length <= 300 && path.split('/').every((part) => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..');

/** A link of GitHub to a folder: owner/repo, then the branch, tag or commit and the path, still together. */
export function githubLink(text: string): { repo: string; rest: string[] } | { error: string } | undefined {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob)\/(.+?))?\/?(?:[?#].*)?$/i.exec(text.trim());
  if (!match) return undefined;
  const [, owner, name, , tail] = match;
  let rest: string[];
  try {
    rest = (tail ?? '').split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return { error: 'that link is not readable' };
  }
  if (rest.some((part) => part === '.' || part === '..' || part.includes('/') || part.includes('\\'))) return { error: 'that link leads out of its folder: a link of a skill names its folder plainly' };
  // The link of a SKILL.md: its folder.
  if (rest.at(-1)?.toLowerCase() === 'skill.md') rest.pop();
  if (rest.length < 2) return { error: 'give the link of the folder of the skill on GitHub (…/tree/<branch>/<folder>, with its SKILL.md), not of the whole repository' };
  return { repo: `${owner}/${name}`, rest };
}

/** What a SKILL.md says of itself: its description, in one line. */
export function describeSkill(text: string): string {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const lines = head.split(/\r?\n/);
  const at = lines.findIndex((line) => /^description:/.test(line));
  if (at < 0) return '';
  let value = lines[at]!.replace(/^description:\s*/, '').trim();
  // A folded or literal block: the indented lines after it.
  if (/^[|>][-+]?$/.test(value) || value === '') {
    const block: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!/^\s+\S/.test(line)) break;
      block.push(line.trim());
    }
    value = block.join(' ');
  }
  value = value.replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/\s+/g, ' ').trim();
  return value.length > 200 ? `${value.slice(0, 199)}…` : value;
}
