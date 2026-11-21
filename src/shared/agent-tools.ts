// What an agent of a team may use besides its role and its skills, for its session only: limits on the tools of
// Claude Code (it reads and writes nothing, no shell, no git push, no web: --disallowedTools) and MCP servers of a
// small catalog, pinned to a version (a browser, Chrome with its DevTools, the docs of libraries: in the MCP
// configuration of its session, its tools allowed without asking, since you gave them to that agent). An agent can
// also start without the MCP servers of your Claude Code (--strict-mcp-config): only its own and those of the team.
// A team file carries only ids of the catalog, never a command: opening a team from someone else runs nothing new.
// No Node module here: the page uses it too.

export type ToolLimitId = 'read-only' | 'no-bash' | 'no-push' | 'no-web';

export interface ToolLimit {
  id: ToolLimitId;
  /** As the box and the studio show it. */
  label: string;
  /** The rules of Claude Code it denies (--disallowedTools). */
  rules: readonly string[];
  /** What it means, for the studio. */
  summary: string;
  /** What the agent is told, in its system prompt. */
  prompt: string;
}

export const TOOL_LIMITS: readonly ToolLimit[] = [
  {
    id: 'read-only',
    label: 'read only',
    rules: ['Edit', 'Write', 'NotebookEdit'],
    summary: 'It reads the files and changes none: no Edit, Write or NotebookEdit. It can still run commands, unless "no shell" is on too.',
    prompt: 'you do not edit files (Edit, Write and NotebookEdit are not yours): you read, run what you need to check, and report',
  },
  { id: 'no-bash', label: 'no shell', rules: ['Bash'], summary: 'No shell commands at all (no Bash).', prompt: 'you run no shell commands (Bash is not yours)' },
  { id: 'no-push', label: 'no git push', rules: ['Bash(git push:*)'], summary: 'git push is refused; the rest of git works.', prompt: 'you never git push: pushing is left to the user' },
  { id: 'no-web', label: 'no web', rules: ['WebFetch', 'WebSearch'], summary: 'No web pages fetched and no web searches.', prompt: 'you do not fetch web pages nor search the web' },
];

export interface McpServerInfo {
  /** Also its name in Claude Code: its tools are mcp__<id>__<tool>. */
  id: string;
  /** As the box and the studio show it. */
  label: string;
  /** The npm package, run with npx at this version. */
  package: string;
  version: string;
  /** Its options after the package. */
  args: readonly string[];
  license: string;
  /** owner/name on GitHub. */
  repo: string;
  summary: string;
  /** Whom it talks to besides the pages it opens, when it does. */
  network?: string;
}

/**
 * The catalog, chosen and pinned (versions published at least two weeks before): the browsers run headless, with a
 * profile kept in memory, so that several agents can use one at the same time; the statistics of Chrome DevTools
 * are off, as Forchetta has none.
 */
export const MCP_SERVERS: readonly McpServerInfo[] = [
  {
    id: 'playwright',
    label: 'browser',
    package: '@playwright/mcp',
    version: '0.0.84',
    args: ['--headless', '--isolated'],
    license: 'Apache-2.0',
    repo: 'microsoft/playwright-mcp',
    summary: 'A browser it drives: it opens the pages of your app, clicks, fills forms and reads what is on the page. Headless, with a profile of its own that is not kept.',
  },
  {
    id: 'chrome-devtools',
    label: 'Chrome DevTools',
    package: 'chrome-devtools-mcp',
    version: '1.12.0',
    args: ['--headless', '--isolated', '--no-usage-statistics', '--no-performance-crux'],
    license: 'Apache-2.0',
    repo: 'ChromeDevTools/chrome-devtools-mcp',
    summary: 'Chrome with its DevTools: the console, the network requests and the performance of a page. Headless, without usage statistics.',
  },
  {
    id: 'context7',
    label: 'library docs',
    package: '@upstash/context7-mcp',
    version: '4.5.1',
    args: [],
    license: 'MIT',
    repo: 'upstash/context7',
    summary: 'The docs of libraries and frameworks as they are now, version by version, instead of what the model remembers.',
    network: 'it asks context7.com, with the names of the libraries it looks up',
  },
];

