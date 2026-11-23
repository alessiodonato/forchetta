// Which pages may talk to the daemon: its own, at 127.0.0.1 or at localhost with its port. localhost is how a
// browser of Windows reaches a daemon inside WSL2. The token is asked anyway: the origin only keeps other pages out.

export const isLocalHost = (host: string | undefined, port: number): boolean => host === `127.0.0.1:${port}` || host === `localhost:${port}`;

export const isOwnOrigin = (origin: string | undefined, port: number): boolean => origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
