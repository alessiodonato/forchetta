import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseRecall, runRecall } from '../src/daemon/recall.ts';
import { tempDir } from './helpers.ts';

// The search in earlier sessions, through `arricurdai recall --json`.

const temp = tempDir('recall');
afterAll(() => temp.cleanup());

/** A fake arricurdai: it writes its arguments and answers as told by the first word searched. */
function fake(): string[] {
  const script = join(temp.dir, 'arricurdai.mjs');
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(temp.dir, 'args.json'))}, JSON.stringify(args));
const words = args.slice(args.indexOf('--') + 1);
if (words[0] === 'rotto') { process.stderr.write('arricurdai recall: no transcripts for this project\\n'); process.exit(1); }
const matches = words[0] === 'niente' ? [] : [{ sessionId: 's-1', timestamp: '2026-11-10T09:00:00.000Z', request: 'Aggiungi il retry', score: 2, excerpt: 'Il retry è nel client.' }];
process.stdout.write(JSON.stringify({ query: words.join(' '), sessions: 3, matches }, null, 2));
`,
  );
  return [process.execPath, script];
}

describe('recall', () => {
  it('reads the matches of arricurdAI', () => {
    expect(parseRecall(JSON.stringify({ query: 'x', sessions: 2, matches: [{ sessionId: 's', timestamp: '2026-11-10T09:00:00.000Z', request: 'r', score: 1, excerpt: 'e' }, { nope: 1 }] }))).toEqual({
      ok: true,
      sessions: 2,
      matches: [{ sessionId: 's', at: Date.parse('2026-11-10T09:00:00.000Z'), request: 'r', excerpt: 'e' }],
    });
  });

  it('asks for the project, as JSON, with "--" before the words', async () => {
    const result = await runRecall(fake(), temp.dir, '-retry   client ');
    expect(result).toMatchObject({ ok: true, sessions: 3, matches: [{ request: 'Aggiungi il retry', excerpt: 'Il retry è nel client.' }] });
    const args = JSON.parse((await import('node:fs')).readFileSync(join(temp.dir, 'args.json'), 'utf8')) as string[];
    expect(args).toEqual(['recall', '--project', temp.dir, '--json', '--limit', '10', '--', '-retry', 'client']);
  });

  it('no match is no error; an error of arricurdAI says why', async () => {
    expect(await runRecall(fake(), temp.dir, 'niente')).toEqual({ ok: true, sessions: 3, matches: [] });
    expect(await runRecall(fake(), temp.dir, 'rotto')).toEqual({ ok: false, error: 'no transcripts for this project' });
  });

  it('needs arricurdAI, a folder that is there, and words', async () => {
    expect((await runRecall(undefined, temp.dir, 'x')).ok).toBe(false);
    expect((await runRecall(fake(), 'relativa', 'x')).error).toBe('scegli un progetto');
    expect((await runRecall(fake(), join(temp.dir, 'non-c-e'), 'x')).ok).toBe(false);
    expect((await runRecall(fake(), temp.dir, '   ')).error).toBe('scrivi cosa cercare');
  });
});
