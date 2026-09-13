import type { ResourceClaim } from './keyed-scheduler.js';
import type {
  DoneRequiredCommandSpecSchema,
  DoneRequiredEvidenceSchema,
} from './artifact-schema.js';

export type ValidationStatus = 'pass' | 'fail' | 'warn';
export type ValidationFailureKind = 'validation_failure' | 'infra_failure';

export interface ValidationCommand {
  /** Explicit cross-consumer reuse; never overrides forbidden/build policies. */
  executionReuse?: 'exact-inputs';
  /** Complete additional generated/external input files; [] explicitly declares none. */
  executionInputs?: string[];
  /**
   * B-a745 CHK-001: OPTIONAL stable planner identity for this command.
   *
   * When absent, `core/validation-command-identity.ts` derives a deterministic
   * provisional id (prefix `prov-`) from the narrow portable tuple
   * {command, args, repo-relative cwd, shell}. A declared id survives a label
   * rename so a planner graph node stays continuous across cosmetic edits.
   *
   * This field is deliberately NOT read by `buildRoutineValidationIdentity`:
   * routine reuse identity keeps its own explicit field list, so declaring an id
   * can never relax an existing reuse refusal. Declaring one in project config
   * still changes `source.inputDigest`, because that digest binds the raw config
   * file contents.
   */
  id?: string;
  label: string;
  command: string;
  args: string[];
  shell?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  optional?: boolean;
  focus?: string[];
  /** Versioned real case registry consumed by DYN-5 adapters. */
  caseRegistryPath?: string;
  /** Source entrypoint executed by the registered DYN-5 case runners. */
  runnerSourcePath?: string;
  /** Content digest of the registered runner source, bound into catalog identity. */
  runnerSourceDigest?: string;
  /**
   * Complete declared selector ownership roots. They control exclusion only;
   * runtime closure and direct triggers also retain runnerSourcePath and
   * caseRegistryPath. An empty declaration falls back to heuristic runtime
   * roots but never becomes complete selector ownership.
   */
  inputRoots?: string[];
  /** Must be true before declared inputRoots can authorize command exclusion. */
  inputsComplete?: boolean;
  /** Environment keys the command is permitted to read during closure tracing. */
  declaredEnvironmentKeys?: string[];
  /** Explicit catalog policy; omitted fields remain non-authoritative defaults. */
  assurance?: 'always' | 'story-selectable' | 'full-only';
  riskTier?: 'local' | 'shared' | 'gate' | 'validation-infra';
  closurePolicy?: 'static-and-traced' | 'whole-repository' | 'never-reuse';
  fullBaselineReusePolicy?: 'not-applicable' | 'exact-current-epoch-only' | 'forbidden';
  cpuWeight?: number;
  expectedP50Ms?: number;
  /**
   * What this command touches, in the SAME vocabulary the full test suite
   * declares (core/keyed-scheduler.ts): git-common-dir / fixed-path /
   * fixed-port / runtime-lock / main-write-lock, shared or exclusive;
   * machine-cpu / machine-process use the fixed exclusive heavy/fanout policy. Keys are
   * resolved relative to the PROJECT ROOT, not to `cwd`.
   *
   * Absent (or empty) means UNDECLARED, which is not the same as "touches
   * nothing": an undeclared command is scheduled exclusively by
   * `resolveValidationCommandResources`, so it can never overlap another
   * command. Declare claims only for a command proven safe to share.
   */
  resources?: ResourceClaim[];
}

