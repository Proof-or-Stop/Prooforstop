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
 * B-a745 CHK-002 adds the canonical legacy pin resolver at the bottom of this
 * file: the ONE migration path from a historical free-form `command` string to a
 * command id, with classified `pinned_command_missing` /
 * `pinned_command_ambiguous` stops.
 *
 * This module only ADDS refusal conditions. It reads no state, writes nothing,
 * and is not consumed by any lifecycle gate in this Story.
 */

import { createHash } from 'node:crypto';
import { relative } from 'node:path';

import {
  normalizeRoutineValidationCommand,
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

// ---------------------------------------------------------------------------
// B-a745 CHK-002 — canonical legacy pin resolver.
//
// Spec: same document, section "Canonical legacy pin resolver". New verification
// evidence pins `commandId`; historical evidence only carries a free-form
// `command` string, so there is EXACTLY ONE migration resolver and it is owned by
// the same command normalizer routine validation uses.
//
// Note the deliberate asymmetry with the stable id above, and do not collapse it:
//   - the stable ID is the NARROW portable tuple, so it survives a host change;
//   - PIN RESOLUTION compares the COMPLETE normalized tuple (command, args,
//     resolved cwd, shell, effective environment), so a pin never silently binds
//     a command that would execute differently.
// ---------------------------------------------------------------------------

/**
 * The shell-metacharacter rule. Single source shared with
 * `handlers/verifier.ts`, whose `commandFromString` is the parse every existing
 * free-form validate command string already went through.
 */
export const VALIDATION_COMMAND_SHELL_META_RE = /[;&|<>$()`]/;

/** Shell-style word splitting with quote and backslash handling. */
export function splitValidationCommandWords(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export interface ParsedLegacyValidationCommand {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Parse a free-form validation command string into an executable tuple, using
 * the SAME rule `configuredValidationCommands` applies to a bare-string config
 * entry: a shell metacharacter makes the WHOLE string the command with no args
 * and shell=true; otherwise the string is split into argv.
 *
 * Returns null for a string that names no command (empty or whitespace only).
 */
export function parseLegacyValidationCommandString(value: string): ParsedLegacyValidationCommand | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (VALIDATION_COMMAND_SHELL_META_RE.test(trimmed)) {
    return { command: trimmed, args: [], shell: true };
  }
  const parts = splitValidationCommandWords(trimmed);
  if (parts.length === 0) return null;
  return { command: parts[0], args: parts.slice(1), shell: false };
}

/**
 * The COMPLETE normalized executable tuple a pin is compared on. Labels, array
 * order, timeouts, optionality and focus are deliberately absent: none of them
 * changes what the command executes, so none of them may bind or break a pin.
 */
export interface CompleteValidationCommandTuple {
  command: string;
  args: string[];
  /** Absolute resolved cwd. */
  cwd: string;
  shell: boolean;
  /** Digest of the effective environment; raw values are never stored. */
  effectiveEnvironmentDigest: string;
}

export function completeValidationCommandTupleDigest(tuple: CompleteValidationCommandTuple): string {
  return validationIdentityDigest({
    schema: 'proofOrStop.validation-command-complete-tuple',
    version: 1,
    command: tuple.command,
    args: tuple.args,
    cwd: tuple.cwd,
    shell: tuple.shell,
    effectiveEnvironmentDigest: tuple.effectiveEnvironmentDigest,
  });
}

function completeTupleFromCommand(args: {
  projectRoot: string;
  command: ValidationCommand;
  processEnvironment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): CompleteValidationCommandTuple {
  // Reuse the ONE per-command normalizer: never recompute cwd, shell or the
  // environment digest here.
  const normalized = normalizeRoutineValidationCommand(args);
  return {
    command: normalized.command,
    args: normalized.args,
    cwd: normalized.cwd,
    shell: normalized.shell,
    effectiveEnvironmentDigest: normalized.effectiveEnvironmentDigest,
  };
}

export interface ValidationPinUniverseEntry extends ValidationCommandIdentityEntry {
  completeTuple: CompleteValidationCommandTuple;
  normalizedTupleDigest: string;
}

export interface ValidationPinUniverse {
  entries: ValidationPinUniverseEntry[];
  commandSetDigest: string;
  warnings: string[];
  /**
   * The resolution context the entries were normalized under. A legacy pin has
   * no cwd or environment of its own, so it must be normalized under EXACTLY the
   * same context as the universe it is compared against; carrying the context
   * here makes that structural instead of a caller convention.
   */
  projectRoot: string;
  processEnvironment?: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export function buildValidationPinUniverse(args: {
  projectRoot: string;
  commands: ValidationCommand[];
  processEnvironment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): ValidationPinUniverse {
  const platform = args.platform ?? process.platform;
  const inventory = buildValidationCommandInventory({
    projectRoot: args.projectRoot,
    commands: args.commands,
    platform,
  });
  return {
    entries: inventory.entries.map((entry) => {
      const completeTuple = completeTupleFromCommand({
        projectRoot: args.projectRoot,
        command: args.commands[entry.index],
        processEnvironment: args.processEnvironment,
        platform,
      });
      return {
        ...entry,
        completeTuple,
        normalizedTupleDigest: completeValidationCommandTupleDigest(completeTuple),
      };
    }),
    commandSetDigest: inventory.commandSetDigest,
    warnings: inventory.warnings,
    projectRoot: args.projectRoot,
    ...(args.processEnvironment ? { processEnvironment: args.processEnvironment } : {}),
    platform,
  };
}

export type ValidationPinResolutionKind = 'declared-id' | 'legacy-exact';
export type ValidationPinStopReason = 'pinned_command_missing' | 'pinned_command_ambiguous';

export interface ResolvedValidationPin {
  status: 'resolved';
  commandId: string;
  pinResolution: ValidationPinResolutionKind;
  /** Digest of the COMPLETE normalized tuple the binding was made on. */
  normalizedTupleDigest: string;
}

export interface StoppedValidationPin {
  status: 'stop';
  reason: ValidationPinStopReason;
  /** Every candidate id, for an ambiguous stop. Empty when nothing matched. */
  candidateIds: string[];
  message: string;
}

export type ValidationPinResolutionResult = ResolvedValidationPin | StoppedValidationPin;

/** The evidence fields a pin is read from. Never mutated. */
export interface ValidationPinEvidence {
  commandId?: string;
  command?: string;
}

/**
 * Runtime re-validation per the Handler encoding convention: the schema
 * constraint on an evidence field is the first line of defence only, so a
 * schema-bypassing caller (an internal fn call, or legacy JSON read straight off
 * disk) is re-checked here. A present-but-empty pin is a malformed input, NOT a
 * silent "unpinned".
 */
function readPinField(value: unknown, field: 'commandId' | 'command'): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`validation pin: ${field} must be a string when present`);
  }
  if (field === 'commandId' && value.trim() === '') {
    throw new Error('validation pin: commandId must be a non-empty string when present');
  }
  return value;
}

/**
 * Resolve one piece of verification evidence to a command id, in exactly the
 * spec's order. Pure: it reads the evidence and NEVER rewrites it in place to
 * migrate it — a future re-record is what writes a resolved `commandId`.
 */
export function resolveValidationCommandPin(args: {
  universe: ValidationPinUniverse;
  evidence: ValidationPinEvidence;
}): ValidationPinResolutionResult {
  const commandId = readPinField(args.evidence.commandId, 'commandId');
  const legacyCommand = readPinField(args.evidence.command, 'command');

  // 1. An explicit id requires an EXACT match, and is authoritative: it never
  //    falls through to string matching, because a silent fall-through would
  //    rebind a renamed pin to whatever currently looks similar.
  if (commandId !== undefined) {
    const trimmed = commandId.trim();
    const match = args.universe.entries.find((entry) => entry.id === trimmed);
    if (match) {
      return {
        status: 'resolved',
        commandId: match.id,
        pinResolution: 'declared-id',
        normalizedTupleDigest: match.normalizedTupleDigest,
      };
    }
    return {
      status: 'stop',
      reason: 'pinned_command_missing',
      candidateIds: [],
      message:
        `pinned_command_missing: evidence pins commandId "${trimmed}", which no command in the current ` +
        'validation command set declares. Re-record the evidence against a current command, or restore the id.',
    };
  }

  // 2. Otherwise parse the legacy free-form string with the existing rule and
  //    compare the COMPLETE normalized tuple.
  const parsed = legacyCommand === undefined ? null : parseLegacyValidationCommandString(legacyCommand);
  if (!parsed) {
    return {
      status: 'stop',
      reason: 'pinned_command_missing',
      candidateIds: [],
      message:
        'pinned_command_missing: evidence pins neither a commandId nor a resolvable command string, ' +
        'so there is nothing to bind to a validation command.',
    };
  }

  const target = completeTupleFromCommand({
    projectRoot: args.universe.projectRoot,
    command: { label: '<legacy evidence pin>', command: parsed.command, args: parsed.args, shell: parsed.shell },
    processEnvironment: args.universe.processEnvironment,
    platform: args.universe.platform,
  });
  const targetDigest = completeValidationCommandTupleDigest(target);
  const matches = args.universe.entries.filter((entry) => entry.normalizedTupleDigest === targetDigest);

  // 3. Exactly one match binds. 4. Zero is a stop. 5. Two or more is a stop
  //    listing EVERY candidate — labels and array order can never break the tie,
  //    because neither is an input to the comparison above.
  if (matches.length === 1) {
    return {
      status: 'resolved',
      commandId: matches[0].id,
      pinResolution: 'legacy-exact',
      normalizedTupleDigest: targetDigest,
    };
  }
  if (matches.length === 0) {
    return {
      status: 'stop',
      reason: 'pinned_command_missing',
      candidateIds: [],
      message:
        `pinned_command_missing: no command in the current validation command set normalizes to the same ` +
        `executable tuple as the legacy pin ${JSON.stringify(legacyCommand)}. Re-record the evidence against ` +
        'a current command.',
    };
  }
  const candidateIds = matches.map((entry) => entry.id);
  return {
    status: 'stop',
    reason: 'pinned_command_ambiguous',
    candidateIds,
    message:
      `pinned_command_ambiguous: the legacy pin ${JSON.stringify(legacyCommand)} normalizes to the same ` +
      `executable tuple as ${matches.length} commands (${candidateIds.map((id) => `"${id}"`).join(', ')}). ` +
      'Labels and array order cannot break the tie: re-record the evidence with an explicit commandId, or make ' +
      'the commands differ.',
  };
}
