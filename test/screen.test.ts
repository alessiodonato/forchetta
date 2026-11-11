import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPromptBox, screenShows } from '../src/daemon/screen.ts';

// Screens of Claude Code 2.1.322 captured with `tmux capture-pane -p -e` during the tests of Phase 4.
const screen = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', 'screens', `${name}.txt`), 'utf8');

describe('the input box of Claude Code', () => {
  it('is found and empty after a turn', () => {
    expect(readPromptBox(screen('vuota'))).toEqual({ found: true, typed: '' });
    expect(readPromptBox(screen('dopo-btw'))).toEqual({ found: true, typed: '' });
  });

  it('shows a draft typed by someone', () => {
    expect(readPromptBox(screen('bozza'))).toEqual({ found: true, typed: 'una bozza scritta a mano' });
  });

  it('is not there while the answer of /btw is open', () => {
    expect(readPromptBox(screen('btw')).found).toBe(false);
    expect(screenShows(screen('btw'), '/btw di che colore è il cielo? una parola')).toBe(true);
  });

  it('reads the placeholder of a new session (dim) as an empty box', () => {
    expect(readPromptBox(screen('segnaposto'))).toEqual({ found: true, typed: '' });
  });

  it('ignores the dim placeholder and suggestions', () => {
    const rule = '\u001b[38;5;244m' + '─'.repeat(60) + '\u001b[39m';
    const placeholder = [rule, '\u001b[39m❯ \u001b[2mTry\u001b[0m \u001b[2m"how\u001b[0m \u001b[2mdoes\u001b[0m \u001b[2m<filepath>\u001b[0m \u001b[2mwork?"\u001b[0m', rule, '  footer'].join('\n');
    expect(readPromptBox(placeholder)).toEqual({ found: true, typed: '' });
    const mixed = [rule, '❯ /com\u001b[2mpact\u001b[0m', rule].join('\n');
    expect(readPromptBox(mixed)).toEqual({ found: true, typed: '/com' });
  });

  it('reads a draft on more lines, and ignores what a resize left of a rule', () => {
    const rule = '─'.repeat(60);
    expect(readPromptBox([rule, '──', '❯ prima riga', '  seconda riga', rule, '──'].join('\n'))).toEqual({ found: true, typed: 'prima riga seconda riga' });
  });

  it('is not a dialog that happens to start with ❯', () => {
    const rule = '─'.repeat(60);
    const question = ['❯ la richiesta di prima', rule, ' ☐ Colore', 'Preferisci il rosso o il blu?', '❯ 1. Rosso', '  2. Blu', rule, '  4. Chat about this'].join('\n');
    expect(readPromptBox(question).found).toBe(false);
  });
});
