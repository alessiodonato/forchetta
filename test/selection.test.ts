import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QuickPrompts } from '../src/daemon/prompts.ts';
import { SelectionReader } from '../src/daemon/selection.ts';
import { cleanPrompts, DEFAULT_PROMPTS, fillPrompt } from '../src/shared/prompts.ts';
import { askText, btwText, byteLength, cleanSelection, insertText, MAX_SELECTION, quote, sendText } from '../src/shared/selection.ts';
import type { TmuxCommand, TmuxResult } from '../src/shared/tmux.ts';
import { tempDir } from './helpers.ts';

describe('the text of a selection', () => {
  it('loses what Claude Code draws around it, and keeps its own indentation', () => {
    const screen = [
      '⏺ I test sono falliti perché',
      '  il token è scaduto:',
      '',
      '    if (expired) {',
      '      return 401;',
      '    }   ',
      '',
      '',
      '',
      '  ⎿  FAIL src/auth.test.ts',
    ].join('\n');
    expect(cleanSelection(screen)).toBe(
      ['I test sono falliti perché', 'il token è scaduto:', '', '  if (expired) {', '    return 401;', '  }', '', '   FAIL src/auth.test.ts'].join('\n'),
    );
  });

  it('drops rules and the sides of boxes', () => {
    const screen = ['╭──────────────────╮', '│ Welcome to Claude │', '│   /help for help  │', '╰──────────────────╯', '────────────'].join('\n');
    expect(cleanSelection(screen)).toBe('Welcome to Claude\n  /help for help');
  });

  it('keeps no control characters, and is cut when it is too long', () => {
    expect(cleanSelection('a\u001b[31mb\r\nc\u0007')).toBe('a[31mb\nc');
    expect(cleanSelection('x'.repeat(MAX_SELECTION + 50))).toHaveLength(MAX_SELECTION);
    expect(cleanSelection('  \n ─── \n')).toBe('');
  });

  it('becomes the texts of the menu', () => {
    expect(quote('uno\n\ndue')).toBe('> uno\n>\n> due');
    expect(askText(' perché 401? ', 'Expected 200\nreceived 401')).toBe('perché 401?\n\n> Expected 200\n> received 401');
    expect(sendText('correggi', 'errore', 'frontend')).toBe('correggi\n\nFrom the session frontend:\n> errore');
    expect(insertText('riga')).toBe('> riga\n');
  });

  it('fits /btw on one line, within its limit in bytes', () => {
    expect(btwText('perché?', 'Expected 200,\nreceived 401')).toBe('perché? — about: "Expected 200, received 401"');
    const long = btwText('perché questo errore?', 'è'.repeat(2000));
    expect(byteLength(long)).toBeLessThanOrEqual(1000);
    expect(long).toMatch(/^perché questo errore\? — about: "è+…"$/);
    expect(btwText('q'.repeat(1200), 'x').length).toBeLessThanOrEqual(1000);
  });
});

describe('quick prompts', () => {
  const values = { selection: 'Expected 200\nreceived 401', session: 'api-gateway', folder: '/p/api' };

  it('fill their variables: the selection quoted on a line of its own, inline elsewhere, after the text when missing', () => {
    expect(fillPrompt({ text: 'Explain this:\n{selection}', mode: 'ask' }, values)).toBe('Explain this:\n> Expected 200\n> received 401');
    expect(fillPrompt({ text: 'Why "{selection}" in {session} ({folder})?', mode: 'prompt' }, values)).toBe('Why "Expected 200 received 401" in api-gateway (/p/api)?');
    expect(fillPrompt({ text: 'Fix it', mode: 'ask' }, values)).toBe('Fix it\n\n> Expected 200\n> received 401');
    expect(fillPrompt({ text: 'Explain:\n{selection}', mode: 'btw' }, values)).toBe('Explain: "Expected 200 received 401"');
    expect(fillPrompt({ text: 'Explain', mode: 'btw' }, values)).toBe('Explain — about: "Expected 200 received 401"');
    expect(byteLength(fillPrompt({ text: '{selection} vs {selection}', mode: 'btw' }, { ...values, selection: 'x'.repeat(5000) }))).toBeLessThanOrEqual(1000);
    // A $ in the selection is text, not a pattern of replace.
    expect(fillPrompt({ text: 'A {selection} B', mode: 'prompt' }, { ...values, selection: "$& $' $1" })).toBe("A $& $' $1 B");
  });

  it('are checked as the page sends them', () => {
    expect(cleanPrompts(DEFAULT_PROMPTS)).toEqual({ prompts: DEFAULT_PROMPTS });
    expect(cleanPrompts([{ name: '  Spiega\n', text: ' Spiega:\r\n{selection} ', mode: 'prompt' }])).toEqual({ prompts: [{ name: 'Spiega', text: 'Spiega:\n{selection}', mode: 'prompt' }] });
    expect(cleanPrompts('no')).toEqual({ error: 'not a list of prompts' });
    expect(cleanPrompts([{ name: '', text: 'x', mode: 'ask' }])).toEqual({ error: 'every prompt needs a name' });
    expect(cleanPrompts([{ name: 'A', text: ' ', mode: 'ask' }])).toEqual({ error: '"A" has no text' });
    expect(cleanPrompts([{ name: 'A', text: 'x', mode: 'run' }])).toEqual({ error: '"A": choose ask, btw or prompt' });
    expect(cleanPrompts([{ name: 'A', text: 'x', mode: 'ask' }, { name: 'a', text: 'y', mode: 'ask' }])).toEqual({ error: 'two prompts are called "a"' });
    expect('error' in cleanPrompts(Array.from({ length: 13 }, (_, n) => ({ name: `p${n}`, text: 'x', mode: 'ask' })))).toBe(true);
  });

  it('are kept in their file, and the defaults stay until you save', () => {
    const temp = tempDir('prompts');
    try {
      const file = join(temp.dir, 'prompts.json');
      const logs: string[] = [];
      const prompts = new QuickPrompts(file, (line) => logs.push(line));
      expect(prompts.list()).toEqual(DEFAULT_PROMPTS);
      expect(prompts.save([{ name: 'Spiega', text: 'Spiega:\n{selection}', mode: 'ask' }])).toEqual({ ok: true });
      expect(new QuickPrompts(file, () => {}).list()).toEqual([{ name: 'Spiega', text: 'Spiega:\n{selection}', mode: 'ask' }]);
      expect(prompts.save([{ name: 'X', text: '', mode: 'ask' }])).toEqual({ ok: false, error: '"X" has no text' });
      expect(JSON.parse(readFileSync(file, 'utf8')).prompts).toHaveLength(1);

      writeFileSync(file, '{"prompts": "broken"}');
      expect(new QuickPrompts(file, (line) => logs.push(line)).list()).toEqual(DEFAULT_PROMPTS);
      expect(logs.at(-1)).toContain('illeggibili');
    } finally {
      temp.cleanup();
    }
  });
});

