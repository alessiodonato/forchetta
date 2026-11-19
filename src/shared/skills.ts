// The skills of Claude Code an agent of a team can have: a catalog of open-source ones, chosen and pinned to a commit
// (19/11/2026). Nothing is downloaded until a team uses one: then the daemon fetches only its folder, at that commit,
// into the cache of Forchetta (daemon/skills.ts), and each session gets its own skills as a plugin for that session
// only (claude --plugin-dir). The folder of the project stays as it was, and an agent carries only the names and
// descriptions of its own skills until it uses one. No Node module here: the page uses it too.

export type SkillGroup = 'yours' | 'plan' | 'build' | 'quality' | 'review' | 'security' | 'test' | 'docs';

export const SKILL_GROUPS: readonly [SkillGroup, string][] = [
  ['yours', 'Yours'],
  ['plan', 'Plan'],
  ['build', 'Build'],
  ['quality', 'Debug & quality'],
  ['review', 'Review'],
  ['security', 'Security'],
  ['test', 'Test'],
  ['docs', 'Docs'],
];

export interface SkillInfo {
  /** The name of its folder: also its name for Claude Code, and how a team refers to it. */
  id: string;
  group: SkillGroup;
  /** The repository on GitHub, owner/name. */
  repo: string;
  /** Its folder in the repository, with its SKILL.md. */
  path: string;
  /** The commit it is taken from: the version that was checked, never a branch that moves. */
  commit: string;
  /** Of the catalog: checked. Of yours: unknown, it is in its repository. */
  license: 'MIT' | 'Apache-2.0' | 'CC-BY-SA-4.0' | 'unknown';
  /**
   * One of yours from a folder of this Mac: used where it is (no repository, no commit), so your changes count from
   * the next session that has it.
   */
  local?: string;
  /** How much it weighs, in KB, and in how many files: what the first use downloads. */
  kb: number;
  files: number;
  /** What it is for, in a line. */
  summary: string;
}

const SUPERPOWERS = { repo: 'obra/superpowers', commit: '22f0b463e7a5e579904dd6211a520321035526f7', license: 'MIT' } as const;
const ANTHROPIC = { repo: 'anthropics/skills', commit: 'e4bb5d960d87126ff3b3a8af1a104b7db67560ba', license: 'Apache-2.0' } as const;
const ADDY = { repo: 'addyosmani/agent-skills', commit: '8c99fa36d90068c82d547f7c12a9d67a3e95f4ee', license: 'MIT' } as const;
const VERCEL = { repo: 'vercel-labs/agent-skills', commit: '1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62', license: 'MIT' } as const;
const TRAIL = { repo: 'trailofbits/skills', commit: '149d7b21f4067765b82e67029730b42d228ef4b4', license: 'CC-BY-SA-4.0' } as const;
const KARPATHY = { repo: 'multica-ai/andrej-karpathy-skills', commit: '2c606141936f1eeef17fa3043a72095b4765b9c2', license: 'MIT' } as const;

