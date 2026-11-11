import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/daemon/registry.ts';
import { claudeArgs, folderOf, spawnSession, startCommand } from '../src/daemon/spawn.ts';
import { which } from '../src/shared/config.ts';
import { paths, ROOT } from '../src/shared/paths.ts';
import { Tmux } from '../src/shared/tmux.ts';
import { recentFolders } from '../src/ui/NewSession.tsx';
import { newAgent } from '../src/daemon/state.ts';
import { sleep, tempDir } from './helpers.ts';

// A new session from the app: the folder, the first prompt, and the chain of the pane up to claude.

const temp = tempDir('spawn');
afterAll(() => temp.cleanup());

describe('the folder', () => {
  it('takes ~ and full paths, nothing relative', () => {
    expect(folderOf('~')).toBe(homedir());
    expect(folderOf('  ~/progetti/app/ ')).toBe(join(homedir(), 'progetti/app'));
    expect(folderOf('/tmp/../tmp/x')).toBe('/tmp/x');
    expect(folderOf('progetti/app')).toBeUndefined();
    expect(folderOf('   ')).toBeUndefined();
  });

  it('the panel offers the folders of the sessions known, the most recent first, once each', () => {
    const agent = (id: string, cwd: string, at: number) => ({ ...newAgent({ id, cwd, control: { kind: 'readonly', reason: 'fuori-tmux' } }, 0), lastEvent: { name: 'x', at } });
    expect(recentFolders([agent('a', '/p/uno', 1), agent('b', '/p/due', 3), agent('c', '/p/uno', 2)])).toEqual(['/p/due', '/p/uno']);
  });
});

describe('the command of the pane', () => {
  it('is the login shell, then forchetta-start, then claude', () => {
    expect(startCommand('/bin/zsh', '/F/bin/forchetta-start', '/u/.local/bin/claude')).toEqual(['/bin/zsh', '-l', '-i', '-c', "exec '/F/bin/forchetta-start' '/u/.local/bin/claude'"]);
    expect(startCommand('/bin/zsh', '/F/bin/forchetta-start', '/c', ['--model', 'haiku'])).toEqual(['/bin/zsh', '-l', '-i', '-c', "exec '/F/bin/forchetta-start' '/c' '--model' 'haiku'"]);
    expect(startCommand('/bin/zsh', "/F'x/bin/forchetta-start", '/c')).toBeUndefined();
    expect(startCommand('/bin/zsh', '/F/bin/forchetta-start', '/c', ["x'; rm -rf ~"])).toBeUndefined();
  });

  it('model, mode and worktree come from closed lists or a checked name', () => {
    expect(claudeArgs({})).toEqual({ args: [] });
    expect(claudeArgs({ model: 'haiku', mode: 'acceptEdits', worktree: 'prova-1' })).toEqual({ args: ['--model', 'haiku', '--permission-mode', 'acceptEdits', '--worktree', 'prova-1'] });
    expect(claudeArgs({ worktree: true })).toEqual({ args: ['--worktree'] });
    expect(claudeArgs({ model: 'gpt' })).toHaveProperty('error');
    expect(claudeArgs({ mode: 'bypassPermissions' })).toHaveProperty('error');
    expect(claudeArgs({ worktree: '../fuori' })).toHaveProperty('error');
  });
});

