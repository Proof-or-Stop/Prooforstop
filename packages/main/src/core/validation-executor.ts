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
import { readBrandEnv } from './brand-env.js';

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

/**
 * B-cdf6 (B-META F-012): hard cap for a per-evidence pinned-command timeout override.
 *
 * A verification intent whose proof IS "the root DONE-blocking suite passes" could not be
 * witnessed by a tool-executed receipt: the evidence path always ran the pinned command
 * under {@link DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS} (270s) while that suite takes 21-24
 * min, so the run was KILLED and no verdict was ever printed. The framework already knew
 * this command legitimately needs longer — lattice.config.json gives the same `npm test`
 * a 7200000ms budget as a DONE-required command — so the cap is set to exactly that
 * value: the longest budget the framework itself sanctions. A request ABOVE the cap is
 * REFUSED, never silently clamped.
 *
 * Canonical single source of truth: the CLI schema (`command-catalog.ts`) and the handler
 * enforcement boundary (`handlers/checklist.ts`) both import THIS constant, so the Zod
 * bound and the runtime re-validation can never drift apart.
 */
export const EVIDENCE_COMMAND_TIMEOUT_CAP_MS = 7_200_000;
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
  const raw = Number(readBrandEnv('VALIDATE_HEARTBEAT_MS', env));
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
 * This constant is a THRESHOLD, not a promise. Deliberately, no guarantee about bounding behaviour
 * is restated here.
 *
 * The paragraph that used to sit at this spot described what boundValidationEvidenceOutput
 * guaranteed, and it was wrong three separate times - not because anyone wrote it carelessly, but
 * because it restated behaviour owned three hundred lines away, and each time that behaviour moved
 * the sentence stayed. Its own text advised re-reading a sentence whenever the behaviour changes,
 * and it then became the third counterexample to that advice.
 *
 * So the durable fix is not a more careful sentence. It is to stop duplicating the claim: what the
 * bounding does, and what it leaves open, is described where it is performed - on
 * boundPersistedValidationEvidence, measurePersistedEvidenceBytes and snapshotPersistedRecord.
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
   * Whether the REDUCED INNER STRING is under the bound. This is not the guarantee: the artifact
   * that has to fit is the serialised TestEvidenceData file, whose second stringify escapes this
   * string again and can double it. boundPersistedValidationEvidence owns that measurement. Kept
   * because the reducer reports what it achieved; read `withinBound` on the persisted result for
   * the file-level measurement.
   */
  outputWithinBound: boolean;
  /** Command entries kept, but with their captured output replaced by a visible marker. */
  elidedCommandOutputs: number;
  /** Command entries dropped from the array, reported as a count. */
  elidedCommandEntries: number;
  /**
   * Detail lines replaced by a marker. executeValidationPlan copies every captured output line
   * into `details`, so this is the SECOND copy of the same bytes and is usually the larger one.
   */
  elidedDetailLines: number;
  /** Warning entries dropped from the array, reported as a count. */
  elidedWarnings: number;
}

