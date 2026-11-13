#!/usr/bin/env node
// Records the scene of the guard in the simulation, for the README and the site. Two sessions in ~/shop: "retries"
// changes src/api.ts and runs its tests; "rate-limit" tries to edit the same file, is stopped, and waits; when
// "retries" ends its turn, the notice that the file is free is typed into "rate-limit", which goes on.
//
// The sessions are scripts/dev/fake-agent.mjs, in the tmux of the test daemon of scripts/dev/sim.sh (var/sim, port
// 47822): the daemon, the guard, the queue and the page are the real ones. HOME is var/sim/home, so the terminals
// show ~/shop and no personal path. The page runs in Chrome headless, driven through the DevTools protocol.
//
//   rm -f var/sim/state.json && sh scripts/dev/sim.sh                  # no box of an earlier run
//   node scripts/dev/record-guard.mjs --still docs/img/guard.png       # the moment one session waits
//   node scripts/dev/record-guard.mjs --video docs/img/guard           # guard.mp4, guard.gif, guard-poster.jpg
//   FORCHETTA_VAR="$PWD/var/sim" node dist/cli.js daemon stop          # when done
//
// Needs ffmpeg for the video.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VAR = join(ROOT, 'var', 'sim');
const HOME = join(VAR, 'home');
const SHOP = join(HOME, 'shop');
const TMUX = existsSync('/opt/homebrew/bin/tmux') ? '/opt/homebrew/bin/tmux' : '/usr/local/bin/tmux';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = 9333;

const args = process.argv.slice(2);
const mode = args.includes('--video') ? 'video' : 'still';
const given = args[args.indexOf(`--${mode}`) + 1];
if (!given || given.startsWith('--')) {
  console.error('usage: record-guard.mjs --still <file.png> | --video <path without extension>');
  process.exit(2);
}
const out = resolve(given);
// The still is sharp (×2); the video is lighter (×1.5), like the demo of the teams.
const VIEW = mode === 'still' ? { width: 1400, height: 786, scale: 2 } : { width: 1280, height: 760, scale: 1.5 };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);

// ---- The daemon of the simulation -----------------------------------------------------------------------------

const daemon = JSON.parse(readFileSync(join(VAR, 'daemon.json'), 'utf8'));
async function agents() {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/api/agents`, { headers: { authorization: `Bearer ${daemon.token}` } });
  return (await response.json()).agents;
}
async function until(what, test, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const found = test(await agents());
    if (found) return found;
    if (Date.now() > end) throw new Error(`waited too long for: ${what}`);
    await wait(250);
  }
}

// ---- The folder, and the two sessions ---------------------------------------------------------------------------

mkdirSync(join(SHOP, 'src'), { recursive: true });
writeFileSync(join(SHOP, 'src', 'api.ts'), 'export async function call(path: string) {\n  return fetch(path);\n}\n');
// A repository of its own: the boxes show src/api.ts, not a path from the root of Forchetta.
if (!existsSync(join(SHOP, '.git'))) execFileSync('git', ['init', '-q', SHOP]);

const outer = join(VAR, 'outer.sock');
const env = { HOME, USER: process.env.USER ?? 'dev', PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', FORCHETTA_VAR: VAR };
const before = new Set((await agents()).map((agent) => agent.id));
/** A session of `forchetta run claude`, attached in a tmux of its own: the claude is the fake one of sim.sh. */
async function start(name) {
  execFileSync(TMUX, ['-S', outer, 'new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', SHOP, `${join(ROOT, 'bin', 'forchetta')} run claude --name ${name}`], { env });
  return until(`the session ${name}`, (list) => list.find((agent) => !before.has(agent.id) && agent.cwd === SHOP && agent.state !== 'ended' && agent.control?.kind === 'tmux' && ![...started.values()].includes(agent.id)));
}
const started = new Map();
started.set('retries', (await start('retries')).id);
started.set('rate-limit', (await start('rate-limit')).id);
// The terminal that started them goes: closing it only detaches them, and its size no longer limits theirs.
execFileSync(TMUX, ['-S', outer, 'kill-server']);
const sessionOf = async (name) => (await agents()).find((agent) => agent.id === started.get(name))?.control.session;
log(`sessions: ${[...started].map(([name, id]) => `${name} ${id.slice(0, 8)}`).join(', ')}`);

/** Types into a session, as you would: the text, a pause, Enter. */
async function type(name, text) {
  const session = await sessionOf(name);
  execFileSync(TMUX, ['-S', join(VAR, 'tmux.sock'), 'send-keys', '-t', session, '-l', text]);
  await wait(400);
  execFileSync(TMUX, ['-S', join(VAR, 'tmux.sock'), 'send-keys', '-t', session, 'Enter']);
}

// ---- Chrome ---------------------------------------------------------------------------------------------------

const profile = mkdtempSync(join(VAR, 'chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 40 && !target; i++) {
  await wait(250);
  try {
    target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((item) => item.type === 'page');
  } catch {
    // Not up yet.
  }
}
if (!target) throw new Error('Chrome did not start');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let nextId = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
function cdp(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result))));
}
const page = async (expression) => (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;

await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: VIEW.scale, mobile: false });
// What the app hands the page before its scripts run.
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__FORCHETTA__ = { token: '${daemon.token}', port: ${daemon.port}, reducedMotion: false };` });
await cdp('Page.navigate', { url: `http://127.0.0.1:${daemon.port}/` });
for (let i = 0; i < 40 && !(await page('!!window.forchettaDebug?.store?.state?.connected')); i++) await wait(250);
// A headless tab counts as hidden: the page would stop its animations and the daemon its readings.
await page('window.forchettaVisibility?.(true)');
// The WebGL renderer of the terminals draws at the wrong scale in Chrome headless: the DOM one draws right.
await page('window.forchettaDebug.domRenderer = true');
const store = 'window.forchettaDebug.store';
for (const [name, id] of started) await page(`${store}.setTeam('${id}', { label: '${name}', group: '', role: '', lead: false })`);
await wait(800);
await page(`${store}.open('${started.get('retries')}')`);
await page(`${store}.open('${started.get('rate-limit')}')`);
await wait(2500);

