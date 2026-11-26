import { describe, expect, it } from 'vitest';
import { Tmux, TMUX_ALLOWED, TmuxRefused, tmuxSessionName } from '../src/shared/tmux.ts';

const tmux = new Tmux('/usr/local/bin/tmux', '/x/var/tmux.sock', '/x/config/tmux.conf');

describe('tmux', () => {
  it('always uses the private socket and configuration', () => {
    expect(tmux.argv('list-panes', ['-a'])).toEqual(['-u', '-S', '/x/var/tmux.sock', '-f', '/x/config/tmux.conf', 'list-panes', '-a']);
  });

  it('has no command that ends a session, a window, a pane or the server', () => {
    for (const command of TMUX_ALLOWED) expect(command).not.toMatch(/^(kill|unlink|respawn|detach|destroy)/);
    for (const command of ['kill-session', 'kill-server', 'kill-pane', 'kill-window', 'respawn-pane', 'run-shell', 'source-file', 'set-option', 'if-shell']) {
      expect(() => tmux.argv(command, [])).toThrow(TmuxRefused);
    }
  });

  it('reads its own configuration again, and no other file', () => {
    expect(tmux.argv('source-file', ['/x/config/tmux.conf']).slice(-2)).toEqual(['source-file', '/x/config/tmux.conf']);
    for (const args of [[], ['/tmp/other.conf'], ['-n', '/x/config/tmux.conf'], ['/x/config/tmux.conf', '/tmp/other.conf']]) expect(() => tmux.argv('source-file', args)).toThrow(TmuxRefused);
  });

  it('refuses arguments that would chain a second command', () => {
    expect(() => tmux.argv('send-keys', ['-t', '%1', ';', 'kill-server'])).toThrow(TmuxRefused);
    expect(() => tmux.argv('send-keys', ['-t', '%1', 'echo;'])).toThrow(TmuxRefused);
    expect(() => tmux.argv('send-keys', ['-t', '%1', '-l', 'a ; b'])).not.toThrow();
  });

  it('names sessions after the agent', () => {
    expect(tmuxSessionName('3f2b8c1e-1111-4222-8333-444455556666')).toBe('fk-3f2b8c1e');
  });
});