/** The buffers of a tmux: the newest first, as list-buffers gives them, with when they were made (seconds). */
class BufferTmux {
  buffers: { name: string; text: string; created: number }[] = [];
  /** A drag that ends: tmux copies a moment later. */
  copyAfter(calls: number, text: string): void {
    this.pendingCopy = { calls, text };
  }
  private pendingCopy: { calls: number; text: string } | undefined;
  private next = 0;

  async run(command: TmuxCommand, args: readonly string[]): Promise<TmuxResult> {
    if (this.pendingCopy && --this.pendingCopy.calls <= 0) {
      this.buffers.unshift({ name: `buffer${this.next++}`, text: this.pendingCopy.text, created: Math.floor(Date.now() / 1000) });
      this.pendingCopy = undefined;
    }
    if (command === 'list-buffers') return { code: 0, stdout: this.buffers.map((buffer) => `${buffer.name}\t${buffer.created}\n`).join(''), stderr: '' };
    if (command === 'show-buffer') {
      const buffer = this.buffers.find((candidate) => candidate.name === args[args.indexOf('-b') + 1]);
      return buffer ? { code: 0, stdout: buffer.text, stderr: '' } : { code: 1, stdout: '', stderr: 'no buffer' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${command}` };
  }
}

describe('SelectionReader', () => {
  const noWait = async (): Promise<void> => {};
  /** A buffer made long before the press. */
  const OLD = Math.floor(Date.now() / 1000) - 60;

  it('reads the buffer that tmux made after the drag started, also when it comes a moment later', async () => {
    const tmux = new BufferTmux();
    tmux.buffers = [{ name: 'forchetta-ab12', text: 'a request', created: OLD }, { name: 'buffer7', text: 'old', created: OLD }];
    const reader = new SelectionReader(tmux, noWait);
    reader.start('A');
    tmux.copyAfter(3, 'riga due con errore 401');
    expect(await reader.end('A')).toBe('riga due con errore 401');
  });

  it('reads nothing when tmux copied nothing, or for a drag that did not start', async () => {
    const tmux = new BufferTmux();
    tmux.buffers = [{ name: 'buffer3', text: 'old', created: OLD }];
    const reader = new SelectionReader(tmux, noWait);
    reader.start('A');
    expect(await reader.end('A', 200)).toBeUndefined();
    expect(await reader.end('B')).toBeUndefined();
    // A buffer of Forchetta (a request being pasted) is not a selection.
    reader.start('A');
    tmux.buffers.unshift({ name: 'forchetta-cd34', text: 'a request', created: Math.floor(Date.now() / 1000) });
    expect(await reader.end('A', 200)).toBeUndefined();
  });

  it('reads the copy of a very quick drag, which tmux made before the daemon looked', async () => {
    const tmux = new BufferTmux();
    const pressed = Date.now();
    tmux.buffers = [{ name: 'buffer4', text: 'quick', created: Math.floor(pressed / 1000) }, { name: 'buffer3', text: 'old', created: OLD }];
    const reader = new SelectionReader(tmux, noWait, () => pressed);
    reader.start('A');
    expect(await reader.end('A')).toBe('quick');
  });

  it('waits for the copy of a drag that comes in the same second as the one before, and never reads that one again', async () => {
    const tmux = new BufferTmux();
    tmux.buffers = [{ name: 'buffer3', text: 'old', created: OLD }];
    const reader = new SelectionReader(tmux, noWait);
    reader.start('A');
    tmux.copyAfter(2, 'first');
    expect(await reader.end('A')).toBe('first');
    // The next drag, at once: its copy comes a little later than the first look.
    reader.start('A');
    tmux.copyAfter(4, 'second');
    expect(await reader.end('A')).toBe('second');
    // A drag that tmux did not copy: the last copy, already read, is not shown again.
    reader.start('A');
    expect(await reader.end('A', 600)).toBeUndefined();
  });
});
