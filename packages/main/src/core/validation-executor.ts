import { execSync, spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from './config.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsForStory,
  dirtyWorktreeClassifierOptionsFromConfig,
  parseGitPorcelainRow,
  renderDirtyWorktreeGroups,
} from './dirty-worktree.js';
import { StoryStore } from './store.js';
import { resolveProjectGitCwd } from './story-signed-workspace-resolution.js';
import { defaultAuditWriter, evaluateDirtyGate, type EvaluateDirtyGateResult } from './dirty-gate-policy.js';
import type {
  ValidationCommand,
  ValidationCommandResult,
  ValidationFailureKind,
  ValidationPlan,
  ValidationProgressEvent,
  ValidationProgressReporter,
  ValidationResult,
} from './validation-types.js';
import { effectiveValidationCommandEnvironment } from './validation-command-environment.js';
import { METADATA_BLOB_READ_MAX_BUFFER_BYTES } from './done-prepare-generated-metadata.js';

const MAX_OUTPUT_CHARS = 12000;

/**
 * Default hard per-command ceiling applied when a validate command sets no explicit
 * `timeoutMs`. This is a TOTAL WALL-CLOCK ceiling per command — distinct from the
 * cli-engine global watchdog, which fires only after ~300s of NO OUTPUT (idle). Kept
 * strictly BELOW that global watchdog (300_000ms = 5*60*1000; overridable via the
 * LATTICE_IDLE_TIMEOUT_MS env var) so a hung/slow command is killed and ATTRIBUTED
 * (exit 124) here first, instead of the global watchdog silently force-exiting the whole
 * validate (which never re-stamps test-evidence.materialHash and silently blocks DONE for
 * every story). It is also kept ABOVE the observed full-validation incident envelope
 * (~171s) with margin; a command that genuinely needs longer can raise
 * `lattice.config.json` validate.commands[].timeoutMs (the build is pinned there to 290s
 * to keep near-watchdog headroom for a cold-cache compile). NOTE: lowering
 * LATTICE_IDLE_TIMEOUT_MS below this default would invert the invariant — an advanced,
 * non-default override the operator owns.
 */
export const DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS = 270_000;
export const DEFAULT_VALIDATE_HEARTBEAT_MS = 30_000;
/** Node clamps larger setTimeout delays to ~1ms and emits TimeoutOverflowWarning. */
export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export interface RunValidationCommandOptions {
  progress?: ValidationProgressReporter;
  commandIndex?: number;
  totalCommands?: number;
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
}

export interface ExecuteValidationPlanOptions {
  progress?: ValidationProgressReporter;
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
}

/**
 * The effective per-command timeout: an explicit positive `timeoutMs`, else `defaultMs`
 * (the module default unless a caller injects one — the seam tests use to exercise the
 * default-arming path with a tiny ceiling). A non-finite / zero / negative `timeoutMs`
 * falls back to the default BY DESIGN: there is intentionally no opt-out of the per-command
 * ceiling, since an unbounded command is exactly the hang this guards against.
 */
export function resolveCommandTimeoutMs(
  command: ValidationCommand,
  defaultMs: number = DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
): number {
  const effective = typeof command.timeoutMs === 'number' && Number.isFinite(command.timeoutMs) && command.timeoutMs > 0
    ? command.timeoutMs
    : defaultMs;
  return Math.max(1, Math.min(MAX_NODE_TIMER_DELAY_MS, Math.floor(effective)));
}

export function resolveValidateHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LATTICE_VALIDATE_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_VALIDATE_HEARTBEAT_MS;
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

export function formatValidationCommand(command: ValidationCommand): string {
  if (command.shell) return command.command;
  return [command.command, ...command.args].join(' ').trim();
}

function formatTimeoutDiagnostics(
  command: ValidationCommand,
  result: ValidationCommandResult,
  commandIndex: number,
  totalCommands: number,
): string[] {
  const explicit = typeof command.timeoutMs === 'number' && Number.isFinite(command.timeoutMs) && command.timeoutMs > 0;
  const timeoutMs = result.timeoutMs ?? resolveCommandTimeoutMs(command);
  const timeout = `${timeoutMs}ms${explicit ? '' : ' (default)'}`;
  return [
    `  timeout diagnostic: command ${commandIndex}/${totalCommands} "${command.label}" exceeded configured timeoutMs=${timeout} after elapsedMs=${result.durationMs}.`,
    `  command: ${command.command}`,
    `  args: ${JSON.stringify(command.args)}`,
    '  If this command legitimately needs longer, raise lattice.config.json validate.commands[].timeoutMs for that command; otherwise investigate a hung validation command.',
  ];
}

function commandCwd(projectRoot: string, cwd?: string): string {
  if (!cwd) return projectRoot;
  return isAbsolute(cwd) ? cwd : resolve(projectRoot, cwd);
}

function trimOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const omitted = output.length - MAX_OUTPUT_CHARS;
  return output.slice(0, MAX_OUTPUT_CHARS) + `\n...[truncated ${omitted} chars]`;
}

/**
 * Aggregate sizing for the serialised validation evidence artifact (B-3434).
 *
 * trimOutput above bounds each command SEPARATELY at MAX_OUTPUT_CHARS. What was never bounded is
 * the AGGREGATE: handlers/verifier.ts serialises every command result into test-evidence.json, so
 * the artifact grows with the NUMBER of configured commands. It measured 1,369,692 bytes on story
 * B-9ff1 after validate.commands grew from 56 to 100 entries in a single day, which put it past the
 * 1,048,576-byte read ceiling that then blocked every REVIEW to TEST transition in the repository.
 *
 * Raising that read ceiling alone only moves the cliff, so the ceiling is the ANCHOR here rather
 * than an independent number: both thresholds below are fractions of
 * METADATA_BLOB_READ_MAX_BUFFER_BYTES, the ceiling core/done-prepare-generated-metadata.ts applies
 * to the very read that consumes this artifact.
 *
 * What is guaranteed, and what is not - stated precisely, because an earlier revision of this
 * comment claimed an invariant the code did not enforce, and the revision after it kept the claim
 * while the code moved underneath: the honest withinBound=false path was added nine lines below
 * this paragraph without the paragraph being revisited. A sentence about behaviour has to be
 * re-read whenever the behaviour changes, or it becomes the most confident wrong thing in the file.
 *
 *   GUARANTEED for an input the reduction can act on - an object, which is what the only
 *   production caller passes: boundValidationEvidenceOutput returns a string strictly smaller than
 *   VALIDATION_EVIDENCE_BOUND_BYTES. It is enforced by measuring the real encoding after every
 *   stage and by a last-resort record capped by construction, not by the two constants standing in
 *   the right order.
 *
 *   NOT GUARANTEED for an input with no structure to reduce - a multi-megabyte primitive, say.
 *   There is no field to elide and no entry to cap, so the function returns the oversized
 *   serialisation and reports withinBound: false. It does not pretend: the flag is measured on that
 *   path like every other, and persistStoryValidationEvidence refuses the write rather than storing
 *   an artifact the metadata read cannot consume. An unreduceable input is reported, not absorbed.
 *
 *   NOT GUARANTEED: that test-evidence.json as a FILE is under the ceiling. That file also carries
 *   verificationCoverage, commandExecution and routineValidationIdentity, written by
 *   persistStoryValidationEvidence outside this string. The 25 percent gap between the bound and
 *   the ceiling is the headroom those fields spend, and it is headroom rather than a proof. A read
 *   above the ceiling must therefore still fail diagnostically, which is what
 *   describeContentReadFailure in core/done-prepare-generated-metadata.ts is for.
 */
