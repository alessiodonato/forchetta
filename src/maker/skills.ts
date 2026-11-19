import { describeSkill, githubLink } from '../shared/skill-links.ts';
import { customSkills, setCustomSkills, type SkillInfo, skillById } from '../shared/skills.ts';

// The skills you add in the studio of forchetta.dev: from GitHub only (there is no folder of yours in a browser).
// As in Forchetta, the link is pinned to the commit it points at now; here GitHub's API says which, and what the
// SKILL.md says of itself. Nothing is downloaded: the file of the team carries where the skill is, and Forchetta
// fetches it when the team starts.

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export async function addFromGitHub(text: string, get: Fetch = (url) => fetch(url)): Promise<{ ok: boolean; error?: string; id?: string }> {
  const link = githubLink(text.trim());
  if (!link) return { ok: false, error: 'paste the link of the folder of a skill on GitHub: https://github.com/<owner>/<repo>/tree/<branch>/<folder>' };
  if ('error' in link) return { ok: false, error: link.error };
  try {
    // A branch may have slashes in its name: the first parts that are a branch, a tag or a commit.
    for (let parts = 1; parts < link.rest.length; parts++) {
      const ref = link.rest.slice(0, parts).join('/');
      const found = await get(`https://api.github.com/repos/${link.repo}/commits/${encodeURIComponent(ref)}`);
      if (found.status === 403) return { ok: false, error: 'GitHub says to wait: too many questions from this browser in the last hour' };
      if (!found.ok) continue;
      const commit = String(((await found.json()) as { sha?: unknown }).sha ?? '');
      if (!/^[0-9a-f]{40}$/.test(commit)) continue;
      const path = link.rest.slice(parts).join('/');
      const id = slug(path.split('/').at(-1) ?? '').slice(0, 64);
      if (!id) return { ok: false, error: 'the name of the folder makes no name for a skill' };
      if (skillById(id)) return { ok: false, error: `there is a skill called ${id} already` };
      const manifest = await get(`https://raw.githubusercontent.com/${link.repo}/${commit}/${path}/SKILL.md`);
      if (!manifest.ok) return { ok: false, error: `${path} has no SKILL.md at that commit: a skill is a folder with its SKILL.md` };
      const listing = await get(`https://api.github.com/repos/${link.repo}/contents/${path}?ref=${commit}`);
      const entries = listing.ok ? ((await listing.json()) as { type?: string; size?: number }[]) : [];
      const files = Array.isArray(entries) ? entries.filter((entry) => entry.type === 'file') : [];
      const skill: SkillInfo = {
        id,
        group: 'yours',
        repo: link.repo,
        path,
        commit,
        license: 'unknown',
        kb: Math.max(1, Math.round(files.reduce((sum, entry) => sum + (entry.size ?? 0), 0) / 1024)),
        files: Math.max(1, files.length),
        summary: describeSkill(await manifest.text()),
      };
      setCustomSkills([...customSkills(), skill]);
      return { ok: true, id };
    }
    return { ok: false, error: `${link.repo} has no branch or tag ${link.rest[0]}, or GitHub does not show it` };
  } catch {
    return { ok: false, error: 'GitHub did not answer: is this browser online?' };
  }
}

export function removeSkill(id: string): { ok: boolean; error?: string } {
  if (!customSkills().some((skill) => skill.id === id)) return { ok: false, error: 'not one of your skills' };
  setCustomSkills(customSkills().filter((skill) => skill.id !== id));
  return { ok: true };
}
