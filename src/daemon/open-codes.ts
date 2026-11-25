import { createHash, randomBytes } from 'node:crypto';

// How a browser gets the token of the daemon (`forchetta open`). The CLI, which has the token, asks for a code and
// opens the page with it in the fragment of the address; the page trades it for the token, once, within two minutes.
// The token itself never goes in an address: browsers keep those in their history, and may sync it, and on Windows
// an address is an argument of the program that opens it, which other programs can read.

export const OPEN_CODE_MS = 2 * 60_000;
const OPEN_CODE = /^[0-9a-f]{32}$/;
/**
 * A page that is open when Forchetta updates itself: it made a code of its own, the daemon before kept its hash, and the daemon of
 * the new version takes it, once. Long enough for an update.
 */
export const HANDOVER_MS = 40 * 60_000;
const HASH = /^[0-9a-f]{64}$/;
export const hashOf = (code: string): string => createHash('sha256').update(code).digest('hex');

/** More codes than anyone opens pages in two minutes: past them, the oldest goes. */
const MAX_CODES = 16;

export class OpenCodes {
  private readonly codes = new Map<string, number>();
  /** By their hash: those of the pages that were open. */
  private readonly handed = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  create(): string {
    this.forgetOld();
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, this.now() + OPEN_CODE_MS);
    return code;
  }

  /** Whether the code is good, which it is only once. */
  redeem(code: unknown): boolean {
    this.forgetOld();
    return typeof code === 'string' && OPEN_CODE.test(code) && (this.codes.delete(code) || this.handed.delete(hashOf(code)));
  }

  /** A page that is open keeps this code for after an update; false when it is not one. */
  hand(code: unknown): boolean {
    if (typeof code !== 'string' || !OPEN_CODE.test(code)) return false;
    this.adopt({ [hashOf(code)]: this.now() + HANDOVER_MS });
    return true;
  }

  /** The hashes kept, for the daemon that comes. */
  handedOver(): Record<string, number> {
    this.forgetOld();
    return Object.fromEntries(this.handed);
  }

  /** Those the daemon before kept. */
  adopt(hashes: unknown): void {
    for (const [hash, until] of Object.entries(hashes && typeof hashes === 'object' ? hashes : {})) {
      if (!HASH.test(hash) || typeof until !== 'number' || until > this.now() + HANDOVER_MS) continue;
      while (this.handed.size >= MAX_CODES) this.handed.delete(this.handed.keys().next().value!);
      this.handed.set(hash, until);
    }
    this.forgetOld();
  }

  private forgetOld(): void {
    const now = this.now();
    for (const codes of [this.codes, this.handed]) for (const [code, until] of codes) if (until <= now) codes.delete(code);
  }
}