export const mcpServerById = (id: string): McpServerInfo | undefined => MCP_SERVERS.find((server) => server.id === id);
export const toolLimitById = (id: string): ToolLimit | undefined => TOOL_LIMITS.find((limit) => limit.id === id);

/** What an agent gets besides its role: limits, MCP servers, and whether the MCP servers of your Claude Code start too. */
export interface AgentTools {
  limits?: ToolLimitId[];
  /** Ids of the catalog, for its session only. */
  mcp?: string[];
  /** Only its own MCP servers and those of the team: none of your Claude Code (yours, and those of the project). */
  strictMcp?: boolean;
}

/** The tools of an agent as sent, checked: known ids, each once, in the order of the catalog; undefined for none. */
export function cleanTools(raw: unknown): { tools?: AgentTools } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'tools: limits, MCP servers and strictMcp' };
  const input = raw as Record<string, unknown>;
  const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : []);
  const limits = ids(input.limits);
  for (const id of limits) if (!toolLimitById(id)) return { error: `unknown tool limit "${id}": the limits are ${TOOL_LIMITS.map((limit) => limit.id).join(', ')}` };
  const mcp = ids(input.mcp);
  for (const id of mcp) if (!mcpServerById(id)) return { error: `unknown MCP server "${id}": the catalog has ${MCP_SERVERS.map((server) => server.id).join(', ')}` };
  const tools: AgentTools = {
    ...(limits.length > 0 ? { limits: TOOL_LIMITS.filter((limit) => limits.includes(limit.id)).map((limit) => limit.id) } : {}),
    ...(mcp.length > 0 ? { mcp: MCP_SERVERS.filter((server) => mcp.includes(server.id)).map((server) => server.id) } : {}),
    ...(input.strictMcp === true ? { strictMcp: true } : {}),
  };
  return Object.keys(tools).length > 0 ? { tools } : {};
}

/** Whether an agent has anything of its own here. */
export const hasTools = (tools: AgentTools | undefined): tools is AgentTools => !!tools && (!!tools.limits?.length || !!tools.mcp?.length || tools.strictMcp === true);

/** "read only, no git push, browser": the tools of an agent in a few words, for its box and the lines of the team. */
export function toolsText(tools: AgentTools | undefined): string {
  if (!hasTools(tools)) return '';
  return [
    ...(tools.limits ?? []).map((id) => toolLimitById(id)?.label ?? id),
    ...(tools.mcp ?? []).map((id) => mcpServerById(id)?.label ?? id),
    ...(tools.strictMcp ? ['none of your MCP servers'] : []),
  ].join(', ');
}

/** What its session is started with: the rules it denies, the MCP servers it gets, those allowed without asking. */
export function sessionTools(tools: AgentTools | undefined): { disallowed: string[]; servers: Record<string, { type: 'stdio'; command: string; args: string[] }>; allowed: string[]; strict: boolean } {
  const servers: Record<string, { type: 'stdio'; command: string; args: string[] }> = {};
  for (const id of tools?.mcp ?? []) {
    const server = mcpServerById(id);
    if (server) servers[server.id] = { type: 'stdio', command: 'npx', args: ['-y', `${server.package}@${server.version}`, ...server.args] };
  }
  return {
    disallowed: [...new Set((tools?.limits ?? []).flatMap((id) => toolLimitById(id)?.rules ?? []))],
    servers,
    allowed: Object.keys(servers).map((id) => `mcp__${id}`),
    strict: tools?.strictMcp === true,
  };
}

/** What an agent is told of its tools, in its system prompt; empty when it has nothing of its own. */
export function toolsPrompt(tools: AgentTools | undefined): string {
  if (!hasTools(tools)) return '';
  const limits = (tools.limits ?? []).map((id) => toolLimitById(id)?.prompt).filter(Boolean);
  const servers = (tools.mcp ?? []).map((id) => mcpServerById(id)).filter((server): server is McpServerInfo => !!server);
  return [
    ...(servers.length > 0 ? [`Your tools in the team, for you only: ${servers.map((server) => `${server.label} (the MCP server "${server.id}", its tools mcp__${server.id}__*)`).join('; ')}. Use them where your role needs them.`] : []),
    ...(limits.length > 0 ? [`Your limits in the team: ${limits.join('; ')}. Claude Code refuses those tools to you: do not try them, and say in your report what someone else has to do.`] : []),
  ].join(' ');
}
