import { describe, expect, it } from 'vitest';
import { GlyphFilter } from '../src/ui/glyphs.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('glyphs of the panes', () => {
  it('shows ⏺ as ●, with the same length, and leaves the rest alone', () => {
    const filter = new GlyphFilter();
    const input = encode('\u001b[32m⏺\u001b[0m Bash(npm test)\n  ⎿  ✓ ok ▐▛███▜▌');
    const output = filter.push(input);
    expect(output.length).toBe(input.length);
    expect(decode(output)).toBe('\u001b[32m●\u001b[0m Bash(npm test)\n  ⎿  ✓ ok ▐▛███▜▌');
  });

  it('also when ⏺ arrives split across two chunks', () => {
    const bytes = encode('a⏺b');
    for (let cut = 1; cut < bytes.length; cut++) {
      const filter = new GlyphFilter();
      const first = filter.push(bytes.slice(0, cut));
      const second = filter.push(bytes.slice(cut));
      expect(decode(new Uint8Array([...first, ...second]))).toBe('a●b');
    }
  });

  it('does not touch other characters that start like it', () => {
    const filter = new GlyphFilter();
    // ⎿ is E2 8E BF, │ is E2 94 82: they share the first byte.
    expect(decode(filter.push(encode('⎿│⏻')))).toBe('⎿│⏻');
  });
});
