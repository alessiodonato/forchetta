import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPromptBox, restartAnswer, restartOffer, restartWorked, screenShows } from '../src/daemon/screen.ts';

// Screens of Claude Code 2.1.322 captured with `tmux capture-pane -p -e` during the tests of Phase 4.
const screen = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', 'screens', `${name}.txt`), 'utf8');

describe('the input box of Claude Code', () => {
  it('is found in a session with a name, whose name sits in the rule above, with a pasted request on three lines', () => {
    expect(readPromptBox(screen('nome-incollato'))).toEqual({ found: true, typed: 'Request #1 from the user: Reply only with the word OK. Nothing else.' });
  });

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

describe('/restart on screen', () => {
  it('is offered by the menu under the box, on a newer version, in a wide pane and in a narrow one', () => {
    expect(readPromptBox(screen('restart-menu'))).toEqual({ found: true, typed: '/restart' });
    expect(restartOffer(screen('restart-menu'))).toBe('newer');
    expect(restartOffer(screen('restart-menu-60'))).toBe('newer');
  });

  const RULE = '─'.repeat(40);
  const menu = (...lines: string[]): string => ['⏺ ok', RULE, '❯ /restart', RULE, ...lines].join('\n');
  it('is not taken for what it is not: another command first, one of yours, the version it already has, no menu', () => {
    expect(restartOffer(menu('  ❯ /deep-research     [dynamic workflow] Deep research', '    /restart     Restart on 2.1.331 and keep this session'))).toBeUndefined();
    expect(restartOffer(menu('  ❯ /restart     Restart the dev server'))).toBeUndefined();
    expect(restartOffer(menu('  ❯ /restart     Restart Claude Code and keep this session'))).toBe('same');
    expect(restartOffer(menu('  footer'))).toBeUndefined();
    // The same words above the box are of the conversation.
    expect(restartOffer(['  ❯ /restart     Restart on 2.1.331 and keep this session', RULE, '❯ /restart', RULE, '  footer'].join('\n'))).toBeUndefined();
    expect(restartOffer('')).toBeUndefined();
  });

  it('is answered under it, also on more lines: the last answer counts', () => {
    const refused = ['❯ /restart', "  ⎿  Can't restart while work is running in the background. Wait for it to finish or stop it in /tasks, then", '     try again.', '', RULE, '❯ ', RULE].join('\n');
    expect(restartAnswer(refused)).toBe("Can't restart while work is running in the background. Wait for it to finish or stop it in /tasks, then try again.");
    const worked = ['❯ /restart', "  ⎿  Can't restart", '', '❯ /restart', '  ⎿  Successfully updated from 2.1.328 to version 2.1.331', '', RULE, '❯ ', RULE].join('\n');
    expect(restartAnswer(worked)).toBe('Successfully updated from 2.1.328 to version 2.1.331');
    expect(restartWorked(restartAnswer(worked)!)).toBe(true);
    expect(restartWorked('Session resumed')).toBe(true);
    expect(restartWorked(restartAnswer(refused)!)).toBe(false);
    expect(restartAnswer(screen('restart-menu'))).toBeUndefined();
  });
});
