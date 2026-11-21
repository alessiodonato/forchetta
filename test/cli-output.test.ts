import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { flushingOutput } from '../src/cli/output.ts';
import { tempDir } from './helpers.ts';

const temp = tempDir('cli-output');
afterAll(() => temp.cleanup());

/** A process that writes `size` characters through flushingOutput, then exits with 3: what reaches its reader. */
function child(size: number, onData?: (chunk: Buffer, stop: () => void) => void): Promise<{ length: number; code: number | null; stderr: string }> {
  const script = join(temp.dir, `child-${size}.ts`);
  writeFileSync(script, `import { flushingOutput } from ${JSON.stringify(join(process.cwd(), 'src/cli/output.ts'))};\nconst out = flushingOutput();\nout.stdout('x'.repeat(${size}));\nout.stdout('\\nend\\n');\nout.exit(3);\n`);
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let length = 0;
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      onData?.(chunk, () => proc.stdout.destroy());
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    proc.on('close', (code) => resolve({ length, code, stderr }));
  });
}

describe('the output of the command line', () => {
  it('reaches a pipe whole before the exit, past 64 KB', async () => {
    const result = await child(300_000);
    expect(result).toEqual({ length: 300_005, code: 3, stderr: '' });
  });

  it('ends quietly when its reader goes away early (| head), with the status of the command', async () => {
    const result = await child(2_000_000, (_chunk, stop) => stop());
    expect(result.stderr).toBe('');
    expect(result.code).toBe(3);
    expect(result.length).toBeLessThan(2_000_000);
  });

  it('exits once every write was handed over, once', async () => {
    const out = new PassThrough({ highWaterMark: 4 });
    const err = new PassThrough();
    const exits: number[] = [];
    const output = flushingOutput(out, err, (status) => exits.push(status));
    output.stdout('a'.repeat(100));
    output.stderr('warning\n');
    output.exit(2);
    expect(exits).toEqual([]);
    out.resume();
    err.resume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exits).toEqual([2]);
    output.exit(2);
    expect(exits).toEqual([2]);
  });
});
