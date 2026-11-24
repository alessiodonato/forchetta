import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttp } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeName, Session, sleep, start } from './client.mjs';
import { fakeApi, requests, tools } from './fake-api.mjs';
import { readPromptBox } from './screen.mjs';

const win = process.platform === 'win32';
const claude = process.env.CLAUDE_BIN ?? (win ? spawnSync('where.exe', ['claude.exe'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0] : '/usr/bin/false');
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'fkclaude-')));
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const home = join(dir, 'home'); const config = join(dir, 'config'); const project = join(dir, 'project');
for (const d of [home, config, project]) mkdirSync(d);
const target = join(project, 'written.txt');
let bad = 0;
const check = (name, ok, detail = '') => { if (!ok) bad++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); return ok; };
const note = (text) => console.log(`     ${text}`);
console.log(`# ${claude}: ${spawnSync(claude, ['--version'], { encoding: 'utf8' }).stdout?.trim()} on ${process.platform} ${process.arch}, node ${process.version}`);

// The two ways for a hook to reach Forchetta: a program on a private pipe, and a POST made by Claude Code itself.
const got = [];
let deny = false;
const answerTo = (event, input) => {
  if (event === 'PreToolUse' && deny) return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'another session is changing this file' } });
  if (event === 'PermissionRequest') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  return '';
};
const pipe = pipeName(`hooks-${randomBytes(6).toString('hex')}`);
const hooks = createServer((socket) => {
  let text = '';
  socket.on('error', () => {});
  socket.on('data', (c) => {
    text += c;
    if (!text.endsWith('\n')) return;
    const message = JSON.parse(text);
    got.push({ ...message, event: message.input.hook_event_name, took: Date.now() - message.at });
    socket.end(answerTo(message.input.hook_event_name, message.input));
  });
});
await new Promise((r) => hooks.listen(pipe, r));
const http = createHttp((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const input = JSON.parse(body);
    got.push({ via: 'http', event: input.hook_event_name, agent: req.headers['x-forchetta-agent'], token: req.headers['x-forchetta-token'], claudePid: req.headers['x-forchetta-claude-pid'], remotePort: req.socket.remotePort, input });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(answerTo(input.hook_event_name, input) || '{}');
  });
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${http.address().port}/forchetta/hook`;
const program = { type: 'command', command: process.execPath, args: [here('hook.mjs'), pipe], timeout: 10 };
const post = { type: 'http', url, headers: { 'X-Forchetta-Token': 'secret', 'X-Forchetta-Agent': '$FORCHETTA_AGENT', 'X-Forchetta-Claude-Pid': '$CLAUDE_PID' }, allowedEnvVars: ['FORCHETTA_AGENT', 'CLAUDE_PID'], timeout: 10 };
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];
const settingsFor = (hook) => ({ hooks: Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [hook] }]])) });
const settings = { program: join(dir, 'program.json'), http: join(dir, 'http.json') };
writeFileSync(settings.program, JSON.stringify(settingsFor(program)));
writeFileSync(settings.http, JSON.stringify(settingsFor(post)));

const api = await fakeApi(target);
const key = 'sk-ant-api03-fake-key-for-a-test-0000000000000000000000';
const projectKey = win ? project.replaceAll('\\', '/') : project;
writeFileSync(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', theme: 'dark', customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects: Object.fromEntries([project, projectKey].map((p) => [p, { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }])) }));
const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'LOCALAPPDATA', 'APPDATA', 'USERNAME', 'USER', 'SHELL'];
const env = { ...Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]])), HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: api.url, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', FORCHETTA_AGENT: 'agent-1', TERM: 'xterm-256color', ...(process.env.NO_GIT_BASH ? { } : {}) };

const print = (name, prompt, extra = []) => {
  const before = got.length; rmSync(target, { force: true });
  return new Promise(async (resolve) => {
    const { spawn } = await import('node:child_process');
    const t = Date.now();
    const child = spawn(claude, ['-p', prompt, '--settings', settings[name], '--model', 'claude-sonnet-5-5', ...extra], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => child.kill(), 90000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), events: got.slice(before), pid: child.pid, ms: Date.now() - t }); });
  });
};
for (const name of ['program', 'http']) {
  console.log(`\n# hooks: ${name}`);
  deny = false;
  let run = await print(name, 'please WRITE', ['--permission-mode', 'acceptEdits']);
  if (!check('claude -p ends well', run.code === 0, `${run.ms} ms, ${run.out.slice(0, 200)}`)) note(`requests: ${[...new Set(requests)].join(', ')}`);
  note(`events: ${run.events.map((e) => e.event).join(' ')}`);
  check('the file is written', existsSync(target));
  const pre = run.events.find((e) => e.event === 'PreToolUse');
  check('PreToolUse arrives, with the file', pre?.input.tool_name === 'Write', JSON.stringify(pre?.input.tool_input?.file_path));
  // A POST of Claude Code itself says no pid: it is the owner of the connection, or the one of `claude agents --json`.
  if (name === 'program') check('the pid of claude is known', Number(pre?.claudePid) === run.pid || pre?.parent === run.pid, `CLAUDE_PID ${pre?.claudePid || '-'}, parent ${pre?.parent ?? '-'}, claude ${run.pid}`);
  check('the session of Forchetta is known', pre?.agent === 'agent-1');
  for (const event of [...(name === 'program' ? ['SessionStart'] : []), 'PostToolUse', 'Stop', 'SessionEnd']) check(`${event} arrives`, run.events.some((e) => e.event === event));
  deny = true;
  run = await print(name, 'please WRITE', ['--permission-mode', 'acceptEdits']);
  check('the guard stops a write: the file is not there', !existsSync(target) && run.code === 0, run.out.slice(0, 160));
  deny = false;
  run = await print(name, 'SHELL please', ['--permission-mode', 'bypassPermissions']);
  const sh = run.events.find((e) => e.event === 'PreToolUse');
  check('a shell command passes by the guard', Boolean(sh?.input.tool_input?.command), `tool ${sh?.input.tool_name}: ${run.out.slice(0, 140)}`);
  if (win) {
    run = await print(name, 'SHELL POWERSHELL please', ['--permission-mode', 'bypassPermissions']);
    const ps = run.events.find((e) => e.event === 'PreToolUse');
    check('also one of PowerShell', ps?.input.tool_name === 'PowerShell', `tool ${ps?.input.tool_name}: ${run.out.slice(0, 140)}`);
  }
}
note(`tools offered: ${[...tools].join(' ')}`);
console.log('\n# how long a hook takes (start of the program, pipe, answer)');
const times = [];
for (let i = 0; i < 8; i++) { const t = performance.now(); spawnSync(process.execPath, [here('hook.mjs'), pipeName('nobody')], { input: '{}' }); times.push(Math.round(performance.now() - t)); }
note(`node as a hook: ${times.join(' ')} ms`);

