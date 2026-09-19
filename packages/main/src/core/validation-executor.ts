import { validationReservationChildEnvironment, validationReservationChildStdio, registerValidationReservationChild, prepareValidationReservationChild, cancelValidationReservationChild, noteValidationReservationSpawn, unregisteredValidationReservationChildGone, validationReservationOwnedGroupSignalTarget, observeValidationReservationChild, attemptValidationReservationSpawn, currentValidationReservationAbortSignal, currentValidationReservationDeadline, isValidationDelegationError } from './validation-reservation-delegation.js';
import { isWithinValidationEvidenceWriteBound } from './validation-evidence-size-policy.js';
import { withValidationPlanStages, withValidationCommandStage } from './validation-execution-lock.js';
import { VALIDATION_RUNTIME_TRACE_POLICY, VALIDATION_SOURCE_PROVENANCE_SCHEMA, VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY, MACHINE_FIXED_PORT_RUNTIME_POLICY } from './runtime-fact-registry.js';
import { isValidationCapacityWaitDeadlineError, withMachineValidationResources } from './validation-execution-lock.js';
import { executeSharedValidationCommand, type SharedValidationExecutionContext } from './shared-validation-execution.js';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { loadConfig, type EvidenceCommandTimeoutOverrideConfig } from './config.js';
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
import { bindLaunchDirectoryIdentity, canonicalizeExistingPath, currentBuildArtifactsHash, isRegisteredPackagesMainBuildCommand, launchDirectoryDrift, launchDirectoryOf, type LaunchDirectoryIdentity } from './build-artifacts-identity.js';
import { BUILD_ONLY_PROTECTION_LABEL, REGISTERED_BUILD_PROTECTION_LABEL, artifactProtectionSatisfied, artifactProtectionStale, hasAnyArtifactRoot, resolveArtifactWriteProtection, weakestProtectionLabel, type ArtifactWriteProtection } from './build-artifacts-protection.js';
import {
  canonicalizeEntries,
  MAX_JOBS,
  parsePositiveInteger,
  runScheduled,
  validateResourceClaims,
  type ResourceClaim,
  type SchedulableEntry,
  type SchedulableResult,
  type ScheduledStatus,
} from './keyed-scheduler.js';
import type {
  ConcurrentWorktreePollution,
  ConcurrentWorktreePollutionAttribution,
  ValidationCommand,
  ValidationCommandResult,
  ValidationFailureKind,
  ValidationPlan,
  ValidationProgressEvent,
  ValidationProgressReporter,
  ValidationResult,
} from './validation-types.js';
import { effectiveValidationCommandEnvironment } from './validation-command-environment.js';
import { closedEnvironmentForVerificationReuseCapsuleInvocation } from './verification-reuse-capsule.js';
import { METADATA_BLOB_READ_MAX_BUFFER_BYTES } from './done-prepare-generated-metadata.js';
import { readBrandEnv } from './brand-env.js';

const MAX_OUTPUT_CHARS = 12000;

/**
 * Default hard per-command ceiling applied when a validate command sets no explicit
 * `timeoutMs`. This is a TOTAL WALL-CLOCK ceiling per command — distinct from the
 * cli-engine global watchdog, which fires only after ~300s of NO OUTPUT (idle). Kept
 * strictly BELOW that global watchdog (300_000ms = 5*60*1000; overridable via the
 * PROOF_OR_STOP_IDLE_TIMEOUT_MS env var) so a hung/slow command is killed and ATTRIBUTED
 * (exit 124) here first, instead of the global watchdog silently force-exiting the whole
 * validate (which never re-stamps test-evidence.materialHash and silently blocks DONE for
 * every story). It is also kept ABOVE the observed full-validation incident envelope
 * (~171s) with margin; a command that genuinely needs longer can raise
 * `proof-or-stop.config.json` validate.commands[].timeoutMs (the build is pinned there to 290s
 * to keep near-watchdog headroom for a cold-cache compile). NOTE: lowering
 * PROOF_OR_STOP_IDLE_TIMEOUT_MS below this default would invert the invariant — an advanced,
 * non-default override the operator owns.
 */
export const DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS = 270_000;

const RUNTIME_TRACE_DIR = '.proof-or-stop/runtime/validation-traces';
const RUNTIME_TRACER_RELATIVE_PATH = 'packages/main/src/core/validation-runtime-tracer.cjs';

function runtimeTracerPath(projectRoot: string): string | undefined {
  const candidate = resolve(projectRoot, RUNTIME_TRACER_RELATIVE_PATH);
  return existsSync(candidate) ? candidate : undefined;
}

type RuntimeTraceFragment = {
  schemaVersion?: unknown; unknownRuntimeInputs?: unknown;
  readPaths?: unknown; loadedPaths?: unknown; spawnedPaths?: unknown;
  registryKeys?: unknown; environmentKeys?: unknown; events?: unknown;
};

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('runtime trace field must be a string array');
  return value as string[];
}

/** Collect the legacy trace or every child-safe sidecar for one command. */
function readRuntimeTraceFragments(traceFile: string): {
  observed?: { readPathSchema: string; unknownRuntimeInputs: string[]; readPaths: string[]; loadedPaths: string[]; spawnedPaths: string[]; registryKeys: string[]; environmentKeys: string[]; events: string[] };
  files: string[];
  malformed: boolean;
} {
  const base = basename(traceFile);
  const directory = dirname(traceFile);
  let files: string[] = [];
  try {
    files = readdirSync(directory)
      .filter(name => name === base || name.startsWith(`${base}.`))
      .map(name => join(directory, name))
      .sort();
  } catch {
    return { files: [], malformed: false };
  }
  if (files.length === 0) return { files, malformed: false };
  const merged = {
    unknownRuntimeInputs: new Set<string>(),
    readPaths: new Set<string>(), loadedPaths: new Set<string>(), spawnedPaths: new Set<string>(),
    registryKeys: new Set<string>(), environmentKeys: new Set<string>(), events: new Set<string>(),
  };
  try {
    for (const file of files) {
      const fragment = JSON.parse(readFileSync(file, 'utf8')) as RuntimeTraceFragment;
      if (!fragment || fragment.schemaVersion !== VALIDATION_RUNTIME_TRACE_POLICY.schemaVersion) throw new Error('legacy or unsupported runtime trace schema');
      for (const value of stringValues(fragment.unknownRuntimeInputs)) merged.unknownRuntimeInputs.add(value);
      for (const value of stringValues(fragment.readPaths)) merged.readPaths.add(value);
      for (const value of stringValues(fragment.loadedPaths)) merged.loadedPaths.add(value);
      for (const value of stringValues(fragment.spawnedPaths)) merged.spawnedPaths.add(value);
      for (const value of stringValues(fragment.registryKeys)) merged.registryKeys.add(value);
      for (const value of stringValues(fragment.environmentKeys)) merged.environmentKeys.add(value);
      for (const value of stringValues(fragment.events)) merged.events.add(value);
    }
  } catch {
    return { files, malformed: true };
  }
  return {
    files,
    malformed: false,
    observed: {
      readPathSchema: VALIDATION_RUNTIME_TRACE_POLICY.schemaVersion, unknownRuntimeInputs: [...merged.unknownRuntimeInputs],
      readPaths: [...merged.readPaths], loadedPaths: [...merged.loadedPaths], spawnedPaths: [...merged.spawnedPaths],
      registryKeys: [...merged.registryKeys], environmentKeys: [...merged.environmentKeys], events: [...merged.events],
    },
  };
}

/**
 * B-cdf6 (B-META F-012): hard cap for a per-evidence pinned-command timeout override.
 *
 * A verification intent whose proof IS "the root DONE-blocking suite passes" could not be
 * witnessed by a tool-executed receipt: the evidence path always ran the pinned command
 * under {@link DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS} (270s) while that suite takes 21-24
 * min, so the run was KILLED and no verdict was ever printed. The framework already knew
 * this command legitimately needs longer — proof-or-stop.config.json gives the same `npm test`
 * a 7200000ms budget as a DONE-required command — so the cap is set to exactly that
 * value: the longest budget the framework itself sanctions. A request ABOVE the cap is
 * REFUSED, never silently clamped.
 *
 * Canonical single source of truth: the CLI schema (`command-catalog.ts`) and the handler
 * enforcement boundary (`handlers/checklist.ts`) both import THIS constant, so the Zod
 * bound and the runtime re-validation can never drift apart.
 */
export const EVIDENCE_COMMAND_TIMEOUT_CAP_MS = 21_600_000;
export const DEFAULT_VALIDATE_HEARTBEAT_MS = 30_000;
/** Node clamps larger setTimeout delays to ~1ms and emits TimeoutOverflowWarning. */
export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export interface RunValidationCommandOptions {
  sharedExecution?: SharedValidationExecutionContext;
  progress?: ValidationProgressReporter;
  commandIndex?: number;
  totalCommands?: number;
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
  /** Exact tool-owned environment for the canonical reuse capsule only. */
  exactEnvironment?: Record<string, string>;
  /**
   * Denies this command and every process it spawns the right to write the
   * compiled artifacts. Applied at the spawn boundary only: the recorded
   * command, args and every identity derived from them stay the command the
   * plan declared, never the wrapper.
   */
  artifactWriteProtection?: ArtifactWriteProtection;
  /**
   * Binds the command to the compiled artifacts it executes: the root whose
   * trees are digested immediately before the child launches and immediately
   * after it returns, and the protection label the caller decided for it. The
   * observations are taken at the spawn boundary, so a result served from the
   * shared-execution cache carries the provenance of the run that was actually
   * executed (bound into its reuse key), never a fresh observation.
   */
  artifactBinding?: { root: string; configRoot?: string; protection: string };
  /**
   * The CANONICAL directory this command runs in under protection, resolved
   * by the caller ONCE before the first launch of its plan or run. Resolving
   * it at spawn time would follow an alias to wherever it points by then.
   */
  launchCwd?: string;
  /**
   * The filesystem identity bound to launchCwd when it was pinned. The
   * directory is re-verified against it (and its path re-resolved) before
   * the cache is consulted and again immediately before the spawn: a
   * directory renamed away, replaced by a link or by another directory
   * between the pin and the launch refuses the launch instead of running,
   * and being attributed to, the pinned directory.
   */
  launchIdentity?: LaunchDirectoryIdentity;
}

interface CapturedValidationCommandResult {
  result: ValidationCommandResult;
  /** Complete ANSI-stripped output, retained only for the pinned-evidence consumer. */
  completeOutput: string;
}

export interface ExecuteValidationPlanOptions {
  progress?: ValidationProgressReporter;
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
  /** Scheduler worker count; overrides PROOF_OR_STOP_VALIDATE_JOBS. See {@link resolveValidatePlanJobs}. */
  jobs?: number;
  /** Refuse each child launch if the caller's preflight snapshot is no longer valid. */
  beforeLaunch?: () => void;
  /**
   * The resolved git working directory whose compiled artifacts the commands
   * execute and publication binds (the verifier passes its own resolved cwd so
   * execution, publication, reuse and admission digest one root). Defaults to
   * resolveProjectGitCwd(projectRoot), exactly as runValidationCommand resolves
   * its dirty-status probe: the configured gitRoot on a wrapper-root layout,
   * projectRoot verbatim on a plain repository.
   */
  gitCwd?: string;
  /**
   * Canonical launch directories FROZEN by the caller for this plan, one per
   * plan command in plan order (undefined entries are pinned here). A dynamic
   * run passes the directories it bound at planning so that every wave,
   * shard and oracle launches exactly where the planning identity says.
   */
  launchCwds?: readonly (string | undefined)[];
  /** The identities bound to `launchCwds` at planning, in the same order; bound at plan start for any entry without one. */
  launchIdentities?: readonly (LaunchDirectoryIdentity | undefined)[];
}

