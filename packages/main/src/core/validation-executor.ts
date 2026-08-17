import { execSync, spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from './config.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsForStory,
  dirtyWorktreeClassifierOptionsFromConfig,
  parseGitPorcelainRow,
  renderDirtyWorktreeGroups,
} from './dirty-worktree.js';
import { StoryStore } from './store.js';
import { resolveProjectGitCwd } from './story-signed-workspace-resolution.js';
import { defaultAuditWriter, evaluateDirtyGate, type EvaluateDirtyGateResult } from './dirty-gate-policy.js';
import {
  canonicalizeEntries,
  MAX_JOBS,
  parsePositiveInteger,
  runScheduled,
  validateResourceClaims,
  type ResourceClaim,
  type SchedulableEntry,
  type SchedulableResult,
  type ScheduledStatus,
} from './keyed-scheduler.js';
import type {
  ConcurrentWorktreePollution,
  ConcurrentWorktreePollutionAttribution,
  ValidationCommand,
  ValidationCommandResult,
  ValidationFailureKind,
  ValidationPlan,
  ValidationProgressEvent,
  ValidationProgressReporter,
  ValidationResult,
} from './validation-types.js';
import { effectiveValidationCommandEnvironment } from './validation-command-environment.js';

const MAX_OUTPUT_CHARS = 12000;

/**
 * Default hard per-command ceiling applied when a validate command sets no explicit
 * `timeoutMs`. This is a TOTAL WALL-CLOCK ceiling per command — distinct from the
 * cli-engine global watchdog, which fires only after ~300s of NO OUTPUT (idle). Kept
 * strictly BELOW that global watchdog (300_000ms = 5*60*1000; overridable via the
 * LATTICE_IDLE_TIMEOUT_MS env var) so a hung/slow command is killed and ATTRIBUTED
 * (exit 124) here first, instead of the global watchdog silently force-exiting the whole
 * validate (which never re-stamps test-evidence.materialHash and silently blocks DONE for
 * every story). It is also kept ABOVE the observed full-validation incident envelope
 * (~171s) with margin; a command that genuinely needs longer can raise
 * `lattice.config.json` validate.commands[].timeoutMs (the build is pinned there to 290s
 * to keep near-watchdog headroom for a cold-cache compile). NOTE: lowering
 * LATTICE_IDLE_TIMEOUT_MS below this default would invert the invariant — an advanced,
 * non-default override the operator owns.
 */
export const DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS = 270_000;
export const DEFAULT_VALIDATE_HEARTBEAT_MS = 30_000;
/** Node clamps larger setTimeout delays to ~1ms and emits TimeoutOverflowWarning. */
export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export interface RunValidationCommandOptions {
  progress?: ValidationProgressReporter;
  commandIndex?: number;
  totalCommands?: number;
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
}

export interface ExecuteValidationPlanOptions {
  progress?: ValidationProgressReporter;
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
  /** Scheduler worker count; overrides LATTICE_VALIDATE_JOBS. See {@link resolveValidatePlanJobs}. */
  jobs?: number;
}

/**
 * Worker count for the routine-validate plan scheduler.
 *
 * 4 is the same default the full test-suite runner (tasks/full-suite-runner.ts)
 * has been running on since it moved onto this scheduler, so the two callers of
 * `runScheduled` behave alike and one number is tuned instead of two. It is also
 * the right order of magnitude here for reasons specific to this plan:
 *
 *  - Admission control, not this number, is what keeps the run correct: an
 *    undeclared command holds the plan-wide barrier exclusively, so raising the
 *    worker count can never make an unclassified command overlap anything.
 *    Today most configured commands are undeclared, which caps the achievable
 *    concurrency well below 4 for long stretches of the plan; workers past that
 *    point sit idle rather than helping.
 *  - Each validate command is itself a process tree (npm / tsc / node spawning
 *    children), so the effective load is a multiple of the worker count. Four
 *    concurrent trees is already a heavy machine on a typical 8-10 core host,
 *    and oversubscribing inflates every command's wall time — which is the same
 *    number the per-command `timeoutMs` ceilings are calibrated against.
 */
export const DEFAULT_VALIDATE_PLAN_JOBS = 4;

/**
 * Resolve the scheduler worker count: explicit `jobs` option, else the
 * `LATTICE_VALIDATE_JOBS` env var, else {@link DEFAULT_VALIDATE_PLAN_JOBS}.
 *
 * A PRESENT but unparseable / out-of-range value is REFUSED rather than
 * silently replaced by the default: an operator who sets this has a reason, and
 * quietly ignoring the setting turns "why is validate still slow / still
 * parallel" into an unanswerable question. Absent or empty is not a setting, so
 * it takes the default. `jobs=1` is a legitimate setting — it degrades to
 * strict plan-order sequential execution, which is exactly the pre-scheduler
 * behaviour.
 */
export function resolveValidatePlanJobs(env: NodeJS.ProcessEnv = process.env, override?: number): number {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 1 || override > MAX_JOBS) {
      throw new Error(`validate plan jobs must be an integer between 1 and ${MAX_JOBS}`);
    }
    return override;
  }
  const raw = env.LATTICE_VALIDATE_JOBS?.trim();
  if (!raw) return DEFAULT_VALIDATE_PLAN_JOBS;
  return parsePositiveInteger(raw, 'LATTICE_VALIDATE_JOBS');
}

/**
 * The effective per-command timeout: an explicit positive `timeoutMs`, else `defaultMs`
 * (the module default unless a caller injects one — the seam tests use to exercise the
 * default-arming path with a tiny ceiling). A non-finite / zero / negative `timeoutMs`
 * falls back to the default BY DESIGN: there is intentionally no opt-out of the per-command
 * ceiling, since an unbounded command is exactly the hang this guards against.
 */
