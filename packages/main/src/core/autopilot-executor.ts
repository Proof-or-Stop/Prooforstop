import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
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
  consumeClaimedAuthorityJob,
  parseClaimedAuthorityJob,
  type ClaimedAuthorityJob,
  type ConsumeClaimedAuthorityJobResult,
} from './authority-runner.js';
import type { AuthorityGateDecision } from './authority-client.js';
import type { MaterialOverlapAuditContract } from './authority-contracts.js';
import type { AuthorityGateEvaluator } from './planned-steps-executor.js';
import type { AuthorityCompletionVerdict, AuthorityReceiptRef } from './authority-completion.js';
import type { AuthorityJobLoopTrace } from './authority-job-loop-live.js';

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
  /**
   * Path to a claimed Authority job JSON file carrying a typed plannedSteps[]
   * payload. When supplied, the executor consumes that job through the shared
   * plannedSteps executor instead of synthesizing local argv steps. This is the
   * CLI/live entry point for the in-process `claimedJob` seam; identity and
   * receipt gating are identical. Ignored when `options.claimedJob` is set.
   */
  jobFile?: string;
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
  claimedJobExecution: ConsumeClaimedAuthorityJobResult | null;
  /**
   * The fail-closed authority completion verdict, present only when a claimed
   * Authority job ran through the shared plannedSteps executor. Local / dry-run /
   * argv-synthesis paths have no plannedSteps completion gate and leave it null;
   * they never project an authority DONE flag.
   */
  completion: AuthorityCompletionVerdict | null;
  /** Machine-readable reasons the job did NOT fully complete (empty when completed or n/a). */
  blockingReasons: string[];
  /** Native gate_decision receipt handles surfaced by the completion verdict. */
  receiptRefs: AuthorityReceiptRef[];
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
  /**
   * Live Stage B authority job-loop runtime trace. Present ONLY on the live
   * `--mode=authority` (no --jobFile) path that registers/heartbeats/claims a
   * queued job over the network and drives its lease to a terminal state. All
   * other paths (local / shadow / dry-run / in-process claimedJob / --jobFile)
   * leave it null.
   */
  authorityJobLoop?: AuthorityJobLoopTrace | null;
}

