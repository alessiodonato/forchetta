import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEAM_MCP } from './crew.ts';
import { ensurePrivateDir, paths } from './paths.ts';

// The MCP server of Forchetta (mcp/team.ts) as a session gets it: a configuration of its own in
// var/crews/mcp/<agent>.json, passed to claude with --mcp-config. The daemon writes it for the sessions it starts,
// `forchetta run` for its own; the daemon takes it away when it forgets the session.

/** How long Claude Code lets a call to a tool of the team run: the longest wait for answers, and a margin. */
export const TEAM_MCP_TIMEOUT_MS = 11 * 60_000;

/** How Claude Code starts the MCP server: node and its script. */
export interface TeamMcpServer {
  command: string;
  args: string[];
}

/**
 * The MCP configuration of one session: the server knows the session by FORCHETTA_AGENT, the daemon by
 * FORCHETTA_VAR, and its tools by FORCHETTA_TEAM_TOOLS (Claude Code lists them once, when the daemon may be
 * restarting; the daemon still checks every call).
 */
export function teamMcpConfig(server: TeamMcpServer, agentId: string, varDir: string, tools: readonly string[]): object {
  return {
    mcpServers: {
      [TEAM_MCP]: {
        type: 'stdio',
        command: server.command,
        args: server.args,
        env: { FORCHETTA_AGENT: agentId, FORCHETTA_VAR: varDir, FORCHETTA_TEAM_TOOLS: tools.join(',') },
        // wait_for_answers waits up to 10 minutes: more than the default time of a call to a tool.
        timeout: TEAM_MCP_TIMEOUT_MS,
      },
    },
  };
}

/** The file of the MCP configuration of a session. */
export const mcpConfigFile = (agentId: string): string => join(paths.crewMcp, `${agentId}.json`);

/** Writes the MCP configuration of a session (0600), and gives its path. */
export function writeMcpConfig(server: TeamMcpServer, agentId: string, tools: readonly string[]): string {
  ensurePrivateDir(paths.crewMcp);
  const file = mcpConfigFile(agentId);
  writeFileSync(file, `${JSON.stringify(teamMcpConfig(server, agentId, paths.varDir, tools), null, 2)}\n`, { mode: 0o600 });
  return file;
}
