import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { cleanPrompts, DEFAULT_PROMPTS, type QuickPrompt } from '../shared/prompts.ts';

// The quick prompts of the menu of a selection (shared/prompts.ts), in one file of the private folder. Until you
// save yours, the defaults.

export class QuickPrompts {
  private prompts: QuickPrompt[];

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void,
  ) {
    this.prompts = [...DEFAULT_PROMPTS];
    let content: string | undefined;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    try {
      const checked = cleanPrompts((JSON.parse(content) as { prompts?: unknown }).prompts);
      if ('prompts' in checked) this.prompts = checked.prompts;
      else log(`domande pronte illeggibili (${checked.error}): uso quelle di partenza`);
    } catch (error) {
      log(`domande pronte illeggibili: ${String(error)}`);
    }
  }

  list(): QuickPrompt[] {
    return this.prompts;
  }

  save(input: unknown): { ok: boolean; error?: string } {
    const checked = cleanPrompts(input);
    if ('error' in checked) return { ok: false, error: checked.error };
    try {
      const temporary = `${this.file}.${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify({ prompts: checked.prompts }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      return { ok: false, error: `not saved: ${String(error)}` };
    }
    this.prompts = checked.prompts;
    this.log(`domande pronte salvate: ${checked.prompts.length}`);
    return { ok: true };
  }
}
