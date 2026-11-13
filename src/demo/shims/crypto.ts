// node:crypto for the demo: ids and tokens from the crypto of the browser.

export const randomUUID = (): string => globalThis.crypto.randomUUID();

class Bytes extends Uint8Array {
  override toString(encoding?: string): string {
    if (encoding === 'hex') return [...this].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (encoding === 'base64url' || encoding === 'base64') {
      const text = btoa(String.fromCharCode(...this));
      return encoding === 'base64' ? text : text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return new TextDecoder().decode(this);
  }
}

export function randomBytes(size: number): Bytes {
  const bytes = new Bytes(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function timingSafeEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

export default { randomUUID, randomBytes, timingSafeEqual };
