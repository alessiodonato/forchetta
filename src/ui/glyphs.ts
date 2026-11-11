// What a pane shows of a symbol that macOS 12 has only as a color emoji.
//
// Claude Code marks its steps with ⏺ (U+23FA). No text font of macOS 12 has it, so WebKit draws the color emoji,
// two cells wide over the next letter. In the panes of Forchetta it becomes ● (U+25CF), which Menlo has: same
// length in UTF-8 (3 bytes), same width (one cell), and it takes the color Claude Code gives it. Only the
// drawing changes: Claude Code, tmux and the session see nothing.

const FROM = [0xe2, 0x8f, 0xba];
const TO = [0xe2, 0x97, 0x8f];

export class GlyphFilter {
  /** The end of the last chunk, when it could be the start of ⏺: it waits for the next chunk. */
  private carry = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array {
    let data = chunk;
    if (this.carry.length > 0) {
      data = new Uint8Array(this.carry.length + chunk.length);
      data.set(this.carry);
      data.set(chunk, this.carry.length);
    } else {
      data = chunk.slice();
    }
    const length = data.length;
    let keep = 0;
    if (length >= 1 && data[length - 1] === FROM[0]) keep = 1;
    else if (length >= 2 && data[length - 2] === FROM[0] && data[length - 1] === FROM[1]) keep = 2;
    this.carry = data.slice(length - keep);
    const out = data.subarray(0, length - keep);
    for (let index = 0; index + 2 < out.length; index++) {
      if (out[index] === FROM[0] && out[index + 1] === FROM[1] && out[index + 2] === FROM[2]) {
        out[index + 1] = TO[1]!;
        out[index + 2] = TO[2]!;
        index += 2;
      }
    }
    return out;
  }
}
