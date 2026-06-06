// ============================================================
// verifier/types — koala built-in verifier type definitions
// ============================================================

import type { CliStep } from './cli-executor.js';
import type { BrowserStep } from './browser-executor.js';
import type { Finding } from '../core/types.js';

/** Input schema field definition (used for Dashboard auto-generated forms, optional) */
export interface InputFieldSchema {
  type: 'number' | 'string' | 'boolean' | 'select';
  label?: string;
  min?: number;
  max?: number;
  default?: any;
  options?: Array<{ value: any; label: string }>;
}

/** Circuit cross-endpoint reference: declares cross-machine event routing */
export interface CircuitRef {
  /** Link name; transitions of circuits with the same name are automatically chained */
  name: string;
  /** Cross-endpoint jump target, format "endpoint:EVENT"; array indicates fan-out */
  next?: string | string[];
  /** Timeout in milliseconds */
  timeout?: number;
  /** Event triggered after timeout */
  onTimeout?: string;
  /** Field name in input used to correlate different instances (exact match by this field in cross-device scenarios) */
  key?: string;
}

/** State transition */
export interface Transition {
  from: string;
  to: string;
  event: string;
  guard: { name: string; fn: (...args: any[]) => boolean };
  action: { name: string; fn: (...args: any[]) => any };
  planned?: boolean;
  /** What this transition does (description for humans and AI, required) */
  description: string;
  /** Input structure description (optional, used by Dashboard to generate forms, does not affect API) */
  inputSchema?: Record<string, InputFieldSchema>;
  /** Circuit cross-endpoint routing declaration (optional, used for koala serve --circuit multi-machine joint debugging) */
  circuit?: CircuitRef;
}

/** Performance constraints */
export interface Constraint {
  name: string;
  time: number;
}

/** Machine configuration */
export interface MachineConfig {
  /** Machine name */
  name: string;
  /** What this Machine does (project-level description) */
  description: string;
  initial: string;
  states: string[];
  terminalStates: string[];
  transitions: Transition[];
  constraints: Constraint[];
  /** Which test shells this machine supports */
  shells?: ('cli' | 'browser' | 'core')[];
}

/** Single check result */
export interface CheckResult {
  name: string;
  pass: boolean;
  details: string;
}

/** Logic chain test: pure functions walking through the Machine path (white-box, runs in memory) */
export interface LogicTest {
  name: string;
  initialState: any;
  /** Initial machine state (defaults to machine.initial) */
  initialMachineState?: string;
  expectedPath: string[];
  steps: Array<{ event: string; input: any }>;
  resolveArgs: (state: any, input: any) => { guardArgs: any[]; actionArgs: any[] };
  extractState: (actionResult: any) => any;
  /** Associated Finding ID (e.g. B-xxx:F-001) */
  findingRef?: string;
  /** Associated verificationIntent refs (e.g., CHK-001:happy:0) */
  intentRefs?: string[];
}

/** Core test step: drive directly via bridge within the current process */
export interface CoreStep {
  sendEvent: string;
  input: any;
  /** Expected sendEvent return value (true=handled, false=no matching transition) */
  expectResult?: boolean;
  /** Expected machine state (e.g., 'waiting_white') */
  expectMachine?: string;
  /** Expected partial match of game state */
  expectState?: Record<string, any>;
}

/** Real machine integration test: spawn real process, send real input, verify real output (black box) */
export interface IntegrationTest {
  type: 'cli' | 'browser' | 'core';
  name: string;
  /** Which transitions this test covers (format: 'from→to') */
  covers: string[];
  /** Timeout in ms (default 30000) */
  timeout?: number;

  // ---- CLI-specific fields ----
  /** CLI steps: sequential stdin/stdout interactions */
  steps?: CliStep[];
  /** CLI launch command (e.g. "npx tsx main.ts") */
  command?: string;
  /** Extra environment variables for CLI */
  env?: Record<string, string>;
  /** Working directory for CLI (defaults to process.cwd()) */
  cwd?: string;

  // ---- Core-specific fields ----
  /** Core test steps: in-process bridge interactions */
  coreSteps?: CoreStep[];

  // ---- Browser-specific fields ----
  /** Browser steps: click/eval/assert/screenshot/wait/type */
  browserSteps?: BrowserStep[];
  /** Dev server command (e.g. "npm run dev") */
  devCommand?: string;
  /** Project root for browser tests */
  projectRoot?: string;
  /** Pattern to detect dev server ready */
  serverReadyPattern?: string;
  /** Associated Finding ID (e.g., B-xxx:F-001) */
  findingRef?: string;
  /** Associated verificationIntent refs (e.g., CHK-001:happy:0) */
  intentRefs?: string[];
}

/** validate options */
export interface ValidateOptions {
  fnExports: Record<string, unknown>;
  extraExports?: Record<string, unknown>;
  machineSource?: string;
  /** Logic chain test (white box) */
  logicTests?: LogicTest[];
  /** Real machine integration test (black box) */
  integrationTests?: IntegrationTest[];
  /** Only run integration tests whose covers include the specified transition */
  integrationFilter?: string[];
  /** Number of constraint measurements (default 10, set to 0 to skip) */
  constraintRuns?: number;
  /** Shell source text (key=filename, value=source), used for Bridge I/O isolation check */
  shellSources?: Record<string, string>;
  /** Finding list (items discovered by koala-reviewer), used for coverage check */
  findings?: Finding[];
  /** Bridge factory function for core test (provided by project validate.ts) */
  bridgeFactory?: () => { sendEvent(event: string, input: any): boolean; getState(): any; getMachineState(): string; reset(): void };
}

/** validate return result */
export interface ValidateResult {
  results: CheckResult[];
  allPass: boolean;
}

/** koala validate --json structured output (consumed by gate) */
export interface ExternalVerifierResult {
  provider: 'koala-verifier';
  status: 'pass' | 'fail' | 'warn';
  allPass: boolean;
  summary: string;
  details: string[];
  warnings: string[];
  artifacts?: Array<{
    type: 'json' | 'text' | 'screenshot' | 'log';
    label: string;
    path?: string;
  }>;
  timestamp: string;
  headSha?: string;
}