/**
 * Worker count for the routine-validate plan scheduler.
 *
 * 4 is the same default the full test-suite runner (tasks/full-suite-runner.ts)
 * has been running on since it moved onto this scheduler, so the two callers of
 * `runScheduled` behave alike and one number is tuned instead of two. It is also
 * the right order of magnitude here for reasons specific to this plan:
 *
 *  - Admission control, not this number, is what keeps the run correct: an
 *    undeclared command holds the plan-wide barrier exclusively, so raising the
 *    worker count can never make an unclassified command overlap anything.
 *    Today most configured commands are undeclared, which caps the achievable
 *    concurrency well below 4 for long stretches of the plan; workers past that
 *    point sit idle rather than helping.
 *  - Each validate command is itself a process tree (npm / tsc / node spawning
 *    children), so the effective load is a multiple of the worker count. Four
 *    concurrent trees is already a heavy machine on a typical 8-10 core host,
 *    and oversubscribing inflates every command's wall time — which is the same
 *    number the per-command `timeoutMs` ceilings are calibrated against.
 */
export const DEFAULT_VALIDATE_PLAN_JOBS = 4;

/**
 * Resolve the scheduler worker count: explicit `jobs` option, else the
 * `PROOF_OR_STOP_VALIDATE_JOBS` env var, else {@link DEFAULT_VALIDATE_PLAN_JOBS}.
 *
 * A PRESENT but unparseable / out-of-range value is REFUSED rather than
 * silently replaced by the default: an operator who sets this has a reason, and
 * quietly ignoring the setting turns "why is validate still slow / still
 * parallel" into an unanswerable question. Absent or empty is not a setting, so
 * it takes the default. `jobs=1` is a legitimate setting — it degrades to
 * strict plan-order sequential execution, which is exactly the pre-scheduler
 * behaviour.
 */
export function resolveValidatePlanJobs(env: NodeJS.ProcessEnv = process.env, override?: number): number {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 1 || override > MAX_JOBS) {
      throw new Error(`validate plan jobs must be an integer between 1 and ${MAX_JOBS}`);
    }
    return override;
  }
  const raw = env.PROOF_OR_STOP_VALIDATE_JOBS?.trim();
  if (!raw) return DEFAULT_VALIDATE_PLAN_JOBS;
  return parsePositiveInteger(raw, 'PROOF_OR_STOP_VALIDATE_JOBS');
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
    `  timeout diagnostic: command ${commandIndex}/${totalCommands} "${command.label}" reached its execution deadline; configured timeoutMs=${timeout}, effective timeoutMs=${result.effectiveTimeoutMs ?? timeoutMs}ms, elapsedMs=${result.durationMs}.`,
    `  command: ${command.command}`,
    `  args: ${JSON.stringify(command.args)}`,
    '  If this command legitimately needs longer, raise proof-or-stop.config.json validate.commands[].timeoutMs for that command; otherwise investigate a hung validation command.',
  ];
}

/**
 * Id-independent git cwd of a validation plan: the configured gitRoot subdir on
 * a wrapper-root layout, projectRoot verbatim on a plain repository or when
 * nothing resolves. Shared by the dirty-status probe and the artifact digests
 * so both observe the repository the commands actually execute.
 */
function resolvePlanGitCwd(projectRoot: string): string {
  try {
    return resolveProjectGitCwd(projectRoot, projectRoot, loadConfig(projectRoot));
  } catch {
    return projectRoot;
  }
}

function commandCwd(projectRoot: string, cwd?: string): string {
  return launchDirectoryOf(projectRoot, cwd);
}