// ---- The frames -----------------------------------------------------------------------------------------------

const frames = [];
let recording = mode === 'video';
// Chrome headless gives no screencast frames: screenshots, three at a time, about 10 per second.
const grabbers = recording
  ? [0, 1, 2].map(async (offset) => {
      await wait(offset * 33);
      while (recording) {
        const at = Date.now();
        const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
        frames.push({ at, data });
      }
    })
  : [];

// ---- The scene ------------------------------------------------------------------------------------------------

await wait(1500);
log('retries: the request');
await type('retries', 'Add retries to the calls in src/api.ts: 3 tries, with a growing pause.');
await until('retries running its tests', (list) => list.find((agent) => agent.id === started.get('retries') && /npm test/.test(agent.action?.label ?? '')));
await wait(800);
log('rate-limit: the request on the same file');
await type('rate-limit', 'Add a rate limit to src/api.ts: 100 requests a minute for each client.');
await until('rate-limit held back', (list) => list.find((agent) => agent.id === started.get('rate-limit') && agent.heldBack && agent.state === 'idle'));
log('rate-limit waits');
const heldAt = Date.now();
if (mode === 'still') {
  await wait(1500);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(data, 'base64'));
  log(`still: ${out}`);
}
await until('retries done', (list) => list.find((agent) => agent.id === started.get('retries') && agent.state === 'idle' && /Retries are in/.test(agent.lastReply ?? '')), 90_000);
log('retries done: the file is free');
await until('rate-limit done', (list) => list.find((agent) => agent.id === started.get('rate-limit') && agent.state === 'idle' && /^Done:/.test(agent.lastReply ?? '')), 90_000);
log('rate-limit done');
await wait(3000);
recording = false;
await Promise.all(grabbers);

// ---- The end --------------------------------------------------------------------------------------------------

for (const name of started.keys()) await type(name, '/exit');
await wait(1500);
socket.close();
chrome.kill();
await wait(500);
rmSync(profile, { recursive: true, force: true });

if (mode === 'video') {
  frames.sort((a, b) => a.at - b.at);
  const dir = mkdtempSync(join(VAR, 'frames-'));
  const list = [];
  frames.forEach((frame, index) => {
    const name = `f${String(index).padStart(5, '0')}.jpg`;
    writeFileSync(join(dir, name), Buffer.from(frame.data, 'base64'));
    const next = frames[index + 1];
    list.push(`file '${name}'`, `duration ${((next ? next.at - frame.at : 100) / 1000).toFixed(3)}`);
  });
  // The concat demuxer takes the duration of the last file only if it is named once more.
  list.push(`file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'`);
  writeFileSync(join(dir, 'list.txt'), `${list.join('\n')}\n`);
  log(`${frames.length} frames in ${((frames.at(-1).at - frames[0].at) / 1000).toFixed(1)} s`);
  const ffmpeg = (...rest) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...rest], { cwd: dir, stdio: 'inherit' });
  ffmpeg('-f', 'concat', '-safe', '0', '-i', 'list.txt', '-vf', 'fps=12,scale=1600:-2:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', `${out}.mp4`);
  ffmpeg('-i', `${out}.mp4`, '-vf', 'fps=10,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', `${out}.gif`);
  // The poster of the video on the site: the moment the second session waits.
  ffmpeg('-ss', ((heldAt + 1500 - frames[0].at) / 1000).toFixed(2), '-i', `${out}.mp4`, '-frames:v', '1', '-q:v', '3', `${out}-poster.jpg`);
  rmSync(dir, { recursive: true, force: true });
  log(`video: ${out}.mp4, ${out}.gif, ${out}-poster.jpg`);
}
process.exit(0);
