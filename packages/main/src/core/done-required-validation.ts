import { validateResourceClaims, type ResourceClaim } from './keyed-scheduler.js';
import { parseLegacyValidationCommandString } from './validation-command-identity.js';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadConfig, type ProofOrStopConfig } from './config.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import { BUILD_ARTIFACT_ROOTS, currentBuildArtifactsHash, isRegisteredPackagesMainBuildCommand } from './build-artifacts-identity.js';
import { REGISTERED_BUILD_PROTECTION_LABEL, artifactProtectionSatisfied, artifactProtectionStale, hasAnyArtifactRoot, resolveArtifactWriteProtection } from './build-artifacts-protection.js';
import type { StoryStore } from './store.js';
import { DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS, formatValidationCommand, resolveCommandTimeoutMs, runValidationCommand } from './validation-executor.js';
import type {
  DoneRequiredCommandSpecEnvelope,
  DoneRequiredCommandReceipt,
  DoneRequiredEvidenceData,
  DoneRequiredEvidenceStatus,
  RoutineValidationIdentity,
  ValidationCommand,
  ValidationCommandResult,
  ValidationProgressReporter,
} from './validation-types.js';
import {
  buildProofAdmissibilityDiagnostic,
  proofAdmissibilityBlockingReason,
  resolveProofAdmissibilityPolicy,
  type ProofAdmissibilityDiagnostic,
} from './proof-admissibility-gates.js';
import { buildRoutineValidationIdentity } from './validation-evidence-reuse.js';
import { digestCanonicalJson } from './digest.js';
import {
  CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR_ID,
  evaluateEvidenceEnvironmentGateProjection,
  projectDoneRequiredReceiptToEnvironment,
} from './evidence/environment-contract.js';
import {
  DONE_REQUIRED_COMMAND_SPEC_SCHEMA,
  DONE_REQUIRED_COMMAND_SPEC_SCHEMA_V1,
  DONE_REQUIRED_EVIDENCE_SCHEMA,
  DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA,
  isDoneRequiredCommandSpecV2Schema,
  isDoneRequiredEvidenceSchema,
} from './artifact-schema.js';

export {
  DONE_REQUIRED_COMMAND_SPEC_SCHEMA,
  DONE_REQUIRED_COMMAND_SPEC_SCHEMA_V1,
  DONE_REQUIRED_EVIDENCE_SCHEMA,
  DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA,
};

export const DONE_REQUIRED_EVIDENCE_FILE = 'done-required-evidence.json';
export const DONE_REQUIRED_EVIDENCE_VERSION = 1 as const;
// v2 digests a repo-root-RELATIVE logical cwd (worktree/host portable). v1
// digested an ABSOLUTE cwd and is still accepted for pre-existing receipts.

const OUTPUT_TAIL_CHARS = 4000;
const PACKAGES_MAIN_BUILD_PROOF = 'packages-main-build' as const;

export interface DoneRequiredCommand extends ValidationCommand {
  /**
   * Command-local opt-in for the Orchestrate self-host policy. External
   * projects can require root npm test without inheriting this build proof.
   */
  requiresBuildProof?: typeof PACKAGES_MAIN_BUILD_PROOF;
  /** Explicit marker for a command that produces the packages/main build proof. */
  providesBuildProof?: typeof PACKAGES_MAIN_BUILD_PROOF;
  /** Legacy/provider alias retained for existing evidence policy compatibility. */
  proof?: typeof PACKAGES_MAIN_BUILD_PROOF;
}

export interface DoneRequiredPolicy {
  required: boolean;
  commands: DoneRequiredCommand[];
  configErrors: string[];
  warnings: string[];
  policyHash: string;
  commandSetHash: string;
  source: 'doneRequiredCommands' | 'validationProfiles.done' | 'none';
}

export interface DoneRequiredGateEvaluation {
  required: boolean;
  ok: boolean;
  status: 'pass' | 'fail' | 'warn';
  blocking: boolean;
  detail: string;
  hint: string;
  reasons: string[];
  policy: DoneRequiredPolicy;
  evidence: DoneRequiredEvidenceData | null;
  proofAdmissibility: ProofAdmissibilityDiagnostic;
}

/**
 * Single producer/consumer identity constructor for DONE-required execution.
 * Platform/env seams are exposed only for deterministic cross-platform tests;
 * production callers use the current process values.
 */
