import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from './fspath.ts';
import { ROOT } from './paths.ts';
import { PLATFORM, type Platform } from './platform.ts';
import { formulaVersion, type InstallKind, isNewer } from './updates.ts';
import { VERSION } from './version.ts';

// How this Forchetta was installed, and which version is the last one for it (daemon/updates.ts, cli/update.ts).

export const TAP = 'alessiodonato/tap/forchetta';
/** The formula of the tap: the version Homebrew installs now. Read as anyone can, with nothing of yours in the request. */
const FORMULA = 'https://raw.githubusercontent.com/alessiodonato/homebrew-tap/main/Formula/forchetta.rb';
/** The releases, for what the installers of Windows and Linux put there. */
const RELEASES = 'https://api.github.com/repos/alessiodonato/forchetta/releases?per_page=20';
const DOWNLOADS = 'https://github.com/alessiodonato/forchetta/releases/download/';
const TIMEOUT_MS = 15_000;

export function installKind(root = ROOT, exists: (path: string) => boolean = existsSync, platform: Platform | undefined = PLATFORM): InstallKind {
  if (exists(join(root, '.git'))) return 'clone';
  if (platform === 'macos') return brewPrefix(root) ? 'brew' : 'other';
  return /\/\.local\/lib\/forchetta$/.test(root) ? 'installer' : 'other';
}

/** The folder of Homebrew a Forchetta is in: /opt/homebrew for /opt/homebrew/opt/forchetta/libexec. */
export const brewPrefix = (root = ROOT): string | undefined => /^(.+)\/(?:opt\/forchetta|Cellar\/forchetta\/[^/]+)\/libexec$/.exec(root)?.[1];

/** A file of the web; one of the disk, in the tests. */
export async function readBytes(from: string): Promise<Buffer> {
  if (!/^https:\/\//.test(from)) return readFile(from);
  const response = await fetch(from, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'forchetta' } });
  if (!response.ok) throw new Error(`${new URL(from).host} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export interface Release {
  version: string;
  /** The address of its installer, and the checksum GitHub gives of it. */
  installer: string;
  sha256?: string;
}

/** The installer of this system. */
export const installerName = (platform: Platform | undefined = PLATFORM): 'install.ps1' | 'install.sh' => (platform === 'windows' ? 'install.ps1' : 'install.sh');

/**
 * The newest release with an installer for this system; a beta only for who has one. Its installer is at the address every file
 * of the release is at, or it is not one; `anywhere` is for the tests.
 */
export function pickRelease(list: unknown, script: string, current: string, anywhere = false): Release | undefined {
  let best: Release | undefined;
  for (const raw of Array.isArray(list) ? (list as Record<string, unknown>[]) : []) {
    if (!raw || typeof raw !== 'object' || raw.draft === true || typeof raw.tag_name !== 'string') continue;
    const version = raw.tag_name.replace(/^v/, '');
    // What isNewer does not take for a version goes no further.
    if (!isNewer(version, '0.0.0') || (version.includes('-beta.') && !current.includes('-beta.'))) continue;
    const asset = (Array.isArray(raw.assets) ? (raw.assets as Record<string, unknown>[]) : []).find((one) => one?.name === script);
    const address = asset?.browser_download_url;
    if (typeof address !== 'string' || !(anywhere || address === `${DOWNLOADS}v${version}/${script}`)) continue;
    const sha256 = typeof asset?.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] : undefined;
    if (!best || isNewer(version, best.version)) best = { version, installer: address, ...(sha256 ? { sha256 } : {}) };
  }
  return best;
}

export async function latestRelease(source = process.env.FORCHETTA_UPDATE_SOURCE, current = VERSION): Promise<Release | undefined> {
  return pickRelease(JSON.parse((await readBytes(source ?? RELEASES)).toString('utf8')), installerName(), current, source !== undefined);
}

/** The last version there is for this installation. */
export async function latestVersion(source = process.env.FORCHETTA_UPDATE_SOURCE, kind = installKind()): Promise<string | undefined> {
  if (kind === 'installer') return (await latestRelease(source))?.version;
  return formulaVersion((await readBytes(source ?? FORMULA)).toString('utf8'));
}

/** Whether a file is the one GitHub says; with no checksum, https is what there is. */
export const isIntact = (bytes: Buffer, sha256: string | undefined): boolean => sha256 === undefined || createHash('sha256').update(bytes).digest('hex') === sha256;
