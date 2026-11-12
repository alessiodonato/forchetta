import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeUpdates, lastLines, parseLastUpdate, updateOutcome, versionIn } from '../src/daemon/claude-update.ts';
import type { ClaudeUpdateInfo } from '../src/shared/agent.ts';
import { failedTitle } from '../src/ui/ClaudeUpdate.tsx';
import { tempDir } from './helpers.ts';

/** What Claude Code 2.1.322 wrote after an automatic update failed at night. */
const FAILED = '{"timestamp":"2026-11-12T03:06:27.290Z","path":"native","outcome":"failed","status":"install_failed","version_from":"2.1.322","version_to":null,"error_code":null}';
const FAILED_AT = Date.parse('2026-11-12T03:06:27.290Z');

describe('the file of the last update', () => {
  it('reads a failed attempt', () => {
    expect(parseLastUpdate(FAILED)).toEqual({ at: FAILED_AT, outcome: 'failed', status: 'install_failed', from: '2.1.322', to: undefined });
  });

  it('leaves out what it cannot read', () => {
    expect(parseLastUpdate('not json')).toBeUndefined();
    expect(parseLastUpdate('{"outcome":"failed"}')).toBeUndefined();
    expect(parseLastUpdate('{"timestamp":"2026-11-12T03:06:27Z"}')).toBeUndefined();
    expect(parseLastUpdate('[]')).toBeUndefined();
  });
});

describe('what claude update did', () => {
  const ok = { code: 0, output: '', timedOut: false };

  it('reads the version of claude --version', () => {
    expect(versionIn('2.1.322 (Claude Code)\n')).toBe('2.1.322');
    expect(versionIn('nothing here')).toBeUndefined();
  });

  it('says a new version, or that there was none', () => {
    expect(updateOutcome(ok, '2.1.322', '2.1.323')).toEqual({ ok: true, text: 'Claude Code 2.1.323 installed: new sessions use it, the open ones keep 2.1.322 until they restart' });
    expect(updateOutcome(ok, '2.1.322', '2.1.322')).toEqual({ ok: true, text: 'Nothing to install: Claude Code 2.1.322 is the latest version' });
  });

  it('says why it failed, from the last lines it wrote, without colors', () => {
    const output = 'Checking for updates…\n\u001b[31mError: download failed\u001b[0m\nRun claude doctor\n\n';
    expect(updateOutcome({ code: 1, output, timedOut: false }, '2.1.322', '2.1.322')).toEqual({ ok: false, text: 'Error: download failed · Run claude doctor' });
    expect(updateOutcome({ code: 2, output: '', timedOut: false }, undefined, undefined)).toEqual({ ok: false, text: 'claude update ended with code 2' });
    expect(updateOutcome({ code: null, output: '', timedOut: true }, undefined, undefined).text).toBe('claude update did not finish in 10 minutes');
    expect(lastLines('x'.repeat(400))).toHaveLength(300);
  });

  it('tells in the tooltip when and from which version it failed', () => {
    const title = failedTitle({ at: FAILED_AT, from: '2.1.322', status: 'install_failed' }, FAILED_AT + 60_000);
    expect(title).toMatch(/^The automatic update of Claude Code from 2\.1\.322 failed at \d\d:\d\d( [AP]M)? \(install_failed\)\./);
    expect(failedTitle({ at: FAILED_AT }, FAILED_AT + 3 * 86_400_000)).toMatch(/failed on Nov 1[12], /);
  });
});

