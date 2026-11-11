#!/usr/bin/env node
// A scripted Claude Code for the simulation (scripts/dev/sim.sh): it draws a screen like the one of Claude Code
// 2.1.322 (the input box between two rules, "❯", a named rule with --name), takes typed keys and bracketed
// pastes, and sends the hooks of a real session to the test daemon, with its pid, pane and agent. What it "does"
// is a script: a member of a team runs a few tools and answers; the lead of a team gives work to its members and
// waits for their answers through the same routes as the MCP server of the team (/api/crew/*). So a team started
// from the app goes through the real daemon, queue and panels, with no Claude and no tokens. Used for the demo
// recording and to try the teams by hand; never by the real daemon.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The arguments of a real claude, as bin/forchetta-start passes them.
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 && index < (args.includes('--') ? args.indexOf('--') : args.length) ? args[index + 1] : undefined;
};
const name = option('--name');
const system = option('--append-system-prompt') ?? '';
const firstPrompt = args.includes('--') ? args.slice(args.indexOf('--') + 1).join(' ') : undefined;
const model = option('--model') === 'haiku' ? 'claude-haiku-4-5' : option('--model') === 'sonnet' ? 'claude-sonnet-5-5' : 'claude-opus-5-5';

// The MCP configuration of a team session tells its agent, its tools and the folder of the daemon.
let mcpEnv = {};
try {
  const file = option('--mcp-config');
  if (file) mcpEnv = JSON.parse(readFileSync(file, 'utf8')).mcpServers?.forchetta?.env ?? {};
} catch {
  // Not in a team, or no file: the plain session.
}
const varDir = process.env.FORCHETTA_VAR ?? mcpEnv.FORCHETTA_VAR ?? join(ROOT, 'var', 'sim');
const agentId = process.env.FORCHETTA_AGENT ?? mcpEnv.FORCHETTA_AGENT ?? '';
const tools = (mcpEnv.FORCHETTA_TEAM_TOOLS ?? '').split(',').filter(Boolean);
const isLead = tools.includes('send_request');
/** The members of a lead, from its system prompt: "- tester (answers you): …". */
const members = [...system.matchAll(/^- (.+?) \((answers you|executes only)/gm)].map((match) => ({ name: match[1], answers: match[2] === 'answers you' }));

// --worktree <name>, as Claude Code does it: a git worktree in .claude/worktrees/<name> of the repository, on a
// branch of its own, and the session works there.
const worktree = option('--worktree');
if (worktree && !worktree.startsWith('-')) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dir = join(root, '.claude', 'worktrees', worktree);
    if (!existsSync(dir)) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', `worktree-${worktree}`, dir], { stdio: 'ignore' });
    process.chdir(dir);
  } catch {
    // Not a repository: the folder as it is.
  }
}

const sessionId = randomUUID();
const cwd = process.cwd();
const daemon = () => JSON.parse(readFileSync(join(varDir, 'daemon.json'), 'utf8'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hook(event, extra = {}) {
  try {
    await fetch(`http://127.0.0.1:${daemon().port}/forchetta/hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forchetta-claude-pid': String(process.pid),
        'x-forchetta-pane': process.env.TMUX_PANE ?? '',
        'x-forchetta-agent': agentId,
      },
      body: JSON.stringify({ session_id: sessionId, cwd, transcript_path: `/tmp/fake-${sessionId}.jsonl`, hook_event_name: event, ...extra }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // The daemon is not there: a real session does not notice either.
  }
}

/** A route of the tools of the team, as dist/team-mcp.js calls it. */
async function crew(route, body) {
  const info = daemon();
  const response = await fetch(`http://127.0.0.1:${info.port}/api/crew/${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agent: agentId, ...body }),
    signal: AbortSignal.timeout(route === 'wait-poll' ? 75_000 : 10_000),
  });
  return response.json();
}

// ---- The screen ---------------------------------------------------------------------------------------------

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  undim: '\x1b[22m',
  gray: '\x1b[38;5;244m',
  light: '\x1b[38;5;246m',
  orange: '\x1b[38;5;174m',
  green: '\x1b[38;5;114m',
  fg: '\x1b[39m',
};
/** What the session showed, oldest first. */
const entries = [];
let input = []; // segments: { text } or { paste, n }
let pastes = 0;
let busySince;
let busyWord = 'Thinking';

const width = () => Math.max(40, process.stdout.columns || 100);
const height = () => Math.max(12, process.stdout.rows || 30);

function wrap(text, size) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line && line.length + 1 + word.length > size) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

