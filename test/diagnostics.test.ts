import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { logProblems, redact } from '../src/cli/doctor.ts';
import { launchAgentPlist } from '../src/daemon/launch-agent.ts';
import { LogFile, logLine } from '../src/daemon/log.ts';
import { optionalFeatures, setupChecks, type SystemInputs } from '../src/daemon/system.ts';
import { DEFAULT_CONFIG } from '../src/shared/config.ts';
import { cleanSettings, compareVersions, needsRestart, newerThanTested, TESTED_CLAUDE } from '../src/shared/system.ts';
import { tempDir } from './helpers.ts';

// What tells whether Forchetta is in place: the log of the daemon, `forchetta doctor`, the checklist of the first
// start, the version of Claude Code against the one tested, the settings of the app, the LaunchAgent.

const temp = tempDir('diagnostics');
afterAll(() => temp.cleanup());

describe('the log of the daemon', () => {
  it('has the time and the level of each line, and starts a new file past its size, keeping three', () => {
    expect(logLine('warn', 'socket of the hooks: gone', new Date('2026-11-20T08:00:00Z'))).toBe('2026-11-20T08:00:00.000Z WARN  socket of the hooks: gone\n');
    const file = join(temp.dir, 'daemon.log');
    const log = new LogFile(file, { maxBytes: 200, keep: 3 });
    for (let n = 0; n < 40; n++) log.write('info', `line ${n} ${'x'.repeat(20)}`);
    log.write('info', 'line 40');
    log.close();
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(true);
    expect(existsSync(`${file}.4`)).toBe(false);
    expect(readFileSync(file, 'utf8')).toMatch(/INFO {2}line \d+/);
  });

  it('doctor shows the warnings and errors of the last day', () => {
    const now = Date.parse('2026-11-20T10:00:00Z');
    const text = [
      '2026-11-18T10:00:00.000Z WARN  too old',
      '2026-11-20T09:00:00.000Z INFO  daemon 0.9.14 listening',
      '2026-11-20T09:10:00.000Z WARN  claude agents --json failed: timeout',
      '2026-11-20T09:20:00.000Z ERROR guard: boom',
      'a line from before the levels',
    ].join('\n');
    expect(logProblems(text, now)).toEqual(['2026-11-20T09:10:00.000Z WARN  claude agents --json failed: timeout', '2026-11-20T09:20:00.000Z ERROR guard: boom']);
  });
});

describe('the bundle of doctor', () => {
  it('has no home, user name, e-mail, token or names of projects', () => {
    const text = 'command sent to shop-api (/Users/dev/code/shop-api) by dev, mail dev@example.com, token 0123456789abcdef0123456789abcdef, key sk-ant-api03-abc_DEF';
    const out = redact(text, ['shop-api', 'x'], '/Users/dev', 'dev');
    expect(out).toBe('command sent to name-1 (~/code/name-1) by <user>, mail <email>, token <token>, key <key>');
  });
});

describe('Claude Code against the version tested', () => {
  it('a newer minor version is said; a newer patch only noted', () => {
    expect(compareVersions('2.1.322', '2.1.40')).toBeGreaterThan(0);
    expect(compareVersions('2.1.322 (Claude Code)', '2.1.322')).toBe(0);
    expect(newerThanTested('2.2.0', '2.1.322')).toBe('minor');
    expect(newerThanTested('3.0.1', '2.1.322')).toBe('minor');
    expect(newerThanTested('2.1.400', '2.1.322')).toBe('patch');
    expect(newerThanTested('2.1.322', '2.1.322')).toBeUndefined();
    expect(newerThanTested('2.0.9', '2.1.322')).toBeUndefined();
    expect(newerThanTested(undefined)).toBeUndefined();
    expect(TESTED_CLAUDE).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the settings of the app', () => {
  const good = { guard: { files: true, git: false, notes: true, servers: true }, stallMin: 10, endedRetentionMin: 10, replace: 'lru', hotkey: 'Ctrl+Alt+F', port: 47821, haiku: false };
  it('are checked, and say what takes effect only after a restart', () => {
    const checked = cleanSettings(good);
    expect(checked).toEqual({ settings: { ...good, hotkey: 'ctrl+alt+f' } });
    expect(cleanSettings({ ...good, hotkey: '' })).toMatchObject({ settings: { hotkey: '' } });
    expect(cleanSettings({ ...good, hotkey: 'f' })).toMatchObject({ error: expect.stringContaining('ctrl+alt+f') });
    expect(cleanSettings({ ...good, stallMin: 0 })).toMatchObject({ error: expect.stringContaining('stuck after') });
    expect(cleanSettings({ ...good, port: 80 })).toMatchObject({ error: expect.stringContaining('port') });
    if (!('settings' in checked)) throw new Error('not valid');
    expect(needsRestart(checked.settings, { ...checked.settings, port: 47900, guard: { ...checked.settings.guard, git: true } })).toEqual(['the port']);
  });
});

describe('the checklist of the first start', () => {
  const inputs = (extra: Partial<SystemInputs> = {}): SystemInputs => ({
    config: DEFAULT_CONFIG,
    tmux: '/usr/local/bin/tmux',
    claude: '/usr/local/bin/claude',
    claudeVersion: '2.1.322',
    notesSupported: false,
    haikuOn: false,
    socket: true,
    hookSeen: false,
    sessions: 0,
    settingsText: '{}',
    ...extra,
  });
  it('says what is missing and how to fix it', () => {
    const checks = setupChecks(inputs({ tmux: undefined }));
    expect(checks.find((check) => check.id === 'hooks')).toMatchObject({ ok: false, fix: 'forchetta hooks install' });
    expect(checks.find((check) => check.id === 'tmux')).toMatchObject({ ok: false, fix: 'brew install tmux' });
    expect(checks.find((check) => check.id === 'claude')).toMatchObject({ ok: true, detail: expect.stringContaining('2.1.322') });
    expect(checks.find((check) => check.id === 'events')).toMatchObject({ ok: true, detail: 'no session yet' });
    expect(setupChecks(inputs({ sessions: 2 })).find((check) => check.id === 'events')).toMatchObject({ ok: false });
    expect(setupChecks(inputs({ settingsText: '{ nope' })).find((check) => check.id === 'hooks')).toMatchObject({ ok: false, detail: expect.stringContaining('not valid JSON') });
  });
  it('the optional features say why they are off and how to turn them on', () => {
    const features = optionalFeatures(inputs());
    expect(features.find((feature) => feature.id === 'arricurdai')).toMatchObject({ on: false, how: expect.any(String), link: expect.stringContaining('github.com') });
    expect(optionalFeatures(inputs({ arricurdai: ['arricurdai'], notesSupported: true })).filter((feature) => feature.on).map((feature) => feature.id)).toEqual(expect.arrayContaining(['arricurdai', 'notes']));
  });
});

describe('the LaunchAgent', () => {
  it('runs the daemon with node, again only when it stopped by mistake', () => {
    const plist = launchAgentPlist('/usr/local/bin/node', { PATH: '/usr/local/bin:/usr/bin', FORCHETTA_VAR: '/tmp/a&b' });
    expect(plist).toContain('<string>dev.forchetta.daemon</string>');
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain('<string>/tmp/a&amp;b</string>');
  });
});
