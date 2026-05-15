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
     * polluted path into a passing category (koala_metadata / runtime_artifact
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
}