describe('spawnSession', () => {
  const tmux = new Tmux(which('tmux') ?? 'tmux', join(temp.dir, 'tmux.sock'), join(ROOT, 'config', 'tmux.conf'));
  const log = () => {};

  it('a worktree needs a folder in a git repository', async () => {
    const registry = new Registry();
    const plain = join(temp.dir, 'senza-git');
    mkdirSync(plain, { recursive: true });
    expect(await spawnSession({ tmux, registry, claude: '/c', log }, { cwd: plain, worktree: true })).toMatchObject({ ok: false, error: expect.stringContaining('repo git') });
    registry.dispose();
  });

  it('refuses a folder that is not there, a file, a missing claude, a prompt too long', async () => {
    const registry = new Registry();
    const file = join(temp.dir, 'file.txt');
    writeFileSync(file, 'x');
    expect(await spawnSession({ tmux, registry, claude: '/c', log }, { cwd: join(temp.dir, 'non-c-e') })).toMatchObject({ ok: false, error: expect.stringContaining('non esiste') });
    expect(await spawnSession({ tmux, registry, claude: '/c', log }, { cwd: file })).toMatchObject({ ok: false, error: expect.stringContaining('non è una cartella') });
    expect(await spawnSession({ tmux, registry, claude: '/c', log }, { cwd: 'relativa' })).toMatchObject({ ok: false });
    expect(await spawnSession({ tmux, registry, claude: undefined, log }, { cwd: temp.dir })).toMatchObject({ ok: false });
    expect(await spawnSession({ tmux, registry, claude: '/c', log }, { cwd: temp.dir, prompt: 'x'.repeat(20_001) })).toMatchObject({ ok: false });
    expect(registry.agents.size).toBe(0);
    registry.dispose();
  });

  it('starts claude in the folder, in tmux, with the first prompt as one argument, whatever it holds', async () => {
    const home = join(temp.dir, 'home');
    const work = join(temp.dir, 'progetto');
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    const out = join(temp.dir, 'argomenti.txt');
    // The fake claude writes what it got: the number of arguments, each one, the folder, the prompt variable.
    const fake = join(temp.dir, 'claude-finto');
    writeFileSync(
      fake,
      `#!/bin/sh\n{ printf '%s\\n' "$#"; for a in "$@"; do printf '[%s]\\n' "$a"; done; pwd; printf 'variabile:%s\\n' "\${FORCHETTA_PROMPT-assente}"; printf 'agente:%s\\n' "$FORCHETTA_AGENT"; } > '${out}'\nsleep 1\n`,
      { mode: 0o755 },
    );
    const registry = new Registry();
    const prompt = `fai "questo"; poi $(rm -rf /) e 'quello'\nseconda riga;`;
    mkdirSync(join(work, '.git'), { recursive: true });
    const result = await spawnSession({ tmux, registry, claude: fake, log, shell: '/bin/bash', env: { PATH: '/usr/bin:/bin', HOME: home }, watchMs: 400 }, { cwd: work, prompt: `-${prompt}`, model: 'haiku', worktree: true });
    expect(result.ok).toBe(true);
    const agentId = (result as { agentId: string }).agentId;
    expect(registry.agents.get(agentId)).toMatchObject({ cwd: work, control: { kind: 'tmux' } });
    for (let round = 0; round < 50; round++) {
      try {
        if (readFileSync(out, 'utf8').includes('agente:')) break;
      } catch {
        // Not yet.
      }
      await sleep(100);
    }
    const lines = readFileSync(out, 'utf8').trimEnd().split('\n');
    // The options first, then "--", then the prompt as one argument, even when it starts with "-".
    expect(lines[0]).toBe('5');
    expect(lines.slice(1, 5)).toEqual(['[--model]', '[haiku]', '[--worktree]', '[--]']);
    expect(lines.slice(5, 7).join('\n')).toBe(`[-${prompt}]`);
    expect(lines.slice(7)).toEqual([work, 'variabile:assente', `agente:${agentId}`]);
    // The env file with the prompt in it is gone before claude starts.
    expect(existsSync(join(paths.runDir, `${agentId}.env`))).toBe(false);
    registry.dispose();
  });

  it('a claude that ends at once is reported, with the hint for a worktree', async () => {
    const quick = join(temp.dir, 'claude-esce');
    writeFileSync(quick, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    mkdirSync(join(temp.dir, 'repo', '.git'), { recursive: true });
    const registry = new Registry();
    const result = await spawnSession(
      { tmux, registry, claude: quick, log, shell: '/bin/bash', env: { PATH: '/usr/bin:/bin', HOME: join(temp.dir, 'home') }, watchMs: 3000 },
      { cwd: join(temp.dir, 'repo'), worktree: true },
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('fidata') });
    registry.dispose();
  });

  it('with no prompt, claude gets no argument', async () => {
    const out = join(temp.dir, 'senza.txt');
    const fake = join(temp.dir, 'claude-senza');
    writeFileSync(fake, `#!/bin/sh\nprintf '%s' "$#" > '${out}'\nsleep 1\n`, { mode: 0o755 });
    const registry = new Registry();
    const result = await spawnSession({ tmux, registry, claude: fake, log, shell: '/bin/bash', env: { PATH: '/usr/bin:/bin', HOME: join(temp.dir, 'home') }, watchMs: 400 }, { cwd: temp.dir, prompt: '   ' });
    expect(result.ok).toBe(true);
    for (let round = 0; round < 50; round++) {
      try {
        if (readFileSync(out, 'utf8') !== '') break;
      } catch {
        // Not yet.
      }
      await sleep(100);
    }
    expect(readFileSync(out, 'utf8')).toBe('0');
    registry.dispose();
  });

});
