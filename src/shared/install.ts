import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.ts';
import { formulaVersion, type InstallKind } from './updates.ts';

// How this Forchetta was installed, and which version is the last one for it (daemon/updates.ts, cli/update.ts).

export const TAP = 'alessiodonato/tap/forchetta';
/** The formula of the tap: the version Homebrew installs now. Read as anyone can, with nothing of yours in the request. */
const FORMULA = 'https://raw.githubusercontent.com/alessiodonato/homebrew-tap/main/Formula/forchetta.rb';
const TIMEOUT_MS = 15_000;

export function installKind(root = ROOT, exists: (path: string) => boolean = existsSync): InstallKind {
  if (exists(join(root, '.git'))) return 'clone';
  return brewPrefix(root) ? 'brew' : 'other';
}

/** The folder of Homebrew a Forchetta is in: /opt/homebrew for /opt/homebrew/opt/forchetta/libexec. */
export const brewPrefix = (root = ROOT): string | undefined => /^(.+)\/(?:opt\/forchetta|Cellar\/forchetta\/[^/]+)\/libexec$/.exec(root)?.[1];

/** A text of the web; a file, in the tests. */
export async function readText(from: string): Promise<string> {
  if (!/^https:\/\//.test(from)) return (await import('node:fs/promises')).readFile(from, 'utf8');
  const response = await fetch(from, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'forchetta' } });
  if (!response.ok) throw new Error(`${new URL(from).host} answered ${response.status}`);
  return response.text();
}

/** The last version there is for this installation. */
export async function latestVersion(source = process.env.FORCHETTA_UPDATE_SOURCE): Promise<string | undefined> {
  return formulaVersion(await readText(source ?? FORMULA));
}
