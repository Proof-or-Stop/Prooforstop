import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { StoryStore } from './store.js';
import {
  buildAutopilotRun,
  type AutopilotArgs,
  type AutopilotReceiptProjection,
  type AutopilotRunResult,
  type AutopilotStatus,
  type AutopilotStep,
} from './autopilot.js';
import {
  isUsageLedgerEnabled,
  parseClaudeCliOutput,
  recordBudgetBlock,
  recordConcurrencyBlock,
  recordDispatchFinal,
  recordDispatchPreflight,
  type DispatchPreflightHandle,
  type DispatchUsageContext,
  type DispatchUsageOptions,
} from './usage-ledger/dispatch-usage.js';
// F-016: lateral core->core import of the host-run admission primitives. Safe
// (no cycle): host-run.ts imports only host-execution-readiness.js and
// usage-ledger/dispatch-usage.js — neither reaches back into this module.
import {
  acquireHostRunSlot,
  hostRunSlotsDir,
  releaseSlot,
  resolveMaxConcurrent,
  resolveSlotStaleMs,
  HOST_RUN_REFUSAL_EXIT_CODE,
  type AcquiredHostRunSlot,
} from './host-run.js';

export type AutopilotExecuteStepStatus = 'passed' | 'failed' | 'skipped';

export interface AutopilotCommandRequest {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMS: number;
}

export interface AutopilotCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AutopilotCommandRunner = (request: AutopilotCommandRequest) => AutopilotCommandResult;