function trimOutput(output: string, retainFailureTail: boolean): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  // Receipts verify exact selectors against this bounded capture. Retaining
  // only the prefix made successful commands whose terminal proof line is at
  // EOF indistinguishable from a selector-absent command. Keep both ends while
  // preserving the same hard cap and making the omitted middle explicit.
  let marker = '\n...[truncated output; retained prefix and suffix]...\n';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retained = Math.max(0, MAX_OUTPUT_CHARS - marker.length);
    const omitted = output.length - retained;
    marker = `\n...[truncated ${omitted} chars; retained prefix and suffix]...\n`;
  }
  const retained = Math.max(0, MAX_OUTPUT_CHARS - marker.length);
  const prefixLength = Math.ceil(retained / 2);
  const suffixLength = retained - prefixLength;
  return output.slice(0, prefixLength) + marker + output.slice(-suffixLength);
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
export {
  VALIDATION_EVIDENCE_READ_CEILING_BYTES, VALIDATION_EVIDENCE_ADVISORY_FRACTION,
  VALIDATION_EVIDENCE_BOUND_FRACTION, VALIDATION_EVIDENCE_ADVISORY_BYTES,
  VALIDATION_EVIDENCE_BOUND_BYTES,
} from './validation-evidence-size-policy.js';
import {
  VALIDATION_EVIDENCE_READ_CEILING_BYTES, VALIDATION_EVIDENCE_ADVISORY_FRACTION,
  VALIDATION_EVIDENCE_BOUND_FRACTION, VALIDATION_EVIDENCE_ADVISORY_BYTES,
  VALIDATION_EVIDENCE_BOUND_BYTES,
} from './validation-evidence-size-policy.js';

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
    return `${head} The file grows with the number of proof-or-stop.config.json validate.commands entries; `
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
  const fits = (output: string): boolean => isWithinValidationEvidenceWriteBound(sizeOf(output), budget);
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
      outputWithinBound: isWithinValidationEvidenceWriteBound(Buffer.byteLength(unreduced, 'utf8')),
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
    outputWithinBound: isWithinValidationEvidenceWriteBound(serializedBytes),
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
 * 158 to 158 while the writer emits 168. This check-time helper still duplicates the format.
 * The writer-owned final ceiling and immutable publication are now documented in
 * docs/requirements/decisions/acceptance-closure-writer-boundary.md; the old divergence
 * transcript remains in validation-evidence-artifact-growth.md as historical evidence.
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
 * outside the historical Story scope. The acceptance-closure Lab adds that writer-owned
 * byte ceiling; this reducer still makes no equality promise about its earlier measurement.
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
 * prototype (snapshotPersistedRecord). Caller mutation between this measurement and publication
 * (B-3434:F-037) is now bounded by StoryStore.prepareTestEvidence/writePreparedTestEvidence: the
 * published bytes are the writer's prepared snapshot. A larger inherited-toJSON result may differ
 * from fileBytes, but the final writer refuses it above the cap instead of publishing oversize data.
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
      withinBound: isWithinValidationEvidenceWriteBound(fileBytes),
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
      isWithinValidationEvidenceWriteBound(plain.bytes) ? 'unmodified' : 'refused',
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
    if (reduced.bytes !== null && isWithinValidationEvidenceWriteBound(reduced.bytes)) {
      return finish(reduced.record, reduced.bytes, bounded.reduced ? 'reduced' : 'unmodified', sizing);
    }
  } catch {
    // A throwing accessor can raise anywhere in the reduction or in buildRecord. Fall through to
    // the fallback, which reads nothing without a guard.
  }

  const fallback = measureWith(verdictOnlyRecord(args.result, measuredBytes));
  if (fallback.bytes === null) return finish(fallback.record, Number.MAX_SAFE_INTEGER, 'refused', sizing);
  if (isWithinValidationEvidenceWriteBound(fallback.bytes)) {
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
    case 'capacity_wait':
      return `validate heartbeat: command ${index} ${event.label} waiting for machine validation capacity elapsedMs=${event.elapsedMs} timeoutMs=${event.timeoutMs}${event.waitDetail ? ` (${event.waitDetail})` : ''}`;
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
// B-7dff CHK-003: `--no-optional-locks` because this probe now runs from several
// concurrently scheduled commands. A plain `git status` opportunistically refreshes
// (and therefore WRITES) the index, taking `.git/index.lock`; two probes racing for
// that lock make one of them fail, and a failed probe returns null, which
// detectNewDirtyStatus turns into "no pollution" — silently disabling the
// side-effect guard for that command. The flag suppresses only that optional index
// write; the porcelain output is unchanged.
//
// B-7dff F-003: this snapshot pair is REPO-WIDE, so what a command observes is
// "what appeared during my window", NOT "what I wrote". Under the concurrent
// scheduler those differ. The raw observation is therefore no longer an
// accusation on its own: executeValidationPlan cross-checks every command's
// observation against every other's (attributeWorktreePollution) before any of
// it is reported or gate-consumed.
function readValidationSourceHead(gitCwd: string): string | null {
  try {
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ? head : null;
  } catch { return null; }
}

function readGitStatus(gitCwd: string): string[] | null {
  try {
    const raw = execSync('git --no-optional-locks status --porcelain=v1 --untracked-files=all', {
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

// Task B-6326 + B-4b22: validation side-effect details share DONE gate dirty
// ownership vocabulary AND route through dirty-gate-policy. When every polluted
// path classifies as a passing category (proof_or_stop_metadata / runtime_artifact /
// declared_artifact), this:
//   1. reports blocking=false (the caller writes it onto the pollution record,
//      and executeValidationPlan reads that to keep allPass = true),
//   2. swaps the leading "✗ … dirtied worktree" line for a "✓ … (passed by
//      dirty-gate-policy)" wording so downstream readers see that the loosening
//      was intentional,
//   3. emits audit lines into <projectRoot>/<storyDir>/<storyId>/process-events.jsonl
//      when a storyId is supplied. Storyless callers pass null writer (no
//      audit; gate degrades to blocking on failure path).
//
// Anti-divergence (preMortem #3): both core/done-oracle.ts (the DONE gate
// checklist) and this function import evaluateDirtyGate from the same module.
// No inline category check.
//
// B-7dff F-003: shared by BOTH pollution reports — the per-command one and the
// set-attributed one — so an unattributable dirty tree is classified, audited
// and gated by exactly the same policy as an attributable one. Only the header
// wording differs, which is why it is the caller's to supply.
function evaluateWorktreePollution(
  statusLines: string[],
  headers: { blocked: string; allowed: string },
  projectRoot?: string,
  storyId?: string,
): { lines: string[]; blocking: boolean } {
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
    statusLines,
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
  const lines = [
    evaluation.allPass ? headers.allowed : headers.blocked,
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
  return { lines, blocking: !evaluation.allPass };
}

/**
 * Render (and gate) ONE command's pollution record.
 *
 * B-7dff F-003: by the time a plan run reaches here, the record has already
 * been narrowed to rows no other command could have caused, so the
 * "<label> dirtied worktree" wording below is always a sound accusation.
 * Single-command callers (verifier's validate-file path,
 * runSingleAllowlistedCommand) are sound for the same reason from the other
 * direction: nothing ran beside them.
 */
export function formatWorktreePollutionDetails(
  result: ValidationCommandResult,
  projectRoot?: string,
  storyId?: string,
): string[] {
  const pollution = result.worktreePollution;
  if (!pollution || pollution.statusLines.length === 0) return [];
  const { lines, blocking } = evaluateWorktreePollution(pollution.statusLines, {
    allowed: `✓ validation command produced policy-allowed dirty paths: ${result.label}: ${formatValidationCommand(result)}`,
    blocked: `✗ validation command dirtied worktree: ${result.label}: ${formatValidationCommand(result)}`,
  }, projectRoot, storyId);
  // Propagate blocking decision back to executeValidationPlan via a typed flag.
  pollution.blocking = blocking;
  return lines;
}

/**
 * B-7dff F-003: render the SET-attributed pollution record, and set its
 * `blocking` flag from the same dirty-gate-policy evaluation a per-command
 * record goes through.
 *
 * The header deliberately says "validation commands" (plural) and names every
 * candidate instead of one label: the plan genuinely cannot tell which of the
 * concurrently running commands wrote the path, and printing one of them would
 * be the false accusation this whole path exists to avoid. The blocking
 * decision is NOT weakened to compensate — an unattributable dirty tree fails
 * exactly as an attributable one does.
 */
export function formatConcurrentWorktreePollutionDetails(
  pollution: ConcurrentWorktreePollution,
  projectRoot?: string,
  storyId?: string,
): string[] {
  if (pollution.statusLines.length === 0) return [];
  const candidates = pollution.candidates.join(', ');
  const { lines, blocking } = evaluateWorktreePollution(pollution.statusLines, {
    allowed: `✓ validation commands produced policy-allowed dirty paths during overlapping windows (not attributable to one command): ${candidates}`,
    blocked: `✗ validation commands dirtied worktree during overlapping windows (not attributable to one command): ${candidates}`,
  }, projectRoot, storyId);
  pollution.blocking = blocking;
  return [
    ...lines,
    ...pollution.attributions.map(
      (attribution) => `  ${attribution.path}: appeared during the windows of ${attribution.candidates.join(', ')}`,
    ),
    '  attribution is the SET above, not any one of them: these commands ran concurrently, so the repo-wide before/after status probe cannot tell which one wrote the path. Re-run with PROOF_OR_STOP_VALIDATE_JOBS=1 to attribute it exactly.',
  ];
}

/** One command's raw before/after observation, as `executeValidationPlan` collected it. */
export interface WorktreePollutionObservation {
  /** Stable command identity used in reports: `<1-based plan index>:<label>`. */
  candidate: string;
  /** The rows this command's OWN before/after snapshot pair saw appear. */
  statusLines: readonly string[];
}

export interface WorktreePollutionAttributionResult {
  /** Per observation (same index and order as the input): rows ONLY that observation saw. */
  exclusive: string[][];
  /** Rows more than one observation saw, or null when every row was exclusive. */
  concurrent: ConcurrentWorktreePollution | null;
}

/**
 * B-7dff F-003: split raw per-command pollution observations into the part that
 * is soundly attributable and the part that is not.
 *
 * A path's appearance is inside a command's observation window iff that command
 * saw it as NEW (present in its after-snapshot, absent from its before-snapshot).
 * So:
 *
 *  - Exactly ONE window contains it → only that command can have written it
 *    (any other command either finished before it appeared, or started after
 *    and therefore already had it in its own before-snapshot). Exact
 *    attribution, which is what every solo-scheduled command still gets — and
 *    every fail-closed barrier is solo-scheduled by construction.
 *  - SEVERAL windows contain it → any of them could have written it and the
 *    repo-wide probe carries no evidence choosing between them. Reported
 *    against the whole set; never pinned on one member, never dropped.
 *
 * Pure and order-deterministic (candidates come out in plan order), so the
 * scheduler's nondeterministic completion order cannot change the report.
 */
export function attributeWorktreePollution(
  observations: readonly WorktreePollutionObservation[],
): WorktreePollutionAttributionResult {
  const observed = new Map<string, { statusLine: string; observers: number[] }>();
  observations.forEach((observation, index) => {
    for (const statusLine of observation.statusLines) {
      const path = statusPath(statusLine);
      const entry = observed.get(path);
      if (!entry) {
        observed.set(path, { statusLine, observers: [index] });
      } else if (!entry.observers.includes(index)) {
        entry.observers.push(index);
      }
    }
  });

  const exclusive: string[][] = observations.map(() => []);
  const attributions: ConcurrentWorktreePollutionAttribution[] = [];
  for (const [path, entry] of observed) {
    if (entry.observers.length === 1) {
      exclusive[entry.observers[0]!]!.push(entry.statusLine);
      continue;
    }
    attributions.push({
      path,
      statusLine: entry.statusLine,
      candidates: entry.observers.map((observer) => observations[observer]!.candidate),
    });
  }
  if (attributions.length === 0) return { exclusive, concurrent: null };

  const candidates: string[] = [];
  for (const attribution of attributions) {
    for (const candidate of attribution.candidates) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return {
    exclusive,
    concurrent: {
      statusLines: attributions.map((attribution) => attribution.statusLine),
      paths: attributions.map((attribution) => attribution.path),
      candidates,
      attributions,
    },
  };
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
  // The canonical launch directory is pinned HERE, once, when the caller has
  // not pinned it for a whole plan or run: the cache identity, the child
  // environment and the launch all read this one binding, so a direct
  // invocation through an alias and one through the real path can never
  // share an identity while seeing different directories.
  if (options.launchCwd === undefined) options = { ...options, launchCwd: canonicalizeExistingPath(commandCwd(projectRoot, command.cwd)) };
  if (options.launchIdentity === undefined) options = { ...options, launchIdentity: bindLaunchDirectoryIdentity(options.launchCwd!) };
  // The pinned directory is verified BEFORE the shared cache is consulted: a
  // cached verdict must not be served for a directory that is no longer the
  // one it was earned in.
  { const drift = launchDirectoryDrift(options.launchCwd!, options.launchIdentity); if (drift) return Promise.resolve(refusedLaunchResult(command, projectRoot, LAUNCH_DIRECTORY_DRIFT_TAG, drift, resolveCommandTimeoutMs(command, defaultTimeoutMs))); }
  return withValidationCommandStage(command, () => executeSharedValidationCommand(command, projectRoot, resolveCommandTimeoutMs(command, defaultTimeoutMs),
    () => (command.executionReuse === 'exact-inputs' ? runValidationCommandWithCompleteOutput : runValidationCommandWithCompleteOutputUnscheduled)(command, projectRoot, defaultTimeoutMs, options), options.sharedExecution, () => {
      if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? new Error('shared validation aborted');
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
        throw options.deadlineError?.() ?? new Error('shared validation deadline exceeded');
      }
    }, options.artifactBinding, options.launchCwd), options);
}

/**
 * Internal capture variant. Public validation callers receive only the bounded `result`;
 * runSingleAllowlistedCommand also consumes the complete bytes already held in memory so
 * receipt matching and digesting are not accidentally governed by the persistence window.
 */
function runValidationCommandWithCompleteOutput(
  command: ValidationCommand, projectRoot: string, defaultTimeoutMs: number = DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
  options: RunValidationCommandOptions = {},
): ReturnType<typeof runValidationCommandWithCompleteOutputUnscheduled> {
  return withValidationCommandStage(command, () => runValidationCommandWithCompleteOutputUnscheduled(command, projectRoot, defaultTimeoutMs, options), options);
}

async function runValidationCommandWithCompleteOutputUnscheduled(
  command: ValidationCommand,
  projectRoot: string,
  defaultTimeoutMs: number = DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
  options: RunValidationCommandOptions = {},
): Promise<CapturedValidationCommandResult> {
  const started = Date.now();
  const configured = resolveCommandTimeoutMs(command, defaultTimeoutMs);
  const reportedTimeoutMs = Math.min(configured, options.deadlineAt === undefined ? Infinity : Math.max(1, options.deadlineAt - started));
  // The machine queue wait is not part of the command's timeout. It is bounded by the queue's own
  // deadline and the caller's outer deadline; the command's configured timeout starts when the
  // command is admitted. The admitted work (and any reservation it holds) is bounded by the latest
  // admission plus that timeout, never beyond the outer deadline.
  const waitDeadlineAt = Math.min(options.deadlineAt ?? Infinity, started + MACHINE_FIXED_PORT_RUNTIME_POLICY.queueDeadlineMs);
  const holdDeadlineAt = Math.min(options.deadlineAt ?? Infinity, waitDeadlineAt + configured);
  let enteredCapture = false;
  let completedCapture: CapturedValidationCommandResult | undefined;
  try {
    // The machine queue is shared by every repository of this OS user. A wait
    // behind another validation is activity, not silence: report it at the same
    // heartbeat cadence as a running command so the CLI idle watchdog does not
    // kill a healthy queued validation. The wait itself stays bounded by the
    // queue deadline and the caller's outer deadline.
    const waitHeartbeatMs = options.heartbeatMs ?? resolveValidateHeartbeatMs();
    const onWaitProgress = options.progress ? (detail: string) => {
      emitValidationProgress(options.progress, {
        ...validationProgressEvent('capacity_wait', command, {
          commandIndex: options.commandIndex ?? 1,
          totalCommands: options.totalCommands ?? 1,
          timeoutMs: reportedTimeoutMs,
          started,
        }),
        waitDetail: detail,
      });
    } : undefined;
    return await withMachineValidationResources({ root: projectRoot, workspaceRoot: projectRoot, command: command.label,
    resources: command.resources?.length ? command.resources : undefined, abortSignal: options.abortSignal, deadlineAt: holdDeadlineAt, waitDeadlineAt,
      deadlineError: options.deadlineError,
      ...(onWaitProgress ? { onWaitProgress, progressIntervalMs: waitHeartbeatMs } : {}) }, () => {
        enteredCapture = true;
        // The capture arms the configured timeout from its own start, capped only by the caller's
        // outer deadline (and, under delegation, the live grant), so time spent queued never
        // shortens the command's budget.
        const admittedAt = Date.now();
        const admittedTimeoutMs = Math.min(configured, options.deadlineAt === undefined ? Infinity : Math.max(1, options.deadlineAt - admittedAt));
        return captureValidationCommand(command, projectRoot, defaultTimeoutMs, options, admittedTimeoutMs).then(value => { completedCapture = value; return value; });
      });
  } catch (error) {
    const aborted = options.abortSignal?.aborted && (error === options.abortSignal.reason || boundedValidationErrorMessage(error) === 'workspace validation capacity wait aborted');
    // Only the capacity wait's own typed deadline error becomes a result; a caller-supplied deadline
    // error is rethrown unchanged whatever its message says.
    const expired = isValidationCapacityWaitDeadlineError(error);
    const delegationRefused = isValidationDelegationError(error);
    if (completedCapture) {
      // The complete authenticated artifact is preserved verbatim with the cleanup diagnostic
      // appended; only the bounded projection is trimmed.
      const diagnostic = boundedValidationErrorMessage(error);
      const output = `${completedCapture.result.output.slice(0, 2000)}\n${diagnostic}`;
      return { completeOutput: `${completedCapture.completeOutput}\n${diagnostic}`, result: { ...completedCapture.result,
        code: completedCapture.result.code === 0 ? 1 : completedCapture.result.code,
        failureKind: 'infra_failure', output,
      } };
    }
    if (!delegationRefused && (enteredCapture || (!aborted && !expired))) throw error;
    // Preserve the command-result API without launching a child merely to abort
    // it. A caller-supplied deadline error remains an exception above.
    const completed = completedValidationCleanupCapture(error);
    const queueWaitExpired = expired && (options.deadlineAt === undefined || Date.now() < options.deadlineAt);
    const diagnostic = delegationRefused ? boundedValidationErrorMessage(error) : `${aborted ? 'aborted' : queueWaitExpired ? 'machine queue wait deadline exceeded' : 'deadline exceeded'} before child launch`;
    if (completed) {
      // A command that completed before its cleanup was refused keeps its complete
      // authenticated artifact verbatim with the diagnostic appended; only the bounded
      // projection is trimmed, exactly as on the post-capture cleanup path.
      // The projection is rebuilt from the untainted command bytes, so each diagnostic appears exactly once.
      const output = `${completed.completeOutput.slice(0, 2000)}${completed.result.delegationDiagnostic === undefined ? '' : `\n${completed.result.delegationDiagnostic}`}\n${diagnostic}`;
      return { completeOutput: `${completed.completeOutput}\n${diagnostic}`, result: {
        ...completed.result, code: completed.result.code === 0 ? 1 : completed.result.code,
        failureKind: 'infra_failure', output,
      } };
    }
    const output = diagnostic;
    return { completeOutput: output, result: {
      label: command.label, command: command.command, args: command.args,
      ...(command.optional ? { optional: true } : {}),
      code: delegationRefused ? 1 : 124, ...(delegationRefused ? {} : { timedOut: true }), failureKind: 'infra_failure', output,
      timeoutMs: reportedTimeoutMs, effectiveTimeoutMs: 0, durationMs: Date.now() - started,
    } };
  }
}

class ValidationNoSpawnCleanupError extends Error {
  readonly completed?: ValidationCommandResult;
  /** The completed command's complete authenticated artifact, carried verbatim past the refused cleanup. */
  readonly completeOutput?: string;
  constructor(message: string, cause: unknown, completed?: ValidationCommandResult, completeOutput?: string) {
    super(message, { cause });
    this.completed = completed;
    this.completeOutput = completeOutput;
  }
}
function completedValidationCleanupCapture(error: unknown): CapturedValidationCommandResult | undefined {
  try {
    for (let depth = 0; error && typeof error === 'object' && depth < 8; depth++) {
      if (error instanceof ValidationNoSpawnCleanupError) {
        return error.completed ? { result: error.completed, completeOutput: error.completeOutput ?? error.completed.output } : undefined;
      }
      const cause = Object.getOwnPropertyDescriptor(error, 'cause');
      error = cause && 'value' in cause ? cause.value : undefined;
    }
  } catch { /* Diagnostic access cannot replace the original failure. */ }
  return undefined;
}

function boundedValidationErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error.slice(0, 2000);
  if (error && typeof error === 'object') {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') return descriptor.value.slice(0, 2000);
    } catch { /* Unavailable detail must not obscure the primary cause. */ }
  }
  return 'unavailable error detail';
}

/**
 * A command that was NOT launched because the directory it was pinned to is
 * no longer that directory. The result records no launch directory (nothing
 * ran anywhere), fails closed as an infrastructure failure, and names the
 * drift so the receipt consumers refuse it and the operator sees why.
 */
export const LAUNCH_DIRECTORY_DRIFT_TAG = '[launch_directory_drift]';
/** A launch the host refused synchronously (a cwd that is not a directory or cannot be searched, say): bounded, not thrown. */
export const SPAWN_REFUSED_TAG = '[spawn_refused]';
function refusedLaunchResult(command: ValidationCommand, projectRoot: string, tag: string, reason: string, timeoutMs: number): ValidationCommandResult {
  const cwd = commandCwd(projectRoot, command.cwd);
  const at = new Date().toISOString();
  return {
    label: command.label,
    command: command.command,
    args: [...command.args],
    ...(command.shell || process.platform === 'win32' ? { shell: true } : {}),
    ...(command.cwd ? { cwd } : {}),
    code: 1,
    output: `${tag} ${command.label} was not launched: ${reason}`,
    ...(command.optional ? { optional: true } : {}),
    timeoutMs,
    effectiveTimeoutMs: 0,
    failureKind: 'infra_failure',
    durationMs: 0,
    runtimeTrace: { command: command.command, argv: [...command.args], cwd, environmentKeys: [], startedAt: at, endedAt: at, exitCode: 1, events: ['launch-refused'], unknownRuntimeInputs: [`command not launched: ${tag}`] },
  };
}

async function captureValidationCommand(command: ValidationCommand, projectRoot: string, defaultTimeoutMs: number, options: RunValidationCommandOptions, reportedTimeoutMs: number): Promise<CapturedValidationCommandResult> {
  const delegationSignal = currentValidationReservationAbortSignal();
  if (delegationSignal) options = { ...options, abortSignal: options.abortSignal ? AbortSignal.any([options.abortSignal, delegationSignal]) : delegationSignal };
  const cwd = commandCwd(projectRoot, command.cwd);
  const started = Date.now();
  const configuredTimeoutMs = resolveCommandTimeoutMs(command, defaultTimeoutMs);
  // The armed timer is fixed here, before setup and the pre-launch handshakes: the configured timeout
  // measured from this start (after any capacity wait), capped by the remaining outer deadline and,
  // under delegation, by the live grant's deadline at which its revocation kills the command; the
  // reported effective timeout is that armed ceiling. The bounded deadline below governs only the
  // pre-launch handshakes.
  const grantDeadlineAt = currentValidationReservationDeadline();
  const ceilingAt = Math.min(options.deadlineAt ?? Infinity, grantDeadlineAt ?? Infinity);
  const armedTimeoutMs = ceilingAt === Infinity ? configuredTimeoutMs : Math.max(1, Math.min(configuredTimeoutMs, Math.floor(ceilingAt - started)));
  options = { ...options, deadlineAt: Math.min(ceilingAt, started + configuredTimeoutMs) };
  // A policy-owned reuse capsule supplies its already-closed environment. Do not
  // merge ambient variables back into that boundary while retaining the normal
  // validation environment construction for every ordinary command.
  // The child environment (PWD included) is built from the PINNED canonical
  // launch directory, the same input the shared cache derives its identity
  // and its executable resolution from: two invocations of one command
  // through an alias and through the real path must see one environment, or
  // a verdict that depends on PWD could earn a PASS the other inherits.
  const effectiveEnv = options.exactEnvironment
    ? { ...options.exactEnvironment }
    : effectiveValidationCommandEnvironment(process.env, command.env, options.launchCwd ?? cwd);
  const startedAt = new Date(started).toISOString();
  const commandIndex = options.commandIndex ?? 1;
  const totalCommands = options.totalCommands ?? 1;
  const heartbeatMs = options.heartbeatMs ?? resolveValidateHeartbeatMs();
  // B-75f0 CHK-002: no storyId in scope here (runValidationCommand takes only
  // projectRoot), so resolve the dirty-status probe cwd with the id-independent
  // project-level resolver — config loaded so a configured gitRoot subdir on a
  // wrapper-root layout is honored. Plain repos / unresolved → projectRoot
  // verbatim (byte-identical). A caller that pinned the plan's canonical
  // artifact root observes provenance THERE, so head and status describe the
  // checkout the command runs in, not wherever an alias points by now.
  const statusGitCwd = options.artifactBinding?.root ?? resolvePlanGitCwd(projectRoot);
  const headBefore = readValidationSourceHead(statusGitCwd);
  const statusBefore = readGitStatus(statusGitCwd);
  // The runtime tracer is a useful ordinary-command observation aid, but its
  // NODE_OPTIONS injection would widen the capsule's exact environment and
  // therefore invalidate the deterministic reuse authority contract.
  const tracer = options.exactEnvironment ? undefined : runtimeTracerPath(projectRoot);
  const traceFile = tracer
    ? join(projectRoot, RUNTIME_TRACE_DIR, `${process.pid}-${commandIndex}-${Date.now()}.json`)
    : undefined;
  const spawnEnv = { ...effectiveEnv };
  // Observed immediately before launch, in the same scope the result is built
  // in; the matching observation is taken the moment the child has finished.
  const buildArtifactsBefore = options.artifactBinding ? currentBuildArtifactsHash(options.artifactBinding.root, options.artifactBinding.configRoot) : undefined;
  if (tracer && traceFile) {
    mkdirSync(join(projectRoot, RUNTIME_TRACE_DIR), { recursive: true });
    spawnEnv.PROOF_OR_STOP_RUNTIME_TRACE_FILE = traceFile;
    spawnEnv.NODE_OPTIONS = `${spawnEnv.NODE_OPTIONS || ''} --require ${tracer}`.trim();
  }

  // The caller's own abort, or a caller-supplied deadline error, is decided before any pending
  // fence is prepared and again ahead of a delegation refusal, so it keeps its exception
  // behaviour instead of folding into a delegation result. A default deadline that expires
  // during preparation still folds into the bounded command result, as it always has.
  const callerStop = (): Error | undefined => {
    if (options.abortSignal?.aborted) return options.abortSignal.reason ?? new Error('shared validation aborted');
    if (options.deadlineError && options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) return options.deadlineError();
    return undefined;
  };
  { const stop = callerStop(); if (stop) throw stop; }
  // Verified again here, immediately before the launch fence and the spawn
  // (nothing between this check and the spawn runs a command): the pinned
  // directory must still resolve to itself and be the same filesystem object.
  if (options.launchCwd !== undefined) {
    const drift = launchDirectoryDrift(options.launchCwd, options.launchIdentity);
    if (drift) { const result = refusedLaunchResult(command, projectRoot, LAUNCH_DIRECTORY_DRIFT_TAG, drift, reportedTimeoutMs); return { result, completeOutput: result.output }; }
  }
  let pendingSpawn: string | undefined;
  try { pendingSpawn = await prepareValidationReservationChild({deadlineAt: options.deadlineAt, signal: options.abortSignal}); }
  catch (error) { const stop = callerStop(); throw stop ?? error; }
  // Marked before the spawn call: an unmarked pending fence proves that no child was ever spawned
  // under it, so owner loss before this point can be recovered without a detached-child risk. A
  // refused mark is withdrawn at once, because no spawn call was made under the fence; a refused
  // withdrawal is reported together with the refusal, never in place of it.
  try { await attemptValidationReservationSpawn(pendingSpawn, {deadlineAt: options.deadlineAt, signal: options.abortSignal}); }
  catch (error) {
    try { await cancelValidationReservationChild(pendingSpawn, {deadlineAt: Date.now() + VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY.cleanupMs}); }
    catch (cleanupError) {
      const stop = callerStop(); if (stop) throw stop;
      throw new ValidationNoSpawnCleanupError(`${boundedValidationErrorMessage(error)}; validation no-spawn cleanup refused: ${boundedValidationErrorMessage(cleanupError)}`, error);
    }
    const stop = callerStop(); throw stop ?? error;
  }
  let spawned = false;
  let spawnedPid: number | undefined;
  // The refused child's identity, recorded while it still lived, so the cleanup below can apply the owned-group rule to it.
  let refusedGroup: ReturnType<typeof observeValidationReservationChild> | undefined;
  let registrationRefused = false;
  let captureFailed = false, captureError: unknown;
  let captured: CapturedValidationCommandResult | undefined;
  try { captured = await new Promise<CapturedValidationCommandResult>((resolveResult) => {
    const isWindows = process.platform === 'win32';
    let output = '';
    let timedOut = false;
    let runnerFailure = false;
    let settled = false;
    let effectiveTimeoutMs = 0;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    const runtimeEvents: string[] = ['spawn-request'];

    let childRegistration: Promise<void> = Promise.resolve();
    const finish = async (rawCode: number | null) => {
      if (settled) return;
      settled = true;
      // A refused registration fails the command closed without touching the command's own output
      // artifact: the refusal is carried as a separate diagnostic and appended only to the bounded
      // projection, and the child's own exit status is kept alongside the fail-closed code.
      let delegationDiagnostic: string | undefined; let observedExitCode: number | null | undefined;
      try { await childRegistration; } catch (error) { runnerFailure = true; delegationDiagnostic = boundedValidationErrorMessage(error); observedExitCode = rawCode; rawCode = 1; }
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
      runtimeEvents.push('finish');
      const failureKind = commandFailureKind({ code, timedOut, runnerFailure });
      const statusAfter = readGitStatus(statusGitCwd);
      const buildArtifactsAfter = options.artifactBinding ? currentBuildArtifactsHash(options.artifactBinding.root, options.artifactBinding.configRoot) : undefined;
      const headAfter = readValidationSourceHead(statusGitCwd);
      const pollutionStatusLines = detectNewDirtyStatus(statusBefore, statusAfter);
      const completeOutput = stripAnsi(output);
      const traceFragments: ReturnType<typeof readRuntimeTraceFragments> = traceFile
        ? readRuntimeTraceFragments(traceFile)
        : { files: [], malformed: false };
      const result: ValidationCommandResult = {
        sourceProvenance: {
          schemaVersion: VALIDATION_SOURCE_PROVENANCE_SCHEMA,
          gitCwd: statusGitCwd, headBefore, headAfter,
          cleanBefore: statusBefore !== null && statusBefore.length === 0,
          cleanAfter: statusAfter !== null && statusAfter.length === 0,
        },
        label: command.label,
        command: command.command,
        args: command.args,
        ...(command.shell || isWindows ? { shell: true } : {}),
        ...(command.cwd ? { cwd } : {}),
        // The canonical directory the command was actually launched in.
        launchCwd,
        ...(buildArtifactsBefore ? { buildArtifactsBefore } : {}),
        ...(buildArtifactsAfter ? { buildArtifactsAfter } : {}),
        ...(options.artifactBinding ? { buildArtifactsProtection: options.artifactBinding.protection } : {}),
        code,
        output: delegationDiagnostic === undefined ? trimOutput(completeOutput, code !== 0) : `${trimOutput(completeOutput, true)}\n${delegationDiagnostic}`,
        ...(delegationDiagnostic === undefined ? {} : { delegationDiagnostic, observedExitCode }),
        ...(command.optional ? { optional: true } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        timeoutMs: reportedTimeoutMs,
        effectiveTimeoutMs,
        ...(failureKind ? { failureKind } : {}),
        durationMs: Date.now() - started,
        runtimeTrace: {
          command: command.command,
          argv: [...command.args],
          cwd,
          // Keep only keys the child actually touched.  Inheriting the parent
          // environment is not evidence of consumption and must not make an
          // undeclared secret/config read look declared to the closure gate.
          environmentKeys: [],
          startedAt,
          endedAt: new Date().toISOString(),
          exitCode: code,
          events: [...runtimeEvents],
          ...(traceFragments.malformed
            ? { unknownRuntimeInputs: ['runtime trace malformed'] }
            : traceFragments.observed
              ? { ...traceFragments.observed }
              : { unknownRuntimeInputs: ['runtime tracer unavailable for command'] }),
        },
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
        timeoutMs: reportedTimeoutMs,
        started,
        cwd,
        code,
        timedOut,
      }));
      resolveResult({ result, completeOutput });
      for (const file of traceFragments.files) rmSync(file, { force: true });
    };

    // Check at the actual spawn boundary, including reuse-ineligible commands.
    // The outer stage remains held for routine callers; independent capture keeps its own guard.
    if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? new Error('shared validation aborted');
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
      throw options.deadlineError?.() ?? new Error('shared validation deadline exceeded');
    }
    const declaredShell = Boolean(command.shell || isWindows);
    const childEnv = options.exactEnvironment ? spawnEnv : validationReservationChildEnvironment(spawnEnv);
    // The protection wrapper replaces only what is handed to spawn. Everything
    // recorded about this command — label, command, args, identity digests —
    // still describes the declared command. The environment is handed to the
    // wrapper too: it withholds what the loader would honour from its own
    // process and re-applies it inside the sandbox, so the command still sees
    // exactly `childEnv` while nothing in it can run ahead of the mechanism.
    const launch = options.artifactWriteProtection?.enforced
      ? options.artifactWriteProtection.wrap({ command: command.command, args: command.args, shell: declaredShell, env: childEnv })
      : { command: command.command, args: [...command.args], shell: declaredShell, env: childEnv };
    // The command runs in the CANONICAL directory the caller resolved before
    // its first launch: the denial rules were written for canonical paths, a
    // symbolic link on the way to the declared cwd could otherwise be
    // re-pointed at another checkout between two launches while the
    // protection still covered the first, and the shared-execution cache
    // keys and snapshots the same pinned directory. The result records the
    // directory that was VERIFIED (path and filesystem identity) immediately
    // before this spawn, never merely the string it was pinned with.
    const launchCwd = options.launchCwd ?? cwd;
    // A launch the host refuses synchronously (Node throws for a cwd that is
    // not a directory or cannot be searched; only ENOENT is reported
    // asynchronously) is a bounded infrastructure failure of THIS command,
    // never an exception out of the plan: nothing ran, no launch directory
    // is recorded, and the pending fence is withdrawn below as unspawned.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: launchCwd,
        env: launch.env,
        shell: launch.shell,
        stdio: options.exactEnvironment ? ['ignore', 'pipe', 'pipe'] : validationReservationChildStdio(['ignore', 'pipe', 'pipe']),
        // POSIX: give the child its own process group (it becomes group leader) so the
        // timeout can signal the WHOLE tree. Wrapper commands (npm, `/bin/sh -c …`) spawn
        // grandchildren that survive a direct child.kill() and keep the stdout/stderr pipe
        // open — which delays, or with an infinite grandchild prevents, the 'close' event,
        // re-introducing the exact hang this guards against. Not unref'd: we still await it.
        ...(isWindows ? {} : { detached: true }),
      });
    } catch (error) {
      runtimeEvents.push('spawn-refused');
      const result = refusedLaunchResult(command, projectRoot, SPAWN_REFUSED_TAG, `the host refused the launch in ${launchCwd}: ${boundedValidationErrorMessage(error)}`, reportedTimeoutMs);
      resolveResult({ result, completeOutput: result.output });
      return;
    }
    spawned = child.pid !== undefined;
    spawnedPid = child.pid;
    // The spawned PID is noted on the fence before the registration handshake, so an owner lost
    // between this spawn call and the applied registration leaves a fence that resolves once the
    // child and its whole group are proven absent instead of a terminal one.
    childRegistration = child.pid ? noteValidationReservationSpawn(pendingSpawn, child.pid, {deadlineAt: options.deadlineAt, signal: options.abortSignal}).then(() => registerValidationReservationChild(child.pid!, pendingSpawn, {deadlineAt: options.deadlineAt, signal: options.abortSignal})) : Promise.resolve();
    // A refused registration terminates the whole spawned group, exactly like a timeout;
    // the owned pending fence is withdrawn below only once that group is proven absent.
    // A refusal that arrives after the child has already exited sends no signal, exactly like the
    // timeout path; a recycled process group is never targeted.
    childRegistration.catch(() => { registrationRefused = true; if (settled || child.exitCode !== null || child.signalCode !== null) return; try { refusedGroup = observeValidationReservationChild(child.pid!); } catch { /* the leader-absent rule of the cleanup below still applies */ } try { killTree('SIGTERM'); } catch { /* finish reports registration failure. */ } });
    runtimeEvents.push('spawn');

    emitValidationProgress(options.progress, validationProgressEvent('command_start', command, {
      commandIndex,
      totalCommands,
      timeoutMs: reportedTimeoutMs,
      started,
      cwd,
    }));
    heartbeatTimer = setInterval(() => {
      emitValidationProgress(options.progress, validationProgressEvent('heartbeat', command, {
        commandIndex,
        totalCommands,
        timeoutMs: reportedTimeoutMs,
        started,
        cwd,
      }));
    }, heartbeatMs);
    heartbeatTimer.unref?.();

    // Signal the child's whole process group (POSIX) / process tree (Windows). Best-effort:
    // a race with natural exit (ESRCH) or a missing pid degrades to a direct child.kill().
    const killTree = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      const pid = child.pid;
      // A non-positive/one PID is never a detached child process we own. In
      // particular, negating 1 is POSIX's broadcast process target, so leave
      // ambiguous state for normal close handling rather than signal it.
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return;
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
        timeoutMs: reportedTimeoutMs,
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
    effectiveTimeoutMs = armedTimeoutMs;
    timer = setTimeout(() => {
      timeOutCommand(1000);
    }, effectiveTimeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => { runtimeEvents.push('close'); finish(code); });
    child.on('error', (e) => {
      runtimeEvents.push('error');
      runnerFailure = true;
      output += output ? `\n${e.message}` : e.message;
      finish(null);
    });
  }); return captured;
  } catch (error) { captureFailed = true; captureError = error; throw error;
  } finally {
    if (!spawned) {
      try { await cancelValidationReservationChild(pendingSpawn, {deadlineAt: Date.now() + VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY.cleanupMs}); }
      catch (cleanupError) {
        // Cleanup refusal stays fail-closed, but must not replace the caller's
        // original abort/deadline or erase a completed command's bounded result.
        const diagnostic = new ValidationNoSpawnCleanupError(
          `${captureFailed ? boundedValidationErrorMessage(captureError) + '; ' : ''}validation no-spawn cleanup refused: ${boundedValidationErrorMessage(cleanupError)}`,
          captureFailed ? captureError : cleanupError, captured?.result, captured?.completeOutput,
        );
        Object.defineProperty(diagnostic, 'cleanupFailure', {value: boundedValidationErrorMessage(cleanupError)});
        if (captured) Object.defineProperty(diagnostic, 'result', {value: {
          code: captured.result.code, timedOut: captured.result.timedOut,
          failureKind: captured.result.failureKind, output: captured.result.output.slice(0, 2000),
          effectiveTimeoutMs: captured.result.effectiveTimeoutMs,
        }});
        throw diagnostic;
      }
    } else if (registrationRefused && spawnedPid !== undefined) {
      // The refused child was signalled with its group while it lived; a child that exited before the
      // refusal arrived, or that ignored the signal, may leave the group its spawn created behind. That
      // group is signalled through the one owned-group rule shared with the controller teardown and the
      // isolated fixture (its leader still observed with the recorded identity, or absent while the
      // recorded group persists): SIGTERM now and SIGKILL at the half-budget point, exactly like a
      // timeout. Once its PID and whole group are proven absent nothing this spawn started can remain,
      // so the owned pending fence is withdrawn; a group that outlives even that, or an unobservable
      // one, keeps the fence for the controller to report.
      const leader = spawnedPid;
      const group = refusedGroup ?? {pid: leader, pgid: leader, start: Number.NaN};
      const signalGroup = (signal: 'SIGTERM' | 'SIGKILL'): void => {
        if (process.platform === 'win32' || !validationReservationOwnedGroupSignalTarget(group)) return;
        try { process.kill(-leader, signal); } catch { /* absence below is decisive */ }
      };
      const cleanupMs = VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY.cleanupMs;
      const until = Date.now() + cleanupMs;
      let escalated = false;
      signalGroup('SIGTERM');
      while (!unregisteredValidationReservationChildGone(spawnedPid) && Date.now() < until) {
        if (!escalated && Date.now() >= until - cleanupMs / 2) { escalated = true; signalGroup('SIGKILL'); }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (unregisteredValidationReservationChildGone(spawnedPid)) {
        try { await cancelValidationReservationChild(pendingSpawn, {deadlineAt: Date.now() + VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY.cleanupMs}); }
        catch (cleanupError) {
          // Withdrawal refusal stays fail-closed without replacing the caller's original
          // error or erasing the completed command's bounded result.
          const diagnostic = new ValidationNoSpawnCleanupError(
            `${captureFailed ? boundedValidationErrorMessage(captureError) + '; ' : ''}validation refused-registration cleanup refused: ${boundedValidationErrorMessage(cleanupError)}`,
            captureFailed ? captureError : cleanupError, captured?.result, captured?.completeOutput,
          );
          Object.defineProperty(diagnostic, 'cleanupFailure', {value: boundedValidationErrorMessage(cleanupError)});
          if (captured) Object.defineProperty(diagnostic, 'result', {value: {
            code: captured.result.code, timedOut: captured.result.timedOut,
            failureKind: captured.result.failureKind, output: captured.result.output.slice(0, 2000),
            effectiveTimeoutMs: captured.result.effectiveTimeoutMs,
          }});
          throw diagnostic;
        }
      }
    }
  }
}

