import { keepRejected, readDataJson, writeDataJson } from '../shared/data-file.ts';
import { cleanPrompts, DEFAULT_PROMPTS, type QuickPrompt } from '../shared/prompts.ts';

// The quick prompts of the menu of a selection (shared/prompts.ts), in one file of the private folder. Until you
// save yours, the defaults.

export class QuickPrompts {
  private prompts: QuickPrompt[];

  constructor(
    private readonly file: string,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void,
  ) {
    this.prompts = [...DEFAULT_PROMPTS];
    const raw = readDataJson(file, 'quick prompts', log) as { prompts?: unknown } | undefined;
    if (raw === undefined) return;
    const checked = cleanPrompts(raw?.prompts);
    if ('prompts' in checked) this.prompts = checked.prompts;
    else {
      log(`quick prompts not valid (${checked.error}): the default ones are used`, 'warn');
      keepRejected(file, [raw], 'quick prompts', log);
    }
  }

  list(): QuickPrompt[] {
    return this.prompts;
  }

  save(input: unknown): { ok: boolean; error?: string } {
    const checked = cleanPrompts(input);
    if ('error' in checked) return { ok: false, error: checked.error };
    try {
      writeDataJson(this.file, { prompts: checked.prompts });
    } catch (error) {
      return { ok: false, error: `not saved: ${String(error)}` };
    }
    this.prompts = checked.prompts;
    this.log(`quick prompts saved: ${checked.prompts.length}`);
    return { ok: true };
  }
}