function entryLines(entry, size) {
  switch (entry.kind) {
    case 'prompt': {
      const lines = wrap(entry.text, size - 2);
      const shown = lines.length > 5 ? [...lines.slice(0, 4), '…'] : lines;
      return ['', ...shown.map((line, index) => `${C.gray}${index === 0 ? '> ' : '  '}${line}${C.fg}`)];
    }
    case 'tool':
      return ['', `${C.green}⏺${C.fg} ${C.bold}${entry.name}${C.reset}(${entry.arg})`, ...(entry.result ? wrap(entry.result, size - 7).map((line, index) => `  ${C.gray}${index === 0 ? '⎿  ' : '   '}${line}${C.fg}`) : [])];
    case 'text':
      return ['', ...wrap(entry.text, size - 2).map((line, index) => `${index === 0 ? '⏺ ' : '  '}${line}`)];
    default:
      return [];
  }
}

function inputText() {
  return input.map((segment) => (segment.paste === undefined ? segment.text : segment.paste)).join('');
}

/** The input box as Claude Code draws it: a long paste becomes "[Pasted text #1 +N lines]". */
function boxLines(size) {
  if (input.length === 0) return [`❯ ${C.dim}Try "add a test for the orders"${C.undim}`];
  const shown = input
    .map((segment) => {
      if (segment.paste === undefined) return segment.text;
      const lines = segment.paste.split('\n').length;
      return segment.paste.length > 800 || lines > 3 ? `[Pasted text #${segment.n} +${lines - 1} lines]` : segment.paste;
    })
    .join('');
  return wrap(shown, size - 2).map((line, index) => `${index === 0 ? '❯ ' : '  '}${line}`);
}

function draw() {
  const size = width();
  const rule = `${C.gray}${name ? `${'─'.repeat(Math.max(10, size - name.length - 3))} ${name} ─` : '─'.repeat(size)}${C.fg}`;
  const bottom = [rule, ...boxLines(size), `${C.gray}${'─'.repeat(size)}${C.fg}`, `  ${C.light}${isLead || tools.length ? 'team tools: forchetta' : '? for shortcuts'}${C.fg}`];
  const spinner = busySince ? ['', `${C.orange}✻ ${busyWord}… ${C.gray}(${Math.round((Date.now() - busySince) / 1000)}s · esc to interrupt)${C.fg}`] : [];
  const header = [
    `${C.orange}╭${'─'.repeat(Math.min(size, 60) - 2)}╮${C.fg}`,
    `${C.orange}│${C.fg} ${C.orange}✻${C.fg} ${C.bold}Claude Code${C.reset} ${C.gray}· ${name ?? 'session'} · ${model}${C.fg}`,
    `${C.orange}│${C.fg}   ${C.gray}${cwd}${C.fg}`,
    `${C.orange}╰${'─'.repeat(Math.min(size, 60) - 2)}╯${C.fg}`,
  ];
  const body = [...header, ...entries.flatMap((entry) => entryLines(entry, size)), ...spinner, ''];
  const room = height() - bottom.length;
  const lines = [...body.slice(Math.max(0, body.length - room)), ...bottom];
  process.stdout.write(`\x1b[H\x1b[2J${lines.join('\r\n')}`);
}

// ---- The keys -----------------------------------------------------------------------------------------------

let pasting;
function onData(chunk) {
  let data = chunk.toString('utf8');
  while (data.length > 0) {
    if (pasting !== undefined) {
      const end = data.indexOf('\x1b[201~');
      pasting += end < 0 ? data : data.slice(0, end);
      if (end < 0) return;
      input.push({ paste: pasting.replace(/\r\n?/g, '\n'), n: ++pastes });
      pasting = undefined;
      data = data.slice(end + 6);
      continue;
    }
    if (data.startsWith('\x1b[200~')) {
      pasting = '';
      data = data.slice(6);
      continue;
    }
    const escape = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(data);
    if (escape) {
      data = data.slice(escape[0].length);
      continue;
    }
    const key = data[0];
    data = data.slice(1);
    if (key === '\r' || key === '\n') submit();
    else if (key === '\x7f' || key === '\b') {
      const last = input.at(-1);
      if (last?.paste !== undefined || (last && last.text.length <= 1)) input.pop();
      else if (last) last.text = last.text.slice(0, -1);
    } else if (key === '\x03') input = [];
    else if (key >= ' ' || key === '\t') {
      const last = input.at(-1);
      if (last && last.paste === undefined) last.text += key;
      else input.push({ text: key });
    }
  }
  draw();
}

