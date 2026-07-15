import { loadConfig } from './config.js';
import { resolveDoneRequiredPolicy } from './done-required-validation.js';
import { resolveCommandTimeoutMs } from './validation-executor.js';
import type { ValidationCommand } from './validation-types.js';

export const NODE_TIMER_MAX_MS = 2_147_483_647;
export const DEFAULT_DONE_PREPARE_PHASE_TIMEOUT_MS = 240_000;
export const DEFAULT_TIMEOUT_BUDGET_GRACE_MS = 30_000;

export type TimeoutBudgetSource = 'phase-env' | 'global-phase-env' | 'derived-command-budget' | 'default';
export type CommandTimeoutLayer = 'command' | 'phase' | 'idle' | 'max';

export class CliWatchdogTimeoutError extends Error {
  readonly timeoutLayer: 'idle' | 'max';
  readonly timeoutMs: number;

  constructor(timeoutLayer: 'idle' | 'max', timeoutMs: number) {
    super(`CLI ${timeoutLayer} timeout exceeded ${timeoutMs}ms`);
    this.name = 'CliWatchdogTimeoutError';
    this.timeoutLayer = timeoutLayer;
    this.timeoutMs = timeoutMs;
  }
}

export function timeoutLayerFromReason(reason: unknown): CommandTimeoutLayer | null {
  if (reason && typeof reason === 'object') {
    const layer = (reason as { timeoutLayer?: unknown }).timeoutLayer;
    if (layer === 'command' || layer === 'phase' || layer === 'idle' || layer === 'max') return layer;
  }
  return null;
}

export interface TimeoutBudget {
  timeoutMs: number;
  source: TimeoutBudgetSource;
  commandBudgetMs?: number;
  graceMs?: number;
}

const DEFAULT_LIVE_SMOKE_CAPTURE_TIMEOUT_MS = 60_000;

export type LiveSmokeCaptureBudgetSource =
  | 'fixed-arbitrary-command'
  | 'derived-done-required-command'
  | 'derived-done-prepare-command'
  | 'bounded-env-override';

export interface LiveSmokeCaptureBudget {
  timeoutMs: number;
  source: LiveSmokeCaptureBudgetSource;
  recognizedCommand: 'done_required_validate' | 'done_prepare' | null;
}

function positiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(NODE_TIMER_MAX_MS, Math.floor(parsed)) : undefined;
}

export function safeTimeoutSum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    const normalized = positiveInt(value) ?? 0;
    total = Math.min(NODE_TIMER_MAX_MS, total + normalized);
  }
  return total;
}

export function sequentialValidationBudget(commands: ValidationCommand[], graceMs = DEFAULT_TIMEOUT_BUDGET_GRACE_MS): number {
  return safeTimeoutSum([...commands.map((command) => resolveCommandTimeoutMs(command)), graceMs]);
}

function configuredRoutineCommands(root: string): ValidationCommand[] {
  const config = loadConfig(root) as ReturnType<typeof loadConfig> & { validation?: unknown };
  const validate = config.validate ?? config.validation;
  if (!validate || typeof validate !== 'object') return [];
  const raw = validate as { command?: unknown; commands?: unknown[] };
  const entries = typeof raw.command === 'string' ? [raw.command, ...(raw.commands ?? [])] : (raw.commands ?? []);
  return entries.flatMap((entry, index): ValidationCommand[] => {
    if (typeof entry === 'string') return [{ label: `configured validate command ${index + 1}`, command: entry, args: [], shell: true }];
    if (!entry || typeof entry !== 'object' || typeof (entry as any).command !== 'string') return [];
    const item = entry as any;
    return [{
      label: typeof item.label === 'string' ? item.label : `configured validate command ${index + 1}`,
      command: item.command,
      args: Array.isArray(item.args) ? item.args.map(String) : [],
      ...(item.shell === true ? { shell: true } : {}),
      ...(typeof item.timeoutMs === 'number' ? { timeoutMs: item.timeoutMs } : {}),
    }];
  });
}

export function doneRequiredDerivedBudget(root: string): TimeoutBudget {
  const commands = resolveDoneRequiredPolicy(root).commands;
  const commandBudgetMs = safeTimeoutSum(commands.map((command) => resolveCommandTimeoutMs(command)));
  return {
    timeoutMs: safeTimeoutSum([commandBudgetMs, DEFAULT_TIMEOUT_BUDGET_GRACE_MS]),
    source: 'derived-command-budget',
    commandBudgetMs,
    graceMs: DEFAULT_TIMEOUT_BUDGET_GRACE_MS,
  };
}

