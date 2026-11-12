import { btwText, byteLength, fitBytes, MAX_BTW_BYTES, oneLine, quote } from './selection.ts';

// Quick prompts: questions you write once and send with one click from the menu of a selection. Each has a name
// (its button), a text with variables, and where it goes:
//   - ask: to the session, as your request (it waits for the session to be ready);
//   - btw: as /btw, a side question that stays out of the conversation;
//   - prompt: into the prompt of the session, not sent, for you to finish.
// Variables: {selection}, the selected text (as a quote when it stands on a line of its own); {session}, the name
// of the session; {folder}, its folder. A text without {selection} gets the selection after it.

export type PromptMode = 'ask' | 'btw' | 'prompt';

export interface QuickPrompt {
  name: string;
  text: string;
  mode: PromptMode;
}

export const MAX_PROMPTS = 12;
export const MAX_PROMPT_NAME = 24;
export const MAX_PROMPT_TEXT = 2000;
const MODES: readonly PromptMode[] = ['ask', 'btw', 'prompt'];

export const DEFAULT_PROMPTS: readonly QuickPrompt[] = [
  { name: 'Explain', text: 'Explain this:\n{selection}', mode: 'ask' },
  { name: 'Fix', text: 'Fix this:\n{selection}', mode: 'ask' },
  { name: 'Test', text: 'Write a test for this:\n{selection}', mode: 'ask' },
];

/** The quick prompts as the page sends them, checked; or what is wrong with them. */
export function cleanPrompts(input: unknown): { prompts: QuickPrompt[] } | { error: string } {
  if (!Array.isArray(input)) return { error: 'not a list of prompts' };
  if (input.length > MAX_PROMPTS) return { error: `at most ${MAX_PROMPTS} prompts` };
  const prompts: QuickPrompt[] = [];
  const names = new Set<string>();
  for (const item of input) {
    if (item === null || typeof item !== 'object') return { error: 'a prompt is not valid' };
    const { name, text, mode } = item as Record<string, unknown>;
    const cleanName = typeof name === 'string' ? oneLine(name) : '';
    const cleanText = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '';
    if (!cleanName) return { error: 'every prompt needs a name' };
    if (cleanName.length > MAX_PROMPT_NAME) return { error: `the name "${cleanName.slice(0, 30)}" is too long (at most ${MAX_PROMPT_NAME} characters)` };
    if (!cleanText) return { error: `"${cleanName}" has no text` };
    if (cleanText.length > MAX_PROMPT_TEXT) return { error: `the text of "${cleanName}" is too long (at most ${MAX_PROMPT_TEXT} characters)` };
    if (!MODES.includes(mode as PromptMode)) return { error: `"${cleanName}": choose ask, btw or prompt` };
    const key = cleanName.toLowerCase();
    if (names.has(key)) return { error: `two prompts are called "${cleanName}"` };
    names.add(key);
    prompts.push({ name: cleanName, text: cleanText, mode: mode as PromptMode });
  }
  return { prompts };
}

export interface PromptValues {
  selection: string;
  session: string;
  folder: string;
}

/** The text of a quick prompt with its variables filled, as it goes to the session for its mode. */
export function fillPrompt(prompt: Pick<QuickPrompt, 'text' | 'mode'>, values: PromptValues): string {
  const text = prompt.text.replace(/\{session\}/g, () => values.session).replace(/\{folder\}/g, () => values.folder);
  if (prompt.mode === 'btw') {
    // One line: the selection in quotes, cut so that the whole question fits.
    if (!text.includes('{selection}')) return btwText(text, values.selection);
    const pieces = oneLine(text).split('{selection}');
    const count = pieces.length - 1;
    const room = MAX_BTW_BYTES - byteLength(pieces.join('')) - 2 * count;
    const inline = `"${fitBytes(oneLine(values.selection), Math.max(8, Math.floor(room / count)))}"`;
    return fitBytes(pieces.join(inline), MAX_BTW_BYTES);
  }
  if (!text.includes('{selection}')) return `${text}\n\n${quote(values.selection)}`;
  return text
    .split('\n')
    .map((line) => (line.trim() === '{selection}' ? quote(values.selection) : line.replace(/\{selection\}/g, () => oneLine(values.selection))))
    .join('\n');
}