export const SKILLS: readonly SkillInfo[] = [
  { id: 'brainstorming', group: 'plan', ...SUPERPOWERS, path: 'skills/brainstorming', kb: 78, files: 8, summary: 'Turns an idea into a design through questions and options, before anything is built.' },
  { id: 'writing-plans', group: 'plan', ...SUPERPOWERS, path: 'skills/writing-plans', kb: 10, files: 1, summary: 'Writes a step-by-step implementation plan from a spec, before touching code.' },
  { id: 'executing-plans', group: 'plan', ...SUPERPOWERS, path: 'skills/executing-plans', kb: 21, files: 3, summary: 'Carries out a written plan in batches, with checkpoints to review.' },
  { id: 'spec-driven-development', group: 'plan', ...ADDY, path: 'skills/spec-driven-development', kb: 17, files: 1, summary: 'Writes the spec first when a feature or change has none: goals, scope, acceptance.' },
  { id: 'planning-and-task-breakdown', group: 'plan', ...ADDY, path: 'skills/planning-and-task-breakdown', kb: 10, files: 1, summary: 'Breaks a spec into ordered, small tasks, and finds what can run in parallel.' },

  { id: 'test-driven-development', group: 'build', ...SUPERPOWERS, path: 'skills/test-driven-development', kb: 17, files: 2, summary: 'Red, green, refactor: the failing test first, for every feature and fix.' },
  { id: 'incremental-implementation', group: 'build', ...ADDY, path: 'skills/incremental-implementation', kb: 9, files: 1, summary: 'Delivers a change in thin slices, each one verified before the next.' },
  { id: 'karpathy-guidelines', group: 'build', ...KARPATHY, path: 'skills/karpathy-guidelines', kb: 2, files: 1, summary: 'Guards against common mistakes of coding models: overbuilding, broad edits, unstated assumptions.' },
  { id: 'frontend-design', group: 'build', ...ANTHROPIC, path: 'skills/frontend-design', kb: 19, files: 2, summary: 'Deliberate visual design for new UI: direction, type, layout that does not look templated.' },
  { id: 'react-best-practices', group: 'build', ...VERCEL, path: 'skills/react-best-practices', kb: 225, files: 76, summary: 'React and Next.js performance rules from Vercel, for writing and reviewing components.' },
  { id: 'mcp-builder', group: 'build', ...ANTHROPIC, path: 'skills/mcp-builder', kb: 155, files: 11, summary: 'Builds MCP servers with well-designed tools, in Python or TypeScript.' },

  { id: 'systematic-debugging', group: 'quality', ...SUPERPOWERS, path: 'skills/systematic-debugging', kb: 28, files: 6, summary: 'Finds the root cause of a bug or a failing test before proposing a fix.' },
  { id: 'verification-before-completion', group: 'quality', ...SUPERPOWERS, path: 'skills/verification-before-completion', kb: 4, files: 1, summary: 'Runs the checks and reads their output before saying anything is done.' },
  { id: 'code-simplification', group: 'quality', ...ADDY, path: 'skills/code-simplification', kb: 13, files: 1, summary: 'Makes working code simpler to read and change, without changing what it does.' },
  { id: 'performance-optimization', group: 'quality', ...ADDY, path: 'skills/performance-optimization', kb: 26, files: 2, summary: 'Measures, then fixes slow paths: frontend, backend, queries, N+1.' },

  { id: 'requesting-code-review', group: 'review', ...SUPERPOWERS, path: 'skills/requesting-code-review', kb: 9, files: 2, summary: 'Asks for a review at the right moments, with what the reviewer needs.' },
  { id: 'receiving-code-review', group: 'review', ...SUPERPOWERS, path: 'skills/receiving-code-review', kb: 6, files: 1, summary: 'Checks review feedback on its merits before applying it, instead of agreeing blindly.' },
  { id: 'code-review-and-quality', group: 'review', ...ADDY, path: 'skills/code-review-and-quality', kb: 21, files: 1, summary: 'Reviews a change on several axes before it is merged: correctness, design, tests, risk.' },
  { id: 'differential-review', group: 'review', ...TRAIL, path: 'plugins/differential-review/skills/differential-review', kb: 36, files: 7, summary: 'Security review of a diff: blast radius, callers, test coverage, with a written report.' },

  { id: 'security-and-hardening', group: 'security', ...ADDY, path: 'skills/security-and-hardening', kb: 30, files: 2, summary: 'Hardens input handling, auth and storage against the OWASP Top Ten.' },
  { id: 'supply-chain-risk-auditor', group: 'security', ...TRAIL, path: 'plugins/supply-chain-risk-auditor/skills/supply-chain-risk-auditor', kb: 225, files: 13, summary: 'Audits the dependencies: advisories, abandoned packages, install scripts.' },

  { id: 'webapp-testing', group: 'test', ...ANTHROPIC, path: 'skills/webapp-testing', kb: 22, files: 6, summary: 'Tests a local web app with Playwright: flows, screenshots, browser logs.' },
  { id: 'property-based-testing', group: 'test', ...TRAIL, path: 'plugins/property-based-testing/skills/property-based-testing', kb: 39, files: 9, summary: 'Writes property-based tests that cover a whole input domain (Hypothesis, fast-check…).' },
  { id: 'accessibility-engineering', group: 'test', ...ADDY, path: 'skills/accessibility-engineering', kb: 15, files: 2, summary: 'Audits an interface for WCAG 2.2 AA and fixes what fails.' },

  { id: 'documentation-and-adrs', group: 'docs', ...ADDY, path: 'skills/documentation-and-adrs', kb: 12, files: 1, summary: 'Records decisions as ADRs and catches docs that drifted from the code.' },
  { id: 'pdf', group: 'docs', ...ANTHROPIC, path: 'skills/pdf', kb: 67, files: 12, summary: 'Reads, fills, merges, splits and creates PDF files.' },
  { id: 'docx', group: 'docs', ...ANTHROPIC, path: 'skills/docx', kb: 1139, files: 61, summary: 'Creates and edits Word documents, with tracked changes and comments.' },
];

/** At most this many skills for one agent: each one adds its name and description to what the session carries. */
export const SKILLS_PER_AGENT_MAX = 8;

/**
 * The skills you added (daemon/custom-skills.ts): from a link of GitHub, at the commit of when you added it, or from a
 * folder of this Mac. The daemon keeps them and says them to the page; both put them here, next to the catalog.
 */
let yours: readonly SkillInfo[] = [];

export function setCustomSkills(skills: readonly SkillInfo[]): void {
  yours = skills;
}

export const customSkills = (): readonly SkillInfo[] => yours;

/** Yours first, then the catalog. */
export const allSkills = (): readonly SkillInfo[] => [...yours, ...SKILLS];

export const skillById = (id: string): SkillInfo | undefined => SKILLS.find((skill) => skill.id === id) ?? yours.find((skill) => skill.id === id);

/** Where a skill is on GitHub, at its commit: for the page, and for you to read it before using it. */
export const skillUrl = (skill: Pick<SkillInfo, 'repo' | 'commit' | 'path'>): string => `https://github.com/${skill.repo}/tree/${skill.commit}/${skill.path}`;

/** The skills of an agent as sent, checked: known ones, each once, at most 8. Undefined for none. */
export function cleanSkills(raw: unknown): { skills?: string[] } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  if (!Array.isArray(raw)) return { error: 'skills: a list of names' };
  const out: string[] = [];
  for (const item of raw) {
    const id = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (!id) continue;
    if (!skillById(id)) return { error: `the skill "${String(item).slice(0, 40)}" is not in the catalog of Forchetta, nor among the skills the user added` };
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > SKILLS_PER_AGENT_MAX) return { error: `${SKILLS_PER_AGENT_MAX} skills at most for one agent` };
  return out.length > 0 ? { skills: out } : {};
}
