#!/usr/bin/env node
// Simulated sessions for the visual and performance tests of the app: hook events posted to a daemon, as
// bin/forchetta-hook would. Run it against the separate test daemon (var/sim, port 47822), not the real one.
//
//   node scripts/dev/simulate.mjs --port 47822 --scenario mix|rest|busy [--loop 60] [--tmux N]
//
// mix: every state at once. rest: all quiet (the "a riposo" of the CPU test). busy: twelve sessions at work.
// --loop N keeps the busy ones changing tool, asking and finishing for N seconds.
// --tmux N runs the first N sessions in the tmux of the test daemon, with scripts/dev/demo-tui.sh: their boxes
// open a terminal. The program ends by itself after ten minutes, and the session with it.

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const port = Number(option('port', '47822'));
const scenario = option('scenario', 'mix');
const loopSeconds = Number(option('loop', '0'));
const tmuxCount = Number(option('tmux', '0'));

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VAR = process.env.FORCHETTA_VAR ?? join(ROOT, 'var', 'sim');
/** Session index -> Forchetta agent id, for the sessions run in tmux. */
const agents = new Map();

const PROJECTS = ['api-gateway', 'frontend', 'docs', 'data-pipeline', 'infra', 'mobile', 'billing', 'search', 'auth', 'analytics', 'legacy', 'scratch'];
const TOOLS = [
  ['Edit', { file_path: 'src/routes/orders.ts' }],
  ['Bash', { command: 'npm test -- --run' }],
  ['Read', { file_path: 'README.md' }],
  ['Grep', { pattern: 'TODO' }],
  ['WebFetch', { url: 'https://code.claude.com/docs/en/hooks' }],
  ['Task', { description: 'Find the slow tests', subagent_type: 'Explore' }],
  ['Write', { file_path: 'docs/api.md' }],
  ['Bash', { command: 'git status' }],
];

const session = (index) => ({ session_id: `sim-${String(index).padStart(2, '0')}`, cwd: `/Users/dev/projects/${PROJECTS[index]}`, transcript_path: `/tmp/sim-${index}.jsonl` });

async function post(index, event, extra = {}) {
  const body = JSON.stringify({ ...session(index), hook_event_name: event, ...extra });
  const agent = agents.get(index);
  const headers = { 'content-type': 'application/json', ...(agent ? { 'x-forchetta-agent': agent } : {}) };
  await fetch(`http://127.0.0.1:${port}/forchetta/hook`, { method: 'POST', headers, body });
}

/** The first sessions in tmux, announced to the daemon as `forchetta run` does. */
async function startTmux(count) {
  const info = JSON.parse(readFileSync(join(VAR, 'daemon.json'), 'utf8'));
  for (let index = 0; index < count; index++) {
    const id = randomUUID();
    const name = `fk-${id.slice(0, 8)}`;
    execFileSync('tmux', ['-u', '-S', join(VAR, 'tmux.sock'), '-f', join(ROOT, 'config', 'tmux.conf'), 'new-session', '-d', '-s', name, '-x', '120', '-y', '36', '--', '/bin/sh', join(ROOT, 'scripts', 'dev', 'demo-tui.sh'), PROJECTS[index]]);
    await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id, cwd: session(index).cwd, tmuxSession: name }),
    });
    agents.set(index, id);
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(index, prompt) {
  await post(index, 'SessionStart', { source: 'startup', model: 'claude-opus-5-5' });
  if (prompt) await post(index, 'UserPromptSubmit', { prompt });
}

async function tool(index, number = index) {
  const [name, input] = TOOLS[number % TOOLS.length];
  await post(index, 'PreToolUse', { tool_name: name, tool_input: input });
}

async function finish(index, reply) {
  await post(index, 'Stop', { last_assistant_message: reply });
}

const PROMPTS = [
  'Add retries with backoff to the order client, then the tests',
  'Move the settings page to the new layout',
  'Rebuild the docs site and fix the broken links',
  'Migrate the jobs to the new schema',
  'Check the staging changes before the deploy',
  'Fix the crash on the onboarding screen',
  'Validate IBANs on the payment form',
  'Find why the search endpoint is slow',
  'Design the login for the internal tools',
  'Generate the weekly report',
  'Put the legacy invoice code behind an adapter',
];

async function mix() {
  for (let index = 0; index < 12; index++) await start(index, PROMPTS[index]);
  await tool(0, 0);
  await tool(1, 1);
  await post(2, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist && npm run build' } });
  await finish(3, 'Done. The pipeline runs on the new schema and the 42 tests pass.');
  await post(4, 'PreCompact', { trigger: 'auto' });
  await post(5, 'StopFailure', { error: 'rate_limit', last_assistant_message: 'API Error: 429 rate limit exceeded, try again in a few minutes' });
  await finish(6, 'Added IBAN validation to the payment form, and the missing test.');
  await post(7, 'PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'slowQuery' }, agent_id: 'a1', agent_type: 'Explore' });
  await post(8, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'OAuth or API keys for the internal clients?' }] } });
  await finish(9, 'Weekly report written to reports/2026-11.md.');
  await finish(10, 'The legacy invoice code now sits behind an adapter, with no change in behavior.');
  await post(11, 'SessionEnd', { reason: 'prompt_input_exit' });
}

async function rest() {
  for (let index = 0; index < 12; index++) {
    await start(index, `Work on the ${PROJECTS[index]} module`);
    await finish(index, `Done: ${PROJECTS[index]} updated and checked.`);
  }
}

async function busy() {
  for (let index = 0; index < 12; index++) {
    await start(index, `Refactor ${PROJECTS[index]}`);
    await tool(index);
  }
}

async function loop(seconds) {
  const end = Date.now() + seconds * 1000;
  let step = 0;
  while (Date.now() < end) {
    step++;
    const index = step % 12;
    if (scenario === 'mix' && [5, 11, 2, 8].includes(index)) {
      await pause(250);
      continue;
    }
    if (step % 9 === 0) {
      await finish(index, `Done step ${step} of ${PROJECTS[index]}.`);
      await pause(1200);
      await post(index, 'UserPromptSubmit', { prompt: `Go on with ${PROJECTS[index]}` });
    } else {
      await tool(index, step);
    }
    await pause(250);
  }
}

const scenarios = { mix, rest, busy };
if (tmuxCount > 0) await startTmux(tmuxCount);
await scenarios[scenario]();
if (loopSeconds > 0) await loop(loopSeconds);
console.log(`simulazione "${scenario}" inviata alla porta ${port}${loopSeconds ? ` (+${loopSeconds} s di attività)` : ''}`);
