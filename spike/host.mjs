// One of these per session: it owns the pseudo-terminal of claude, keeps its screen, and answers on a private pipe.
// Started detached: it lives on when whoever started it goes away, as a tmux session does.
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
rmSync(process.argv[2], { force: true });
const screen = new Terminal({ cols: spec.cols, rows: spec.rows, scrollback: 5000, allowProposedApi: true });
const serialize = new SerializeAddon();
screen.loadAddon(serialize);
const child = pty.spawn(spec.file, spec.args, {
  name: 'xterm-256color', cols: spec.cols, rows: spec.rows, cwd: spec.cwd, env: spec.env,
  ...(process.platform === 'win32' ? { useConptyDll: spec.useConptyDll === true } : {}),
});
const viewers = new Set();
let lastInput = 0;
child.onData((data) => {
  screen.write(data);
  for (const viewer of viewers) viewer.write(`${JSON.stringify({ type: 'data', data })}\n`);
});
screen.onData((data) => child.write(data)); // answers of the terminal to its queries (DA, cursor position)
child.onExit(({ exitCode }) => {
  for (const viewer of viewers) viewer.end(`${JSON.stringify({ type: 'exit', exitCode })}\n`);
  server.close();
  setTimeout(() => process.exit(0), 200);
});

/** A line of the screen with its styles, as `tmux capture-pane -e` prints it. */
function line(row) {
  const cells = screen.buffer.active.getLine(row);
  if (!cells) return '';
  let out = '';
  let style = '';
  let text = '';
  for (let x = 0; x < screen.cols; x++) {
    const cell = cells.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const codes = [];
    if (cell.isBold()) codes.push(1);
    if (cell.isDim()) codes.push(2);
    if (cell.isItalic()) codes.push(3);
    if (cell.isUnderline()) codes.push(4);
    if (cell.isInverse()) codes.push(7);
    if (cell.isFgRGB()) { const c = cell.getFgColor(); codes.push(38, 2, c >> 16, (c >> 8) & 255, c & 255); }
    else if (cell.isFgPalette()) codes.push(38, 5, cell.getFgColor());
    if (cell.isBgRGB()) { const c = cell.getBgColor(); codes.push(48, 2, c >> 16, (c >> 8) & 255, c & 255); }
    else if (cell.isBgPalette()) codes.push(48, 5, cell.getBgColor());
    const wanted = codes.join(';');
    if (wanted !== style) {
      out += text + (style ? '\x1b[0m' : '') + (wanted ? `\x1b[${wanted}m` : '');
      text = '';
      style = wanted;
    }
    text += cell.getChars() || ' ';
  }
  return (out + text + (style ? '\x1b[0m' : '')).replace(/ +$/, '');
}
function capture(history) {
  const buffer = screen.buffer.active;
  const lines = [];
  for (let row = Math.max(0, buffer.baseY - history); row < buffer.baseY + screen.rows; row++) lines.push(line(row));
  return lines.join('\n');
}

const ops = {
  identity: () => ({ session: spec.session, pid: child.pid, hostPid: process.pid, cols: screen.cols, rows: screen.rows, lastInput, bracketedPaste: screen.modes.bracketedPasteMode }),
  capture: ({ history = 0 }) => ({ text: capture(history) }),
  input: ({ data }) => { child.write(data); return {}; },
  paste: ({ text }) => {
    const body = text.replace(/\r?\n/g, '\r');
    child.write(screen.modes.bracketedPasteMode ? `\x1b[200~${body}\x1b[201~` : body);
    return { bracketed: screen.modes.bracketedPasteMode };
  },
  resize: ({ cols, rows }) => { child.resize(cols, rows); screen.resize(cols, rows); return {}; },
};

const server = createServer((socket) => {
  let pending = '';
  let known = false;
  socket.on('error', () => viewers.delete(socket));
  socket.on('close', () => viewers.delete(socket));
  socket.on('data', (chunk) => {
    pending += chunk;
    for (let end; (end = pending.indexOf('\n')) >= 0; ) {
      const raw = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let message;
      try { message = JSON.parse(raw); } catch { socket.destroy(); return; }
      if (!known) {
        if (message.token !== spec.token) { socket.destroy(); return; }
        known = true;
        continue;
      }
      if (message.op === 'attach') {
        screen.write('', () => {
          socket.write(`${JSON.stringify({ type: 'data', data: serialize.serialize({ scrollback: 1000 }) })}\n`);
          viewers.add(socket);
        });
        continue;
      }
      if (message.typed) lastInput = Date.now();
      const op = ops[message.op];
      // What was written to the screen before this is drawn first.
      screen.write('', () => {
        let answer;
        try { answer = op ? { ok: true, ...op(message) } : { ok: false, error: 'unknown' }; } catch (error) { answer = { ok: false, error: String(error) }; }
        socket.write(`${JSON.stringify({ id: message.id, ...answer })}\n`);
      });
    }
  });
});
server.listen(spec.pipe, () => writeFileSync(spec.ready, JSON.stringify({ hostPid: process.pid, pid: child.pid })));