export const VALIDATION_EVIDENCE_READ_CEILING_BYTES = METADATA_BLOB_READ_MAX_BUFFER_BYTES;
/**
 * Advisory at a quarter of the ceiling (8 MiB against a 32 MiB ceiling). Chosen against the
 * measured growth curve, not by taste: 8 MiB is roughly 6x the 1,369,692-byte artifact that caused
 * the incident, which is far enough ahead that an operator meets the advisory with room to act, and
 * far enough behind the bound that the advisory is not a synonym for it.
 */
export const VALIDATION_EVIDENCE_ADVISORY_FRACTION = 0.25;
/** Hard bound at three quarters of the ceiling, leaving 25 percent headroom for the read itself. */
export const VALIDATION_EVIDENCE_BOUND_FRACTION = 0.75;
export const VALIDATION_EVIDENCE_ADVISORY_BYTES = Math.floor(
  VALIDATION_EVIDENCE_READ_CEILING_BYTES * VALIDATION_EVIDENCE_ADVISORY_FRACTION,
);
export const VALIDATION_EVIDENCE_BOUND_BYTES = Math.floor(
  VALIDATION_EVIDENCE_READ_CEILING_BYTES * VALIDATION_EVIDENCE_BOUND_FRACTION,
);

/** Three tiers, mirroring the buildLedgerSizing shape in core/proofstory.ts. */
export type ValidationEvidenceSizingState = 'within_budget' | 'advisory' | 'bounded';

export interface ValidationEvidenceSizing {
  /** Byte length of the artifact as it would have serialised with no bounding applied. */
  measuredBytes: number;
  /** Byte length of the artifact actually written. Equals measuredBytes when nothing was bounded. */
  serializedBytes: number;
  ceilingBytes: number;
  advisoryBytes: number;
  boundBytes: number;
  state: ValidationEvidenceSizingState;
  /** True when a reduction was applied. Says work happened; says NOTHING about the result size. */
  reduced: boolean;
  /**
   * The postcondition, DERIVED from the final measurement of the returned string - never asserted
   * by a code path having run. It is a separate field from `reduced` precisely because the two can
   * disagree: a reduction can run and still not get under the bound, and that must be reportable.
   */
  withinBound: boolean;
  /** Command entries kept, but with their captured output replaced by a visible marker. */
  elidedCommandOutputs: number;
  /** Command entries dropped from the array, always reported as a count, never silently. */
  elidedCommandEntries: number;
  /**
   * Detail lines replaced by a marker. executeValidationPlan copies every captured output line
   * into `details`, so this is the SECOND copy of the same bytes and is usually the larger one.
   */
  elidedDetailLines: number;
  /** Warning entries dropped from the array, reported as a count. */
  elidedWarnings: number;
  /**
   * Top-level fields REMOVED entirely, named rather than counted. Any field can appear here: the
   * bound is a postcondition over the whole object, not a list of fields the author thought of.
   * Names are individually length-capped, because a key name is itself a place bulk can hide.
   */
  droppedKeys: string[];
  /**
   * Top-level fields KEPT but truncated in place, each carrying a visible marker in the artifact.
   * Separate from droppedKeys because "removed" and "shortened" are different things to a reader.
   */
  truncatedKeys: string[];
}

export interface BoundedValidationEvidenceOutput extends ValidationEvidenceSizing {
  /** The serialised artifact. Always valid JSON, and always preserves the pass/fail fields. */
  output: string;
}

/**
 * Boundary rule, stated once so it is not re-litigated: each threshold is INCLUSIVE of the higher
 * tier. An artifact of exactly VALIDATION_EVIDENCE_ADVISORY_BYTES is `advisory`, and one of exactly
 * VALIDATION_EVIDENCE_BOUND_BYTES is `bounded`.
 */