/**
 * B-ec67: executables a pinned verification command may use. A pinned command is
 * executable+argv, NEVER a raw shell program — so we constrain the leading token to
 * this small allowlist of test/runtime launchers. This is the enforcement analogue
 * of the proof-or-stop-dispatch command-authorization boundary (dispatch's per-policy
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
  'go',
]);

export interface EvidenceCommandIdentity {
  executable: string;
  args: string[];
}

function parseEvidenceTimeoutOverride(value: unknown): EvidenceCommandTimeoutOverrideConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.join('\0') !== ['args', 'command', 'timeoutMs'].join('\0')) return null;
  if (
    typeof row.command !== 'string'
    || row.command.length === 0
    || row.command.trim() !== row.command
    || /\s/.test(row.command)
    || !VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST.has(row.command)
  ) return null;
  if (!Array.isArray(row.args) || !row.args.every(arg => typeof arg === 'string')) return null;
  if (
    typeof row.timeoutMs !== 'number'
    || !Number.isSafeInteger(row.timeoutMs)
    || row.timeoutMs <= 0
    || row.timeoutMs > MAX_NODE_TIMER_DELAY_MS
  ) return null;
  return {
    command: row.command,
    args: [...row.args] as string[],
    timeoutMs: row.timeoutMs,
  };
}

/**
 * Resolve an evidence-only timeout override by exact parsed executable and
 * ordered argv identity. The complete override collection is one policy unit:
 * malformed rows or duplicate identities fail closed to the bounded default.
 * This never registers a routine validation command and never weakens the
 * outer abort/deadline, which {@link runValidationCommand} still caps first.
 */
