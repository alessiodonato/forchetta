import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostEnv, paneEnv } from '../src/cli/pane-env.ts';
import { Prefix } from '../src/cli/attach.ts';
import { openerOf, windowsBrowsers } from '../src/cli/open.ts';
import { windowsName, windowsSteps } from '../src/cli/setup-windows.ts';
import { Guard } from '../src/daemon/guard.ts';
import { isShellTool, powershellAsShell, shellLine } from '../src/daemon/powershell.ts';
import { isInteractiveCommand } from '../src/daemon/process.ts';
import { Registry } from '../src/daemon/registry.ts';
import { createDaemonServer, type DaemonServer, hookMeta } from '../src/daemon/server.ts';
import { killTargets, placedCommands, shellWrites } from '../src/daemon/shell.ts';
import { claudeStart } from '../src/daemon/spawn.ts';
import { LIST_ARGS, matchingProcesses, namesFolder, parseNetstat, parseProcesses, windowsLook } from '../src/daemon/windows-processes.ts';
import { ofWindows, windowsPayload } from '../src/daemon/windows-payload.ts';
import { isFullPath, projectOf } from '../src/shared/agent.ts';
import { fromGitBash, realWindowsPath, slashes } from '../src/shared/fspath.ts';
import { pathsFor, ROOT } from '../src/shared/paths.ts';
import { acceptPipe, newPipe, parsePipe, type PipeInfo } from '../src/shared/pipe.ts';
import { GUARD_MATCHER, isOurHook, isOurStatusLine, windowsStatusCommand, WINDOWS_GUARD_MATCHER, withForchettaHooks, withForchettaStatusLine, withoutForchettaHooks, withoutForchettaStatusLine } from '../src/shared/settings.ts';
import { findExe, gitBash, windowsClaude, windowsGit } from '../src/shared/windows.ts';
import { folderText } from '../src/shared/present.ts';
import { placeText } from '../src/ui/platform.ts';
import { sleep, tempDir } from './helpers.ts';

// Forchetta on Windows, with no WSL: what does not need Windows to be tried. The hosts of the sessions are in host.test.ts.

const temp = tempDir('windows');
afterAll(() => temp.cleanup());
const WINDOWS = process.platform === 'win32';