export function buildDoneRequiredExecutionIdentity(args: {
  projectRoot: string;
  policy: DoneRequiredPolicy;
  processEnvironment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): RoutineValidationIdentity {
  return buildRoutineValidationIdentity({
    projectRoot: args.projectRoot,
    sourceKind: 'configured',
    sourceInputs: args.policy.commands,
    commands: args.policy.commands,
    profile: 'done-required',
    verificationPolicyInputs: {
      policyHash: args.policy.policyHash,
      commandSetHash: args.policy.commandSetHash,
    },
    ...(args.processEnvironment ? { processEnvironment: args.processEnvironment } : {}),
    ...(args.platform ? { platform: args.platform } : {}),
  });
}

interface DoneRequiredValidationRuntimeOptions {
  progress?: ValidationProgressReporter;
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortedStringRecord(value?: Record<string, string>): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function commandSpecDigestPayload(spec: Omit<DoneRequiredCommandSpecEnvelope, 'schema' | 'digest'>): string {
  // NOTE: `resolvedCwd` (absolute physical workspace path) is deliberately NOT
  // included here — it is non-digested provenance (CHK-003), so changing only
  // the physical cwd leaves the digest unchanged and portable across worktrees.
  return stableStringify({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    shell: spec.shell,
    env: sortedStringRecord(spec.env),
    timeoutMs: spec.timeoutMs,
  });
}

function commandSpecDigest(spec: Omit<DoneRequiredCommandSpecEnvelope, 'schema' | 'digest'>): string {
  return sha256(commandSpecDigestPayload(spec));
}

/**
 * Portable (v2) command-spec envelope. The DIGESTED cwd is a workspace-root-
 * relative LOGICAL cwd derived from the cwd the command ACTUALLY ran in
 * (`executed.cwd` when present, else the configured cwd). Binding the executed
 * cwd (F-005) means a command configured for one location but run somewhere else
 * digests to where it really ran, and validateRequiredReceiptCoverage catches the
 * divergence from the policy's configured cwd (receipt-cwd-mismatch). The same
 * logical command still digests identically across worktree/host roots, and the
 * physical absolute workspace path is recorded separately (see CHK-003
 * `resolvedCwd`) as NON-digested provenance.
 */
export function buildDoneRequiredCommandSpecEnvelope(
  projectRoot: string,
  command: ValidationCommand,
  executed?: Pick<ValidationCommandResult, 'command' | 'args' | 'shell' | 'cwd'>,
): DoneRequiredCommandSpecEnvelope {
  const cwd = executed?.cwd ?? command.cwd;
  return buildV2CommandSpecEnvelopeFromLogicalCwd(
    // Derive the portable logical cwd by relativizing against projectRoot. Correct
    // at WRITE time, where projectRoot is the worktree the command actually ran in.
    repoRelativeLogicalCwd(projectRoot, cwd),
    // Non-digested provenance: the real absolute workspace path the command ran
    // in. commandSpecDigestPayload intentionally omits it so it never affects
    // the portable digest (CHK-003).
    normalizedCommandCwd(projectRoot, cwd),
    command,
    executed,
  );
}

/**
 * Core v2 envelope builder keyed on an EXPLICIT already-resolved logical cwd
 * (repo-root-relative, worktree/host portable). Callers that reconstruct an
 * expected v2 digest to VERIFY a receipt written under a DIFFERENT root must pass
 * the receipt's STORED logical cwd here — NOT an absolute physical cwd re-anchored
 * against the current projectRoot, which would embed the verifying root and break
 * cross-worktree comparison (F-009). `resolvedCwd` is non-digested provenance, so
 * it never affects the digest or `matchesEnvelope` (CHK-003).
 */
function buildV2CommandSpecEnvelopeFromLogicalCwd(
  logicalCwd: string,
  resolvedCwd: string,
  command: ValidationCommand,
  executed?: Pick<ValidationCommandResult, 'command' | 'args' | 'shell' | 'cwd'>,
): DoneRequiredCommandSpecEnvelope {
  const spec = {
    command: executed?.command ?? command.command,
    args: [...(executed?.args ?? command.args)],
    cwd: logicalCwd,
    resolvedCwd,
    shell: executed ? executed.shell === true : command.shell === true,
    env: sortedStringRecord(command.env),
    timeoutMs: resolveCommandTimeoutMs(command),
  };
  return {
    schema: DONE_REQUIRED_COMMAND_SPEC_SCHEMA,
    digest: commandSpecDigest(spec),
    ...spec,
  };
}

/**
 * Reconstruct the LEGACY (v1) absolute-cwd envelope for migration-time
 * verification only. Pre-existing receipts were written with an absolute cwd in
 * the digest; recomputing the v1 digest lets those receipts keep verifying
 * without hard-failing legacy evidence. Exported so migration tests can
 * synthesize a faithful pre-existing v1 receipt.
 */
export function buildLegacyAbsoluteCwdCommandSpecEnvelope(
  projectRoot: string,
  command: ValidationCommand,
  executed?: Pick<ValidationCommandResult, 'command' | 'args' | 'shell' | 'cwd'>,
): DoneRequiredCommandSpecEnvelope {
  const spec = {
    command: executed?.command ?? command.command,
    args: [...(executed?.args ?? command.args)],
    cwd: normalizedCommandCwd(projectRoot, executed?.cwd ?? command.cwd),
    shell: executed ? executed.shell === true : command.shell === true,
    env: sortedStringRecord(command.env),
    timeoutMs: resolveCommandTimeoutMs(command),
  };
  return {
    schema: DONE_REQUIRED_COMMAND_SPEC_SCHEMA_V1,
    digest: commandSpecDigest(spec),
    ...spec,
  };
}

/**
 * B-41c8 CHK-002: the free-form `doneRequiredCommands[]` string entry is parsed
 * by the ONE canonical legacy parser (core/validation-command-identity.ts), so
 * DONE-required execution and legacy pin identity can never disagree on
 * shell-versus-argv. Only the DoneRequiredCommand shape is built here; the
 * argv branch deliberately omits the `shell` key, exactly as before, so every
 * command-spec digest over an existing policy stays byte-identical.
 */
function parseDoneRequiredCommandString(label: string, value: string): DoneRequiredCommand | null {
  const parsed = parseLegacyValidationCommandString(value);
  if (!parsed) return null;
  return parsed.shell
    ? { label, command: parsed.command, args: [], shell: true }
    : { label, command: parsed.command, args: parsed.args };
}

function normalizePackagesMainBuildProof(
  field: string,
  value: unknown,
  errors: string[],
): typeof PACKAGES_MAIN_BUILD_PROOF | undefined {
  if (value === undefined) return undefined;
  if (value === PACKAGES_MAIN_BUILD_PROOF) return PACKAGES_MAIN_BUILD_PROOF;
  errors.push(`${field} must be "${PACKAGES_MAIN_BUILD_PROOF}" when present`);
  return undefined;
}

function normalizeCommandEntry(entry: unknown, index: number, errors: string[]): DoneRequiredCommand | null {
  if (typeof entry === 'string') {
    const command = parseDoneRequiredCommandString(`doneRequiredCommands[${index}]`, entry);
    if (!command) errors.push(`doneRequiredCommands[${index}] must not be empty`);
    return command;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`doneRequiredCommands[${index}] must be a string or command object`);
    return null;
  }
  const raw = entry as Record<string, unknown>;
  if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
    errors.push(`doneRequiredCommands[${index}].command must be a non-empty string`);
    return null;
  }
  const args = raw.args === undefined
    ? []
    : Array.isArray(raw.args)
      ? raw.args.map(String)
      : null;
  if (!args) {
    errors.push(`doneRequiredCommands[${index}].args must be an array when present`);
    return null;
  }
  if (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0)) {
    errors.push(`doneRequiredCommands[${index}].timeoutMs must be a positive number when present`);
  }
  if (raw.optional === true) {
    errors.push(`doneRequiredCommands[${index}].optional is not supported; DONE-required commands are mandatory`);
  }
  const env = raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
    ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]))
    : undefined;
  if (raw.env !== undefined && !env) {
    errors.push(`doneRequiredCommands[${index}].env must be an object when present`);
  }
  let resources: ResourceClaim[] | undefined;
  if (raw.resources !== undefined) {
    try {
      if (!Array.isArray(raw.resources)) throw new Error('resources must be an array');
      resources = raw.resources.map(claim => ({ class: claim.class, key: claim.key, access: claim.access,
        ...(claim.ownership ? { ownership: claim.ownership } : {}) }));
      validateResourceClaims(resources!, `doneRequiredCommands[${index}]`);
    } catch (error) {
      errors.push(`doneRequiredCommands[${index}].resources invalid: ${error instanceof Error ? error.message : String(error)}`);
      resources = undefined;
    }
  }
  const requiresBuildProof = normalizePackagesMainBuildProof(
    `doneRequiredCommands[${index}].requiresBuildProof`,
    raw.requiresBuildProof,
    errors,
  );
  const providesBuildProof = normalizePackagesMainBuildProof(
    `doneRequiredCommands[${index}].providesBuildProof`,
    raw.providesBuildProof,
    errors,
  );
  const proof = normalizePackagesMainBuildProof(
    `doneRequiredCommands[${index}].proof`,
    raw.proof,
    errors,
  );
  return {
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : `doneRequiredCommands[${index}]`,
    command: raw.command.trim(),
    args,
    ...(raw.shell === true ? { shell: true } : {}),
    ...(typeof raw.cwd === 'string' && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
    ...(env ? { env } : {}),
    ...(typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? { timeoutMs: raw.timeoutMs } : {}),
    ...(requiresBuildProof ? { requiresBuildProof } : {}),
    ...(providesBuildProof ? { providesBuildProof } : {}),
    ...(proof ? { proof } : {}),
    ...(resources ? { resources } : {}),
    ...(raw.executionReuse === 'exact-inputs' ? {executionReuse:'exact-inputs' as const} : {}),
    ...(Array.isArray(raw.executionInputs) ? {executionInputs:raw.executionInputs as string[]} : {}),
    ...(typeof raw.fullBaselineReusePolicy === 'string' ? {fullBaselineReusePolicy:raw.fullBaselineReusePolicy as ValidationCommand['fullBaselineReusePolicy']} : {}),
    ...(typeof raw.closurePolicy === 'string' ? {closurePolicy:raw.closurePolicy as ValidationCommand['closurePolicy']} : {}),
    ...(typeof raw.riskTier === 'string' ? {riskTier:raw.riskTier as ValidationCommand['riskTier']} : {}),
  };
}

