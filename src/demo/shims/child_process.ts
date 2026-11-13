// node:child_process for the demo: only git runs, and it is the one of demo/git.ts.
import { runGit } from '../git.ts';

type Callback = (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => void;

export function execFile(file: string, args: readonly string[], ...rest: unknown[]): void {
  const callback = rest.find((item): item is Callback => typeof item === 'function');
  const options = rest.find((item): item is { cwd?: string } => typeof item === 'object' && item !== null);
  if (file !== 'git') {
    setTimeout(() => callback?.(Object.assign(new Error(`${file}: not in the demo`), { code: 127 }), '', ''), 0);
    return;
  }
  const result = runGit(args, options?.cwd ?? '/Users/you');
  setTimeout(() => callback?.(result.code === 0 ? null : Object.assign(new Error('git'), { code: result.code }), result.stdout, ''), 0);
}

export const spawn = (): never => {
  throw new Error('not in the demo');
};
export default { execFile, spawn };