export function resolveCommandTimeoutMs(
  command: ValidationCommand,
  defaultMs: number = DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
): number {
  const effective = typeof command.timeoutMs === 'number' && Number.isFinite(command.timeoutMs) && command.timeoutMs > 0
    ? command.timeoutMs
    : defaultMs;
  return Math.max(1, Math.min(MAX_NODE_TIMER_DELAY_MS, Math.floor(effective)));
}

export function resolveValidateHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LATTICE_VALIDATE_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_VALIDATE_HEARTBEAT_MS;
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

export function formatValidationCommand(command: ValidationCommand): string {
  if (command.shell) return command.command;
  return [command.command, ...command.args].join(' ').trim();
}

function formatTimeoutDiagnostics(
  command: ValidationCommand,
  result: ValidationCommandResult,
  commandIndex: number,
  totalCommands: number,
): string[] {
  const explicit = typeof command.timeoutMs === 'number' && Number.isFinite(command.timeoutMs) && command.timeoutMs > 0;
  const timeoutMs = result.timeoutMs ?? resolveCommandTimeoutMs(command);
  const timeout = `${timeoutMs}ms${explicit ? '' : ' (default)'}`;
  return [
    `  timeout diagnostic: command ${commandIndex}/${totalCommands} "${command.label}" exceeded configured timeoutMs=${timeout} after elapsedMs=${result.durationMs}.`,
    `  command: ${command.command}`,
    `  args: ${JSON.stringify(command.args)}`,
    '  If this command legitimately needs longer, raise lattice.config.json validate.commands[].timeoutMs for that command; otherwise investigate a hung validation command.',
  ];
}

function commandCwd(projectRoot: string, cwd?: string): string {
  if (!cwd) return projectRoot;
  return isAbsolute(cwd) ? cwd : resolve(projectRoot, cwd);
}

function trimOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const omitted = output.length - MAX_OUTPUT_CHARS;
  return output.slice(0, MAX_OUTPUT_CHARS) + `\n...[truncated ${omitted} chars]`;
}

function emitValidationProgress(progress: ValidationProgressReporter | undefined, event: ValidationProgressEvent): void {
  if (!progress) return;
  try {
    const result = progress(event) as unknown;
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => { /* diagnostic-only async sink rejection */ });
    }
  } catch {
    // Progress is diagnostic-only; validation results must not depend on a
    // caller's logging sink.
  }
}

function commandFailureKind(args: {
  code: number;
  timedOut: boolean;
  runnerFailure: boolean;
}): ValidationFailureKind | undefined {
  if (args.code === 0 && !args.timedOut && !args.runnerFailure) return undefined;
  if (args.timedOut || args.runnerFailure) return 'infra_failure';
  return 'validation_failure';
}