export function resolveEvidenceCommandTimeoutMs(
  identity: EvidenceCommandIdentity,
  overrides: unknown,
  defaultMs: number = DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
): number {
  const boundedDefault = Math.max(1, Math.min(MAX_NODE_TIMER_DELAY_MS, Math.floor(defaultMs)));
  if (!Array.isArray(overrides)) return boundedDefault;

  const parsed: EvidenceCommandTimeoutOverrideConfig[] = [];
  const identities = new Set<string>();
  for (const value of overrides) {
    const row = parseEvidenceTimeoutOverride(value);
    if (!row) return boundedDefault;
    const key = JSON.stringify([row.command, row.args]);
    if (identities.has(key)) return boundedDefault;
    identities.add(key);
    parsed.push(row);
  }

  const match = parsed.find(row => (
    row.command === identity.executable
    && row.args.length === identity.args.length
    && row.args.every((arg, index) => arg === identity.args[index])
  ));
  return match?.timeoutMs ?? boundedDefault;
}

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
  /** A refused delegation registration, kept apart from the complete output. */
  delegationDiagnostic?: string;
  observedExitCode?: number | null;
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

export interface SingleCommandExecutionOptions extends RunValidationCommandOptions {
  cwd?: string;
  timeoutMs?: number;
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
  options: SingleCommandExecutionOptions = {},
): Promise<SingleCommandExecutionResult> {
  const { executable, args } = parseAllowlistedCommand(command);
  const { cwd, timeoutMs } = options;
  // Build the pass-through EXPLICITLY instead of a `...rest` spread. A rest type
  // erases the callable provenance of `progress` / `deadlineError`, which makes
  // the retired-authority guard's type analysis fail closed
  // (`unresolved-known-property.progress`). Listing the fields keeps the exact
  // same values while staying statically resolvable.
  const runOptions: RunValidationCommandOptions = {
    ...(options.progress ? { progress: options.progress } : {}),
    ...(options.commandIndex !== undefined ? { commandIndex: options.commandIndex } : {}),
    ...(options.totalCommands !== undefined ? { totalCommands: options.totalCommands } : {}),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
    ...(options.deadlineError ? { deadlineError: options.deadlineError } : {}),
  };
  const configuredTimeoutMs = timeoutMs ?? resolveEvidenceCommandTimeoutMs(
    { executable, args },
    loadConfig(projectRoot).validate?.evidenceCommandTimeoutOverrides,
  );
  const validationCommand: ValidationCommand = {
    label: 'verification-evidence-command',
    command: executable,
    args,
    ...(cwd ? { cwd } : {}),
    timeoutMs: configuredTimeoutMs,
  };
  const capsuleEnvironment = closedEnvironmentForVerificationReuseCapsuleInvocation({
    executable,
    argv: args,
    cwd: options.cwd ?? projectRoot,
  });
  const { result, completeOutput } = await runValidationCommandWithCompleteOutput(
    validationCommand,
    projectRoot,
    DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
    { ...runOptions, ...(capsuleEnvironment ? { exactEnvironment: capsuleEnvironment } : {}) },
  );
  // Read the abort/deadline controls from the DECLARED `options` type rather than
  // the rest-spread `runOptions`. Both hold the same values (runOptions is options
  // minus cwd/timeoutMs), but a rest type hides `deadlineError`'s callable
  // provenance from the retired-authority guard's type analysis, which then fails
  // closed with `unresolved-known-property.deadlineError`. `runOptions` stays the
  // pass-through payload for runValidationCommand.
  if (options.abortSignal?.aborted) {
    throw options.abortSignal.reason instanceof Error
      ? options.abortSignal.reason
      : new Error('verification evidence command aborted');
  }
  if (
    result.timedOut
    && typeof options.deadlineAt === 'number'
    && Date.now() >= options.deadlineAt
  ) {
    throw options.deadlineError?.()
      ?? new Error(`verification evidence command deadline exceeded at ${options.deadlineAt}`);
  }
  return {
    executable,
    args,
    code: result.code,
    output: completeOutput,
    // A refused registration travels as its own field; the complete output stays the command's bytes.
    ...(result.delegationDiagnostic === undefined ? {} : { delegationDiagnostic: result.delegationDiagnostic, observedExitCode: result.observedExitCode ?? null }),
    timedOut: Boolean(result.timedOut),
    durationMs: result.durationMs,
    // runValidationCommand always stamps the effective (clamped, deadline-capped) ceiling,
    // but ValidationCommandResult.timeoutMs is optional for legacy/stub producers — fall
    // back to the same resolver so the reported budget is never undefined. A refusal that
    // has to NAME the budget must always have one.
    timeoutMs: result.timeoutMs ?? resolveCommandTimeoutMs(validationCommand),
  };
}

