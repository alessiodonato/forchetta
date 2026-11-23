// What the computer is called in the texts for you and for Claude: the Mac, or the computer. No Node module here: the
// page uses it too, and there it is the computer of the browser.

const where = typeof process !== 'undefined' && typeof process.platform === 'string' ? process.platform : typeof navigator !== 'undefined' ? navigator.platform : 'darwin';

export const MACHINE: 'Mac' | 'computer' = /^(?:darwin|mac)/i.test(where) ? 'Mac' : 'computer';
