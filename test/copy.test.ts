import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { which } from '../src/shared/config.ts';
import { ROOT } from '../src/shared/paths.ts';
import { reloadConf, Tmux } from '../src/shared/tmux.ts';
import { sleep, tempDir } from './helpers.ts';

// What a selection in a pane leaves in the clipboard, through the copy-command of config/tmux.conf: a real tmux server,
// started without a locale, as the daemon of an app opened from the Finder starts it, and a pbcopy of the test in
// front of the real one, which keeps what it gets. The clipboard of the Mac is not touched.

const temp = tempDir('copy');
const tmuxBin = which('tmux');
const conf = join(ROOT, 'config', 'tmux.conf');
const socket = join(temp.dir, 't.sock');
const tmux = new Tmux(tmuxBin ?? 'tmux', socket, conf);
const copied = join(temp.dir, 'copied');
const locale = join(temp.dir, 'locale');
const NBSP = ' ';

// The screen: a prompt, an answer with code, a result; then what is copied as it is.
const SCREEN = [
  `❯${NBSP}abbiamo qualcosa, perché è così?`,
  '  una seconda riga',
  '',
  '⏺ Risposta: “tutto” ok',
  '  e continua',
  '',
  '    if (x) {',
  '      return 1;',
  '    }',
  `  ⎿ ${NBSP}un${NBSP}risultato`,
  '     del comando',
  '    npm test -- "è" # 100%',
  '  │ a │ b │',
];

const t = (...args: string[]): string => execFileSync(tmuxBin!, ['-S', socket, ...args], { encoding: 'utf8' });

/** Selects from a line of the screen to another, whole, and copies: what pbcopy got. */
async function copy(from: number, to: number): Promise<string> {
  rmSync(copied, { force: true });
  t('copy-mode', '-t', 'copy');
  t('send-keys', '-t', 'copy', '-X', 'top-line');
  if (from > 0) t('send-keys', '-t', 'copy', '-X', '-N', String(from), 'cursor-down');
  t('send-keys', '-t', 'copy', '-X', 'start-of-line');
  t('send-keys', '-t', 'copy', '-X', 'begin-selection');
  if (to > from) t('send-keys', '-t', 'copy', '-X', '-N', String(to - from), 'cursor-down');
  t('send-keys', '-t', 'copy', '-X', 'end-of-line');
  t('send-keys', '-t', 'copy', '-X', 'copy-pipe-and-cancel');
  for (let waited = 0; !existsSync(copied) && waited < 8000; waited += 50) await sleep(50);
  return readFileSync(copied, 'utf8');
}

describe.skipIf(!tmuxBin)('the clipboard', () => {
  beforeAll(async () => {
    const bin = join(temp.dir, 'bin');
    mkdirSync(bin);
    // Written aside, then moved in place: the test never reads half of it.
    writeFileSync(join(bin, 'pbcopy'), `#!/bin/sh\necho "$LC_ALL" > '${locale}'\ncat > '${copied}.part' && mv '${copied}.part' '${copied}'\n`);
    chmodSync(join(bin, 'pbcopy'), 0o755);
    writeFileSync(join(temp.dir, 'screen'), `${SCREEN.join('\n')}\n`);
    // Its program ends by itself, and the server with it.
    execFileSync(tmuxBin!, ['-u', '-S', socket, '-f', conf, 'new-session', '-d', '-s', 'copy', '-x', '90', '-y', '30', '--', '/bin/sh', '-c', `cat '${join(temp.dir, 'screen')}'; sleep 40`], {
      env: { HOME: process.env.HOME, TERM: 'xterm-256color', PATH: `${bin}:/usr/bin:/bin` },
    });
    await sleep(600);
  });

  afterAll(() => temp.cleanup());

  it('gets your message without its sign, in UTF-8 and with plain spaces', async () => {
    expect(await copy(0, 0)).toBe('abbiamo qualcosa, perché è così?');
    expect(readFileSync(locale, 'utf8').trim()).toBe('en_US.UTF-8');
    expect(await copy(0, 1)).toBe('abbiamo qualcosa, perché è così?\nuna seconda riga');
  }, 20_000);

  it('gets an answer without its signs and their margin, the code still indented', async () => {
    expect(await copy(3, 8)).toBe('Risposta: “tutto” ok\ne continua\n\n  if (x) {\n    return 1;\n  }');
    expect(await copy(9, 10)).toBe('un risultato\ndel comando');
  }, 20_000);

  it('gets a line without a sign as it is', async () => {
    expect(await copy(11, 11)).toBe('    npm test -- "è" # 100%');
    expect(await copy(6, 8)).toBe('    if (x) {\n      return 1;\n    }');
    expect(await copy(12, 12)).toBe('  │ a │ b │');
  }, 20_000);

  it('a server that was already running reads the configuration again; none is started for it', async () => {
    t('set-option', '-s', 'copy-command', 'pbcopy');
    expect(t('show-options', '-sv', 'copy-command').trim()).toBe('pbcopy');
    expect(await reloadConf(tmux)).toBe(true);
    expect(t('show-options', '-sv', 'copy-command')).toContain('LC_ALL=en_US.UTF-8 pbcopy');

    const none = join(temp.dir, 'none.sock');
    expect(await reloadConf(new Tmux(tmuxBin!, none, conf))).toBe(false);
    expect(existsSync(none)).toBe(false);
  });
});
