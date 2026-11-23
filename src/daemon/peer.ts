import { readFileSync } from 'node:fs';

// Whose program is at the other end of a connection to the daemon. On Linux every user of the computer can read the
// arguments of the programs of the others, and the browser that `forchetta open` starts has the code of the page among
// its own: the code alone is not enough to say who asks. The kernel knows: /proc/net/tcp lists the connections with the
// user of each end. Not in WSL, where who connects is Windows, through a program of the system.

/** 127.0.0.1 in /proc/net/tcp, and as an IPv6 address in /proc/net/tcp6. */
const LOOPBACK = ['0100007F', '0000000000000000FFFF00000100007F'];
const portIn = (port: number): string => port.toString(16).toUpperCase().padStart(4, '0');

/** The user of the program that connected from `from` to `to`, both on 127.0.0.1; undefined when it is not listed. */
export function peerUid(table: string, from: number, to: number): number | undefined {
  for (const line of table.split('\n')) {
    const [, local, remote, , , , , uid] = line.trim().split(/\s+/);
    if (!local || !remote || !uid || !/^\d+$/.test(uid)) continue;
    if (LOOPBACK.some((address) => local === `${address}:${portIn(from)}` && remote === `${address}:${portIn(to)}`)) return Number(uid);
  }
  return undefined;
}

const readTable = (file: string): string => readFileSync(file, 'utf8');

/** Whether the other end is a program of this user; not known counts as no. */
export function sameUser(socket: { remotePort?: number; localPort?: number }, own: number | undefined = process.getuid?.(), read: (file: string) => string = readTable): boolean {
  const { remotePort, localPort } = socket;
  if (remotePort === undefined || localPort === undefined || own === undefined) return false;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let uid: number | undefined;
    try {
      uid = peerUid(read(file), remotePort, localPort);
    } catch {
      // No IPv6 here, say: the other table may have it.
    }
    if (uid !== undefined) return uid === own;
  }
  return false;
}