function rawDonePolicy(config: ProofOrStopConfig): { source: DoneRequiredPolicy['source']; value: unknown } {
  const cfg = config as ProofOrStopConfig & Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(cfg, 'doneRequiredCommands')) {
    return { source: 'doneRequiredCommands', value: cfg.doneRequiredCommands };
  }
  const profiles = cfg.validationProfiles;
  if (profiles && typeof profiles === 'object' && Object.prototype.hasOwnProperty.call(profiles, 'done')) {
    const done = (profiles as { done?: unknown }).done;
    if (Array.isArray(done)) return { source: 'validationProfiles.done', value: done };
    if (done && typeof done === 'object' && Object.prototype.hasOwnProperty.call(done, 'commands')) {
      return { source: 'validationProfiles.done', value: (done as { commands?: unknown }).commands };
    }
    return { source: 'validationProfiles.done', value: done };
  }
  return { source: 'none', value: undefined };
}

export function resolveDoneRequiredPolicy(projectRoot: string): DoneRequiredPolicy {
  const config = loadConfig(projectRoot);
  const raw = rawDonePolicy(config);
  if (raw.source === 'none') {
    const emptyHash = sha256(stableStringify({ source: 'none', commands: [] }));
    return {
      required: false,
      commands: [],
      configErrors: [],
      warnings: ['No doneRequiredCommands policy configured; DONE-required full-suite proof is advisory only.'],
      policyHash: emptyHash,
      commandSetHash: sha256('[]'),
      source: 'none',
    };
  }

  const errors: string[] = [];
  const commands: DoneRequiredCommand[] = [];
  if (!Array.isArray(raw.value)) {
    errors.push(`${raw.source} must be an array of command entries`);
  } else if (raw.value.length === 0) {
    errors.push(`${raw.source} must include at least one required command`);
  } else {
    for (let i = 0; i < raw.value.length; i++) {
      const command = normalizeCommandEntry(raw.value[i], i, errors);
      if (command) commands.push(command);
    }
  }

  const normalized = commands.map((cmd) => ({
    label: cmd.label,
    command: cmd.command,
    args: cmd.args,
    shell: cmd.shell === true,
    cwd: cmd.cwd ?? '',
    env: cmd.env ?? {},
    timeoutMs: cmd.timeoutMs ?? null,
    requiresBuildProof: cmd.requiresBuildProof ?? '',
    providesBuildProof: cmd.providesBuildProof ?? '',
    proof: cmd.proof ?? '',
  }));
  return {
    required: true,
    commands,
    configErrors: errors,
    warnings: [],
    policyHash: sha256(stableStringify({ source: raw.source, raw: raw.value, normalized })),
    commandSetHash: sha256(stableStringify(normalized)),
    source: raw.source,
  };
}

function commandCwd(projectRoot: string, cwd?: string): string {
  if (!cwd) return projectRoot;
  return isAbsolute(cwd) ? cwd : resolve(projectRoot, cwd);
}

function normalizedCommandCwd(projectRoot: string, cwd?: string): string {
  return commandCwd(projectRoot, cwd).replace(/\\/g, '/');
}

/**
 * Longest-existing-prefix realpath: resolves symlinks on the part of `p` that
 * exists on disk (e.g. macOS /var -> /private/var) and re-appends any trailing
 * segments that do not exist yet. Falls back to the input verbatim when nothing
 * resolves. Used to symlink-normalize BOTH the anchor and an absolute cwd before
 * relativizing, so a symlinked workspace root does not produce a spurious '..'.
 */