// ---- The turns ----------------------------------------------------------------------------------------------

const queue = [];
let running = false;

function submit() {
  const prompt = inputText().trim();
  input = [];
  if (!prompt) return;
  queue.push(prompt);
  if (!running) void next();
}

async function next() {
  running = true;
  while (queue.length > 0) {
    const prompt = queue.shift();
    if (prompt === '/exit') {
      await hook('SessionEnd', { reason: 'prompt_input_exit' });
      process.exit(0);
    }
    entries.push({ kind: 'prompt', text: prompt });
    busySince = Date.now();
    busyWord = 'Thinking';
    draw();
    await hook('UserPromptSubmit', { prompt });
    let reply;
    try {
      reply = await turn(prompt);
    } catch (error) {
      reply = `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
    }
    entries.push({ kind: 'text', text: reply });
    busySince = undefined;
    draw();
    await hook('Stop', { last_assistant_message: reply });
  }
  running = false;
}

/** One tool: its hooks before and after, and its lines on screen. */
async function tool(toolName, toolInput, arg, result, ms) {
  busyWord = toolName.startsWith('mcp__') ? 'Waiting' : toolName === 'Bash' ? 'Running' : 'Working';
  const entry = { kind: 'tool', name: toolName.startsWith('mcp__') ? `${toolName.split('__')[1]} - ${toolName.split('__')[2]} (MCP)` : toolName, arg };
  entries.push(entry);
  draw();
  await hook('PreToolUse', { tool_name: toolName, tool_input: toolInput });
  const value = typeof ms === 'function' ? await ms() : (await wait(ms), result);
  entry.result = typeof value === 'string' ? value : result;
  draw();
  await hook('PostToolUse', { tool_name: toolName, tool_input: toolInput, tool_response: {} });
  return value;
}

const file = (path) => join(cwd, path);
const read = (path, ms = 1400) => tool('Read', { file_path: file(path) }, path, `Read ${80 + path.length * 3} lines`, ms);
const edit = (path, ms = 1800) => tool('Edit', { file_path: file(path), old_string: '…', new_string: '…' }, path, 'Updated with 2 additions and 1 removal', ms);
const write = (path, ms = 1800) => tool('Write', { file_path: file(path), content: '…' }, path, `Wrote 64 lines to ${path}`, ms);
const bash = (command, result, ms = 2200) => tool('Bash', { command }, command, result, ms);
const grep = (pattern, result, ms = 1200) => tool('Grep', { pattern }, `pattern: "${pattern}"`, result, ms);

/** What each kind of member does with a request, and what it says at the end. */
const WORK = {
  developer: async () => {
    await read('src/checkout/form.tsx');
    await edit('src/checkout/form.tsx');
    await edit('src/checkout/order.ts');
    await edit('src/api/orders.ts');
    await bash('npm test -- checkout', '18 tests passed');
    return 'Guest checkout is in: the account is optional, the email is checked, and guest orders are saved with guest: true. Changed src/checkout/form.tsx, src/checkout/order.ts and src/api/orders.ts.';
  },
  reviewer: async () => {
    await read('src/checkout/order.ts');
    await grep('guest', 'Found 7 matches in 3 files');
    await read('src/routes/order-page.ts');
    await edit('src/routes/order-page.ts');
    return 'Reviewed. One fix: the order page showed any order to whoever had its link; it now asks for the email of the order. Nothing else to change.';
  },
  tester: async () => {
    await write('test/checkout.test.ts');
    await bash('npm test -- checkout', '22 tests passed', 2600);
    return 'Added 4 tests in test/checkout.test.ts (an order without account, a wrong email, the receipt, the order page): all 22 checkout tests pass.';
  },
};

const REQUESTS = {
  developer: (goal) => `${goal}\nBuild it in the repository, run the tests, and tell me which files you changed.`,
  check: (goal, names) => `Check the change of developer for: ${goal}\n${names.includes('reviewer') ? 'reviewer: review the code, and fix what is wrong. ' : ''}${names.includes('tester') ? 'tester: write the tests and run them.' : ''}`.trim(),
};

/** wait_for_answers, as the MCP server runs it: start, then poll until it is over. */
async function waitFor(requests) {
  return tool('mcp__forchetta__wait_for_answers', { requests }, `requests: [${requests.join(', ')}]`, '', async () => {
    const started = await crew('wait', { requests, minutes: 5 });
    if (!started.ok) return started.error ?? 'the wait did not start';
    for (;;) {
      const polled = await crew('wait-poll', { id: started.id });
      if (!polled.ok) return polled.error ?? 'the wait ended';
      if (polled.done) return (polled.answers ?? []).map((item) => `${item.from}, #${item.n}: ${item.answer ? `${item.answer.slice(0, 90).trim()}…` : item.status}`).join('\n') || 'No answer';
    }
  });
}

