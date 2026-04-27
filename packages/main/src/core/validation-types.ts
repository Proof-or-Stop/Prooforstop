export type ValidationStatus = 'pass' | 'fail' | 'warn';

export interface ValidationCommand {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  optional?: boolean;
}

export interface ValidationCommandResult {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  code: number;
  output: string;
  optional?: boolean;
  timedOut?: boolean;
  durationMs: number;
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
