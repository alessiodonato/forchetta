import { UserError } from '../shared/errors.ts';
import { closest } from './help.ts';

// The options of a command: flags (--json), options with a value (--goal "…" or --goal="…") and the rest, in order.

export interface Parsed {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

/** Splits the arguments of `forchetta <command>`; an unknown option, or one without its value, is an error. */
export function parseArgs(command: string, args: readonly string[], spec: { values?: readonly string[]; flags?: readonly string[] }): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  const valueNames = spec.values ?? [];
  const flagNames = spec.flags ?? [];
  const known = [...valueNames, ...flagNames];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (valueNames.includes(name)) {
      const value = equals > 0 ? arg.slice(equals + 1) : args[++index];
      if (value === undefined) throw new UserError(`${name} needs a value`, `see \`forchetta ${command} --help\``);
      values.set(name, value);
      continue;
    }
    if (flagNames.includes(name) && equals < 0) {
      flags.add(name);
      continue;
    }
    const near = closest(name, known);
    throw new UserError(`unknown option ${name} for ${command}`, near ? `did you mean \`${near}\`?` : `see \`forchetta ${command} --help\``);
  }
  return { positional, values, flags };
}
