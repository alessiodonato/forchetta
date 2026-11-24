import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

// The pipes of Windows on which the hooks talk to the daemon, and the daemon to the hosts of the sessions. On a Mac and on
// Linux a socket in a private folder is enough: no one else can open it, nor be there in its place. A pipe of Windows has a
// name that any program of the computer can see while it is there, and take once it is gone. So each has a name made at
// random and a key, both in a file of the private folder, and the two ends prove to each other that they have the key,
// without sending it, before anything else passes: who connects knows it talks to Forchetta, and the other way round.

export interface PipeInfo {
  /** \\.\pipe\forchetta-…: on a Mac, in the tests, the path of a socket. */
  pipe: string;
  /** 32 bytes in hex. */
  key: string;
}

/** How long each end waits for the other to prove itself. */
export const PROOF_MS = 2000;
const HELLO = /^fk1 ([0-9a-f]{32})$/;
const ANSWER = /^([0-9a-f]{64}) ([0-9a-f]{32})$/;
const PROOF = /^[0-9a-f]{64}$/;
/** The longest line of the proofs: more than this is not one. */
const MAX_LINE = 200;

export const newPipe = (what: string, name = `\\\\.\\pipe\\forchetta-${what}-${randomBytes(16).toString('hex')}`): PipeInfo => ({ pipe: name, key: randomBytes(32).toString('hex') });

const nonce = (): string => randomBytes(16).toString('hex');
const proof = (key: string, who: 'server' | 'client', theirs: string, ours: string): string => createHmac('sha256', Buffer.from(key, 'hex')).update(`${who}:${theirs}:${ours}`).digest('hex');

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Reads the lines of the proofs, and nothing of what comes after them. */
function lines(socket: Socket, onLine: (line: string) => void, onBad: () => void): () => void {
  let text = '';
  const onData = (chunk: Buffer): void => {
    text += chunk.toString('latin1');
    const end = text.indexOf('\n');
    if (end < 0) {
      if (text.length > MAX_LINE) onBad();
      return;
    }
    // Each end waits for the other: a line and nothing more.
    if (end !== text.length - 1) return onBad();
    const line = text.slice(0, end);
    text = '';
    onLine(line);
  };
  socket.on('data', onData);
  return () => socket.removeListener('data', onData);
}

/** The end that listens: calls `ready` with a connection that proved it has the key, and closes the others. */
export function acceptPipe(socket: Socket, key: string, ready: (socket: Socket) => void): void {
  const fail = (): void => {
    clearTimeout(timer);
    stop();
    socket.destroy();
  };
  const timer = setTimeout(() => fail(), PROOF_MS);
  timer.unref?.();
  socket.on('error', () => socket.destroy());
  let theirs: string | undefined;
  const ours = nonce();
  const stop = lines(
    socket,
    (line) => {
      if (theirs === undefined) {
        theirs = HELLO.exec(line)?.[1];
        if (theirs === undefined) return fail();
        socket.write(`${proof(key, 'server', theirs, ours)} ${ours}\n`);
        return;
      }
      if (!PROOF.test(line) || !same(line, proof(key, 'client', ours, theirs))) return fail();
      clearTimeout(timer);
      stop();
      socket.pause();
      socket.write('ok\n');
      ready(socket);
      socket.resume();
    },
    fail,
  );
}

/** The end that connects: the connection, once the other end proved it has the key. */
export function connectPipe(info: PipeInfo, timeoutMs = PROOF_MS): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(info.pipe);
    const ours = nonce();
    let stop = (): void => {};
    const fail = (error: Error): void => {
      clearTimeout(timer);
      stop();
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('no answer on the pipe')), timeoutMs);
    const onError = (error: Error): void => fail(error);
    const onClose = (): void => fail(new Error('the pipe closed'));
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('connect', () => socket.write(`fk1 ${ours}\n`));
    let proved = false;
    stop = lines(
      socket,
      (line) => {
        if (!proved) {
          const [, theirProof, theirs] = ANSWER.exec(line) ?? [];
          if (!theirProof || !theirs || !same(theirProof, proof(info.key, 'server', ours, theirs))) return fail(new Error('what answers on the pipe is not Forchetta'));
          proved = true;
          socket.write(`${proof(info.key, 'client', theirs, ours)}\n`);
          return;
        }
        if (line !== 'ok') return fail(new Error('refused on the pipe'));
        clearTimeout(timer);
        stop();
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        // Whoever takes it hears its errors; until then they are not fatal.
        socket.on('error', () => {});
        socket.pause();
        resolve(socket);
      },
      () => fail(new Error('not understood on the pipe')),
    );
  });
}

/** A file with a pipe and its key, as the daemon and the hosts write it; undefined when it is not one. */
export function parsePipe(text: string): PipeInfo | undefined {
  try {
    const raw = JSON.parse(text) as Partial<PipeInfo>;
    if (typeof raw.pipe === 'string' && raw.pipe && typeof raw.key === 'string' && /^[0-9a-f]{64}$/.test(raw.key)) return { pipe: raw.pipe, key: raw.key };
  } catch {
    // Not there yet, or half written.
  }
  return undefined;
}