/**
 * The one synthetic resource every routine-validate plan entry claims.
 *
 * A command that DECLARED resources holds this key `shared`, so two declared
 * commands may overlap whenever their declared claims are disjoint. A command
 * that declared NOTHING holds it `exclusive`, so it conflicts with every other
 * entry in the plan — declared or not — and is therefore scheduled alone.
 *
 * The default is exclusive on purpose. Routine validate commands write under
 * `.proof-or-stop/`, rebuild `packages/main/dist`, take repository build/runtime
 * locks and drive git; an unclassified command that silently ran concurrently
 * would corrupt exactly the evidence validate exists to produce. Defaulting to
 * shared would assume the disjointness nobody has proven yet, and a declaration
 * is precisely the record of that proof. Under-declaring only costs latency.
 */
export const VALIDATE_PLAN_BARRIER_CLAIM_CLASS = 'fixed-path' as const;
export const VALIDATE_PLAN_BARRIER_CLAIM_KEY = '.proof-or-stop/runtime/validate-plan-barrier';

/** One plan command as the keyed scheduler sees it. */
export interface ValidationScheduleEntry extends SchedulableEntry {
  /** Unique per plan (the plan index is part of it: labels may repeat). */
  name: string;
  resources: ResourceClaim[];
  command: ValidationCommand;
  /** 1-based position in the plan, so results can be restored to plan order. */
  commandIndex: number;
  /** True when the command declared nothing and got the fail-closed exclusive default. */
  exclusiveByDefault: boolean;
}

/** One command's resolved claims plus whether the fail-closed default produced them. */
export interface ResolvedValidationCommandResources {
  claims: ResourceClaim[];
  /**
   * True when the command declared nothing and therefore holds the barrier
   * EXCLUSIVELY. This is the resolver's own verdict, returned rather than left
   * to be re-derived from the raw `resources` field: B-7dff F-005 — the rule is
   * this story's load-bearing safety invariant, and two independent copies of
   * it (`exclusiveByDefault` said one thing, the scheduler enforced another)
   * would diverge silently the first time the rule changes.
   */
  exclusiveByDefault: boolean;
}

