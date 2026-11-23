// The computer of who looks at the page: a Mac, or another one (the browser of Windows, with Forchetta inside WSL).
// There the shortcuts are with Ctrl, and the texts call them so.

const name = typeof navigator === 'undefined' ? 'Mac' : navigator.platform || '';

export const IS_MAC = /^(?:Mac|iPhone|iPad)/i.test(name);

/** The title of the buttons that choose a folder: the panel of macOS, or the one of the page. */
export const CHOOSE_FOLDER = IS_MAC ? 'Choose the folder in the panel of macOS' : 'Choose the folder';

/** The key of the shortcuts and of the clicks on links: ⌘ on a Mac, Ctrl elsewhere. */
export const commandKey = (event: { metaKey: boolean; ctrlKey: boolean }, mac = IS_MAC): boolean => (mac ? event.metaKey : event.ctrlKey);

const NAMES: Record<string, string> = { '⌃': 'Ctrl', '⌘': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
const ORDER = ['Ctrl', 'Alt', 'Shift'];

/** A text with shortcuts as a Mac writes them, as this computer does: "Settings (⌘,)" is "Settings (Ctrl+,)". */
export function keyText(text: string, mac = IS_MAC): string {
  if (mac) return text;
  return text
    .replace(/([⌃⌘⌥⇧]+)(-(?=[a-z]))?/gi, (_match, signs: string, dash: string | undefined, at: number) => {
      const names = [...new Set([...signs].map((sign) => NAMES[sign]!))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).join('+');
      // "⌘-click" is "Ctrl-click"; "⌘N" is "Ctrl+N"; a sign alone is its name.
      if (dash) return `${names}-`;
      const next = text[at + signs.length];
      return next === undefined || /[\s).:;]/.test(next) ? names : `${names}+`;
    })
    .replace(/↩/g, 'Enter');
}
