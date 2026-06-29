import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { changedFilesBetween, checkEvidenceFreshnessForGit, currentGitHead } from './evidence-freshness.js';
import {
  checkDispatchPolicy,
  type DispatchPolicy,
  type DispatchPolicyCheckResult,
} from './dispatch-policy.js';
import { LATTICE_DIR } from './lattice-paths.js';
import {
  buildHandoffWorktreeProjection,
  createHandoffPack,
  submitHandoffReceipt,
  type HandoffPack,
  type HandoffReceipt,
  type HandoffReceiptSubmission,
} from './lattice-handoff.js';
import {
  buildClaudeCodeRealRunnerRecord,
  buildFakeRunnerRecord,
  buildRefusedRunnerRecord,
  buildScaffoldedRunnerRecord,
  type DispatchRunnerRecord,
} from './dispatch-runner.js';
import type { StoryStore } from './store.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';
import { getSessionId } from './owner-session.js';
// B-ceed: codex + legacy gemini live-dispatch — bounded provider seams (real spawn).
import { codexCliAvailable, runBoundedCodexProvider } from '../providers/codex-cli.js';
import { geminiCliAvailable, runBoundedGeminiProvider } from '../providers/gemini-cli.js';
// THIN ONE-WAY SEAM: dispatch imports the usage ledger only through this single
// in-module orchestrator. dispatch-usage.ts keeps zero cross-module imports, so
// the dependency is strictly one-way (dispatch -> usage-ledger, never back).
import {
  isUsageLedgerEnabled,
  parseClaudeCliOutput,
  recordBudgetBlock,
  recordDispatchFinal,
  recordDispatchFinalForProvider,
  recordDispatchPreflight,
  type DispatchUsageContext,
} from './usage-ledger/dispatch-usage.js';

export type HostRuntimeId = 'fake' | 'codex' | 'claude-code' | 'antigravity' | 'gemini';
export type HostRuntimeStatus = 'ready' | 'scaffolded' | 'unavailable';
export type DispatchLifecycleStatus =
  | 'planned'
  | 'prepared'
  | 'running'
  | 'needs_receipt'
  | 'accepted_local'
  | 'diagnostic'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'unavailable';