describe('the paths of Windows', () => {
  it('are written with forward slashes, and an upper case drive', () => {
    expect(slashes('C:\\Users\\me\\shop')).toBe('C:/Users/me/shop');
    expect(slashes('c:/code')).toBe('C:/code');
    expect(slashes('\\\\server\\share\\x')).toBe('//server/share/x');
    expect(slashes('\\\\?\\C:\\long')).toBe('C:/long');
    expect(slashes('\\\\?\\UNC\\server\\share')).toBe('//server/share');
  });

  it('also as Git Bash has them', () => {
    expect(fromGitBash('/c/Users/me')).toBe('C:/Users/me');
    expect(fromGitBash('/cygdrive/d/x')).toBe('D:/x');
    expect(fromGitBash('/c')).toBe('C:/');
    expect(fromGitBash('/code/x')).toBe('/code/x');
    expect(fromGitBash('src/c/x')).toBe('src/c/x');
  });

  it('are those of the disk: the case, no short names, also of a file not there yet', () => {
    const disk: Record<string, string> = { 'c:/users/runner~1/shop': 'C:\\Users\\runneradmin\\shop', 'c:/users/runner~1/shop/src': 'C:\\Users\\runneradmin\\shop\\src', 'c:/users/runner~1/shop/src/app.ts': 'C:\\Users\\runneradmin\\shop\\src\\App.ts', 'z:/code': '\\\\server\\share\\code' };
    const real = (path: string): string => {
      const found = disk[path.toLowerCase()];
      if (!found) throw new Error('ENOENT');
      return found;
    };
    expect(realWindowsPath('c:\\USERS\\RUNNER~1\\shop\\SRC\\app.ts', real)).toBe('C:/Users/runneradmin/shop/src/App.ts');
    expect(realWindowsPath('C:/Users/runner~1/shop/src/new/Deep.ts', real)).toBe('C:/Users/runneradmin/shop/src/new/Deep.ts');
    // A network drive stays the drive the session uses.
    expect(realWindowsPath('Z:\\code', real)).toBe('Z:/code');
    expect(realWindowsPath('Q:\\nothing\\here', real)).toBe('Q:/nothing/here');
  });

  it('tell a full path, its project and its short form', () => {
    for (const path of ['/Users/me', 'C:/Users/me', '//server/share/x']) expect(isFullPath(path), path).toBe(true);
    for (const path of ['src/a.ts', 'C:', 'c', '~/x']) expect(isFullPath(path), path).toBe(false);
    expect(projectOf('C:/Users/me/shop')).toBe('shop');
    expect(folderText('C:/Users/me/code/shop')).toBe('~/code/shop');
    expect(folderText('/Users/me/code/shop')).toBe('~/code/shop');
  });

  it('a hook has them all as Forchetta keeps them', () => {
    const real = (path: string): string => slashes(path).replace('RUNNER~1', 'runneradmin');
    const payload = windowsPayload(
      { hook_event_name: 'PostToolUse', session_id: 's', cwd: 'c:\\Users\\RUNNER~1\\shop', transcript_path: 'C:\\Users\\me\\.claude\\projects\\x\\s.jsonl', tool_name: 'Edit', tool_input: { file_path: 'C:\\Users\\RUNNER~1\\shop\\src\\a.ts', old_string: 'a\\b' }, tool_response: { filePath: 'C:\\Users\\RUNNER~1\\shop\\src\\a.ts', type: 'update' } },
      real,
    );
    expect(payload).toMatchObject({ cwd: 'C:/Users/runneradmin/shop', transcript_path: 'C:/Users/me/.claude/projects/x/s.jsonl', tool_input: { file_path: 'C:/Users/runneradmin/shop/src/a.ts', old_string: 'a\\b' }, tool_response: { filePath: 'C:/Users/runneradmin/shop/src/a.ts', type: 'update' } });
    expect(ofWindows('src\\a.ts', real)).toBe('src/a.ts');
    expect(ofWindows('/c/Users/me/a.ts', real)).toBe('C:/Users/me/a.ts');
  });

  it('where Forchetta keeps the pipe of the hooks', () => {
    expect(pathsFor('C:/Users/me/.local/share/forchetta', 'C:/f', true).hooksSocket).toContain('hooks-pipe.json');
    expect(pathsFor('/x/var', '/x', false).hooksSocket).toBe(join('/x/var', 'hooks.sock').replaceAll('\\', '/'));
  });
});

