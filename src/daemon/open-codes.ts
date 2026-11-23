import { randomBytes } from 'node:crypto';

// How a browser gets the token of the daemon (`forchetta open`). The CLI, which has the token, asks for a code and
// opens the page with it in the fragment of the address; the page trades it for the token, once, within two minutes.
// The token itself never goes in an address: browsers keep those in their history, and may sync it, and on Windows
// an address is an argument of the program that opens it, which other programs can read.

export const OPEN_CODE_MS = 2 * 60_000;
const OPEN_CODE = /^[0-9a-f]{32}$/;
/** More codes than anyone opens pages in two minutes: past them, the oldest goes. */
const MAX_CODES = 16;

export class OpenCodes {
  private readonly codes = new Map<string, number>();

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
    return typeof code === 'string' && OPEN_CODE.test(code) && this.codes.delete(code);
  }

  private forgetOld(): void {
    const now = this.now();
    for (const [code, until] of this.codes) if (until <= now) this.codes.delete(code);
  }
}