export interface ValidationCommandResult {
  /** Diagnostic intra-plan resource-conflict wait; excludes worker slots and cross-process capacity. */
  schedulerWaitMs?: number;
  /** Context-local diagnostics only; never evidence or permission to reuse. */
  executionDecision?: { disposition: 'executed' | 'reused'; reason: string };
  /** Observed by the executor, never inferred from a successful exit code. */
  sourceProvenance?: {
    schemaVersion: string;
    gitCwd: string;
    headBefore: string | null;
    headAfter: string | null;
    cleanBefore: boolean;
    cleanAfter: boolean;
  };
  executionReceipt?: {executionKey:string;receiptHash:string;disposition:'executed'|'reused';executedAt:string};
  label: string;
  command: string;
  args: string[];
  shell?: boolean;
  cwd?: string;
  code: number;
  output: string;
  optional?: boolean;
  timedOut?: boolean;
  /** Remaining child budget; timeoutMs is the invocation budget, capped by any caller deadline before admission. */
  effectiveTimeoutMs?: number;
  timeoutMs?: number;
  failureKind?: ValidationFailureKind;
  durationMs: number;
  /** Real command-boundary observations captured by the executor spawn seam. */
  runtimeTrace?: {
    /** Filesystem paths resolved at call time; not atomic kernel provenance. */
    readPathSchema?: string;
    command: string;
    argv: string[];
    cwd: string;
    environmentKeys: string[];
    startedAt: string;
    endedAt: string;
    exitCode: number;
    /** Observable executor boundary events, in occurrence order. */
    events: string[];
    readPaths?: string[];
    loadedPaths?: string[];
    spawnedPaths?: string[];
    registryKeys?: string[];
    unknownRuntimeInputs: string[];
  };
  worktreePollution?: {
    statusLines: string[];
    paths: string[];
    /**
     * Task B-4b22: when false, the dirty-gate-policy classified every
     * polluted path into a passing category (proof_or_stop_metadata / runtime_artifact
     * / declared_artifact) and audit lines were written. The execute plan
     * still records the pollution for visibility but does NOT flip allPass.
     * Undefined for legacy callers — treated as `true` (blocking) by
     * `executeValidationPlan` (back-compat).
     */
    blocking?: boolean;
    /**
     * B-7dff F-003: `'exclusive'` — NO other command in the plan could have
     * caused these rows, because no other command's before/after observation
     * window contained their appearance. It is the only value this field ever
     * takes: pollution that more than one concurrently scheduled command could
     * have caused is never recorded here, it moves to
     * {@link ValidationResult.concurrentWorktreePollution}. So a per-command
     * record is always a sound accusation, both with the field (a plan run) and
     * without it (a single-command caller, where the command ran alone by
     * construction).
     */
    attribution?: 'exclusive';
  };
}

/**
 * B-7dff F-003: worktree pollution the plan DETECTED but could not attribute to
 * one command.
 *
 * The side-effect probe is a repo-wide `git status` snapshot taken before and
 * after each command, so once commands run concurrently one command's write
 * lands inside every concurrently running command's window and each of them
 * observes it. Rather than pick one of those windows (which blames innocent
 * commands — the B-7dff F-003 defect) or drop the row (which loses the
 * detection), the row is reported here against the SET of commands that could
 * have caused it.
 *
 * This is gate-consumed exactly like a per-command record: `blocking !== false`
 * flips `allPass` and is counted as a required failure by
 * `summarizeRoutineCommandExecution`.
 */
export interface ConcurrentWorktreePollutionAttribution {
  /** The polluted path. */
  path: string;
  /** The first porcelain row observed for it. */
  statusLine: string;
  /** Every command whose observation window contained this path's appearance, in plan order. */
  candidates: string[];
}

export interface ConcurrentWorktreePollution {
  statusLines: string[];
  paths: string[];
  /** Union of every {@link ConcurrentWorktreePollutionAttribution.candidates}, in plan order. */
  candidates: string[];
  /** Per-path candidate sets, so no single command is ever implied to be the cause. */
  attributions: ConcurrentWorktreePollutionAttribution[];
  /** Same semantics as the per-command flag: false = dirty-gate-policy passed every path. */
  blocking?: boolean;
}

export type ValidationProgressEventType =
  | 'command_start'
  | 'heartbeat'
  | 'command_timeout'
  | 'command_end';

export interface ValidationProgressEvent {
  type: ValidationProgressEventType;
  commandIndex: number;
  totalCommands: number;
  label: string;
  command: string;
  args: string[];
  shell?: boolean;
  cwd?: string;
  timeoutMs: number;
  elapsedMs: number;
  timestamp: string;
  code?: number;
  timedOut?: boolean;
}

export type ValidationProgressReporter = (event: ValidationProgressEvent) => void;

export interface ValidationPlan {
  provider: string;
  commands: ValidationCommand[];
  warnings?: string[];
  focus?: string;
}