function validationProgressEvent(
  type: ValidationProgressEvent['type'],
  command: ValidationCommand,
  args: {
    commandIndex: number;
    totalCommands: number;
    timeoutMs: number;
    started: number;
    cwd?: string;
    code?: number;
    timedOut?: boolean;
  },
): ValidationProgressEvent {
  return {
    type,
    commandIndex: args.commandIndex,
    totalCommands: args.totalCommands,
    label: command.label,
    command: command.command,
    args: command.args,
    ...(command.shell ? { shell: true } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
    timeoutMs: args.timeoutMs,
    elapsedMs: Date.now() - args.started,
    timestamp: new Date().toISOString(),
    ...(typeof args.code === 'number' ? { code: args.code } : {}),
    ...(args.timedOut ? { timedOut: true } : {}),
  };
}

export function formatValidationProgressEvent(event: ValidationProgressEvent): string {
  const index = `${event.commandIndex}/${event.totalCommands}`;
  const commandText = event.shell
    ? event.command
    : [event.command, ...event.args].join(' ').trim();
  switch (event.type) {
    case 'command_start':
      return `validate progress: command ${index} started ${event.label}: ${commandText} timeoutMs=${event.timeoutMs}`;
    case 'heartbeat':
      return `validate heartbeat: command ${index} ${event.label} elapsedMs=${event.elapsedMs} timeoutMs=${event.timeoutMs}`;
    case 'command_timeout':
      return `validate timeout: command ${index} ${event.label}: command=${event.command} args=${JSON.stringify(event.args)} timeoutMs=${event.timeoutMs} elapsedMs=${event.elapsedMs}`;
    case 'command_end':
      return `validate progress: command ${index} ended ${event.label}: code=${event.code ?? 'unknown'} elapsedMs=${event.elapsedMs}${event.timedOut ? ' timedOut=true' : ''}`;
  }
}

// B-75f0 CHK-002: `gitCwd` is the resolved git working dir (runValidationCommand
// resolves it via resolveProjectGitCwd). On a wrapper-root layout it is the real
// gitRoot subdir so the dirty-status probe reads the actual repo; on a plain repo
// (or when no gitRoot resolves) it is the passed projectRoot verbatim. The `null`
// fallback on any git failure is preserved (the side-effect guard is only
// available inside git worktrees; outside one it degrades to null, never crash).
// B-7dff CHK-003: `--no-optional-locks` because this probe now runs from several
// concurrently scheduled commands. A plain `git status` opportunistically refreshes
// (and therefore WRITES) the index, taking `.git/index.lock`; two probes racing for
// that lock make one of them fail, and a failed probe returns null, which
// detectNewDirtyStatus turns into "no pollution" — silently disabling the
// side-effect guard for that command. The flag suppresses only that optional index
// write; the porcelain output is unchanged.
//
// B-7dff F-003: this snapshot pair is REPO-WIDE, so what a command observes is
// "what appeared during my window", NOT "what I wrote". Under the concurrent
// scheduler those differ. The raw observation is therefore no longer an
// accusation on its own: executeValidationPlan cross-checks every command's
// observation against every other's (attributeWorktreePollution) before any of
// it is reported or gate-consumed.
function readGitStatus(gitCwd: string): string[] | null {
  try {
    const raw = execSync('git --no-optional-locks status --porcelain=v1 --untracked-files=all', {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return raw.split('\n').map(line => line.trimEnd()).filter(Boolean);
  } catch {
    // PROBE: validation side-effect guard is only available inside git worktrees.
    return null;
  }
}

function statusPath(line: string): string {
  return parseGitPorcelainRow(line)?.path ?? line.slice(3).trim();
}

function detectNewDirtyStatus(before: string[] | null, after: string[] | null): string[] {
  if (!before || !after || after.length === 0) return [];
  const beforePaths = new Set(before.map(statusPath));
  return after.filter(line => !beforePaths.has(statusPath(line)));
}

// Task B-6326 + B-4b22: validation side-effect details share DONE gate dirty
// ownership vocabulary AND route through dirty-gate-policy. When every polluted
// path classifies as a passing category (lattice_metadata / runtime_artifact /
// declared_artifact), this:
//   1. reports blocking=false (the caller writes it onto the pollution record,
//      and executeValidationPlan reads that to keep allPass = true),
//   2. swaps the leading "✗ … dirtied worktree" line for a "✓ … (passed by
//      dirty-gate-policy)" wording so downstream readers see that the loosening
//      was intentional,
//   3. emits audit lines into <projectRoot>/<storyDir>/<storyId>/process-events.jsonl
//      when a storyId is supplied. Storyless callers pass null writer (no
//      audit; gate degrades to blocking on failure path).
//
// Anti-divergence (preMortem #3): both core/done-oracle.ts (the DONE gate
// checklist) and this function import evaluateDirtyGate from the same module.
// No inline category check.
//
// B-7dff F-003: shared by BOTH pollution reports — the per-command one and the
// set-attributed one — so an unattributable dirty tree is classified, audited
// and gated by exactly the same policy as an attributable one. Only the header
// wording differs, which is why it is the caller's to supply.
function evaluateWorktreePollution(
  statusLines: string[],
  headers: { blocked: string; allowed: string },
  projectRoot?: string,
  storyId?: string,
): { lines: string[]; blocking: boolean } {
  const config = projectRoot ? loadConfig(projectRoot) : undefined;
  let classifierOptions = config ? dirtyWorktreeClassifierOptionsFromConfig(config, projectRoot) : {};
  if (config && projectRoot && storyId) {
    try {
      const store = new StoryStore(projectRoot);
      classifierOptions = dirtyWorktreeClassifierOptionsForStory(config, storyId, store, projectRoot);
    } catch {
      // PROBE: StoryStore init or declared-artifacts read failed → fall back to config-only options.
    }
  }
  const classification = classifyGitStatusRows(
    statusLines,
    classifierOptions,
  );
  const writer = projectRoot && storyId && config
    ? defaultAuditWriter(projectRoot, config.storyDir, storyId)
    : null;
  const evaluation: EvaluateDirtyGateResult = evaluateDirtyGate(classification, {
    storyId: storyId ?? 'anonymous',
    gate: 'validate-side-effect',
    writer,
  });
  const lines = [
    evaluation.allPass ? headers.allowed : headers.blocked,
    `  ${evaluation.allPass ? 'pass' : 'fail'}: ${evaluation.summary}`,
    ...renderDirtyWorktreeGroups(classification, { sampleLimit: 6, indent: '  ' }),
  ];
  if (evaluation.auditFailure) {
    lines.push(`  ${evaluation.auditFailure}`);
  }
  if (!evaluation.allPass) {
    lines.push('  validation commands must be side-effect-free by default; gate report generation behind an env var or configure side-effect-free validate.command(s)');
  } else {
    lines.push('  audit lines appended to process-events.jsonl by dirty-gate-policy (B-4b22)');
  }
  return { lines, blocking: !evaluation.allPass };
}

/**
 * Render (and gate) ONE command's pollution record.
 *
 * B-7dff F-003: by the time a plan run reaches here, the record has already
 * been narrowed to rows no other command could have caused, so the
 * "<label> dirtied worktree" wording below is always a sound accusation.
 * Single-command callers (verifier's validate-file path,
 * runSingleAllowlistedCommand) are sound for the same reason from the other
 * direction: nothing ran beside them.
 */
export function formatWorktreePollutionDetails(
  result: ValidationCommandResult,
  projectRoot?: string,
  storyId?: string,
): string[] {
  const pollution = result.worktreePollution;
  if (!pollution || pollution.statusLines.length === 0) return [];
  const { lines, blocking } = evaluateWorktreePollution(pollution.statusLines, {
    allowed: `✓ validation command produced policy-allowed dirty paths: ${result.label}: ${formatValidationCommand(result)}`,
    blocked: `✗ validation command dirtied worktree: ${result.label}: ${formatValidationCommand(result)}`,
  }, projectRoot, storyId);
  // Propagate blocking decision back to executeValidationPlan via a typed flag.
  pollution.blocking = blocking;
  return lines;
}

/**
 * B-7dff F-003: render the SET-attributed pollution record, and set its
 * `blocking` flag from the same dirty-gate-policy evaluation a per-command
 * record goes through.
 *
 * The header deliberately says "validation commands" (plural) and names every
 * candidate instead of one label: the plan genuinely cannot tell which of the
 * concurrently running commands wrote the path, and printing one of them would
 * be the false accusation this whole path exists to avoid. The blocking
 * decision is NOT weakened to compensate — an unattributable dirty tree fails
 * exactly as an attributable one does.
 */
export function formatConcurrentWorktreePollutionDetails(
  pollution: ConcurrentWorktreePollution,
  projectRoot?: string,
  storyId?: string,
): string[] {
  if (pollution.statusLines.length === 0) return [];
  const candidates = pollution.candidates.join(', ');
  const { lines, blocking } = evaluateWorktreePollution(pollution.statusLines, {
    allowed: `✓ validation commands produced policy-allowed dirty paths during overlapping windows (not attributable to one command): ${candidates}`,
    blocked: `✗ validation commands dirtied worktree during overlapping windows (not attributable to one command): ${candidates}`,
  }, projectRoot, storyId);
  pollution.blocking = blocking;
  return [
    ...lines,
    ...pollution.attributions.map(
      (attribution) => `  ${attribution.path}: appeared during the windows of ${attribution.candidates.join(', ')}`,
    ),
    '  attribution is the SET above, not any one of them: these commands ran concurrently, so the repo-wide before/after status probe cannot tell which one wrote the path. Re-run with LATTICE_VALIDATE_JOBS=1 to attribute it exactly.',
  ];
}

/** One command's raw before/after observation, as `executeValidationPlan` collected it. */
export interface WorktreePollutionObservation {
  /** Stable command identity used in reports: `<1-based plan index>:<label>`. */
  candidate: string;
  /** The rows this command's OWN before/after snapshot pair saw appear. */
  statusLines: readonly string[];
}

export interface WorktreePollutionAttributionResult {
  /** Per observation (same index and order as the input): rows ONLY that observation saw. */
  exclusive: string[][];
  /** Rows more than one observation saw, or null when every row was exclusive. */
  concurrent: ConcurrentWorktreePollution | null;
}

/**
 * B-7dff F-003: split raw per-command pollution observations into the part that
 * is soundly attributable and the part that is not.
 *
 * A path's appearance is inside a command's observation window iff that command
 * saw it as NEW (present in its after-snapshot, absent from its before-snapshot).
 * So:
 *
 *  - Exactly ONE window contains it → only that command can have written it
 *    (any other command either finished before it appeared, or started after
 *    and therefore already had it in its own before-snapshot). Exact
 *    attribution, which is what every solo-scheduled command still gets — and
 *    every fail-closed barrier is solo-scheduled by construction.
 *  - SEVERAL windows contain it → any of them could have written it and the
 *    repo-wide probe carries no evidence choosing between them. Reported
 *    against the whole set; never pinned on one member, never dropped.
 *
 * Pure and order-deterministic (candidates come out in plan order), so the
 * scheduler's nondeterministic completion order cannot change the report.
 */
export function attributeWorktreePollution(
  observations: readonly WorktreePollutionObservation[],
): WorktreePollutionAttributionResult {
  const observed = new Map<string, { statusLine: string; observers: number[] }>();
  observations.forEach((observation, index) => {
    for (const statusLine of observation.statusLines) {
      const path = statusPath(statusLine);
      const entry = observed.get(path);
      if (!entry) {
        observed.set(path, { statusLine, observers: [index] });
      } else if (!entry.observers.includes(index)) {
        entry.observers.push(index);
      }
    }
  });

  const exclusive: string[][] = observations.map(() => []);
  const attributions: ConcurrentWorktreePollutionAttribution[] = [];
  for (const [path, entry] of observed) {
    if (entry.observers.length === 1) {
      exclusive[entry.observers[0]!]!.push(entry.statusLine);
      continue;
    }
    attributions.push({
      path,
      statusLine: entry.statusLine,
      candidates: entry.observers.map((observer) => observations[observer]!.candidate),
    });
  }
  if (attributions.length === 0) return { exclusive, concurrent: null };

  const candidates: string[] = [];
  for (const attribution of attributions) {
    for (const candidate of attribution.candidates) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return {
    exclusive,
    concurrent: {
      statusLines: attributions.map((attribution) => attribution.statusLine),
      paths: attributions.map((attribution) => attribution.path),
      candidates,
      attributions,
    },
  };
}

/**
 * Run a single validation command, enforcing a per-command wall-clock timeout.
 *
 * `defaultTimeoutMs` is a TEST SEAM: it overrides the module-default ceiling used when the
 * command carries no explicit `timeoutMs`, letting tests exercise the default-arming path
 * with a tiny value instead of waiting the full default. No production caller passes it —
 * {@link executeValidationPlan} and the direct handler callers (the legacy validate.ts and
 * external-command paths in verifier.ts) all omit the argument, so production always resolves
 * to DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS. There is deliberately no plan-level injection to
 * expose: every production command either carries its own `timeoutMs` or wants the real default.
 */
export function runValidationCommand(
  command: ValidationCommand,
  projectRoot: string,
  defaultTimeoutMs: number = DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
  options: RunValidationCommandOptions = {},
): Promise<ValidationCommandResult> {
  const cwd = commandCwd(projectRoot, command.cwd);
  const started = Date.now();
  const configuredTimeoutMs = resolveCommandTimeoutMs(command, defaultTimeoutMs);
  const deadlineRemainingMs = typeof options.deadlineAt === 'number' && Number.isFinite(options.deadlineAt)
    ? Math.max(1, Math.floor(options.deadlineAt - Date.now()))
    : undefined;
  const timeoutMs = deadlineRemainingMs === undefined
    ? configuredTimeoutMs
    : Math.min(configuredTimeoutMs, deadlineRemainingMs);
  const commandIndex = options.commandIndex ?? 1;
  const totalCommands = options.totalCommands ?? 1;
  const heartbeatMs = options.heartbeatMs ?? resolveValidateHeartbeatMs();
  // B-75f0 CHK-002: no storyId in scope here (runValidationCommand takes only
  // projectRoot), so resolve the dirty-status probe cwd with the id-independent
  // project-level resolver — config loaded so a configured gitRoot subdir on a
  // wrapper-root layout is honored. Plain repos / unresolved → projectRoot
  // verbatim (byte-identical).
  let statusGitCwd: string;
  try {
    statusGitCwd = resolveProjectGitCwd(projectRoot, projectRoot, loadConfig(projectRoot));
  } catch {
    statusGitCwd = projectRoot;
  }
  const statusBefore = readGitStatus(statusGitCwd);

  return new Promise((resolveResult) => {
    const isWindows = process.platform === 'win32';
    let output = '';
    let timedOut = false;
    let runnerFailure = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;

    const finish = (rawCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      options.abortSignal?.removeEventListener('abort', abortCommand);
      // A timed-out command is ALWAYS attributed exit 124, regardless of the child's own
      // reported code. On POSIX a SIGTERM/SIGKILL gives code=null; on Windows
      // TerminateProcess gives a numeric code (≠ null), and a child that traps SIGTERM
      // could even exit 0 — without this normalization those would mis-report as not-124
      // even though `timedOut` is set.
      const code = timedOut ? 124 : (rawCode ?? 1);
      const failureKind = commandFailureKind({ code, timedOut, runnerFailure });
      const statusAfter = readGitStatus(statusGitCwd);
      const pollutionStatusLines = detectNewDirtyStatus(statusBefore, statusAfter);
      const result: ValidationCommandResult = {
        label: command.label,
        command: command.command,
        args: command.args,
        ...(command.shell || isWindows ? { shell: true } : {}),
        ...(command.cwd ? { cwd } : {}),
        code,
        output: trimOutput(stripAnsi(output)),
        ...(command.optional ? { optional: true } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        timeoutMs,
        ...(failureKind ? { failureKind } : {}),
        durationMs: Date.now() - started,
        ...(pollutionStatusLines.length > 0
          ? {
              worktreePollution: {
                statusLines: pollutionStatusLines,
                paths: pollutionStatusLines.map(statusPath),
              },
            }
          : {}),
      };
      emitValidationProgress(options.progress, validationProgressEvent('command_end', command, {
        commandIndex,
        totalCommands,
        timeoutMs,
        started,
        cwd,
        code,
        timedOut,
      }));
      resolveResult(result);
    };

    const child = spawn(command.command, command.args, {
      cwd,
      env: effectiveValidationCommandEnvironment(process.env, command.env, cwd),
      shell: command.shell || isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: give the child its own process group (it becomes group leader) so the
      // timeout can signal the WHOLE tree. Wrapper commands (npm, `/bin/sh -c …`) spawn
      // grandchildren that survive a direct child.kill() and keep the stdout/stderr pipe
      // open — which delays, or with an infinite grandchild prevents, the 'close' event,
      // re-introducing the exact hang this guards against. Not unref'd: we still await it.
      ...(isWindows ? {} : { detached: true }),
    });

    emitValidationProgress(options.progress, validationProgressEvent('command_start', command, {
      commandIndex,
      totalCommands,
      timeoutMs,
      started,
      cwd,
    }));
    heartbeatTimer = setInterval(() => {
      emitValidationProgress(options.progress, validationProgressEvent('heartbeat', command, {
        commandIndex,
        totalCommands,
        timeoutMs,
        started,
        cwd,
      }));
    }, heartbeatMs);
    heartbeatTimer.unref?.();

    // Signal the child's whole process group (POSIX) / process tree (Windows). Best-effort:
    // a race with natural exit (ESRCH) or a missing pid degrades to a direct child.kill().
    const killTree = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (isWindows) {
          // Windows has no process groups/POSIX signals; force-kill the whole tree.
          // Attach an 'error' handler: a missing/unlaunchable taskkill emits an async
          // 'error' on the returned child, which would otherwise be an unhandled exception
          // that crashes the process. Fall back to a direct child.kill() in that case.
          spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
            .on('error', () => { try { child.kill(signal); } catch { /* already gone */ } });
        } else {
          process.kill(-pid, signal); // negative pid → the child's process group
        }
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };

    const timeOutCommand = (escalationMs: number): void => {
      if (settled || timedOut) return;
      timedOut = true;
      emitValidationProgress(options.progress, validationProgressEvent('command_timeout', command, {
        commandIndex,
        totalCommands,
        timeoutMs,
        started,
        cwd,
        timedOut: true,
      }));
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), escalationMs);
      killTimer.unref?.();
    };

    const abortCommand = (): void => {
      timeOutCommand(50);
    };

    if (options.abortSignal?.aborted) {
      abortCommand();
    } else {
      options.abortSignal?.addEventListener('abort', abortCommand, { once: true });
    }

    // Always arm a per-command timeout: explicit timeoutMs, else the default ceiling. A
    // hung command is then killed (whole group) + attributed (exit 124) here, instead of
    // the global idle watchdog silently force-exiting the whole validate. unref() so a
    // stray timer never keeps the event loop alive on its own (the awaited child does).
    timer = setTimeout(() => {
      timeOutCommand(1000);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => finish(code));
    child.on('error', (e) => {
      runnerFailure = true;
      output += output ? `\n${e.message}` : e.message;
      finish(null);
    });
  });
}

/**
 * B-ec67: executables a pinned verification command may use. A pinned command is
 * executable+argv, NEVER a raw shell program — so we constrain the leading token to
 * this small allowlist of test/runtime launchers. This is the enforcement analogue
 * of the lattice-dispatch command-authorization boundary (dispatch's per-policy
 * `commandAllowlist` authorizes whole command STRINGS under an unattended policy and
 * needs a DispatchPolicy in scope; that surface is not reusable for a synchronous
 * evidence write, so the pinned-command path keeps its own focused executable
 * allowlist and never runs an arbitrary shell program).
 */
export const VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST: ReadonlySet<string> = new Set([
  'node',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'tsx',
  'bun',
]);

/**
 * B-ec67: tokenize a pinned command string into executable + argv WITHOUT a shell.
 * Supports single/double quotes and backslash escapes so a command like
 * `node -e "console.log('MARKER_OK')"` yields ['node','-e',"console.log('MARKER_OK')"].
 * Throws on an unterminated quote. No shell metacharacter interpretation happens.
 */
export function tokenizeCommandString(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === '\\' && i + 1 < command.length && (command[i + 1] === '"' || command[i + 1] === '\\')) current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === "'") { inSingle = true; hasToken = true; continue; }
    if (ch === '"') { inDouble = true; hasToken = true; continue; }
    if (ch === '\\' && i + 1 < command.length) { current += command[++i]; hasToken = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasToken) { tokens.push(current); current = ''; hasToken = false; }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (inSingle || inDouble) throw new Error(`verification command has an unterminated quote: ${command}`);
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * B-ec67: parse + allowlist-check a pinned command string. Throws when empty or when
 * the leading executable is not in {@link VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST}.
 */
export function parseAllowlistedCommand(command: string): { executable: string; args: string[] } {
  const tokens = tokenizeCommandString(command);
  if (tokens.length === 0) throw new Error('verification command is empty');
  const [executable, ...args] = tokens;
  if (!VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST.has(executable)) {
    throw new Error(
      `verification command executable "${executable}" is not allowlisted ` +
      `(allowed: ${[...VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST].join(', ')}); ` +
      'a pinned verification command must be executable+argv, never a raw shell program [verification_command_not_allowlisted]',
    );
  }
  return { executable, args };
}

export interface SingleCommandExecutionResult {
  executable: string;
  args: string[];
  code: number;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * B-ec67: run ONE allowlisted pinned command via the shared {@link runValidationCommand}
 * spawn path (per-command timeout, output capture, no shell on POSIX). Used by the
 * evidence-write handler to derive a tool-owned receipt from the actual exit + output.
 */
export async function runSingleAllowlistedCommand(
  command: string,
  projectRoot: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<SingleCommandExecutionResult> {
  const { executable, args } = parseAllowlistedCommand(command);
  const validationCommand: ValidationCommand = {
    label: 'verification-evidence-command',
    command: executable,
    args,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
  };
  const result = await runValidationCommand(validationCommand, projectRoot);
  return {
    executable,
    args,
    code: result.code,
    output: result.output,
    timedOut: Boolean(result.timedOut),
    durationMs: result.durationMs,
  };
}

/**
 * The one synthetic resource every routine-validate plan entry claims.
 *
 * A command that DECLARED resources holds this key `shared`, so two declared
 * commands may overlap whenever their declared claims are disjoint. A command
 * that declared NOTHING holds it `exclusive`, so it conflicts with every other
 * entry in the plan — declared or not — and is therefore scheduled alone.
 *
 * The default is exclusive on purpose. Routine validate commands write under
 * `.lattice/`, rebuild `packages/main/dist`, take repository build/runtime
 * locks and drive git; an unclassified command that silently ran concurrently
 * would corrupt exactly the evidence validate exists to produce. Defaulting to
 * shared would assume the disjointness nobody has proven yet, and a declaration
 * is precisely the record of that proof. Under-declaring only costs latency.
 */
export const VALIDATE_PLAN_BARRIER_CLAIM_CLASS = 'fixed-path' as const;
export const VALIDATE_PLAN_BARRIER_CLAIM_KEY = '.lattice/runtime/validate-plan-barrier';

/** One plan command as the keyed scheduler sees it. */
export interface ValidationScheduleEntry extends SchedulableEntry {
  /** Unique per plan (the plan index is part of it: labels may repeat). */
  name: string;
  resources: ResourceClaim[];
  command: ValidationCommand;
  /** 1-based position in the plan, so results can be restored to plan order. */
  commandIndex: number;
  /** True when the command declared nothing and got the fail-closed exclusive default. */
  exclusiveByDefault: boolean;
}

/** One command's resolved claims plus whether the fail-closed default produced them. */
export interface ResolvedValidationCommandResources {
  claims: ResourceClaim[];
  /**
   * True when the command declared nothing and therefore holds the barrier
   * EXCLUSIVELY. This is the resolver's own verdict, returned rather than left
   * to be re-derived from the raw `resources` field: B-7dff F-005 — the rule is
   * this story's load-bearing safety invariant, and two independent copies of
   * it (`exclusiveByDefault` said one thing, the scheduler enforced another)
   * would diverge silently the first time the rule changes.
   */
  exclusiveByDefault: boolean;
}

/**
 * Resolve one command's effective claims, and report whether the fail-closed
 * default was applied. THE one place that decides "this command declared
 * nothing" — every other reader takes the answer from here.
 *
 * - Declared: `[barrier(shared), ...declared]`, `exclusiveByDefault: false`.
 * - Undeclared or empty: `[barrier(exclusive)]`, `exclusiveByDefault: true` — a
 *   single exclusive claim on the synthetic key, which is what makes an
 *   unclassified command run alone.
 *
 * An unrecognised class / access / ownership is REFUSED here, at declaration
 * time, rather than being dropped (which would silently leave the command in
 * some other key's admission set). Any `canonicalKey` arriving from a caller or
 * from config is discarded: canonicalization is the scheduler's job
 * (`canonicalizeEntries`), and accepting a pre-set one would let untrusted
 * input choose which entries it conflicts with.
 */
export function resolveValidationCommandResourceClaims(
  command: ValidationCommand,
  owner: string,
): ResolvedValidationCommandResources {
  const declared = command.resources;
  if (declared !== undefined && !Array.isArray(declared)) {
    throw new Error(`validate command ${owner} declared a non-array resources field`);
  }
  const claims: ResourceClaim[] = (declared ?? []).map((claim) => {
    if (!claim || typeof claim !== 'object') throw new Error(`validate command ${owner} declared a non-object resource claim`);
    return {
      class: claim.class,
      key: claim.key,
      access: claim.access,
      ...(claim.ownership ? { ownership: claim.ownership } : {}),
    };
  });
  validateResourceClaims(claims, owner);
  if (claims.length === 0) {
    return {
      claims: [{ class: VALIDATE_PLAN_BARRIER_CLAIM_CLASS, key: VALIDATE_PLAN_BARRIER_CLAIM_KEY, access: 'exclusive' }],
      exclusiveByDefault: true,
    };
  }
  return {
    claims: [{ class: VALIDATE_PLAN_BARRIER_CLAIM_CLASS, key: VALIDATE_PLAN_BARRIER_CLAIM_KEY, access: 'shared' }, ...claims],
    exclusiveByDefault: false,
  };
}

/**
 * The claims alone, for callers that only need the admission set.
 * {@link resolveValidationCommandResourceClaims} stays the single decision point.
 */
export function resolveValidationCommandResources(command: ValidationCommand, owner: string): ResourceClaim[] {
  return resolveValidationCommandResourceClaims(command, owner).claims;
}

/**
 * Resolve a whole plan into scheduler entries, in plan order. The claims are
 * NOT canonicalized here (that needs a project root and touches the filesystem
 * and git); the scheduler's `canonicalizeEntries` does it and refuses to run
 * any entry whose claims were never canonicalized.
 */
export function resolveValidationPlanEntries(plan: ValidationPlan): ValidationScheduleEntry[] {
  return plan.commands.map((command, index) => {
    // The index keeps names unique: two plan commands may share a label.
    const name = `${index}:${command.label}`;
    // B-7dff F-005: exclusiveByDefault comes from the resolver that actually
    // applied the default, never re-derived from command.resources here.
    const { claims, exclusiveByDefault } = resolveValidationCommandResourceClaims(command, name);
    return {
      name,
      resources: claims,
      command,
      commandIndex: index + 1,
      exclusiveByDefault,
    };
  });
}

/** One plan command's terminal record as the keyed scheduler sees it. */
interface ValidationScheduleResult extends SchedulableResult {
  name: string;
  status: ScheduledStatus;
  /** 1-based plan position, so the caller can restore plan order. */
  commandIndex: number;
}

/** The scheduler's coarse verdict for one command. Reported, never acted on: the routine
 * plan runs under `run-all`, so no status here can cancel another command. */
function scheduledStatusForCommand(result: ValidationCommandResult): ScheduledStatus {
  if (result.timedOut) return 'TIMEOUT';
  return result.code === 0 ? 'PASS' : 'FAIL';
}

export async function executeValidationPlan(
  plan: ValidationPlan,
  projectRoot: string,
  headSha?: string,
  storyId?: string,
  options: ExecuteValidationPlanOptions = {},
): Promise<ValidationResult> {
  const commands: ValidationCommandResult[] = [];
  const details: string[] = [];
  const warnings = [...(plan.warnings ?? [])];
  const focus = plan.focus?.trim();
  if (focus) {
    details.push(`FOCUSED VALIDATE MODE focus=${focus}: not final full validation and not DONE-required proof.`);
  }

  const totalCommands = plan.commands.length;
  const jobs = resolveValidatePlanJobs(process.env, options.jobs);
  // Canonicalization is what makes the claims comparable (and it REFUSES an
  // undeclarable one), so it happens before anything is launched. Every entry
  // keeps its plan position in `commandIndex`.
  const entries = canonicalizeEntries(resolveValidationPlanEntries(plan), projectRoot);
  const exclusiveCount = entries.filter((entry) => entry.exclusiveByDefault).length;

  // Completion order is not plan order, so results are parked by plan index and
  // read back in plan order below. `details` is assembled there too: pushing it
  // from inside a concurrent command would interleave one command's output into
  // another's, and formatWorktreePollutionDetails also appends dirty-gate audit
  // lines to process-events.jsonl, which stays single-writer this way.
  const executed: (ValidationCommandResult | null)[] = new Array(totalCommands).fill(null);
  // Latched by whichever command first observes the plan deadline blown. The
  // sequential implementation threw at exactly that point and never started a
  // later command; entries still pending here are skipped for the same reason
  // (their timeout would already be clamped to ~0 by the passed deadline, so
  // launching them only spawns processes whose results this function is about
  // to discard by throwing).
  let deadlineExceeded = false;

  await runScheduled<ValidationScheduleEntry, ValidationScheduleResult>(entries, jobs, async (entry) => {
    if (deadlineExceeded) return { name: entry.name, status: 'INTERRUPTED', commandIndex: entry.commandIndex };
    const result = await runValidationCommand(entry.command, projectRoot, DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS, {
      progress: options.progress,
      heartbeatMs: options.heartbeatMs,
      commandIndex: entry.commandIndex,
      totalCommands,
      abortSignal: options.abortSignal,
      deadlineAt: options.deadlineAt,
      deadlineError: options.deadlineError,
    });
    if (
      result.timedOut
      && typeof options.deadlineAt === 'number'
      && Date.now() >= options.deadlineAt
    ) {
      deadlineExceeded = true;
    }
    executed[entry.commandIndex - 1] = result;
    return { name: entry.name, status: scheduledStatusForCommand(result), commandIndex: entry.commandIndex };
  }, {
    // run-all: a failing command must never cancel the others. Every gate and
    // receipt downstream reads commands[] as a COMPLETE record of the plan
    // (commandExecution.complete compares its length against the plan length),
    // so a short array would read as an infrastructure failure, not as the one
    // real command failure it is.
    cancellation: 'run-all',
  });

  if (deadlineExceeded) {
    throw options.deadlineError?.() ?? new Error(`validation plan deadline exceeded at ${options.deadlineAt}`);
  }

  // B-7dff F-003: each command's dirty-status observation is repo-wide, so
  // under concurrency it reports "what appeared during my window", not "what I
  // wrote". Cross-check the whole set of observations BEFORE any of it is
  // reported or gate-consumed: a row only one window saw stays that command's
  // (exact attribution — which every solo-scheduled command, including every
  // fail-closed barrier, still gets), and a row several windows saw is moved to
  // a set-attributed plan-level record instead of being pinned on whichever
  // innocent command happened to straddle the write. Nothing is discarded: the
  // set-level record goes through the same dirty-gate-policy evaluation and
  // blocks exactly as a per-command one would.
  const attribution = attributeWorktreePollution(plan.commands.map((command, index) => ({
    candidate: `${index + 1}:${command.label}`,
    statusLines: executed[index]?.worktreePollution?.statusLines ?? [],
  })));
  executed.forEach((result, index) => {
    if (!result) return;
    const exclusiveLines = attribution.exclusive[index] ?? [];
    if (exclusiveLines.length === 0) {
      delete result.worktreePollution;
      return;
    }
    result.worktreePollution = {
      statusLines: exclusiveLines,
      paths: exclusiveLines.map(statusPath),
      attribution: 'exclusive',
    };
  });
  const concurrentPollution = attribution.concurrent;

  for (let i = 0; i < totalCommands; i++) {
    const command = plan.commands[i];
    const result = executed[i];
    // Unreachable under run-all (every entry produces a terminal result and the
    // deadline path threw above). Fail closed rather than emit a commands[]
    // shorter than the plan, which downstream would read as a passing run of a
    // smaller plan.
    if (!result) {
      throw new Error(`validation plan produced no result for command ${i + 1}/${totalCommands} (${command.label})`);
    }
    commands.push(result);

    const failed = result.code !== 0 || Boolean(result.timedOut);
    const mark = failed ? (result.optional ? '⚠' : '✗') : '✓';
    const suffix = result.timedOut ? ' (timed out)' : '';
    details.push(`${mark} ${result.label}: ${formatValidationCommand(command)}${suffix}`.trim());
    if (result.timedOut) {
      details.push(...formatTimeoutDiagnostics(command, result, i + 1, totalCommands));
    }
    if (result.output.trim()) {
      details.push(...result.output.trim().split('\n').filter(Boolean).map((line) => `  ${line}`));
    }
    details.push(...formatWorktreePollutionDetails(result, projectRoot, storyId));
    if (failed && result.optional) {
      warnings.push(`optional validation failed: ${result.label}`);
    }
  }
  // Before the scheduler line, which callers read as the last line of details.
  if (concurrentPollution) {
    details.push(...formatConcurrentWorktreePollutionDetails(concurrentPollution, projectRoot, storyId));
  }
  // Appended, never prepended: details[0] is the first command line (or the
  // focus banner) and callers read it as the headline.
  details.push(
    `validate scheduler: jobs=${jobs} commands=${totalCommands} `
    + `declared=${totalCommands - exclusiveCount} exclusiveByDefault=${exclusiveCount}`,
  );

  const requiredFailures = commands.filter((r) => !r.optional && (r.code !== 0 || r.timedOut));
  const optionalFailures = commands.filter((r) => r.optional && (r.code !== 0 || r.timedOut));
  const requiredInfraFailures = requiredFailures.filter((r) => r.failureKind === 'infra_failure');
  // Task B-4b22: pollution only counts as failure if dirty-gate-policy
  // marked it blocking. Passing-only category pollution (lattice_metadata /
  // runtime_artifact / declared_artifact) is allowed and audited.
  const pollutionFailures = commands.filter((r) => {
    if (!r.worktreePollution || r.worktreePollution.statusLines.length === 0) return false;
    // blocking undefined → legacy back-compat: treat as blocking.
    return r.worktreePollution.blocking !== false;
  });
  // B-7dff F-003: pollution nobody can be blamed for individually still blocks.
  // Losing the detection would be a strictly worse bug than mis-attributing it,
  // so the ambiguity is reported honestly and gated identically.
  const concurrentPollutionBlocking = Boolean(concurrentPollution)
    && concurrentPollution!.statusLines.length > 0
    && concurrentPollution!.blocking !== false;
  const anyPollutionFailure = pollutionFailures.length > 0 || concurrentPollutionBlocking;
  const allPass = requiredFailures.length === 0 && !anyPollutionFailure;
  const status = allPass ? (optionalFailures.length > 0 || warnings.length > 0 ? 'warn' : 'pass') : 'fail';
  const failureKind: ValidationFailureKind | undefined = allPass
    ? undefined
    : requiredInfraFailures.length > 0
      ? 'infra_failure'
      : 'validation_failure';
  const baseSummary = allPass
    ? optionalFailures.length > 0
      ? 'Required validation commands passed with optional failures'
      : 'Project validation commands passed'
    : anyPollutionFailure && requiredFailures.length === 0
      ? 'Project validation commands dirtied the worktree'
    : 'Project validation commands failed';

  return {
    provider: focus ? `${plan.provider}-focused` : plan.provider,
    status,
    allPass,
    ...(failureKind ? { failureKind } : {}),
    summary: focus
      ? `Focused validation (${focus}): ${baseSummary}; not final full validation or DONE-required proof`
      : baseSummary,
    details,
    warnings,
    timestamp: new Date().toISOString(),
    ...(headSha ? { headSha } : {}),
    commands,
    ...(concurrentPollution ? { concurrentWorktreePollution: concurrentPollution } : {}),
    ...(focus ? { focus: { name: focus, mode: 'focused' as const, finalFullValidation: false as const, doneRequiredProof: false as const } } : {}),
  };
}