describe('a line of PowerShell, as a POSIX shell has it', () => {
  it.each([
    ["Set-Content -Path src\\a.ts -Value 'x'", 'tee src/a.ts'],
    ["Set-Content src\\a.ts 'x' -Encoding UTF8", 'tee src/a.ts'],
    ['Set-Content -LiteralPath:a.txt -Value:x', 'tee a.txt'],
    ["'hi' | Out-File -FilePath .\\out.txt -Append", 'hi | tee ./out.txt'],
    ["echo hi >> 'my file.txt'", "echo hi > 'my file.txt'"],
    ['npm test 2>&1 | Tee-Object -FilePath log.txt', 'npm test | tee log.txt'],
    ['npm run build *> build.log', 'npm run build > build.log'],
    ["(Get-Content src\\a.ts) -replace 'x','y' | Set-Content src\\a.ts", 'Get-Content src/a.ts; -replace x y | tee src/a.ts'],
    ['Remove-Item -Recurse -Force node_modules, dist', 'rm -r node_modules dist'],
    ['del a.txt', 'rm -r a.txt'],
    ['Get-ChildItem build -Filter *.js | Remove-Item -Force', 'Get-ChildItem build -Filter \'*.js\' | rm -r build'],
    ['cp -Path a.txt -Destination sub\\b.txt', 'cp a.txt sub/b.txt'],
    ['Move-Item a.txt b.txt', 'mv a.txt b.txt'],
    ['Rename-Item src\\a.ts b.ts', 'mv src/a.ts src/b.ts'],
    ['cd src; git checkout main', 'cd src; git checkout main'],
    ["Set-Location -Path 'C:\\My Proj'; git stash", "cd 'C:/My Proj'; git stash"],
    ["[System.IO.File]::WriteAllText('src\\a.ts', $text)", 'tee src/a.ts'],
    ['[IO.File]::WriteAllText("$PWD\\a.ts", "x"); git status', 'tee ./a.ts; git status'],
    ["[IO.File]::Delete('a.txt')", 'rm -r a.txt'],
    ['$x = Get-Content a; Set-Content b.txt $x', 'Get-Content a; tee b.txt'],
    ['$x=git status', 'git status'],
    ['if (Test-Path a.txt) { Remove-Item a.txt }', 'Test-Path a.txt; rm -r a.txt'],
    ['Stop-Process -Id 1234, 5678 -Force', 'kill 1234 5678'],
    ['Stop-Process -Name node', 'killall node'],
    ['taskkill /PID 1234 /F /T', 'kill 1234'],
    ['taskkill /IM node.exe /F', 'killall node.exe'],
    ["& 'C:\\Program Files\\Git\\cmd\\git.exe' reset --hard", "'C:/Program Files/Git/cmd/git' reset --hard"],
    ['git add -A; git commit -m "it\'s a test; really"', "git add -A; git commit -m 'it'\\''s a test; really'"],
    ["@'\nhello > not\n'@ | Set-Content x.md", "'hello > not' | tee x.md"],
    ['Invoke-WebRequest https://x.y -OutFile z.zip', 'tee z.zip'],
    ['curl.exe -sO https://x.y/z', 'curl -sO https://x.y/z'],
    ['New-Item -ItemType File -Path src\\n.ts -Force', 'tee src/n.ts'],
    ['New-Item -ItemType Directory src\\n', 'true'],
    ['# a comment > x\nnpm run dev', 'npm run dev'],
    ['python script.py `\n  --out x', 'python script.py --out x'],
    ['git checkout main && npm i', 'git checkout main && npm i'],
    ['npm.cmd run dev', 'npm run dev'],
    ["echo 'unclosed", ''],
    ["@'\nunclosed", ''],
  ])('%s', (line, expected) => {
    expect(powershellAsShell(line)).toBe(expected);
  });

  it('says which files it writes, and what it stops', () => {
    const writes = (line: string): string[] => shellWrites(powershellAsShell(line), '/w').map((write) => `${write.path}${write.tree ? '/' : ''}`);
    expect(writes('dir > $null')).toEqual([]);
    expect(writes('Set-Content $file x')).toEqual([]);
    expect(writes("Get-Content a | Set-Content 'b c.txt'; Remove-Item d")).toEqual(['/w/b c.txt', '/w/d/']);
    expect(writes('Set-Location sub; "x" > a.ts')).toEqual(['/w/sub/a.ts']);
    expect(writes('npx prettier --write src')).toEqual(['/w/src/']);
    expect(killTargets(powershellAsShell('Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess -Force'))).toEqual({ pids: [], patterns: [], ports: [3000] });
    expect(killTargets('taskkill //PID 12 //F')).toEqual({ pids: [12], patterns: [], ports: [] });
    expect(placedCommands(powershellAsShell('cd web; npm run dev'), '/w')).toEqual([{ words: ['npm', 'run', 'dev'], dir: '/w/web' }]);
  });

  it('is read only for the tools that run commands', () => {
    expect(shellLine({ tool_name: 'PowerShell', tool_input: { command: 'del a' } })).toBe('rm -r a');
    expect(shellLine({ tool_name: 'Bash', tool_input: { command: 'del a' } })).toBe('del a');
    expect(shellLine({ tool_name: 'Edit', tool_input: { command: 'del a' } })).toBeUndefined();
    expect(shellLine({ tool_name: 'PowerShell', tool_input: {} })).toBeUndefined();
    expect(['Bash', 'PowerShell', 'Read', undefined].map(isShellTool)).toEqual([true, true, false, false]);
  });

  it('does not take long on a long line', () => {
    const started = Date.now();
    powershellAsShell(`${'Set-Content a.txt x; '.repeat(3000)}${'('.repeat(2000)}`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('the guard, with a command of PowerShell', () => {
  const agents = ['a', 'b'].map((id) => ({ id, state: 'working', cwd: '/w', project: 'w', name: id, control: { kind: 'readonly', reason: 'fuori-tmux' } }) as never);
  const guard = new Guard({ agents: () => agents, repoOf: () => '/w', writesOf: () => [], enabled: () => ({ files: true, git: true, notes: false }), touch: () => {} });
  const call = (command: string, tool = 'PowerShell') => ({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/w', tool_name: tool, tool_input: { command }, tool_use_id: randomUUID() });

  it('stops one that writes the file another session is changing', () => {
    guard.wrote(agents[0]!, '/w/src/a.ts');
    for (const line of ['Set-Content src\\a.ts x', '"x" > src\\a.ts', 'Remove-Item src -Recurse', 'Move-Item src\\a.ts old.ts', "[IO.File]::AppendAllText('src/a.ts', 'x')"]) expect(guard.decide(agents[1]!, call(line))?.decision, line).toBe('deny');
    expect(guard.decide(agents[1]!, call('Get-Content src\\a.ts'))).toBeUndefined();
    expect(guard.decide(agents[0]!, call('Set-Content src\\a.ts x'))).toBeUndefined();
  });
});

describe('the settings of Claude Code on Windows', () => {
  const targets = { port: 47821, hookScript: '/x/forchetta-hook', permissionScript: '/x/forchetta-permission', guardScript: '/x/forchetta-guard', windows: { node: 'C:/Program Files/nodejs/node.exe', hookJs: 'C:/Users/Ada Lovelace/.local/lib/forchetta/dist/windows/forchetta-hooks.js' } };

  it('start the program of the hooks with no shell, and take the hooks away', () => {
    const { settings, changes } = withForchettaHooks({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }, targets);
    const hooks = settings.hooks as Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
    expect(hooks.PreToolUse![0]).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] });
    expect(hooks.PreToolUse!.at(-1)).toEqual({ matcher: WINDOWS_GUARD_MATCHER, hooks: [{ type: 'command', command: targets.windows.node, args: [targets.windows.hookJs, 'guard', '47821'], timeout: 6 }] });
    expect(hooks.PermissionRequest![0]!.hooks[0]).toMatchObject({ args: [targets.windows.hookJs, 'permission', '47821'], timeout: 3600 });
    expect(hooks.Stop![0]!.hooks[0]).toEqual({ type: 'command', command: targets.windows.node, args: [targets.windows.hookJs, 'hook', '47821'], async: true });
    expect(changes.join('\n')).toContain('forchetta-hooks.js guard 47821');
    // Again: nothing to change. And away.
    expect(withForchettaHooks(settings, targets).changes).toEqual([]);
    expect(withoutForchettaHooks(settings).settings).toEqual({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } });
    // Of another folder or another node: replaced, not added.
    const moved = withForchettaHooks(settings, { ...targets, windows: { node: 'D:/node.exe', hookJs: 'D:/f/dist/windows/forchetta-hooks.js' } });
    expect(moved.changes.every((change) => change.startsWith('~'))).toBe(true);
  });

  it('the guard is before PowerShell too, only there', () => {
    expect(new RegExp(WINDOWS_GUARD_MATCHER).test('PowerShell')).toBe(true);
    expect(new RegExp(GUARD_MATCHER).test('PowerShell')).toBe(false);
    expect(isOurHook({ type: 'command', command: 'node', args: ['C:/x/forchetta-hooks.js', 'status', '1'] })).toBe(false);
    expect(isOurHook({ type: 'command', command: 'node', args: ['C:/x/other.js', 'guard', '1'] })).toBe(false);
  });

  it('the status line is quoted by no shell', () => {
    const plain = { port: 47821, node: 'C:/nodejs/node.exe', hookJs: 'C:/Users/ada/f/forchetta-hooks.js' };
    expect(windowsStatusCommand(plain, false)).toBe('C:/nodejs/node.exe C:/Users/ada/f/forchetta-hooks.js status 47821');
    expect(windowsStatusCommand({ ...plain, node: targets.windows.node }, true)).toBe('forchetta-statusline.cmd 47821');
    expect(windowsStatusCommand({ ...plain, node: targets.windows.node }, false)).toBeUndefined();
    for (const command of ['C:/nodejs/node.exe C:/Users/ada/f/forchetta-hooks.js status 47821', 'forchetta-statusline.cmd 47821', '/x/bin/forchetta-statusline 47821']) expect(isOurStatusLine({ type: 'command', command }), command).toBe(true);
    expect(isOurStatusLine({ type: 'command', command: 'mine' })).toBe(false);
    const plan = withForchettaStatusLine({ statusLine: { type: 'command', command: 'mine', padding: 1 } }, { port: 1, statusScript: '/x', command: 'forchetta-statusline.cmd 47821' });
    expect(plan).toMatchObject({ original: 'mine', settings: { statusLine: { command: 'forchetta-statusline.cmd 47821', padding: 1 } } });
    expect(withoutForchettaStatusLine(plan.settings, 'mine').settings).toEqual({ statusLine: { type: 'command', command: 'mine', padding: 1 } });
  });
});

describe('a session on Windows', () => {
  it('claude gets as arguments what elsewhere forchetta-start gives it', () => {
    expect(
      claudeStart(['--model', 'opus'], {
        PATH: 'p',
        FORCHETTA_PROMPT: '-fix it',
        FORCHETTA_SYSTEM_PROMPT: 'You are "the reviewer"\nof a team',
        FORCHETTA_NAME: 'reviewer',
        FORCHETTA_PLUGIN_DIR: 'C:/p',
        FORCHETTA_MCP_CONFIG: 'C:/m.json',
        FORCHETTA_STRICT_MCP: '1',
        FORCHETTA_ALLOWED_TOOLS: 'mcp__forchetta\nmcp__docs',
        FORCHETTA_DISALLOWED_TOOLS: 'Bash(git push:*)\nEdit\nBashOutput',
      }),
    ).toEqual({
      env: { PATH: 'p' },
      args: ['--model', 'opus', '--append-system-prompt', 'You are "the reviewer"\nof a team', '--name', 'reviewer', '--plugin-dir', 'C:/p', '--mcp-config', 'C:/m.json', '--strict-mcp-config', '--allowedTools', 'mcp__forchetta', 'mcp__docs', '--disallowedTools', 'Bash(git push:*)', 'PowerShell(git push:*)', 'Edit', 'BashOutput', '--', '-fix it'],
    });
    expect(claudeStart([], { A: '1' })).toEqual({ args: [], env: { A: '1' } });
  });

  it('its environment keeps the names of Windows, and says what terminal it is', () => {
    const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', '=C:': 'C:\\x', Path: 'p', WT_SESSION: 'w', CLAUDE_PID: '1', TERM_PROGRAM: 'vscode', FORCHETTA_PANE: 'fk-00000000' };
    const pane = paneEnv(env, 'agent', true);
    expect(pane).toEqual({ 'ProgramFiles(x86)': 'C:\\Program Files (x86)', Path: 'p', FORCHETTA_AGENT: 'agent' });
    expect(hostEnv(pane, 'fk-12345678')).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCHETTA_PANE: 'fk-12345678' });
    expect(paneEnv(env, 'agent', false)).not.toHaveProperty('ProgramFiles(x86)');
  });

  it('Ctrl-b d leaves it, as in tmux', () => {
    const prefix = new Prefix();
    expect(prefix.push('abc')).toEqual({ send: 'abc', leave: false });
    expect(prefix.push('\u0002')).toEqual({ send: '', leave: false });
    expect(prefix.push('d')).toEqual({ send: '', leave: true });
    expect(prefix.push('\u0002\u0002x')).toEqual({ send: '\u0002x', leave: false });
    expect(prefix.push('\u0002q')).toEqual({ send: '\u0002q', leave: false });
  });

  it('a hook names its session as the pane', () => {
    expect(hookMeta({ 'x-forchetta-pane': 'fk-12ab34cd' }).pane).toBe('fk-12ab34cd');
    expect(hookMeta({ 'x-forchetta-pane': '%3' }).pane).toBe('%3');
    expect(hookMeta({ 'x-forchetta-pane': 'fk-../../x' }).pane).toBeUndefined();
  });

  it('claude with a quoted path is told interactive or not', () => {
    expect(isInteractiveCommand('"C:\\Users\\Ada -p Lovelace\\.local\\bin\\claude.exe" --model opus')).toBe(true);
    expect(isInteractiveCommand('"C:\\x y\\claude.exe" -p hello')).toBe(false);
    expect(isInteractiveCommand('C:\\x\\claude.exe')).toBe(true);
  });

  it('the page says Forchetta, where there is no tmux', () => {
    expect(placeText('It starts in the tmux of Forchetta, and opens here.', 'windows')).toBe('It starts in Forchetta, and opens here.');
    expect(placeText('Outside the tmux of Forchetta: read only.', 'windows')).toBe('Not started by Forchetta: read only.');
    expect(placeText('Outside the tmux of Forchetta: read only.', 'macos')).toBe('Outside the tmux of Forchetta: read only.');
  });
});

describe('the processes of Windows', () => {
  const netstat = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242
  TCP    [::]:3000              [::]:0                 IN ASCOLTO      4242
  TCP    127.0.0.1:5173         0.0.0.0:0              ABHÖREN         77
  TCP    127.0.0.1:50000        127.0.0.1:3000         ESTABLISHED     99
`;
  const list = ['100|1|1000|claude.exe|"C:\\Users\\me\\.local\\bin\\claude.exe"', '200|100|2000|cmd.exe|C:\\Windows\\system32\\cmd.exe /d /s /c vite', '4242|200|3000|node.exe|"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\Shop\\node_modules\\vite\\bin\\vite.js" | x', '300|4242|500|old.exe|', 'noise'].join('\r\n');

  it('who listens, in any language of Windows', () => {
    expect([...parseNetstat(netstat)]).toEqual([
      [4242, [3000]],
      [77, [5173]],
    ]);
  });

  it('who started whom; a parent younger than its child is another process', () => {
    const rows = parseProcesses(list);
    expect(rows.get(4242)).toMatchObject({ ppid: 200, name: 'node.exe', command: expect.stringContaining('| x') });
    expect(rows.get(300)?.ppid).toBe(0);
    expect(rows.size).toBe(4);
  });

  it('the folder a command line names', () => {
    expect(namesFolder('node.exe C:\\Users\\me\\Shop\\node_modules\\x.js', 'C:/Users/me/shop')).toBe(true);
    expect(namesFolder('node.exe C:\\Users\\me\\shop2\\x.js', 'C:/Users/me/shop')).toBe(false);
    expect(namesFolder('node.exe --root "C:/Users/me/shop"', 'C:/Users/me/shop')).toBe(true);
  });

  it('what a kill by name stops', () => {
    const rows = parseProcesses(list);
    expect(matchingProcesses(['-x', 'node.exe'], rows)).toEqual([4242]);
    expect(matchingProcesses(['-x', 'NODE'], rows)).toEqual([4242]);
    expect(matchingProcesses(['-x', 'no*'], rows)).toEqual([4242]);
    expect(matchingProcesses(['-f', 'vite.js'], rows)).toEqual([4242]);
  });

  it('asks for the list once for a command', async () => {
    const asked: string[] = [];
    const look = windowsLook(async (file, args) => {
      asked.push(args.join(' '));
      return file.endsWith('netstat.exe') ? netstat : list;
    });
    expect((await look.listening()).get(4242)).toEqual([3000]);
    expect([...(await look.folders([4242, 77], 'C:/Users/me/shop', await look.table())).keys()]).toEqual([4242]);
    await look.processes();
    expect(asked.filter((args) => args === LIST_ARGS.join(' '))).toHaveLength(1);
  });
});

describe('the programs of Windows', () => {
  const env = { PATH: ['C:\\bin', 'C:\\npm'].join(WINDOWS ? ';' : ':').replaceAll(WINDOWS ? '' : 'C:', WINDOWS ? '' : '/c'), APPDATA: '/appdata', LOCALAPPDATA: '/local', ProgramFiles: '/pf', 'ProgramFiles(x86)': '/pf86' };
  const has = (...paths: string[]) => (path: string): boolean => paths.includes(path.replaceAll('\\', '/'));

  it('claude.exe, also inside the package of npm', () => {
    expect(windowsClaude({ PATH: '' }, has('/h/.local/bin/claude.exe'), '/h')).toBe('/h/.local/bin/claude.exe');
    expect(windowsClaude({ PATH: '/npm' }, has('/npm/claude.cmd', '/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'), '/h')).toBe('/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
    expect(windowsClaude({ PATH: '' }, has(), '/h')).toBeUndefined();
  });

  it('git, and the bash next to it', () => {
    expect(windowsGit({ ProgramFiles: '/pf', PATH: '' }, has('/pf/Git/cmd/git.exe'))).toBe('/pf/Git/cmd/git.exe');
    expect(gitBash({ ProgramFiles: '/pf', PATH: '' }, has('/pf/Git/cmd/git.exe', '/pf/Git/bin/bash.exe'))).toBe('/pf/Git/bin/bash.exe');
    expect(gitBash({ PATH: '/g/mingw64/bin' }, has('/g/mingw64/bin/git.exe', '/g/bin/bash.exe'))).toBe('/g/bin/bash.exe');
    expect(gitBash({ PATH: '', CLAUDE_CODE_GIT_BASH_PATH: '/mine/bash.exe' }, has('/mine/bash.exe'))).toBe('/mine/bash.exe');
    expect(gitBash({ PATH: '' }, has())).toBeUndefined();
    expect(findExe('gh', [], env, has('/c/nothing'))).toBeUndefined();
  });

  it('the window: Edge first, with a profile of its own and no extensions', () => {
    expect(windowsBrowsers({ 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' })[0]).toBe('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
    const edge = windowsBrowsers()[0];
    const opener = openerOf('http://127.0.0.1:47821/#open=x', 'windows', (path) => path === edge, () => undefined, () => 'C:\\p');
    if (edge) expect(opener).toEqual({ file: edge, args: ['--app=http://127.0.0.1:47821/#open=x', '--user-data-dir=C:\\p', '--disable-extensions', '--no-first-run', '--no-default-browser-check'], own: true });
    expect(openerOf('u', 'windows', () => false)).toMatchObject({ args: ['url.dll,FileProtocolHandler', 'u'], own: false });
  });

  it('what setup says', () => {
    expect(windowsName('10.0.22631')).toBe('Windows 11 (10.0.22631)');
    expect(windowsName('10.0.19045')).toBe('Windows 10 (10.0.19045)');
    expect(windowsSteps({ release: '10.0.17134', node: '22.1.0' })).toMatchObject({ error: expect.stringContaining('too old') });
    expect(windowsSteps({ release: '10.0.22631', node: '20.1.0' })).toMatchObject({ error: expect.stringContaining('Node.js') });
    const all = windowsSteps({ release: '10.0.22631', node: '22.1.0', claude: 'C:/c.exe', git: 'C:/g.exe', bash: 'C:/b.exe' });
    expect(all.steps.every((step) => step.mark === '✓')).toBe(true);
    const none = windowsSteps({ release: '10.0.22631', node: '22.1.0', pty: 'blocked by policy' });
    expect(none).not.toHaveProperty('error');
    expect(none.steps.filter((step) => step.mark === '▲').map((step) => step.label)).toEqual(['Terminals', 'claude', 'git']);
  });
});

describe('the program of the hooks', () => {
  const hookJs = join(temp.dir, 'forchetta-hooks.js');
  const varDir = join(temp.dir, 'var');
  const socketFile = join(varDir, WINDOWS ? 'hooks-pipe.json' : 'hooks.sock');
  const info: PipeInfo = newPipe('hooks', WINDOWS ? undefined : join(realpathSync(tmpdir()), `fk-${randomUUID().slice(0, 8)}.sock`));
  let server: DaemonServer;
  let pipe: Server;
  const registry = new Registry({ settleMs: 5 });
  let decision: object | undefined;
  const opened: string[] = [];

  beforeAll(async () => {
    mkdirSync(varDir, { recursive: true });
    await build({ entryPoints: [join(ROOT, 'src', 'hook', 'main.ts')], outfile: hookJs, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'error' });
    server = createDaemonServer({
      registry,
      token: 'a'.repeat(64),
      port: () => 0,
      log: () => {},
      info: () => ({}),
      onShutdown: () => {},
      guard: () => decision,
      permissions: {
        open: async () => 'ab'.repeat(16),
        attach: (ticket, res) => {
          opened.push(ticket);
          setTimeout(() => res.end('{"allow":"yes"}'), 200);
        },
      },
    });
    pipe = createServer((raw) => acceptPipe(raw, info.key, (socket) => server.hooks.emit('connection', socket)));
    await new Promise<void>((resolve) => pipe.listen(info.pipe, resolve));
  });

  afterAll(async () => {
    pipe.close();
    registry.dispose();
    await sleep(50);
  });

  const run = (args: string[], input: object, more: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; ms: number }> =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [hookJs, ...args], { env: { ...(process.env as Record<string, string>), FORCHETTA_ROOT: ROOT, FORCHETTA_VAR: varDir, CLAUDE_PID: '4321', FORCHETTA_AGENT: '', ...more }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.on('exit', (code) => resolve({ code, stdout, ms: Date.now() - started }));
      child.stdin.end(JSON.stringify(input));
    });
  const event = (name: string, more: object = {}): object => ({ hook_event_name: name, session_id: 'sess-1', cwd: temp.dir, ...more });

  it('with the daemon off it says nothing, and lets Claude go on', async () => {
    for (const kind of ['hook', 'guard', 'permission']) expect(await run([kind, '47821'], event('PreToolUse')), kind).toMatchObject({ code: 0, stdout: '' });
  });

  it('sends the events, with the pid of claude', async () => {
    writeFileSync(socketFile, JSON.stringify(info));
    expect(parsePipe(JSON.stringify(info))).toEqual(info);
    expect(await run(['hook', '47821'], event('SessionStart', { source: 'startup' }))).toMatchObject({ code: 0, stdout: '' });
    expect([...registry.agents.values()].find((agent) => agent.sessionId === 'sess-1')?.pid).toBe(4321);
  });

  it('prints the decision of the guard, and nothing when there is none', async () => {
    const pre = event('PreToolUse', { tool_name: 'Write', tool_input: { file_path: join(temp.dir, 'a.txt'), content: 'è' } });
    expect(await run(['guard', '47821'], pre)).toMatchObject({ code: 0, stdout: '' });
    decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'another session è' } };
    expect(JSON.parse((await run(['guard', '47821'], pre)).stdout)).toEqual(decision);
  });

  it('waits for the answer to a permission', async () => {
    const result = await run(['permission', '47821', '20'], event('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'x' } }));
    expect(result).toMatchObject({ code: 0, stdout: '{"allow":"yes"}' });
    expect(opened).toEqual(['ab'.repeat(16)]);
  });

  it('what is not the pipe of Forchetta gets nothing', async () => {
    writeFileSync(socketFile, JSON.stringify({ ...info, key: 'b'.repeat(64) }));
    expect(await run(['guard', '47821'], event('PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'x' } }))).toMatchObject({ code: 0, stdout: '' });
    writeFileSync(socketFile, JSON.stringify(info));
  });
});