export function classifyValidationEvidenceSize(measuredBytes: number): ValidationEvidenceSizingState {
  if (measuredBytes >= VALIDATION_EVIDENCE_BOUND_BYTES) return 'bounded';
  if (measuredBytes >= VALIDATION_EVIDENCE_ADVISORY_BYTES) return 'advisory';
  return 'within_budget';
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${bytes} bytes (${mib.toFixed(2)} MiB)`;
}

/**
 * The operator-facing advisory. Deliberately worded as information: no failure vocabulary, no
 * cross or warning glyph, and an explicit statement that the validate verdict is untouched, so a
 * reader scanning output cannot mistake it for a failing check.
 */
export function formatValidationEvidenceAdvisory(sizing: ValidationEvidenceSizing): string | null {
  if (sizing.state === 'within_budget') return null;
  // The wording deliberately avoids every failure token, so a reader scanning validate output
  // cannot mistake this line for a check that did not pass.
  const head = `evidence size advisory (informational; the validate verdict is unchanged): `
    + `the serialised validation evidence artifact is ${formatBytes(sizing.measuredBytes)}, `
    + `past the ${formatBytes(sizing.advisoryBytes)} advisory threshold, which is `
    + `${Math.round(VALIDATION_EVIDENCE_ADVISORY_FRACTION * 100)}% of the `
    + `${formatBytes(sizing.ceilingBytes)} metadata read ceiling.`;
  if (sizing.state === 'advisory') {
    return `${head} The artifact grows with the number of lattice.config.json validate.commands entries; `
      + `it is bounded at ${formatBytes(sizing.boundBytes)}.`;
  }
  // Removed and truncated are rendered as the different dispositions they are: a field that is
  // still present with an inline marker has not been removed, and saying so was inaccurate.
  const dropped = sizing.droppedKeys.length > 0
    ? ` Top-level field(s) removed entirely: ${sizing.droppedKeys.join(', ')}.`
    : '';
  const truncated = sizing.truncatedKeys.length > 0
    ? ` Top-level field(s) kept but truncated in place, each with an inline marker: ${sizing.truncatedKeys.join(', ')}.`
    : '';
  // The honest case: reduction ran and still could not satisfy the bound.
  const unmet = sizing.withinBound
    ? ''
    : ` The artifact could NOT be reduced under the bound and measures `
      + `${formatBytes(sizing.serializedBytes)}; the evidence write refuses it rather than storing an `
      + `artifact the metadata read cannot consume.`;
  return `${head} It reached the ${formatBytes(sizing.boundBytes)} bound, so it was serialised at `
    + `${formatBytes(sizing.serializedBytes)} with ${sizing.elidedCommandOutputs} command output(s) `
    + `replaced by a marker, ${sizing.elidedDetailLines} detail line(s) replaced by a marker, `
    + `${sizing.elidedWarnings} warning(s) and ${sizing.elidedCommandEntries} command entry(ies) `
    + `summarised by count.${dropped}${truncated}${unmet} `
    + `Per-command output remains available in the validate console output.`;
}

/**
 * Cap any label before it is embedded in the artifact.
 *
 * A key NAME is a place bulk can hide, and it was the one this function did not cap: a field
 * dropped because its name was enormous had that same name re-embedded under droppedKeys, so the
 * reduction reproduced the payload it had just removed. Capping values and entry counts is not
 * enough while any input-derived string reaches the output uncapped.
 */
const MAX_EMBEDDED_LABEL_CHARS = 120;

/**
 * Fields stage 5 will not drop, because they carry the verdict or the provenance a consumer reads.
 */
const VALIDATION_EVIDENCE_VERDICT_KEYS = [
  'allPass',
  'allPassed',
  'status',
  'failureKind',
  'summary',
  'provider',
  'timestamp',
  'headSha',
] as const;

/**
 * The subset the last-resort record can carry. Anything in VALIDATION_EVIDENCE_VERDICT_KEYS but not
 * here is dropped BY NAME when the fallback runs - the difference is computed from these two lists
 * rather than written out, so a field protected later without being carried cannot go missing
 * quietly the way timestamp and headSha did.
 */
const VALIDATION_EVIDENCE_VERDICT_ONLY_RECORD_KEYS = [
  'provider',
  'status',
  'allPass',
  'allPassed',
  'failureKind',
  'summary',
] as const;

/** Protected fields the fallback cannot carry, derived from the two lists above. */
function verdictKeysDroppedByFallback(source: Record<string, unknown>): string[] {
  const carried = new Set<string>(VALIDATION_EVIDENCE_VERDICT_ONLY_RECORD_KEYS);
  return VALIDATION_EVIDENCE_VERDICT_KEYS.filter((key) => !carried.has(key) && key in source);
}

function capLabel(label: string): string {
  const text = String(label);
  if (text.length <= MAX_EMBEDDED_LABEL_CHARS) return text;
  return `${text.slice(0, MAX_EMBEDDED_LABEL_CHARS)}...[+${text.length - MAX_EMBEDDED_LABEL_CHARS} chars]`;
}

function elisionMarker(originalChars: number): string {
  return `[evidence bound: ${originalChars} chars of captured output omitted so the aggregate artifact `
    + `stays under ${VALIDATION_EVIDENCE_BOUND_BYTES} bytes; see the validate console output]`;
}

function detailElisionMarker(lines: number, chars: number): string {
  return `  [evidence bound: ${lines} detail line(s), ${chars} chars, omitted so the aggregate artifact `
    + `stays under ${VALIDATION_EVIDENCE_BOUND_BYTES} bytes; see the validate console output]`;
}

function countElisionMarker(kind: string, omitted: number): string {
  return `[evidence bound: ${omitted} further ${kind} omitted so the aggregate artifact stays under `
    + `${VALIDATION_EVIDENCE_BOUND_BYTES} bytes; see the validate console output]`;
}

/**
 * Collapse the duplicated command output out of `details` while keeping the index a reader scans.
 *
 * executeValidationPlan pushes one status line per command (`✓ label: command`) and then pushes
 * every line of that command captured output indented by two spaces. The indented run is the
 * duplicate; the status lines are the navigable index. So each contiguous run of continuation
 * lines collapses to a single marker naming how many lines and characters went, and every status
 * line survives.
 */
function collapseDetailContinuationRuns(details: string[]): { details: string[]; elidedLines: number } {
  const collapsed: string[] = [];
  let runLines = 0;
  let runChars = 0;
  let elidedLines = 0;
  const flush = (): void => {
    if (runLines === 0) return;
    collapsed.push(detailElisionMarker(runLines, runChars));
    elidedLines += runLines;
    runLines = 0;
    runChars = 0;
  };
  for (const line of details) {
    if (typeof line === 'string' && line.startsWith('  ')) {
      runLines += 1;
      runChars += line.length;
      continue;
    }
    flush();
    collapsed.push(line);
  }
  flush();
  return { details: collapsed, elidedLines };
}

/**
 * Serialise a validation result for the evidence artifact, bounded at VALIDATION_EVIDENCE_BOUND_BYTES.
 *
 * Bounding is structural, never a string truncation: consumers parse this field (an unparseable
 * artifact is rejected as output_invalid_json and blocks the phase gate), so the result stays valid
 * JSON and keeps allPass / allPassed / status exactly as given. Nothing is discarded silently:
 *
 *   stage 1 - replace captured per-command output with a visible marker naming the omitted length,
 *             largest first; every entry is retained.
 *   stage 2 - collapse the DUPLICATE of that same output that executeValidationPlan copies into
 *             `details`, keeping the per-command status lines that make details navigable.
 *   stage 3 - cap `warnings`, then stage 4 caps `commands` entries, each with a stated count.
 *   stage 5 - drop the largest remaining top-level fields, NAMING each one in droppedKeys. This is
 *             what makes the bound a post-condition over the whole object rather than a promise
 *             about the fields listed above; bulk in a field added later is bounded too.
 *   stage 6 - truncate any still-oversized string value IN PLACE, naming each field in
 *             truncatedKeys. The field stays in the artifact, carrying an inline marker; that is a
 *             different disposition from stage 5 removal and is reported as one.
 *   fallback - if the measurement STILL fails, replace the whole artifact with verdictOnlyRecord:
 *             a record capped by construction that keeps the verdict fields the phase gate parses,
 *             says of itself that it is a replacement, and names every protected field it could
 *             not carry in droppedKeys, so the fallback discards nothing unnamed either.
 *
 * The verdict-bearing fields (VALIDATION_EVIDENCE_VERDICT_KEYS) are preserved by stages 1 to 5, and
 * the input object is never mutated. The fallback is the one place that cannot carry all of them -
 * it emits VALIDATION_EVIDENCE_VERDICT_ONLY_RECORD_KEYS - and the difference between those two
 * lists is computed and recorded rather than assumed, so protecting a new field without carrying it
 * names it automatically instead of dropping it in silence.
 *
 * `withinBound` is computed from Buffer.byteLength of the string actually returned, on every path
 * including the ones that do no work. It is never set from the fact that a stage ran: a flag that
 * cannot report failure turns a failure into an assurance, which is the `catch { return null }`
 * shape this story exists to remove.
 */
export function boundValidationEvidenceOutput(result: unknown): BoundedValidationEvidenceOutput {
  const serialized = JSON.stringify(result);
  const measuredBytes = Buffer.byteLength(serialized ?? 'null', 'utf8');
  const base = {
    measuredBytes,
    ceilingBytes: VALIDATION_EVIDENCE_READ_CEILING_BYTES,
    advisoryBytes: VALIDATION_EVIDENCE_ADVISORY_BYTES,
    boundBytes: VALIDATION_EVIDENCE_BOUND_BYTES,
    state: classifyValidationEvidenceSize(measuredBytes),
  };
  if (measuredBytes < VALIDATION_EVIDENCE_BOUND_BYTES || !result || typeof result !== 'object') {
    // Note the second half of that condition: a non-object carrying bulk (a multi-megabyte string)
    // has no structure to reduce, so this path can legitimately return withinBound=false. That is
    // the honest answer, and the caller is expected to act on it rather than store the artifact.
    const output = serialized ?? 'null';
    const serializedBytes = Buffer.byteLength(output, 'utf8');
    return {
      ...base,
      serializedBytes,
      reduced: false,
      withinBound: serializedBytes < VALIDATION_EVIDENCE_BOUND_BYTES,
      elidedCommandOutputs: 0,
      elidedCommandEntries: 0,
      elidedDetailLines: 0,
      elidedWarnings: 0,
      droppedKeys: [],
      truncatedKeys: [],
      output,
    };
  }

  const source = result as Record<string, unknown>;
  const carried: Record<string, unknown> = { ...source };
  let commands = Array.isArray(source.commands) ? [...(source.commands as any[])] : [];
  let details = Array.isArray(source.details) ? [...(source.details as any[])] : [];
  let warnings = Array.isArray(source.warnings) ? [...(source.warnings as any[])] : [];
  let elidedCommandOutputs = 0;
  let elidedCommandEntries = 0;
  let elidedDetailLines = 0;
  let elidedWarnings = 0;
  const droppedKeys: string[] = [];
  const truncatedKeys: string[] = [];

  const render = (): string => JSON.stringify({
    ...carried,
    ...(Array.isArray(source.commands) ? { commands } : {}),
    ...(Array.isArray(source.details) ? { details } : {}),
    ...(Array.isArray(source.warnings) ? { warnings } : {}),
    evidenceBound: {
      measuredBytes,
      boundBytes: VALIDATION_EVIDENCE_BOUND_BYTES,
      ceilingBytes: VALIDATION_EVIDENCE_READ_CEILING_BYTES,
      elidedCommandOutputs,
      elidedCommandEntries,
      elidedDetailLines,
      elidedWarnings,
      droppedKeys,
      truncatedKeys,
    },
  });
  const measure = (): number => Buffer.byteLength(render(), 'utf8');

  // Stage 1. Serialising a multi-megabyte artifact is not free, so elisions inside a stage adjust
  // an EXACT byte delta (replacing one JSON string value changes the encoding by exactly the
  // difference of the two encoded lengths) and the object is re-rendered once per stage.
  const encodedLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  let bytes = measure();
  if (bytes >= VALIDATION_EVIDENCE_BOUND_BYTES) {
    const order = commands
      .map((command, index) => ({ index, length: typeof command?.output === 'string' ? command.output.length : 0 }))
      .sort((a, b) => (b.length - a.length) || (a.index - b.index));
    for (const entry of order) {
      if (bytes < VALIDATION_EVIDENCE_BOUND_BYTES) break;
      if (entry.length === 0) continue;
      const previous = commands[entry.index]?.output;
      const marker = elisionMarker(entry.length);
      commands[entry.index] = { ...commands[entry.index], output: marker };
      elidedCommandOutputs += 1;
      bytes -= encodedLength(previous) - encodedLength(marker);
    }
    bytes = measure();
  }

  // Stage 2. The second copy of the same bytes, and usually the larger one: executeValidationPlan
  // indents every captured output line into `details`, so `details` alone can exceed the ceiling.
  if (bytes >= VALIDATION_EVIDENCE_BOUND_BYTES && details.length > 0) {
    const collapsed = collapseDetailContinuationRuns(details as string[]);
    details = collapsed.details;
    elidedDetailLines += collapsed.elidedLines;
    bytes = measure();
    // Whatever survives the collapse is structural rather than duplicated output, so it is capped
    // from the end with a stated count instead of being collapsed further.
    while (bytes >= VALIDATION_EVIDENCE_BOUND_BYTES && details.length > 1) {
      const removed = details.pop();
      elidedDetailLines += 1;
      bytes -= encodedLength(removed) + 1;
    }
    if (elidedDetailLines > 0 && details.length > 0) {
      details.push(countElisionMarker('detail line(s)', elidedDetailLines));
    }
    bytes = measure();
  }

  // Stage 3.
  while (bytes >= VALIDATION_EVIDENCE_BOUND_BYTES && warnings.length > 0) {
    const removed = warnings.pop();
    elidedWarnings += 1;
    bytes -= encodedLength(removed) + 1;
  }
  if (elidedWarnings > 0) {
    warnings.push(countElisionMarker('warning(s)', elidedWarnings));
    bytes = measure();
  }

  // Stage 4.
  while (bytes >= VALIDATION_EVIDENCE_BOUND_BYTES && commands.length > 0) {
    const removed = commands.pop();
    elidedCommandEntries += 1;
    bytes -= encodedLength(removed) + 1;
  }
  bytes = measure();

  // Stage 5. Anything still oversized lives in a field this function does not model. Drop the
  // largest remaining non-verdict field, name it, and re-measure, until the bound holds.
  const verdictKeys = new Set<string>(VALIDATION_EVIDENCE_VERDICT_KEYS);
  while (bytes >= VALIDATION_EVIDENCE_BOUND_BYTES) {
    const candidates = Object.keys(carried)
      .filter((key) => !verdictKeys.has(key) && key !== 'commands' && key !== 'details' && key !== 'warnings')
      .map((key) => ({ key, length: encodedLength(carried[key]) }))
      .sort((a, b) => (b.length - a.length) || a.key.localeCompare(b.key));
    if (candidates.length === 0) break;
    delete carried[candidates[0].key];
    // capLabel, because the key NAME is itself input-derived bulk: without it a field dropped for
    // being enormous is re-embedded here at its original size under a new label.
    droppedKeys.push(capLabel(candidates[0].key));
    bytes = measure();
  }

  // Stage 6. Truncate remaining oversized string values IN PLACE, which is a different disposition
  // from stage 5 removal and is recorded separately so the advisory can say which happened.
  let output = render();
  if (Buffer.byteLength(output, 'utf8') >= VALIDATION_EVIDENCE_BOUND_BYTES) {
    for (const key of Object.keys(carried)) {
      if (typeof carried[key] === 'string' && (carried[key] as string).length > 1000) {
        carried[key] = `${(carried[key] as string).slice(0, 1000)}${countElisionMarker('char(s) of this field', (carried[key] as string).length - 1000)}`;
        const label = capLabel(key);
        if (!truncatedKeys.includes(label)) truncatedKeys.push(label);
      }
    }
    commands = [];
    details = [];
    warnings = [];
    output = render();
  }

  // THE POSTCONDITION. Everything above is a reduction strategy, and any strategy can be defeated
  // by a dimension nobody modelled - `details` was one, a multi-megabyte KEY NAME was the next. So
  // the guarantee is not that the stages ran; it is this measurement of the string being returned,
  // with one fallback whose size is capped by construction rather than by the input.
  if (Buffer.byteLength(output, 'utf8') >= VALIDATION_EVIDENCE_BOUND_BYTES) {
    // Record what the fallback cannot carry BEFORE building it, so the record embeds those names
    // too. This was the single place in the function where a field vanished unlisted, inside the
    // function whose contract is that nothing does.
    for (const key of verdictKeysDroppedByFallback(source)) {
      const label = capLabel(key);
      if (!droppedKeys.includes(label)) droppedKeys.push(label);
    }
    output = verdictOnlyRecord(source, measuredBytes, droppedKeys, truncatedKeys);
  }
  const serializedBytes = Buffer.byteLength(output, 'utf8');
  const withinBound = serializedBytes < VALIDATION_EVIDENCE_BOUND_BYTES;

  return {
    ...base,
    serializedBytes,
    reduced: true,
    // Derived from the measurement immediately above, on this path and every other one. If some
    // input defeats even verdictOnlyRecord, this reports false and the caller refuses the write -
    // it does not hand back an oversized artifact wearing a success flag.
    withinBound,
    elidedCommandOutputs,
    elidedCommandEntries,
    elidedDetailLines,
    elidedWarnings,
    droppedKeys,
    truncatedKeys,
    output,
  };
}

/**
 * The last-resort artifact, sized by construction rather than by the input.
 *
 * Every string it embeds passes through a cap - scalars at 200 characters, labels at
 * MAX_EMBEDDED_LABEL_CHARS, and at most twenty labels of each kind - so its serialised length has a
 * computable ceiling in the low kilobytes whatever arrives. An earlier revision claimed that
 * independence while splicing raw key names into droppedKeys, which is exactly how a 30,000,000
 * character key reappeared in a record advertised as fixed-size.
 *
 * It still satisfies the consumer contract that matters at the phase gate: valid JSON carrying
 * allPass / allPassed / status, which is what evaluateValidationEvidenceAdmissibility in
 * core/validation-evidence-admissibility.ts parses. And it says of itself that it is a replacement,
 * so a reader is never left thinking this is the whole evidence.
 */
function verdictOnlyRecord(
  source: Record<string, unknown>,
  measuredBytes: number,
  droppedKeys: string[],
  truncatedKeys: string[],
): string {
  const scalar = (value: unknown): unknown =>
    typeof value === 'string' ? value.slice(0, 200) : (typeof value === 'boolean' || typeof value === 'number' ? value : undefined);
  // Built FROM the constant rather than repeating its members, so the set this record carries and
  // the set the caller reports as dropped are derived from one another and cannot disagree.
  const carried: Record<string, unknown> = {};
  for (const key of VALIDATION_EVIDENCE_VERDICT_ONLY_RECORD_KEYS) {
    const value = scalar(source[key]);
    if (value !== undefined) carried[key] = value;
  }
  return JSON.stringify({
    ...carried,
    evidenceBound: {
      measuredBytes,
      boundBytes: VALIDATION_EVIDENCE_BOUND_BYTES,
      ceilingBytes: VALIDATION_EVIDENCE_READ_CEILING_BYTES,
      replacedWithVerdictOnlyRecord: true,
      reason: 'known reductions were insufficient; the full result is available in the validate console output',
      droppedKeys: droppedKeys.slice(0, 20).map(capLabel),
      truncatedKeys: truncatedKeys.slice(0, 20).map(capLabel),
    },
  });
}

function emitValidationProgress(progress: ValidationProgressReporter | undefined, event: ValidationProgressEvent): void {
  if (!progress) return;
  try {
    const result = progress(event) as unknown;
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => { /* diagnostic-only async sink rejection */ });
    }
  } catch {
    // Progress is diagnostic-only; validation results must not depend on a
    // caller's logging sink.
  }
}

function commandFailureKind(args: {
  code: number;
  timedOut: boolean;
  runnerFailure: boolean;
}): ValidationFailureKind | undefined {
  if (args.code === 0 && !args.timedOut && !args.runnerFailure) return undefined;
  if (args.timedOut || args.runnerFailure) return 'infra_failure';
  return 'validation_failure';
}

function validationProgressEvent(
  type: ValidationProgressEvent['type'],
  command: ValidationCommand,
  args: {
    commandIndex: number;
    totalCommands: number;
    timeoutMs: number;
    started: number;
    cwd?: string;
    code?: number;
    timedOut?: boolean;
  },
): ValidationProgressEvent {
  return {
    type,
    commandIndex: args.commandIndex,
    totalCommands: args.totalCommands,
    label: command.label,
    command: command.command,
    args: command.args,
    ...(command.shell ? { shell: true } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
    timeoutMs: args.timeoutMs,
    elapsedMs: Date.now() - args.started,
    timestamp: new Date().toISOString(),
    ...(typeof args.code === 'number' ? { code: args.code } : {}),
    ...(args.timedOut ? { timedOut: true } : {}),
  };
}

export function formatValidationProgressEvent(event: ValidationProgressEvent): string {
  const index = `${event.commandIndex}/${event.totalCommands}`;
  const commandText = event.shell
    ? event.command
    : [event.command, ...event.args].join(' ').trim();
  switch (event.type) {
    case 'command_start':
      return `validate progress: command ${index} started ${event.label}: ${commandText} timeoutMs=${event.timeoutMs}`;
    case 'heartbeat':
      return `validate heartbeat: command ${index} ${event.label} elapsedMs=${event.elapsedMs} timeoutMs=${event.timeoutMs}`;
    case 'command_timeout':
      return `validate timeout: command ${index} ${event.label}: command=${event.command} args=${JSON.stringify(event.args)} timeoutMs=${event.timeoutMs} elapsedMs=${event.elapsedMs}`;
    case 'command_end':
      return `validate progress: command ${index} ended ${event.label}: code=${event.code ?? 'unknown'} elapsedMs=${event.elapsedMs}${event.timedOut ? ' timedOut=true' : ''}`;
  }
}

// B-75f0 CHK-002: `gitCwd` is the resolved git working dir (runValidationCommand
// resolves it via resolveProjectGitCwd). On a wrapper-root layout it is the real
// gitRoot subdir so the dirty-status probe reads the actual repo; on a plain repo
// (or when no gitRoot resolves) it is the passed projectRoot verbatim. The `null`
// fallback on any git failure is preserved (the side-effect guard is only
// available inside git worktrees; outside one it degrades to null, never crash).
function readGitStatus(gitCwd: string): string[] | null {
  try {
    const raw = execSync('git status --porcelain=v1 --untracked-files=all', {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return raw.split('\n').map(line => line.trimEnd()).filter(Boolean);
  } catch {
    // PROBE: validation side-effect guard is only available inside git worktrees.
    return null;
  }
}

function statusPath(line: string): string {
  return parseGitPorcelainRow(line)?.path ?? line.slice(3).trim();
}

function detectNewDirtyStatus(before: string[] | null, after: string[] | null): string[] {
  if (!before || !after || after.length === 0) return [];
  const beforePaths = new Set(before.map(statusPath));
  return after.filter(line => !beforePaths.has(statusPath(line)));
}

// Task B-6326 + B-4b22: validation side-effect details share DONE gate
// dirty ownership vocabulary AND route through dirty-gate-policy. When every
// polluted path classifies as a passing category (lattice_metadata /
// runtime_artifact / declared_artifact), the call:
//   1. flips `result.worktreePollution.blocking` to false (executeValidationPlan
//      then reads this to keep allPass = true),
//   2. swaps the leading "✗ validation command dirtied worktree" line for a
//      "✓ … (passed by dirty-gate-policy)" wording so downstream readers see
//      that the loosening was intentional,
//   3. emits audit lines into <projectRoot>/<storyDir>/<storyId>/process-events.jsonl
//      when a storyId is supplied. Storyless callers pass null writer (no
//      audit; gate degrades to blocking on failure path).
//
// Anti-divergence (preMortem #3): both core/done-oracle.ts (the DONE gate
// checklist) and this function import evaluateDirtyGate from the same module.
// No inline category check.
export function formatWorktreePollutionDetails(
  result: ValidationCommandResult,
  projectRoot?: string,
  storyId?: string,
): string[] {
  const pollution = result.worktreePollution;
  if (!pollution || pollution.statusLines.length === 0) return [];
  const config = projectRoot ? loadConfig(projectRoot) : undefined;
  let classifierOptions = config ? dirtyWorktreeClassifierOptionsFromConfig(config, projectRoot) : {};
  if (config && projectRoot && storyId) {
    try {
      const store = new StoryStore(projectRoot);
      classifierOptions = dirtyWorktreeClassifierOptionsForStory(config, storyId, store, projectRoot);
    } catch {
      // PROBE: StoryStore init or declared-artifacts read failed → fall back to config-only options.
    }
  }
  const classification = classifyGitStatusRows(
    pollution.statusLines,
    classifierOptions,
  );
  const writer = projectRoot && storyId && config
    ? defaultAuditWriter(projectRoot, config.storyDir, storyId)
    : null;
  const evaluation: EvaluateDirtyGateResult = evaluateDirtyGate(classification, {
    storyId: storyId ?? 'anonymous',
    gate: 'validate-side-effect',
    writer,
  });
  // Propagate blocking decision back to executeValidationPlan via a typed flag.
  pollution.blocking = !evaluation.allPass;

  const mark = evaluation.allPass ? '✓' : '✗';
  const header = evaluation.allPass
    ? `${mark} validation command produced policy-allowed dirty paths: ${result.label}: ${formatValidationCommand(result)}`
    : `${mark} validation command dirtied worktree: ${result.label}: ${formatValidationCommand(result)}`;
  const lines = [
    header,
    `  ${evaluation.allPass ? 'pass' : 'fail'}: ${evaluation.summary}`,
    ...renderDirtyWorktreeGroups(classification, { sampleLimit: 6, indent: '  ' }),
  ];
  if (evaluation.auditFailure) {
    lines.push(`  ${evaluation.auditFailure}`);
  }
  if (!evaluation.allPass) {
    lines.push('  validation commands must be side-effect-free by default; gate report generation behind an env var or configure side-effect-free validate.command(s)');
  } else {
    lines.push('  audit lines appended to process-events.jsonl by dirty-gate-policy (B-4b22)');
  }
  return lines;
}

/**
 * Run a single validation command, enforcing a per-command wall-clock timeout.
 *
 * `defaultTimeoutMs` is a TEST SEAM: it overrides the module-default ceiling used when the
 * command carries no explicit `timeoutMs`, letting tests exercise the default-arming path
 * with a tiny value instead of waiting the full default. No production caller passes it —
 * {@link executeValidationPlan} and the direct handler callers (the legacy validate.ts and
 * external-command paths in verifier.ts) all omit the argument, so production always resolves
 * to DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS. There is deliberately no plan-level injection to
 * expose: every production command either carries its own `timeoutMs` or wants the real default.
 */
export function runValidationCommand(
  command: ValidationCommand,
  projectRoot: string,
  defaultTimeoutMs: number = DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
  options: RunValidationCommandOptions = {},
): Promise<ValidationCommandResult> {
  const cwd = commandCwd(projectRoot, command.cwd);
  const started = Date.now();
  const configuredTimeoutMs = resolveCommandTimeoutMs(command, defaultTimeoutMs);
  const deadlineRemainingMs = typeof options.deadlineAt === 'number' && Number.isFinite(options.deadlineAt)
    ? Math.max(1, Math.floor(options.deadlineAt - Date.now()))
    : undefined;
  const timeoutMs = deadlineRemainingMs === undefined
    ? configuredTimeoutMs
    : Math.min(configuredTimeoutMs, deadlineRemainingMs);
  const commandIndex = options.commandIndex ?? 1;
  const totalCommands = options.totalCommands ?? 1;
  const heartbeatMs = options.heartbeatMs ?? resolveValidateHeartbeatMs();
  // B-75f0 CHK-002: no storyId in scope here (runValidationCommand takes only
  // projectRoot), so resolve the dirty-status probe cwd with the id-independent
  // project-level resolver — config loaded so a configured gitRoot subdir on a
  // wrapper-root layout is honored. Plain repos / unresolved → projectRoot
  // verbatim (byte-identical).
  let statusGitCwd: string;
  try {
    statusGitCwd = resolveProjectGitCwd(projectRoot, projectRoot, loadConfig(projectRoot));
  } catch {
    statusGitCwd = projectRoot;
  }
  const statusBefore = readGitStatus(statusGitCwd);

  return new Promise((resolveResult) => {
    const isWindows = process.platform === 'win32';
    let output = '';
    let timedOut = false;
    let runnerFailure = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;

    const finish = (rawCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      options.abortSignal?.removeEventListener('abort', abortCommand);
      // A timed-out command is ALWAYS attributed exit 124, regardless of the child's own
      // reported code. On POSIX a SIGTERM/SIGKILL gives code=null; on Windows
      // TerminateProcess gives a numeric code (≠ null), and a child that traps SIGTERM
      // could even exit 0 — without this normalization those would mis-report as not-124
      // even though `timedOut` is set.
      const code = timedOut ? 124 : (rawCode ?? 1);
      const failureKind = commandFailureKind({ code, timedOut, runnerFailure });
      const statusAfter = readGitStatus(statusGitCwd);
      const pollutionStatusLines = detectNewDirtyStatus(statusBefore, statusAfter);
      const result: ValidationCommandResult = {
        label: command.label,
        command: command.command,
        args: command.args,
        ...(command.shell || isWindows ? { shell: true } : {}),
        ...(command.cwd ? { cwd } : {}),
        code,
        output: trimOutput(stripAnsi(output)),
        ...(command.optional ? { optional: true } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        timeoutMs,
        ...(failureKind ? { failureKind } : {}),
        durationMs: Date.now() - started,
        ...(pollutionStatusLines.length > 0
          ? {
              worktreePollution: {
                statusLines: pollutionStatusLines,
                paths: pollutionStatusLines.map(statusPath),
              },
            }
          : {}),
      };
      emitValidationProgress(options.progress, validationProgressEvent('command_end', command, {
        commandIndex,
        totalCommands,
        timeoutMs,
        started,
        cwd,
        code,
        timedOut,
      }));
      resolveResult(result);
    };

    const child = spawn(command.command, command.args, {
      cwd,
      env: effectiveValidationCommandEnvironment(process.env, command.env, cwd),
      shell: command.shell || isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: give the child its own process group (it becomes group leader) so the
      // timeout can signal the WHOLE tree. Wrapper commands (npm, `/bin/sh -c …`) spawn
      // grandchildren that survive a direct child.kill() and keep the stdout/stderr pipe
      // open — which delays, or with an infinite grandchild prevents, the 'close' event,
      // re-introducing the exact hang this guards against. Not unref'd: we still await it.
      ...(isWindows ? {} : { detached: true }),
    });

    emitValidationProgress(options.progress, validationProgressEvent('command_start', command, {
      commandIndex,
      totalCommands,
      timeoutMs,
      started,
      cwd,
    }));
    heartbeatTimer = setInterval(() => {
      emitValidationProgress(options.progress, validationProgressEvent('heartbeat', command, {
        commandIndex,
        totalCommands,
        timeoutMs,
        started,
        cwd,
      }));
    }, heartbeatMs);
    heartbeatTimer.unref?.();

    // Signal the child's whole process group (POSIX) / process tree (Windows). Best-effort:
    // a race with natural exit (ESRCH) or a missing pid degrades to a direct child.kill().
    const killTree = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (isWindows) {
          // Windows has no process groups/POSIX signals; force-kill the whole tree.
          // Attach an 'error' handler: a missing/unlaunchable taskkill emits an async
          // 'error' on the returned child, which would otherwise be an unhandled exception
          // that crashes the process. Fall back to a direct child.kill() in that case.
          spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
            .on('error', () => { try { child.kill(signal); } catch { /* already gone */ } });
        } else {
          process.kill(-pid, signal); // negative pid → the child's process group
        }
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };

    const timeOutCommand = (escalationMs: number): void => {
      if (settled || timedOut) return;
      timedOut = true;
      emitValidationProgress(options.progress, validationProgressEvent('command_timeout', command, {
        commandIndex,
        totalCommands,
        timeoutMs,
        started,
        cwd,
        timedOut: true,
      }));
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), escalationMs);
      killTimer.unref?.();
    };

    const abortCommand = (): void => {
      timeOutCommand(50);
    };

    if (options.abortSignal?.aborted) {
      abortCommand();
    } else {
      options.abortSignal?.addEventListener('abort', abortCommand, { once: true });
    }

    // Always arm a per-command timeout: explicit timeoutMs, else the default ceiling. A
    // hung command is then killed (whole group) + attributed (exit 124) here, instead of
    // the global idle watchdog silently force-exiting the whole validate. unref() so a
    // stray timer never keeps the event loop alive on its own (the awaited child does).
    timer = setTimeout(() => {
      timeOutCommand(1000);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => finish(code));
    child.on('error', (e) => {
      runnerFailure = true;
      output += output ? `\n${e.message}` : e.message;
      finish(null);
    });
  });
}

/**
 * B-ec67: executables a pinned verification command may use. A pinned command is
 * executable+argv, NEVER a raw shell program — so we constrain the leading token to
 * this small allowlist of test/runtime launchers. This is the enforcement analogue
 * of the lattice-dispatch command-authorization boundary (dispatch's per-policy
 * `commandAllowlist` authorizes whole command STRINGS under an unattended policy and
 * needs a DispatchPolicy in scope; that surface is not reusable for a synchronous
 * evidence write, so the pinned-command path keeps its own focused executable
 * allowlist and never runs an arbitrary shell program).
 */
export const VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST: ReadonlySet<string> = new Set([
  'node',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'tsx',
  'bun',
]);

/**
 * B-ec67: tokenize a pinned command string into executable + argv WITHOUT a shell.
 * Supports single/double quotes and backslash escapes so a command like
 * `node -e "console.log('MARKER_OK')"` yields ['node','-e',"console.log('MARKER_OK')"].
 * Throws on an unterminated quote. No shell metacharacter interpretation happens.
 */
export function tokenizeCommandString(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === '\\' && i + 1 < command.length && (command[i + 1] === '"' || command[i + 1] === '\\')) current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === "'") { inSingle = true; hasToken = true; continue; }
    if (ch === '"') { inDouble = true; hasToken = true; continue; }
    if (ch === '\\' && i + 1 < command.length) { current += command[++i]; hasToken = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasToken) { tokens.push(current); current = ''; hasToken = false; }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (inSingle || inDouble) throw new Error(`verification command has an unterminated quote: ${command}`);
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * B-ec67: parse + allowlist-check a pinned command string. Throws when empty or when
 * the leading executable is not in {@link VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST}.
 */
export function parseAllowlistedCommand(command: string): { executable: string; args: string[] } {
  const tokens = tokenizeCommandString(command);
  if (tokens.length === 0) throw new Error('verification command is empty');
  const [executable, ...args] = tokens;
  if (!VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST.has(executable)) {
    throw new Error(
      `verification command executable "${executable}" is not allowlisted ` +
      `(allowed: ${[...VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST].join(', ')}); ` +
      'a pinned verification command must be executable+argv, never a raw shell program [verification_command_not_allowlisted]',
    );
  }
  return { executable, args };
}

export interface SingleCommandExecutionResult {
  executable: string;
  args: string[];
  code: number;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * B-ec67: run ONE allowlisted pinned command via the shared {@link runValidationCommand}
 * spawn path (per-command timeout, output capture, no shell on POSIX). Used by the
 * evidence-write handler to derive a tool-owned receipt from the actual exit + output.
 */
export async function runSingleAllowlistedCommand(
  command: string,
  projectRoot: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<SingleCommandExecutionResult> {
  const { executable, args } = parseAllowlistedCommand(command);
  const validationCommand: ValidationCommand = {
    label: 'verification-evidence-command',
    command: executable,
    args,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
  };
  const result = await runValidationCommand(validationCommand, projectRoot);
  return {
    executable,
    args,
    code: result.code,
    output: result.output,
    timedOut: Boolean(result.timedOut),
    durationMs: result.durationMs,
  };
}

export async function executeValidationPlan(
  plan: ValidationPlan,
  projectRoot: string,
  headSha?: string,
  storyId?: string,
  options: ExecuteValidationPlanOptions = {},
): Promise<ValidationResult> {
  const commands: ValidationCommandResult[] = [];
  const details: string[] = [];
  const warnings = [...(plan.warnings ?? [])];
  const focus = plan.focus?.trim();
  if (focus) {
    details.push(`FOCUSED VALIDATE MODE focus=${focus}: not final full validation and not DONE-required proof.`);
  }

  for (let i = 0; i < plan.commands.length; i++) {
    const command = plan.commands[i];
    const result = await runValidationCommand(command, projectRoot, DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS, {
      progress: options.progress,
      heartbeatMs: options.heartbeatMs,
      commandIndex: i + 1,
      totalCommands: plan.commands.length,
      abortSignal: options.abortSignal,
      deadlineAt: options.deadlineAt,
      deadlineError: options.deadlineError,
    });
    if (
      result.timedOut
      && typeof options.deadlineAt === 'number'
      && Date.now() >= options.deadlineAt
    ) {
      throw options.deadlineError?.() ?? new Error(`validation plan deadline exceeded at ${options.deadlineAt}`);
    }
    commands.push(result);

    const failed = result.code !== 0 || Boolean(result.timedOut);
    const mark = failed ? (result.optional ? '⚠' : '✗') : '✓';
    const suffix = result.timedOut ? ' (timed out)' : '';
    details.push(`${mark} ${result.label}: ${formatValidationCommand(command)}${suffix}`.trim());
    if (result.timedOut) {
      details.push(...formatTimeoutDiagnostics(command, result, i + 1, plan.commands.length));
    }
    if (result.output.trim()) {
      details.push(...result.output.trim().split('\n').filter(Boolean).map((line) => `  ${line}`));
    }
    details.push(...formatWorktreePollutionDetails(result, projectRoot, storyId));
    if (failed && result.optional) {
      warnings.push(`optional validation failed: ${result.label}`);
    }
  }

  const requiredFailures = commands.filter((r) => !r.optional && (r.code !== 0 || r.timedOut));
  const optionalFailures = commands.filter((r) => r.optional && (r.code !== 0 || r.timedOut));
  const requiredInfraFailures = requiredFailures.filter((r) => r.failureKind === 'infra_failure');
  // Task B-4b22: pollution only counts as failure if dirty-gate-policy
  // marked it blocking. Passing-only category pollution (lattice_metadata /
  // runtime_artifact / declared_artifact) is allowed and audited.
  const pollutionFailures = commands.filter((r) => {
    if (!r.worktreePollution || r.worktreePollution.statusLines.length === 0) return false;
    // blocking undefined → legacy back-compat: treat as blocking.
    return r.worktreePollution.blocking !== false;
  });
  const allPass = requiredFailures.length === 0 && pollutionFailures.length === 0;
  const status = allPass ? (optionalFailures.length > 0 || warnings.length > 0 ? 'warn' : 'pass') : 'fail';
  const failureKind: ValidationFailureKind | undefined = allPass
    ? undefined
    : requiredInfraFailures.length > 0
      ? 'infra_failure'
      : 'validation_failure';
  const baseSummary = allPass
    ? optionalFailures.length > 0
      ? 'Required validation commands passed with optional failures'
      : 'Project validation commands passed'
    : pollutionFailures.length > 0 && requiredFailures.length === 0
      ? 'Project validation commands dirtied the worktree'
    : 'Project validation commands failed';

  return {
    provider: focus ? `${plan.provider}-focused` : plan.provider,
    status,
    allPass,
    ...(failureKind ? { failureKind } : {}),
    summary: focus
      ? `Focused validation (${focus}): ${baseSummary}; not final full validation or DONE-required proof`
      : baseSummary,
    details,
    warnings,
    timestamp: new Date().toISOString(),
    ...(headSha ? { headSha } : {}),
    commands,
    ...(focus ? { focus: { name: focus, mode: 'focused' as const, finalFullValidation: false as const, doneRequiredProof: false as const } } : {}),
  };
}
