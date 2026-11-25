import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { consoleBuild, loadPty, openPty, type Pty } from '../daemon/pty.ts';
import { acceptPipe } from '../shared/pipe.ts';
import { clampSize, FOCUS_REPORT, type HostMessage, type HostRecord, type HostRequest, type HostSpec, TERMINAL_REPLY } from './protocol.ts';
import { Screen } from './screen.ts';
import { Viewers } from './viewers.ts';

// The host of one session, on Windows, where there is no tmux: a process of its own, started apart from everything, that
// holds the pseudo-terminal claude runs in. The windows and the daemon come and go on its pipe; the session goes on until
// claude ends, and the host goes with it. Like tmux, nothing here ends a session.

/** A window so far behind is let go: it opens again by itself. */
const MAX_BEHIND = 16 * 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024;

const open = (spec: HostSpec): Pty => openPty(loadPty(), spec.file, spec.args, { name: 'xterm-256color', cols: spec.cols, rows: spec.rows, cwd: spec.cwd, env: spec.env });

function main(): void {
  const specFile = process.argv[2];
  if (!specFile) process.exit(2);
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as HostSpec;
  rmSync(specFile, { force: true });
  const fail = (error: unknown): never => {
    try {
      writeFileSync(`${spec.record}.error`, error instanceof Error ? error.message : String(error), { mode: 0o600 });
    } catch {
      // Whoever started it sees that no record comes.
    }
    process.exit(1);
  };
  let child: Pty;
  try {
    child = open(spec);
  } catch (error) {
    return fail(error);
  }
  const screen = new Screen(spec, consoleBuild());
  let typedAt = 0;
  const send = (socket: Socket, message: HostMessage): void => {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(message)}\n`);
    if (socket.writableLength > MAX_BEHIND) socket.destroy();
  };

  const viewers = new Viewers<Socket>(screen, (socket, data) => send(socket, { type: 'data', data }));

  child.onData((chunk) => {
    const data = String(chunk);
    screen.write(data);
    viewers.drawn(data);
  });
  screen.onReply((data) => child.write(data));
  child.onExit(({ exitCode }) => {
    rmSync(spec.record, { force: true });
    for (const viewer of viewers) viewer.end(`${JSON.stringify({ type: 'exit', code: exitCode } satisfies HostMessage)}\n`);
    server.close();
    // A moment for the windows to hear it.
    setTimeout(() => process.exit(0), 300);
  });

  const resize = (size: { cols: number; rows: number }): void => {
    if (size.cols === screen.size.cols && size.rows === screen.size.rows) return;
    child.resize(size.cols, size.rows);
    screen.resize(size);
  };

  const handle = (socket: Socket, request: HostRequest): void => {
    switch (request.op) {
      case 'attach':
        resize(clampSize(request.cols, request.rows));
        viewers.add(socket);
        return;
      case 'resize':
        resize(clampSize(request.cols, request.rows));
        return;
      case 'input':
        if (typeof request.data !== 'string' || TERMINAL_REPLY.test(request.data)) return;
        if (!FOCUS_REPORT.test(request.data)) typedAt = Date.now();
        child.write(request.data);
        return;
      default:
        break;
    }
    // What was drawn until now is on the screen before the answer.
    screen.settled(() => {
      const { id } = request;
      switch (request.op) {
        case 'identity':
          return send(socket, { id, ok: true, identity: { session: spec.session, pid: child.pid, activity: Math.floor(typedAt / 1000) } });
        case 'capture':
          return send(socket, { id, ok: true, text: screen.capture(Math.max(0, Math.min(1000, Number(request.history) || 0))) });
        case 'keys':
          child.write(String(request.data));
          return send(socket, { id, ok: true });
        case 'paste': {
          // As tmux: new lines as Return, and one block when the program asked for it.
          const text = String(request.text).replace(/\r?\n/g, '\r');
          child.write(screen.bracketedPaste ? `\u001b[200~${text}\u001b[201~` : text);
          return send(socket, { id, ok: true });
        }
        default:
          return send(socket, { id, ok: false, error: 'not a request of the host' });
      }
    });
  };

  const server = createServer((raw) =>
    acceptPipe(raw, spec.key, (socket) => {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      socket.on('error', () => socket.destroy());
      socket.on('close', () => viewers.delete(socket));
      socket.on('data', (chunk: Buffer) => {
        pending += decoder.write(chunk);
        if (pending.length > MAX_LINE) return void socket.destroy();
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            handle(socket, JSON.parse(line) as HostRequest);
          } catch {
            return void socket.destroy();
          }
        }
      });
    }),
  );
  server.on('error', fail);
  server.listen(spec.pipe, () => {
    const record: HostRecord = { session: spec.session, agentId: spec.agentId, pipe: spec.pipe, key: spec.key, hostPid: process.pid, pid: child.pid, startedAt: Date.now() };
    // Whole or not at all: who waits for it reads it at once.
    writeFileSync(`${spec.record}.tmp`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(`${spec.record}.tmp`, spec.record);
  });
}

main();
