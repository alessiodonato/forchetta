import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session, sleep, start } from './client.mjs';
const dir = mkdtempSync(join(tmpdir(), 'fkspike-'));
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
if (process.argv[2] === 'launch') {
  // A launcher that starts the session and dies at once, like a daemon that is restarted.
  const spec = await start(process.argv[3], { file: process.execPath, args: [here('tui.mjs')], cwd: process.argv[3], env: process.env, useConptyDll: process.argv[5] === 'dll' });
  writeFileSync(process.argv[4], JSON.stringify(spec));
  process.exit(0);
}
let bad = 0;
const check = (name, ok, detail = '') => { if (!ok) bad++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (const mode of process.platform === 'win32' ? ['system', 'dll'] : ['system']) {
  console.log(`\n# pseudo-terminal: ${mode} (${process.platform} ${process.arch}, node ${process.version})`);
  const out = join(dir, `spec-${mode}.json`);
  const launched = spawnSync(process.execPath, [here('holder-test.mjs'), 'launch', dir, out, mode], { encoding: 'utf8', timeout: 30000 });
  if (launched.status !== 0) { check('the launcher starts the session and ends', false, launched.stderr.slice(0, 600)); continue; }
  check('the launcher starts the session and ends', true);
  const spec = JSON.parse(readFileSync(out, 'utf8'));
  await sleep(1500);
  check('the session outlives who started it', alive(spec.hostPid) && alive(spec.pid), `host ${spec.hostPid}, program ${spec.pid}`);
  const wrong = new Session({ ...spec, token: 'x' });
  await wrong.open(); await sleep(400);
  check('without the token it answers nothing', wrong.socket.destroyed);
  const a = await new Session(spec).open();
  let screen = (await a.ask('capture')).text;
  check('reads the screen (capture-pane)', /TUI/.test(screen) && /120x36/.test(screen), JSON.stringify(screen.split('\n').slice(0, 2)));
  check('wide and accented characters', screen.includes('è € 漢 ✻'));
  check('keeps the styles of the text (bold, dim)', /\x1b\[1m/.test(screen) && /\x1b\[2m/.test(screen));
  const id = await a.ask('identity');
  check('identity of the pane', id.session === spec.session && id.pid === spec.pid);
  check('knows that the program wants bracketed paste', id.bracketedPaste === true);
  await a.ask('input', { data: 'ciao è' }); await sleep(600);
  screen = (await a.ask('capture')).text;
  check('types text (send-keys)', screen.includes('ciao è'));
  await a.ask('input', { data: '\r' }); await sleep(500);
  check('types Enter', (await a.ask('capture')).text.includes('got "\\r"'));
  await a.ask('input', { data: '\x15' }); await sleep(500);
  check('types Ctrl+U', /got "\\u0015"/.test((await a.ask('capture')).text));
  await a.ask('input', { data: '\x1b' }); await sleep(700);
  check('types Esc', /got "\\u001b"/.test((await a.ask('capture')).text));
  await a.ask('paste', { text: 'uno\ndue' }); await sleep(900);
  screen = (await a.ask('capture')).text;
  check('pastes as one block (paste-buffer -p)', screen.includes('[200~uno\\rdue\\u001b[201~'), JSON.stringify(screen.split('\n').slice(-40).filter((l) => l.includes('got')).slice(-2)));
  await a.ask('resize', { cols: 90, rows: 20 }); await sleep(1200);
  check('resizes', (await a.ask('capture')).text.includes('90x20'));
  const b = await new Session(spec).open(); b.attach(); await sleep(700);
  check('a window that attaches gets the screen', b.seen.includes('TUI'));
  b.seen = ''; await a.ask('input', { data: 'live' }); await sleep(700);
  check('and what comes after, live', b.seen.includes('live'));
  b.close(); await sleep(500);
  check('a window that closes leaves the session alone', alive(spec.pid) && (await a.ask('identity')).ok);
  const c = await new Session(spec).open(); c.attach(); await sleep(400);
  await a.ask('input', { data: '\x03' }); await sleep(2500);
  check('the program ends: exit code to the window', c.ended === 7, String(c.ended));
  check('and its host goes away', !alive(spec.hostPid));
}
console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
