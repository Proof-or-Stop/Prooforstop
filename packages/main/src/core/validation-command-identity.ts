/**
 * B-a745 CHK-001 — stable validation command identity.
 *
 * Spec: `docs/requirements/decisions/story-relevance-dynamic-validation-tiers-execution-plan.md`
 * section "Stable command identity". Dynamic selection must not depend on a
 * display label or an array position, so every configured validation command
 * needs an id that survives cosmetic edits.
 *
 * Design (`A-narrow-portable-id`):
 *   - A declared `id` is kept verbatim.
 *   - Otherwise the id is `prov-` + sha256 over the canonical serialization of
 *     the NARROW PORTABLE tuple {command, args, cwdRelative, shell}. Narrow so
 *     the id is stable across hosts: the machine-dependent digests the routine
 *     identity binds (effective environment, resolved executable, shell
 *     executable) are deliberately NOT in the id. They stay available through
 *     `buildRoutineValidationIdentity` as separate pin-resolution evidence.
 *   - `commandSetDigest` covers the ORDERED list of
 *     {id, label, command, args, cwdRelative, shell, timeoutMs, optional, focus}.
 *     `label` and `focus` are both inside it on purpose: the spec requires a
 *     label rename to invalidate the selection command-set digest even though the
 *     stable id survives, and a `focus` retag is a real configuration change.
 *     Being in the DIGEST is a different question from being in RELEVANCE —
 *     `focus` is excluded from relevance computation and included here.
 *   - Duplicate ids (declared or derived) are a hard error naming both entries.
 *     Never deduped: two commands that normalize identically are a configuration
 *     defect a planner must not paper over.
 *
 * This module only ADDS refusal conditions. It reads no state, writes nothing,
 * and is not consumed by any lifecycle gate in this Story.
 */

import { createHash } from 'node:crypto';
import { relative } from 'node:path';

import {
  resolveValidationCommandCwd,
  validationCommandUsesShell,
  validationIdentityDigest,
} from './validation-evidence-reuse.js';
import { resolveCommandTimeoutMs } from './validation-executor.js';
import type { ValidationCommand } from './validation-types.js';

/** Reserved namespace for derived ids. A declared id may never enter it. */
export const PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX = 'prov-';

/**
 * The host-portable subset of a command's execution identity. Everything in it
 * is either declared in project config or derived from the project root, so two
 * checkouts of the same commit produce the same tuple.
 */
export interface NarrowPortableValidationCommandTuple {
  command: string;
  args: string[];
  /** Repo-root-relative logical cwd, posix-separated. `.` means the project root. */
  cwdRelative: string;
  shell: boolean;
}

export interface ValidationCommandIdentityEntry {
  /** Original position in the configured array. Provenance only — never an identity input. */
  index: number;
  id: string;
  /** True when `id` was derived because the command declared none. */
  provisional: boolean;
  label: string;
  tuple: NarrowPortableValidationCommandTuple;
  timeoutMs: number;
  optional: boolean;
  focus: string[];
}

export interface ValidationCommandInventory {
  entries: ValidationCommandIdentityEntry[];
  commandSetDigest: string;
  provisionalCount: number;
  declaredCount: number;
  /** Migration warnings. Non-empty while any command still relies on a provisional id. */
  warnings: string[];
}

/** Repo-root-relative, posix-separated logical cwd. Empty relative path means the root. */
function commandCwdRelative(projectRoot: string, command: Pick<ValidationCommand, 'cwd'>): string {
  const absolute = resolveValidationCommandCwd(projectRoot, command);
  const relativePath = relative(projectRoot, absolute).split(/[\\/]+/).join('/');
  return relativePath === '' ? '.' : relativePath;
}

export function narrowPortableValidationCommandTuple(args: {
  projectRoot: string;
  command: ValidationCommand;
  platform?: NodeJS.Platform;
}): NarrowPortableValidationCommandTuple {
  const platform = args.platform ?? process.platform;
  return {
    command: args.command.command,
    args: [...args.command.args],
    cwdRelative: commandCwdRelative(args.projectRoot, args.command),
    shell: validationCommandUsesShell(args.command, platform),
  };
}

