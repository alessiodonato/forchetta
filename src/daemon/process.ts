import { execFile } from 'node:child_process';
import { systemTool } from '../shared/platform.ts';
import { WINDOWS } from '../shared/fspath.ts';
import { windowsPowerShell } from '../shared/windows.ts';

// Whether a claude process shows its dialogs in a terminal. `claude -p` and the SDK have no dialog: there a
// PermissionRequest hook that waits stops the whole run until it answers (seen with 2.1.322), so Forchetta does
// not hold their requests. The command line is the only sign: `claude agents --json` calls them "interactive"
// too.

/** Windows has no ps: its PowerShell says it. */
const COMMAND_LINE_ARGS = (pid: number): string[] => ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`];

/** The command line of a process, as ps shows it, or undefined when ps cannot tell. */
export function readCommandLine(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (WINDOWS) {
      execFile(windowsPowerShell(), COMMAND_LINE_ARGS(pid), { timeout: 8000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : String(stdout).trim() || undefined));
      return;
    }
    execFile(systemTool('ps'), ['-ww', '-o', 'args=', '-p', String(pid)], { timeout: 3000 }, (error, stdout) => {
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
  // On Windows the program may be quoted, with spaces in its path.
  const words = commandLine.replace(/^"[^"]*"/, 'claude').split(/\s+/).slice(1);
  return !words.some((word) => NON_INTERACTIVE.test(word) || (SHORT_PRINT.test(word) && word.length <= 6));
}
