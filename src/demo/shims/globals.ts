// What the daemon's modules expect of Node, set before any of them loads: Buffer (only what they use), process,
// setImmediate, and unref() on timers, which in a browser are numbers.

class DemoBuffer extends Uint8Array {
  static override from(value: unknown, _encoding?: unknown): DemoBuffer {
    if (typeof value === 'string') return new DemoBuffer(new TextEncoder().encode(value));
    return new DemoBuffer(value as ArrayLike<number>);
  }

  static byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
  }

  static isBuffer(value: unknown): boolean {
    return value instanceof DemoBuffer;
  }

  override toString(encoding?: string): string {
    if (encoding === 'hex') return [...this].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return new TextDecoder().decode(this);
  }
}

const scope = globalThis as unknown as Record<string, unknown>;

scope.Buffer ??= DemoBuffer;
scope.process ??= {
  env: { FORCHETTA_ROOT: '/forchetta', FORCHETTA_VAR: '/forchetta/var', HOME: '/Users/you' },
  pid: 4242,
  platform: 'darwin',
  argv: [],
  versions: {},
  cwd: () => '/Users/you',
  on: () => undefined,
  nextTick: (callback: () => void) => queueMicrotask(callback),
};
scope.setImmediate ??= (callback: () => void) => setTimeout(callback, 0);

const proto = Number.prototype as unknown as Record<string, unknown>;
proto.unref ??= function unref(this: number) {
  return this;
};
proto.ref ??= function ref(this: number) {
  return this;
};
proto.hasRef ??= () => false;

export {};