describe('ClaudeUpdates', () => {
  let temp: ReturnType<typeof tempDir>;
  let resultFile: string;
  let handledFile: string;
  let claude: string;
  let changes: ClaudeUpdateInfo[];
  /** null: claude was not found. */
  const make = (bin: string | null = claude): ClaudeUpdates =>
    new ClaudeUpdates({ resultFile, handledFile, claude: () => bin ?? undefined, onChange: (info) => changes.push(info), log: () => {} });

  beforeEach(() => {
    temp = tempDir('claude-update');
    resultFile = join(temp.dir, 'last-update-result.json');
    handledFile = join(temp.dir, 'claude-update.json');
    changes = [];
    // A fake claude: its version is in a file; `update` copies the next one there, or fails if asked to.
    claude = join(temp.dir, 'claude');
    writeFileSync(join(temp.dir, 'version'), '2.1.322\n');
    writeFileSync(
      claude,
      [
        '#!/bin/sh',
        'dir=$(dirname "$0")',
        'case "$1" in',
        '  --version) echo "$(cat "$dir/version") (Claude Code)" ;;',
        '  update)',
        '    if [ -f "$dir/fail" ]; then echo "Checking for updates" ; echo "Error: no network" >&2 ; exit 1 ; fi',
        '    if [ -f "$dir/next" ]; then cp "$dir/next" "$dir/version" ; echo "Updated" ; else echo "Up to date" ; fi ;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(claude, 0o755);
  });

  afterEach(() => temp.cleanup());

  it('shows a failed attempt, and nothing once Claude Code writes a good one', () => {
    const updates = make();
    updates.check();
    expect(updates.info()).toEqual({});
    expect(changes).toEqual([]);

    writeFileSync(resultFile, FAILED);
    updates.check();
    updates.check();
    expect(updates.info()).toEqual({ failed: { at: FAILED_AT, from: '2.1.322', status: 'install_failed' } });
    expect(changes).toHaveLength(1);

    writeFileSync(resultFile, '{"timestamp":"2026-11-12T05:00:00Z","outcome":"success","version_from":"2.1.322","version_to":"2.1.323"}');
    updates.check();
    expect(updates.info()).toEqual({});
    expect(changes).toHaveLength(2);
  });

  it('installs a new version, and does not show that failure again, after a restart either', async () => {
    writeFileSync(resultFile, FAILED);
    writeFileSync(join(temp.dir, 'next'), '2.1.323\n');
    const updates = make();
    updates.check();
    await updates.update();
    expect(changes.map((info) => info.run?.state)).toEqual([undefined, 'running', 'done']);
    expect(updates.info()).toEqual({ run: { state: 'done', text: expect.stringContaining('Claude Code 2.1.323 installed') as unknown, at: expect.any(Number) as unknown } });
    expect(JSON.parse(readFileSync(handledFile, 'utf8'))).toEqual({ handled: FAILED_AT });

    updates.dismiss();
    expect(updates.info()).toEqual({});

    const again = make();
    again.check();
    expect(again.info()).toEqual({});
    // A later failure shows again.
    writeFileSync(resultFile, FAILED.replace('2026-11-12T03:06:27.290Z', '2026-11-13T03:00:00.000Z'));
    again.check();
    expect(again.info().failed?.at).toBe(Date.parse('2026-11-13T03:00:00.000Z'));
  });

  it('says when there was nothing newer, and that counts as taken care of', async () => {
    writeFileSync(resultFile, FAILED);
    const updates = make();
    updates.check();
    await updates.update();
    expect(updates.info()).toEqual({ run: { state: 'done', text: 'Nothing to install: Claude Code 2.1.322 is the latest version', at: expect.any(Number) as unknown } });
  });

  it('keeps the failure and says why claude update failed', async () => {
    writeFileSync(resultFile, FAILED);
    writeFileSync(join(temp.dir, 'fail'), '');
    const updates = make();
    updates.check();
    await updates.update();
    const info = updates.info();
    expect(info.failed?.at).toBe(FAILED_AT);
    expect(info.run).toMatchObject({ state: 'error', text: expect.stringContaining('Error: no network') as unknown });
    expect(existsSync(handledFile)).toBe(false);

    updates.dismiss();
    expect(updates.info()).toEqual({ failed: info.failed });
  });

  it('runs one claude update at a time, and says when claude is missing', async () => {
    writeFileSync(resultFile, FAILED);
    const updates = make();
    updates.check();
    await Promise.all([updates.update(), updates.update()]);
    expect(changes.filter((info) => info.run?.state === 'running')).toHaveLength(1);

    rmSync(handledFile, { force: true });
    const missing = make(null);
    missing.check();
    await missing.update();
    expect(missing.info().run).toMatchObject({ state: 'error', text: 'claude not found' });
  });
});