function canonicalizeExisting(p: string): string {
  let current = p;
  const tail: string[] = [];
  // Bounded by path depth; dirname() reaches a fixed point at the filesystem root.
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return p;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Portable LOGICAL cwd for the command-spec digest, anchored at the STORY'S OWN
 * workspace root (projectRoot) — NOT the shared git-common-dir root. Anchoring at
 * projectRoot is what makes the same logical command portable across a story's
 * worktrees/hosts:
 *
 * - RELATIVE (or empty) cwd: resolved against projectRoot and expressed relative
 *   to that SAME root — root-independent by construction ('.' -> '.',
 *   'packages/main' -> 'packages/main').
 * - ABSOLUTE cwd INSIDE projectRoot: relativized against projectRoot, so the
 *   CORRESPONDING physical path in EVERY worktree ('<root>/packages/main') maps to
 *   the same portable logical value ('packages/main'). Anchoring an in-workspace
 *   absolute path at the SHARED root instead relativized the SAME logical location
 *   differently per worktree ('.worktrees/<id>/packages/main' vs 'packages/main')
 *   — that shared-root anchoring was the broken over-correction this replaces
 *   (F-006). resolveSharedLockRoot stays in use for the LOCK path only (CHK-001).
 * - ABSOLUTE cwd OUTSIDE projectRoot (relative result starts with '..', e.g.
 *   '/opt/tool'): it points outside this story's workspace and genuinely CANNOT be
 *   made cross-root portable. We keep the STABLE relative representation (which
 *   starts with '..'); this is an accepted, documented limitation, not something
 *   to force-anchor into an in-workspace path.
 *
 * Symlink-safe: for an absolute cwd, projectRoot and the cwd are realpath-
 * canonicalized (longest existing prefix) before relativizing, so a symlinked
 * temp/workspace root (macOS /var -> /private/var) does not yield a spurious '..'.
 *
 * Forward-slash normalized; '.' when equal to projectRoot.
 */
function repoRelativeLogicalCwd(projectRoot: string, cwd?: string): string {
  if (!cwd || !isAbsolute(cwd)) {
    // Relative/empty: both sides live in projectRoot's OWN path space, so a plain
    // resolve+relativize is exact and needs no symlink canonicalization.
    const absolute = resolve(projectRoot, cwd ?? '');
    const rel = relative(projectRoot, absolute).replace(/\\/g, '/');
    return rel === '' ? '.' : rel;
  }
  // Absolute: the configured/executed path may live in a different symlink space
  // than projectRoot, so canonicalize BOTH before relativizing against projectRoot.
  const anchor = canonicalizeExisting(projectRoot);
  const target = canonicalizeExisting(cwd);
  const rel = relative(anchor, target).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}

/**
 * The receipt's portable LOGICAL cwd for cross-root receipt verification (F-001).
 *
 * A v2 receipt already stored the shared/worktree-portable logical cwd in
 * `commandSpec.cwd` (verified independently by validateCommandSpecDigestCoverage),
 * so we trust it directly — the top-level `receipt.cwd` is an ABSOLUTE physical
 * worktree path and relativizing it embeds the writing worktree's location
 * (e.g. '.worktrees/<id>'), which breaks cross-root comparison. For legacy v1 or
 * missing envelopes we fall back to relativizing the physical `receipt.cwd`
 * against the CURRENT projectRoot, matching the pre-portability same-root
 * behavior (cross-root legacy evidence was never portable).
 */
function receiptLogicalCwd(projectRoot: string, receipt: DoneRequiredCommandReceipt): string {
  const spec = receipt.commandSpec;
  if (spec && isDoneRequiredCommandSpecV2Schema(spec.schema) && typeof spec.cwd === 'string') {
    return spec.cwd;
  }
  const physical = typeof receipt.cwd === 'string' && receipt.cwd ? receipt.cwd : projectRoot;
  const rel = relative(projectRoot, physical).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}

function outputTail(output: string): string {
  return output.length <= OUTPUT_TAIL_CHARS ? output : output.slice(output.length - OUTPUT_TAIL_CHARS);
}

function commandStatus(code: number, timedOut?: boolean): DoneRequiredEvidenceStatus {
  return code === 0 && !timedOut ? 'PASS' : 'FAIL';
}

function doneRequiredDeadlineError(options: DoneRequiredValidationRuntimeOptions): Error {
  const reason = (options.abortSignal as (AbortSignal & { reason?: unknown }) | undefined)?.reason;
  if (reason instanceof Error) return reason;
  return options.deadlineError?.() ?? new Error('DONE-required validation aborted by caller deadline');
}

function throwIfDoneRequiredDeadlineExceeded(options: DoneRequiredValidationRuntimeOptions): void {
  if (options.abortSignal?.aborted) throw doneRequiredDeadlineError(options);
  if (typeof options.deadlineAt === 'number' && Number.isFinite(options.deadlineAt) && Date.now() >= options.deadlineAt) {
    throw doneRequiredDeadlineError(options);
  }
}

function receiptLine(receipt: DoneRequiredCommandReceipt): string {
  const args = Array.isArray(receipt.args) ? receipt.args : [];
  return `${receipt.status} ${receipt.label}: ${receipt.command} ${args.join(' ')}`.trim();
}

function isPackagesMainBuild(receipt: DoneRequiredCommandReceipt, projectRoot: string, command?: DoneRequiredCommand, artifactsRoot: string = projectRoot): boolean {
  if (receipt.status !== 'PASS') return false;
  if (command?.providesBuildProof === PACKAGES_MAIN_BUILD_PROOF || command?.proof === PACKAGES_MAIN_BUILD_PROOF) return true;
  // Compare on the portable LOGICAL cwd (not the absolute physical receipt.cwd)
  // so a build proof written in worktree A is still recognized when evaluated
  // under root B (F-001).
  // One recogniser for launch and receipt: the receipt's logical cwd is
  // relative to the project root, and the shared matcher judges it against
  // the artifact root (the git root on a wrapper-root layout).
  return isRegisteredPackagesMainBuildCommand({
    command: receipt.command,
    args: Array.isArray(receipt.args) ? receipt.args : [],
    cwd: receiptLogicalCwd(projectRoot, receipt),
    // The DECLARED shell mode: the executor records shell:true as a transport
    // detail on Windows for every command, which says nothing about whether
    // the policy asked for a shell command line.
    shell: command?.shell === true,
  }, projectRoot, artifactsRoot);
}

function requiresPackagesMainBuildProof(command?: DoneRequiredCommand): boolean {
  return command?.requiresBuildProof === PACKAGES_MAIN_BUILD_PROOF;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const aEntries = Object.entries(a).sort(([left], [right]) => left.localeCompare(right));
  const bEntries = Object.entries(b).sort(([left], [right]) => left.localeCompare(right));
  return aEntries.length === bEntries.length && aEntries.every(([key, value], index) => {
    const [otherKey, otherValue] = bEntries[index];
    return key === otherKey && value === otherValue;
  });
}

export function validateCommandSpecDigestCoverage(
  evidence: Pick<DoneRequiredEvidenceData, 'receipts'>,
  projectRoot: string,
  commands: ValidationCommand[],
): { valid?: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
  let missing = false;
  let mismatch = false;

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const receipt = receipts[i];
    if (!receipt) {
      missing = true;
      reasons.push(`command-spec-missing[${i}]: missing receipt for ${formatValidationCommand(command)}`);
      continue;
    }

    const commandSpec = receipt.commandSpec;
    if (!commandSpec || typeof commandSpec !== 'object') {
      missing = true;
      reasons.push(`command-spec-missing[${i}]: ${receipt.label}`);
      continue;
    }

    const executedShape: Pick<ValidationCommandResult, 'command' | 'args' | 'shell' | 'cwd'> = {
      command: receipt.command,
      args: Array.isArray(receipt.args) ? receipt.args : [],
      ...(receipt.shell ? { shell: true } : {}),
      cwd: receipt.cwd,
    };
    // v2 reconstruction MUST use the receipt's STORED portable logical cwd
    // (receiptLogicalCwd — the same helper validateRequiredReceiptCoverage uses),
    // NOT receipt.cwd re-normalized against the current projectRoot. The receipt's
    // top-level cwd is an ABSOLUTE physical worktree path; re-anchoring it via the
    // verifying projectRoot embeds THIS root's location (e.g. '.worktrees/<id>'),
    // so a cross-worktree receipt that validateRequiredReceiptCoverage correctly
    // ACCEPTS would be wrongly rejected here as command-spec-digest-mismatch (F-009).
    // resolvedCwd is non-digested provenance and does not affect the digest/match.
    const expectedNew = buildV2CommandSpecEnvelopeFromLogicalCwd(
      receiptLogicalCwd(projectRoot, receipt),
      normalizedCommandCwd(projectRoot, receipt.cwd),
      command,
      executedShape,
    );
    // The v2 digest excludes the schema label. Older canonical v2 receipt
    // provenance remains verifiable after the current schema guard above.
    const expectedLegacyV2: DoneRequiredCommandSpecEnvelope = {
      ...expectedNew,
      schema: DONE_REQUIRED_COMMAND_SPEC_SCHEMA,
    };
    // The LEGACY v1 branch keeps absolute-cwd reconstruction — that IS correct for
    // v1 receipts, which digested an absolute cwd and were never cross-root portable.
    const expectedLegacy = buildLegacyAbsoluteCwdCommandSpecEnvelope(projectRoot, command, executedShape);

    const matchesEnvelope = (candidate: DoneRequiredCommandSpecEnvelope): boolean =>
      commandSpec.schema === candidate.schema &&
      commandSpec.command === candidate.command &&
      Array.isArray(commandSpec.args) &&
      sameStringArray(commandSpec.args, candidate.args) &&
      commandSpec.cwd === candidate.cwd &&
      commandSpec.shell === candidate.shell &&
      commandSpec.timeoutMs === candidate.timeoutMs &&
      Boolean(commandSpec.env) &&
      !Array.isArray(commandSpec.env) &&
      sameStringRecord(commandSpec.env, candidate.env) &&
      commandSpec.digest === candidate.digest;

    // MIGRATION: accept a receipt whose stored envelope matches EITHER the new
    // portable v2 relative-cwd digest OR the legacy v1 absolute-cwd digest, so
    // pre-existing receipts still verify without hard-failing legacy evidence.
    if (!matchesEnvelope(expectedNew)
      && !matchesEnvelope(expectedLegacyV2)
      && !matchesEnvelope(expectedLegacy)) {
      mismatch = true;
      reasons.push(`command-spec-digest-mismatch[${i}]: ${receipt.label}`);
    }
  }

  return {
    valid: missing ? undefined : !mismatch,
    reasons,
  };
}

export function validateRequiredReceiptCoverage(
  evidence: Pick<DoneRequiredEvidenceData, 'receipts'>,
  projectRoot: string,
  commands: DoneRequiredCommand[],
  executionIdentity?: RoutineValidationIdentity,
): string[] {
  const reasons: string[] = [];
  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
  if (!Array.isArray(evidence.receipts)) {
    reasons.push('receipt-shape-mismatch: receipts must be an array');
  }
  if (receipts.length !== commands.length) {
    reasons.push(`receipt-count-mismatch: expected ${commands.length}, got ${receipts.length}`);
  }

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const receipt = receipts[i];
    if (!receipt) {
      reasons.push(`missing-receipt[${i}]: ${formatDoneRequiredCommand(command)}`);
      continue;
    }

    if (receipt.command !== command.command) {
      reasons.push(`receipt-command-mismatch[${i}]: expected ${command.command}, got ${receipt.command}`);
    }
    if (!Array.isArray(receipt.args) || !sameStringArray(receipt.args, command.args)) {
      const actualArgs = Array.isArray(receipt.args) ? receipt.args : [];
      reasons.push(`receipt-args-mismatch[${i}]: expected ${JSON.stringify(command.args)}, got ${JSON.stringify(actualArgs)}`);
    }

    // Compare a repo-relative LOGICAL cwd on BOTH sides (F-001). The old code
    // compared absolute physical paths, so a receipt written in worktree A
    // failed under root B (receipt-cwd-mismatch) — the exact cross-root scenario
    // this story fixes. The logical cwd is worktree/host portable, yet genuinely
    // different cwds still normalize differently and remain distinguishable.
    const expectedCwd = repoRelativeLogicalCwd(projectRoot, command.cwd);
    const actualCwd = receiptLogicalCwd(projectRoot, receipt);
    if (actualCwd !== expectedCwd) {
      reasons.push(`receipt-cwd-mismatch[${i}]: expected ${expectedCwd}, got ${actualCwd || '<missing>'}`);
    }

    const expectedShell = executionIdentity?.commands[i]?.shell ?? command.shell === true;
    const actualShell = receipt.shell === true;
    if (actualShell !== expectedShell) {
      reasons.push(`receipt-shell-mismatch[${i}]: expected ${expectedShell}, got ${actualShell}`);
    }

    if (receipt.status !== 'PASS' || receipt.exitCode !== 0 || receipt.timedOut === true) {
      reasons.push(`receipt-status-fail[${i}]: status=${receipt.status} exitCode=${receipt.exitCode} timedOut=${receipt.timedOut === true}`);
    }
  }

  return reasons;
}

