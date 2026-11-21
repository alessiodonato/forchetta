import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { CrewTemplate, RolePreset } from '../shared/crew.ts';
import { DESCRIBE_MAX, DESCRIBE_SYSTEM, describePrompt, templateOfAnswer } from '../shared/describe.ts';
import { ensurePrivateDir, paths } from '../shared/paths.ts';
import { teamChecks } from '../shared/team-checks.ts';
import { TEMPLATE_SCHEMA } from '../shared/team-schema.ts';

// A team drawn from a sentence of the studio (shared/describe.ts): Claude Code in print mode writes its template.
// It runs as you, with your Claude Code (your account, your plan), but alone: none of your customizations
// (--safe-mode: no CLAUDE.md, no memory, no skills, plugins or MCP servers), no tools (--tools ""), no hook (so it
// is not a session of Forchetta and the guard is not asked), nothing kept of the conversation, in an empty private
// folder. Its answer must follow the schema of
// a template (--json-schema), and Forchetta checks it again; a wrong one is asked to be fixed, once. A team that
// works against itself (shared/team-checks.ts) goes back once too, with what does not hold together; if the second
// answer is refused, the first one stays.

export const DESCRIBE_MODEL = 'sonnet';
/** How long a team may take to be drawn, and what it may cost at most (it costs a few cents). */
const DESCRIBE_TIMEOUT_MS = 180_000;
const DESCRIBE_BUDGET_USD = '1';

export interface DescribeResult {
  ok: boolean;
  template?: CrewTemplate;
  error?: string;
  /** What it cost, at API prices, as Claude Code says. */
  usd?: number;
}

/** One run of claude: its stdout, or why there is none. */
export type DescribeRun = (args: string[], input: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The arguments of claude: print mode, the answer as JSON in the shape of a template, and nothing else of yours. */
export function describeArgs(model = DESCRIBE_MODEL): string[] {
  return [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(TEMPLATE_SCHEMA),
    '--system-prompt',
    DESCRIBE_SYSTEM,
    // None of your customizations: no CLAUDE.md, no memory, no skills, plugins, hooks or MCP servers.
    '--safe-mode',
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
    '--max-budget-usd',
    DESCRIBE_BUDGET_USD,
  ];
}

/** The environment of claude: the daemon's, without what would tie it to a session or to Forchetta. */
export function describeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of ['FORCHETTA_AGENT', 'FORCHETTA_VAR', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_PID']) delete out[name];
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  // The daemon of the app has the short PATH of the Finder: node next to the daemon, in case claude is a script.
  out.PATH = [dirname(process.execPath), out.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');
  return out;
}

/** What claude printed with --output-format json: the structured answer (or the text of the result) and the cost. */
export function readOutput(stdout: string): { answer?: unknown; usd?: number; error?: string } {
  // The last line that is a JSON object: a login profile or a warning may print before it.
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const output = JSON.parse(text) as { is_error?: boolean; result?: unknown; structured_output?: unknown; total_cost_usd?: unknown; subtype?: unknown };
      const usd = typeof output.total_cost_usd === 'number' ? output.total_cost_usd : undefined;
      if (output.is_error) return { error: typeof output.result === 'string' && output.result.trim() ? output.result.trim().slice(0, 300) : `claude stopped (${String(output.subtype ?? 'error')})`, ...(usd !== undefined ? { usd } : {}) };
      return { answer: output.structured_output ?? output.result, ...(usd !== undefined ? { usd } : {}) };
    } catch {
      continue;
    }
  }
  return { error: 'claude gave no answer' };
}

const runClaude =
  (claude: string): DescribeRun =>
  (args, input, options) =>
    new Promise((resolve) => {
      const child = spawn(claude, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: String(error) });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr: signal === 'SIGTERM' ? `${stderr}\n(stopped after ${Math.round(options.timeoutMs / 1000)} s)` : stderr });
      });
      child.stdin.end(input);
    });