/**
 * Resolve one command's effective claims, and report whether the fail-closed
 * default was applied. THE one place that decides "this command declared
 * nothing" — every other reader takes the answer from here.
 *
 * - Declared: `[barrier(shared), ...declared]`, `exclusiveByDefault: false`.
 * - Undeclared or empty: `[barrier(exclusive)]`, `exclusiveByDefault: true` — a
 *   single exclusive claim on the synthetic key, which is what makes an
 *   unclassified command run alone.
 *
 * An unrecognised class / access / ownership is REFUSED here, at declaration
 * time, rather than being dropped (which would silently leave the command in
 * some other key's admission set). Any `canonicalKey` arriving from a caller or
 * from config is discarded: canonicalization is the scheduler's job
 * (`canonicalizeEntries`), and accepting a pre-set one would let untrusted
 * input choose which entries it conflicts with.
 */
export function resolveValidationCommandResourceClaims(
  command: ValidationCommand,
  owner: string,
): ResolvedValidationCommandResources {
  const declared = command.resources;
  if (declared !== undefined && !Array.isArray(declared)) {
    throw new Error(`validate command ${owner} declared a non-array resources field`);
  }
  const claims: ResourceClaim[] = (declared ?? []).map((claim) => {
    if (!claim || typeof claim !== 'object') throw new Error(`validate command ${owner} declared a non-object resource claim`);
    return {
      class: claim.class,
      key: claim.key,
      access: claim.access,
      ...(claim.ownership ? { ownership: claim.ownership } : {}),
    };
  });
  validateResourceClaims(claims, owner);
  if (claims.length === 0) {
    return {
      claims: [{ class: VALIDATE_PLAN_BARRIER_CLAIM_CLASS, key: VALIDATE_PLAN_BARRIER_CLAIM_KEY, access: 'exclusive' }],
      exclusiveByDefault: true,
    };
  }
  return {
    claims: [{ class: VALIDATE_PLAN_BARRIER_CLAIM_CLASS, key: VALIDATE_PLAN_BARRIER_CLAIM_KEY, access: 'shared' }, ...claims],
    exclusiveByDefault: false,
  };
}

/**
 * The claims alone, for callers that only need the admission set.
 * {@link resolveValidationCommandResourceClaims} stays the single decision point.
 */
export function resolveValidationCommandResources(command: ValidationCommand, owner: string): ResourceClaim[] {
  return resolveValidationCommandResourceClaims(command, owner).claims;
}

/**
 * Resolve a whole plan into scheduler entries, in plan order. The claims are
 * NOT canonicalized here (that needs a project root and touches the filesystem
 * and git); the scheduler's `canonicalizeEntries` does it and refuses to run
 * any entry whose claims were never canonicalized.
 */
export function resolveValidationPlanEntries(plan: ValidationPlan): ValidationScheduleEntry[] {
  return plan.commands.map((command, index) => {
    // The index keeps names unique: two plan commands may share a label.
    const name = `${index}:${command.label}`;
    // B-7dff F-005: exclusiveByDefault comes from the resolver that actually
    // applied the default, never re-derived from command.resources here.
    const { claims, exclusiveByDefault } = resolveValidationCommandResourceClaims(command, name);
    return {
      name,
      resources: claims,
      command,
      commandIndex: index + 1,
      exclusiveByDefault,
    };
  });
}

/** One plan command's terminal record as the keyed scheduler sees it. */
interface ValidationScheduleResult extends SchedulableResult {
  name: string;
  status: ScheduledStatus;
  /** 1-based plan position, so the caller can restore plan order. */
  commandIndex: number;
}

/** The scheduler's coarse verdict for one command. Reported, never acted on: the routine
 * plan runs under `run-all`, so no status here can cancel another command. */
function scheduledStatusForCommand(result: ValidationCommandResult): ScheduledStatus {
  if (result.timedOut) return 'TIMEOUT';
  return result.code === 0 ? 'PASS' : 'FAIL';
}

/**
 * Plan-level build binding rules over the executor's own observations. Pure and
 * exported so every rule can be exercised directly: with write protection
 * enforced, most of these violations can no longer be produced by running a
 * command, and this is the second line of defence that still catches them on a
 * host where protection could not be established.
 *
 * Every observation is a content digest, so the rules hold against a swap that
 * is later restored ACROSS commands: the swap, every command that ran on the
 * swapped bytes, and the restore each fail their own comparison. They cannot
 * see a swap that happens and is undone inside one command; that is what the
 * write protection is for.
 */
