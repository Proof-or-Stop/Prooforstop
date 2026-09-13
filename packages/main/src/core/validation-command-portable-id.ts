import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { ValidationCommand } from './validation-types.js';

export const PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX = 'prov-';

/**
 * The host-portable subset of a command's execution identity. Every field is
 * declared in project config; no ambient host or checkout location is read.
 */
export interface NarrowPortableValidationCommandTuple {
  command: string;
  args: string[];
  cwdRelative: string;
  shell: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** One canonical digest implementation shared by portable IDs and routine validation identity. */
export function validationIdentityDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/**
 * Return the declared cwd literal, POSIX-normalized. An absent declaration is
 * `.`. Absolute literals remain absolute and are reported by the inventory as
 * non-portable rather than silently rewritten relative to this checkout.
 */
export function declaredValidationCommandCwd(command: Pick<ValidationCommand, 'cwd'>): string {
  const raw = typeof command.cwd === 'string' ? command.cwd.trim() : '';
  if (raw === '') return '.';
  let normalized = posix.normalize(raw.replace(/\\/g, '/'));
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

export function isAbsoluteDeclaredValidationCommandCwd(declaredCwd: string): boolean {
  return posix.isAbsolute(declaredCwd) || /^[A-Za-z]:\//.test(declaredCwd);
}

export function narrowPortableValidationCommandTuple(args: {
  command: ValidationCommand;
}): NarrowPortableValidationCommandTuple {
  return {
    command: args.command.command,
    args: [...args.command.args],
    cwdRelative: declaredValidationCommandCwd(args.command),
    shell: args.command.shell === true,
  };
}

export function provisionalValidationCommandId(tuple: NarrowPortableValidationCommandTuple): string {
  const digest = validationIdentityDigest({
    schema: 'proofOrStop.validation-command-narrow-tuple',
    version: 1,
    command: tuple.command,
    args: tuple.args,
    cwdRelative: tuple.cwdRelative,
    shell: tuple.shell,
  });
  return `${PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX}${digest}`;
}
