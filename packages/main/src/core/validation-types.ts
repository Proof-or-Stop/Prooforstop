export type ValidationStatus = 'pass' | 'fail' | 'warn';

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
