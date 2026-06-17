// ============================================================
// verifier — lattice built-in code verification module
// ============================================================

export type {
  Transition, Constraint, MachineConfig, CheckResult,
  ValidateOptions, ValidateResult, LogicTest, IntegrationTest,
  ExternalVerifierResult,
} from './types.js';

// Re-export Finding from core for convenience
export type { Finding, FindingData } from '../core/types.js';

export { validateMachine, printReport, statusReport, toExternalResult, dependencyReport } from './validate.js';

export type { CliStep, CliCaseResult, CliTestResult, CliTestConfig } from './cli-executor.js';
export { executeCliCases } from './cli-executor.js';

export type { BrowserStep, BrowserCaseResult, BrowserTestResult, BrowserTestConfig } from './browser-executor.js';
export { executeBrowserCases, cleanupBrowserEnv, stablePort } from './browser-executor.js';
