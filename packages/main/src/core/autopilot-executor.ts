import { execFileSync } from 'node:child_process';
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

function runClaudeRepair(
  root: string,
  args: AutopilotExecuteArgs,
  runner: AutopilotCommandRunner,
  step: AutopilotStep,
  request: AutopilotCommandRequest,
  result: AutopilotCommandResult,
  plan: AutopilotRunResult,
): AutopilotRepairAttempt {
  const claudeCommand = args.claudeCommand || 'claude';
  const claudeArgs = ['-p', claudeRepairPrompt(step, request, result, plan)];
  if (args.claudePermissionMode) {
    claudeArgs.push('--permission-mode', args.claudePermissionMode);
  }
  const repairResult = runner({
    executable: claudeCommand,
    args: claudeArgs,
    cwd: root,
    timeoutMS: positiveInteger(args.claudeTimeoutMS, DEFAULT_CLAUDE_TIMEOUT_MS),
  });
  return {
    stepId: step.id,
    command: [claudeCommand, '-p', '<repair-prompt>', ...(args.claudePermissionMode ? ['--permission-mode', args.claudePermissionMode] : [])].join(' '),
    status: repairResult.exitCode === 0 ? 'passed' : 'failed',
    exitCode: repairResult.exitCode,
    stdoutExcerpt: excerpt(repairResult.stdout),
    stderrExcerpt: excerpt(repairResult.stderr),
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
        const repair = runClaudeRepair(options.root, args, runner, step, request, commandResult, plan);
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