async function sendRequest(to, text) {
  const result = await tool('mcp__forchetta__send_request', { to, request: text }, `to: [${to.join(', ')}]`, '', async () => {
    const sent = await crew('request', { to, text });
    return sent.ok ? { n: sent.n, text: `Request #${sent.n} is in the queue of ${sent.to.join(', ')}.` } : { error: sent.error };
  });
  entries.at(-1).result = result.text ?? result.error;
  draw();
  return result.n;
}

async function turn(prompt) {
  const request = /^Request #(\d+) from (.+?):\s*([\s\S]*)$/.exec(prompt);
  if (isLead && request) {
    const goal = request[3].trim() || 'the goal of the user';
    await wait(1500);
    const builder = members.find((member) => member.name === 'developer') ?? members.find((member) => member.answers) ?? members[0];
    const checkers = members.filter((member) => member !== builder).map((member) => member.name);
    entries.push({ kind: 'text', text: `I'll have ${builder?.name ?? 'the team'} build it${checkers.length ? `, then ${checkers.join(' and ')} check it` : ''}.` });
    draw();
    if (!builder) return 'My team has no members.';
    const built = await sendRequest([builder.name], REQUESTS.developer(goal));
    if (built) await waitFor([built]);
    if (checkers.length > 0) {
      const checked = await sendRequest(checkers, REQUESTS.check(goal, checkers));
      if (checked) await waitFor([checked]);
    }
    await wait(1200);
    return checkers.includes('reviewer') && checkers.includes('tester')
      ? 'Guest checkout is ready: the account is optional and the receipt goes by email. developer built it (3 files), reviewer fixed the order page, which now asks for the email of the order, and tester added 4 tests: all 22 pass.'
      : `Done: ${goal}`;
  }
  if (request) {
    await wait(1000);
    const work = WORK[name ?? ''];
    if (work) return work();
    await read('README.md');
    await edit('src/index.ts');
    return `Done: ${request[3].split('\n')[0].trim()}`;
  }
  if (/^Answer from /.test(prompt) || /^Question from /.test(prompt)) {
    await wait(1200);
    return 'Noted.';
  }
  await wait(1200);
  await read('README.md');
  await edit('src/index.ts', 2000);
  return 'Done.';
}

// ---- Start --------------------------------------------------------------------------------------------------

if (process.stdin.isTTY) process.stdin.setRawMode(true);
// Bracketed paste on, and no terminal cursor: Claude Code draws its own in the box.
process.stdout.write('\x1b[?2004h\x1b[?25l');
process.stdin.on('data', onData);
process.stdout.on('resize', draw);
setInterval(() => {
  if (busySince) draw();
}, 1000);
for (const signal of ['SIGHUP', 'SIGTERM']) {
  process.on(signal, () => {
    void hook('SessionEnd', { reason: 'other' }).finally(() => process.exit(0));
  });
}
draw();
await hook('SessionStart', { source: 'startup', model });
if (firstPrompt) {
  queue.push(firstPrompt);
  void next();
}