export function donePreparePhaseBudget(root: string, phaseEnv: string, derived?: TimeoutBudget): TimeoutBudget {
  const phaseOverride = positiveInt(process.env[phaseEnv]);
  if (phaseOverride) return { timeoutMs: phaseOverride, source: 'phase-env' };
  const globalOverride = positiveInt(process.env.LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS);
  if (globalOverride) return { timeoutMs: globalOverride, source: 'global-phase-env' };
  return derived ?? { timeoutMs: DEFAULT_DONE_PREPARE_PHASE_TIMEOUT_MS, source: 'default' };
}

function recognizedLiveSmokeCommand(command: string): 'done_required_validate' | 'done_prepare' | null {
  const trimmed = command.trim();
  // A wider budget is reserved for one direct Lattice closeout command. Shell
  // composition/substitution stays on the fixed arbitrary-command ceiling.
  if (!trimmed || /[;&|<>\n\r`]|\$\(/.test(trimmed)) return null;
  const match = trimmed.match(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*lattice\s+(done_required_validate|done_prepare)(?:\s|$)/,
  );
  return match?.[1] === 'done_required_validate' || match?.[1] === 'done_prepare' ? match[1] : null;
}

/**
 * Select the live-smoke capture ceiling without granting arbitrary shell
 * commands a longer window. A positive explicit override may only LOWER the
 * legal ceiling selected for the command, and is clamped to Node's timer max.
 */
export function liveSmokeCaptureBudget(
  root: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): LiveSmokeCaptureBudget {
  const recognizedCommand = recognizedLiveSmokeCommand(command);
  let legalTimeoutMs = DEFAULT_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
  let source: LiveSmokeCaptureBudgetSource = 'fixed-arbitrary-command';
  if (recognizedCommand === 'done_required_validate') {
    legalTimeoutMs = commandCliMaxBudget(root, recognizedCommand, {}).timeoutMs;
    source = 'derived-done-required-command';
  } else if (recognizedCommand === 'done_prepare') {
    const validate = !/(?:^|\s)--validate(?:=|\s+)false(?:\s|$)/.test(command);
    legalTimeoutMs = commandCliMaxBudget(root, recognizedCommand, { validate }).timeoutMs;
    source = 'derived-done-prepare-command';
  }

  const override = positiveInt(env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS);
  if (override !== undefined && override < legalTimeoutMs) {
    return { timeoutMs: override, source: 'bounded-env-override', recognizedCommand };
  }
  return { timeoutMs: legalTimeoutMs, source, recognizedCommand };
}

const CLOSEOUT_PHASE_ENVS = [
  'LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS',
  'LATTICE_DONE_PREPARE_DONE_CLOSURE_TIMEOUT_MS',
  'LATTICE_DONE_PREPARE_REVIEW_ASSURANCE_TIMEOUT_MS',
  'LATTICE_DONE_PREPARE_RUNTIME_CHANGE_TIMEOUT_MS',
  'LATTICE_DONE_PREPARE_CLEAN_TREE_TIMEOUT_MS',
  'LATTICE_DONE_PREPARE_PRODUCE_COMMAND_TIMEOUT_MS',
] as const;

export function commandCliMaxBudget(root: string, command: string, args: Record<string, unknown>): TimeoutBudget {
  if (command === 'live_smoke_transcript' && typeof args.capture === 'string') {
    const capture = liveSmokeCaptureBudget(root, args.capture);
    return {
      timeoutMs: safeTimeoutSum([capture.timeoutMs, DEFAULT_TIMEOUT_BUDGET_GRACE_MS]),
      source: capture.recognizedCommand ? 'derived-command-budget' : 'default',
      commandBudgetMs: capture.timeoutMs,
      graceMs: DEFAULT_TIMEOUT_BUDGET_GRACE_MS,
    };
  }
  const derived = doneRequiredDerivedBudget(root);
  if (command === 'done_required_validate') return derived;
  if (command !== 'done_prepare') return { timeoutMs: 15 * 60_000, source: 'default' };

  const validateEnabled = args.validate !== false;
  const routine = validateEnabled ? sequentialValidationBudget(configuredRoutineCommands(root)) : 0;
  const doneRequiredEnabled = validateEnabled && resolveDoneRequiredPolicy(root).required;
  const enabledPhaseEnvs = doneRequiredEnabled ? CLOSEOUT_PHASE_ENVS : CLOSEOUT_PHASE_ENVS.slice(1);
  const phases = enabledPhaseEnvs.map((env) => donePreparePhaseBudget(
    root,
    env,
    env === 'LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS' ? derived : undefined,
  ).timeoutMs);
  return {
    timeoutMs: safeTimeoutSum([routine, ...phases]),
    source: 'derived-command-budget',
    commandBudgetMs: routine,
    graceMs: DEFAULT_TIMEOUT_BUDGET_GRACE_MS,
  };
}