/** The team of a description, drawn by Claude: its template, checked; or why there is none. */
export async function describeTeam(
  text: string,
  options: { claude: string | undefined; log: (message: string, level?: 'info' | 'warn' | 'error') => void; roles?: readonly RolePreset[]; templates?: readonly CrewTemplate[]; run?: DescribeRun; model?: string; dir?: string },
): Promise<DescribeResult> {
  const description = text.trim();
  if (!description) return { ok: false, error: 'describe the team first: what it is for, who does what' };
  if (description.length > DESCRIBE_MAX) return { ok: false, error: `a description of ${DESCRIBE_MAX} characters at most: put the details in the roles afterwards` };
  if (!options.claude) return { ok: false, error: `claude not found: set its path in ${paths.config} (paths.claude)` };
  const dir = options.dir ?? join(paths.varDir, 'describe');
  ensurePrivateDir(dir);
  const run = options.run ?? runClaude(options.claude);
  const args = describeArgs(options.model);
  const env = describeEnv();
  let prompt = describePrompt(description, options.roles);
  let usd = 0;
  // The first team, when it went back only for its warnings: it stays if the second answer is refused.
  let first: CrewTemplate | undefined;
  const started = Date.now();
  const drawn = (template: CrewTemplate, cost: { usd?: number }): DescribeResult => {
    // A name of a template you have gets a number: drawing never replaces one.
    const taken = new Set((options.templates ?? []).map((one) => one.name.toLowerCase()));
    let name = template.name;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${template.name.slice(0, 36)} ${n}`;
    const warnings = teamChecks(template).length;
    options.log(
      `describe a team: "${name}" drawn in ${Math.round((Date.now() - started) / 1000)} s, ${template.members.length + (template.lead.kind === 'claude' ? 1 : 0)} agents${usd > 0 ? `, $${usd.toFixed(3)}` : ''}${warnings > 0 ? `, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : ''}`,
    );
    return { ok: true, template: { ...template, name }, ...cost };
  };
  // A template Forchetta refuses, or one that works against itself, goes back once, with the reason.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await run(args, prompt, { cwd: dir, env, timeoutMs: DESCRIBE_TIMEOUT_MS });
    const output = readOutput(result.stdout);
    usd += output.usd ?? 0;
    const cost = usd > 0 ? { usd: Math.round(usd * 10_000) / 10_000 } : {};
    if (output.error || result.code !== 0) {
      const why = output.error ?? (result.stderr.trim().split('\n').at(-1) || `claude ended with code ${result.code}`);
      if (first) {
        options.log(`describe a team: the second answer failed (${why}): the first one stays`, 'warn');
        return drawn(first, cost);
      }
      options.log(`describe a team: ${why}`, 'warn');
      return { ok: false, error: `Claude could not draw it: ${why}`, ...cost };
    }
    const checked = templateOfAnswer(output.answer);
    if ('template' in checked) {
      const checks = teamChecks(checked.template);
      // The second one, unless it holds together less than the first.
      if (first) return drawn(checks.length > teamChecks(first).length ? first : checked.template, cost);
      if (checks.length === 0 || attempt === 2) return drawn(checked.template, cost);
      first = checked.template;
      prompt = `${describePrompt(description, options.roles)}\n\nForchetta warns about your last answer, as it would warn the user before the team starts:\n${checks.map((check) => `- ${check.text}`).join('\n')}\nWrite the whole team again with these fixed, unless the description asks for them as they are.\nYour last answer:\n${JSON.stringify(checked.template).slice(0, 20_000)}`;
      continue;
    }
    if (first) return drawn(first, cost);
    if (attempt === 2) return { ok: false, error: `Claude drew a team Forchetta cannot open: ${checked.error}`, ...cost };
    prompt = `${describePrompt(description, options.roles)}\n\nYour last answer was refused by Forchetta: ${checked.error}. Write the whole team again, fixed.\nYour last answer:\n${JSON.stringify(output.answer).slice(0, 20_000)}`;
  }
  return { ok: false, error: 'Claude could not draw it' };
}