export function evaluatePlanBuildArtifactsBinding(input: {
  commands: readonly Pick<ValidationCommandResult, 'label' | 'buildArtifactsBefore' | 'buildArtifactsAfter' | 'buildArtifactsRole'>[];
  start?: string;
  end?: string;
}): string[] {
  const failures: string[] = [];
  const { commands, start, end } = input;
  if (!start || !end) {
    failures.push('build artifacts identity is unavailable (symbolic link or unreadable artifact tree); the plan cannot bind what it executed [build_artifacts_identity_unavailable]');
    return failures;
  }
  const buildRan = commands.some((result) => result.buildArtifactsRole === 'build');
  for (const result of commands) {
    if (!result.buildArtifactsBefore || !result.buildArtifactsAfter) {
      failures.push(`${result.label}: build artifacts were not observed around this command [build_artifacts_observation_missing]`);
      continue;
    }
    if (result.buildArtifactsRole === 'build') continue;
    if (result.buildArtifactsBefore !== result.buildArtifactsAfter) {
      failures.push(`${result.label}: compiled artifacts changed while this non-build command ran${buildRan ? ' (a registered build overlapped it)' : ''} [build_artifacts_changed_by_non_build_command]`);
    }
    if (result.buildArtifactsBefore !== end) {
      failures.push(`${result.label}: executed bytes that differ from the artifacts the plan ended on; rerun it against the final build [receipt_not_bound_to_final_build]`);
    }
  }
  // The plan may only end on the exact bytes the last registered build
  // produced (or, when no build ran, the bytes it started with).
  const builds = commands.filter((result) => result.buildArtifactsRole === 'build' && result.buildArtifactsAfter);
  const expectedFinalContent = builds.length > 0 ? builds[builds.length - 1].buildArtifactsAfter : start;
  if (end !== expectedFinalContent) {
    failures.push(buildRan
      ? 'compiled artifacts differ from the output of the last registered packages/main build; a later command rewrote them [build_artifacts_changed_after_build]'
      : 'compiled artifacts changed during the plan without a registered packages/main build [build_artifacts_changed_by_non_build_command]');
  }
  return failures;
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

  const totalCommands = plan.commands.length;
  const jobs = resolveValidatePlanJobs(process.env, options.jobs);
  // Canonicalization is what makes the claims comparable (and it REFUSES an
  // undeclarable one), so it happens before anything is launched. Every entry
  // keeps its plan position in `commandIndex`.
  // A registered packages/main build launches ahead of every other entry: it is
  // the only command allowed to change the compiled artifacts, so running it
  // first means every later command executes the build the evidence binds
  // instead of a build that is then replaced (which the binding rules below
  // would refuse). Plan order is otherwise preserved.
  // One artifact root for the whole plan: the repository the commands execute
  // and publication digests, never the wrapper metadata root. Resolved before
  // scheduling because build recognition is judged against it, and
  // CANONICALISED once: an alias above the project that a command re-points
  // mid-plan must not move where later commands run, what is observed, or
  // what is protected (every launch under protection runs in the canonical
  // directory, see captureValidationCommand).
  const artifactsRoot = canonicalizeExistingPath(options.gitCwd ?? resolvePlanGitCwd(projectRoot));
  // Where each command runs, and therefore what it IS, resolved NOW for the
  // whole plan: the canonical launch directory is pinned before the first
  // launch, and the build role is derived from that same directory once, so
  // an alias re-pointed by an earlier command can neither move a later
  // command nor turn it into a registered build at launch time. Scheduling
  // priority, the build wave, the protection decision and the recorded role
  // all read this one binding.
  const planEntries = resolveValidationPlanEntries(plan);
  const canonicalLaunchCwds = new Map(planEntries.map((entry) => [entry.commandIndex, options.launchCwds?.[entry.commandIndex - 1] ?? canonicalizeExistingPath(commandCwd(projectRoot, entry.command.cwd))] as const));
  // The filesystem identity of each pinned directory, bound NOW (or carried
  // from planning): every launch re-verifies its directory against it.
  const launchIdentities = new Map(planEntries.map((entry) => [entry.commandIndex, options.launchIdentities?.[entry.commandIndex - 1] ?? bindLaunchDirectoryIdentity(canonicalLaunchCwds.get(entry.commandIndex)!)] as const));
  const buildRoles = new Map(planEntries.map((entry) => [entry.commandIndex,
    isRegisteredPackagesMainBuildCommand(entry.command, projectRoot, artifactsRoot, canonicalLaunchCwds.get(entry.commandIndex)) ? 'build' as const : 'test' as const] as const));
  const entries = canonicalizeEntries(planEntries, projectRoot)
    .map((entry) => (buildRoles.get(entry.commandIndex) === 'build' ? { ...entry, priority: (entry.priority ?? 0) + 1 } : entry));
  const exclusiveCount = entries.filter((entry) => entry.exclusiveByDefault).length;

  // Completion order is not plan order, so results are parked by plan index and
  // read back in plan order below. `details` is assembled there too: pushing it
  // from inside a concurrent command would interleave one command's output into
  // another's, and formatWorktreePollutionDetails also appends dirty-gate audit
  // lines to process-events.jsonl, which stays single-writer this way.
  const executed: (ValidationCommandResult | null)[] = new Array(totalCommands).fill(null);
  // Content digest of the compiled artifacts before anything launches; the
  // matching digest after the plan is the identity the evidence binds and the
  // per-command content digests attribute every change in between.
  // Boundary observations cannot see a swap that a command undoes before it
  // returns, so every non-build command is launched under a mechanism that
  // denies it, and its descendants, the right to write these trees at all.
  // The contract declaration is read from the project's configuration root
  // (projectRoot), which on a wrapper-root layout is not the artifact root.
  let artifactWriteProtection = resolveArtifactWriteProtection(artifactsRoot, { configRoot: projectRoot });
  // A resolution describes the host at one moment. A registered build may
  // create or replace the trees, and a `not-applicable` exemption (no tree to
  // protect) is valid only while that stays true, so the protection is
  // re-resolved before a test launches whenever either has happened.
  let buildRanSinceResolve = false;
  const buildArtifactsAtStart = currentBuildArtifactsHash(artifactsRoot, projectRoot);
  // Latched by whichever command first observes the plan deadline blown. The
  // sequential implementation threw at exactly that point and never started a
  // later command; entries still pending here are skipped for the same reason
  // (their timeout would already be clamped to ~0 by the passed deadline, so
  // launching them only spawns processes whose results this function is about
  // to discard by throwing).
  let deadlineExceeded = false;

  const runEntry = async (entry: ValidationScheduleEntry): Promise<ValidationScheduleResult> => {
    if (deadlineExceeded) return { name: entry.name, status: 'INTERRUPTED', commandIndex: entry.commandIndex };
    options.beforeLaunch?.();
    // Execution-boundary observation of the compiled artifacts, by content:
    // the exact bytes this command started against and the exact bytes it
    // left behind. Content, not sizes or timestamps, so a swap that is later
    // restored is still attributed to the commands that ran in between. A
    // digest of the 57 MB tree costs about 90 ms warm; the plan-level rules
    // below turn these observations into the binding the evidence carries.
    // Boundary observations only: a command that swaps and restores the trees
    // inside its own window is not observable here (build-artifacts-identity.ts
    // states the bound); that needs OS-enforced write denial, not observation.
    // A registered build is the one command allowed to change these trees, so
    // it alone runs unprotected; everything else is denied the write.
    const buildArtifactsRole = buildRoles.get(entry.commandIndex) ?? 'test';
    if (buildArtifactsRole === 'test' && artifactProtectionStale(artifactWriteProtection, { buildRanSinceResolve, anyRootExists: hasAnyArtifactRoot(artifactsRoot, projectRoot) })) {
      artifactWriteProtection = resolveArtifactWriteProtection(artifactsRoot, { configRoot: projectRoot });
      buildRanSinceResolve = false;
    }
    const result = await runValidationCommand(entry.command, projectRoot, DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS, {
      ...(buildArtifactsRole === 'test' ? { artifactWriteProtection } : {}),
      artifactBinding: { root: artifactsRoot, configRoot: projectRoot, protection: buildArtifactsRole === 'build' ? REGISTERED_BUILD_PROTECTION_LABEL : artifactWriteProtection.label },
      launchCwd: canonicalLaunchCwds.get(entry.commandIndex),
      launchIdentity: launchIdentities.get(entry.commandIndex),
      progress: options.progress,
      heartbeatMs: options.heartbeatMs,
      commandIndex: entry.commandIndex,
      totalCommands,
      abortSignal: options.abortSignal,
      deadlineAt: options.deadlineAt,
      deadlineError: options.deadlineError,
    });
    // The observations and the protection label arrive on the result from the
    // capture (an executed run) or from the reuse key (a cached run); the plan
    // never overwrites them with what it sees now.
    result.buildArtifactsRole = buildArtifactsRole;
    if (buildArtifactsRole === 'build') buildRanSinceResolve = true;
    if (
      result.timedOut
      && typeof options.deadlineAt === 'number'
      && Date.now() >= options.deadlineAt
    ) {
      deadlineExceeded = true;
    }
    executed[entry.commandIndex - 1] = result;
    return { name: entry.name, status: scheduledStatusForCommand(result), commandIndex: entry.commandIndex };
  };
  // run-all: a failing command must never cancel the others. Every gate and
  // receipt downstream reads commands[] as a COMPLETE record of the plan
  // (commandExecution.complete compares its length against the plan length),
  // so a short array would read as an infrastructure failure, not as the one
  // real command failure it is.
  const scheduleOptions = { cancellation: 'run-all' as const };
  // Registered builds run FIRST and ALONE; everything else runs after the last
  // of them has returned. A build is the one command that writes the trees, so
  // no protected test may overlap it — whatever resources the caller declared:
  // a build that replaced and restored the trees while a test ran would leave
  // that test's two observations equal and its evidence false. The barrier is
  // the plan's own, not the scheduler's declared-resource model, and the
  // protection is re-resolved after the builds (artifactProtectionStale).
  const buildEntries = entries.filter((entry) => buildRoles.get(entry.commandIndex) === 'build');
  const testEntries = entries.filter((entry) => !buildEntries.includes(entry));
  const scheduled = await withValidationPlanStages(async () => [
    ...await runScheduled<ValidationScheduleEntry, ValidationScheduleResult>(buildEntries, 1, runEntry, scheduleOptions),
    ...await runScheduled<ValidationScheduleEntry, ValidationScheduleResult>(testEntries, jobs, runEntry, scheduleOptions),
  ]);

  if (deadlineExceeded) {
    throw options.deadlineError?.() ?? new Error(`validation plan deadline exceeded at ${options.deadlineAt}`);
  }

  // Diagnostic resource-conflict wait from the scheduler; excludes worker-slot
  // queue time and cross-process capacity wait. Never used to decide gate acceptance or reuse.
  for (const row of scheduled) {
    const result = executed[row.commandIndex - 1];
    if (result && row.lockWaitMs !== undefined) result.schedulerWaitMs = row.lockWaitMs;
  }

  // B-7dff F-003: each command's dirty-status observation is repo-wide, so
  // under concurrency it reports "what appeared during my window", not "what I
  // wrote". Cross-check the whole set of observations BEFORE any of it is
  // reported or gate-consumed: a row only one window saw stays that command's
  // (exact attribution — which every solo-scheduled command, including every
  // fail-closed barrier, still gets), and a row several windows saw is moved to
  // a set-attributed plan-level record instead of being pinned on whichever
  // innocent command happened to straddle the write. Nothing is discarded: the
  // set-level record goes through the same dirty-gate-policy evaluation and
  // blocks exactly as a per-command one would.
  const attribution = attributeWorktreePollution(plan.commands.map((command, index) => ({
    candidate: `${index + 1}:${command.label}`,
    statusLines: executed[index]?.worktreePollution?.statusLines ?? [],
  })));
  executed.forEach((result, index) => {
    if (!result) return;
    const exclusiveLines = attribution.exclusive[index] ?? [];
    if (exclusiveLines.length === 0) {
      delete result.worktreePollution;
      return;
    }
    result.worktreePollution = {
      statusLines: exclusiveLines,
      paths: exclusiveLines.map(statusPath),
      attribution: 'exclusive',
    };
  });
  const concurrentPollution = attribution.concurrent;

  for (let i = 0; i < totalCommands; i++) {
    const command = plan.commands[i];
    const result = executed[i];
    // Unreachable under run-all (every entry produces a terminal result and the
    // deadline path threw above). Fail closed rather than emit a commands[]
    // shorter than the plan, which downstream would read as a passing run of a
    // smaller plan.
    if (!result) {
      throw new Error(`validation plan produced no result for command ${i + 1}/${totalCommands} (${command.label})`);
    }
    commands.push(result);

    const failed = result.code !== 0 || Boolean(result.timedOut);
    const mark = failed ? (result.optional ? '⚠' : '✗') : '✓';
    const suffix = result.timedOut ? ' (timed out)' : '';
    details.push(`${mark} ${result.label}: ${formatValidationCommand(command)}${suffix}`.trim());
    if (result.timedOut) {
      details.push(...formatTimeoutDiagnostics(command, result, i + 1, totalCommands));
    }
    if (result.output.trim()) {
      details.push(...result.output.trim().split('\n').filter(Boolean).map((line) => `  ${line}`));
    }
    details.push(...formatWorktreePollutionDetails(result, projectRoot, storyId));
    if (failed && result.optional) {
      warnings.push(`optional validation failed: ${result.label}`);
    }
  }
  // Before the scheduler line, which callers read as the last line of details.
  if (concurrentPollution) {
    details.push(...formatConcurrentWorktreePollutionDetails(concurrentPollution, projectRoot, storyId));
  }
  // Build-identity binding. The evidence binds the compiled artifacts as the
  // plan left them; every change in between must be a registered packages/main
  // build, and every non-build command must have started against that final
  // build. A test that ran before or alongside a build executed a build that
  // was then replaced, so it is refused instead of relabelled; a non-build
  // command that changed the artifacts rewrote the dist under test. Legacy or
  // unobservable trees (symbolic links) cannot vouch and are refused.
  const buildArtifactsAtEnd = currentBuildArtifactsHash(artifactsRoot, projectRoot);
  const buildBindingFailures = evaluatePlanBuildArtifactsBinding({
    commands,
    start: buildArtifactsAtStart,
    end: buildArtifactsAtEnd,
  });
  for (const line of buildBindingFailures) details.push(`✗ build binding: ${line}`);
  // Appended, never prepended: details[0] is the first command line (or the
  // focus banner) and callers read it as the headline.
  details.push(
    `validate scheduler: jobs=${jobs} commands=${totalCommands} `
    + `declared=${totalCommands - exclusiveCount} exclusiveByDefault=${exclusiveCount}`,
  );

  const requiredFailures = commands.filter((r) => !r.optional && (r.code !== 0 || r.timedOut));
  const optionalFailures = commands.filter((r) => r.optional && (r.code !== 0 || r.timedOut));
  const requiredInfraFailures = requiredFailures.filter((r) => r.failureKind === 'infra_failure');
  // Task B-4b22: pollution only counts as failure if dirty-gate-policy
  // marked it blocking. Passing-only category pollution (proof_or_stop_metadata /
  // runtime_artifact / declared_artifact) is allowed and audited.
  const pollutionFailures = commands.filter((r) => {
    if (!r.worktreePollution || r.worktreePollution.statusLines.length === 0) return false;
    // blocking undefined → legacy back-compat: treat as blocking.
    return r.worktreePollution.blocking !== false;
  });
  // B-7dff F-003: pollution nobody can be blamed for individually still blocks.
  // Losing the detection would be a strictly worse bug than mis-attributing it,
  // so the ambiguity is reported honestly and gated identically.
  const concurrentPollutionBlocking = Boolean(concurrentPollution)
    && concurrentPollution!.statusLines.length > 0
    && concurrentPollution!.blocking !== false;
  const anyPollutionFailure = pollutionFailures.length > 0 || concurrentPollutionBlocking;
  const buildBindingFailed = buildBindingFailures.length > 0;
  const allPass = requiredFailures.length === 0 && !anyPollutionFailure && !buildBindingFailed;
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
    : buildBindingFailed && requiredFailures.length === 0 && !anyPollutionFailure
      ? 'Project validation commands could not bind the compiled artifacts they executed'
    : anyPollutionFailure && requiredFailures.length === 0
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
    ...(concurrentPollution ? { concurrentWorktreePollution: concurrentPollution } : {}),
    // The identity the evidence binds: only stamped when the binding rules held.
    ...(!buildBindingFailed && buildArtifactsAtEnd ? { buildArtifactsHash: buildArtifactsAtEnd } : {}),
    // The plan's label is the weakest protection any NON-build command ran
    // under. A plan that ran only registered builds records none: it proves
    // nothing about protected execution, and a resolution taken before its
    // build (possibly unenforced because a tree was still missing) must not
    // be carried into an aggregate whose tests ran enforced afterwards.
    ...((): { buildArtifactsProtection?: string } => {
      // A plan with nothing to run (no validator configured) executed nothing
      // that could have swapped the trees; it records the host's resolution so
      // its evidence is judged on whether this host can enforce at all.
      if (commands.length === 0) return { buildArtifactsProtection: artifactWriteProtection.label };
      const tests = commands.filter((result) => result.buildArtifactsRole !== 'build');
      // Registered builds and nothing else: explicitly build-only, which the
      // contract accepts on its own terms (no command ran that it protects)
      // and which never outranks an enforced or unenforced test label.
      if (tests.length === 0) return { buildArtifactsProtection: BUILD_ONLY_PROTECTION_LABEL };
      const weakest = weakestProtectionLabel(tests.map((result) => result.buildArtifactsProtection));
      return weakest ? { buildArtifactsProtection: weakest } : {};
    })(),
    buildArtifacts: {
      root: artifactsRoot,
      ...(buildArtifactsAtStart ? { start: buildArtifactsAtStart } : {}),
      ...(buildArtifactsAtEnd ? { end: buildArtifactsAtEnd } : {}),
    },
    ...(focus ? { focus: { name: focus, mode: 'focused' as const, finalFullValidation: false as const, doneRequiredProof: false as const } } : {}),
  };
}