export function provisionalValidationCommandId(tuple: NarrowPortableValidationCommandTuple): string {
  return `${PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX}${validationIdentityDigest({
    schema: 'proofOrStop.validation-command-narrow-tuple',
    version: 1,
    command: tuple.command,
    args: tuple.args,
    cwdRelative: tuple.cwdRelative,
    shell: tuple.shell,
  })}`;
}

/**
 * Runtime re-validation of a declared id, per the Handler encoding convention:
 * a schema constraint is the first line of defence only, so every consumer
 * re-checks. `owner` names the offending entry in the error.
 */
export function assertDeclaredValidationCommandId(value: unknown, owner: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${owner}: id must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${owner}: id must be a non-empty string`);
  }
  if (trimmed.startsWith(PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX)) {
    throw new Error(
      `${owner}: id "${trimmed}" uses the reserved "${PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX}" prefix, ` +
      'which marks ids this tool derived for commands that declare none. Choose a different id.',
    );
  }
  return trimmed;
}

function describeEntry(index: number, label: string): string {
  return `"${label}" (validate.commands[${index}])`;
}

/**
 * Emitted while any command still relies on a derived id. The count is read from
 * the inventory being built, so it can never drift from reality.
 */
function migrationWarning(provisionalCount: number, total: number): string {
  return (
    `${provisionalCount} of ${total} validation commands still lack a declared id and are running on ` +
    `provisional ids (prefix "${PROVISIONAL_VALIDATION_COMMAND_ID_PREFIX}") derived from command, args, ` +
    'repo-relative cwd and shell. Declare a stable id on each so its planner identity survives an edit ' +
    'to any of those fields.'
  );
}

export function buildValidationCommandInventory(args: {
  projectRoot: string;
  commands: ValidationCommand[];
  platform?: NodeJS.Platform;
}): ValidationCommandInventory {
  const platform = args.platform ?? process.platform;
  const entries: ValidationCommandIdentityEntry[] = args.commands.map((command, index) => {
    const tuple = narrowPortableValidationCommandTuple({ projectRoot: args.projectRoot, command, platform });
    const declared = command.id === undefined
      ? null
      : assertDeclaredValidationCommandId(command.id, describeEntry(index, command.label));
    return {
      index,
      id: declared ?? provisionalValidationCommandId(tuple),
      provisional: declared === null,
      label: command.label,
      tuple,
      timeoutMs: resolveCommandTimeoutMs(command),
      optional: command.optional === true,
      focus: [...(command.focus ?? [])],
    };
  });

  // Duplicates are a hard error naming BOTH entries, never a silent dedupe.
  const seen = new Map<string, ValidationCommandIdentityEntry>();
  for (const entry of entries) {
    const previous = seen.get(entry.id);
    if (previous) {
      const derived = previous.provisional || entry.provisional;
      throw new Error(
        `duplicate validation command id "${entry.id}": ` +
        `${describeEntry(previous.index, previous.label)} and ${describeEntry(entry.index, entry.label)}` +
        (derived
          ? ' normalize to the same {command, args, cwd, shell} tuple. Make them differ, remove one, ' +
            'or declare a distinct id on each.'
          : ' declare the same id. Declared ids must be unique.'),
      );
    }
    seen.set(entry.id, entry);
  }

  const provisionalCount = entries.filter((entry) => entry.provisional).length;
  return {
    entries,
    commandSetDigest: createHash('sha256')
      .update(validationIdentityDigest({
        schema: 'proofOrStop.validation-command-set',
        version: 1,
        commands: entries.map((entry) => ({
          id: entry.id,
          label: entry.label,
          command: entry.tuple.command,
          args: entry.tuple.args,
          cwdRelative: entry.tuple.cwdRelative,
          shell: entry.tuple.shell,
          timeoutMs: entry.timeoutMs,
          optional: entry.optional,
          focus: entry.focus,
        })),
      }))
      .digest('hex'),
    provisionalCount,
    declaredCount: entries.length - provisionalCount,
    warnings: provisionalCount > 0 ? [migrationWarning(provisionalCount, entries.length)] : [],
  };
}