export function validateSelfHostBuildProof(
  evidence: Pick<DoneRequiredEvidenceData, 'receipts'>,
  projectRoot: string,
  commands: DoneRequiredCommand[] = [],
  artifactsRoot: string = projectRoot,
): string[] {
  const reasons: string[] = [];
  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i];
    const command = commands[i];
    if (!requiresPackagesMainBuildProof(command)) continue;
    const build = receipts.slice(0, i).find((candidate, candidateIndex) => (
      isPackagesMainBuild(candidate, projectRoot, commands[candidateIndex], artifactsRoot) &&
      candidate.materialHash &&
      receipt.materialHash &&
      candidate.materialHash === receipt.materialHash
    ));
    if (!build) {
      reasons.push(`missing-build-proof: ${receipt.label} requires a preceding PASS receipt for npm --prefix packages/main run build, or equivalent packages/main build proof, with the same materialHash`);
    }
  }
  return reasons;
}

/**
 * Per-receipt build binding. Each receipt records the compiled-artifact
 * content digest it started against and the one it left behind. The receipts
 * run sequentially, so the chain must be continuous: every receipt starts on
 * exactly the bytes the previous one left behind, otherwise something rewrote
 * the dist between two commands. Only a registered packages/main build receipt
 * may change the identity; any other command that does so has rewritten the
 * dist under test. Every non-build receipt must have started against the
 * identity the evidence finally binds, so a build that lands after a test
 * invalidates that test instead of relabelling it, and that final identity
 * must be the output of the last registered build, so a rewrite that lands
 * after the build cannot be published as the build's own bytes. Legacy
 * receipts without the observations cannot vouch and are refused.
 */
/**
 * Refusal of a DONE-required run BEFORE any command launches. This evidence is
 * the authoritative executed-build proof, so on a host whose artifact trees
 * exist but cannot be write-protected, every non-build receipt would be refused
 * by validateReceiptBuildBinding after the run anyway. Deciding that here means
 * an unsupported host learns why in seconds, with the remedy, instead of after
 * the whole suite, and nothing is executed whose evidence could not count.
 *
 * Only the commands that would run under THIS resolution are judged: the
 * non-build commands before the first registered build. A registered build may
 * repair the very topology that made the resolution unenforced (a missing
 * artifact tree that bwrap could not bind), and the writer re-resolves the
 * protection after it; the commands that follow are decided then, by the
 * same rule, and refused there if enforcement is still unavailable. A
 * `not-applicable` host (no artifact trees, nothing to protect) and a policy
 * made only of registered builds are not refused.
 */
export function doneRequiredProtectionRefusal(
  protectionLabel: string,
  commands: DoneRequiredCommand[],
  projectRoot: string,
  artifactsRoot: string = projectRoot,
): string | undefined {
  if (artifactProtectionSatisfied(protectionLabel)) return undefined;
  const isBuild = (command: DoneRequiredCommand): boolean => command.providesBuildProof === PACKAGES_MAIN_BUILD_PROOF
    || command.proof === PACKAGES_MAIN_BUILD_PROOF
    || isRegisteredPackagesMainBuildCommand(command, projectRoot, artifactsRoot);
  const firstBuild = commands.findIndex(isBuild);
  const exposed = firstBuild < 0 ? commands : commands.slice(0, firstBuild);
  const unprotected = exposed.filter((command) => !isBuild(command));
  if (unprotected.length === 0) return undefined;
  const labels = unprotected.map((command) => command.label).join(', ');
  return `build-artifacts-protection-unavailable: ${protectionLabel}; ${unprotected.length} non-build DONE-required command(s) (${labels}) would run without enforced artifact write protection and their receipts would be refused, so nothing was executed. Provide a write-protection mechanism for this host (macOS: /usr/bin/sandbox-exec; Linux: bwrap on PATH) or remove the compiled artifact trees (${BUILD_ARTIFACT_ROOTS.join(', ')}) if this project does not execute them.`;
}

export function validateReceiptBuildBinding(
  evidence: Pick<DoneRequiredEvidenceData, 'receipts' | 'buildArtifactsHash'>,
  projectRoot: string,
  commands: DoneRequiredCommand[] = [],
  artifactsRoot: string = projectRoot,
): string[] {
  const reasons: string[] = [];
  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
  let previous: { label: string; after: string } | undefined;
  let lastRegisteredBuildOutput: string | undefined;
  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i];
    const before = receipt.buildArtifactsBefore;
    const after = receipt.buildArtifactsAfter;
    if (!before || !after) {
      reasons.push(`missing-receipt-build-binding[${i}]: ${receipt.label} did not record the build identity it executed`);
      previous = undefined;
      continue;
    }
    if (previous && before !== previous.after) {
      reasons.push(`build-artifacts-changed-between-receipts[${i}]: ${receipt.label} started on compiled artifacts that differ from what ${previous.label} left behind; the dist was rewritten between two receipts`);
    }
    previous = { label: receipt.label, after };
    if (isPackagesMainBuild(receipt, projectRoot, commands[i], artifactsRoot)) {
      lastRegisteredBuildOutput = after;
      continue;
    }
    // DONE-required evidence is the authoritative executed-build proof, so a
    // receipt whose command could have swapped the artifacts inside its own
    // window — undetectable at the boundaries — cannot carry that claim.
    if (!artifactProtectionSatisfied(receipt.buildArtifactsProtection)) {
      reasons.push(`build-artifacts-protection-unenforced[${i}]: ${receipt.label} ran without enforced artifact write protection (${receipt.buildArtifactsProtection ?? 'not recorded'}); this evidence cannot prove which build it executed`);
    }
    if (before !== after) {
      reasons.push(`build-artifacts-changed-during-command[${i}]: ${receipt.label} rewrote the compiled artifacts but is not a registered packages/main build`);
    }
    if (evidence.buildArtifactsHash && before !== evidence.buildArtifactsHash) {
      reasons.push(`receipt-not-bound-to-final-build[${i}]: ${receipt.label} executed a build that was replaced before the evidence was bound; rerun it against the final build`);
    }
  }
  if (evidence.buildArtifactsHash && lastRegisteredBuildOutput && evidence.buildArtifactsHash !== lastRegisteredBuildOutput) {
    reasons.push('build-artifacts-differ-from-registered-build: the evidence binds compiled artifacts that are not the output of the last registered packages/main build; a later command or an external write replaced the dist');
  }
  return reasons;
}

