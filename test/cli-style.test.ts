import { describe, expect, it } from 'vitest';
import { closest, code, commandHelp, mainHelp, suggestCommand } from '../src/cli/help.ts';
import { paintChange } from '../src/cli/hooks.ts';
import { colorLevel, makeStyle, paintDiff, pairs, plain, tildify, visibleLength } from '../src/cli/style.ts';

// How the CLI looks: colors only where they can be seen, the help, and the command you probably meant.

const tty = { isTTY: true };

describe('colors', () => {
  it('only on a terminal, never with NO_COLOR or TERM=dumb', () => {
    expect(colorLevel(tty, {})).toBe(1);
    expect(colorLevel({ isTTY: false }, {})).toBe(0);
    expect(colorLevel(tty, { NO_COLOR: '1' })).toBe(0);
    expect(colorLevel(tty, { NO_COLOR: '' })).toBe(1);
    expect(colorLevel(tty, { TERM: 'dumb' })).toBe(0);
  });

  it('24-bit where the terminal says so, and FORCE_COLOR wins', () => {
    expect(colorLevel(tty, { COLORTERM: 'truecolor' })).toBe(2);
    expect(colorLevel({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(1);
    expect(colorLevel(tty, { FORCE_COLOR: '0' })).toBe(0);
    expect(colorLevel(tty, { FORCE_COLOR: '1', NO_COLOR: '1' })).toBe(1);
  });

  it('paints with the colors of the app, and leaves plain text alone', () => {
    expect(makeStyle(1).claude('x')).toBe('\u001b[38;5;173mx\u001b[39m');
    expect(makeStyle(2).claude('x')).toBe('\u001b[38;2;217;119;87mx\u001b[39m');
    expect(plain.claude('x')).toBe('x');
    expect(plain.mark('✓', 'green', 'done')).toBe('done');
    expect(makeStyle(1).mark('✓', 'green', 'done')).toBe('\u001b[38;5;78m✓\u001b[39m done');
    expect(visibleLength(makeStyle(2).bold(makeStyle(2).red('abc')))).toBe(3);
  });

  it('paints a diff line by line', () => {
    const diff = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same';
    expect(paintDiff(diff, plain)).toBe(diff);
    const lines = paintDiff(diff, makeStyle(1)).split('\n');
    expect(lines[3]).toBe('\u001b[38;5;203m-old\u001b[39m');
    expect(lines[4]).toBe('\u001b[38;5;78m+new\u001b[39m');
    expect(lines[5]).toBe(' same');
  });

  it('writes paths with ~ and lines labels up', () => {
    expect(tildify('/Users/dev/Applications/Forchetta.app', '/Users/dev')).toBe('~/Applications/Forchetta.app');
    expect(tildify('/Users/developer/x', '/Users/dev')).toBe('/Users/developer/x');
    expect(pairs([['pid', '1'], ['sessions', '5']], plain)).toBe('  pid       1\n  sessions  5');
  });
});

describe('help', () => {
  it('lists every command, aligned, with no escape code when plain', () => {
    const text = mainHelp(plain);
    expect(text).not.toContain('\u001b');
    expect(text).toContain('Usage\n  forchetta <command> [options]');
    const rows = text.split('\n').filter((line) => /^ {2}(setup|run|ls|daemon|hooks) /.test(line));
    expect(rows).toHaveLength(5);
    const starts = rows.map((line) => line.search(/[A-Z]/));
    expect(new Set(starts).size).toBe(1);
  });

  it('has a page for each command, and none for the rest', () => {
    expect(commandHelp('setup', plain)).toContain('--app-dir <folder>');
    expect(commandHelp('daemon', plain)).toContain('status');
    expect(commandHelp('nope', plain)).toBeUndefined();
  });

  it('paints `code` in Claude orange, and drops the backticks without colors', () => {
    expect(code('run `forchetta setup` again', plain)).toBe('run forchetta setup again');
    expect(code('run `forchetta setup` again', makeStyle(1))).toBe('run \u001b[38;5;173mforchetta setup\u001b[39m again');
  });
});

describe('the command you meant', () => {
  it('from a typo or another name', () => {
    expect(suggestCommand('deamon')).toBe('forchetta daemon');
    expect(suggestCommand('stup')).toBe('forchetta setup');
    expect(suggestCommand('list')).toBe('forchetta ls');
    expect(suggestCommand('status')).toBe('forchetta daemon status');
    expect(suggestCommand('banana')).toBeUndefined();
    expect(closest('--yse', ['--yes', '--force'])).toBe('--yes');
    expect(closest('stat', ['start', 'stop', 'status'])).toBe('status');
    expect(closest('sta', ['start', 'stop', 'status'])).toBe('start');
  });
});

describe('the list of the hook changes', () => {
  it('paints the sign, the event and the rest, with ~ for the home folder', () => {
    const line = '+ PreToolUse: command /Users/dev/Forchetta/bin/forchetta-hook 47821 (async)';
    expect(paintChange(line, plain, '/Users/dev')).toBe('+ PreToolUse: command ~/Forchetta/bin/forchetta-hook 47821 (async)');
    expect(paintChange(line, makeStyle(1), '/Users/dev')).toBe(
      '\u001b[38;5;78m+\u001b[39m \u001b[1mPreToolUse\u001b[22m: \u001b[38;5;245mcommand ~/Forchetta/bin/forchetta-hook 47821 (async)\u001b[39m',
    );
    expect(paintChange('- statusLine', makeStyle(1), '/Users/dev')).toBe('\u001b[38;5;203m-\u001b[39m \u001b[1mstatusLine\u001b[22m');
  });
});
