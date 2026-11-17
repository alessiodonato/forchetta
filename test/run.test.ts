import { describe, expect, it } from 'vitest';
import { takesTemplateTools, templateToolArgs } from '../src/cli/run.ts';

// `forchetta run claude [args]`: the tools of templates go first, so they are added only where nothing after them
// can be taken for one of their values, or refuse them.

describe('forchetta run and the tools of templates', () => {
  it('come with claude alone or with options first; not before a subcommand or a prompt', () => {
    expect(takesTemplateTools([])).toBe(true);
    expect(takesTemplateTools(['--continue'])).toBe(true);
    expect(takesTemplateTools(['--model', 'opus', 'fix the parser'])).toBe(true);
    expect(takesTemplateTools(['--', '-a prompt'])).toBe(true);
    expect(takesTemplateTools(['mcp', 'list'])).toBe(false);
    expect(takesTemplateTools(['fix the parser'])).toBe(false);
  });

  it('are the MCP configuration of the session, with reading allowed without asking', () => {
    expect(templateToolArgs('/F/var/crews/mcp/a.json')).toEqual(['--mcp-config', '/F/var/crews/mcp/a.json', '--allowedTools', 'mcp__forchetta__list_team_templates']);
  });
});
