// What the command line writes, and its exit once all of it went out. Into a pipe (`forchetta ls --json | jq`) Node
// writes asynchronously, 64 KB at a time: a process.exit() right after the last write cuts what is still on its
// way. So each write is counted until it is handed over, and the exit waits for the last one. A reader that goes
// away early (`| head -1`) ends the command quietly, as with any tool of the shell, not with an EPIPE.

export interface Output {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Exits with this status once everything written went out. */
  exit: (status: number) => void;
}

export function flushingOutput(
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
  quit: (status: number) => void = (status) => process.exit(status),
): Output {
  let pending = 0;
  let status: number | undefined;
  let gone = false;
  const leave = (code: number): void => {
    if (gone) return;
    gone = true;
    quit(code);
  };
  const settle = (): void => {
    if (pending === 0 && status !== undefined) leave(status);
  };
  const write =
    (stream: NodeJS.WritableStream) =>
    (text: string): void => {
      pending += 1;
      stream.write(text, () => {
        pending -= 1;
        settle();
      });
    };
  for (const stream of [out, err]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      // The reader closed the pipe: nothing more can go out, and nothing is wrong.
      if (error.code === 'EPIPE') leave(status ?? 0);
    });
  }
  return {
    stdout: write(out),
    stderr: write(err),
    exit: (code) => {
      status = code;
      settle();
    },
  };
}
