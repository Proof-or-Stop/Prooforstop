export type ValidationStatus = 'pass' | 'fail' | 'warn';
export type ValidationFailureKind = 'validation_failure' | 'infra_failure';

export interface ValidationCommand {
  label: string;
  command: string;
  args: string[];
  shell?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  optional?: boolean;
  focus?: string[];
}

export interface ValidationCommandResult {
  label: string;
  command: string;
  args: string[];
  shell?: boolean;
  cwd?: string;
  code: number;
  output: string;
  optional?: boolean;
  timedOut?: boolean;
  timeoutMs?: number;
  failureKind?: ValidationFailureKind;
  durationMs: number;
  worktreePollution?: {
    statusLines: string[];
    paths: string[];
    /**
     * Task B-4b22: when false, the dirty-gate-policy classified every
     * polluted path into a passing category (lattice_metadata / runtime_artifact
     * / declared_artifact) and audit lines were written. The execute plan
     * still records the pollution for visibility but does NOT flip allPass.
     * Undefined for legacy callers — treated as `true` (blocking) by
     * `executeValidationPlan` (back-compat).
     */
    blocking?: boolean;
  };
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
  executableDigest: string | null;
}

export interface RoutineValidationIdentity {
  schema: 'lattice.routine-validation-identity';
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
  schema: 'lattice.routine-validation-command-execution';
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
  schema: 'lattice.command-spec.v1';
  digest: string;
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface DoneRequiredCommandReceipt {
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
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
}

export interface DoneRequiredEvidenceData {
  schema: 'lattice.done-required-evidence';
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
