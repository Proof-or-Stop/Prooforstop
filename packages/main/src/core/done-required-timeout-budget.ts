import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { resolveDoneRequiredPolicy } from './done-required-validation.js';
import { resolveCommandTimeoutMs } from './validation-executor.js';
import type { ValidationCommand } from './validation-types.js';
import { PRE_REVIEW_LIVE_PROOF_COMMAND, PRE_REVIEW_LIVE_PROOF_TIMEOUT_MS } from './pre-review-check.js';
import { readBrandEnv } from './brand-env.js';

export const NODE_TIMER_MAX_MS = 2_147_483_647;
export const DEFAULT_DONE_PREPARE_PHASE_TIMEOUT_MS = 240_000;
export const DEFAULT_TIMEOUT_BUDGET_GRACE_MS = 30_000;

export type TimeoutBudgetSource = 'phase-env' | 'global-phase-env' | 'derived-command-budget' | 'explicit-max-env' | 'default';
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
export const LIVE_SMOKE_CAPTURE_CLEANUP_GRACE_MS = 3_000;

export type LiveSmokeCaptureBudgetSource =
  | 'fixed-arbitrary-command'
  | 'derived-done-required-command'
  | 'derived-done-prepare-command'
  | 'derived-pre-review-live-proof-command'
  | 'derived-closeout-saturation-adjusted'
  | 'inherited-cli-max'
  | 'inherited-cli-max-saturation-adjusted'
  | 'bounded-env-override';

export interface LiveSmokeCaptureBudget {
  timeoutMs: number;
  source: LiveSmokeCaptureBudgetSource;
  recognizedCommand: 'done_required_validate' | 'done_prepare' | 'pre_review_live_proof' | null;
  nestedMaxTimeoutMs?: number;
  requestedNestedMaxTimeoutMs?: number;
  saturationAdjusted?: true;
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
  // Routed through readBrandEnv (not a raw process.env[phaseEnv] lookup) so a phase
  // override still applies when the operator exported the deprecated PROOF_OR_STOP_* spelling.
  const phaseOverride = positiveInt(readBrandEnv(phaseEnv));
  if (phaseOverride) return { timeoutMs: phaseOverride, source: 'phase-env' };
  const globalOverride = positiveInt(readBrandEnv('DONE_PREPARE_PHASE_TIMEOUT_MS'));
  if (globalOverride) return { timeoutMs: globalOverride, source: 'global-phase-env' };
  return derived ?? { timeoutMs: DEFAULT_DONE_PREPARE_PHASE_TIMEOUT_MS, source: 'default' };
}

function safeRealpath(path: string): string | null {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return realpathSync(path);
  } catch {
    return null;
  }
}

function executableOnInheritedPath(name: string, root: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = process.platform === 'win32' ? env.Path ?? env.PATH ?? '' : env.PATH ?? '';
  const names = process.platform === 'win32' ? [name, `${name}.cmd`, `${name}.exe`] : [name];
  for (const rawDir of pathValue.split(delimiter)) {
    const dir = isAbsolute(rawDir || '.') ? (rawDir || '.') : resolve(root, rawDir || '.');
    for (const candidateName of names) {
      const candidate = join(dir, candidateName);
      if (existsSync(candidate)) return safeRealpath(candidate);
    }
  }
  return null;
}

function trustedProofOrStopExecutable(
  root: string,
  executable: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const resolvedExecutable = executable === 'proof-or-stop'
    ? executableOnInheritedPath(executable, root, env)
    : safeRealpath(isAbsolute(executable) ? executable : resolve(root, executable));
  if (!resolvedExecutable) return false;

  const activeEntrypoint = process.argv[1]
    ? safeRealpath(isAbsolute(process.argv[1]) ? process.argv[1] : resolve(root, process.argv[1]))
    : null;
  // No project-path self-authorization: a project executable is trusted only
  // when it is the CLI that is actually running this handler.
  return activeEntrypoint !== null && resolvedExecutable === activeEntrypoint;
}