console.log('\n# interactive: claude in the session host');
for (const mode of win ? ['system', 'dll'] : ['system']) {
  console.log(`\n## pseudo-terminal: ${mode}`);
  const before = got.length; rmSync(target, { force: true });
  const spec = await start(dir, { file: claude, args: ['--settings', settings.program, '--model', 'claude-sonnet-5-5', '--permission-mode', 'default'], cwd: project, env, useConptyDll: mode === 'dll' });
  const session = await new Session(spec).open(); session.attach();
  let box = { found: false }; let screen = '';
  for (let i = 0; i < 60 && !box.found; i++) { await sleep(500); screen = (await session.ask('capture', { history: 60 })).text; box = readPromptBox(screen); }
  const plain = () => screen.replace(/\x1b\[[0-9;]*m/g, '');
  if (!check('the input box is read by the code of Forchetta, unchanged', box.found && !box.typed, JSON.stringify(box))) console.log(plain());
  const id = await session.ask('identity');
  note(`program pid ${id.pid}, bracketed paste ${id.bracketedPaste}`);
  const first = got.slice(before).find((e) => e.event === 'SessionStart');
  check('SessionStart of that pid', first && (first.claudePid === id.pid || first.parent === id.pid), `CLAUDE_PID ${first?.claudePid}, parent ${first?.parent}, pane ${id.pid}`);
  await session.ask('input', { data: 'ciao è' }); await sleep(1200);
  screen = (await session.ask('capture', { history: 60 })).text; box = readPromptBox(screen);
  check('a command typed from the box shows in the prompt', box.typed === 'ciao è', JSON.stringify(box));
  await session.ask('input', { data: '\x15' }); await sleep(900);
  box = readPromptBox((await session.ask('capture', { history: 60 })).text);
  check('Ctrl+U empties it', box.found && !box.typed, JSON.stringify(box));
  await session.ask('input', { data: 'please WRITE' });
  await session.ask('paste', { text: '\nsecond line\nthird line' }); await sleep(1500);
  screen = (await session.ask('capture', { history: 60 })).text; box = readPromptBox(screen);
  check('a request of several lines is pasted, not sent', /please WRITE/.test(box.typed ?? '') && /third line|Pasted/.test(box.typed ?? ''), JSON.stringify(box));
  const asked = got.length;
  await session.ask('input', { data: '\r' });
  let done = false;
  for (let i = 0; i < 60 && !done; i++) { await sleep(500); done = got.slice(asked).some((e) => e.event === 'Stop'); }
  note(`events: ${got.slice(asked).map((e) => e.event).join(' ')}`);
  check('Enter sends it: UserPromptSubmit', got.slice(asked).some((e) => e.event === 'UserPromptSubmit'));
  check('the permission is answered from Forchetta', got.slice(asked).some((e) => e.event === 'PermissionRequest') && existsSync(target));
  check('the turn ends: Stop', done);
  screen = (await session.ask('capture', { history: 60 })).text;
  console.log(plain().split('\n').filter((l) => l.trim()).slice(-16).map((l) => `     | ${l}`).join('\n'));
  await session.ask('input', { data: '/exit' }); await sleep(1200); await session.ask('input', { data: '\r' });
  for (let i = 0; i < 30 && session.ended === undefined; i++) await sleep(500);
  check('/exit ends it, and SessionEnd arrives', session.ended !== undefined && got.slice(asked).some((e) => e.event === 'SessionEnd'), `code ${session.ended}`);
}
console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
