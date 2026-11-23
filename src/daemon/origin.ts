// Which pages may talk to the daemon: its own, at 127.0.0.1 with its port. In WSL also at localhost, which is how a
// browser of Windows reaches a daemon there; nowhere else. The token is asked anyway: the origin only keeps other
// pages out.

export const isLocalHost = (host: string | undefined, port: number): boolean => host === `127.0.0.1:${port}` || host === `localhost:${port}`;

export const isOwnOrigin = (origin: string | undefined, port: number, localhost = false): boolean =>
  origin === `http://127.0.0.1:${port}` || (localhost && origin === `http://localhost:${port}`);
