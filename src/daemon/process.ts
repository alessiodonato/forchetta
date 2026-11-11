import { execFile } from 'node:child_process';

// Whether a claude process shows its dialogs in a terminal. `claude -p` and the SDK have no dialog: there a
// PermissionRequest hook that waits stops the whole run until it answers (seen with 2.1.322), so Forchetta does
// not hold their requests. The command line is the only sign: `claude agents --json` calls them "interactive"
// too.

/** The command line of a process, as ps shows it, or undefined when ps cannot tell. */
export function readCommandLine(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)], { timeout: 3000 }, (error, stdout) => {
      const line = error ? '' : String(stdout).trim();
      resolve(line || undefined);
    });
  });
}

const NON_INTERACTIVE = /^--(?:print|output-format|input-format|sdk-url)(?:=|$)/;
/** -p alone, or among other short options: -cp. */
const SHORT_PRINT = /^-[A-Za-z]*p[A-Za-z]*$/;

/**
 * True for a claude that runs in a terminal: no -p or --print, no SDK streams. When in doubt, false: a request
 * that is not held still gets its dialog in the terminal. A prompt that contains " -p " counts as print: that
 * session only loses the buttons of the box.
 */
export function isInteractiveCommand(commandLine: string | undefined): boolean {
  if (!commandLine) return false;
  const words = commandLine.split(/\s+/).slice(1);
  return !words.some((word) => NON_INTERACTIVE.test(word) || (SHORT_PRINT.test(word) && word.length <= 6));
}
