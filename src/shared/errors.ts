/** A problem the user can fix: printed as one line, without a stack trace, and with what to do when there is a hint. */
export class UserError extends Error {
  override name = 'UserError';
  /** What to do about it: "brew install tmux, then run forchetta setup again". */
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}