function validateDoneRequiredEvidenceEnvironmentProjection(
  evidence: DoneRequiredEvidenceData,
  policy: DoneRequiredPolicy,
): string[] {
  const reasons: string[] = [];
  const subjectDigest = digestCanonicalJson({
    storyId: evidence.storyId,
    headHash: evidence.headHash ?? null,
    materialHash: evidence.materialHash ?? null,
    storyFilesHash: evidence.storyFilesHash ?? null,
  });
  for (let i = 0; i < evidence.receipts.length; i++) {
    const commandReceipt = evidence.receipts[i];
    try {
      // The evidence-environment adapter predates this story and only knows
      // the historical v2 label.  Its normalized command identity excludes
      // the schema label, so bridge the canonical label locally without
      // changing the stored receipt or teaching that out-of-scope adapter to
      // rewrite artifacts.  Unknown schemas still go through unchanged and
      // fail closed there.
      const adapterReceipt = commandReceipt.commandSpec?.schema === DONE_REQUIRED_COMMAND_SPEC_SCHEMA
        ? {
            ...commandReceipt,
            commandSpec: {
              ...commandReceipt.commandSpec,
              schema: DONE_REQUIRED_COMMAND_SPEC_SCHEMA,
            },
          }
        : commandReceipt;
      const projected = projectDoneRequiredReceiptToEnvironment(adapterReceipt, {
        invocationId: `done-required:${i}:${commandReceipt.commandSpec?.digest ?? 'missing'}`,
        subjectId: evidence.storyId,
        subjectDigest,
        policyId: policy.source,
        policyDigest: policy.policyHash,
        requestedAt: commandReceipt.startedAt,
        freshnessDeadline: '9999-12-31T23:59:59.999Z',
      });
      const gate = evaluateEvidenceEnvironmentGateProjection({
        descriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR_ID,
        invocation: projected.invocation,
        receipt: projected.receipt,
        artifactKind: 'done-required-evidence',
        consumer: 'DONE_REQUIRED',
        claim: 'done-readiness',
        checks: {
          schemaVersion: 'proof-or-stop.done_required_evidence.v1',
          strictShapeValid: true,
          temporalAndMaterialBindingValid: true,
          subjectMatches: true,
          producerBoundaryTrusted: true,
          commandSpecDigestValid: true,
          hashTupleFresh: true,
        },
      });
      if (!gate.allowed) {
        reasons.push(...gate.reasons.map((reason) => `evidence-environment[${i}]: ${reason}`));
      }
    } catch (error) {
      reasons.push(`evidence-environment[${i}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...new Set(reasons)];
}

function validateDoneRequiredExecutionIdentityCoverage(
  evidence: DoneRequiredEvidenceData,
  currentIdentity: RoutineValidationIdentity,
  policy: DoneRequiredPolicy,
): string[] {
  const reasons: string[] = [];
  for (let i = 0; i < policy.commands.length; i++) {
    const receipt = evidence.receipts[i];
    const commandIdentity = currentIdentity.commands[i];
    if (!receipt || !commandIdentity) {
      reasons.push(`execution-identity-missing[${i}]`);
      continue;
    }
    if (!receipt.effectiveEnvironmentDigest || receipt.effectiveEnvironmentDigest !== commandIdentity.effectiveEnvironmentDigest) {
      reasons.push(`effective-environment-digest-mismatch[${i}]`);
    }
    if (receipt.executableDigest !== commandIdentity.executableDigest) {
      reasons.push(`executable-digest-mismatch[${i}]`);
    }
    const expectedShellDigest = commandIdentity.shellExecutableDigest ?? null;
    const receiptShellDigest = receipt.shellExecutableDigest ?? null;
    if ((receipt.shell === true) !== commandIdentity.shell
      || receiptShellDigest !== expectedShellDigest
      || (commandIdentity.shell && !receiptShellDigest)) {
      reasons.push(`shell-executable-digest-mismatch[${i}]`);
    }
  }
  return reasons;
}

export async function runDoneRequiredValidation(args: {
  projectRoot: string;
  storyId: string;
  store: StoryStore;
  gitCwd: string;
  options?: DoneRequiredValidationRuntimeOptions;
}): Promise<DoneRequiredEvidenceData> {
  const runtimeOptions = args.options ?? {};
  throwIfDoneRequiredDeadlineExceeded(runtimeOptions);
  const policy = resolveDoneRequiredPolicy(args.projectRoot);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const receipts: DoneRequiredCommandReceipt[] = [];
  const reasons: string[] = [];
  const executionIdentity = buildDoneRequiredExecutionIdentity({
    projectRoot: args.projectRoot,
    policy,
  });

  if (!policy.required) {
    reasons.push('no doneRequiredCommands policy configured');
  }
  if (policy.configErrors.length > 0) {
    reasons.push(...policy.configErrors.map((error) => `config-error: ${error}`));
  }

  if (policy.required && policy.configErrors.length === 0) {
    // The contract declaration is read from the configuration root
    // (projectRoot), which on a wrapper-root layout is not the artifact root.
    let artifactWriteProtection = resolveArtifactWriteProtection(args.gitCwd, { configRoot: args.projectRoot });
    // Unsupported host: decided before the first launch, never after the suite.
    let protectionRefusal = doneRequiredProtectionRefusal(artifactWriteProtection.label, policy.commands, args.projectRoot, args.gitCwd);
    if (protectionRefusal) reasons.push(protectionRefusal);
    // A registered build may create or replace the trees, and a
    // `not-applicable` exemption holds only while no tree exists, so the
    // protection is re-resolved before any later non-build receipt, and the
    // refusal above is re-decided for the commands that remain.
    let buildRanSinceResolve = false;
    for (let i = 0; !protectionRefusal && i < policy.commands.length; i++) {
      const command = policy.commands[i];
      throwIfDoneRequiredDeadlineExceeded(runtimeOptions);
      const commandIsRegisteredBuild = command.providesBuildProof === PACKAGES_MAIN_BUILD_PROOF
        || command.proof === PACKAGES_MAIN_BUILD_PROOF
        || isRegisteredPackagesMainBuildCommand(command, args.projectRoot, args.gitCwd);
      if (!commandIsRegisteredBuild && artifactProtectionStale(artifactWriteProtection, { buildRanSinceResolve, anyRootExists: hasAnyArtifactRoot(args.gitCwd, args.projectRoot) })) {
        artifactWriteProtection = resolveArtifactWriteProtection(args.gitCwd, { configRoot: args.projectRoot });
        buildRanSinceResolve = false;
        protectionRefusal = doneRequiredProtectionRefusal(artifactWriteProtection.label, policy.commands.slice(i), args.projectRoot, args.gitCwd);
        if (protectionRefusal) {
          reasons.push(`${protectionRefusal} (protection re-resolved before ${command.label}, after the registered build created or replaced the artifact trees)`);
          break;
        }
      }
      const receiptStartedMs = Date.now();
      const receiptStartedAt = new Date(receiptStartedMs).toISOString();
      // Per-receipt build identity: the dist this command started against and
      // the dist it left behind. Only a registered build receipt may change it,
      // and every test receipt must have started against the final build.
      // Boundary observations cannot see a swap a command undoes before it
      // returns, so every non-build receipt executes under a mechanism that
      // denies it, and its descendants, the right to write these trees.
      const result = await runValidationCommand(command, args.projectRoot, DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS, {
        ...(commandIsRegisteredBuild ? {} : { artifactWriteProtection }),
        // Observed at the spawn boundary (or inherited from the reuse key for a
        // cached run); this writer records what the execution carried and never
        // relabels a result with what it observes afterwards.
        artifactBinding: { root: args.gitCwd, configRoot: args.projectRoot, protection: commandIsRegisteredBuild ? REGISTERED_BUILD_PROTECTION_LABEL : artifactWriteProtection.label },
        progress: runtimeOptions.progress,
        heartbeatMs: runtimeOptions.heartbeatMs,
        abortSignal: runtimeOptions.abortSignal,
        deadlineAt: runtimeOptions.deadlineAt,
        commandIndex: i + 1,
        totalCommands: policy.commands.length,
      });
      throwIfDoneRequiredDeadlineExceeded(runtimeOptions);
      if (commandIsRegisteredBuild) buildRanSinceResolve = true;
      const receiptEndedAt = new Date().toISOString();
      const headHash = currentGitHead(args.gitCwd);
      const materialHash = currentMaterialHash(args.gitCwd, 'HEAD', args.projectRoot);
      const storyFilesHash = currentStoryFilesHash(args.gitCwd, 'HEAD', args.projectRoot);
      const status = commandStatus(result.code, result.timedOut);
      const commandIdentity = executionIdentity.commands[i];
      const receipt: DoneRequiredCommandReceipt = {
        label: result.label,
        command: result.command,
        args: result.args,
        commandSpec: buildDoneRequiredCommandSpecEnvelope(args.projectRoot, command, result),
        ...(result.shell ? { shell: true } : {}),
        cwd: result.cwd ?? commandCwd(args.projectRoot, command.cwd),
        status,
        exitCode: result.code,
        durationMs: result.durationMs,
        outputDigest: sha256(result.output),
        outputTail: outputTail(result.output),
        // These are this consumer's receipt boundaries. executionReceipt keeps
        // the original child execution attribution when no child was launched.
        startedAt: receiptStartedAt,
        endedAt: receiptEndedAt,
        ...(result.executionReceipt ? {executionReceipt:result.executionReceipt} : {}),
        ...(result.executionDecision ? {executionDecision:result.executionDecision} : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(commandIdentity
          ? {
              effectiveEnvironmentDigest: commandIdentity.effectiveEnvironmentDigest,
              executableDigest: commandIdentity.executableDigest,
              shellExecutableDigest: commandIdentity.shellExecutableDigest ?? null,
            }
          : {}),
        ...(headHash ? { headHash } : {}),
        ...(materialHash ? { materialHash } : {}),
        ...(storyFilesHash ? { storyFilesHash } : {}),
        ...(result.buildArtifactsBefore ? { buildArtifactsBefore: result.buildArtifactsBefore } : {}),
        ...(result.buildArtifactsAfter ? { buildArtifactsAfter: result.buildArtifactsAfter } : {}),
        ...(result.buildArtifactsProtection ? { buildArtifactsProtection: result.buildArtifactsProtection } : {}),
      };
      receipts.push(receipt);
      if (status === 'FAIL') {
        reasons.push(`command-failed: ${receiptLine(receipt)} exitCode=${receipt.exitCode}`);
      }
    }
  }

  // End-of-execution build identity: the dist the receipts executed, observed
  // the moment the last command returned (after the build receipt rewrote it).
  const executionBuildArtifactsHash = currentBuildArtifactsHash(args.gitCwd, args.projectRoot);
  throwIfDoneRequiredDeadlineExceeded(runtimeOptions);
  reasons.push(...validateSelfHostBuildProof({ receipts }, args.projectRoot, policy.commands, args.gitCwd));
  // Every test receipt must have executed the build this evidence binds, and
  // nothing but a registered build may have rewritten the dist mid-run.
  reasons.push(...validateReceiptBuildBinding({ receipts, buildArtifactsHash: executionBuildArtifactsHash }, args.projectRoot, policy.commands, args.gitCwd));

  const endedMs = Date.now();
  const finalHeadHash = currentGitHead(args.gitCwd);
  const finalMaterialHash = currentMaterialHash(args.gitCwd, 'HEAD', args.projectRoot);
  const finalStoryFilesHash = currentStoryFilesHash(args.gitCwd, 'HEAD', args.projectRoot);
  // Publication must still see the executed identity; a dist that moved in
  // between was never tested by these receipts, so the evidence fails instead
  // of binding a PASS to an untested build. An unreadable identity fails too.
  const publicationBuildArtifactsHash = currentBuildArtifactsHash(args.gitCwd, args.projectRoot);
  if (!executionBuildArtifactsHash || !publicationBuildArtifactsHash) {
    reasons.push('build-artifacts-identity-unavailable');
  } else if (executionBuildArtifactsHash !== publicationBuildArtifactsHash) {
    reasons.push('build-artifacts-changed-before-publication');
  }
  const finalBuildArtifactsHash = executionBuildArtifactsHash;
  const status: DoneRequiredEvidenceStatus = policy.required && reasons.length === 0 ? 'PASS' : 'FAIL';
  const evidence: DoneRequiredEvidenceData = {
    schema: DONE_REQUIRED_EVIDENCE_SCHEMA,
    version: DONE_REQUIRED_EVIDENCE_VERSION,
    storyId: args.storyId,
    status,
    startedAt,
    endedAt: new Date(endedMs).toISOString(),
    durationMs: endedMs - startedMs,
    ...(finalHeadHash ? { headHash: finalHeadHash } : {}),
    ...(finalMaterialHash ? { materialHash: finalMaterialHash } : {}),
    ...(finalStoryFilesHash ? { storyFilesHash: finalStoryFilesHash } : {}),
    ...(finalBuildArtifactsHash ? { buildArtifactsHash: finalBuildArtifactsHash } : {}),
    policyHash: policy.policyHash,
    commandSetHash: policy.commandSetHash,
    receipts,
    reasons,
    ...(policy.configErrors.length > 0 ? { configErrors: policy.configErrors } : {}),
  };
  throwIfDoneRequiredDeadlineExceeded(runtimeOptions);
  args.store.writeDoneRequiredEvidence(args.storyId, evidence);
  return evidence;
}

export function evaluateDoneRequiredEvidence(args: {
  projectRoot: string;
  storyId: string;
  store: StoryStore;
  gitCwd: string;
  /** Deterministic platform/env seam for cross-platform identity regressions. */
  executionIdentityContext?: {
    processEnvironment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  };
}): DoneRequiredGateEvaluation {
  const policy = resolveDoneRequiredPolicy(args.projectRoot);
  const proofPolicy = resolveProofAdmissibilityPolicy(args.projectRoot);
  const doneRequiredDiagnostic = (
    evidence: DoneRequiredEvidenceData | null,
    ok: boolean,
    commandSpecDigestValid?: boolean,
  ): ProofAdmissibilityDiagnostic => buildProofAdmissibilityDiagnostic({
    artifactKind: 'done-required-evidence',
    artifactId: DONE_REQUIRED_EVIDENCE_FILE,
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    policy: proofPolicy,
    checks: {
      schemaVersion: evidence?.schema === DONE_REQUIRED_EVIDENCE_SCHEMA && evidence?.version === DONE_REQUIRED_EVIDENCE_VERSION
        ? 'proof-or-stop.done_required_evidence.v1'
        : undefined,
      strictShapeValid: Boolean(evidence),
      semanticDigestValid: ok,
      temporalAndMaterialBindingValid: ok,
      subjectMatches: evidence ? evidence.storyId === args.storyId : false,
      producerBoundaryTrusted: Boolean(evidence),
      commandSpecDigestValid,
    },
  });
  const withProofBlock = (
    result: Omit<DoneRequiredGateEvaluation, 'blocking' | 'ok' | 'status'> & Pick<DoneRequiredGateEvaluation, 'ok' | 'status'>,
  ): DoneRequiredGateEvaluation => {
    const reason = proofAdmissibilityBlockingReason(result.proofAdmissibility);
    if (!reason) {
      return { ...result, blocking: !result.ok && result.status === 'fail' };
    }
    return {
      ...result,
      ok: false,
      status: 'fail',
      blocking: true,
      detail: result.ok ? reason : result.detail,
      hint: result.hint ? `${result.hint}\n${reason}` : reason,
      reasons: [...new Set([...result.reasons, reason])],
    };
  };
  if (!policy.required) {
    return {
      required: false,
      ok: true,
      status: 'warn',
      blocking: false,
      detail: 'no doneRequiredCommands policy configured; no full-suite DONE claim',
      hint: 'External projects are advisory by default. Configure doneRequiredCommands to make DONE-required validation blocking.',
      reasons: policy.warnings,
      policy,
      evidence: null,
      proofAdmissibility: doneRequiredDiagnostic(null, false),
    };
  }
  if (policy.configErrors.length > 0) {
    return withProofBlock({
      required: true,
      ok: false,
      status: 'fail',
      detail: `malformed DONE-required policy: ${policy.configErrors[0]}`,
      hint: policy.configErrors.join('\n'),
      reasons: policy.configErrors,
      policy,
      evidence: null,
      proofAdmissibility: doneRequiredDiagnostic(null, false),
    });
  }

  const evidence = args.store.readDoneRequiredEvidence(args.storyId);
  if (!evidence) {
    return withProofBlock({
      required: true,
      ok: false,
      status: 'fail',
      detail: 'missing done-required-evidence.json',
      hint: `proof-or-stop done_required_validate --storyId=${args.storyId}`,
      reasons: ['missing-artifact'],
      policy,
      evidence: null,
      proofAdmissibility: doneRequiredDiagnostic(null, false),
    });
  }

  const reasons: string[] = [];
  const currentExecutionIdentity = buildDoneRequiredExecutionIdentity({
    projectRoot: args.projectRoot,
    policy,
    ...(args.executionIdentityContext?.processEnvironment
      ? { processEnvironment: args.executionIdentityContext.processEnvironment }
      : {}),
    ...(args.executionIdentityContext?.platform
      ? { platform: args.executionIdentityContext.platform }
      : {}),
  });
  if (!isDoneRequiredEvidenceSchema(evidence.schema) || evidence.version !== DONE_REQUIRED_EVIDENCE_VERSION) {
    reasons.push('schema-version-mismatch');
  }
  if (evidence.storyId !== args.storyId) reasons.push(`storyId-mismatch: ${evidence.storyId}`);
  if (evidence.status !== 'PASS') reasons.push(...(evidence.reasons.length > 0 ? evidence.reasons : ['status-fail']));
  if (evidence.policyHash !== policy.policyHash) reasons.push('policy-drift');
  if (evidence.commandSetHash !== policy.commandSetHash) reasons.push('command-set-drift');
  reasons.push(...validateRequiredReceiptCoverage(
    evidence,
    args.projectRoot,
    policy.commands,
    currentExecutionIdentity,
  ));
  const commandSpecDigestCoverage = validateCommandSpecDigestCoverage(evidence, args.projectRoot, policy.commands);
  reasons.push(...commandSpecDigestCoverage.reasons);

  const currentMaterial = currentMaterialHash(args.gitCwd, 'HEAD', args.projectRoot);
  const currentStoryFiles = currentStoryFilesHash(args.gitCwd, 'HEAD', args.projectRoot);
  // headHash remains an audit stamp only. Committing done-required-evidence.json
  // bumps HEAD with story metadata, while materialHash excludes story metadata
  // and still changes for real code/config drift. Blocking on headHash deadlocked
  // DONE: writing the evidence moved HEAD past the recorded headHash, re-staling
  // freshly-validated evidence. materialHash + storyFilesHash are the authoritative
  // freshness gate; both still re-stale on genuine code/config/story drift.
  if (!evidence.materialHash || !currentMaterial) reasons.push('missing-materialHash');
  else if (evidence.materialHash !== currentMaterial) reasons.push('stale-material');
  if (!evidence.storyFilesHash || !currentStoryFiles) reasons.push('missing-storyFilesHash');
  else if (evidence.storyFilesHash !== currentStoryFiles) reasons.push('stale-storyFilesHash');
  // validateSelfHostBuildProof below proves a build receipt preceded the tests;
  // this proves the dist on disk is still the one those receipts executed.
  const currentBuildArtifacts = currentBuildArtifactsHash(args.gitCwd, args.projectRoot);
  if (!evidence.buildArtifactsHash || !currentBuildArtifacts) reasons.push('missing-buildArtifactsHash');
  else if (evidence.buildArtifactsHash !== currentBuildArtifacts) reasons.push('stale-buildArtifacts');
  reasons.push(...validateSelfHostBuildProof(evidence, args.projectRoot, policy.commands, args.gitCwd));
  reasons.push(...validateReceiptBuildBinding(evidence, args.projectRoot, policy.commands, args.gitCwd));
  reasons.push(...validateDoneRequiredExecutionIdentityCoverage(evidence, currentExecutionIdentity, policy));

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0) {
    return withProofBlock({
      required: true,
      ok: false,
      status: 'fail',
      detail: uniqueReasons.slice(0, 3).join(', '),
      hint: [
        ...uniqueReasons,
        `rerun: proof-or-stop done_required_validate --storyId=${args.storyId}`,
      ].join('\n'),
      reasons: uniqueReasons,
      policy,
      evidence,
      proofAdmissibility: doneRequiredDiagnostic(evidence, false, commandSpecDigestCoverage.valid),
    });
  }

  const environmentProjectionReasons = validateDoneRequiredEvidenceEnvironmentProjection(evidence, policy);
  if (environmentProjectionReasons.length > 0) {
    return withProofBlock({
      required: true,
      ok: false,
      status: 'fail',
      detail: environmentProjectionReasons.slice(0, 3).join(', '),
      hint: [
        ...environmentProjectionReasons,
        `rerun: proof-or-stop done_required_validate --storyId=${args.storyId}`,
      ].join('\n'),
      reasons: environmentProjectionReasons,
      policy,
      evidence,
      proofAdmissibility: doneRequiredDiagnostic(evidence, false, commandSpecDigestCoverage.valid),
    });
  }

  return withProofBlock({
    required: true,
    ok: true,
    status: 'pass',
    detail: `PASS @ ${evidence.endedAt}; ${evidence.receipts.length} required command(s)`,
    hint: evidence.receipts.map(receiptLine).join('\n'),
    reasons: [],
    policy,
    evidence,
    proofAdmissibility: doneRequiredDiagnostic(evidence, true, commandSpecDigestCoverage.valid),
  });
}

export function renderDoneRequiredEvidence(evidence: DoneRequiredEvidenceData): string {
  const lines = [
    `DONE-required validation: ${evidence.status}`,
    `storyId: ${evidence.storyId}`,
    `durationMs: ${evidence.durationMs}`,
    `policyHash: ${evidence.policyHash}`,
    `commandSetHash: ${evidence.commandSetHash}`,
  ];
  for (const receipt of evidence.receipts) {
    lines.push(`- ${receiptLine(receipt)} exitCode=${receipt.exitCode} durationMs=${receipt.durationMs}`);
  }
  for (const reason of evidence.reasons) lines.push(`reason: ${reason}`);
  return lines.join('\n');
}

export function formatDoneRequiredCommand(command: DoneRequiredCommand): string {
  return formatValidationCommand(command);
}