export interface ExecuteAutopilotOptions {
  store: StoryStore;
  root: string;
  args?: AutopilotExecuteArgs;
  env?: Record<string, string | undefined>;
  runner?: AutopilotCommandRunner;
  now?: () => Date;
  /**
   * A claimed Authority job carrying typed plannedSteps[]. When supplied, the
   * executor consumes it through the shared plannedSteps executor instead of
   * synthesizing local argv steps. Authority DONE stays gated by a verified
   * native receipt; this path never mints one.
   */
  claimedJob?: ClaimedAuthorityJob;
  /**
   * Optional live gate evaluator for claimed authority jobs. This is resolved
   * before the synchronous executor path runs, so --jobFile/non-live callers keep
   * the existing fail-closed behavior unless they explicitly inject it.
   */
  claimedJobAuthorityGate?: AuthorityGateEvaluator;
  claimedJobGateDecision?: AuthorityGateDecision;
  /** Material-overlap audit paired with claimedJobAuthorityGate for the signed DONE gate request. */
  claimedJobMaterialOverlapAudit?: MaterialOverlapAuditContract;
  /**
   * Injected fetch for the live authority job loop (tests inject a fake server).
   * Threaded only into the live `--mode=authority` loop; unused on every other
   * path. Defaults to the global fetch.
   */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_EXECUTE_STEPS = 20;
// Hard ceilings so the executor loop can never be driven unbounded by caller input.
const MAX_EXECUTE_STEPS_HARD_CAP = 100;
const DEFAULT_MAX_REVIEW_WAVES = 3;
const MAX_REVIEW_WAVES_HARD_CAP = 10;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_CLAUDE_TIMEOUT_MS = 300_000;
const OUTPUT_EXCERPT_LIMIT = 2_000;

function projectCompletionReceipt(
  base: AutopilotReceiptProjection,
  completion: AuthorityCompletionVerdict | null,
): AutopilotReceiptProjection {
  if (!completion) return base;
  const ref = completion.receiptRefs[0];
  if (!ref && !completion.receiptId && !completion.decisionDigest) return base;
  return {
    ...base,
    provided: true,
    verified: completion.receiptVerified,
    native: true,
    format: 'lattice-authority',
    reason: completion.receiptVerified
      ? 'verified gate_decision receipt from the Authority completion gate'
      : completion.blockingReasons[0] ?? base.reason,
    ...(ref?.receiptId || completion.receiptId ? { receiptId: ref?.receiptId || completion.receiptId } : {}),
    kind: 'gate_decision',
    ...(ref?.decisionDigest || completion.decisionDigest ? { decisionDigest: ref?.decisionDigest || completion.decisionDigest } : {}),
  };
}

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
    case 'authority-status-shadow':
      return {
        ...latticeArgs(['authority', 'status', '--json']),
        env: { LATTICE_AUTHORITY_MODE: 'shadow' },
      };
    case 'authority-policy':
      return latticeArgs(['authority', 'enforce', 'policy', '--json']);
    case 'authority-runner':
      return latticeArgs(['authority', 'enforce', 'runner', '--dry-run', '--json']);
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
    'You are Claude Code CLI running as an explicit Lattice autopilot repair step.',
    'Make the smallest safe code or documentation change needed for the failing command to pass.',
    'Do not edit Story, checklist, fixture, or process-event JSON directly; use the Lattice CLI for Lattice state changes.',
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
    'After the repair, stop. The Lattice autopilot executor will retry the failing command.',
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

type LoadClaimedJobResult =
  | { ok: true; job: ClaimedAuthorityJob }
  | { ok: false; reason: string };

// Load and validate a claimed Authority job from a JSON file. Fail-closed: any
// read, parse, or shape problem returns a reason instead of a job, so the
// executor refuses to run rather than synthesize local argv steps from a bad
// job. Deep plannedSteps[] validation stays in consumeClaimedAuthorityJob.
function loadClaimedAuthorityJobFile(jobFile: string): LoadClaimedJobResult {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), jobFile), 'utf8');
  } catch (error: any) {
    return { ok: false, reason: `cannot read claimed job file ${jobFile}: ${error?.message || error}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: any) {
    return { ok: false, reason: `claimed job file ${jobFile} is not valid JSON: ${error?.message || error}` };
  }
  const coerced = parseClaimedAuthorityJob(parsed);
  if (!coerced.ok) {
    return { ok: false, reason: `claimed job file ${jobFile} is invalid: ${coerced.reason}` };
  }
  return { ok: true, job: coerced.job };
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
  let claimedJobExecution: ConsumeClaimedAuthorityJobResult | null = null;
  let completion: AuthorityCompletionVerdict | null = null;
  let receipt = plan.receipt;

  // Resolve a claimed Authority job. An in-process job (options.claimedJob) wins
  // for tests/programmatic callers; otherwise --jobFile is the CLI/live entry
  // point. A bad --jobFile fails closed before any execution.
  let claimedJob: ClaimedAuthorityJob | undefined = options.claimedJob;
  let claimedJobFileError: string | null = null;
  if (!claimedJob && typeof args.jobFile === 'string' && args.jobFile.length > 0) {
    const loaded = loadClaimedAuthorityJobFile(args.jobFile);
    if (loaded.ok) {
      claimedJob = loaded.job;
    } else {
      claimedJobFileError = loaded.reason;
    }
  }

  if (claimedJobFileError) {
    // A claimed job file was requested but could not be loaded/validated. Refuse
    // to fall back to local argv synthesis; fail closed with a clear reason.
    status = 'fail';
    stopReason = 'claimed-job-file-invalid';
    nextActions.add(claimedJobFileError);
    nextActions.add('Reissue a valid claimed Authority job file (typed plannedSteps[]) before running lattice autopilot execute --jobFile.');
  } else if (dryRun) {
    nextActions.add('Remove --dryRun to execute the planned local Lattice commands.');
    if (multiHostRequired) {
      nextActions.add(`This run targets DONE with multi-host certification: real execution stays blocked until ${requiredHostVerdictCount} independent host verdicts certify the run (lattice autopilot review submit / lattice authority verdict submit).`);
    }
  } else if (!plan.story.storyId) {
    status = 'fail';
    stopReason = 'story-required';
    nextActions.add('Pass --storyId=B-xxx before running lattice autopilot execute; true execution must be owner-gated to a concrete Story.');
  } else if (!plan.story.exists) {
    status = 'fail';
    stopReason = 'story-not-found';
    nextActions.add(`Create or restore Story ${plan.story.storyId} before running lattice autopilot execute.`);
  } else if (claimedJob) {
    // A claimed Authority job was supplied (in-process or via --jobFile): consume
    // its typed plannedSteps[] through the shared plannedSteps executor instead of
    // synthesizing local argv steps. Identity must line up with the CLI-bound run,
    // and authority DONE stays gated by a verified native receipt (no client-side
    // minting).
    const job = claimedJob;
    if (job.storyId !== plan.story.storyId) {
      status = 'fail';
      stopReason = 'claimed-job-story-mismatch';
      nextActions.add(`Claimed job storyId ${job.storyId} does not match --storyId=${plan.story.storyId}; refusing to execute a mismatched job.`);
    } else if (job.mode !== plan.mode) {
      status = 'fail';
      stopReason = 'claimed-job-mode-mismatch';
      nextActions.add(`Claimed job mode ${job.mode} does not match --mode=${plan.mode}; refusing to execute a mismatched job.`);
    } else {
      const consume = consumeClaimedAuthorityJob({
        root: options.root,
        store: options.store,
        job,
        receiptVerified: plan.receipt.verified && plan.receipt.native,
        maxSteps,
        now,
        ...(options.claimedJobAuthorityGate ? { authorityGate: options.claimedJobAuthorityGate } : {}),
        ...(options.claimedJobGateDecision ? { gateDecision: options.claimedJobGateDecision } : {}),
        ...(options.claimedJobMaterialOverlapAudit ? { materialOverlapAudit: options.claimedJobMaterialOverlapAudit } : {}),
      });
      claimedJobExecution = consume;
      completion = consume.completion;
      authorityDone = consume.authorityDone;
      fullAuthorityDone = consume.fullAuthorityDone;
      receipt = projectCompletionReceipt(plan.receipt, completion);
      stopReason = `authority-job-${consume.disposition}`;
      status = consume.disposition === 'completed'
        ? (plan.status === 'fail' ? 'warn' : 'pass')
        : 'fail';
      for (const action of consume.nextActions) nextActions.add(action);
    }
  } else if (plan.mode === 'authority' && plan.status === 'fail') {
    status = 'fail';
    stopReason = 'authority-not-ready';
    nextActions.add('Use --mode=local for local execution, or provide authority readiness and a verified DONE receipt before authority execution.');
  } else if (multiHostRequired && !multiHostSatisfied) {
    status = 'fail';
    stopReason = 'multi-host-verdicts-required';
    nextActions.add(`Autopilot execute cannot self-certify multi-host DONE. Collect ${requiredHostVerdictCount} independent host verdicts via lattice autopilot review submit (local) or lattice authority verdict submit (authority), then advance DONE once multiHostVerified is true.`);
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
    blockingReasons: completion?.blockingReasons ?? [],
    receiptRefs: completion?.receiptRefs ?? [],
    hostVerdictRefs: completion?.hostVerdictRefs ?? [],
    nextAction: completion?.nextAction ?? [...nextActions][0] ?? stopReason,
    repair: {
      enabled: args.allowClaudeRepair === true,
      command: args.claudeCommand || 'claude',
      permissionMode: args.claudePermissionMode ?? null,
      maxAttemptsPerStep: maxRepairAttempts,
      attempts: repairAttempts,
    },
    stopReason,
    nextActions: [...nextActions],
    note: plan.mode === 'authority'
      ? 'Authority execute is fail-closed: local mode remains available, and authority DONE still requires a verified Python authority receipt.'
      : plan.mode === 'shadow'
        ? 'Shadow execute runs local Lattice steps while surfacing authority readiness warnings.'
        : 'Local execute runs only local Lattice commands and does not require Python authority.',
  };
}
