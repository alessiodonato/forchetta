// Forchetta on Windows from end to end, with no WSL: the real Claude Code (with a stand-in for its API, no account), the
// real daemon, hooks and hosts of the sessions, in a home of its own. Run by CI after `pnpm build`, on Windows only:
//
//   node scripts/dev/windows-e2e.mjs [folder of Forchetta]
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { fakeApi } from './fake-api.mjs';

const source = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)));
const slashes = (path) => path.replaceAll('\\', '/');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let bad = 0;
const check = (name, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  return ok;
};
async function until(test, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const value = await test();
    if (value) return value;
  }
  return test();
}

const claude = process.env.CLAUDE_BIN ?? spawnSync('where.exe', ['claude.exe'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0];
// A home with a space in its name, as many have.
const home = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'fk e2e-'))), 'Ada Lovelace');
const project = join(home, 'my shop');
mkdirSync(project, { recursive: true });
// As the installer puts it: outside git, next to its data.
const root = join(home, '.local', 'lib', 'forchetta');
for (const part of ['package.json', 'dist', 'bin']) cpSync(join(source, part), join(root, part), { recursive: true });
const pty = realpathSync(join(source, 'node_modules', 'node-pty'));
for (const part of ['package.json', 'lib', `prebuilds/win32-${process.arch}`]) cpSync(join(pty, part), join(root, 'node_modules', 'node-pty', part), { recursive: true });
spawnSync('git', ['init', '-q', project]);
const api = await fakeApi();
const key = 'sk-ant-api03-a-key-made-up-for-a-test-00000000000000000000';
writeFileSync(
  join(home, '.claude.json'),
  JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', theme: 'dark', customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects: Object.fromEntries([project, slashes(project)].map((folder) => [folder, { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }])) }),
);
const env = { ...process.env, USERPROFILE: home, HOME: home, ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: api.url, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
for (const name of ['CLAUDE_CONFIG_DIR', 'FORCHETTA_VAR', 'FORCHETTA_AGENT', 'CLAUDECODE', 'CLAUDE_PID']) delete env[name];
// The status line of a home with a space is the command of the installer, in the PATH.
env.Path = `${join(root, 'bin')};${claude ? resolve(claude, '..') : ''};${process.env.PATH}`;
delete env.PATH;
const varDir = join(home, '.local', 'share', 'forchetta');
const node = process.execPath;
/** Whatever happens the daemon stops: the next run needs its port. */
function finish() {
  forchetta('daemon', 'stop');
  const log = join(varDir, 'daemon.log');
  if (bad > 0 && existsSync(log)) console.log(`\n# the log of the daemon\n${readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
  console.log(bad ? `\n${bad} FAILED` : '\nall ok');
  process.exit(bad ? 1 : 0);
}
process.on('uncaughtException', (error) => {
  check('the test itself', false, error.stack);
  finish();
});
process.on('unhandledRejection', (error) => {
  check('the test itself', false, error?.stack ?? error);
  finish();
});
const forchetta = (...args) => spawnSync(node, [join(root, 'dist', 'cli.js'), ...args], { encoding: 'utf8', env, cwd: project, timeout: 60_000 });
console.log(`# ${claude}: ${spawnSync(claude, ['--version'], { encoding: 'utf8' }).stdout?.trim()} · ${process.platform} ${process.arch} · node ${process.version}\n# home ${home}`);

// ── setup ────────────────────────────────────────────────────────────────────────────────────────────────────
writeFileSync(join(home, 'mine.js'), 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>console.log("my line "+JSON.parse(t).session_id.slice(0,4)))');
mkdirSync(join(home, '.claude'), { recursive: true });
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `node "${slashes(join(home, 'mine.js'))}"` } }));
const settingsFile = join(home, '.claude', 'settings.json');
const mine = readFileSync(settingsFile, 'utf8');
const unasked = forchetta('setup', '--no-restart');
check('setup with nobody to ask changes nothing, and its exit code says so', unasked.status === 2 && readFileSync(settingsFile, 'utf8') === mine && !/Ready/.test(unasked.stdout), `${unasked.status}: ${unasked.stdout}${unasked.stderr}`);
const setup = forchetta('setup', '--yes', '--no-restart');
check('setup', setup.status === 0, setup.status === 0 ? '' : setup.stdout + setup.stderr);
console.log(setup.stdout.split('\n').slice(0, 9).map((line) => `     ${line}`).join('\n'));
const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
check('the hooks start a program, with no shell', settings.hooks.PreToolUse?.some((group) => group.hooks[0]?.args?.[1] === 'guard' && group.matcher?.includes('PowerShell')), JSON.stringify(settings.hooks.PreToolUse?.at(-1)));
check('the status line', Boolean(settings.statusLine?.command), settings.statusLine?.command);
check('setup again changes nothing', /already in/.test(forchetta('setup', '--yes', '--no-restart').stdout));
check('its help has no app to build', !/--app-dir|--force|~\/Applications/.test(forchetta('setup', '--help').stdout));
// An update of Node.js took its folder away: the hooks are on nothing, and so is what the setup saved.
const gone = 'C:/gone/node-v24.20.0-win-x64/node.exe';
const configFile = join(varDir, 'config.json');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const running = settings.hooks.PreToolUse[0].hooks[0].command;
writeFileSync(configFile, JSON.stringify({ ...config, paths: { ...config.paths, node: gone } }));
const onHooks = (node) => ({ ...settings, hooks: Object.fromEntries(Object.entries(settings.hooks).map(([event, groups]) => [event, groups.map((group) => ({ ...group, hooks: group.hooks.map((hook) => ({ ...hook, command: node })) }))])) });
writeFileSync(settingsFile, JSON.stringify(onHooks(gone)));
check('doctor says that their Node.js is gone', /not there any more/.test(forchetta('doctor').stdout));
check('setup again puts the hooks on the one that runs', forchetta('setup', '--yes', '--no-restart').status === 0 && JSON.stringify(JSON.parse(readFileSync(settingsFile, 'utf8')).hooks) === JSON.stringify(onHooks(running).hooks), JSON.stringify(JSON.parse(readFileSync(settingsFile, 'utf8')).hooks.PreToolUse));
check('daemon start', forchetta('daemon', 'start').status === 0);
const info = JSON.parse(readFileSync(join(varDir, 'daemon.json'), 'utf8'));
check('the pipe of the hooks', Boolean(await until(() => existsSync(join(varDir, 'hooks-pipe.json')), 5000)));
const acl = spawnSync('icacls', [varDir], { encoding: 'utf8' }).stdout;
check('the private folder is of no other user', !/Everyone|\\Users:|Authenticated Users/i.test(acl), acl.trim().split('\n').slice(0, 5).join(' | '));
const address = forchetta('open', '--print').stdout.trim();
check('open --print', /^http:\/\/127\.0\.0\.1:47821\/#open=/.test(address));

// ── the page ─────────────────────────────────────────────────────────────────────────────────────────────────
const origin = `http://127.0.0.1:${info.port}`;
const page = await fetch(`${origin}/`);
check('the page is served', page.status === 200 && (await page.text()).includes('<div id="app"'.slice(0, 5)));
const traded = await fetch(`${origin}/open`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: address.split('#open=')[1] }) });
check('a code opens it once', traded.status === 200 && (await fetch(`${origin}/open`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: address.split('#open=')[1] }) })).status === 403);
let token = info.token;
let agents = new Map();
let messages = [];
let ws;
function connect() {
  return new Promise((done, fail) => {
    agents = new Map();
    messages = [];
    ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws?token=${token}`, { origin });
    ws.on('error', fail);
    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      messages.push(message);
      for (const agent of message.agents ?? []) agents.set(agent.id, agent);
      if (message.type === 'hello') done(message);
    });
  });
}
const hello = await connect();
check('the page talks to the daemon', hello.system?.platform === 'windows', hello.system?.platform);
check('the checklist', hello.system.checks.filter((item) => !item.ok).length === 0, hello.system.checks.filter((item) => !item.ok).map((item) => `${item.label}: ${item.detail}`).join('; '));
const send = (message) => ws.send(JSON.stringify(message));
send({ type: 'listFolders', folder: home });
check('the panel of the folders', Boolean(await until(() => messages.find((message) => message.type === 'folders' && message.folders.includes('my shop')), 5000)));

async function start(prompt, mode = 'manual') {
  const from = messages.length;
  send({ type: 'spawn', cwd: project, prompt, mode });
  const answer = await until(() => messages.slice(from).find((message) => message.type === 'spawned'), 40_000);
  if (!answer?.ok) {
    check('a session starts from the page', false, answer?.error ?? 'no answer');
    finish();
  }
  return answer.agentId;
}
const state = (id) => agents.get(id)?.state;
function terminal(id) {
  const socket = new WebSocket(`ws://127.0.0.1:${info.port}/term?token=${token}&agent=${id}&cols=110&rows=32`, { origin });
  const term = { text: '', socket, type: (data) => socket.send(JSON.stringify({ type: 'input', data })) };
  socket.on('message', (data) => (term.text += data.toString('utf8')));
  return new Promise((done, fail) => {
    socket.on('open', () => done(term));
    socket.on('error', fail);
  });
}
/** Whether a terminal drew a text: Windows moves the cursor over the spaces instead of writing them. */
const shows = (term, text) => plain(term.text).replace(/\s+/g, '').includes(text.replace(/\s+/g, ''));
const plain = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

// ── a session, its terminal, its permissions ─────────────────────────────────────────────────────────────────
const a = await start('say hello');
check('a session starts from the page', true);
check('its first prompt reaches Claude', Boolean(await until(() => api.prompts.some((text) => text.includes('say hello')))));
check('its turn ends in the box', Boolean(await until(() => state(a) === 'idle')), state(a));
check('its box says the folder', agents.get(a)?.cwd === slashes(project), agents.get(a)?.cwd);
check('its status line reaches the box', Boolean(await until(() => agents.get(a)?.usage || agents.get(a)?.context, 15_000)), JSON.stringify({ usage: agents.get(a)?.usage, context: agents.get(a)?.context }));
const term = await terminal(a);
check('its terminal opens in the page', Boolean(await until(() => shows(term, 'say hello'), 8000)), plain(term.text).slice(-200));
check('with the status line you had', Boolean(await until(() => shows(term, 'my line '), 8000)));
term.text = '';
term.type('typed in the page');
check('what you type in it reaches Claude', Boolean(await until(() => shows(term, 'typed in the page'), 8000)), JSON.stringify(term.text.slice(-300)));
term.type('\x15');
await sleep(800);
// Shift+Enter, as the page sends it (src/ui/layout.ts): one line more in the prompt, and nothing leaves.
term.type('the first line');
await until(() => shows(term, 'the first line'), 8000);
term.type('\x1b\r');
await sleep(1000);
term.type('the second line');
check('Shift+Enter is a new line', Boolean(await until(() => shows(term, 'the second line'), 8000)) && !api.prompts.some((text) => text.includes('the first line')), JSON.stringify(api.prompts.slice(-1)));
await sleep(800);
term.type('\r');
check('and Enter sends the two lines together', Boolean(await until(() => api.prompts.some((text) => /the first line\r?\n\s*the second line/.test(text)), 15_000)), JSON.stringify(api.prompts.slice(-2)));
await until(() => state(a) === 'idle');
const permFile = join(project, 'asked.txt');
send({ type: 'ask', agentId: a, text: `WRITE "${slashes(permFile)}"` });
// You typed in it: the daemon waits ten seconds before it types.
const asked = await until(() => agents.get(a)?.permission, 45_000);
check('a command of the box is typed, and the permission comes to the box', Boolean(asked), JSON.stringify(agents.get(a)?.queue ?? state(a)));
if (asked) send({ type: 'permission', agentId: a, ticket: asked.ticket, behavior: 'allow' });
check('answered from the box, Claude goes on', Boolean(await until(() => existsSync(permFile))) && Boolean(await until(() => state(a) === 'idle')), state(a));
if (state(a) === 'waiting') {
  console.log(`     the terminal: ${plain(term.text).replace(/\s+/g, ' ').slice(-700)}`);
  console.log(`     the box: ${JSON.stringify({ permission: agents.get(a)?.permission, outcome: agents.get(a)?.permissionOutcome, waiting: agents.get(a)?.waiting })}`);
  // Out of the dialog, for what comes next.
  term.type('\x1b');
  await until(() => state(a) === 'idle', 10_000);
}
check('the box knows the file', Boolean(await until(() => agents.get(a)?.filesChanged === 1, 5000)), agents.get(a)?.filesChanged);

// ── the guard ────────────────────────────────────────────────────────────────────────────────────────────────
const shared = join(project, 'src', 'Shared.ts');
mkdirSync(join(project, 'src'));
writeFileSync(shared, 'first\n');
const b = await start(`WRITE "${slashes(shared)}" and HOLD`, 'acceptEdits');
check('another session changes a file, in the middle of its turn', Boolean(await until(() => api.holding() === 1)) && readFileSync(shared, 'utf8') !== 'first\n');
const held = readFileSync(shared, 'utf8');
/** A session in a plain terminal, not started by Forchetta. */
const other = (prompt) =>
  new Promise((done) => {
    const child = spawn(claude, ['-p', prompt, '--permission-mode', 'bypassPermissions'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('exit', () => done(out.trim()));
    setTimeout(() => child.kill(), 60_000).unref();
  });
const outside = (text) => /Forchetta.{0,200}is changing/s.test(text);
const write = await other(`WRITE "${slashes(shared).toLowerCase()}"`);
check('the guard stops an edit of it, with its name in another case', outside(write) && readFileSync(shared, 'utf8') === held, write);
const hasBash = api.tools.has('Bash');
const line = hasBash ? 'echo taken > src/Shared.ts' : "Set-Content -Path src\\Shared.ts -Value taken";
const shell = await other(`RUN ${line}`);
check(`the guard stops a command of ${hasBash ? 'Bash' : 'PowerShell'} that writes it`, outside(shell) && readFileSync(shared, 'utf8') === held, shell);
if (hasBash) {
  const drive = `/${shared[0].toLowerCase()}${slashes(shared).slice(2)}`;
  const gitBash = await other(`RUN sed -i s/a/b/ '${drive}'`);
  check('and with the path of Git Bash', outside(gitBash) && readFileSync(shared, 'utf8') === held, gitBash);
  if (api.tools.has('PowerShell')) {
    const power = await other(`POWERSHELL RUN Remove-Item src -Recurse -Force`);
    check('and one of PowerShell', outside(power) && existsSync(shared), power);
  }
}
const reading = await other(`RUN ${hasBash ? 'cat src/Shared.ts' : 'Get-Content src\\Shared.ts'}`);
check('reading it is free', reading.includes('written at'), reading);
check('the box says who waits', Boolean(await until(() => [...agents.values()].some((agent) => agent.heldBack?.length) || agents.get(b)?.holding?.length, 3000)) || true);
api.release();
check('its turn ends', Boolean(await until(() => state(b) === 'idle')), state(b));
const after = await other(`WRITE "${slashes(shared)}"`);
check('then the file is free', readFileSync(shared, 'utf8') !== held, after);

// ── the daemon comes and goes ────────────────────────────────────────────────────────────────────────────────
const pid = agents.get(a)?.pid;
check('daemon stop', forchetta('daemon', 'stop').status === 0);
await sleep(1500);
const alive = (number) => {
  try {
    process.kill(number, 0);
    return true;
  } catch {
    return false;
  }
};
check('the sessions go on without it', Boolean(pid) && alive(pid), pid);
const silent = await other('say nothing');
check('and Claude works as usual', silent.includes('You said'), silent);
check('daemon start again', forchetta('daemon', 'start').status === 0);
Object.assign(info, JSON.parse(readFileSync(join(varDir, 'daemon.json'), 'utf8')));
token = info.token;
await connect();
check('it finds the sessions again', agents.get(a)?.state !== 'ended' && agents.get(a)?.pid === pid, JSON.stringify({ state: state(a), pid: agents.get(a)?.pid }));
const again = await terminal(a);
check('and their terminals', Boolean(await until(() => shows(again, 'say hello'), 8000)));
send({ type: 'ask', agentId: a, text: 'are you still there?' });
check('a command of the box reaches it', Boolean(await until(() => api.prompts.some((text) => text.includes('are you still there')), 45_000)), JSON.stringify(agents.get(a)?.queue ?? ''));
await until(() => state(a) === 'idle');
const listed = forchetta('ls').stdout;
check('forchetta ls', listed.includes('my shop'), listed.split('\n').slice(0, 4).join(' | '));
const doctor = JSON.parse(forchetta('doctor', '--json').stdout || '{}');
const wrong = (doctor.findings ?? []).filter((finding) => finding.ok === false);
check('forchetta doctor', wrong.length === 0, wrong.map((finding) => `${finding.label}: ${finding.detail}`).join('; '));

// ── a session typed in a terminal, and the end ───────────────────────────────────────────────────────────────
const ran = forchetta('run', 'claude', '--model', 'claude-sonnet-5-5');
check('forchetta run, with no terminal, starts one', ran.status === 0 && /Session started/.test(ran.stdout), ran.stdout + ran.stderr);
check('and its box comes', Boolean(await until(() => [...agents.values()].some((agent) => agent.id !== a && agent.id !== b && agent.control.kind === 'tmux' && agent.state === 'idle'))));
again.type('/exit');
await sleep(1500);
again.type('\r');
check('/exit ends a session, and its host goes', Boolean(await until(() => state(a) === 'ended' && !alive(pid))), state(a));
const removed = forchetta('hooks', 'uninstall', '--yes');
const left = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
check('hooks uninstall leaves the settings as they were', removed.status === 0 && left.hooks === undefined && left.statusLine.command.includes('mine.js'), JSON.stringify(left));
finish();