export interface DispatchAuthorityState {
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export type VersionStatus = 'detected' | 'unavailable' | 'unknown';
export type NoninteractiveSupport = 'supported' | 'unverified' | 'unsupported';
export type CwdSupport = 'supported' | 'unverified';
export type TimeoutSupport = 'supported' | 'unverified';
export type TranscriptSupport = 'supported' | 'unverified';
export type EnvSafetyPosture = 'sandboxed' | 'inherited' | 'unverified';
export type LoginReadiness = 'ready' | 'requires-login' | 'unknown';
export type ReceiptSupport = 'structured' | 'transcript-capture' | 'unverified';

const CLAUDE_PRINT_LAUNCHER = 'claude --print <prompt-file>';

export interface HostRuntimeProbe {
  schemaVersion: 'lattice.host_runtime_probe.v1';
  host: HostRuntimeId;
  requestedHost: string;
  status: HostRuntimeStatus;
  available: boolean;
  supportsParallel: boolean;
  matchedFallback: boolean;
  runtimeKind: 'fake' | 'scaffolded' | 'missing-cli';
  cliCommand?: string;
  commandPath?: string;
  invocationTemplate?: string[];
  // Unattended capability contract (CHK-002 / CHK-004)
  versionStatus: VersionStatus;
  version?: string;
  loginReadiness: LoginReadiness;
  noninteractiveSupport: NoninteractiveSupport;
  cwdSupport: CwdSupport;
  timeoutSupport: TimeoutSupport;
  transcriptSupport: TranscriptSupport;
  envSafetyPosture: EnvSafetyPosture;
  receiptSupport: ReceiptSupport;
  unattendedSafe: boolean;
  unattendedReasons: string[];
  degradations: string[];
  limitations: string[];
  warnings: string[];
  nextAction: string;
  authority: DispatchAuthorityState;
}

export interface HostRuntimeList {
  schemaVersion: 'lattice.host_runtime_list.v1';
  runtimes: HostRuntimeProbe[];
  authority: DispatchAuthorityState;
}

export interface DispatchPackPreview {
  packId: string;
  packHash: string;
  baseSha?: string;
  fromHost: string;
  toHost: string;
  allowedPaths: string[];
  deniedPaths: string[];
  requiredCommands: string[];
  successCriteria: string[];
  authorityBoundarySummary: string;
}

export interface DispatchPlanResult {
  schemaVersion: 'lattice.dispatch_plan.v1';
  storyId: string;
  requestedHost: string;
  selectedHost: HostRuntimeId;
  status: 'planned' | 'unavailable';
  parallel: number;
  runtime: HostRuntimeProbe;
  fallbackHosts: Array<{
    host: HostRuntimeId;
    status: HostRuntimeStatus;
    reason: string;
  }>;
  pack: DispatchPackPreview;
  worktree: {
    branch: string;
    worktreePath: string;
    reviewCommand: string;
    cleanupCommand: string;
  };
  risks: string[];
  warnings: string[];
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchRecord {
  schemaVersion: 'lattice.dispatch_record.v1';
  dispatchId: string;
  storyId: string;
  requestedHost: string;
  selectedHost: HostRuntimeId;
  status: DispatchLifecycleStatus;
  parallel: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  runtime: HostRuntimeProbe;
  warnings: string[];
  nextAction: string;
  packFile: string;
  statusFile: string;
  promptFile: string;
  transcriptFile: string;
  collectFile: string;
  receiptFile: string;
  receiptSubmissionFile: string;
  worktree: {
    branch: string;
    worktreePath: string;
    reviewCommand: string;
    cleanupCommand: string;
  };
  workerIds: string[];
  parentDispatchId?: string;
  latestHeadSha?: string;
  cancelledAt?: string;
  runnerFile?: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchCollection {
  schemaVersion: 'lattice.dispatch_collect.v1';
  dispatchId: string;
  storyId: string;
  host: HostRuntimeId;
  status: DispatchLifecycleStatus;
  baseSha?: string;
  headSha?: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  changedFiles: string[];
  commands: string[];
  transcriptExists: boolean;
  warnings: string[];
  limitations: string[];
  workers: DispatchCollection[];
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchReceiptDraft {
  schemaVersion: 'lattice.dispatch_receipt_create.v1';
  dispatchId: string;
  status: 'created' | 'diagnostic';
  receipt: HandoffReceipt;
  warnings: string[];
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchRunResult {
  schemaVersion: 'lattice.dispatch_run.v1';
  dispatchId: string;
  storyId: string;
  host: HostRuntimeId;
  status: DispatchLifecycleStatus;
  parallel: number;
  runtime: HostRuntimeProbe;
  workers: DispatchRunResult[];
  receipt?: HandoffReceiptSubmission;
  warnings: string[];
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchStatusResult {
  schemaVersion: 'lattice.dispatch_status.v1';
  dispatch: DispatchRecord;
  receipt?: HandoffReceiptSubmission;
  runner?: DispatchRunnerRecord;
  workers: DispatchStatusResult[];
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export type { DispatchRunnerRecord };

export interface DispatchListResult {
  schemaVersion: 'lattice.dispatch_list.v1';
  dispatches: Array<{
    dispatchId: string;
    storyId: string;
    host: HostRuntimeId;
    status: DispatchLifecycleStatus;
    parallel: number;
    updatedAt: string;
  }>;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchReviewRunnerSummary {
  runnerKind: string;
  cwd: string;
  transcriptPath: string;
  exitCode?: number;
  timedOut: boolean;
  commandTemplate: string[];
}

export interface DispatchReviewResult {
  schemaVersion: 'lattice.dispatch_review.v1';
  dispatchId: string;
  storyId: string;
  status: DispatchLifecycleStatus;
  changedFiles: string[];
  commands: string[];
  transcriptPath: string;
  transcriptExists: boolean;
  runnerSummary?: DispatchReviewRunnerSummary;
  localReceiptStatus: 'accepted-local' | 'diagnostic' | 'missing';
  receipt?: HandoffReceiptSubmission;
  workers: DispatchReviewResult[];
  warnings: string[];
  risks: string[];
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchMergePlanResult {
  schemaVersion: 'lattice.dispatch_merge_plan.v1';
  dispatchId: string;
  storyId: string;
  status: DispatchLifecycleStatus;
  mergeable: boolean;
  manualOnly: true;
  workers: Array<{
    dispatchId: string;
    status: DispatchLifecycleStatus;
    reviewCommand: string;
    cleanupCommand: string;
  }>;
  commands: string[];
  warnings: string[];
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchAutoResult {
  schemaVersion: 'lattice.dispatch_auto.v1';
  dispatchId: string;
  storyId: string;
  host: HostRuntimeId;
  status: DispatchLifecycleStatus;
  parallel: number;
  policy: string;
  workers: DispatchAutoResult[];
  warnings: string[];
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchWatchWorkerSummary {
  dispatchId: string;
  status: DispatchLifecycleStatus;
  runnerKind?: string;
}

export interface DispatchWatchResult {
  schemaVersion: 'lattice.dispatch_watch.v1';
  dispatchId: string;
  storyId: string;
  status: DispatchLifecycleStatus;
  workers: DispatchWatchWorkerSummary[];
  runnerSummary?: {
    runnerKind: string;
    cwd: string;
    exitCode?: number;
    timedOut: boolean;
    transcriptPath: string;
  };
  changedFilesCount?: number;
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

type DispatchPlanArgs = {
  storyId: string;
  host?: string;
  fromHost?: string;
  role?: string;
  objective?: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
  requiredCommands?: string[];
  successCriteria?: string[];
  baseSha?: string;
  packId?: string;
  authorityBoundary?: string;
  executionInstructions?: string[];
  parallel?: number;
};

type DispatchPrepareArgs = DispatchPlanArgs & {
  dispatchId?: string;
};

type DispatchRunArgs = DispatchPrepareArgs & {
  dispatchId?: string;
  executionPolicy?: DispatchCommandExecutionPolicy;
  allowRealHostSubprocess?: boolean;
};

type DispatchCommandExecutionPolicy = {
  envAllowlist: string[];
  envDenylist: string[];
  commandAllowlist: string[];
  maxRuntimeMs: number;
};

type RequiredCommandResult = {
  command: string;
  ok: boolean;
  output: string;
  timedOut?: boolean;
};

const TERMINAL_DISPATCH_STATUSES = new Set<DispatchLifecycleStatus>([
  'accepted_local',
  'diagnostic',
  'failed',
  'cancelled',
  'expired',
  'unavailable',
]);

export const CURRENT_HOST_RUNTIME_IDS = ['codex', 'claude-code', 'antigravity'] as const;
export const HOST_RUNTIME_BASELINE = {
  current: CURRENT_HOST_RUNTIME_IDS,
  aliases: { agy: 'antigravity', claude: 'claude-code' },
  legacyDeprecated: ['gemini'],
} as const;
const CURRENT_HOST_RUNTIME_DESCRIPTION = 'fake|codex|claude-code|antigravity';
const LEGACY_HOST_RUNTIME_DESCRIPTION = 'agy aliases to antigravity; gemini is accepted only for legacy compatibility';
const HOST_RUNTIME_ORDER: HostRuntimeId[] = ['codex', 'claude-code', 'antigravity', 'fake'];
const REAL_HOST_CLI: Record<Exclude<HostRuntimeId, 'fake'>, string> = {
  codex: 'codex',
  'claude-code': 'claude',
  antigravity: 'agy',
  gemini: 'gemini',
};

function authorityState(): DispatchAuthorityState {
  return {
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function plusHoursIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function normalizeHostRuntimeId(host: string | undefined): HostRuntimeId | null {
  const value = (host ?? '').trim().toLowerCase();
  if (!value || value === 'auto') return null;
  if (value === 'claude' || value === 'claude-code') return 'claude-code';
  if (value === 'antigravity' || value === 'agy') return 'antigravity';
  if (value === 'gemini') return 'gemini';
  if (value === 'codex') return 'codex';
  if (value === 'fake') return 'fake';
  return null;
}

function detectCommandPath(command: string): string | null {
  try {
    const path = execFileSync('sh', ['-c', `command -v ${command}`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return path || null;
  } catch {
    return null;
  }
}

function currentCodexSessionAvailable(): boolean {
  return process.env.LATTICE_ACTIVITY_SOURCE === 'codex'
    || typeof process.env.CODEX_SESSION_ID === 'string'
    || typeof process.env.CODEX_HOME === 'string';
}

function runtimeTemplate(host: HostRuntimeId): string[] | undefined {
  if (host === 'fake') return ['fake-runtime', '--deterministic'];
  if (host === 'claude-code') return ['claude', '--print', '<prompt-file>'];
  if (host === 'antigravity') return ['agy', '--prompt-file', '<prompt-file>'];
  if (host === 'gemini') return ['gemini', '--prompt-file', '<prompt-file>'];
  return ['codex', 'exec', '--prompt-file', '<prompt-file>'];
}

interface RealHostCapabilities {
  versionStatus: VersionStatus;
  version?: string;
  loginReadiness: LoginReadiness;
  noninteractiveSupport: NoninteractiveSupport;
  cwdSupport: CwdSupport;
  timeoutSupport: TimeoutSupport;
  transcriptSupport: TranscriptSupport;
  envSafetyPosture: EnvSafetyPosture;
  receiptSupport: ReceiptSupport;
  unattendedSafe: boolean;
  unattendedReasons: string[];
  degradations: string[];
}

function probeClaudeCodeCapabilities(commandPath: string | null): RealHostCapabilities {
  const unattendedReasons: string[] = [];
  const degradations: string[] = [];

  // Version detection
  let versionStatus: VersionStatus = 'unavailable';
  let version: string | undefined;
  if (commandPath) {
    try {
      const versionOutput = execFileSync('claude', ['--version'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
      if (versionOutput) {
        versionStatus = 'detected';
        version = versionOutput;
      } else {
        versionStatus = 'unknown';
      }
    } catch {
      versionStatus = 'unknown';
    }
  }

  // Noninteractive support: check if --print / -p flag is present in help output
  let noninteractiveSupport: NoninteractiveSupport = 'unverified';
  if (commandPath) {
    try {
      let helpOutput = '';
      try {
        helpOutput = execFileSync('claude', ['--help'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        });
      } catch (err: any) {
        // Some CLI tools exit non-zero for --help; capture stderr output too
        helpOutput = String(err?.stdout || '') + String(err?.stderr || '');
      }
      if (/--print\b|-p\b/i.test(helpOutput)) {
        noninteractiveSupport = 'supported';
      } else if (helpOutput.length > 0) {
        noninteractiveSupport = 'unsupported';
        unattendedReasons.push('claude --help output does not document --print/-p noninteractive flag; unattended execution not confirmed.');
      } else {
        noninteractiveSupport = 'unverified';
        unattendedReasons.push('claude --help produced no output; noninteractive support cannot be verified.');
      }
    } catch {
      noninteractiveSupport = 'unverified';
      unattendedReasons.push('claude --help failed; noninteractive support cannot be verified.');
    }
  } else {
    unattendedReasons.push('claude CLI is not available; noninteractive execution is impossible.');
  }

  // cwd, timeout, transcript: standard subprocess behavior; supported when CLI is present
  const cwdSupport: CwdSupport = commandPath ? 'supported' : 'unverified';
  const timeoutSupport: TimeoutSupport = commandPath ? 'supported' : 'unverified';
  const transcriptSupport: TranscriptSupport = commandPath ? 'supported' : 'unverified';
  if (!commandPath) {
    degradations.push('cwd, timeout, and transcript support cannot be confirmed without a live CLI.');
  }

  // Environment safety: Claude Code inherits the invoker's environment
  const envSafetyPosture: EnvSafetyPosture = commandPath ? 'inherited' : 'unverified';
  if (commandPath) {
    degradations.push('claude-code inherits the invoker environment; sensitive env vars are visible to the subprocess unless filtered by Proofbound policy.');
  }

  // Login readiness: ANTHROPIC_API_KEY is a strong signal for non-interactive auth
  const loginReadiness: LoginReadiness = process.env.ANTHROPIC_API_KEY?.trim()
    ? 'ready'
    : (commandPath ? 'unknown' : 'unknown');

  // Receipt support: stdout/stderr captured as transcript; Proofbound builds receipt from transcript + git
  const receiptSupport: ReceiptSupport = commandPath ? 'transcript-capture' : 'unverified';

  if (!commandPath) {
    unattendedReasons.push('claude CLI is not available in PATH.');
  }
  if (noninteractiveSupport !== 'supported') {
    unattendedReasons.push('Noninteractive (--print/-p) support not confirmed; bounded unattended execution cannot be guaranteed.');
  }
  // Policy + dispatch_auto binding required before any unattended run may start
  unattendedReasons.push('Unattended execution requires a dispatch_policy_check authorization and dispatch_auto policy binding before starting.');

  return {
    versionStatus,
    ...(version !== undefined ? { version } : {}),
    loginReadiness,
    noninteractiveSupport,
    cwdSupport,
    timeoutSupport,
    transcriptSupport,
    envSafetyPosture,
    receiptSupport,
    unattendedSafe: false,
    unattendedReasons,
    degradations,
  };
}

function probeGeminiCapabilities(commandPath: string | null): RealHostCapabilities {
  const unattendedReasons: string[] = [];
  const degradations: string[] = [];

  const versionStatus: VersionStatus = commandPath ? 'unknown' : 'unavailable';
  const noninteractiveSupport: NoninteractiveSupport = 'unverified';
  if (commandPath) {
    degradations.push('gemini version/help probing is intentionally skipped by host_runtime_probe; provider CLIs can block or authenticate during help startup.');
    unattendedReasons.push('gemini noninteractive support is unverified by the safe probe; dispatch_auto must require policy binding and a bounded runner before launch.');
  } else {
    unattendedReasons.push('gemini CLI is not available; noninteractive execution is impossible.');
  }

  const cwdSupport: CwdSupport = commandPath ? 'supported' : 'unverified';
  const timeoutSupport: TimeoutSupport = commandPath ? 'supported' : 'unverified';
  const transcriptSupport: TranscriptSupport = commandPath ? 'supported' : 'unverified';
  if (!commandPath) {
    degradations.push('cwd, timeout, and transcript support cannot be confirmed without a live CLI.');
  }

  const envSafetyPosture: EnvSafetyPosture = commandPath ? 'inherited' : 'unverified';
  if (commandPath) {
    degradations.push('gemini inherits the invoker environment; sensitive env vars are visible to the subprocess unless filtered by Proofbound policy.');
  }

  // Login readiness: gemini typically requires gcloud auth or application default credentials
  const loginReadiness: LoginReadiness = 'unknown';
  const receiptSupport: ReceiptSupport = commandPath ? 'transcript-capture' : 'unverified';

  if (!commandPath) {
    unattendedReasons.push('gemini CLI is not available in PATH.');
  }
  unattendedReasons.push('Noninteractive mode is unverified for gemini; bounded unattended execution cannot be guaranteed by host_runtime_probe alone.');
  unattendedReasons.push('Unattended execution requires a dispatch_policy_check authorization and dispatch_auto policy binding before starting.');

  return {
    versionStatus,
    loginReadiness,
    noninteractiveSupport,
    cwdSupport,
    timeoutSupport,
    transcriptSupport,
    envSafetyPosture,
    receiptSupport,
    unattendedSafe: false,
    unattendedReasons,
    degradations,
  };
}

function probeAntigravityCapabilities(commandPath: string | null): RealHostCapabilities {
  const unattendedReasons: string[] = [];
  const degradations: string[] = [];

  const versionStatus: VersionStatus = commandPath ? 'unknown' : 'unavailable';
  const noninteractiveSupport: NoninteractiveSupport = 'unverified';
  if (commandPath) {
    degradations.push('agy version/help probing is intentionally skipped by host_runtime_probe; host CLIs can block or authenticate during help startup.');
    unattendedReasons.push('antigravity noninteractive support is unverified by the safe probe; dispatch_auto must require policy binding and a bounded runner before launch.');
  } else {
    unattendedReasons.push('agy CLI is not available; noninteractive execution is impossible.');
  }

  const cwdSupport: CwdSupport = commandPath ? 'supported' : 'unverified';
  const timeoutSupport: TimeoutSupport = commandPath ? 'supported' : 'unverified';
  const transcriptSupport: TranscriptSupport = commandPath ? 'supported' : 'unverified';
  if (!commandPath) {
    degradations.push('cwd, timeout, and transcript support cannot be confirmed without a live CLI.');
  }

  const envSafetyPosture: EnvSafetyPosture = commandPath ? 'inherited' : 'unverified';
  if (commandPath) {
    degradations.push('antigravity inherits the invoker environment; sensitive env vars are visible to the subprocess unless filtered by Proofbound policy.');
  }

  const loginReadiness: LoginReadiness = 'unknown';
  const receiptSupport: ReceiptSupport = commandPath ? 'transcript-capture' : 'unverified';

  if (!commandPath) {
    unattendedReasons.push('agy CLI is not available in PATH.');
  }
  unattendedReasons.push('Noninteractive mode is unverified for antigravity; bounded unattended execution cannot be guaranteed by host_runtime_probe alone.');
  unattendedReasons.push('Unattended execution requires a dispatch_policy_check authorization and dispatch_auto policy binding before starting.');

  return {
    versionStatus,
    loginReadiness,
    noninteractiveSupport,
    cwdSupport,
    timeoutSupport,
    transcriptSupport,
    envSafetyPosture,
    receiptSupport,
    unattendedSafe: false,
    unattendedReasons,
    degradations,
  };
}

function probeCodexCapabilities(commandPath: string | null, isCodexSession: boolean): RealHostCapabilities {
  const unattendedReasons: string[] = [];
  const degradations: string[] = [];

  if (isCodexSession) {
    // Running inside a Codex session: capabilities are available in-process
    degradations.push('Codex session inherits the invoker environment; sensitive env vars are visible unless filtered by Proofbound policy.');
    unattendedReasons.push('Unattended execution requires a dispatch_policy_check authorization and dispatch_auto policy binding before starting.');
    return {
      versionStatus: 'unknown',
      loginReadiness: 'ready',
      noninteractiveSupport: 'supported',
      cwdSupport: 'supported',
      timeoutSupport: 'supported',
      transcriptSupport: 'supported',
      envSafetyPosture: 'inherited',
      receiptSupport: 'transcript-capture',
      unattendedSafe: false,
      unattendedReasons,
      degradations,
    };
  }

  const versionStatus: VersionStatus = commandPath ? 'unknown' : 'unavailable';
  const noninteractiveSupport: NoninteractiveSupport = 'unverified';
  if (commandPath) {
    degradations.push('codex version/help probing is intentionally skipped by host_runtime_probe; the current Codex host may be the active operator and must not be auto-driven by a probe.');
    unattendedReasons.push('codex CLI noninteractive support is unverified by the safe probe; dispatch_auto must require policy binding and a bounded runner before launch.');
  } else {
    unattendedReasons.push('codex CLI is not available; noninteractive execution is impossible.');
  }

  const cwdSupport: CwdSupport = commandPath ? 'supported' : 'unverified';
  const timeoutSupport: TimeoutSupport = commandPath ? 'supported' : 'unverified';
  const transcriptSupport: TranscriptSupport = commandPath ? 'supported' : 'unverified';
  if (!commandPath) {
    degradations.push('cwd, timeout, and transcript support cannot be confirmed without a live CLI.');
  }

  const envSafetyPosture: EnvSafetyPosture = commandPath ? 'inherited' : 'unverified';
  if (commandPath) {
    degradations.push('codex inherits the invoker environment; sensitive env vars are visible to the subprocess unless filtered by Proofbound policy.');
  }

  const loginReadiness: LoginReadiness = 'unknown';
  const receiptSupport: ReceiptSupport = commandPath ? 'transcript-capture' : 'unverified';

  if (!commandPath) {
    unattendedReasons.push('codex CLI is not available in PATH.');
  }
  unattendedReasons.push('Noninteractive mode is unverified for codex; bounded unattended execution cannot be guaranteed by host_runtime_probe alone.');
  unattendedReasons.push('Unattended execution requires a dispatch_policy_check authorization and dispatch_auto policy binding before starting.');

  return {
    versionStatus,
    loginReadiness,
    noninteractiveSupport,
    cwdSupport,
    timeoutSupport,
    transcriptSupport,
    envSafetyPosture,
    receiptSupport,
    unattendedSafe: false,
    unattendedReasons,
    degradations,
  };
}

export function probeHostRuntime(host: string): HostRuntimeProbe {
  const normalized = normalizeHostRuntimeId(host);
  if (!normalized) {
    throw new Error(`host_runtime_probe requires host=${CURRENT_HOST_RUNTIME_DESCRIPTION}; ${LEGACY_HOST_RUNTIME_DESCRIPTION}; got ${host || '(empty)'}`);
  }
  if (normalized === 'fake') {
    return {
      schemaVersion: 'lattice.host_runtime_probe.v1',
      host: 'fake',
      requestedHost: host,
      status: 'ready',
      available: true,
      supportsParallel: true,
      matchedFallback: host.trim().toLowerCase() !== 'fake',
      runtimeKind: 'fake',
      invocationTemplate: runtimeTemplate('fake'),
      versionStatus: 'detected',
      version: 'fake-deterministic',
      loginReadiness: 'ready',
      noninteractiveSupport: 'supported',
      cwdSupport: 'supported',
      timeoutSupport: 'supported',
      transcriptSupport: 'supported',
      envSafetyPosture: 'sandboxed',
      receiptSupport: 'structured',
      unattendedSafe: false,
      unattendedReasons: ['Fake runtime is for deterministic local test coverage only; not for production unattended use.'],
      degradations: [],
      limitations: [
        'Deterministic local test harness only.',
        'Produces local diagnostic receipts only.',
        'Never verifies receipts, changes authority, or claims release readiness.',
      ],
      warnings: [],
      nextAction: 'Ready for deterministic local dispatch_prepare/dispatch_run coverage in an isolated overflow worktree.',
      authority: authorityState(),
    };
  }

  const cliCommand = REAL_HOST_CLI[normalized];
  const isCodexSession = normalized === 'codex' && currentCodexSessionAvailable();
  const commandPath = isCodexSession
    ? process.execPath
    : detectCommandPath(cliCommand);
  const available = Boolean(commandPath);
  // B-ceed: codex/legacy gemini real-host live dispatch exists; antigravity is
  // manual-first until a bounded agy runner lands. Claude Code's bespoke leaf is
  // surfaced only as an informational note (real claude-code dispatch runs via
  // runClaudeCodeRealLeafDispatch when allowRealHostSubprocess is granted).
  const supportsLiveDispatch = normalized === 'codex' || normalized === 'gemini' || normalized === 'claude-code';
  const legacyWarnings = normalized === 'gemini'
    ? ['gemini is deprecated legacy compatibility; use antigravity/agy for current third-host runtime flows.']
    : [];
  const availabilityWarnings = available
    ? supportsLiveDispatch
      ? []
      : [
        `${normalized} runtime is scaffolded only: Proofbound records invocation metadata and waits for a local receipt; it does not auto-drive the external host.`,
      ]
    : [
      `${cliCommand} CLI is not available in PATH; runtime stays unavailable-safe and will not start the host automatically.`,
    ];
  const warnings = [...legacyWarnings, ...availabilityWarnings];

  // Real host unattended capability contract (CHK-002 claude-code / CHK-004 all hosts)
  const capabilities: RealHostCapabilities = normalized === 'claude-code'
    ? probeClaudeCodeCapabilities(commandPath)
    : normalized === 'antigravity'
      ? probeAntigravityCapabilities(commandPath)
      : normalized === 'gemini'
        ? probeGeminiCapabilities(commandPath)
        : probeCodexCapabilities(commandPath, isCodexSession);

  return {
    schemaVersion: 'lattice.host_runtime_probe.v1',
    host: normalized,
    requestedHost: host,
    status: available ? 'scaffolded' : 'unavailable',
    available,
    supportsParallel: false,
    matchedFallback: host.trim().toLowerCase() !== normalized,
    runtimeKind: available ? 'scaffolded' : 'missing-cli',
    cliCommand,
    ...(commandPath ? { commandPath } : {}),
    invocationTemplate: runtimeTemplate(normalized),
    versionStatus: capabilities.versionStatus,
    ...(capabilities.version !== undefined ? { version: capabilities.version } : {}),
    loginReadiness: capabilities.loginReadiness,
    noninteractiveSupport: capabilities.noninteractiveSupport,
    cwdSupport: capabilities.cwdSupport,
    timeoutSupport: capabilities.timeoutSupport,
    transcriptSupport: capabilities.transcriptSupport,
    envSafetyPosture: capabilities.envSafetyPosture,
    receiptSupport: capabilities.receiptSupport,
    unattendedSafe: capabilities.unattendedSafe,
    unattendedReasons: capabilities.unattendedReasons,
    degradations: capabilities.degradations,
    limitations: supportsLiveDispatch
      ? [
        normalized === 'gemini'
          ? 'Gemini is deprecated legacy compatibility; current third-host runtime flows use antigravity/agy.'
          : 'A local receipt is still diagnostic-only and leaves productionDone=false.',
        ...(normalized === 'gemini' ? ['A local receipt is still diagnostic-only and leaves productionDone=false.'] : []),
      ]
      : [
        'Real-host execution is scaffolded only in this milestone.',
        'No external host is auto-driven by Proofbound dispatch_run.',
        'A local receipt is still diagnostic-only and leaves productionDone=false.',
      ],
    warnings,
    nextAction: available
      ? `${normalized} is supervised-only until dispatch_auto (CHK-006) is authorized. ${normalized === 'gemini' ? 'Gemini is legacy compatibility; prefer antigravity/agy for current third-host runtime flows. ' : ''}Use dispatch_prepare/dispatch_run to generate the isolated worktree + prompt metadata, then run ${cliCommand} manually and return a local receipt. Unattended execution requires dispatch_policy_check authorization and dispatch_auto policy binding.`
      : `Install or expose ${cliCommand} in PATH, or use host=fake for deterministic local coverage.`,
    authority: authorityState(),
  };
}

export function listHostRuntimes(): HostRuntimeList {
  return {
    schemaVersion: 'lattice.host_runtime_list.v1',
    runtimes: ['fake', ...CURRENT_HOST_RUNTIME_IDS].map(host => probeHostRuntime(host)),
    authority: authorityState(),
  };
}

function normalizeList(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeDispatchId(dispatchId: string, label = 'dispatchId'): string {
  const trimmed = dispatchId.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }
  if (isAbsolute(trimmed)) {
    throw new Error(`${label} must not be absolute: ${trimmed}`);
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error(`${label} must not contain path separators or traversal segments: ${trimmed}`);
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`${label} must not be "." or "..": ${trimmed}`);
  }
  return trimmed;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dispatch';
}

function dispatchStorageRoot(root: string): string {
  return join(root, LATTICE_DIR, 'dispatches');
}

function projectedDispatchWorktreePath(storyId: string, packId: string): string {
  return `.worktrees/overflow/${sanitizeSegment(storyId)}/${sanitizeSegment(packId)}`;
}

function normalizePackPathList(
  root: string,
  storyId: string,
  packId: string,
  values: string[] | undefined,
  label: 'allowedPaths' | 'deniedPaths',
): string[] {
  const worktreeAbs = resolve(root, projectedDispatchWorktreePath(storyId, packId));
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const [index, value] of (values ?? []).entries()) {
    const relativePath = assertWorktreeRelativePath(worktreeAbs, value, `${label}[${index}]`);
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    normalized.push(relativePath);
  }
  return normalized;
}

function dispatchDir(root: string, dispatchId: string): string {
  return join(dispatchStorageRoot(root), normalizeDispatchId(dispatchId));
}

function dispatchFile(root: string, dispatchId: string, name: string): string {
  return join(dispatchDir(root, dispatchId), name);
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function maybeReadJson<T>(file: string): T | undefined {
  return existsSync(file) ? readJson<T>(file) : undefined;
}

function ensureDispatchDir(root: string, dispatchId: string): void {
  mkdirSync(dispatchDir(root, dispatchId), { recursive: true });
}

function createDispatchId(storyId: string, host: HostRuntimeId): string {
  const stamp = Date.now().toString(36);
  return `D-${sanitizeSegment(storyId)}-${sanitizeSegment(host)}-${stamp}`;
}

function dispatchPrompt(pack: HandoffPack, runtime: HostRuntimeProbe, dispatchId: string): string {
  return [
    `# Proofbound Dispatch ${dispatchId}`,
    '',
    `Story: ${pack.storyId}`,
    `Host runtime: ${runtime.host}`,
    `Pack: ${pack.packId} (${pack.packHash})`,
    '',
    '## Execution Instructions',
    ...pack.executionInstructions.map(line => `- ${line}`),
    '',
    '## Required Commands',
    ...(pack.requiredCommands.length > 0 ? pack.requiredCommands.map(line => `- ${line}`) : ['- (none)']),
    '',
    '## Success Criteria',
    ...(pack.successCriteria.length > 0 ? pack.successCriteria.map(line => `- ${line}`) : ['- Return a local diagnostic receipt for review.']),
    '',
    '## Authority Boundary',
    `- ${pack.authorityBoundary.summary}`,
    ...pack.authorityBoundary.notes.map(line => `- ${line}`),
  ].join('\n') + '\n';
}

function handoffTargetForRuntime(host: HostRuntimeId): string {
  if (host === 'claude-code') return 'claude-code';
  if (host === 'antigravity') return 'antigravity';
  if (host === 'gemini') return 'gemini';
  return 'codex';
}

function chooseHost(requestedHost: string | undefined): {
  selectedHost: HostRuntimeId;
  runtime: HostRuntimeProbe;
  fallbackHosts: Array<{ host: HostRuntimeId; status: HostRuntimeStatus; reason: string }>;
} {
  const explicit = normalizeHostRuntimeId(requestedHost);
  if (explicit) {
    const runtime = probeHostRuntime(explicit);
    return {
      selectedHost: explicit,
      runtime,
      fallbackHosts: HOST_RUNTIME_ORDER
        .filter(host => host !== explicit)
        .map(host => ({ host, status: probeHostRuntime(host).status, reason: probeHostRuntime(host).nextAction })),
    };
  }

  const probes = HOST_RUNTIME_ORDER.map(host => probeHostRuntime(host));
  const selected = probes.find(probe => probe.status !== 'unavailable') ?? probes[probes.length - 1];
  return {
    selectedHost: selected.host,
    runtime: selected,
    fallbackHosts: probes
      .filter(probe => probe.host !== selected.host)
      .map(probe => ({ host: probe.host, status: probe.status, reason: probe.nextAction })),
  };
}

function packPreview(pack: HandoffPack): DispatchPackPreview {
  return {
    packId: pack.packId,
    packHash: pack.packHash,
    ...(pack.baseSha ? { baseSha: pack.baseSha } : {}),
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    allowedPaths: [...pack.allowedPaths],
    deniedPaths: [...pack.deniedPaths],
    requiredCommands: [...pack.requiredCommands],
    successCriteria: [...pack.successCriteria],
    authorityBoundarySummary: pack.authorityBoundary.summary,
  };
}

function buildPack(
  store: StoryStore,
  root: string,
  args: DispatchPlanArgs,
  selectedHost: HostRuntimeId,
  dispatchId?: string,
): HandoffPack {
  const role = args.role?.trim() || 'overflow-worker';
  const objective = args.objective?.trim() || `Dispatch runtime work for ${args.storyId}`;
  const packId = args.packId?.trim() || dispatchId || 'dispatch-preview';
  return createHandoffPack(store, root, {
    storyId: args.storyId,
    fromHost: args.fromHost?.trim() || 'codex',
    toHost: handoffTargetForRuntime(selectedHost),
    role,
    objective,
    allowedPaths: normalizePackPathList(root, args.storyId, packId, args.allowedPaths, 'allowedPaths'),
    deniedPaths: normalizePackPathList(root, args.storyId, packId, args.deniedPaths, 'deniedPaths'),
    requiredCommands: normalizeList(args.requiredCommands),
    successCriteria: normalizeList(args.successCriteria),
    baseSha: args.baseSha?.trim(),
    packId,
    authorityBoundary: args.authorityBoundary?.trim(),
    executionInstructions: normalizeList(args.executionInstructions),
  });
}

function computePlan(
  store: StoryStore,
  root: string,
  args: DispatchPlanArgs,
): DispatchPlanResult {
  const { selectedHost, runtime, fallbackHosts } = chooseHost(args.host);
  const pack = buildPack(store, root, args, selectedHost);
  const worktree = buildHandoffWorktreeProjection(pack);
  const constraintWarnings = [
    ...(pack.allowedPaths.length === 0 ? ['No allowedPaths declared; scope remains advisory until constrained.'] : []),
    ...(pack.requiredCommands.length === 0 ? ['No requiredCommands declared; validation expectations are minimal.'] : []),
  ];
  const risks = [
    ...(runtime.status === 'unavailable' ? [`${selectedHost} runtime is unavailable.`] : []),
    ...(runtime.status === 'scaffolded' ? ['Real-host execution remains scaffolded/manual-first.'] : []),
    ...constraintWarnings,
  ];
  const warnings = [
    ...runtime.warnings,
    ...worktree.warnings,
    ...constraintWarnings,
  ];
  return {
    schemaVersion: 'lattice.dispatch_plan.v1',
    storyId: args.storyId,
    requestedHost: args.host?.trim() || 'auto',
    selectedHost,
    status: runtime.status === 'unavailable' ? 'unavailable' : 'planned',
    parallel: Math.max(1, args.parallel ?? 1),
    runtime,
    fallbackHosts,
    pack: packPreview(pack),
    worktree: {
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      reviewCommand: worktree.reviewCommand,
      cleanupCommand: worktree.cleanupCommand,
    },
    risks,
    warnings,
    nextAction: runtime.status === 'unavailable'
      ? runtime.nextAction
      : selectedHost === 'fake'
        ? 'Run dispatch_prepare or dispatch_run --host=fake to create isolated local dispatch state and a diagnostic receipt.'
        : `Run dispatch_prepare to materialize prompt/worktree metadata for ${selectedHost}; real-host execution stays manual-first and receipt-aware.`,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function readPack(root: string, dispatchId: string): HandoffPack {
  return readJson<HandoffPack>(dispatchFile(root, dispatchId, 'pack.json'));
}

function writePack(root: string, dispatchId: string, pack: HandoffPack): void {
  writeJson(dispatchFile(root, dispatchId, 'pack.json'), pack);
}

function writeRecord(root: string, record: DispatchRecord): DispatchRecord {
  const dispatchId = normalizeDispatchId(record.dispatchId, 'record.dispatchId');
  const next = {
    ...record,
    dispatchId,
    updatedAt: nowIso(),
  };
  writeJson(dispatchFile(root, dispatchId, 'dispatch.json'), next);
  return next;
}

function readRecord(root: string, dispatchId: string): DispatchRecord {
  const normalizedDispatchId = normalizeDispatchId(dispatchId);
  const file = dispatchFile(root, normalizedDispatchId, 'dispatch.json');
  if (!existsSync(file)) {
    throw new Error(`Unknown dispatchId ${normalizedDispatchId}. Expected ${relative(root, file)}.`);
  }
  const record = readJson<DispatchRecord>(file);
  const recordedDispatchId = normalizeDispatchId(record.dispatchId, 'dispatch.json dispatchId');
  if (recordedDispatchId !== normalizedDispatchId) {
    throw new Error(`Dispatch metadata mismatch: requested ${normalizedDispatchId}, found ${recordedDispatchId}.`);
  }
  return {
    ...record,
    dispatchId: recordedDispatchId,
  };
}

function resolveEffectiveStatus(record: DispatchRecord): DispatchLifecycleStatus {
  if (!TERMINAL_DISPATCH_STATUSES.has(record.status) && Date.parse(record.expiresAt) < Date.now()) {
    return 'expired';
  }
  return record.status;
}

function ensurePreparedPackForFake(root: string, dispatchId: string, pack: HandoffPack): HandoffPack {
  if (pack.allowedPaths.length > 0) return pack;
  const safePath = `.lattice/dispatches/${dispatchId}/worker/fake-result.txt`;
  const patched: HandoffPack = {
    ...pack,
    allowedPaths: [safePath],
    executionInstructions: [
      ...pack.executionInstructions,
      `Fake runtime defaulted allowedPaths to ${safePath} so deterministic local scope can still be reviewed.`,
    ],
  };
  writePack(root, dispatchId, patched);
  return patched;
}

function assertWorktreeRelativePath(worktreeAbs: string, candidatePath: string, label: string): string {
  const trimmed = candidatePath.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }
  if (isAbsolute(trimmed)) {
    throw new Error(`${label} must stay inside the isolated worktree; absolute paths are forbidden: ${trimmed}`);
  }
  const candidateAbs = resolve(worktreeAbs, trimmed);
  const candidateRel = relative(worktreeAbs, candidateAbs);
  if (candidateRel === '..' || candidateRel.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes the isolated worktree via path traversal: ${trimmed}`);
  }
  return candidateRel || '.';
}

export function relativePathStaysWithinRoot(
  rel: string,
  absolutePathDetector: (path: string) => boolean = isAbsolute,
): boolean {
  return rel === ''
    || (rel !== '..'
      && !rel.startsWith('../')
      && !rel.startsWith('..\\')
      && !absolutePathDetector(rel));
}

function pathResolvesWithinRoot(rootReal: string, candidateReal: string): boolean {
  const rel = relative(rootReal, candidateReal);
  return relativePathStaysWithinRoot(rel);
}

function commandAllowlistAllowsClaudePrint(commandAllowlist: string[] | undefined): boolean {
  return normalizeList(commandAllowlist).includes(CLAUDE_PRINT_LAUNCHER);
}

function assertClaudePrintLauncherAllowed(
  commandAllowlist: string[] | undefined,
  refusalPrefix: string,
): void {
  if (commandAllowlistAllowsClaudePrint(commandAllowlist)) return;
  throw new Error(
    `${refusalPrefix} policy commandAllowlist must include canonical launcher "${CLAUDE_PRINT_LAUNCHER}" before Proofbound may start claude --print.`,
  );
}

function assertCanonicalWorktreePath(worktreeAbs: string, candidatePath: string, label: string): string {
  const relativePath = assertWorktreeRelativePath(worktreeAbs, candidatePath, label);
  const worktreeReal = realpathSync(worktreeAbs);
  const segments = relativePath === '.' ? [] : relativePath.split(/[\\/]+/).filter(Boolean);
  let currentAbs = worktreeAbs;
  for (const segment of segments) {
    currentAbs = join(currentAbs, segment);
    try {
      lstatSync(currentAbs);
    } catch {
      break;
    }
    let currentReal: string;
    try {
      currentReal = realpathSync(currentAbs);
    } catch (error: any) {
      throw new Error(`${label} traverses an unresolved symlink inside the isolated worktree: ${candidatePath} (${String(error?.message || error)})`);
    }
    if (!pathResolvesWithinRoot(worktreeReal, currentReal)) {
      throw new Error(`${label} resolves outside the isolated worktree via an existing symlinked path segment: ${candidatePath}`);
    }
  }
  return relativePath;
}

// B-75f0 CHK-001: gitCwd is the RESOLVED git invocation cwd (wrapper-root aware),
// threaded from the caller that holds store + record.storyId. On a wrapper-root
// layout the bare metadataRoot (`root`) is not a git repo, so this hard-throwing
// `git worktree list` errored and dispatch could never reach a registered
// worktree. `root` is still used only for the realpath fallback resolution of
// listed paths. Plain repos pass gitCwd == root → byte-identical.
function listedGitWorktreeRoots(root: string, gitCwd: string): string[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: gitCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return output
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim())
    .filter(Boolean)
    .map((path) => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(root, path);
      }
    });
}

function assertProjectedWorktreeAncestors(root: string, worktreeAbs: string, label: string): void {
  const relativePath = relative(root, worktreeAbs);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay within the repository root: ${worktreeAbs}`);
  }
  const rootReal = realpathSync(root);
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  let currentAbs = root;
  for (const segment of segments) {
    currentAbs = join(currentAbs, segment);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(currentAbs);
    } catch (error: any) {
      if (error?.code === 'ENOENT') break;
      const detail = String(error?.message || error).trim();
      throw new Error(`${label} ancestor could not be inspected: ${relative(root, currentAbs)} (${detail})`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} traverses a symlinked ancestor: ${relative(root, currentAbs)}`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`${label} ancestor must be a directory: ${relative(root, currentAbs)}`);
    }
    const currentReal = realpathSync(currentAbs);
    if (!pathResolvesWithinRoot(rootReal, currentReal)) {
      throw new Error(`${label} ancestor resolves outside the repository root: ${relative(root, currentAbs)}`);
    }
  }
}

// B-75f0 CHK-001: gitCwd is the RESOLVED git invocation cwd (wrapper-root aware),
// threaded from the caller. The hard-throwing `git rev-parse --show-toplevel`
// (and the nested `git worktree list`) ran from the bare metadataRoot before,
// which is not a git repo on a wrapper-root layout → dispatch hard-failed. `root`
// stays for path-relative diagnostics only. Plain repos pass gitCwd == root.
function assertRegisteredDispatchWorktreeRoot(root: string, gitCwd: string, worktreeAbs: string, label: string): void {
  const entry = lstatSync(worktreeAbs);
  if (entry.isSymbolicLink()) {
    throw new Error(`${label} must be a real git worktree root, not a symlink: ${relative(root, worktreeAbs)}`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`${label} must be a directory git worktree root: ${relative(root, worktreeAbs)}`);
  }
  const rootReal = realpathSync(root);
  const worktreeReal = realpathSync(worktreeAbs);
  if (!pathResolvesWithinRoot(rootReal, worktreeReal)) {
    throw new Error(`${label} resolves outside the repository root: ${relative(root, worktreeAbs)}`);
  }

  let gitTopLevel: string;
  try {
    gitTopLevel = execFileSync('git', ['-C', worktreeAbs, 'rev-parse', '--show-toplevel'], {
      cwd: gitCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch (error: any) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    throw new Error(`${label} is not a git worktree root: ${relative(root, worktreeAbs)} (${detail})`);
  }

  const gitTopLevelReal = realpathSync(gitTopLevel);
  if (gitTopLevelReal !== worktreeReal) {
    throw new Error(`${label} must be the git top-level worktree root, got ${relative(root, worktreeAbs)} inside ${relative(root, gitTopLevelReal)}`);
  }

  if (!listedGitWorktreeRoots(root, gitCwd).includes(worktreeReal)) {
    throw new Error(`${label} is not registered in this repository's git worktree list: ${relative(root, worktreeAbs)}`);
  }
}

function normalizePackPaths(
  root: string,
  dispatchId: string,
  worktreeAbs: string,
  pack: HandoffPack,
  mode: 'relative' | 'canonical' = 'relative',
): HandoffPack {
  const normalizePath = mode === 'canonical'
    ? assertCanonicalWorktreePath
    : assertWorktreeRelativePath;
  const allowedPaths = pack.allowedPaths.map((entry, index) =>
    normalizePath(worktreeAbs, entry, `allowedPaths[${index}]`));
  const deniedPaths = pack.deniedPaths.map((entry, index) =>
    normalizePath(worktreeAbs, entry, `deniedPaths[${index}]`));
  const packChanged = allowedPaths.some((entry, index) => entry !== pack.allowedPaths[index])
    || deniedPaths.some((entry, index) => entry !== pack.deniedPaths[index]);
  if (!packChanged) return pack;
  const patched: HandoffPack = {
    ...pack,
    allowedPaths,
    deniedPaths,
  };
  writePack(root, dispatchId, patched);
  return patched;
}

// B-75f0 CHK-001: gitCwd is the RESOLVED git invocation cwd (wrapper-root aware),
// resolved at the caller via resolveGitCwd (store + record.storyId in scope). All
// `git worktree add` and the nested registration probes now run from the resolved
// gitRoot instead of the bare metadataRoot. `root` stays for path math. Plain
// repos pass gitCwd == root → byte-identical.
function ensureWorktree(root: string, gitCwd: string, worktreePath: string, branch: string, baseRef: string): string {
  const absPath = resolve(root, worktreePath);
  assertProjectedWorktreeAncestors(root, absPath, 'Dispatch worktree path');
  if (existsSync(absPath)) {
    assertRegisteredDispatchWorktreeRoot(root, gitCwd, absPath, 'Dispatch worktree path');
    return absPath;
  }
  mkdirSync(dirname(absPath), { recursive: true });
  assertProjectedWorktreeAncestors(root, absPath, 'Dispatch worktree path');
  try {
    execFileSync('git', ['worktree', 'add', absPath, '-b', branch, baseRef], {
      cwd: gitCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error: any) {
    const message = String(error?.stderr || error?.stdout || error?.message || error);
    if (!existsSync(absPath)) {
      throw new Error(`git worktree add failed for ${worktreePath}: ${message.trim()}`);
    }
  }
  try {
    assertRegisteredDispatchWorktreeRoot(root, gitCwd, absPath, 'Dispatch worktree path');
  } catch (error: any) {
    const detail = String(error?.message || error).trim();
    const cleanupWarnings = cleanupCreatedWorktree(root, gitCwd, worktreePath, branch);
    const suffix = cleanupWarnings.length > 0 ? ` (${cleanupWarnings.join(' | ')})` : '';
    throw new Error(`${detail}${suffix}`);
  }
  return absPath;
}

// B-75f0 CHK-001: gitCwd is the RESOLVED git invocation cwd (wrapper-root aware).
// `git worktree remove` / `prune` / `branch -D` run from the resolved gitRoot, not
// the bare metadataRoot. Plain repos pass gitCwd == root → byte-identical.
function cleanupCreatedWorktree(root: string, gitCwd: string, worktreePath: string, branch: string): string[] {
  const warnings: string[] = [];
  const absPath = resolve(root, worktreePath);
  try {
    execFileSync('git', ['worktree', 'remove', '--force', absPath], {
      cwd: gitCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error: any) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    warnings.push(`Worktree cleanup warning: git worktree remove failed for ${worktreePath}: ${detail}`);
  }
  if (existsSync(absPath)) {
    try {
      rmSync(absPath, { recursive: true, force: true });
    } catch (error: any) {
      const detail = String(error?.message || error).trim();
      warnings.push(`Worktree cleanup warning: rm -rf failed for ${worktreePath}: ${detail}`);
    }
  }
  try {
    execFileSync('git', ['worktree', 'prune'], {
      cwd: gitCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch {
    // probe: stale worktree metadata can remain until prune, but prune failure is non-fatal here
  }
  try {
    execFileSync('git', ['branch', '-D', branch], {
      cwd: gitCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error: any) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    warnings.push(`Worktree cleanup warning: branch delete failed for ${branch}: ${detail}`);
  }
  return warnings;
}

function appendTranscript(file: string, lines: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const payload = `${previous}${lines.join('\n')}\n`;
  writeFileSync(file, payload, 'utf8');
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

const UNSAFE_COMMAND_ENV_PATTERN = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH|PRIVATE/i;
const SAFE_COMMAND_ENV_BASICS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'ComSpec',
];

function isUnsafeCommandEnvName(name: string): boolean {
  return UNSAFE_COMMAND_ENV_PATTERN.test(name);
}

function buildRequiredCommandEnv(policy?: DispatchCommandExecutionPolicy): Record<string, string | undefined> {
  if (!policy) return process.env;

  const denied = new Set(policy.envDenylist.map(name => name.trim()).filter(Boolean));
  const env: Record<string, string | undefined> = {};
  const copyIfAllowed = (name: string): void => {
    const trimmed = name.trim();
    if (!trimmed || denied.has(trimmed) || isUnsafeCommandEnvName(trimmed)) return;
    const value = process.env[trimmed];
    if (value !== undefined) env[trimmed] = value;
  };

  for (const name of SAFE_COMMAND_ENV_BASICS) copyIfAllowed(name);
  for (const name of policy.envAllowlist) copyIfAllowed(name);
  if (!denied.has('LATTICE_SESSION_ID')) {
    env.LATTICE_SESSION_ID = getSessionId();
  }
  return env;
}

function ownerSessionProviderForHostRuntime(host: HostRuntimeId): 'codex' | 'claude-code' | 'antigravity' | 'fake' | null {
  if (host === 'codex') return 'codex';
  if (host === 'claude-code') return 'claude-code';
  if (host === 'antigravity') return 'antigravity';
  if (host === 'fake') return 'fake';
  return null;
}

function buildCanonicalHostRuntimeEnv(
  policy: DispatchCommandExecutionPolicy,
  host: HostRuntimeId,
  adapterBoundary: string,
): NodeJS.ProcessEnv {
  const env = buildRequiredCommandEnv(policy) as NodeJS.ProcessEnv;
  const sessionId = getSessionId();
  env.LATTICE_SESSION_ID = sessionId;
  env.LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY = adapterBoundary;
  env.LATTICE_ACTIVITY_SOURCE = host;
  env.LATTICE_ACTIVITY_SESSION = sessionId;
  const provider = ownerSessionProviderForHostRuntime(host);
  if (provider !== null) {
    env.LATTICE_OWNER_SESSION_ADAPTER_PROVIDER = provider;
    env.LATTICE_OWNER_SESSION_ADAPTER_SESSION = sessionId;
  }
  return env;
}

function commandTimedOut(error: any, timeoutMs: number | undefined): boolean {
  if (timeoutMs === undefined) return false;
  const message = String(error?.message || error?.stderr || error?.stdout || error);
  return error?.signal === 'SIGTERM'
    || error?.code === 'ETIMEDOUT'
    || /timed out|timeout|SIGTERM|ETIMEDOUT/i.test(message);
}

function commandFailureOutput(error: any, timedOut: boolean, timeoutMs: number | undefined): string {
  const details = String(error?.stderr || error?.stdout || error?.message || error).trim();
  if (!timedOut) return details;
  const timeoutNote = `timed out after ${Math.ceil(timeoutMs ?? 0)}ms`;
  return details ? `${timeoutNote}; ${details}` : timeoutNote;
}

function runRequiredCommands(
  worktreeRoot: string,
  commands: string[],
  executionPolicy?: DispatchCommandExecutionPolicy,
  env: Record<string, string | undefined> = buildRequiredCommandEnv(executionPolicy),
): RequiredCommandResult[] {
  const commandAllowlist = new Set(executionPolicy?.commandAllowlist ?? []);
  const timeoutMs = executionPolicy ? Math.ceil(executionPolicy.maxRuntimeMs) : undefined;
  return commands.map((command) => {
    if (executionPolicy && !commandAllowlist.has(command)) {
      return {
        command,
        ok: false,
        output: 'refused before execution: command is not in dispatch_auto policy commandAllowlist',
      };
    }
    try {
      const output = execSync(command, {
        cwd: worktreeRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      });
      return { command, ok: true, output: output.trim() };
    } catch (error: any) {
      const timedOut = commandTimedOut(error, timeoutMs);
      return {
        command,
        ok: false,
        output: commandFailureOutput(error, timedOut, timeoutMs),
        ...(timedOut ? { timedOut: true } : {}),
      };
    }
  });
}

function spawnOutputText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function compactProcessOutputForWarning(...values: string[]): string {
  return values
    .filter(Boolean)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function spawnTimedOut(result: ReturnType<typeof spawnSync>, timeoutMs: number): boolean {
  const error = result.error as NodeJS.ErrnoException | undefined;
  const message = String(error?.message || '');
  return error?.code === 'ETIMEDOUT'
    || result.signal === 'SIGTERM'
    || /timed out|timeout|ETIMEDOUT/i.test(message)
    || (result.status === null && timeoutMs > 0 && Boolean(error));
}

function spawnExitCode(result: ReturnType<typeof spawnSync>, timedOut: boolean): number {
  if (typeof result.status === 'number') return result.status;
  return timedOut ? 124 : 1;
}

function gitStatusPaths(worktreeAbs: string): string[] {
  const output = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: worktreeAbs,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return output
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const pathPart = line.slice(3);
      return pathPart.includes(' -> ') ? pathPart.split(' -> ').pop()! : pathPart;
    });
}

function packAllowsChangedPath(pack: HandoffPack, changedPath: string): boolean {
  return pack.allowedPaths.some(allowedPath => pathIsWithinScope(changedPath, allowedPath))
    && !pack.deniedPaths.some(deniedPath => pathIsWithinScope(changedPath, deniedPath));
}

function removeScaffoldedOnlyWarnings(warnings: string[]): string[] {
  return warnings.filter(warning => !/scaffolded only|does not auto-drive/i.test(warning));
}

function createClaudeCodeReceipt(opts: {
  pack: HandoffPack;
  record: Pick<DispatchRecord, 'dispatchId' | 'selectedHost'>;
  headSha: string;
  changedFiles: string[];
  command: string;
  diagnosticWarnings: string[];
}): HandoffReceipt {
  const verdict: HandoffReceipt['verdict'] =
    opts.changedFiles.length > 0 && opts.diagnosticWarnings.length === 0 ? 'pass' : 'warn';
  return {
    schemaVersion: 'lattice.handoff_receipt.v1',
    storyId: opts.pack.storyId,
    host: dispatchReceiptHost(opts.record, opts.pack),
    packId: opts.pack.packId,
    packHash: opts.pack.packHash,
    fromHost: opts.pack.fromHost,
    toHost: opts.pack.toHost,
    ...(opts.pack.baseSha ? { baseSha: opts.pack.baseSha } : {}),
    ...(opts.pack.role ? { role: opts.pack.role } : {}),
    ...(opts.pack.objective ? { objective: opts.pack.objective } : {}),
    allowedPaths: [...opts.pack.allowedPaths],
    deniedPaths: [...opts.pack.deniedPaths],
    requiredCommands: [...opts.pack.requiredCommands],
    successCriteria: [...opts.pack.successCriteria],
    authorityBoundary: opts.pack.authorityBoundary,
    executionInstructions: [...opts.pack.executionInstructions],
    headSha: opts.headSha,
    changedFiles: [...opts.changedFiles],
    commands: [opts.command],
    verdict,
    summary: verdict === 'pass'
      ? `Claude Code dispatch ${opts.record.dispatchId} completed with a local reviewable diff.`
      : `Claude Code dispatch ${opts.record.dispatchId} completed but needs diagnostic review before acceptance.`,
    limitations: [
      'Claude Code subprocess receipt is local diagnostic evidence only.',
      'receiptVerified=false, authorityChanged=false, productionDone=false.',
      ...opts.diagnosticWarnings,
    ],
  };
}

function dispatchReceiptHost(record: Pick<DispatchRecord, 'selectedHost'>, pack: HandoffPack): string {
  return normalizeHostRuntimeId(record.selectedHost) ?? pack.toHost;
}

function createFakeReceipt(
  pack: HandoffPack,
  record: Pick<DispatchRecord, 'dispatchId' | 'selectedHost'>,
  headSha: string,
  changedFiles: string[],
  commandResults: RequiredCommandResult[],
  warnings: string[],
): HandoffReceipt {
  const failedCommand = commandResults.find(result => !result.ok);
  return {
    schemaVersion: 'lattice.handoff_receipt.v1',
    storyId: pack.storyId,
    host: dispatchReceiptHost(record, pack),
    packId: pack.packId,
    packHash: pack.packHash,
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    ...(pack.baseSha ? { baseSha: pack.baseSha } : {}),
    ...(pack.role ? { role: pack.role } : {}),
    ...(pack.objective ? { objective: pack.objective } : {}),
    allowedPaths: [...pack.allowedPaths],
    deniedPaths: [...pack.deniedPaths],
    requiredCommands: [...pack.requiredCommands],
    successCriteria: [...pack.successCriteria],
    authorityBoundary: pack.authorityBoundary,
    executionInstructions: [...pack.executionInstructions],
    headSha,
    changedFiles,
    commands: commandResults.map(result => result.command),
    verdict: failedCommand ? 'fail' : 'pass',
    summary: failedCommand
      ? `Fake dispatch ${record.dispatchId} hit command failure: ${failedCommand.command}`
      : `Fake dispatch ${record.dispatchId} produced a deterministic local diff for review.`,
    limitations: [
      'Local fake runtime receipt only.',
      'receiptVerified=false, authorityChanged=false, productionDone=false.',
      ...warnings,
    ],
  };
}

function leafDispatchCollection(root: string, record: DispatchRecord, pack: HandoffPack): DispatchCollection {
  const warnings = [...record.warnings];
  const transcriptExists = existsSync(resolve(root, record.transcriptFile));
  const commands = maybeReadJson<Array<{ command: string; ok: boolean; output: string }>>(resolve(root, record.collectFile.replace(/collect\.json$/, 'command-results.json')))
    ?.map(result => result.command)
    ?? [];
  let headSha: string | undefined;
  let changedFiles: string[] = [];
  let freshness: DispatchCollection['freshness'] = 'unknown';
  const worktreeAbs = resolve(root, record.worktree.worktreePath);
  if (existsSync(worktreeAbs)) {
    try {
      headSha = currentGitHead(worktreeAbs);
      if (pack.baseSha) {
        changedFiles = changedFilesBetween(root, pack.baseSha, headSha);
        freshness = checkEvidenceFreshnessForGit(root, pack.baseSha).fresh ? 'fresh' : 'stale';
      } else {
        freshness = 'unknown';
        warnings.push('Pack is missing baseSha, so freshness is unknown.');
      }
    } catch (error: any) {
      warnings.push(String(error?.message || error));
    }
  } else {
    warnings.push(`Worktree missing: ${record.worktree.worktreePath}`);
  }
  const limitations = [
    ...(transcriptExists ? [] : ['Transcript placeholder is missing.']),
    ...(changedFiles.length > 0 ? [] : ['No git-derived changedFiles detected.']),
  ];
  return {
    schemaVersion: 'lattice.dispatch_collect.v1',
    dispatchId: record.dispatchId,
    storyId: record.storyId,
    host: record.selectedHost,
    status: resolveEffectiveStatus(record),
    ...(pack.baseSha ? { baseSha: pack.baseSha } : {}),
    ...(headSha ? { headSha } : {}),
    freshness,
    changedFiles,
    commands,
    transcriptExists,
    warnings,
    limitations,
    workers: [],
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function aggregateStatus(statuses: DispatchLifecycleStatus[]): DispatchLifecycleStatus {
  if (statuses.length === 0) return 'diagnostic';
  const first = statuses[0];
  if (statuses.every(status => status === first)) return first;
  if (statuses.some(status => status === 'running')) return 'running';
  if (statuses.some(status => status === 'needs_receipt')) return 'needs_receipt';
  if (statuses.some(status => status === 'prepared')) return 'prepared';
  if (statuses.some(status => status === 'planned')) return 'planned';
  return 'diagnostic';
}

type CollectDispatchOptions = {
  persist?: boolean;
};

function aggregateWorkerCollections(root: string, record: DispatchRecord, options: CollectDispatchOptions = {}): DispatchCollection {
  const workers = record.workerIds.map(workerId => collectDispatch(root, workerId, options));
  return {
    schemaVersion: 'lattice.dispatch_collect.v1',
    dispatchId: record.dispatchId,
    storyId: record.storyId,
    host: record.selectedHost,
    status: aggregateStatus(workers.map(worker => worker.status)),
    freshness: workers.every(worker => worker.freshness === 'fresh')
      ? 'fresh'
      : workers.some(worker => worker.freshness === 'stale')
        ? 'stale'
        : 'unknown',
    changedFiles: [...new Set(workers.flatMap(worker => worker.changedFiles))].sort(),
    commands: [...new Set(workers.flatMap(worker => worker.commands))],
    transcriptExists: workers.every(worker => worker.transcriptExists),
    warnings: workers.flatMap(worker => worker.warnings),
    limitations: workers.flatMap(worker => worker.limitations),
    workers,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function planDispatch(store: StoryStore, root: string, args: DispatchPlanArgs): DispatchPlanResult {
  return computePlan(store, root, args);
}

export function prepareDispatch(store: StoryStore, root: string, args: DispatchPrepareArgs): DispatchRecord {
  const requestedDispatchId = args.dispatchId?.trim() ? normalizeDispatchId(args.dispatchId) : undefined;
  const plan = computePlan(store, root, args);
  const dispatchId = requestedDispatchId ?? createDispatchId(args.storyId, plan.selectedHost);
  ensureDispatchDir(root, dispatchId);
  const pack = buildPack(store, root, args, plan.selectedHost, dispatchId);
  writePack(root, dispatchId, pack);
  const worktree = buildHandoffWorktreeProjection(pack);
  const promptFile = dispatchFile(root, dispatchId, 'prompt.md');
  const transcriptFile = dispatchFile(root, dispatchId, 'transcript.log');
  writeFileSync(promptFile, dispatchPrompt(pack, plan.runtime, dispatchId), 'utf8');
  if (!existsSync(transcriptFile)) writeFileSync(transcriptFile, '', 'utf8');
  const record: DispatchRecord = {
    schemaVersion: 'lattice.dispatch_record.v1',
    dispatchId,
    storyId: args.storyId,
    requestedHost: args.host?.trim() || 'auto',
    selectedHost: plan.selectedHost,
    status: plan.status === 'unavailable' ? 'unavailable' : 'prepared',
    parallel: Math.max(1, args.parallel ?? 1),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    expiresAt: plusHoursIso(24),
    runtime: plan.runtime,
    warnings: [...plan.warnings],
    nextAction: plan.nextAction,
    packFile: relative(root, dispatchFile(root, dispatchId, 'pack.json')),
    statusFile: relative(root, dispatchFile(root, dispatchId, 'dispatch.json')),
    promptFile: relative(root, promptFile),
    transcriptFile: relative(root, transcriptFile),
    collectFile: relative(root, dispatchFile(root, dispatchId, 'collect.json')),
    receiptFile: relative(root, dispatchFile(root, dispatchId, 'receipt.json')),
    receiptSubmissionFile: relative(root, dispatchFile(root, dispatchId, 'receipt-submit.json')),
    runnerFile: relative(root, dispatchFile(root, dispatchId, 'runner.json')),
    worktree: {
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      reviewCommand: worktree.reviewCommand,
      cleanupCommand: worktree.cleanupCommand,
    },
    workerIds: [],
    ...(requestedDispatchId ? { parentDispatchId: requestedDispatchId } : {}),
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
  return writeRecord(root, record);
}

function runFakeLeafDispatch(
  store: StoryStore,
  root: string,
  record: DispatchRecord,
  executionPolicy?: DispatchCommandExecutionPolicy,
): DispatchRunResult {
  const runnerStartedAt = nowIso();
  let pack = readPack(root, record.dispatchId);
  pack = ensurePreparedPackForFake(root, record.dispatchId, pack);
  const projectedWorktreeAbs = resolve(root, record.worktree.worktreePath);
  pack = normalizePackPaths(root, record.dispatchId, projectedWorktreeAbs, pack);
  const baseRef = pack.baseSha ?? 'HEAD';
  // B-75f0 CHK-001: resolve the authoritative git cwd from the real record.storyId.
  const fakeGitCwd = resolveGitCwd({ store, storyId: record.storyId, metadataRoot: root, projectRoot: root });
  const worktreeAbs = ensureWorktree(root, fakeGitCwd, record.worktree.worktreePath, record.worktree.branch, baseRef);
  pack = normalizePackPaths(root, record.dispatchId, worktreeAbs, pack, 'canonical');
  const markerPath = pack.allowedPaths[0] ?? `.lattice/dispatches/${record.dispatchId}/worker/fake-result.txt`;
  const safeMarkerPath = assertCanonicalWorktreePath(worktreeAbs, markerPath, 'fake dispatch marker');
  const markerAbs = resolve(worktreeAbs, safeMarkerPath);
  mkdirSync(dirname(markerAbs), { recursive: true });
  writeFileSync(markerAbs, `dispatch=${record.dispatchId}\nstory=${record.storyId}\nrunAt=${nowIso()}\n`, 'utf8');
  appendTranscript(resolve(root, record.transcriptFile), [
    `[${nowIso()}] fake runtime prepared ${safeMarkerPath}`,
  ]);
  const commandEnv = buildRequiredCommandEnv(executionPolicy);
  const commandResults = runRequiredCommands(worktreeAbs, pack.requiredCommands, executionPolicy, commandEnv);
  appendTranscript(resolve(root, record.transcriptFile), commandResults.map(result => (
    `[${nowIso()}] command ${result.ok ? 'ok' : 'fail'} ${result.command}${result.output ? ` :: ${result.output}` : ''}`
  )));
  writeJson(resolve(root, record.collectFile.replace(/collect\.json$/, 'command-results.json')), commandResults);
  gitOutput(worktreeAbs, ['add', '-f', safeMarkerPath]);
  const commitMessage = `fake dispatch ${record.dispatchId}`;
  try {
    gitOutput(worktreeAbs, ['commit', '-m', commitMessage]);
  } catch {
    gitOutput(worktreeAbs, ['commit', '--allow-empty', '-m', `${commitMessage} (empty)`]);
  }
  const headSha = currentGitHead(worktreeAbs);
  if (!headSha) {
    throw new Error(`fake dispatch ${record.dispatchId} could not resolve HEAD after commit`);
  }
  const changedFiles = pack.baseSha ? changedFilesBetween(root, pack.baseSha, headSha) : [safeMarkerPath];
  const commandWarnings = commandResults.filter(result => !result.ok).map(result => `command failed: ${result.command}`);
  const receipt = createFakeReceipt(pack, record, headSha, changedFiles, commandResults, commandWarnings);
  writeJson(resolve(root, record.receiptFile), receipt);
  const submission = submitHandoffReceipt(root, receipt);
  writeJson(resolve(root, record.receiptSubmissionFile), submission);
  const collection = leafDispatchCollection(root, {
    ...record,
    latestHeadSha: headSha,
    warnings: [...record.warnings, ...commandWarnings],
  }, pack);
  writeJson(resolve(root, record.collectFile), collection);
  const nextStatus: DispatchLifecycleStatus =
    submission.status === 'accepted-local'
      ? 'accepted_local'
      : receipt.verdict === 'fail'
        ? 'failed'
        : 'diagnostic';
  const nextAction = submission.status === 'accepted-local'
    ? 'Fake dispatch completed. Review the isolated overflow diff and receipt manually before any merge.'
    : submission.nextAction;
  const runnerEndedAt = nowIso();
  const fakeExitCode = commandWarnings.length > 0 ? 1 : 0;
  const commandTimedOut = commandResults.some(result => result.timedOut === true);
  const runnerRecord = buildFakeRunnerRecord({
    dispatchId: record.dispatchId,
    host: record.selectedHost,
    commandTemplate: record.runtime.invocationTemplate ?? ['fake-runtime', '--deterministic'],
    cwd: record.worktree.worktreePath,
    transcriptPath: record.transcriptFile,
    startedAt: runnerStartedAt,
    endedAt: runnerEndedAt,
    exitCode: fakeExitCode,
    timedOut: commandTimedOut,
    env: commandEnv,
  });
  if (record.runnerFile) {
    writeJson(resolve(root, record.runnerFile), runnerRecord);
  }
  writeRecord(root, {
    ...record,
    status: nextStatus,
    latestHeadSha: headSha,
    warnings: [...record.warnings, ...commandWarnings, ...submission.warnings],
    nextAction,
  });
  return {
    schemaVersion: 'lattice.dispatch_run.v1',
    dispatchId: record.dispatchId,
    storyId: record.storyId,
    host: 'fake',
    status: nextStatus,
    parallel: 1,
    runtime: record.runtime,
    workers: [],
    receipt: submission,
    warnings: [...record.warnings, ...commandWarnings, ...submission.warnings],
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

/**
 * Documented attribution constants for the claude-code leaf dispatch usage
 * ledger seam. The dispatch path has no story phase of its own; `agentType` names
 * the seam so usage diagnostics can group claude-code dispatch calls.
 */
const DISPATCH_LEDGER_PHASE = 'dispatch';
const DISPATCH_LEDGER_AGENT_TYPE = 'lattice-dispatch:claude-code';
/** Best-effort model default for the preflight estimate (before the provider reports). */
const DISPATCH_LEDGER_ESTIMATE_MODEL = 'claude-code';

/**
 * Pure spawn-arg builder for the claude-code leaf dispatch. EXTRACTED so the
 * OFF-vs-ON arg shape is unit-testable WITHOUT changing OFF behavior:
 *   - ledger OFF -> exactly ['--print', promptFile] (byte-identical to today);
 *   - ledger ON  -> ['--print', promptFile, '--output-format', 'json'] so the
 *     host emits the JSON envelope we parse for usage.
 * The OFF branch returns the literal original array; the ON branch only APPENDS.
 */
export function buildClaudeSpawnArgs(promptFile: string, ledgerOn: boolean): string[] {
  if (!ledgerOn) return ['--print', promptFile];
  return ['--print', promptFile, '--output-format', 'json'];
}

/** Deterministic projectRootHash for ledger records (sha256 of the root path). */
function dispatchProjectRootHash(root: string): string {
  return `sha256:${createHash('sha256').update(root, 'utf8').digest('hex')}`;
}

/**
 * B-dd44: build the BLOCKED dispatch result when the fail-closed hard-budget
 * guard skips the provider spawn. It MIRRORS the existing exitCode!=0 failure
 * return: writes a `failed` record + a leaf collection, then returns the
 * `lattice.dispatch_run.v1` shape with status `failed`. The block carries a
 * distinct, machine-readable warning prefix so downstream handlers can tell a
 * budget block apart from a provider error / timeout. The provider is NEVER
 * called on this path.
 */
function buildBudgetBlockedDispatchResult(
  root: string,
  record: DispatchRecord,
  pack: HandoffPack,
  budgetPolicyId: string | null,
  hardBudgetTokens: number | null,
  transcriptPath: string,
): DispatchRunResult {
  const baseWarnings = removeScaffoldedOnlyWarnings(record.warnings);
  const policyLabel = budgetPolicyId ?? 'hard-budget';
  const budgetLabel = hardBudgetTokens !== null ? String(hardBudgetTokens) : 'configured';
  const blockedWarning =
    `claude-code dispatch blocked by hard budget (${policyLabel}): ` +
    `preflight estimate exceeds the configured budget of ${budgetLabel} tokens. ` +
    `Provider call skipped (fail-closed); no tokens were spent.`;
  appendTranscript(transcriptPath, [
    `[${nowIso()}] claude-code real subprocess SKIPPED: hard-budget block (${policyLabel})`,
    `[${nowIso()}] ${blockedWarning}`,
  ]);
  const blocked = writeRecord(root, {
    ...record,
    status: 'failed',
    warnings: [...baseWarnings, blockedWarning],
    nextAction:
      `Claude Code dispatch ${record.dispatchId} was blocked before spawn by the hard token budget ` +
      `(${policyLabel}). Raise LATTICE_HARD_BUDGET_TOKENS or reduce the prompt size, then retry. ` +
      `No provider call was made.`,
  });
  writeJson(resolve(root, blocked.collectFile), leafDispatchCollection(root, blocked, pack));
  return {
    schemaVersion: 'lattice.dispatch_run.v1',
    dispatchId: blocked.dispatchId,
    storyId: blocked.storyId,
    host: blocked.selectedHost,
    status: 'failed',
    parallel: blocked.parallel,
    runtime: blocked.runtime,
    workers: [],
    warnings: [...blocked.warnings],
    nextAction: blocked.nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

/**
 * B-ceed: minimal real-leaf dispatch for codex + legacy gemini hosts.
 *
 * Unblocks the upstream live-dispatch story per [[llm-usage-ledger-status]] memory.
 * Mirrors the SCAFFOLDED record shape (status='accepted_local') but actually
 * spawns the host CLI via the bounded provider seam (codex-cli.ts / gemini-cli.ts),
 * captures exit/duration/digests, and writes a real-subprocess transcript line
 * instead of "scaffolded runtime". Out of scope for this story: usage-ledger seam
 * + budget guard plumbing (claude-code parity is the follow-up adapter story).
 */
function runBoundedRealLeafDispatch(
  root: string,
  record: DispatchRecord,
  runtime: HostRuntimeProbe,
  executionPolicy: DispatchCommandExecutionPolicy,
  hostKind: 'codex' | 'gemini',
): DispatchRunResult {
  const startedAt = nowIso();
  const promptFile = resolve(root, record.promptFile);
  const transcriptPath = resolve(root, record.transcriptFile);
  const invocation = runtime.invocationTemplate?.map(part =>
    part === '<prompt-file>' ? promptFile : part === '<worktree>' ? record.worktree.worktreePath : part,
  ) ?? [];
  const argv = invocation.length > 1 ? invocation.slice(1) : [];
  const timeoutMs = Math.ceil(executionPolicy.maxRuntimeMs);
  const runner = hostKind === 'codex' ? runBoundedCodexProvider : runBoundedGeminiProvider;
  const providerEnv = buildCanonicalHostRuntimeEnv(
    executionPolicy,
    record.selectedHost,
    `${record.storyId}:${record.dispatchId}:${hostKind}`,
  );

  // ---- THIN ONE-WAY USAGE-LEDGER SEAM (opt-in; OFF path is byte-identical) ----
  // All new work below is inside `if (ledgerOn)` blocks, so when the flag is OFF
  // this function behaves exactly as before (no preflight, no final, no extra I/O).
  // Each ledger call is fail-open: any error is transcribed non-fatally and the
  // dispatch proceeds. Models the claude seam (runClaudeCodeRealLeafDispatch).
  const ledgerOn = isUsageLedgerEnabled();
  // F-001: do NOT label the codex/gemini preflight estimate as 'claude-code'.
  // Omitting model lets recordDispatchPreflight fall back to DEFAULT_ESTIMATE_MODEL
  // ('unknown') — honest, since the served codex/gemini model is only known AFTER
  // the run, and the final record binds the real result.model via
  // finalContextForProvider. DISPATCH_LEDGER_ESTIMATE_MODEL stays for the claude
  // path (runClaudeCodeRealLeafDispatch) only.
  const ledgerCtx: DispatchUsageContext = {
    storyId: record.storyId,
    phase: DISPATCH_LEDGER_PHASE,
    agentType: `lattice-dispatch:${hostKind}`,
  };
  const ledgerOpts = {
    recordedAt: startedAt,
    projectRootHash: dispatchProjectRootHash(root),
    command: (runtime.invocationTemplate ?? [hostKind]).join(' '),
    host: { kind: record.selectedHost },
    env: process.env,
  };
  let ledgerHandle: ReturnType<typeof recordDispatchPreflight> = null;
  if (ledgerOn) {
    try {
      const promptText = readFileSync(promptFile, 'utf8');
      ledgerHandle = recordDispatchPreflight(root, ledgerCtx, promptText, ledgerOpts);
    } catch (error) {
      appendTranscript(transcriptPath, [
        `[${nowIso()}] usage-ledger preflight skipped (non-fatal): ${String((error as Error)?.message ?? error)}`,
      ]);
    }
  }

  const result = runner({
    provider: hostKind,
    argv,
    cwd: record.worktree.worktreePath,
    timeoutMs,
    maxAttempts: 1,
    env: providerEnv,
  });

  if (ledgerOn) {
    try {
      recordDispatchFinalForProvider(
        root,
        ledgerCtx,
        ledgerHandle?.correlation ?? null,
        ledgerHandle?.estimateRecordId ?? null,
        hostKind === 'codex' ? 'openai' : 'gemini',
        result.reportedUsage,
        result.model ?? null,
        ledgerOpts,
      );
    } catch (error) {
      appendTranscript(transcriptPath, [
        `[${nowIso()}] usage-ledger final skipped (non-fatal): ${String((error as Error)?.message ?? error)}`,
      ]);
    }
  }

  const endedAt = nowIso();
  appendTranscript(transcriptPath, [
    `[${startedAt}] ${hostKind} real subprocess started (worktree ${record.worktree.worktreePath})`,
    `[${endedAt}] exitCode=${result.exitCode ?? 'null'} durationMs=${result.durationMs} spawnError=${result.spawnError} timedOut=${result.timedOut}`,
  ]);
  const status: DispatchLifecycleStatus = result.exitCode === 0 && !result.spawnError && !result.timedOut
    ? 'accepted_local'
    : 'diagnostic';
  const nextAction = status === 'accepted_local'
    ? `${hostKind} real subprocess completed cleanly in ${record.worktree.worktreePath}. Review the transcript before merge planning.`
    : `${hostKind} real subprocess returned exitCode=${result.exitCode ?? 'null'}. Review the transcript and decide whether to retry or escalate.`;
  const updated = writeRecord(root, {
    ...record,
    status,
    nextAction,
    warnings: [...record.warnings],
  });
  return {
    schemaVersion: 'lattice.dispatch_run.v1',
    dispatchId: updated.dispatchId,
    storyId: updated.storyId,
    host: updated.selectedHost,
    status,
    parallel: updated.parallel,
    runtime: updated.runtime,
    workers: [],
    warnings: [...updated.warnings],
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function runCodexRealLeafDispatch(
  root: string,
  record: DispatchRecord,
  runtime: HostRuntimeProbe,
  executionPolicy: DispatchCommandExecutionPolicy,
): DispatchRunResult {
  return runBoundedRealLeafDispatch(root, record, runtime, executionPolicy, 'codex');
}

function runGeminiRealLeafDispatch(
  root: string,
  record: DispatchRecord,
  runtime: HostRuntimeProbe,
  executionPolicy: DispatchCommandExecutionPolicy,
): DispatchRunResult {
  return runBoundedRealLeafDispatch(root, record, runtime, executionPolicy, 'gemini');
}

function runClaudeCodeRealLeafDispatch(
  root: string,
  record: DispatchRecord,
  pack: HandoffPack,
  runtime: HostRuntimeProbe,
  worktreeAbs: string,
  executionPolicy: DispatchCommandExecutionPolicy,
): DispatchRunResult {
  const runnerStartedAt = nowIso();
  const promptFile = resolve(root, record.promptFile);
  assertClaudePrintLauncherAllowed(executionPolicy.commandAllowlist, 'dispatch_run:');
  const commandTemplate = runtime.invocationTemplate ?? ['claude', '--print', '<prompt-file>'];
  const commandLabel = CLAUDE_PRINT_LAUNCHER;
  const transcriptPath = resolve(root, record.transcriptFile);
  const commandEnv = buildRequiredCommandEnv(executionPolicy);
  const timeoutMs = Math.ceil(executionPolicy.maxRuntimeMs);

  // ---- THIN ONE-WAY USAGE-LEDGER SEAM (opt-in; OFF path is byte-identical) ----
  // INV-1: ledgerOn drives the arg shape; when OFF the builder returns the literal
  // original ['--print', promptFile] and stdout is used raw, exactly as before.
  // INV-3: every ledger call below is wrapped in try/catch and proceeds on error.
  const ledgerOn = isUsageLedgerEnabled();
  const ledgerCtx: DispatchUsageContext = {
    storyId: record.storyId,
    phase: DISPATCH_LEDGER_PHASE,
    agentType: DISPATCH_LEDGER_AGENT_TYPE,
    model: DISPATCH_LEDGER_ESTIMATE_MODEL,
  };
  const ledgerOpts = {
    recordedAt: runnerStartedAt,
    projectRootHash: dispatchProjectRootHash(root),
    command: commandLabel,
    host: { kind: record.selectedHost },
    // B-dd44 F-001 fix: thread the real process env explicitly into the ledger +
    // budget path. resolveHardBudget also defaults undefined -> process.env, but
    // passing it here is belt-and-suspenders so the production budget guard reads
    // the real env (the seam never builds a synthetic env object).
    env: process.env,
  };
  let ledgerHandle: ReturnType<typeof recordDispatchPreflight> = null;
  let ledgerPromptText = '';
  if (ledgerOn) {
    try {
      ledgerPromptText = readFileSync(promptFile, 'utf8');
      ledgerHandle = recordDispatchPreflight(root, ledgerCtx, ledgerPromptText, ledgerOpts);
    } catch (error) {
      appendTranscript(transcriptPath, [
        `[${nowIso()}] usage-ledger preflight skipped (non-fatal): ${String((error as Error)?.message ?? error)}`,
      ]);
    }
  }

  // ---- B-dd44: FAIL-CLOSED HARD-BUDGET PRE-SPAWN GUARD (env-gated) ----
  // INV-A: this block only runs when ledgerOn (the existing gate). When the ledger
  //   flag is OFF this is never reached, so dispatch is byte-identical to today.
  // INV-B: recordBudgetBlock returns blocked=true ONLY when a hard budget is
  //   configured AND the preflight estimate strictly exceeds it; otherwise (no
  //   budget env) it is a no-op and we proceed to spawnSync exactly as today.
  // INV-C: all budget work is fail-open on error (recordBudgetBlock never throws
  //   and returns blocked=false on any resolution/build error) — a budget-check
  //   error PROCEEDS and never wrongly blocks.
  if (ledgerOn) {
    const budgetDecision = recordBudgetBlock(
      root,
      ledgerCtx,
      ledgerHandle,
      ledgerPromptText,
      ledgerOpts,
    );
    if (budgetDecision.blocked) {
      // Over budget: SKIP spawnSync and return a well-formed BLOCKED dispatch
      // result, mirroring the exitCode!=0 failure-return shape below.
      return buildBudgetBlockedDispatchResult(
        root,
        record,
        pack,
        budgetDecision.budgetPolicyId,
        budgetDecision.hardBudgetTokens,
        transcriptPath,
      );
    }
  }

  const spawnArgs = buildClaudeSpawnArgs(promptFile, ledgerOn);
  const invocation = ['claude', ...spawnArgs];
  appendTranscript(transcriptPath, [
    `[${nowIso()}] claude-code real subprocess starting`,
    `[${nowIso()}] cwd ${record.worktree.worktreePath} (${worktreeAbs})`,
    `[${nowIso()}] invocation ${invocation.join(' ')}`,
  ]);

  const result = spawnSync('claude', spawnArgs, {
    cwd: worktreeAbs,
    env: commandEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
  const timedOut = spawnTimedOut(result, timeoutMs);
  const exitCode = spawnExitCode(result, timedOut);
  const rawStdout = spawnOutputText(result.stdout).trimEnd();
  // INV-1/INV-2: OFF -> stdout is the raw text, byte-identical to today. ON ->
  // parse the JSON envelope; resultText is the downstream text (raw fallback when
  // the output is not JSON/usage), and the parsed usage feeds the final record.
  let stdout = rawStdout;
  if (ledgerOn) {
    try {
      const parsed = parseClaudeCliOutput(rawStdout);
      stdout = parsed.resultText;
      // INV-5: the provider-reported final supersedes the preflight estimate.
      // Bind the real served model from the envelope (token counts are
      // model-version-specific; diagnostics group by model). recordDispatchFinal
      // falls back to the best-effort default only when parsed.model is null.
      recordDispatchFinal(
        root,
        ledgerCtx,
        ledgerHandle?.correlation ?? null,
        ledgerHandle?.estimateRecordId ?? null,
        parsed.anthropicUsage,
        parsed.model,
        ledgerOpts,
      );
    } catch (error) {
      // Never let a ledger/parse error break dispatch: fall back to raw stdout.
      stdout = rawStdout;
      appendTranscript(transcriptPath, [
        `[${nowIso()}] usage-ledger final skipped (non-fatal): ${String((error as Error)?.message ?? error)}`,
      ]);
    }
  }
  const stderr = spawnOutputText(result.stderr).trimEnd();
  const spawnError = result.error ? String(result.error.message || result.error).trim() : '';
  const runnerEndedAt = nowIso();
  appendTranscript(transcriptPath, [
    `[${nowIso()}] claude-code real subprocess exitCode=${exitCode} timedOut=${timedOut}`,
    ...(stdout ? ['[stdout]', stdout] : ['[stdout]', '(empty)']),
    ...(stderr ? ['[stderr]', stderr] : ['[stderr]', '(empty)']),
    ...(spawnError ? ['[spawn-error]', spawnError] : []),
  ]);

  const runnerRecord = buildClaudeCodeRealRunnerRecord({
    dispatchId: record.dispatchId,
    host: record.selectedHost,
    commandTemplate,
    invocation,
    cwd: record.worktree.worktreePath,
    transcriptPath: record.transcriptFile,
    startedAt: runnerStartedAt,
    endedAt: runnerEndedAt,
    exitCode,
    timedOut,
    env: commandEnv,
  });
  if (record.runnerFile) {
    writeJson(resolve(root, record.runnerFile), runnerRecord);
  }

  const baseWarnings = removeScaffoldedOnlyWarnings(record.warnings);
  if (exitCode !== 0 || timedOut) {
    const providerOutput = compactProcessOutputForWarning(stderr, stdout, spawnError);
    const failureWarning = timedOut
      ? `claude-code real subprocess timed out after ${timeoutMs}ms`
      : providerOutput
        ? `claude-code real subprocess exited non-zero: ${exitCode}; provider output: ${providerOutput}`
        : `claude-code real subprocess exited non-zero: ${exitCode}`;
    const failed = writeRecord(root, {
      ...record,
      status: 'failed',
      warnings: [...baseWarnings, failureWarning],
      nextAction: `Claude Code subprocess failed for ${record.dispatchId}. Inspect ${record.transcriptFile} and the isolated worktree before retrying.`,
    });
    writeJson(resolve(root, failed.collectFile), leafDispatchCollection(root, failed, pack));
    return {
      schemaVersion: 'lattice.dispatch_run.v1',
      dispatchId: failed.dispatchId,
      storyId: failed.storyId,
      host: failed.selectedHost,
      status: 'failed',
      parallel: failed.parallel,
      runtime: failed.runtime,
      workers: [],
      warnings: [...failed.warnings],
      nextAction: failed.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }

  const changedWorktreeFiles = gitStatusPaths(worktreeAbs);
  const allowedChangedFiles = changedWorktreeFiles.filter(path => packAllowsChangedPath(pack, path));
  const outOfScopeChangedFiles = changedWorktreeFiles.filter(path => !packAllowsChangedPath(pack, path));
  if (allowedChangedFiles.length > 0) {
    execFileSync('git', ['add', '-A', '--', ...allowedChangedFiles], {
      cwd: worktreeAbs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      gitOutput(worktreeAbs, ['commit', '-m', `claude-code dispatch ${record.dispatchId}`]);
    } catch {
      gitOutput(worktreeAbs, ['commit', '--allow-empty', '-m', `claude-code dispatch ${record.dispatchId} (empty)`]);
    }
  }

  const headSha = currentGitHead(worktreeAbs);
  if (!headSha) {
    throw new Error(`claude-code dispatch ${record.dispatchId} could not resolve HEAD after subprocess run`);
  }
  const changedFiles = pack.baseSha ? changedFilesBetween(root, pack.baseSha, headSha) : allowedChangedFiles;
  const diagnosticWarnings = [
    ...(allowedChangedFiles.length === 0 ? ['Claude Code subprocess exited 0 but produced no policy-allowed git changes.'] : []),
    ...outOfScopeChangedFiles.map(path => `Claude Code left an unstaged out-of-policy change in the isolated worktree: ${path}`),
  ];
  const receipt = createClaudeCodeReceipt({
    pack,
    record,
    headSha,
    changedFiles,
    command: commandLabel,
    diagnosticWarnings,
  });
  writeJson(resolve(root, record.receiptFile), receipt);
  const submission = submitHandoffReceipt(root, receipt);
  writeJson(resolve(root, record.receiptSubmissionFile), submission);
  const warnings = [...baseWarnings, ...diagnosticWarnings, ...submission.warnings];
  const collection = leafDispatchCollection(root, {
    ...record,
    latestHeadSha: headSha,
    warnings,
  }, pack);
  writeJson(resolve(root, record.collectFile), collection);
  const nextStatus: DispatchLifecycleStatus =
    submission.status === 'accepted-local' ? 'accepted_local' : 'diagnostic';
  const nextAction = submission.status === 'accepted-local'
    ? 'Claude Code subprocess completed with a local diagnostic receipt. Review the isolated diff and transcript manually before merge planning.'
    : submission.nextAction;
  const updated = writeRecord(root, {
    ...record,
    status: nextStatus,
    latestHeadSha: headSha,
    warnings,
    nextAction,
  });
  return {
    schemaVersion: 'lattice.dispatch_run.v1',
    dispatchId: updated.dispatchId,
    storyId: updated.storyId,
    host: updated.selectedHost,
    status: nextStatus,
    parallel: updated.parallel,
    runtime: updated.runtime,
    workers: [],
    receipt: submission,
    warnings: [...updated.warnings],
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function childDispatchArgs(parentPack: HandoffPack, parent: DispatchRecord, workerIndex: number): DispatchPrepareArgs {
  const childId = `${parent.dispatchId}-w${workerIndex + 1}`;
  return {
    storyId: parent.storyId,
    host: 'fake',
    fromHost: parentPack.fromHost,
    role: parentPack.role ? `${parentPack.role}-worker-${workerIndex + 1}` : `worker-${workerIndex + 1}`,
    objective: parentPack.objective ? `${parentPack.objective} (worker ${workerIndex + 1})` : `Worker ${workerIndex + 1}`,
    allowedPaths: parentPack.allowedPaths.length > workerIndex
      ? [parentPack.allowedPaths[workerIndex]]
      : [`.lattice/dispatches/${childId}/worker/fake-result.txt`],
    deniedPaths: [...parentPack.deniedPaths],
    requiredCommands: [...parentPack.requiredCommands],
    successCriteria: [...parentPack.successCriteria],
    baseSha: parentPack.baseSha,
    packId: `${parentPack.packId}-w${workerIndex + 1}`,
    authorityBoundary: parentPack.authorityBoundary.summary,
    executionInstructions: [...parentPack.executionInstructions],
    dispatchId: childId,
    parallel: 1,
  };
}

export function runDispatch(store: StoryStore, root: string, args: DispatchRunArgs): DispatchRunResult {
  const requestedDispatchId = args.dispatchId?.trim() ? normalizeDispatchId(args.dispatchId) : undefined;
  const existing = requestedDispatchId ? readRecord(root, requestedDispatchId) : null;
  const record = existing ?? prepareDispatch(store, root, args);
  if (resolveEffectiveStatus(record) === 'expired') {
    const expired = writeRecord(root, { ...record, status: 'expired', nextAction: 'Dispatch expired. Run dispatch_resume to refresh metadata and rerun it.' });
    return {
      schemaVersion: 'lattice.dispatch_run.v1',
      dispatchId: expired.dispatchId,
      storyId: expired.storyId,
      host: expired.selectedHost,
      status: 'expired',
      parallel: expired.parallel,
      runtime: expired.runtime,
      workers: [],
      warnings: [...expired.warnings],
      nextAction: expired.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }

  if (record.selectedHost === 'fake' && record.parallel > 1 && record.workerIds.length === 0) {
    const pack = readPack(root, record.dispatchId);
    const workers: DispatchRunResult[] = [];
    const workerIds: string[] = [];
    for (let index = 0; index < record.parallel; index += 1) {
      const childArgs = childDispatchArgs(pack, record, index);
      const childRecord = prepareDispatch(store, root, { ...childArgs });
      workerIds.push(childRecord.dispatchId);
      workers.push(runFakeLeafDispatch(store, root, childRecord, args.executionPolicy));
    }
    const aggregate = aggregateStatus(workers.map(worker => worker.status));
    const warnings = workers.flatMap(worker => worker.warnings);
    const nextAction = aggregate === 'accepted_local'
      ? 'All fake workers completed with local accepted receipts. Review each isolated worker diff manually before any merge.'
      : 'At least one fake worker did not complete cleanly. Review worker receipts/status before attempting merge guidance.';
    const updated = writeRecord(root, {
      ...record,
      status: aggregate,
      workerIds,
      warnings: [...record.warnings, ...warnings],
      nextAction,
    });
    return {
      schemaVersion: 'lattice.dispatch_run.v1',
      dispatchId: updated.dispatchId,
      storyId: updated.storyId,
      host: 'fake',
      status: aggregate,
      parallel: updated.parallel,
      runtime: updated.runtime,
      workers,
      warnings: [...updated.warnings],
      nextAction: updated.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }

  if (record.selectedHost === 'fake') {
    return runFakeLeafDispatch(store, root, record, args.executionPolicy);
  }

  const runtime = record.runtime;
  if (!runtime.available) {
    const refusalReasons = [
      ...runtime.warnings,
      ...runtime.unattendedReasons,
      `Host ${runtime.host} is not available; run refused.`,
    ];
    const refusedRunner = buildRefusedRunnerRecord({
      dispatchId: record.dispatchId,
      host: record.selectedHost,
      commandTemplate: runtime.invocationTemplate ?? [],
      cwd: record.worktree.worktreePath,
      transcriptPath: record.transcriptFile,
      refusalReasons,
    });
    if (record.runnerFile) {
      writeJson(resolve(root, record.runnerFile), refusedRunner);
    }
    const updated = writeRecord(root, {
      ...record,
      status: 'unavailable',
      nextAction: runtime.nextAction,
      warnings: [...record.warnings, ...runtime.warnings],
    });
    return {
      schemaVersion: 'lattice.dispatch_run.v1',
      dispatchId: updated.dispatchId,
      storyId: updated.storyId,
      host: updated.selectedHost,
      status: updated.status,
      parallel: updated.parallel,
      runtime: updated.runtime,
      workers: [],
      warnings: [...updated.warnings],
      nextAction: updated.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }
  let pack = readPack(root, record.dispatchId);
  pack = normalizePackPaths(root, record.dispatchId, resolve(root, record.worktree.worktreePath), pack);
  const baseRef = pack.baseSha ?? 'HEAD';
  const worktreeAbsPath = resolve(root, record.worktree.worktreePath);
  const worktreeCreatedThisRun = !existsSync(worktreeAbsPath);
  // B-75f0 CHK-001: resolve the authoritative git cwd from the real record.storyId
  // once, then thread it into ensureWorktree + cleanupCreatedWorktree below.
  const runGitCwd = resolveGitCwd({ store, storyId: record.storyId, metadataRoot: root, projectRoot: root });
  let worktreeAbs: string;
  try {
    worktreeAbs = ensureWorktree(root, runGitCwd, record.worktree.worktreePath, record.worktree.branch, baseRef);
  } catch (error: any) {
    const detail = String(error?.message || error).trim();
    appendTranscript(resolve(root, record.transcriptFile), [
      `[${nowIso()}] scaffolded runtime ${runtime.host} failed to create worktree`,
      detail,
    ]);
    const warnings = [...record.warnings, ...runtime.warnings, `Worktree creation failed: ${detail}`];
    const nextAction = `Dispatch scaffold could not create ${record.worktree.worktreePath}. Resolve the git worktree error, then rerun dispatch_run for ${record.dispatchId}.`;
    const failed = writeRecord(root, {
      ...record,
      status: 'failed',
      warnings,
      nextAction,
    });
    return {
      schemaVersion: 'lattice.dispatch_run.v1',
      dispatchId: failed.dispatchId,
      storyId: failed.storyId,
      host: failed.selectedHost,
      status: failed.status,
      parallel: failed.parallel,
      runtime: failed.runtime,
      workers: [],
      warnings: [...failed.warnings],
      nextAction: failed.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
      };
  }
  try {
    pack = normalizePackPaths(root, record.dispatchId, worktreeAbs, pack, 'canonical');
  } catch (error: any) {
    const detail = String(error?.message || error).trim();
    const cleanupWarnings = worktreeCreatedThisRun
      ? cleanupCreatedWorktree(root, runGitCwd, record.worktree.worktreePath, record.worktree.branch)
      : [];
    appendTranscript(resolve(root, record.transcriptFile), [
      `[${nowIso()}] scaffolded runtime ${runtime.host} canonical pack-path validation failed`,
      detail,
      ...cleanupWarnings.map(warning => `[${nowIso()}] ${warning}`),
    ]);
    const warnings = [
      ...record.warnings,
      ...runtime.warnings,
      `Canonical pack-path validation failed: ${detail}`,
      ...cleanupWarnings,
    ];
    const nextAction = worktreeCreatedThisRun
      ? `Dispatch scaffold was rolled back after canonical pack-path validation failed. Fix the allowed/denied paths for ${record.dispatchId}, then rerun dispatch_run.`
      : `Canonical pack-path validation failed for ${record.dispatchId}. Fix the allowed/denied paths, verify the existing worktree at ${record.worktree.worktreePath}, then rerun dispatch_run.`;
    const failed = writeRecord(root, {
      ...record,
      status: 'failed',
      warnings,
      nextAction,
    });
    return {
      schemaVersion: 'lattice.dispatch_run.v1',
      dispatchId: failed.dispatchId,
      storyId: failed.storyId,
      host: failed.selectedHost,
      status: failed.status,
      parallel: failed.parallel,
      runtime: failed.runtime,
      workers: [],
      warnings: [...failed.warnings],
      nextAction: failed.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }
  if (record.selectedHost === 'claude-code' && args.allowRealHostSubprocess === true && args.executionPolicy) {
    return runClaudeCodeRealLeafDispatch(root, record, pack, runtime, worktreeAbs, args.executionPolicy);
  }
  // B-ceed: codex + legacy gemini real-host live dispatch when CLI is available.
  // When the requested CLI is NOT in PATH, fall back to claude-code real dispatch
  // (per user (a3) decision 2026-06-17) with a logged degradation reason.
  if (record.selectedHost === 'codex' && args.allowRealHostSubprocess === true && args.executionPolicy) {
    if (codexCliAvailable()) {
      return runCodexRealLeafDispatch(root, record, runtime, args.executionPolicy);
    }
    appendTranscript(resolve(root, record.transcriptFile), [
      `[${nowIso()}] codex CLI unavailable in PATH; falling back to claude-code real dispatch (B-ceed fallback policy)`,
    ]);
    return runClaudeCodeRealLeafDispatch(root, record, pack, runtime, worktreeAbs, args.executionPolicy);
  }
  if (record.selectedHost === 'gemini' && args.allowRealHostSubprocess === true && args.executionPolicy) {
    if (geminiCliAvailable()) {
      return runGeminiRealLeafDispatch(root, record, runtime, args.executionPolicy);
    }
    appendTranscript(resolve(root, record.transcriptFile), [
      `[${nowIso()}] gemini CLI unavailable in PATH; falling back to claude-code real dispatch (B-ceed fallback policy)`,
    ]);
    return runClaudeCodeRealLeafDispatch(root, record, pack, runtime, worktreeAbs, args.executionPolicy);
  }
  const scaffoldStartedAt = nowIso();
  const promptFile = resolve(root, record.promptFile);
  const invocation = runtime.invocationTemplate?.map(part =>
    part === '<prompt-file>' ? promptFile : part === '<worktree>' ? record.worktree.worktreePath : part,
  ) ?? [];
  appendTranscript(resolve(root, record.transcriptFile), [
    `[${nowIso()}] scaffolded runtime ${runtime.host}`,
    `[${nowIso()}] worktree ready ${record.worktree.worktreePath} (${worktreeAbs})`,
    invocation.length > 0 ? invocation.join(' ') : '(no invocation template)',
  ]);
  const status: DispatchLifecycleStatus = 'needs_receipt';
  const nextAction = `Manual-first only. Worktree is ready at ${record.worktree.worktreePath}. Run ${invocation.join(' ')} there, then return a local receipt via dispatch_collect/dispatch_receipt_create.`;
  const scaffoldedRunner = buildScaffoldedRunnerRecord({
    dispatchId: record.dispatchId,
    host: record.selectedHost,
    commandTemplate: runtime.invocationTemplate ?? [],
    invocation,
    cwd: record.worktree.worktreePath,
    transcriptPath: record.transcriptFile,
    startedAt: scaffoldStartedAt,
    endedAt: nowIso(),
  });
  if (record.runnerFile) {
    writeJson(resolve(root, record.runnerFile), scaffoldedRunner);
  }
  const updated = writeRecord(root, {
    ...record,
    status,
    nextAction,
    warnings: [...record.warnings, ...runtime.warnings],
  });
  return {
    schemaVersion: 'lattice.dispatch_run.v1',
    dispatchId: updated.dispatchId,
    storyId: updated.storyId,
    host: updated.selectedHost,
    status,
    parallel: updated.parallel,
    runtime: updated.runtime,
    workers: [],
    warnings: [...updated.warnings],
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function collectDispatch(root: string, dispatchId: string, options: CollectDispatchOptions = {}): DispatchCollection {
  const record = readRecord(root, dispatchId);
  if (record.workerIds.length > 0) {
    const aggregate = aggregateWorkerCollections(root, record, options);
    if (options.persist !== false) writeJson(resolve(root, record.collectFile), aggregate);
    return aggregate;
  }
  const pack = readPack(root, dispatchId);
  const result = leafDispatchCollection(root, record, pack);
  if (options.persist !== false) writeJson(resolve(root, record.collectFile), result);
  return result;
}

export function createDispatchReceipt(root: string, dispatchId: string): DispatchReceiptDraft {
  const record = readRecord(root, dispatchId);
  if (record.workerIds.length > 0) {
    throw new Error(`dispatch_receipt_create only supports leaf dispatches. ${dispatchId} is a parent dispatch; inspect workerIds instead.`);
  }
  const pack = readPack(root, dispatchId);
  const collection = collectDispatch(root, dispatchId);
  const warnings = [...collection.warnings];
  const receipt: HandoffReceipt = {
    schemaVersion: 'lattice.handoff_receipt.v1',
    storyId: record.storyId,
    host: dispatchReceiptHost(record, pack),
    packId: pack.packId,
    packHash: pack.packHash,
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    ...(pack.baseSha ? { baseSha: pack.baseSha } : {}),
    ...(pack.role ? { role: pack.role } : {}),
    ...(pack.objective ? { objective: pack.objective } : {}),
    allowedPaths: [...pack.allowedPaths],
    deniedPaths: [...pack.deniedPaths],
    requiredCommands: [...pack.requiredCommands],
    successCriteria: [...pack.successCriteria],
    authorityBoundary: pack.authorityBoundary,
    executionInstructions: [...pack.executionInstructions],
    headSha: collection.headSha ?? '',
    changedFiles: [...collection.changedFiles],
    commands: [...collection.commands],
    verdict: collection.changedFiles.length > 0 ? 'pass' : 'warn',
    summary: `Dispatch ${dispatchId} draft receipt generated from git-derived collect data.`,
    limitations: [
      ...collection.limitations,
      'Draft receipt only: receiptVerified=false, authorityChanged=false, productionDone=false.',
    ],
  };
  writeJson(resolve(root, record.receiptFile), receipt);
  return {
    schemaVersion: 'lattice.dispatch_receipt_create.v1',
    dispatchId,
    status: collection.changedFiles.length > 0 ? 'created' : 'diagnostic',
    receipt,
    warnings,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function maybeReadReceiptSubmission(root: string, record: DispatchRecord): HandoffReceiptSubmission | undefined {
  return maybeReadJson<HandoffReceiptSubmission>(resolve(root, record.receiptSubmissionFile));
}

function maybeReadRunnerRecord(root: string, record: DispatchRecord): DispatchRunnerRecord | undefined {
  if (!record.runnerFile) return undefined;
  return maybeReadJson<DispatchRunnerRecord>(resolve(root, record.runnerFile));
}

export function dispatchStatus(root: string, dispatchId: string): DispatchStatusResult {
  const record = readRecord(root, dispatchId);
  const effectiveStatus = resolveEffectiveStatus(record);
  const current = effectiveStatus === record.status ? record : { ...record, status: effectiveStatus };
  const runner = maybeReadRunnerRecord(root, current);
  return {
    schemaVersion: 'lattice.dispatch_status.v1',
    dispatch: current,
    receipt: maybeReadReceiptSubmission(root, current),
    ...(runner !== undefined ? { runner } : {}),
    workers: current.workerIds.map(workerId => dispatchStatus(root, workerId)),
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function listDispatches(root: string, storyId?: string): DispatchListResult {
  const storageRoot = dispatchStorageRoot(root);
  if (!existsSync(storageRoot)) {
    return {
      schemaVersion: 'lattice.dispatch_list.v1',
      dispatches: [],
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }
  const dispatches = readdirSync(storageRoot)
    .filter(entry => existsSync(join(storageRoot, entry, 'dispatch.json')))
    .map(entry => readRecord(root, entry))
    .filter(record => !storyId || record.storyId === storyId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map(record => ({
      dispatchId: record.dispatchId,
      storyId: record.storyId,
      host: record.selectedHost,
      status: resolveEffectiveStatus(record),
      parallel: record.parallel,
      updatedAt: record.updatedAt,
    }));
  return {
    schemaVersion: 'lattice.dispatch_list.v1',
    dispatches,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function resumeDispatch(store: StoryStore, root: string, dispatchId: string): DispatchRunResult {
  const record = readRecord(root, dispatchId);
  if (record.status === 'cancelled') {
    const resumed = writeRecord(root, { ...record, status: 'prepared', cancelledAt: undefined, nextAction: 'Dispatch resumed. Rerun dispatch_run to continue.' });
    return runDispatch(store, root, { dispatchId: resumed.dispatchId, storyId: resumed.storyId, host: resumed.selectedHost });
  }
  return runDispatch(store, root, { dispatchId: record.dispatchId, storyId: record.storyId, host: record.selectedHost });
}

export function cancelDispatch(root: string, dispatchId: string): DispatchStatusResult {
  const record = readRecord(root, dispatchId);
  const updated = writeRecord(root, {
    ...record,
    status: 'cancelled',
    cancelledAt: nowIso(),
    nextAction: 'Dispatch cancelled. Review or clean up the isolated worktree manually; no authority state changed.',
  });
  return dispatchStatus(root, updated.dispatchId);
}

function normalizeReceiptSubmissionAuthority(sub: HandoffReceiptSubmission): HandoffReceiptSubmission {
  return {
    ...sub,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function reviewDispatch(root: string, dispatchId: string): DispatchReviewResult {
  const status = dispatchStatus(root, dispatchId);
  // Normalize receipt to ensure forged authority fields in persisted files cannot surface as true.
  const receipt = status.receipt ? normalizeReceiptSubmissionAuthority(status.receipt) : undefined;
  if (status.dispatch.workerIds.length > 0) {
    const workers = status.workers.map(worker => reviewDispatch(root, worker.dispatch.dispatchId));
    const warnings = workers.flatMap(worker => worker.warnings);
    const risks = workers.flatMap(worker => worker.risks);
    const transcriptPath = status.dispatch.transcriptFile;
    const transcriptAbsPath = resolve(root, transcriptPath);
    const transcriptExists = existsSync(transcriptAbsPath) && (statSync(transcriptAbsPath).size > 0);
    const localReceiptStatus: DispatchReviewResult['localReceiptStatus'] =
      workers.some(w => w.localReceiptStatus === 'accepted-local')
        ? workers.every(w => w.localReceiptStatus === 'accepted-local') ? 'accepted-local' : 'diagnostic'
        : workers.some(w => w.localReceiptStatus === 'diagnostic') ? 'diagnostic' : 'missing';
    return {
      schemaVersion: 'lattice.dispatch_review.v1',
      dispatchId,
      storyId: status.dispatch.storyId,
      status: aggregateStatus(workers.map(worker => worker.status)),
      changedFiles: [...new Set(workers.flatMap(worker => worker.changedFiles))].sort(),
      commands: [...new Set(workers.flatMap(worker => worker.commands))],
      transcriptPath,
      transcriptExists,
      localReceiptStatus,
      workers,
      warnings,
      risks,
      nextAction: status.dispatch.status === 'accepted_local'
        ? 'Parallel dispatch review is ready. Inspect each worker receipt and diff manually before merge planning.'
        : 'Parallel dispatch review found non-accepted workers. Resolve warnings before merge planning.',
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }
  const collection = collectDispatch(root, dispatchId, { persist: false });
  const transcriptPath = status.dispatch.transcriptFile;
  const transcriptAbsPath = resolve(root, transcriptPath);
  // transcriptExists is true only when the transcript file has been written to (non-empty).
  // The placeholder file is created during dispatch_prepare; actual content means the dispatch ran.
  const transcriptExists = existsSync(transcriptAbsPath) && (statSync(transcriptAbsPath).size > 0);
  const runner = status.runner;
  const runnerSummary: DispatchReviewRunnerSummary | undefined = runner ? {
    runnerKind: runner.runnerKind,
    cwd: runner.cwd,
    transcriptPath: runner.transcriptPath,
    ...(runner.exitCode !== undefined ? { exitCode: runner.exitCode } : {}),
    timedOut: runner.timedOut,
    commandTemplate: [...runner.commandTemplate],
  } : undefined;
  const localReceiptStatus: DispatchReviewResult['localReceiptStatus'] = receipt
    ? (receipt.status === 'accepted-local' ? 'accepted-local' : 'diagnostic')
    : 'missing';
  const risks = [
    ...(status.dispatch.status === 'accepted_local' ? [] : [`dispatch status=${status.dispatch.status}`]),
    ...(receipt?.status === 'accepted-local' ? [] : ['receipt is diagnostic-only or missing']),
    ...(collection.changedFiles.length > 0 ? [] : ['no git-derived changedFiles collected']),
    ...(!transcriptExists ? ['transcript file missing or not yet written'] : []),
  ];
  return {
    schemaVersion: 'lattice.dispatch_review.v1',
    dispatchId,
    storyId: status.dispatch.storyId,
    status: status.dispatch.status,
    changedFiles: collection.changedFiles,
    commands: collection.commands,
    transcriptPath,
    transcriptExists,
    ...(runnerSummary ? { runnerSummary } : {}),
    localReceiptStatus,
    ...(receipt ? { receipt } : {}),
    workers: [],
    warnings: [...status.dispatch.warnings, ...collection.warnings, ...(receipt?.warnings ?? [])],
    risks,
    nextAction: status.dispatch.status === 'accepted_local'
      ? 'Review the isolated overflow diff and local receipt manually; merge remains manual-only.'
      : status.dispatch.nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function buildDispatchMergePlan(root: string, dispatchId: string): DispatchMergePlanResult {
  const status = dispatchStatus(root, dispatchId);
  const workerRecords = status.dispatch.workerIds.length > 0
    ? status.workers.map(w => w.dispatch)
    : [status.dispatch];
  const workers = workerRecords.map(record => ({
    dispatchId: record.dispatchId,
    status: record.status,
    reviewCommand: record.worktree.reviewCommand,
    cleanupCommand: record.worktree.cleanupCommand,
  }));
  const allLifecycleAccepted = workers.every(worker => worker.status === 'accepted_local');
  // Defense in depth: verify accepted-local receipts actually exist on disk, not just lifecycle status.
  // This prevents a forged or mutated receipt file from making mergeable=true after an invalid run.
  const allReceiptsAccepted = workerRecords.every(record => {
    const sub = maybeReadReceiptSubmission(root, record);
    return sub?.status === 'accepted-local';
  });
  const mergeable = allLifecycleAccepted && allReceiptsAccepted;
  const receiptMismatch = allLifecycleAccepted && !allReceiptsAccepted;
  const commands = mergeable
    ? workers.flatMap(worker => [`${worker.reviewCommand}`, `${worker.cleanupCommand}`])
    : [];
  const warnings: string[] = [];
  if (mergeable) {
    warnings.push('Manual merge only: review each isolated worker diff and cherry-pick/merge by hand if accepted.');
  } else if (receiptMismatch) {
    warnings.push('Lifecycle status shows accepted_local but accepted-local receipt(s) are missing or diagnostic. Manual investigation required before merge.');
  } else {
    warnings.push('Normal merge guidance is withheld because the dispatch is not accepted_local across all required workers.');
  }
  return {
    schemaVersion: 'lattice.dispatch_merge_plan.v1',
    dispatchId,
    storyId: status.dispatch.storyId,
    status: status.dispatch.status,
    mergeable,
    manualOnly: true,
    workers,
    commands,
    warnings,
    nextAction: mergeable
      ? 'Manual merge only. Review diffs, receipt diagnostics, and required command output before merging anything back.'
      : status.dispatch.nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function overflowAuto(
  store: StoryStore,
  root: string,
  args: DispatchRunArgs & { approve?: boolean; start?: boolean },
): DispatchPlanResult | DispatchRunResult {
  const plan = computePlan(store, root, { ...args, host: args.host ?? 'auto' });
  if (args.start === true && args.approve === true) {
    return runDispatch(store, root, {
      ...args,
      host: plan.selectedHost,
    });
  }
  const gatingWarning = args.start === true
    ? 'overflow_auto received start=true without approve=true; staying in suggest-only mode.'
    : args.approve === true
      ? 'overflow_auto received approve=true without start=true; staying in suggest-only mode.'
      : 'overflow_auto defaulted to suggest-only mode; no host was started.';
  return {
    ...plan,
    warnings: [
      ...plan.warnings,
      gatingWarning,
    ],
    nextAction: plan.selectedHost === 'fake'
      ? 'Run overflow_auto --approve=true --start=true or dispatch_run --host=fake to execute the deterministic local harness. For policy-authorized unattended scheduling, use dispatch_auto --policy=<name>.'
      : 'Review the suggested host and rerun with --approve=true --start=true if you want to materialize dispatch metadata. For policy-authorized unattended scheduling, use dispatch_auto --policy=<name>.',
  };
}

function pathIsWithinScope(candidate: string, scope: string): boolean {
  if (scope === '.') return true;
  return candidate === scope || candidate.startsWith(`${scope}/`);
}

function pathsOverlap(left: string, right: string): boolean {
  return pathIsWithinScope(left, right) || pathIsWithinScope(right, left);
}

function normalizePolicyPaths(
  root: string,
  storyId: string,
  policy: DispatchPolicy,
): { allowedPaths: string[]; deniedPaths: string[] } {
  const packId = `dispatch-auto-policy-${sanitizeSegment(policy.policy)}`;
  return {
    allowedPaths: normalizePackPathList(root, storyId, packId, policy.allowedPaths, 'allowedPaths'),
    deniedPaths: normalizePackPathList(root, storyId, packId, policy.deniedPaths, 'deniedPaths'),
  };
}

function defaultAllowedPathForPolicyScope(root: string, rawScope: string, normalizedScope: string, index: number): string {
  if (normalizedScope === '.') return `dispatch-auto-result-${index + 1}.txt`;
  const trimmed = rawScope.trim();
  const rootCandidate = resolve(root, normalizedScope);
  const isDirectoryScope = trimmed.endsWith('/') || trimmed.endsWith('\\')
    || (existsSync(rootCandidate) && statSync(rootCandidate).isDirectory());
  return isDirectoryScope
    ? `${normalizedScope}/dispatch-auto-result-${index + 1}.txt`
    : normalizedScope;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function bindDispatchAutoPathsToPolicy(
  root: string,
  args: DispatchRunArgs,
  policy: DispatchPolicy,
): Pick<DispatchRunArgs, 'allowedPaths' | 'deniedPaths'> {
  const policyPaths = normalizePolicyPaths(root, args.storyId, policy);
  const packId = args.packId?.trim() || `dispatch-auto-request-${sanitizeSegment(args.storyId)}`;
  const requestedAllowedPaths = normalizePackPathList(root, args.storyId, packId, args.allowedPaths, 'allowedPaths');
  const requestedDeniedPaths = normalizePackPathList(root, args.storyId, packId, args.deniedPaths, 'deniedPaths');
  const effectiveAllowedPaths = requestedAllowedPaths.length > 0
    ? requestedAllowedPaths
    : policyPaths.allowedPaths.map((allowedPath, index) =>
      defaultAllowedPathForPolicyScope(root, policy.allowedPaths[index] ?? allowedPath, allowedPath, index));

  const errors: string[] = [];
  for (const [index, allowedPath] of effectiveAllowedPaths.entries()) {
    if (!policyPaths.allowedPaths.some(policyAllowed => pathIsWithinScope(allowedPath, policyAllowed))) {
      errors.push(
        `allowedPaths[${index}] "${allowedPath}" is outside policy "${policy.policy}" allowedPaths (${policy.allowedPaths.join(', ')})`,
      );
    }
    const deniedOverlap = policyPaths.deniedPaths.find(policyDenied => pathsOverlap(allowedPath, policyDenied));
    if (deniedOverlap) {
      errors.push(
        `allowedPaths[${index}] "${allowedPath}" overlaps policy "${policy.policy}" deniedPaths entry "${deniedOverlap}"`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`dispatch_auto refused by policy scope:\n${errors.map(error => `  - ${error}`).join('\n')}`);
  }

  return {
    allowedPaths: effectiveAllowedPaths,
    deniedPaths: uniqueStrings([...policyPaths.deniedPaths, ...requestedDeniedPaths]),
  };
}

function bindDispatchAutoCommandsToPolicy(args: DispatchRunArgs, policy: DispatchPolicy): string[] {
  const requiredCommands = normalizeList(args.requiredCommands);
  const allowedCommands = new Set(normalizeList(policy.commandAllowlist));
  const refused = requiredCommands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => !allowedCommands.has(command));
  if (refused.length > 0) {
    throw new Error(
      `dispatch_auto refused by policy commandAllowlist:\n${refused.map(({ command, index }) =>
        `  - requiredCommands[${index}] "${command}" is not in policy "${policy.policy}" commandAllowlist`).join('\n')}`,
    );
  }
  return requiredCommands;
}

function buildDispatchCommandExecutionPolicy(policy: DispatchPolicy): DispatchCommandExecutionPolicy {
  return {
    envAllowlist: normalizeList(policy.envAllowlist),
    envDenylist: normalizeList(policy.envDenylist),
    commandAllowlist: normalizeList(policy.commandAllowlist),
    maxRuntimeMs: policy.maxRuntimeMinutes * 60 * 1000,
  };
}

function policyAllowsRealHostSubprocess(policy: DispatchPolicy): boolean {
  return (policy as DispatchPolicy & { allowRealHostSubprocess?: boolean }).allowRealHostSubprocess === true;
}

function bindDispatchAutoArgsToPolicy(
  root: string,
  args: DispatchRunArgs,
  selectedHost: HostRuntimeId,
  policy: DispatchPolicy,
): DispatchRunArgs {
  const paths = bindDispatchAutoPathsToPolicy(root, args, policy);
  const requiredCommands = bindDispatchAutoCommandsToPolicy(args, policy);
  return {
    ...args,
    host: selectedHost,
    allowedPaths: paths.allowedPaths,
    deniedPaths: paths.deniedPaths,
    requiredCommands,
    executionPolicy: buildDispatchCommandExecutionPolicy(policy),
    // B-ceed: live dispatch exists for codex + legacy gemini in addition to
    // claude-code. The dispatch_run switch routes the requested host to its real
    // leaf when the CLI is available, and falls back to the claude-code real
    // leaf otherwise. policyAllowsRealHostSubprocess() still gates the whole
    // mechanism so unattended execution requires explicit policy authorization.
    allowRealHostSubprocess:
      (selectedHost === 'claude-code' || selectedHost === 'codex' || selectedHost === 'gemini')
      && policyAllowsRealHostSubprocess(policy),
  };
}

type DispatchAutoArgs = DispatchRunArgs & {
  policy: string;
};

export function dispatchAuto(store: StoryStore, root: string, args: DispatchAutoArgs): DispatchAutoResult {
  const policyName = (args.policy ?? '').trim();
  if (!policyName) {
    throw new Error('dispatch_auto requires a policy name; set --policy=<name> to authorize unattended scheduling.');
  }

  let policyCheck: DispatchPolicyCheckResult;
  try {
    policyCheck = checkDispatchPolicy(root, policyName);
  } catch (error: any) {
    throw new Error(`dispatch_auto: policy "${policyName}" could not be loaded: ${String(error?.message || error)}`);
  }

  if (policyCheck.status === 'refused') {
    throw new Error(
      `dispatch_auto refused by policy "${policyName}":\n${policyCheck.reasons.map(r => `  - ${r}`).join('\n')}\n${policyCheck.nextAction}`,
    );
  }

  const policy = policyCheck.normalizedPolicy;

  const requestedHost = args.host?.trim();
  let selectedHost: HostRuntimeId;
  if (requestedHost) {
    const normalized = normalizeHostRuntimeId(requestedHost);
    if (!normalized) {
      throw new Error(`dispatch_auto: unknown host "${requestedHost}"; must be ${CURRENT_HOST_RUNTIME_DESCRIPTION} (${LEGACY_HOST_RUNTIME_DESCRIPTION})`);
    }
    selectedHost = normalized;
  } else {
    const firstAllowed = policy.allowedHosts
      .map(h => normalizeHostRuntimeId(h))
      .find((n): n is HostRuntimeId => n !== null);
    selectedHost = firstAllowed ?? 'fake';
  }

  if (!policy.allowedHosts.includes(selectedHost)) {
    throw new Error(
      `dispatch_auto: host "${selectedHost}" is not in policy "${policyName}" allowedHosts (${policy.allowedHosts.join(', ')}); only policy-allowed hosts may be scheduled.`,
    );
  }

  const constrainedArgs = bindDispatchAutoArgsToPolicy(root, args, selectedHost, policy);

  const existing = listDispatches(root, args.storyId);
  const activeCount = existing.dispatches.filter(d => !TERMINAL_DISPATCH_STATUSES.has(d.status)).length;
  if (activeCount >= policy.maxParallel) {
    throw new Error(
      `dispatch_auto: maxParallel limit (${policy.maxParallel}) reached; ${activeCount} active dispatch(es) found for story ${args.storyId}. Cancel or resolve existing dispatches before starting new ones.`,
    );
  }

  if (!policyCheck.authorized) {
    throw new Error(
      `dispatch_auto: policy "${policyName}" is supervised-only and cannot authorize unattended scheduling. ${policyCheck.nextAction}`,
    );
  }

  if (selectedHost !== 'fake') {
    const probe = probeHostRuntime(selectedHost);
    if (!probe.available) {
      throw new Error(
        `dispatch_auto: host "${selectedHost}" is not available in PATH; install or expose ${probe.cliCommand ?? selectedHost} and retry, or use host=fake for deterministic local coverage.`,
      );
    }
    // B-ceed: codex + legacy gemini live dispatch is wired through the dispatch_run
    // switch. Antigravity is first-class for supervised dispatch metadata, but it
    // has no bounded agy subprocess runner yet, so dispatch_auto must refuse it.
    if (selectedHost !== 'claude-code' && selectedHost !== 'codex' && selectedHost !== 'gemini') {
      throw new Error(
        `dispatch_auto: host "${selectedHost}" is not unattended-safe (unattendedSafe=false). Antigravity has supervised metadata support but no bounded agy runner yet; use host=fake for deterministic local coverage.`,
      );
    }
    if (!policyAllowsRealHostSubprocess(policy)) {
      throw new Error(
        `dispatch_auto: host "${selectedHost}" is not unattended-safe (unattendedSafe=false). Policy "${policyName}" must set allowRealHostSubprocess=true before Proofbound may start claude --print.`,
      );
    }
    if (probe.noninteractiveSupport !== 'supported') {
      throw new Error(
        `dispatch_auto: host "${selectedHost}" is not unattended-safe (unattendedSafe=false). claude --print support is ${probe.noninteractiveSupport}; refusing real subprocess launch.`,
      );
    }
    assertClaudePrintLauncherAllowed(policy.commandAllowlist, 'dispatch_auto:');
  }

  const parallel = Math.min(Math.max(1, args.parallel ?? 1), policy.maxParallel);
  const runResult = runDispatch(store, root, { ...constrainedArgs, parallel });

  function convertToAutoResult(worker: DispatchRunResult): DispatchAutoResult {
    return {
      schemaVersion: 'lattice.dispatch_auto.v1',
      dispatchId: worker.dispatchId,
      storyId: worker.storyId,
      host: worker.host,
      status: worker.status,
      parallel: worker.parallel,
      policy: policyName,
      workers: worker.workers.map(convertToAutoResult),
      warnings: [...worker.warnings],
      nextAction: worker.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }

  return convertToAutoResult(runResult);
}

export function dispatchWatch(root: string, dispatchId: string): DispatchWatchResult {
  const status = dispatchStatus(root, dispatchId);
  const record = status.dispatch;
  const effectiveStatus = record.status;

  const runnerSummary = status.runner
    ? {
      runnerKind: status.runner.runnerKind,
      cwd: status.runner.cwd,
      ...(status.runner.exitCode !== undefined ? { exitCode: status.runner.exitCode } : {}),
      timedOut: status.runner.timedOut,
      transcriptPath: status.runner.transcriptPath,
    }
    : undefined;

  let changedFilesCount: number | undefined;
  try {
    const collection = collectDispatch(root, dispatchId, { persist: false });
    if (collection.changedFiles.length > 0) {
      changedFilesCount = collection.changedFiles.length;
    }
  } catch {
    // changedFilesCount remains undefined if collection fails
  }

  const workers: DispatchWatchWorkerSummary[] = status.workers.map(worker => ({
    dispatchId: worker.dispatch.dispatchId,
    status: worker.dispatch.status,
    ...(worker.runner ? { runnerKind: worker.runner.runnerKind } : {}),
  }));

  const nextAction = TERMINAL_DISPATCH_STATUSES.has(effectiveStatus)
    ? record.nextAction
    : effectiveStatus === 'accepted_local'
      ? 'Dispatch completed with local accepted receipt. Run dispatch_review or dispatch_merge_plan to inspect evidence before any merge.'
      : record.nextAction;

  return {
    schemaVersion: 'lattice.dispatch_watch.v1',
    dispatchId: record.dispatchId,
    storyId: record.storyId,
    status: effectiveStatus,
    workers,
    ...(runnerSummary !== undefined ? { runnerSummary } : {}),
    ...(changedFilesCount !== undefined ? { changedFilesCount } : {}),
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function summaryLine(record: DispatchRecord): string {
  return `${record.dispatchId} ${record.storyId} host=${record.selectedHost} status=${record.status} parallel=${record.parallel}`;
}

export function renderHostRuntimeListText(result: HostRuntimeList): string {
  return [
    `Host runtime list (${result.schemaVersion})`,
    ...result.runtimes.map(runtime => `${runtime.host}: ${runtime.status} — ${runtime.nextAction}`),
  ].join('\n');
}

export function renderHostRuntimeProbeText(result: HostRuntimeProbe): string {
  const lines = [
    `Host runtime probe (${result.schemaVersion})`,
    `host: ${result.host}`,
    `requestedHost: ${result.requestedHost}`,
    `status: ${result.status}`,
    `available: ${result.available}`,
    `supportsParallel: ${result.supportsParallel}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchPlanText(result: DispatchPlanResult): string {
  const lines = [
    `Dispatch plan (${result.schemaVersion})`,
    `storyId: ${result.storyId}`,
    `requestedHost: ${result.requestedHost}`,
    `selectedHost: ${result.selectedHost}`,
    `status: ${result.status}`,
    `parallel: ${result.parallel}`,
    `packId: ${result.pack.packId}`,
    `packHash: ${result.pack.packHash}`,
    `worktreePath: ${result.worktree.worktreePath}`,
    `branch: ${result.worktree.branch}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchRecordText(record: DispatchRecord): string {
  return [
    `Dispatch prepare (${record.schemaVersion})`,
    summaryLine(record),
    `nextAction: ${record.nextAction}`,
    `packFile: ${record.packFile}`,
    `statusFile: ${record.statusFile}`,
    `promptFile: ${record.promptFile}`,
    `transcriptFile: ${record.transcriptFile}`,
  ].join('\n');
}

export function renderDispatchRunText(result: DispatchRunResult): string {
  const lines = [
    `Dispatch run (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `storyId: ${result.storyId}`,
    `host: ${result.host}`,
    `status: ${result.status}`,
    `parallel: ${result.parallel}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.receipt) {
    lines.push(`receipt.status: ${result.receipt.status}`);
  }
  if (result.workers.length > 0) {
    lines.push('', 'workers:');
    lines.push(...result.workers.map(worker => `  - ${worker.dispatchId}: ${worker.status}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchCollectionText(result: DispatchCollection): string {
  const lines = [
    `Dispatch collect (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `storyId: ${result.storyId}`,
    `status: ${result.status}`,
    `freshness: ${result.freshness}`,
    `changedFiles: ${result.changedFiles.length}`,
  ];
  if (result.workers.length > 0) {
    lines.push('', 'workers:');
    lines.push(...result.workers.map(worker => `  - ${worker.dispatchId}: ${worker.status}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchReceiptDraftText(result: DispatchReceiptDraft): string {
  return [
    `Dispatch receipt create (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `status: ${result.status}`,
    `packId: ${result.receipt.packId}`,
    `packHash: ${result.receipt.packHash}`,
    `changedFiles: ${result.receipt.changedFiles.length}`,
  ].join('\n');
}

export function renderDispatchStatusText(result: DispatchStatusResult): string {
  const lines = [
    `Dispatch status (${result.schemaVersion})`,
    summaryLine(result.dispatch),
    `nextAction: ${result.dispatch.nextAction}`,
  ];
  if (result.receipt) {
    lines.push(`receipt.status: ${result.receipt.status}`);
  }
  if (result.runner) {
    const r = result.runner;
    lines.push('', 'runner:');
    lines.push(`  runnerKind: ${r.runnerKind}`);
    if (r.commandTemplate.length > 0) {
      lines.push(`  commandTemplate: ${r.commandTemplate.join(' ')}`);
    }
    if (r.invocation.length > 0) {
      lines.push(`  invocation: ${r.invocation.join(' ')}`);
    }
    lines.push(`  cwd: ${r.cwd}`);
    lines.push(`  transcriptPath: ${r.transcriptPath}`);
    lines.push(`  startedAt: ${r.startedAt}`);
    if (r.endedAt) lines.push(`  endedAt: ${r.endedAt}`);
    if (r.exitCode !== undefined) lines.push(`  exitCode: ${r.exitCode}`);
    if (r.timedOut) lines.push(`  timedOut: true`);
    lines.push(`  envSummary: ${r.envSummary.totalVars} vars, ${r.envSummary.sensitiveFiltered} sensitive filtered`);
    if (r.refusalReasons.length > 0) {
      lines.push('  refusalReasons:');
      lines.push(...r.refusalReasons.map(reason => `    - ${reason}`));
    }
  }
  if (result.workers.length > 0) {
    lines.push('', 'workers:');
    lines.push(...result.workers.map(worker => `  - ${worker.dispatch.dispatchId}: ${worker.dispatch.status}`));
  }
  return lines.join('\n');
}

export function renderDispatchListText(result: DispatchListResult): string {
  return [
    `Dispatch list (${result.schemaVersion})`,
    ...(result.dispatches.length > 0
      ? result.dispatches.map(dispatch => `${dispatch.dispatchId} ${dispatch.storyId} ${dispatch.host} ${dispatch.status}`)
      : ['(none)']),
  ].join('\n');
}

export function renderDispatchReviewText(result: DispatchReviewResult): string {
  const lines = [
    `Dispatch review (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `storyId: ${result.storyId}`,
    `status: ${result.status}`,
    `changedFiles: ${result.changedFiles.length}`,
    `transcriptPath: ${result.transcriptPath}`,
    `transcriptExists: ${result.transcriptExists}`,
    `localReceiptStatus: ${result.localReceiptStatus}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.runnerSummary) {
    const r = result.runnerSummary;
    lines.push('', 'runner:');
    lines.push(`  runnerKind: ${r.runnerKind}`);
    lines.push(`  cwd: ${r.cwd}`);
    lines.push(`  transcriptPath: ${r.transcriptPath}`);
    if (r.exitCode !== undefined) lines.push(`  exitCode: ${r.exitCode}`);
    lines.push(`  timedOut: ${r.timedOut}`);
  }
  if (result.commands.length > 0) {
    lines.push('', 'commands:');
    lines.push(...result.commands.map(cmd => `  - ${cmd}`));
  }
  if (result.workers.length > 0) {
    lines.push('', 'workers:');
    lines.push(...result.workers.map(worker => `  - ${worker.dispatchId}: ${worker.status} localReceiptStatus=${worker.localReceiptStatus}`));
  }
  if (result.risks.length > 0) {
    lines.push('', 'risks:');
    lines.push(...result.risks.map(risk => `  - ${risk}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchMergePlanText(result: DispatchMergePlanResult): string {
  const lines = [
    `Dispatch merge plan (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `storyId: ${result.storyId}`,
    `status: ${result.status}`,
    `mergeable: ${result.mergeable}`,
    `manualOnly: ${result.manualOnly}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.commands.length > 0) {
    lines.push('', 'commands:');
    lines.push(...result.commands.map(command => `  - ${command}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchAutoText(result: DispatchAutoResult): string {
  const lines = [
    `Dispatch auto (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `storyId: ${result.storyId}`,
    `host: ${result.host}`,
    `status: ${result.status}`,
    `parallel: ${result.parallel}`,
    `policy: ${result.policy}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.workers.length > 0) {
    lines.push('', 'workers:');
    lines.push(...result.workers.map(worker => `  - ${worker.dispatchId}: ${worker.status}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchWatchText(result: DispatchWatchResult): string {
  const lines = [
    `Dispatch watch (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `storyId: ${result.storyId}`,
    `status: ${result.status}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.changedFilesCount !== undefined) {
    lines.push(`changedFilesCount: ${result.changedFilesCount}`);
  }
  if (result.runnerSummary) {
    const r = result.runnerSummary;
    lines.push('', 'runner:');
    lines.push(`  runnerKind: ${r.runnerKind}`);
    lines.push(`  cwd: ${r.cwd}`);
    lines.push(`  transcriptPath: ${r.transcriptPath}`);
    if (r.exitCode !== undefined) lines.push(`  exitCode: ${r.exitCode}`);
    if (r.timedOut) lines.push(`  timedOut: true`);
  }
  if (result.workers.length > 0) {
    lines.push('', 'workers:');
    lines.push(...result.workers.map(worker => `  - ${worker.dispatchId}: ${worker.status}${worker.runnerKind ? ` (${worker.runnerKind})` : ''}`));
  }
  return lines.join('\n');
}