export interface BoundedValidationEvidenceOutput extends ValidationEvidenceSizing {
  /** The serialised artifact: JSON, with the pass/fail fields carried through the reduction. */
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
 * The operator-facing size text.
 *
 * On the advisory paths it is deliberately worded as information - no failure vocabulary, no cross
 * or warning glyph - so a reader scanning output cannot mistake it for a failing check. The refusal
 * path is NOT one of those: there the evidence write does not happen, and the text says so plainly
 * rather than reassuring. Which wording applies is decided by `disposition` below; this comment
 * does not enumerate the cases, because the last three defects in this file were sentences that
 * enumerated something the code then changed.
 */
export function formatValidationEvidenceAdvisory(persisted: PersistedValidationEvidenceBound): string | null {
  if (persisted.state === 'within_budget') return null;
  // The wording deliberately avoids every failure token, so a reader scanning validate output
  // cannot mistake this line for a check that did not pass - EXCEPT on the refusal path, where the
  // write genuinely does not happen and saying otherwise would be the inaccuracy.
  const head = `evidence size advisory (informational; the validate verdict is unchanged): `
    + `the serialised test-evidence.json file is ${formatBytes(persisted.fileBytes)}, `
    + `past the ${formatBytes(VALIDATION_EVIDENCE_ADVISORY_BYTES)} advisory threshold, which is `
    + `${Math.round(VALIDATION_EVIDENCE_ADVISORY_FRACTION * 100)}% of the `
    + `${formatBytes(VALIDATION_EVIDENCE_READ_CEILING_BYTES)} metadata read ceiling.`;
  if (persisted.state === 'advisory') {
    return `${head} The file grows with the number of lattice.config.json validate.commands entries; `
      + `it is bounded at ${formatBytes(VALIDATION_EVIDENCE_BOUND_BYTES)}.`;
  }
  const sizing = persisted.sizing;
  const reductions = sizing
    ? ` ${sizing.elidedCommandOutputs} command output(s) and ${sizing.elidedDetailLines} detail line(s) `
      + `were replaced by markers, and ${sizing.elidedWarnings} warning(s) and `
      + `${sizing.elidedCommandEntries} command entry(ies) summarised by count.`
    : '';
  if (persisted.disposition === 'refused') {
    // Not an advisory any more: this states a refusal, so it must read as one.
    return `evidence size limit reached: the serialised test-evidence.json file measures `
      + `${formatBytes(persisted.fileBytes)}, above the ${formatBytes(VALIDATION_EVIDENCE_BOUND_BYTES)} bound, `
      + `and could not be reduced.${reductions} The evidence write is refused rather than storing a file `
      + `the metadata read cannot consume; validate itself reported its own verdict separately.`;
  }
  const replaced = persisted.disposition === 'verdict_only'
    ? ` The reduced result was still too large inside the record, so the output field was replaced by a `
      + `verdict-only summary that names itself as a replacement.`
    : '';
  return `${head} It reached the ${formatBytes(VALIDATION_EVIDENCE_BOUND_BYTES)} bound, so the file was `
    + `written at ${formatBytes(persisted.fileBytes)}.${reductions}${replaced} `
    + `Per-command output remains available in the validate console output.`;
}

/**
 * The cap safeScalarRead applies to every string it returns, in UTF-16 units. B-3434:F-034: this
 * used to be a figure written into a comment 250 lines from the `slice` that enforced it, so the
 * two could disagree without anything noticing. One constant, both sites.
 */
const VALIDATION_EVIDENCE_SCALAR_CHAR_CAP = 200;

/**
 * The fields the last-resort record carries. Every one is coerced to a short scalar by
 * safeScalarRead, so the record's size is a function of THIS LIST and that cap rather than of the
 * input.
 *
 * No byte figure is stated here. The figure that used to be - "low hundreds of bytes" - was picked
 * by hand and was wrong by an order of magnitude: four of these keys are string-capable, each capped
 * at VALIDATION_EVIDENCE_SCALAR_CHAR_CAP UTF-16 units, and a 4-byte character costs 4 bytes each,
 * which puts the packed worst case in the low thousands. The verdict_only section of
 * tasks/validation-evidence-buffer-smoke.ts measures the realised size on every run and asserts the
 * ceiling it actually meets, so the number lives where it is checked rather than where it is only
 * read.
 */
const VALIDATION_EVIDENCE_VERDICT_ONLY_RECORD_KEYS = [
  'provider',
  'status',
  'allPass',
  'allPassed',
  'failureKind',
  'summary',
] as const;

/**
 * How much of an array to keep, from the measured overshoot. Clamped well below 1 so every step is
 * a real reduction, and floored so a wild overshoot does not collapse the array in one go when two
 * cheap steps would have kept more evidence.
 */
function targetRatio(bytes: number, budget: number): number {
  return Math.max(0.1, Math.min(0.9, (budget * 0.85) / Math.max(1, bytes)));
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
 * Reduce a validation result for the evidence artifact until a caller-supplied predicate is
 * satisfied.
 *
 * Bounding is structural, never a string truncation: consumers parse this field (an unparseable
 * artifact is rejected as output_invalid_json and blocks the phase gate), so the result stays valid
 * JSON and keeps allPass / allPassed / status exactly as given. Nothing is discarded silently.
 *
 * The `fits` predicate is the whole design. This function does NOT know what the caller is trying
 * to fit into: boundPersistedValidationEvidence passes a predicate that builds the full
 * TestEvidenceData and measures the FILE, so the reduction is driven by the bytes that reach disk
 * rather than by this string, which the outer serialisation escapes again. An earlier revision
 * estimated that expansion factor and made one corrective attempt; a heterogeneous artifact whose
 * realised expansion differed from the estimate then had a perfectly good reduced artifact thrown
 * away for a stub. Estimation is gone. Each stage is applied whole and then MEASURED.
 *
 *   stage 1 - replace every captured per-command output with a marker naming the omitted length.
 *   stage 2 - collapse the DUPLICATE of that output that executeValidationPlan copies into
 *             `details`, keeping the per-command status lines that make details navigable.
 *   stage 3 - replace `warnings` with a counted marker.
 *   stage 4 - halve the `details` tail until it fits, then stage 5 halves `commands` the same way.
 *
 * Halving rather than measuring per entry is a deliberate cost trade: it converges in O(log n)
 * measurements instead of O(n), at the price of removing up to twice as much as strictly needed on
 * the final step. It never removes anything without counting it.
 *
 * The input object is never mutated. `outputWithinBound` reports this string against the module
 * bound and is not the guarantee; boundPersistedValidationEvidence owns that.
 */
export function boundValidationEvidenceOutput(
  result: unknown,
  options: { measure?: (output: string) => number | null; budgetBytes?: number } = {},
): BoundedValidationEvidenceOutput {
  const budget = options.budgetBytes ?? VALIDATION_EVIDENCE_BOUND_BYTES;
  // The predicate returns a SIZE, not a boolean, so the array stages can size their next step from
  // the measurement instead of stepping blindly. Every step is still decided by a real measurement
  // and every step makes progress, so a step that lands short costs one more iteration - it never
  // discards what has already been reduced, which is the failure this replaced.
  const measure = options.measure ?? ((output: string) => Buffer.byteLength(output, 'utf8'));
  const sizeOf = (output: string): number => {
    const measured = measure(output);
    return measured === null ? Number.MAX_SAFE_INTEGER : measured;
  };
  const fits = (output: string): boolean => sizeOf(output) < budget;
  const serialized = safeJsonStringify(result);
  const measuredBytes = Buffer.byteLength(serialized ?? 'null', 'utf8');
  const base = {
    measuredBytes,
    ceilingBytes: VALIDATION_EVIDENCE_READ_CEILING_BYTES,
    advisoryBytes: VALIDATION_EVIDENCE_ADVISORY_BYTES,
    boundBytes: VALIDATION_EVIDENCE_BOUND_BYTES,
    state: classifyValidationEvidenceSize(measuredBytes),
  };
  const unreduced = serialized ?? 'null';
  if (!result || typeof result !== 'object' || fits(unreduced)) {
    return {
      ...base,
      serializedBytes: Buffer.byteLength(unreduced, 'utf8'),
      reduced: false,
      outputWithinBound: Buffer.byteLength(unreduced, 'utf8') < VALIDATION_EVIDENCE_BOUND_BYTES,
      elidedCommandOutputs: 0,
      elidedCommandEntries: 0,
      elidedDetailLines: 0,
      elidedWarnings: 0,
      output: unreduced,
    };
  }

  const source = result as Record<string, unknown>;
  let commands = Array.isArray(source.commands) ? [...(source.commands as any[])] : [];
  let details = Array.isArray(source.details) ? [...(source.details as any[])] : [];
  let warnings = Array.isArray(source.warnings) ? [...(source.warnings as any[])] : [];
  let elidedCommandOutputs = 0;
  let elidedCommandEntries = 0;
  let elidedDetailLines = 0;
  let elidedWarnings = 0;

  const render = (): string => safeJsonStringify({
    ...source,
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
    },
  }) ?? unreduced;

  let output = render();

  // Stage 1.
  if (!fits(output)) {
    for (let index = 0; index < commands.length; index += 1) {
      const captured = commands[index]?.output;
      if (typeof captured !== 'string' || captured.length === 0) continue;
      commands[index] = { ...commands[index], output: elisionMarker(captured.length) };
      elidedCommandOutputs += 1;
    }
    output = render();
  }

  // Stage 2.
  if (!fits(output) && details.length > 0) {
    const collapsed = collapseDetailContinuationRuns(details as string[]);
    details = collapsed.details;
    elidedDetailLines += collapsed.elidedLines;
    output = render();
  }

  // Stage 3.
  if (!fits(output) && warnings.length > 0) {
    elidedWarnings += warnings.length;
    warnings = [countElisionMarker('warning(s)', elidedWarnings)];
    output = render();
  }

  // Stage 4. Size the step from the measurement, then re-measure. `keep` is always at least one
  // element smaller than the current length, so the loop cannot stall.
  let bytes = sizeOf(output);
  // The marker is appended ONCE, after the loop. Appending it per iteration made the array length
  // unchanged whenever the step was a single element - slice off one, push one - so the loop spun
  // forever on any artifact whose remaining bulk was not in `details`. Progress is now structural:
  // `keep` is strictly less than the current length and nothing is added back inside the loop.
  while (bytes >= budget && details.length > 0) {
    const keep = Math.max(0, Math.min(details.length - 1, Math.floor(details.length * targetRatio(bytes, budget))));
    elidedDetailLines += details.length - keep;
    details = details.slice(0, keep);
    output = render();
    bytes = sizeOf(output);
  }
  if (elidedDetailLines > 0) {
    details.push(countElisionMarker('detail line(s)', elidedDetailLines));
    output = render();
    bytes = sizeOf(output);
  }

  // Stage 5.
  while (bytes >= budget && commands.length > 0) {
    const keep = Math.max(0, Math.min(commands.length - 1, Math.floor(commands.length * targetRatio(bytes, budget))));
    elidedCommandEntries += commands.length - keep;
    commands = commands.slice(0, keep);
    output = render();
    bytes = sizeOf(output);
  }

  const serializedBytes = Buffer.byteLength(output, 'utf8');
  return {
    ...base,
    serializedBytes,
    reduced: true,
    outputWithinBound: serializedBytes < VALIDATION_EVIDENCE_BOUND_BYTES,
    elidedCommandOutputs,
    elidedCommandEntries,
    elidedDetailLines,
    elidedWarnings,
    output,
  };
}

/**
 * Read one property without trusting the object it comes from.
 *
 * A getter or a proxy trap can throw on property access, so every read of caller data inside the
 * fallback goes through here. This is the repair for a fallback whose own comment claimed it "reads
 * only scalars and cannot depend on the reduction having worked" while reading properties off the
 * original object outside any try.
 */
function safeScalarRead(source: Record<string, unknown>, key: string): unknown {
  let value: unknown;
  try {
    value = source[key];
  } catch {
    return undefined;
  }
  if (typeof value === 'string') return value.slice(0, VALIDATION_EVIDENCE_SCALAR_CHAR_CAP);
  return typeof value === 'boolean' || typeof value === 'number' ? value : undefined;
}

/**
 * The last-resort output field, sized by construction rather than by the input.
 *
 * Every value passes a cap and every read goes through safeScalarRead, so its serialised length is a
 * function of the key list above and that cap rather than of the input. The size itself is measured
 * by the smoke rather than restated here. It satisfies the consumer contract that matters at the
 * phase gate: valid JSON carrying allPass / allPassed / status, which is what outputPassState in
 * core/validation-evidence-admissibility.ts parses. And it names itself a replacement, so a reader
 * is not left thinking it is the whole evidence.
 */
function verdictOnlyRecord(source: unknown, measuredBytes: number): string {
  const record = source && typeof source === 'object' ? source as Record<string, unknown> : {};
  const carried: Record<string, unknown> = {};
  for (const key of VALIDATION_EVIDENCE_VERDICT_ONLY_RECORD_KEYS) {
    const value = safeScalarRead(record, key);
    if (value !== undefined) carried[key] = value;
  }
  const rendered = safeJsonStringify({
    ...carried,
    evidenceBound: {
      measuredBytes,
      boundBytes: VALIDATION_EVIDENCE_BOUND_BYTES,
      ceilingBytes: VALIDATION_EVIDENCE_READ_CEILING_BYTES,
      replacedWithVerdictOnlyRecord: true,
      reason: 'the reduced result did not fit inside the persisted record; the full result is available in the validate console output',
      carriedFields: [...VALIDATION_EVIDENCE_VERDICT_ONLY_RECORD_KEYS],
    },
  });
  // The constant floor: no input-derived value at all. Reached only if the capped scalars above are
  // themselves unserialisable, which nothing in JSON can be - but the floor costs one line and
  // removes the last "cannot happen" from this path.
  return rendered ?? JSON.stringify({
    evidenceBound: {
      measuredBytes,
      boundBytes: VALIDATION_EVIDENCE_BOUND_BYTES,
      replacedWithVerdictOnlyRecord: true,
      reason: 'the result could not be serialised at all; the full result is available in the validate console output',
    },
  });
}

/**
 * JSON.stringify that cannot throw.
 *
 * It can throw on a cycle, on a BigInt, and on any getter or proxy trap that raises during
 * serialisation. An earlier revision of this module claimed a fallback that "cannot fail" while
 * sitting on top of a call that can, so this returns null instead and lets the caller treat an
 * unserialisable input as the bounded case it is.
 */
function safeJsonStringify(value: unknown, indent?: number): string | null {
  try {
    const text = indent === undefined ? JSON.stringify(value) : JSON.stringify(value, null, indent);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * JSON.parse that cannot throw, guarded the same way safeJsonStringify is.
 *
 * The result is wrapped rather than returned bare because `null` is a legitimate parse of the text
 * "null", and a bare null would make a successful parse indistinguishable from a failed one - the
 * same conflation that would let a failure be treated as a value.
 */
function safeJsonParse(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** How the persisted record was brought under the bound, if it had to be. */
export type PersistedValidationEvidenceDisposition =
  | 'unmodified'
  | 'reduced'
  | 'verdict_only'
  | 'refused';

export interface PersistedValidationEvidenceBound<T = unknown> {
  /**
   * The record to persist, as plain JSON data: JSON.parse of the very serialisation fileBytes
   * counts, not the object buildRecord returned. Its `output` field carries the caller value unless
   * it had to be replaced.
   *
   * Null when no record could be built or measured. Every null record is reported with
   * withinBound false and disposition 'refused', so a caller that checks withinBound before writing
   * is checking this too - and the type says so, rather than a comment saying so.
   */
  record: T | null;
  /**
   * Byte length reported for `record`, measured in the format core/store.ts writes with. On every
   * path that produces a record today it comes from snapshotPersistedRecord, which counts one text
   * and parses that same text back. It reaches the single exit as a parameter beside `record`
   * rather than being re-derived there (B-3434:F-035).
   */
  fileBytes: number;
  /** Derived from fileBytes. False means: do not write this. */
  withinBound: boolean;
  disposition: PersistedValidationEvidenceDisposition;
  state: ValidationEvidenceSizingState;
  /** Reducer detail when the staged reduction ran; null when the input could not be serialised. */
  sizing: ValidationEvidenceSizing | null;
}

/**
 * Applies the format core/store.ts writes with - `JSON.stringify(data, null, 2) + '\n'` - to
 * whatever it is handed, and returns null instead of throwing when the value cannot be serialised.
 *
 * It measures the value AS GIVEN, at the moment it is given. It does not follow that value to disk,
 * and it describes that one reading: a `toJSON` that answers small now and large later defeats any
 * single reading of it. snapshotPersistedRecord narrows that route and records what it leaves open.
 *
 * The format is DUPLICATED from core/store.ts rather than shared with it, and it is NOT pinned. The
 * smoke does not import StoryStore; it re-types the same formula and compares two hand-written
 * copies, so a format change in store.ts moves both copies together, this measurement reads low,
 * and the assertions keep passing. Measured on a two-space to four-space change: the smoke compares
 * 158 to 158 while the writer emits 168. core/store.ts is outside this story's scope; the
 * divergence, its transcripts and the named repair are recorded in
 * docs/requirements/decisions/validation-evidence-artifact-growth.md.
 */
export function measurePersistedEvidenceBytes(record: unknown): number | null {
  const serialized = safeJsonStringify(record, 2);
  return serialized === null ? null : Buffer.byteLength(`${serialized}\n`, 'utf8');
}

/**
 * Serialise once, count those bytes, and hand back a parse of the same text. Best-effort narrowing,
 * not a settlement.
 *
 * The reason it is done in this order: a record is built by a caller-supplied closure over
 * caller-supplied data, so any node of it may be a getter, a Proxy or a `toJSON` - values that are
 * free to answer differently on each call. Measuring such an object and then returning IT means the
 * number describes one reading and the writer performs another. Parsing the measured text removes
 * the OWN properties that do that: what comes back holds strings, numbers, booleans, null, arrays
 * and plain objects, with no own toJSON, getter or Proxy trap, and `bytes` is the length of the text
 * it was parsed from.
 *
 * It does NOT survive an inherited toJSON. JSON.parse returns objects whose prototype is the live
 * Object.prototype, so a toJSON installed there is consulted again when the writer serialises.
 * Measured through the real StoryStore, on a record the builder produced as a fresh plain object
 * literal: 67 bytes reported and within bound, 31,457,342 bytes on disk against a 25,165,824-byte
 * bound. Closing that route means one serialisation owned by the writer, in core/store.ts, which is
 * out of this story's scope.
 *
 * Returns null if either step fails, which the caller treats as "no record" rather than a small one.
 */
function snapshotPersistedRecord<T>(record: T): { record: T; bytes: number } | null {
  const measured = safeJsonStringify(record, 2);
  if (measured === null) return null;
  const parsed = safeJsonParse(measured);
  if (parsed === null) return null;
  // Re-serialised from the parsed copy rather than reusing `measured`: the returned value is what a
  // writer will stringify, so the count comes from stringifying that same value. For plain data the
  // two texts are identical; where they could differ, this is the one that describes the record
  // being handed back.
  const settled = safeJsonStringify(parsed.value, 2);
  if (settled === null) return null;
  return { record: parsed.value as T, bytes: Buffer.byteLength(`${settled}\n`, 'utf8') };
}

/**
 * The size decision, made over the record that is about to be written.
 *
 * The reducer produces an inner `output` string. That is not what has to fit: StoryStore
 * stringifies the whole TestEvidenceData a SECOND time, escaping every character of that string
 * again, so quote-heavy captured output roughly doubles on the way to disk - measured at x1.99 with
 * 400 commands. Bounding the inner string alone left a reachable wedge where an in-bound string
 * produced an out-of-bound file, the metadata commit failed on the blob ceiling, and no story could
 * persist evidence.
 *
 * So the reduction is DRIVEN by a predicate that measures the file, and the result is measured
 * again before it is returned. Three outcomes, all measured:
 *
 *   reduced / unmodified - the record fits; write it.
 *   verdict_only         - reduction could not fit an OBJECT result, so the output field is
 *                          replaced by a record sized by construction.
 *   refused              - it still does not fit, the input had no structure to reduce, or no
 *                          record could be built or measured at all. The caller must not write
 *                          this; withinBound is false, `record` may be null, and both say so.
 *
 * Degenerate inputs are routed rather than propagated: serialisation goes through
 * safeJsonStringify, parses through safeJsonParse, and reads of caller data through safeScalarRead,
 * so a cyclic, BigInt or throwing-accessor input arrives at one of the outcomes above instead of at
 * an exception. The smoke exercises cyclic, BigInt, always-throwing-getter and throwing-proxy inputs
 * against this.
 *
 * What this does NOT establish is that `fileBytes` equals the bytes StoryStore writes. Routes by
 * which they diverge are open and measured: a serialisation format duplicated from core/store.ts
 * rather than shared with it (measurePersistedEvidenceBytes), an inherited toJSON on the shared
 * prototype (snapshotPersistedRecord), and a caller that mutates the returned record between the
 * gate and the write (B-3434:F-037).
 *
 * Every disposition, the refusal included, runs its record through snapshotPersistedRecord. The
 * plain-data shape of the RETURNED record comes from the terminal call alone: the reduction loop
 * consumes only `.bytes` from the snapshots it takes and discards their records (B-3434:F-036).
 */
export function boundPersistedValidationEvidence<T>(args: {
  result: unknown;
  buildRecord: (output: string) => T;
}): PersistedValidationEvidenceBound<T> {
  const serializedResult = safeJsonStringify(args.result);
  const measuredBytes = Buffer.byteLength(serializedResult ?? 'null', 'utf8');
  const finish = (
    record: T | null,
    fileBytes: number,
    disposition: PersistedValidationEvidenceDisposition,
    sizing: ValidationEvidenceSizing | null,
  ): PersistedValidationEvidenceBound<T> => (record === null
    // No record is not a small record. Forcing the refusal here, at the single exit, is what makes
    // `record: T | null` readable as "a null record is not writable": no caller has to know which of
    // the branches below produced the null. The other half - that `fileBytes` describes THIS record
    // - is convention rather than structure at this exit: both arrive as separate parameters and
    // neither is re-derived from the other (B-3434:F-035).
    ? {
      record: null,
      fileBytes: Number.MAX_SAFE_INTEGER,
      withinBound: false,
      disposition: 'refused',
      state: classifyValidationEvidenceSize(Number.MAX_SAFE_INTEGER),
      sizing,
    }
    : {
      record,
      fileBytes,
      withinBound: fileBytes < VALIDATION_EVIDENCE_BOUND_BYTES,
      disposition,
      state: classifyValidationEvidenceSize(fileBytes),
      sizing,
    });
  const measureWith = (output: string): { record: T | null; bytes: number | null } => {
    try {
      const snapshot = snapshotPersistedRecord(args.buildRecord(output));
      return snapshot === null ? { record: null, bytes: null } : snapshot;
    } catch {
      // A builder that throws produces no record at all. The previous revision manufactured one by
      // calling the same builder again with a different argument - an unguarded call, in the one
      // place reached only because that builder had just thrown, and two of the four call sites of
      // this helper have no outer try to catch it. There is nothing to build from: say so.
      return { record: null, bytes: null };
    }
  };

  // A non-object result has no structure to reduce, and substituting a verdict-only record for it
  // would be an invention rather than a reduction: there are no verdict fields on a string to
  // carry, so the artifact would claim neither allPass nor status. Report it honestly instead - an
  // unreducible oversized input is refused, which is the contract the smoke has always asserted.
  //
  // Arrays are named explicitly because `typeof [] === 'object'` puts them on the wrong side of that
  // test. An array has no `commands`, `details` or `warnings` for the reducer to work on and no
  // verdict fields for the fallback to carry, so it used to arrive at a verdict-only record that
  // asserted neither allPass nor status while reporting success - the exact invention this branch
  // refuses to perform for a string.
  if (!args.result || typeof args.result !== 'object' || Array.isArray(args.result)) {
    const plain = measureWith(serializedResult ?? 'null');
    if (plain.bytes === null) return finish(plain.record, Number.MAX_SAFE_INTEGER, 'refused', null);
    return finish(
      plain.record,
      plain.bytes,
      plain.bytes < VALIDATION_EVIDENCE_BOUND_BYTES ? 'unmodified' : 'refused',
      null,
    );
  }

  let sizing: ValidationEvidenceSizing | null = null;
  // An object that cannot be serialised at all - a cycle, a BigInt, a throwing accessor - has no
  // reduction to attempt. Routing it straight to the fallback matters beyond tidiness: the reducer
  // would otherwise emit the literal `null`, which a consumer parses as valid JSON that simply is
  // not allPass. That is a silent not-a-pass where a stated replacement belongs.
  try {
    if (serializedResult === null) throw new Error('result is not serialisable');
    // The predicate is what makes the reduction converge on the FILE rather than on an estimate of
    // it: every stage boundary inside the reducer measures the record this callback builds.
    const bounded = boundValidationEvidenceOutput(args.result, {
      measure: (output) => measureWith(output).bytes,
      budgetBytes: VALIDATION_EVIDENCE_BOUND_BYTES,
    });
    sizing = bounded;
    const reduced = measureWith(bounded.output);
    if (reduced.bytes !== null && reduced.bytes < VALIDATION_EVIDENCE_BOUND_BYTES) {
      return finish(reduced.record, reduced.bytes, bounded.reduced ? 'reduced' : 'unmodified', sizing);
    }
  } catch {
    // A throwing accessor can raise anywhere in the reduction or in buildRecord. Fall through to
    // the fallback, which reads nothing without a guard.
  }

  const fallback = measureWith(verdictOnlyRecord(args.result, measuredBytes));
  if (fallback.bytes === null) return finish(fallback.record, Number.MAX_SAFE_INTEGER, 'refused', sizing);
  if (fallback.bytes < VALIDATION_EVIDENCE_BOUND_BYTES) {
    return finish(fallback.record, fallback.bytes, 'verdict_only', sizing);
  }
  return finish(fallback.record, fallback.bytes, 'refused', sizing);
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
  /**
   * B-cdf6 (B-META F-012): the wall-clock ceiling this run was ACTUALLY armed with —
   * the caller's `options.timeoutMs` when supplied, else
   * {@link DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS}, after
   * {@link resolveCommandTimeoutMs} clamping. Reported back so a caller that must
   * refuse a killed run can NAME the budget it was killed at instead of forcing the
   * operator to guess (the F-012 misdiagnosis: three attempts read only the absent
   * selector and never learned a 270s ceiling existed).
   */
  timeoutMs: number;
}

/**
 * B-ec67: run ONE allowlisted pinned command via the shared {@link runValidationCommand}
 * spawn path (per-command timeout, output capture, no shell on POSIX). Used by the
 * evidence-write handler to derive a tool-owned receipt from the actual exit + output.
 *
 * B-cdf6 (B-META F-012): `options.timeoutMs` was always accepted here but no production
 * caller passed it, so every pinned evidence command ran under the 270s default and a
 * longer witness (the root DONE-blocking suite takes 21-24 min) could never earn a
 * receipt. The returned `timeoutMs` is the effective armed ceiling, so `timedOut` can be
 * reported as a DISTINCT timeout refusal naming the budget.
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
    // runValidationCommand always stamps the effective (clamped, deadline-capped) ceiling,
    // but ValidationCommandResult.timeoutMs is optional for legacy/stub producers — fall
    // back to the same resolver so the reported budget is never undefined. A refusal that
    // has to NAME the budget must always have one.
    timeoutMs: result.timeoutMs ?? resolveCommandTimeoutMs(validationCommand),
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