export interface ValidationResult {
  provider: string;
  status: ValidationStatus;
  allPass: boolean;
  failureKind?: ValidationFailureKind;
  summary: string;
  details: string[];
  warnings: string[];
  timestamp: string;
  headSha?: string;
  commands: ValidationCommandResult[];
  /**
   * B-7dff F-003: pollution detected during the plan that no single command's
   * observation window owns. Absent when every detected row was exclusively
   * attributable (which is every row of a jobs=1 / single-command run).
   */
  concurrentWorktreePollution?: ConcurrentWorktreePollution;
  focus?: {
    name: string;
    mode: 'focused';
    finalFullValidation: false;
    doneRequiredProof: false;
  };
  /** Whether project commands ran or a fresh command PASS was reused. */
  disposition?: 'executed' | 'reused';
  /** Number of project validation commands invoked by this call. */
  commandExecutions?: number;
  /** Stable reasons explaining why reuse was accepted or refused. */
  reuse?: {
    lineage: 'exact-head' | 'trusted-story-metadata-descendant' | 'rejected';
    existingEvidenceBasis: 'fresh' | 'stale' | 'missing';
    refusalReasons: string[];
    identityDigest?: string;
  };
}

export type RoutineValidationSourceKind = 'configured' | 'fallback' | 'validate-file' | 'no-validator';

export interface RoutineValidationIdentityCommand {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
  timeoutMs: number;
  optional: boolean;
  focus: string[];
  /** Digest of process.env plus the command overlay; raw environment values are never stored. */
  effectiveEnvironmentDigest: string;
  /** Content identity of the configured target executable. */
  executableDigest: string | null;
  /** Content identity of the actual command shell when shell=true, else null. */
  shellExecutableDigest?: string | null;
}

export interface RoutineValidationIdentity {
  schema: 'proofOrStop.routine-validation-identity';
  version: 1;
  digest: string;
  source: {
    kind: RoutineValidationSourceKind;
    inputDigest: string;
    entrypointDigest: string | null;
  };
  commands: RoutineValidationIdentityCommand[];
  invocation: {
    full: boolean | string | null;
    focus: string | null;
    profile: string;
  };
  verificationPolicyDigest: string;
  runtime: {
    platform: string;
    arch: string;
    node: string;
  };
}

export interface RoutineValidationCommandExecution {
  schema: 'proofOrStop.routine-validation-command-execution';
  version: 1;
  status: 'PASS' | 'FAIL';
  complete: boolean;
  commandCount: number;
  requiredFailureCount: number;
  optionalFailureCount: number;
  failureKind?: ValidationFailureKind;
}

export type DoneRequiredEvidenceStatus = 'PASS' | 'FAIL';

export interface DoneRequiredCommandSpecEnvelope {
  /** v2 digests a repo-relative logical cwd; v1 (legacy) digested an absolute cwd. */
  schema: DoneRequiredCommandSpecSchema;
  digest: string;
  command: string;
  args: string[];
  /** Repo-root-relative LOGICAL cwd (v2) / absolute cwd (legacy v1). Digested. */
  cwd: string;
  /**
   * Resolved ABSOLUTE physical workspace path where the command ran. Provenance
   * only — deliberately EXCLUDED from the command-spec digest so it never breaks
   * cross-worktree/host verification. Absent on legacy v1 receipts.
   */
  resolvedCwd?: string;
  shell: boolean;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface DoneRequiredCommandReceipt {
  executionReceipt?: ValidationCommandResult['executionReceipt'];
  label: string;
  command: string;
  args: string[];
  commandSpec?: DoneRequiredCommandSpecEnvelope;
  shell?: boolean;
  cwd: string;
  status: DoneRequiredEvidenceStatus;
  exitCode: number;
  durationMs: number;
  outputDigest: string;
  outputTail: string;
  startedAt: string;
  endedAt: string;
  timedOut?: boolean;
  /** Executor-owned effective environment identity; raw environment values are never stored. */
  effectiveEnvironmentDigest?: string;
  /** Executor-owned resolved executable content identity. */
  executableDigest?: string | null;
  /** Executor-owned actual shell executable identity; required when shell=true. */
  shellExecutableDigest?: string | null;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
}

export interface DoneRequiredEvidenceData {
  schema: DoneRequiredEvidenceSchema;
  version: 1;
  storyId: string;
  status: DoneRequiredEvidenceStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  policyHash: string;
  commandSetHash: string;
  receipts: DoneRequiredCommandReceipt[];
  reasons: string[];
  configErrors?: string[];
}
