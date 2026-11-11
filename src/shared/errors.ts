/** A problem the user can fix: printed as one line, without a stack trace. */
export class UserError extends Error {
  override name = 'UserError';
}