function recognizedLiveSmokeCommand(
  root: string,
  command: string,
  env: NodeJS.ProcessEnv,
): 'done_required_validate' | 'done_prepare' | 'pre_review_live_proof' | null {
  if (command === PRE_REVIEW_LIVE_PROOF_COMMAND) return 'pre_review_live_proof';
  const trimmed = command.trim();
  // A wider budget is reserved for one direct ProofOrStop closeout command. Shell
  // composition/substitution and executable-affecting inline environment stay
  // on the fixed arbitrary-command ceiling. PROOF_OR_STOP_SESSION_ID is the sole
  // inert inline assignment needed by the owner-lease workflow.
  if (!trimmed || /[;&|<>\n\r`]|\$\(/.test(trimmed)) return null;
  const match = trimmed.match(
    // B-cdf6:F-062 — accept EITHER session-id env prefix. This recognizer previously
    // matched only the deprecated `PROOF_OR_STOP_SESSION_ID=` spelling, so a caller using the
    // canonical `PROOF_OR_STOP_SESSION_ID=` silently lost the wider live-smoke timeout
    // budget with no error. Read-both applies to parsing too, not just to env lookup.
    /^(?:(?:PROOF_OR_STOP|PROOF_OR_STOP)_SESSION_ID=[A-Za-z0-9_.:-]+\s+)?([^\s]+)\s+(done_required_validate|done_prepare)(?:\s|$)/,
  );
  if (!match || !trustedProofOrStopExecutable(root, match[1], env)) return null;
  return match[2] === 'done_required_validate' || match[2] === 'done_prepare' ? match[2] : null;
}

/**
 * Select the live-smoke capture ceiling without granting arbitrary shell
 * commands a longer window. The inherited CLI max remains the nested closeout
 * business bound; the capture adds only bounded termination/reap grace. The
 * live-smoke-specific override may only lower the resulting legal ceiling.
 */
export function liveSmokeCaptureBudget(
  root: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): LiveSmokeCaptureBudget {
  const recognizedCommand = recognizedLiveSmokeCommand(root, command, env);
  let legalTimeoutMs = DEFAULT_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
  let source: LiveSmokeCaptureBudgetSource = 'fixed-arbitrary-command';
  let requestedNestedMaxTimeoutMs: number | undefined;
  if (recognizedCommand === 'done_required_validate') {
    requestedNestedMaxTimeoutMs = commandCliMaxBudget(root, recognizedCommand, {}, env).timeoutMs;
    source = 'derived-done-required-command';
  } else if (recognizedCommand === 'done_prepare') {
    const validate = !/(?:^|\s)--validate(?:=|\s+)false(?:\s|$)/.test(command);
    requestedNestedMaxTimeoutMs = commandCliMaxBudget(root, recognizedCommand, { validate }, env).timeoutMs;
    source = 'derived-done-prepare-command';
  } else if (recognizedCommand === 'pre_review_live_proof') {
    requestedNestedMaxTimeoutMs = PRE_REVIEW_LIVE_PROOF_TIMEOUT_MS;
    source = 'derived-pre-review-live-proof-command';
  }

  // Every trusted nested closeout uses its inherited or derived CLI budget as
  // the business deadline. The capture wrapper adds only enough grace to
  // terminate/reap it; commandCliMaxBudget adds the separate outer-wrapper
  // grace. For an arbitrary/untrusted command an inherited max may only LOWER
  // the fixed capture safety ceiling.
  const inheritedMax = positiveInt(readBrandEnv('MAX_TIMEOUT_MS', env));
  let nestedMaxTimeoutMs: number | undefined;
  let saturationAdjusted = false;
  if (recognizedCommand) {
    if (inheritedMax !== undefined) requestedNestedMaxTimeoutMs = inheritedMax;
    const maxNestedWithLayeredGrace = Math.max(
      1,
      NODE_TIMER_MAX_MS - LIVE_SMOKE_CAPTURE_CLEANUP_GRACE_MS - DEFAULT_TIMEOUT_BUDGET_GRACE_MS,
    );
    nestedMaxTimeoutMs = Math.min(requestedNestedMaxTimeoutMs!, maxNestedWithLayeredGrace);
    saturationAdjusted = nestedMaxTimeoutMs !== requestedNestedMaxTimeoutMs;
    legalTimeoutMs = safeTimeoutSum([nestedMaxTimeoutMs, LIVE_SMOKE_CAPTURE_CLEANUP_GRACE_MS]);
    if (inheritedMax !== undefined) {
      source = saturationAdjusted ? 'inherited-cli-max-saturation-adjusted' : 'inherited-cli-max';
    } else if (saturationAdjusted) {
      source = 'derived-closeout-saturation-adjusted';
    }
  } else if (inheritedMax !== undefined) {
    legalTimeoutMs = Math.min(legalTimeoutMs, inheritedMax);
  }

  const override = positiveInt(readBrandEnv('LIVE_SMOKE_CAPTURE_TIMEOUT_MS', env));
  if (override !== undefined && override < legalTimeoutMs) {
    return {
      timeoutMs: override,
      source: 'bounded-env-override',
      recognizedCommand,
      ...(nestedMaxTimeoutMs !== undefined ? { nestedMaxTimeoutMs } : {}),
      ...(requestedNestedMaxTimeoutMs !== undefined ? { requestedNestedMaxTimeoutMs } : {}),
      ...(saturationAdjusted ? { saturationAdjusted: true } : {}),
    };
  }
  return {
    timeoutMs: legalTimeoutMs,
    source,
    recognizedCommand,
    ...(nestedMaxTimeoutMs !== undefined ? { nestedMaxTimeoutMs } : {}),
    ...(requestedNestedMaxTimeoutMs !== undefined ? { requestedNestedMaxTimeoutMs } : {}),
    ...(saturationAdjusted ? { saturationAdjusted: true } : {}),
  };
}

// Canonical spellings. Every consumer resolves these via readBrandEnv, which also
// accepts the deprecated PROOF_OR_STOP_* spelling of the same suffix.
const CLOSEOUT_PHASE_ENVS = [
  'PROOF_OR_STOP_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS',
  'PROOF_OR_STOP_DONE_PREPARE_DONE_CLOSURE_TIMEOUT_MS',
  'PROOF_OR_STOP_DONE_PREPARE_REVIEW_ASSURANCE_TIMEOUT_MS',
  'PROOF_OR_STOP_DONE_PREPARE_RUNTIME_CHANGE_TIMEOUT_MS',
  'PROOF_OR_STOP_DONE_PREPARE_CLEAN_TREE_TIMEOUT_MS',
  'PROOF_OR_STOP_DONE_PREPARE_PRODUCE_COMMAND_TIMEOUT_MS',
] as const;

export function commandCliMaxBudget(
  root: string,
  command: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): TimeoutBudget {
  if (command === 'live_smoke_transcript' && typeof args.capture === 'string') {
    const capture = liveSmokeCaptureBudget(root, args.capture, env);
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
    env === 'PROOF_OR_STOP_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS' ? derived : undefined,
  ).timeoutMs);
  return {
    timeoutMs: safeTimeoutSum([routine, ...phases]),
    source: 'derived-command-budget',
    commandBudgetMs: routine,
    graceMs: DEFAULT_TIMEOUT_BUDGET_GRACE_MS,
  };
}

/** Select the outer CLI watchdog budget while preserving explicit-max behavior
 * for every command except a trusted closeout capture wrapper. That wrapper
 * needs to outlive the nested business bound plus capture cleanup/reap grace. */
export function effectiveCommandCliMaxBudget(
  root: string,
  command: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): TimeoutBudget {
  const derived = commandCliMaxBudget(root, command, args, env);
  if (command === 'live_smoke_transcript' && derived.source === 'derived-command-budget') return derived;
  const explicit = positiveInt(readBrandEnv('MAX_TIMEOUT_MS', env));
  return explicit === undefined ? derived : { timeoutMs: explicit, source: 'explicit-max-env' };
}