export interface AutopilotRepairAttempt {
  stepId: string;
  command: string;
  status: AutopilotExecuteStepStatus;
  exitCode: number;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export interface AutopilotExecutedStep extends AutopilotStep {
  status: AutopilotExecuteStepStatus;
  exitCode: number | null;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  startedAt: string;
  endedAt: string;
  repairAttempts: AutopilotRepairAttempt[];
  reason?: string;
}

export interface AutopilotExecuteArgs extends AutopilotArgs {
  dryRun?: boolean;
  allowClaudeRepair?: boolean;
  claudeCommand?: string;
  claudePermissionMode?: string;
  maxRepairAttempts?: number;
  commandTimeoutMS?: number;
  claudeTimeoutMS?: number;
  maxReviewWaves?: number;
  requireMultiHost?: boolean;
  requiredHostVerdictCount?: number;
}

export interface AutopilotExecuteResult {
  schemaVersion: 'lattice.autopilot_execute.v1';
  mode: AutopilotRunResult['mode'];
  status: AutopilotStatus;
  dryRun: boolean;
  once: boolean;
  maxSteps: number;
  maxReviewWaves: number;
  targetPhase: AutopilotRunResult['targetPhase'];
  story: AutopilotRunResult['story'];
  localWorkflowUsable: true;
  localReviewCertified: boolean;
  authorityDone: boolean;
  fullAuthorityDone: boolean;
  multiHostVerified: boolean;
  multiHostRequired: boolean;
  requiredHostVerdictCount: number;
  authorityRequired: boolean;
  receiptRequired: boolean;
  receipt: AutopilotRunResult['receipt'];
  authority: AutopilotRunResult['authority'];
  plannedSteps: AutopilotStep[];
  executedSteps: AutopilotExecutedStep[];
  claimedJobExecution: null;
  completion: null;
  /** Machine-readable reasons the job did NOT fully complete (empty when completed or n/a). */
  blockingReasons: string[];
  /** Local/offline receipt-bundle refs are not produced by this executor. */
  receiptRefs: [];
  /** Independent multi-host verdict refs surfaced by the completion verdict. */
  hostVerdictRefs: string[];
  /** The single recommended next action (completion verdict, or first nextActions entry). */
  nextAction: string;
  repair: {
    enabled: boolean;
    command: string;
    permissionMode: string | null;
    maxAttemptsPerStep: number;
    attempts: AutopilotRepairAttempt[];
  };
  stopReason: string;
  nextActions: string[];
  note: string;
  authorityJobLoop?: null;
}

export interface ExecuteAutopilotOptions {
  store: StoryStore;
  root: string;
  args?: AutopilotExecuteArgs;
  env?: Record<string, string | undefined>;
  runner?: AutopilotCommandRunner;
  now?: () => Date;
}

const DEFAULT_MAX_EXECUTE_STEPS = 20;
// Hard ceilings so the executor loop can never be driven unbounded by caller input.
const MAX_EXECUTE_STEPS_HARD_CAP = 100;
const DEFAULT_MAX_REVIEW_WAVES = 3;
const MAX_REVIEW_WAVES_HARD_CAP = 10;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_CLAUDE_TIMEOUT_MS = 300_000;
const OUTPUT_EXCERPT_LIMIT = 2_000;

function defaultRunner(request: AutopilotCommandRequest): AutopilotCommandResult {
  try {
    const stdout = execFileSync(request.executable, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: request.timeoutMS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error: any) {
    return {
      exitCode: typeof error?.status === 'number' ? error.status : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : (error?.message || String(error)),
    };
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

// Clamp a caller-supplied loop bound to a finite hard cap so retry/review loops
// can never run forever, regardless of CLI/job input.
function boundedInteger(value: unknown, fallback: number, cap: number): number {
  return Math.min(positiveInteger(value, fallback), cap);
}

function excerpt(value: string): string {
  if (value.length <= OUTPUT_EXCERPT_LIMIT) return value;
  return `${value.slice(0, OUTPUT_EXCERPT_LIMIT)}\n...[truncated]`;
}

function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
}

function commandForStep(root: string, step: AutopilotStep, plan: AutopilotRunResult): AutopilotCommandRequest | null {
  const storyId = plan.story.storyId ?? undefined;
  const latticeArgs = (args: string[]): AutopilotCommandRequest => ({
    executable: process.execPath,
    args: [cliPath(), '--root', root, ...args],
    cwd: root,
    timeoutMS: DEFAULT_COMMAND_TIMEOUT_MS,
  });

  switch (step.id) {
    case 'session-brief':
      return latticeArgs(['session_brief']);
    case 'docs':
      return latticeArgs(['aux_doc_list']);
    case 'story':
      return storyId ? latticeArgs(['story_get', `--storyId=${storyId}`]) : latticeArgs(['story_list']);
    case 'validate':
      return storyId ? latticeArgs(['validate', `--story=${storyId}`]) : latticeArgs(['validate']);
    case 'asset-check':
      return latticeArgs(['check']);
    case 'codex-adapter':
      return storyId ? latticeArgs(['codex', 'verify', `--storyId=${storyId}`]) : latticeArgs(['codex', 'verify']);
    case 'advance-target':
      return storyId ? latticeArgs(['story_advance', `--storyId=${storyId}`, `--phase=${plan.targetPhase}`]) : null;
    default:
      return null;
  }
}

function displayCommand(request: AutopilotCommandRequest): string {
  if (request.executable === process.execPath && request.args[0]?.endsWith('/cli.js')) {
    return `lattice ${request.args.slice(3).join(' ')}`;
  }
  return [request.executable, ...request.args].join(' ');
}

function claudeRepairPrompt(step: AutopilotStep, request: AutopilotCommandRequest, result: AutopilotCommandResult, plan: AutopilotRunResult): string {
  return [
    'You are Claude Code CLI running as an explicit Proofbound autopilot repair step.',
    'Make the smallest safe code or documentation change needed for the failing command to pass.',
    'Do not edit Story, checklist, fixture, or process-event JSON directly; use the Proofbound CLI for Proofbound state changes.',
    'Do not create or push GitHub/origin branches.',
    '',
    `Story: ${plan.story.storyId ?? 'unbound'}`,
    `Mode: ${plan.mode}`,
    `Target phase: ${plan.targetPhase}`,
    `Failing step: ${step.id}`,
    `Failing command: ${displayCommand(request)}`,
    `Exit code: ${result.exitCode}`,
    '',
    'stdout excerpt:',
    excerpt(result.stdout) || '(empty)',
    '',
    'stderr excerpt:',
    excerpt(result.stderr) || '(empty)',
    '',
    'After the repair, stop. The Proofbound autopilot executor will retry the failing command.',
  ].join('\n');
}

/** Best-effort project-root hash for a usage-ledger context (mirrors the host_run handler). */
function projectRootHashFor(root: string): string {
  return `sha256:${createHash('sha256').update(root, 'utf8').digest('hex')}`;
}

/**
 * B-70e9 CHK-003: the Claude Code CLI repair spawn is a lattice-initiated host run,
 * so it is covered by the SAME usage-ledger seam as host_run / lattice-dispatch —
 * preflight estimate (sequence 1) -> spawn -> provider/unavailable final (sequence 2
 * superseding the estimate). Every ledger call is fail-open (never throws to the
 * repair) and the whole thing is a STRICT no-op when the ledger is OFF.
 *
 * F-016: the repair also passes the SAME pre-spawn admission as runHostRun —
 * hard-budget guard (recordBudgetBlock) then atomic concurrency-slot admission
 * (acquireHostRunSlot; released in a finally) — so LATTICE_HARD_BUDGET_TOKENS
 * and LATTICE_HOST_RUN_MAX_CONCURRENT stop an autopilot repair exactly like any
 * other lattice-initiated host run. A refusal records the same blocked ledger
 * row (provider anthropic — a repair is always a claude launch) and returns a
 * 'failed' attempt WITHOUT invoking the runner. Admission only exists in the
 * ledger-ON path; OFF stays byte-identical (no admission, no slot dirs, no rows).
 *
 * Ledger-ON vs OFF contract (load-bearing invariant):
 *   - OFF (LATTICE_USAGE_LEDGER=0): argv and behavior are BYTE-IDENTICAL to before
 *     this change — no `--output-format json`, no rows, no dirs. The existing
 *     autopilot smokes rely on this.
 *   - ON: the repair launcher adds `--output-format json` so Claude emits a parseable
 *     usage envelope; the final row binds the served model, and the recorded stdout
 *     EXCERPT comes from the parsed envelope `.result` text (so the human-facing
 *     excerpt stays equivalent to the plain-text output it would have printed).
 *
 * Exported so the smoke can drive it directly with a fake AutopilotCommandRunner
 * (no real Claude CLI, no StoryStore) and assert both the ON rows and the OFF
 * byte-identical argv.
 */
export function runClaudeRepair(
  root: string,
  args: AutopilotExecuteArgs,
  runner: AutopilotCommandRunner,
  step: AutopilotStep,
  request: AutopilotCommandRequest,
  result: AutopilotCommandResult,
  plan: AutopilotRunResult,
  env: NodeJS.ProcessEnv = process.env,
): AutopilotRepairAttempt {
  const claudeCommand = args.claudeCommand || 'claude';
  const prompt = claudeRepairPrompt(step, request, result, plan);
  const ledgerOn = isUsageLedgerEnabled(env);

  const claudeArgs = ['-p', prompt];
  // Ledger ON: request the JSON envelope so the served-model usage is parseable.
  // Ledger OFF: this flag is NOT added, keeping the spawn argv byte-identical.
  if (ledgerOn) {
    claudeArgs.push('--output-format', 'json');
  }
  if (args.claudePermissionMode) {
    claudeArgs.push('--permission-mode', args.claudePermissionMode);
  }

  // The human-facing command label (prompt redacted). Built up front so a
  // pre-spawn admission refusal (F-016) reports the exact launch it refused.
  const displayArgs = ['-p', '<repair-prompt>'];
  if (ledgerOn) displayArgs.push('--output-format', 'json');
  if (args.claudePermissionMode) displayArgs.push('--permission-mode', args.claudePermissionMode);
  const commandLabel = [claudeCommand, ...displayArgs].join(' ');

  // Attribution: storyId from the plan (null when unbound); phase = the target phase
  // the autopilot is driving toward (the honest phase the repair ran under) else a
  // stable 'autopilot-repair' label; agentType 'autopilot-repair'.
  const ctx: DispatchUsageContext = {
    storyId: plan.story.storyId ?? null,
    phase: typeof plan.targetPhase === 'string' && plan.targetPhase.length > 0 ? plan.targetPhase : 'autopilot-repair',
    agentType: 'autopilot-repair',
  };
  const opts: DispatchUsageOptions = {
    recordedAt: new Date().toISOString(),
    projectRootHash: projectRootHashFor(root),
    command: 'autopilot-repair:claude',
    host: { kind: 'claude-code' },
    env,
  };

  // Preflight estimate BEFORE the spawn (fail-open; strict no-op when OFF).
  let handle: DispatchPreflightHandle | null = null;
  if (ledgerOn) {
    try {
      handle = recordDispatchPreflight(root, ctx, prompt, opts);
    } catch {
      handle = null;
    }
  }

  // F-016: pre-spawn admission — the SAME gates, in the SAME order, as
  // runHostRun (preflight -> budget -> concurrency -> spawn). ON-path only, so
  // the ledger-OFF repair stays byte-identical (no admission, no slot dirs).
  let slot: AcquiredHostRunSlot | null = null;
  if (ledgerOn) {
    // (1) Hard-budget admission (fail-closed; the blocked row is written inside
    // recordBudgetBlock, which never throws). A repair is always a claude
    // launch, so the anthropic provider binding mirrors host_run's claude path.
    const budget = recordBudgetBlock(root, ctx, handle, prompt, opts, { name: 'anthropic', model: null });
    if (budget.blocked) {
      return blockedRepairAttempt(
        step,
        commandLabel,
        `autopilot repair refused pre-spawn: hard_budget_exceeded (${budget.budgetPolicyId ?? 'hard-budget'}${
          budget.hardBudgetTokens !== null ? `, cap ${budget.hardBudgetTokens}` : ''
        }); the claude runner was never invoked`,
      );
    }

    // (2) Concurrency admission via the SAME atomic fixed-slot registry as
    // host_run: acquire before the spawn, release in the finally below. On a
    // cap refusal, record the concurrency blocked row and return WITHOUT
    // spawning. A slot-registry error also refuses fail-closed (an admission
    // error must never grant an unguarded spawn) but never throws out of the
    // repair — unlike runHostRun, whose caller owns that failure directly.
    const cap = resolveMaxConcurrent(env);
    let registryError: string | null = null;
    try {
      slot = acquireHostRunSlot(hostRunSlotsDir(root), cap, resolveSlotStaleMs(env), Date.now(), {
        pid: process.pid,
        startedAt: opts.recordedAt,
        host: 'claude',
        storyId: ctx.storyId,
        agentType: ctx.agentType,
      });
    } catch (err) {
      registryError = err instanceof Error ? err.message : String(err);
      slot = null;
    }
    if (slot === null) {
      if (registryError !== null) {
        // An honest registry-failure refusal: no concurrency_cap_exceeded row is
        // fabricated for a refusal that was not a cap decision.
        return blockedRepairAttempt(
          step,
          commandLabel,
          `autopilot repair refused pre-spawn: host-run slot registry error (${registryError}); refusing fail-closed, the claude runner was never invoked`,
        );
      }
      recordConcurrencyBlock(root, ctx, handle, prompt, cap, opts, { name: 'anthropic', model: null });
      return blockedRepairAttempt(
        step,
        commandLabel,
        `autopilot repair refused pre-spawn: concurrency_cap_exceeded (cap ${cap}, every host-run slot held by a live run); the claude runner was never invoked`,
      );
    }
  }

  let repairResult: AutopilotCommandResult;
  try {
    repairResult = runner({
      executable: claudeCommand,
      args: claudeArgs,
      cwd: root,
      timeoutMS: positiveInteger(args.claudeTimeoutMS, DEFAULT_CLAUDE_TIMEOUT_MS),
    });
  } finally {
    // F-016: release the admission slot exactly like host_run — token-verified
    // (F-025; a reclaimed+reacquired slot is never deleted), best-effort (pid-
    // death / the orphan backstop reclaims a leak). null (ledger OFF) is a no-op.
    releaseSlot(slot ? slot.file : null, slot ? slot.token : null);
  }

  // Final row + excerpt. When the ledger is ON, parse the JSON envelope so (a) the
  // final binds the anthropic four-field usage + served model, and (b) the recorded
  // excerpt is the human-facing `.result` text rather than the raw JSON blob (keeps
  // the excerpt equivalent to today's plain-text output). A non-envelope stdout
  // (fake / a claude that ignored the flag) falls back to the raw text, so the
  // excerpt degrades to the raw stdout exactly like the OFF path.
  let stdoutForExcerpt = repairResult.stdout;
  if (ledgerOn) {
    try {
      const parsed = parseClaudeCliOutput(repairResult.stdout);
      recordDispatchFinal(
        root,
        ctx,
        handle?.correlation ?? null,
        handle?.estimateRecordId ?? null,
        parsed.anthropicUsage,
        parsed.model,
        opts,
      );
      stdoutForExcerpt = parsed.resultText;
    } catch {
      // The seam never breaks the repair; keep the raw stdout for the excerpt.
    }
  }

  return {
    stepId: step.id,
    command: commandLabel,
    status: repairResult.exitCode === 0 ? 'passed' : 'failed',
    exitCode: repairResult.exitCode,
    stdoutExcerpt: excerpt(stdoutForExcerpt),
    stderrExcerpt: excerpt(repairResult.stderr),
  };
}

/**
 * F-016: the honest attempt row for a pre-spawn admission refusal. The repair
 * never launched, so:
 *   - status is 'failed' — of AutopilotRepairAttempt's three statuses this is
 *     the least surprising: 'skipped' is what the executor uses for steps that
 *     are NOT APPLICABLE (and skipped steps carry exitCode null, which this
 *     shape cannot express), while a fail-closed cap refusal IS a failed repair
 *     attempt; the executor's repair loop already stops on any non-'passed'.
 *   - exitCode is the host-run refusal sentinel (3), matching a host_run cap
 *     refusal for the same condition.
 *   - command is the exact launch that was refused (prompt redacted) and
 *     stderrExcerpt carries the refusal reason; stdout is honestly empty.
 */
function blockedRepairAttempt(step: AutopilotStep, command: string, reason: string): AutopilotRepairAttempt {
  return {
    stepId: step.id,
    command,
    status: 'failed',
    exitCode: HOST_RUN_REFUSAL_EXIT_CODE,
    stdoutExcerpt: '',
    stderrExcerpt: reason,
  };
}

function skippedStep(step: AutopilotStep, reason: string, now: () => Date): AutopilotExecutedStep {
  const timestamp = now().toISOString();
  return {
    ...step,
    status: 'skipped',
    exitCode: null,
    stdoutExcerpt: '',
    stderrExcerpt: '',
    startedAt: timestamp,
    endedAt: timestamp,
    repairAttempts: [],
    reason,
  };
}

export function executeAutopilot(options: ExecuteAutopilotOptions): AutopilotExecuteResult {
  const args = options.args ?? {};
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;
  const now = options.now ?? (() => new Date());
  const maxSteps = boundedInteger(args.maxSteps, DEFAULT_MAX_EXECUTE_STEPS, MAX_EXECUTE_STEPS_HARD_CAP);
  const maxReviewWaves = boundedInteger(args.maxReviewWaves, DEFAULT_MAX_REVIEW_WAVES, MAX_REVIEW_WAVES_HARD_CAP);
  const dryRun = args.dryRun === true;
  const commandTimeoutMS = positiveInteger(args.commandTimeoutMS, DEFAULT_COMMAND_TIMEOUT_MS);
  const maxRepairAttempts = args.allowClaudeRepair
    ? positiveInteger(args.maxRepairAttempts, 1)
    : 0;

  const plan = buildAutopilotRun(options.store, {
    ...args,
    dryRun: true,
    maxSteps,
  }, env, { cwd: options.root });
  // --requireMultiHost / --requiredHostVerdictCount only tighten DONE certification.
  // This executor never collects host verdicts itself, so multiHostVerified stays false
  // and a multi-host DONE target must fail closed with a clear next action.
  const requireMultiHost = args.requireMultiHost === true;
  const requiredHostVerdictCount = Math.max(
    positiveInteger(args.requiredHostVerdictCount, 0),
    requireMultiHost ? 2 : 0,
  );
  const multiHostRequired =
    (requireMultiHost || requiredHostVerdictCount > 0) && plan.targetPhase === 'DONE';
  const multiHostSatisfied = plan.multiHostVerified;
  const executedSteps: AutopilotExecutedStep[] = [];
  const repairAttempts: AutopilotRepairAttempt[] = [];
  const nextActions = new Set(plan.nextActions);
  let status: AutopilotStatus = plan.status;
  let stopReason = dryRun ? 'dry-run' : 'completed';
  let authorityDone = plan.authorityDone;
  let fullAuthorityDone = plan.fullAuthorityDone;
  let claimedJobExecution: null = null;
  let completion: null = null;
  let receipt = plan.receipt;
  if (dryRun) {
    nextActions.add('Remove --dryRun to execute the planned local Proofbound commands.');
    if (multiHostRequired) {
      nextActions.add(`This run targets DONE with multi-host certification: real execution stays blocked until ${requiredHostVerdictCount} independent host verdicts certify the run (lattice autopilot review submit / lattice quorum_submit).`);
    }
  } else if (!plan.story.storyId) {
    status = 'fail';
    stopReason = 'story-required';
    nextActions.add('Pass --storyId=B-xxx before running lattice autopilot execute; true execution must be owner-gated to a concrete Story.');
  } else if (!plan.story.exists) {
    status = 'fail';
    stopReason = 'story-not-found';
    nextActions.add(`Create or restore Story ${plan.story.storyId} before running lattice autopilot execute.`);
  } else if (plan.mode === 'authority' && plan.status === 'fail') {
    status = 'fail';
    stopReason = 'remote-runner-retired';
    nextActions.add('Use --mode=local; remote runner execution is retired from the active Proofbound runtime.');
  } else if (multiHostRequired && !multiHostSatisfied) {
    status = 'fail';
    stopReason = 'multi-host-verdicts-required';
    nextActions.add(`Autopilot execute cannot self-certify multi-host DONE. Collect ${requiredHostVerdictCount} independent host verdicts via lattice autopilot review submit and lattice quorum_submit, then advance DONE once local quorum evidence is present.`);
  } else {
    const steps = plan.plannedSteps.slice(0, maxSteps);
    if (plan.plannedSteps.length > maxSteps) {
      status = status === 'fail' ? 'fail' : 'warn';
      stopReason = 'max-steps-reached';
      nextActions.add(`Increase --maxSteps above ${maxSteps} to continue the executor loop.`);
    }

    for (const step of steps) {
      if (step.authorityRequired && plan.mode !== 'authority') {
        executedSteps.push(skippedStep(step, 'authority step is not required in this mode', now));
        continue;
      }
      const request = commandForStep(options.root, step, plan);
      if (!request) {
        executedSteps.push(skippedStep(step, 'no safe argv mapping exists for this planned step', now));
        continue;
      }
      request.timeoutMS = commandTimeoutMS;

      const startedAt = now().toISOString();
      let commandResult = runner(request);
      const stepRepairs: AutopilotRepairAttempt[] = [];
      let repairIndex = 0;
      while (commandResult.exitCode !== 0 && repairIndex < maxRepairAttempts) {
        const repair = runClaudeRepair(options.root, args, runner, step, request, commandResult, plan, env);
        stepRepairs.push(repair);
        repairAttempts.push(repair);
        repairIndex += 1;
        if (repair.status !== 'passed') break;
        commandResult = runner(request);
      }
      const endedAt = now().toISOString();
      const passed = commandResult.exitCode === 0;
      executedSteps.push({
        ...step,
        status: passed ? 'passed' : 'failed',
        exitCode: commandResult.exitCode,
        stdoutExcerpt: excerpt(commandResult.stdout),
        stderrExcerpt: excerpt(commandResult.stderr),
        startedAt,
        endedAt,
        repairAttempts: stepRepairs,
      });
      if (!passed) {
        status = 'fail';
        stopReason = 'step-failed';
        nextActions.add(`Fix failing autopilot step "${step.id}" and rerun lattice autopilot execute.`);
        break;
      }
    }
  }

  return {
    schemaVersion: 'lattice.autopilot_execute.v1',
    mode: plan.mode,
    status,
    dryRun,
    once: plan.once,
    maxSteps,
    maxReviewWaves,
    targetPhase: plan.targetPhase,
    story: plan.story,
    localWorkflowUsable: true,
    localReviewCertified: plan.localReviewCertified,
    authorityDone,
    fullAuthorityDone,
    multiHostVerified: plan.multiHostVerified,
    multiHostRequired,
    requiredHostVerdictCount,
    authorityRequired: plan.authorityRequired,
    receiptRequired: plan.receiptRequired,
    receipt,
    authority: plan.authority,
    plannedSteps: plan.plannedSteps,
    executedSteps,
    claimedJobExecution,
    completion,
    blockingReasons: [],
    receiptRefs: [],
    hostVerdictRefs: [],
    nextAction: [...nextActions][0] ?? stopReason,
    repair: {
      enabled: args.allowClaudeRepair === true,
      command: args.claudeCommand || 'claude',
      permissionMode: args.claudePermissionMode ?? null,
      maxAttemptsPerStep: maxRepairAttempts,
      attempts: repairAttempts,
    },
    stopReason,
    nextActions: [...nextActions],
    note: 'Local execute runs only local Proofbound commands and does not contact or require a remote receipt server.',
  };
}
