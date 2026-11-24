import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const pipeName = (id) => (process.platform === 'win32' ? `\\\\.\\pipe\\forchetta-${id}` : join('/tmp', `fk-${id}.sock`));

/** Starts a session: a detached host with the program inside. */
export async function start(dir, spec) {
  mkdirSync(dir, { recursive: true });
  const id = randomUUID().slice(0, 8);
  const full = { session: `fk-${id}`, token: randomBytes(16).toString('hex'), pipe: pipeName(`${id}-${randomBytes(6).toString('hex')}`), ready: join(dir, `${id}.ready`), cols: 120, rows: 36, args: [], ...spec };
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify(full), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('host.mjs', import.meta.url)), file], { detached: true, stdio: spec.debug ? 'inherit' : 'ignore', windowsHide: true, cwd: dir });
  child.unref();
  for (let i = 0; i < 150 && !existsSync(full.ready); i++) await sleep(100);
  if (!existsSync(full.ready)) throw new Error('the host did not start');
  await sleep(50);
  return { ...full, ...JSON.parse(readFileSync(full.ready, 'utf8')) };
}

export class Session {
  constructor(spec) { this.spec = spec; this.waiting = new Map(); this.next = 1; this.seen = ''; this.ended = undefined; }
  async open() {
    this.socket = createConnection(this.spec.pipe);
    await new Promise((resolve, reject) => { this.socket.once('connect', resolve); this.socket.once('error', reject); });
    this.socket.on('error', () => {});
    let pending = '';
    this.socket.on('data', (chunk) => {
      pending += chunk;
      for (let end; (end = pending.indexOf('\n')) >= 0; ) {
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (message.type === 'data') this.seen += message.data;
        else if (message.type === 'exit') this.ended = message.exitCode;
        else { this.waiting.get(message.id)?.(message); this.waiting.delete(message.id); }
      }
    });
    this.socket.write(`${JSON.stringify({ token: this.spec.token })}\n`);
    return this;
  }
  ask(op, more = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${op}: no answer`)), 8000);
      this.waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.socket.write(`${JSON.stringify({ id, op, ...more })}\n`);
    });
  }
  attach() { this.socket.write(`${JSON.stringify({ op: 'attach' })}\n`); }
  close() { this.socket.destroy(); }
}
