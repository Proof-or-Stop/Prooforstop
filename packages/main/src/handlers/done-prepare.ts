import childProcess, { type ExecFileSyncOptions, type ExecSyncOptions } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { refreshStaleEvidenceMetadataOnly } from './checklist.js';
import { buildDoneClosureRunbook, type DoneClosureRunbook } from './done-closure.js';
import { createDoneRequiredValidationHandlers } from './done-required-validation.js';
import { createVerifierHandlers } from './verifier.js';
import { loadConfig } from '../core/config.js';
import { isStateDirPath } from '../core/brand-paths.js';
import { resolveDoneRequiredPolicy } from '../core/done-required-validation.js';
import { checkEvidenceFreshnessForGit, checkStrictVerificationEvidenceFreshnessForGit, currentGitHead, currentMaterialHash, currentStoryFilesHash, isCanonicalGitHeadHash, isCanonicalSha256Hash, isStoryMetadataPath } from '../core/evidence-freshness.js';
import { closeoutArtifactPolicyFor, readCloseoutWriteReceipts } from '../core/closeout-trust.js';
import { verifyReviewRun } from '../core/review-run.js';
import { verifyReviewPass } from '../core/finding-verify.js';
import { agentRoleIdsEqual } from '../core/agent-role-identity.js';
import type { ProcessEvent } from '../core/types.js';
import { formatValidationProgressEvent } from '../core/validation-executor.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { verificationReceiptHasCurrentReuseAuthority, verificationReceiptLostCurrentReuseAuthority } from '../core/verification-execution-evidence.js';
import { createVerificationEvidenceGateEvaluator } from '../core/proof-admissibility.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsForStory,
  parseGitPorcelainRow,
  type DirtyWorktreeClassification,
  type DirtyWorktreeEntry,
} from '../core/dirty-worktree.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { renderMemoryFreshnessPackSummary } from '../core/playbook-runtime-memory.js';
import { surfaceRuntimeMemoryPack } from '../core/experience-pack-surface.js';
import type { MemoryFreshnessPack } from '../core/playbook-runtime-memory.js';
import {
  evaluateReviewEscalation,
} from '../core/review-escalation.js';
import {
  buildDonePrepareGeneratedMetadataManifest,
  captureDonePrepareGeneratedMetadataBaseline,
  captureDonePrepareGeneratedMetadataTransaction,
  commitDonePrepareGeneratedMetadata,
  gitStatusRowsForDonePrepareGeneratedMetadata,
  rollbackDonePrepareGeneratedMetadataTransaction,
  type DonePrepareGeneratedMetadataBaseline,
  type DonePrepareGeneratedMetadataCommitResult,
  type DonePrepareGeneratedMetadataManifest,
  type DonePrepareGeneratedProcessEventBinding,
  type DonePrepareGeneratedMetadataTransaction,
} from '../core/done-prepare-generated-metadata.js';
import {
  captureDonePrepareValidationReuseBasis,
  evaluateDoneRequiredPreRunReuse,
  writeDonePrepareValidationReuseRecord,
  type DonePrepareValidationReuseBasis,
} from '../core/done-prepare-validation-reuse.js';
import { CliWatchdogTimeoutError, donePreparePhaseBudget, doneRequiredDerivedBudget, timeoutLayerFromReason, type TimeoutBudgetSource } from '../core/done-required-timeout-budget.js';
import { readBrandEnv } from '../core/brand-env.js';
import { DONE_PREPARE_SCHEMA } from '../core/artifact-schema.js';
import {
  buildReviewEscalationGuidance,
  buildReviewAssuranceFloorGuidance,
  evaluateReviewAssuranceFloor,
  renderReviewAssuranceGuidance,
  type ReviewAssuranceGuidance,
} from '../core/review-assurance-floor.js';

type StepStatus = 'pending' | 'skipped' | 'pass' | 'blocked';
type StepId =
  | 'preflight'
  | 'mergeMain'
  | 'staleEvidenceRefresh'
  | 'validate'
  | 'doneClosure'
  | 'worktreeVersionCheck'
  | 'runtimeChange'
  | 'cleanTree';

interface DonePrepareArgs {
  storyId: string;
  mergeMain?: boolean;
  refreshStale?: boolean;
  validate?: boolean;
  build?: boolean;
  dryRun?: boolean;
  json?: boolean;
  autoCloseGeneratedMetadata?: boolean;
  reuseFreshValidation?: boolean;
  reuseFreshDoneRequired?: boolean;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
}

interface DonePrepareStep {
  id: StepId;
  status: StepStatus;
  reason?: string;
  command?: string;
}

interface DonePrepareBlocked {
  blockedAt: StepId | 'evidenceFreshness';
  reason: string;
  next: string;
  dryRun?: boolean;
  currentBinding?: DonePrepareCurrentBinding;
  reviewAssurancePlan?: DonePrepareReviewAssurancePlan;
  memoryFreshnessPack?: MemoryFreshnessPack;
  files?: string[];
  commits?: string[];
  commands?: string[];
  guidanceSections?: DonePrepareGuidanceSection[];
  steps: DonePrepareStep[];
}

interface DonePrepareGuidanceSection {
  title: string;
  lines: string[];
}

interface DonePrepareCurrentBinding {
  currentHead?: string;
  currentMaterialHash?: string;
  currentStoryFilesHash?: string;
}

type DonePrepareConvergence = NonNullable<DonePrepareJsonResult['convergence']>;

export interface DonePrepareConvergenceFacts {
  anchor: {
    timestamp: string;
    attemptId: string;
    materialHash: string;
    storyFilesHash: string;
    reviewRound: string;
  };
  testEntryAt: string;
  phaseTransitions: ProcessEvent[];
  humanConfirmations: ProcessEvent[];
  validationTerminals: ProcessEvent[];
  reviewerIdentityIds: string[];
  postTestReviewerIdentityIds: string[];
  closeoutWriterSequence: string[];
}

interface DonePrepareReviewAssurancePlan {
  requiredGates: Array<{
    source: ReviewAssuranceGuidance['source'];
    reasonCode: string;
    requiredAssurance: string;
    fallbackStatus: ReviewAssuranceGuidance['fallback']['status'];
  }>;
  ownerRunnableCommands: string[];
  reviewerHostWriterPaths: string[];
  humanApprovedFallbackWriterPaths: string[];
  warnings: string[];
  renderedGuidance: string[];
}

interface StaleEvidencePlan {
  dryRunTranscript: string;
  staleCount: number;
  safeRefresh: Array<{ intentRef: string; subject: string }>;
  rerunRequired: Array<{ intentRef: string; command: string }>;
}

interface RuntimeChangeReport {
  postDoneRuntimeVersionBumpRequired: boolean;
  changedFiles: string[];
  runtimeFiles: string[];
  docsOnly: boolean;
  postDoneVersionState: 'consistent' | 'inconsistent' | 'unknown';
  versionSources: Record<string, string>;
  versionMismatches: string[];
}

type CloseoutPhaseId =
  | 'doneRequiredValidation'
  | 'doneClosure'
  | 'reviewAssurance'
  | 'runtimeChange'
  | 'cleanTree'
  | 'produceCommand';

interface CloseoutPhase {
  id: CloseoutPhaseId;
  label: string;
  stepId: StepId;
  timeoutEnv: string;
}

export interface DonePrepareJsonResult {
  schemaVersion: typeof DONE_PREPARE_SCHEMA;
  storyId: string;
  status: 'pass' | 'blocked' | 'unknown';
  transcript: string;
  blockedAt?: string;
  reason?: string;
  disposition?: 'reused' | 'executed' | 'skipped_explicitly';
  result?: 'pass' | 'failed' | 'timed_out' | 'blocked' | 'not_run';
  refusalReasons?: string[];
  timeoutLayer?: 'command' | 'phase' | 'idle' | 'max' | null;
  existingEvidenceBasis?: 'fresh' | 'stale' | 'missing';
  convergence?: {
    metadataRollbacks: number;
    reviewerReattestations: number;
    postTestReviewerReattestations: number;
    humanConfirmations: number;
    unchangedSuiteExecutions: number;
    // B-f824: observable whole-window duplicate-execution telemetry (never asserted).
    reviewWindowSuiteExecutions: number;
    successfulCloseout: number;
  };
}

interface ObservedValidationTerminalContext {
  disposition: NonNullable<DonePrepareJsonResult['disposition']>;
  result: NonNullable<DonePrepareJsonResult['result']>;
  refusalReasons: string[];
  timeoutLayer: DonePrepareJsonResult['timeoutLayer'];
  existingEvidenceBasis: NonNullable<DonePrepareJsonResult['existingEvidenceBasis']>;
}

class DonePreparePhaseTimeoutError extends Error {
  readonly phase: CloseoutPhase;
  readonly timeoutMs: number;
  readonly budgetSource: TimeoutBudgetSource;

  constructor(phase: CloseoutPhase, timeoutMs: number, budgetSource: TimeoutBudgetSource) {
    super(`done_prepare phase "${phase.label}" exceeded ${timeoutMs}ms timeout`);
    this.name = 'DonePreparePhaseTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
    this.budgetSource = budgetSource;
  }
}

interface CloseoutPhaseChildProcessDeadline {
  phase: CloseoutPhase;
  timeoutMs: number;
  deadlineAt: number;
  timeoutError?: DonePreparePhaseTimeoutError;
  budgetSource: TimeoutBudgetSource;
  restore: () => void;
}

interface CloseoutPhaseControl {
  signal: AbortSignal;
  deadlineAt: number;
  timeoutMs: number;
  timeoutError: () => DonePreparePhaseTimeoutError;
}

type SmokeSyncGitHangKind = 'execFileSync' | 'execSync';

const DONE_PREPARE_HEARTBEAT_ENV = 'PROOF_OR_STOP_DONE_PREPARE_HEARTBEAT_MS';
const DONE_PREPARE_SMOKE_HANG_PHASE_ENV = 'PROOF_OR_STOP_DONE_PREPARE_SMOKE_HANG_PHASE';
const DONE_PREPARE_SMOKE_SYNC_GIT_HANG_PHASE_ENV = 'PROOF_OR_STOP_DONE_PREPARE_SMOKE_SYNC_GIT_HANG_PHASE';
const DONE_PREPARE_SMOKE_SYNC_GIT_HANG_KIND_ENV = 'PROOF_OR_STOP_DONE_PREPARE_SMOKE_SYNC_GIT_HANG_KIND';
const DONE_PREPARE_SMOKE_SYNC_GIT_HANG_MS_ENV = 'PROOF_OR_STOP_DONE_PREPARE_SMOKE_SYNC_GIT_HANG_MS';
const DEFAULT_DONE_PREPARE_HEARTBEAT_MS = 30_000;
const DEFAULT_DONE_PREPARE_SMOKE_SYNC_GIT_HANG_MS = 30_000;

const CLOSEOUT_PHASES: Record<CloseoutPhaseId, CloseoutPhase> = {
  doneRequiredValidation: {
    id: 'doneRequiredValidation',
    label: 'running DONE-required validation',
    stepId: 'validate',
    timeoutEnv: 'PROOF_OR_STOP_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS',
  },
  doneClosure: {
    id: 'doneClosure',
    label: 'evaluating DONE closure',
    stepId: 'doneClosure',
    timeoutEnv: 'PROOF_OR_STOP_DONE_PREPARE_DONE_CLOSURE_TIMEOUT_MS',
  },
  reviewAssurance: {
    id: 'reviewAssurance',
    label: 'checking review assurance',
    stepId: 'doneClosure',
    timeoutEnv: 'PROOF_OR_STOP_DONE_PREPARE_REVIEW_ASSURANCE_TIMEOUT_MS',
  },
  runtimeChange: {
    id: 'runtimeChange',
    label: 'computing runtime-change status',
    stepId: 'runtimeChange',
    timeoutEnv: 'PROOF_OR_STOP_DONE_PREPARE_RUNTIME_CHANGE_TIMEOUT_MS',
  },
  cleanTree: {
    id: 'cleanTree',
    label: 'checking clean tree',
    stepId: 'cleanTree',
    timeoutEnv: 'PROOF_OR_STOP_DONE_PREPARE_CLEAN_TREE_TIMEOUT_MS',
  },
  produceCommand: {
    id: 'produceCommand',
    label: 'producing DONE command',
    stepId: 'doneClosure',
    timeoutEnv: 'PROOF_OR_STOP_DONE_PREPARE_PRODUCE_COMMAND_TIMEOUT_MS',
  },
};

const VERSION_SOURCE_FILES = [
  'package.json',
  'package-lock.json',
  'packages/main/package.json',
  'packages/main/package-lock.json',
  'packages/main/src/core/proof-or-stop-brand.ts',
] as const;

const RUNTIME_PREFIXES = [
  'packages/main/src/core/',
  'packages/main/src/handlers/',
  'packages/main/src/tasks/',
  'packages/main/src/cli/',
  'bin/',
] as const;

const RUNTIME_FILES = new Set([
  'packages/main/src/cli.ts',
  'packages/main/src/index.ts',
  'packages/main/src/registry.ts',
  'packages/main/src/cli-engine.ts',
]);

type DefaultedDonePrepareArgs = Required<Omit<DonePrepareArgs, 'abortSignal' | 'deadlineAt' | 'deadlineError'>>;

function defaulted(args: DonePrepareArgs): DefaultedDonePrepareArgs {
  return {
    storyId: args.storyId,
    mergeMain: args.mergeMain !== false,
    refreshStale: args.refreshStale !== false,
    validate: args.validate !== false,
    build: args.build === true,
    dryRun: args.dryRun === true,
    json: args.json === true,
    autoCloseGeneratedMetadata: args.autoCloseGeneratedMetadata === true,
    reuseFreshValidation: args.reuseFreshValidation === true,
    reuseFreshDoneRequired: args.reuseFreshDoneRequired !== false,
  };
}

function git(gitCwd: string, args: string[]): string {
  return childProcess.execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitMaybe(gitCwd: string, args: string[]): { ok: true; output: string } | { ok: false; error: string } {
  try {
    return { ok: true, output: git(gitCwd, args) };
  } catch (err: any) {
    return {
      ok: false,
      error: String(err?.stderr || err?.stdout || err?.message || err).trim(),
    };
  }
}

function gitStatusRows(gitCwd: string): string[] {
  // Do not reuse git(): its full-output trim() strips the first porcelain row's
  // leading status space (" M path" -> "M path"), which shifts the fixed-width
  // path offset and corrupts the first reported path (".proof-or-stop/x" -> "proofOrStop/x").
  const raw = childProcess.execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return raw.split('\n').map((line) => line.trimEnd()).filter(Boolean);
}

function statusFiles(rows: string[]): string[] {
  return rows
    .map((row) => parseGitPorcelainRow(row)?.path || row.slice(3).trim() || row)
    .filter(Boolean);
}

function entryFiles(entries: DirtyWorktreeEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => dirtyEntryPaths(entry)))];
}

function ownerLeaseRelPath(ctx: HandlerContext, storyId: string): string {
  return `${ctx.store.storyDirRel()}/${storyId}/owner-lease.json`.replace(/\\/g, '/');
}

function nonLeaseDirtyRows(ctx: HandlerContext, storyId: string, rows: string[]): string[] {
  const leasePath = ownerLeaseRelPath(ctx, storyId);
  return rows.filter((row) => {
    const parsed = parseGitPorcelainRow(row);
    if (!parsed) return true;
    const dirtyPaths = [parsed.path, parsed.originalPath].filter((path): path is string => Boolean(path));
    return dirtyPaths.length === 0 || !dirtyPaths.every((path) => path === leasePath);
  });
}

function classifyDirtyRows(ctx: HandlerContext, storyId: string, rows: string[]): DirtyWorktreeClassification {
  const config = loadConfig(ctx.root);
  return classifyGitStatusRows(
    rows,
    dirtyWorktreeClassifierOptionsForStory(config, storyId, ctx.store, ctx.root),
  );
}

function dirtyEntryPaths(entry: DirtyWorktreeEntry): string[] {
  return [entry.path, entry.originalPath].filter((path): path is string => Boolean(path));
}

function normalizeRelPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function sortedUniqueRelPaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizeRelPath).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function isSameStoryLifecycleMetadataPath(ctx: HandlerContext, storyId: string, path: string): boolean {
  const storyDir = normalizeRelPath(ctx.store.storyDirRel());
  const normalized = normalizeRelPath(path);
  return normalized === `${storyDir}/${storyId}` || normalized.startsWith(`${storyDir}/${storyId}/`);
}

function isDonePrepareAllowedInitialMetadataEntry(ctx: HandlerContext, storyId: string, entry: DirtyWorktreeEntry): boolean {
  const paths = dirtyEntryPaths(entry);
  return entry.category === 'proof_or_stop_metadata_changes'
    && paths.length > 0
    && paths.every((path) => isStoryMetadataPath(path, ctx.root))
    && paths.every((path) => isSameStoryLifecycleMetadataPath(ctx, storyId, path));
}

function initialDonePrepareBlockingEntries(
  ctx: HandlerContext,
  storyId: string,
  classification: DirtyWorktreeClassification,
): DirtyWorktreeEntry[] {
  return classification.entries.filter((entry) => !isDonePrepareAllowedInitialMetadataEntry(ctx, storyId, entry));
}

function dirtyPathDigest(gitCwd: string, path: string): string {
  const absPath = join(gitCwd, path);
  try {
    if (!existsSync(absPath)) return 'missing';
    const stat = statSync(absPath);
    if (stat.isDirectory()) return 'directory';
    if (!stat.isFile()) return `non-file:${stat.mode}`;
    return createHash('sha256').update(readFileSync(absPath)).digest('hex');
  } catch (err: any) {
    return `unreadable:${err?.code || err?.message || String(err)}`;
  }
}

function dirtyEntrySignature(gitCwd: string, entry: DirtyWorktreeEntry): string {
  const paths = [entry.path, entry.originalPath].filter((path): path is string => Boolean(path));
  return [
    entry.statusCode,
    entry.path,
    entry.originalPath ?? '',
    ...paths.map((path) => `${path}:${dirtyPathDigest(gitCwd, path)}`),
  ].join('\0');
}

function unchangedFromInitialAllowedMetadata(
  ctx: HandlerContext,
  storyId: string,
  gitCwd: string,
  entry: DirtyWorktreeEntry,
  initialAllowedMetadataSignatures: ReadonlySet<string>,
): boolean {
  return isDonePrepareAllowedInitialMetadataEntry(ctx, storyId, entry)
    && initialAllowedMetadataSignatures.has(dirtyEntrySignature(gitCwd, entry));
}

function pathExistsOnMain(gitCwd: string, path: string): boolean {
  return gitMaybe(gitCwd, ['cat-file', '-e', `main:${path}`]).ok;
}

function dirtyCategoryLabel(entry: DirtyWorktreeEntry): string {
  switch (entry.category) {
    case 'proof_or_stop_metadata_changes':
      return 'Proof-or-Stop metadata outside the current-run safe lifecycle metadata set';
    case 'runtime_artifact_changes':
      return entry.runtimeArtifactId
        ? `runtime artifact (${entry.runtimeArtifactId})`
        : 'runtime artifact';
    case 'declared_artifact_changes':
      return 'declared artifact';
    case 'material_source_changes':
      return 'story or project material source';
    case 'fixture_changes':
      return 'fixture';
    case 'unexpected_dirty_files':
      return 'unrelated dirty file';
  }
}

function dirtyEntryDisplayPath(entry: DirtyWorktreeEntry): string {
  const paths = dirtyEntryPaths(entry);
  return paths.length > 0 ? paths.join(' -> ') : entry.rawPath || entry.raw;
}

function buildInitialDirtyGuidance(
  gitCwd: string,
  entries: DirtyWorktreeEntry[],
): DonePrepareGuidanceSection[] {
  const mergeHazards = entries
    .filter((entry) => entry.statusCode === '??' && pathExistsOnMain(gitCwd, entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const lines: string[] = [];

  for (const entry of mergeHazards) {
    lines.push(`merge hazard: untracked file would be overwritten: ${entry.path}`);
  }
  if (mergeHazards.length > 0) {
    lines.push('safe next step: preserve or move the file, then rerun done_prepare');
  }

  lines.push('dirty file classification:');
  for (const entry of entries) {
    lines.push(`  - ${dirtyEntryDisplayPath(entry)}: ${dirtyCategoryLabel(entry)}`);
  }

  return [{ title: 'pre-DONE dirty guidance', lines }];
}

function buildMergeConflictGuidance(): DonePrepareGuidanceSection[] {
  return [{
    title: 'merge conflict guidance',
    lines: [
      'merge conflict files require manual resolution; done_prepare will not auto-resolve them',
      'next action: resolve the listed files, commit the merge, then rerun done_prepare',
    ],
  }];
}

function buildRerunReasonGuidance(
  commits: string[],
  binding: DonePrepareCurrentBinding,
): DonePrepareGuidanceSection[] {
  const lines = commits.length > 0
    ? commits.map((commit) => `generated commit: ${commit}`)
    : ['generated commit: (unavailable)'];
  lines.push('current binding:');
  lines.push(`  currentHead: ${binding.currentHead || '(unavailable)'}`);
  lines.push(`  currentMaterialHash: ${binding.currentMaterialHash || '(unavailable)'}`);
  lines.push(`  currentStoryFilesHash: ${binding.currentStoryFilesHash || '(unavailable)'}`);
  return [{ title: 'done_prepare re-run reason', lines }];
}

function buildGeneratedMetadataDirtyGuidance(
  manifest: DonePrepareGeneratedMetadataManifest,
): DonePrepareGuidanceSection[] {
  const currentRun = manifest.entries
    .filter((entry) => entry.currentRunGenerated && entry.safeToAutoStage)
    .sort((left, right) => left.path.localeCompare(right.path));
  const unsafe = manifest.entries
    .filter((entry) => !entry.safeToAutoStage)
    .sort((left, right) => left.path.localeCompare(right.path));
  const lines: string[] = [];

  if (currentRun.length > 0) {
    lines.push('generated by this done_prepare run:');
    for (const entry of currentRun) lines.push(`  - ${entry.path}`);
  }
  if (unsafe.length > 0) {
    lines.push('unsafe or pre-existing dirty files:');
    for (const entry of unsafe) lines.push(`  - ${entry.path}: ${entry.reason}`);
  }

  return lines.length > 0 ? [{ title: 'generated metadata delta', lines }] : [];
}

function isMainAncestor(gitCwd: string): boolean {
  return gitMaybe(gitCwd, ['merge-base', '--is-ancestor', 'main', 'HEAD']).ok;
}

function ensureStep(steps: DonePrepareStep[], id: StepId): DonePrepareStep {
  let step = steps.find((candidate) => candidate.id === id);
  if (!step) {
    step = { id, status: 'pending' };
    steps.push(step);
  }
  return step;
}

function setStep(
  steps: DonePrepareStep[],
  id: StepId,
  status: StepStatus,
  reason?: string,
  command?: string,
): void {
  const step = ensureStep(steps, id);
  step.status = status;
  if (reason !== undefined) step.reason = reason;
  if (command !== undefined) step.command = command;
}

function block(args: DonePrepareBlocked): string {
  const lines = [
    'DONE prepare: BLOCKED',
    `blockedAt: ${args.blockedAt}`,
    `reason: ${args.reason}`,
  ];
  if (args.dryRun) {
    lines.push('dryRun: no files will be written');
  }
  if (args.files && args.files.length > 0) {
    lines.push('files:');
    for (const file of args.files) lines.push(`  - ${file}`);
  }
  if (args.commits && args.commits.length > 0) {
    lines.push('commits:');
    for (const commit of args.commits) lines.push(`  - ${commit}`);
  }
  if (args.guidanceSections) {
    for (const section of args.guidanceSections) {
      if (section.lines.length === 0) continue;
      lines.push(`${section.title}:`);
      lines.push(...section.lines.map((line) => `  ${line}`));
    }
  }
  if (args.currentBinding) {
    lines.push('Current material binding:');
    lines.push(`  currentHead: ${args.currentBinding.currentHead || '(unavailable)'}`);
    lines.push(`  currentMaterialHash: ${args.currentBinding.currentMaterialHash || '(unavailable)'}`);
    lines.push(`  currentStoryFilesHash: ${args.currentBinding.currentStoryFilesHash || '(unavailable)'}`);
  }
  if (args.reviewAssurancePlan) {
    lines.push('Review assurance blocker classification:');
    for (const gate of args.reviewAssurancePlan.requiredGates) {
      lines.push(`  - ${gate.source}: reasonCode=${gate.reasonCode}; requiredAssurance=${gate.requiredAssurance}; fallback=${gate.fallbackStatus}`);
    }
    lines.push('owner-runnable commands:');
    for (const command of args.reviewAssurancePlan.ownerRunnableCommands) lines.push(`  - ${command}`);
    lines.push('reviewer/host writer paths (do not run from owner/main session):');
    if (args.reviewAssurancePlan.reviewerHostWriterPaths.length === 0) {
      lines.push('  - none');
    } else {
      for (const command of args.reviewAssurancePlan.reviewerHostWriterPaths) lines.push(`  - ${command}`);
    }
    lines.push('human-approved fallback writer paths (only when eligible):');
    if (args.reviewAssurancePlan.humanApprovedFallbackWriterPaths.length === 0) {
      lines.push('  - none');
    } else {
      for (const command of args.reviewAssurancePlan.humanApprovedFallbackWriterPaths) lines.push(`  - ${command}`);
    }
    lines.push('cannot-auto-sign warnings:');
    for (const warning of args.reviewAssurancePlan.warnings) lines.push(`  - ${warning}`);
    lines.push('canonical guidance:');
    for (const rendered of args.reviewAssurancePlan.renderedGuidance) {
      lines.push(...rendered.split('\n').map((line) => `  ${line}`));
    }
  }
  if (args.commands && args.commands.length > 0) {
    lines.push('commands:');
    for (const command of args.commands) lines.push(`  - ${command}`);
  }
  if (args.memoryFreshnessPack) {
    lines.push('');
    lines.push('Advisory memory considered:');
    lines.push(...renderMemoryFreshnessPackSummary(args.memoryFreshnessPack).split('\n').map((line) => `  ${line}`));
    lines.push('  memoryCompletionProof: false');
  }
  lines.push(`next: ${args.next}`);
  lines.push('');
  lines.push(renderSteps(args.steps));
  return lines.join('\n');
}

function renderSteps(steps: DonePrepareStep[]): string {
  const lines = ['Steps:'];
  for (const step of steps) {
    const suffix = step.reason ? ` — ${step.reason}` : '';
    lines.push(`  ${step.id}: ${step.status.toUpperCase()}${suffix}`);
  }
  return lines.join('\n');
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

function envPositiveInt(name: string, fallback: number): number {
  // readBrandEnv, not a raw lookup: accepts the canonical PROOF_OR_STOP_* spelling and
  // still honours a deprecated PROOF_OR_STOP_* export of the same suffix.
  const raw = readBrandEnv(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function donePrepareHeartbeatMs(): number {
  return envPositiveInt(DONE_PREPARE_HEARTBEAT_ENV, DEFAULT_DONE_PREPARE_HEARTBEAT_MS);
}

function donePreparePhaseTimeoutBudget(root: string, phase: CloseoutPhase) {
  return donePreparePhaseBudget(
    root,
    phase.timeoutEnv,
    phase.id === 'doneRequiredValidation' ? doneRequiredDerivedBudget(root) : undefined,
  );
}

function phaseEnvMatches(name: string, phase: CloseoutPhase): boolean {
  const raw = readBrandEnv(name);
  if (!raw) return false;
  const wanted = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  return wanted.includes(phase.id) || wanted.includes(phase.label);
}

function shouldSmokeHangCloseoutPhase(phase: CloseoutPhase): boolean {
  return phaseEnvMatches(DONE_PREPARE_SMOKE_HANG_PHASE_ENV, phase);
}

async function maybeSmokeHangCloseoutPhase(phase: CloseoutPhase, signal: AbortSignal): Promise<void> {
  if (!shouldSmokeHangCloseoutPhase(phase)) return;
  await new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('closeout phase aborted'));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

function markChildProcessPhaseTimeout(deadline: CloseoutPhaseChildProcessDeadline): DonePreparePhaseTimeoutError {
  if (!deadline.timeoutError) {
    deadline.timeoutError = new DonePreparePhaseTimeoutError(deadline.phase, deadline.timeoutMs, deadline.budgetSource);
  }
  return deadline.timeoutError;
}

function remainingChildProcessTimeoutMs(deadline: CloseoutPhaseChildProcessDeadline): number {
  const remainingMs = Math.floor(deadline.deadlineAt - Date.now());
  if (remainingMs <= 0) throw markChildProcessPhaseTimeout(deadline);
  return Math.max(1, remainingMs);
}

function boundedExecFileSyncOptions(
  options: ExecFileSyncOptions | undefined,
  remainingMs: number,
): { options: ExecFileSyncOptions; phaseBounded: boolean } {
  const existingTimeout = options?.timeout;
  const hasShorterTimeout = typeof existingTimeout === 'number'
    && Number.isFinite(existingTimeout)
    && existingTimeout > 0
    && existingTimeout <= remainingMs;
  return {
    options: {
      ...(options ?? {}),
      timeout: hasShorterTimeout ? Math.floor(existingTimeout) : remainingMs,
      ...(!hasShorterTimeout ? { killSignal: 'SIGKILL' as const } : {}),
    },
    phaseBounded: !hasShorterTimeout,
  };
}

function boundedExecSyncOptions(
  options: ExecSyncOptions | undefined,
  remainingMs: number,
): { options: ExecSyncOptions; phaseBounded: boolean } {
  const existingTimeout = options?.timeout;
  const hasShorterTimeout = typeof existingTimeout === 'number'
    && Number.isFinite(existingTimeout)
    && existingTimeout > 0
    && existingTimeout <= remainingMs;
  return {
    options: {
      ...(options ?? {}),
      timeout: hasShorterTimeout ? Math.floor(existingTimeout) : remainingMs,
      ...(!hasShorterTimeout ? { killSignal: 'SIGKILL' as const } : {}),
    },
    phaseBounded: !hasShorterTimeout,
  };
}

function isChildProcessOptions(value: unknown): value is ExecFileSyncOptions {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function commandLeaf(command: string): string {
  return command.split(/[\\/]/).pop() || command;
}

function isGitCommand(command: string): boolean {
  return commandLeaf(command) === 'git' || /^\s*(?:"git"|'git'|git)(?:\s|$)/.test(command);
}

function smokeSyncGitHangKindMatches(kind: SmokeSyncGitHangKind): boolean {
  const raw = process.env[DONE_PREPARE_SMOKE_SYNC_GIT_HANG_KIND_ENV];
  if (!raw) return true;
  const wanted = raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return wanted.includes('all') || wanted.includes('any') || wanted.includes(kind.toLowerCase());
}

function shouldSmokeHangSyncGitCommand(
  deadline: CloseoutPhaseChildProcessDeadline,
  command: string,
  kind: SmokeSyncGitHangKind,
): boolean {
  return isGitCommand(command)
    && phaseEnvMatches(DONE_PREPARE_SMOKE_SYNC_GIT_HANG_PHASE_ENV, deadline.phase)
    && smokeSyncGitHangKindMatches(kind);
}

function smokeSyncGitHangArgs(): string[] {
  const hangMs = envPositiveInt(
    DONE_PREPARE_SMOKE_SYNC_GIT_HANG_MS_ENV,
    DEFAULT_DONE_PREPARE_SMOKE_SYNC_GIT_HANG_MS,
  );
  return ['-e', `process.on('SIGTERM', () => {}); setTimeout(() => {}, ${hangMs});`];
}

function smokeSyncGitHangCommand(): string {
  const [flag, script] = smokeSyncGitHangArgs();
  return `${JSON.stringify(process.execPath)} ${flag} ${JSON.stringify(script)}`;
}

function isChildProcessTimeoutError(err: unknown): boolean {
  const value = err as { code?: unknown; message?: unknown };
  return value?.code === 'ETIMEDOUT' || /\bETIMEDOUT\b|timed out|timeout/i.test(String(value?.message ?? ''));
}

function installCloseoutPhaseChildProcessDeadline(
  phase: CloseoutPhase,
  timeoutMs: number,
  budgetSource: TimeoutBudgetSource,
  started: number,
): CloseoutPhaseChildProcessDeadline {
  const previousExecFileSync = childProcess.execFileSync;
  const previousExecSync = childProcess.execSync;
  const deadline: CloseoutPhaseChildProcessDeadline = {
    phase,
    timeoutMs,
    deadlineAt: started + timeoutMs,
    budgetSource,
    restore: () => {},
  };

  const runExecFileSyncWithDeadline = (
    command: string,
    argsOrOptions?: readonly string[] | ExecFileSyncOptions,
    options?: ExecFileSyncOptions,
  ) => {
    const remainingMs = remainingChildProcessTimeoutMs(deadline);
    const useSmokeHang = shouldSmokeHangSyncGitCommand(deadline, command, 'execFileSync');
    const commandToRun = useSmokeHang ? process.execPath : command;
    const argsToRun = useSmokeHang ? smokeSyncGitHangArgs() : argsOrOptions;
    let phaseBounded = true;

    try {
      let result: string | Buffer;
      if (Array.isArray(argsToRun)) {
        const bounded = boundedExecFileSyncOptions(options, remainingMs);
        phaseBounded = bounded.phaseBounded;
        result = previousExecFileSync(commandToRun, argsToRun, bounded.options);
      } else if (isChildProcessOptions(argsToRun)) {
        const bounded = boundedExecFileSyncOptions(argsToRun, remainingMs);
        phaseBounded = bounded.phaseBounded;
        result = previousExecFileSync(commandToRun, bounded.options);
      } else {
        const bounded = boundedExecFileSyncOptions(undefined, remainingMs);
        phaseBounded = bounded.phaseBounded;
        result = previousExecFileSync(commandToRun, [], bounded.options);
      }
      if (Date.now() >= deadline.deadlineAt) throw markChildProcessPhaseTimeout(deadline);
      return result;
    } catch (err) {
      if ((phaseBounded && isChildProcessTimeoutError(err)) || Date.now() >= deadline.deadlineAt) {
        throw markChildProcessPhaseTimeout(deadline);
      }
      throw err;
    }
  };

  const runExecSyncWithDeadline = (command: string, options?: ExecSyncOptions) => {
    const remainingMs = remainingChildProcessTimeoutMs(deadline);
    const commandToRun = shouldSmokeHangSyncGitCommand(deadline, command, 'execSync')
      ? smokeSyncGitHangCommand()
      : command;
    const bounded = boundedExecSyncOptions(options, remainingMs);
    try {
      const result = previousExecSync(commandToRun, bounded.options);
      if (Date.now() >= deadline.deadlineAt) throw markChildProcessPhaseTimeout(deadline);
      return result;
    } catch (err) {
      if ((bounded.phaseBounded && isChildProcessTimeoutError(err)) || Date.now() >= deadline.deadlineAt) {
        throw markChildProcessPhaseTimeout(deadline);
      }
      throw err;
    }
  };

  // Closeout helpers import execFileSync/execSync directly; sync the builtin named exports
  // so those existing imports see the active phase deadline guard.
  childProcess.execFileSync = runExecFileSyncWithDeadline as typeof childProcess.execFileSync;
  childProcess.execSync = runExecSyncWithDeadline as typeof childProcess.execSync;
  syncBuiltinESMExports();
  deadline.restore = () => {
    childProcess.execFileSync = previousExecFileSync;
    childProcess.execSync = previousExecSync;
    syncBuiltinESMExports();
  };
  return deadline;
}

async function runCloseoutPhase<T>(
  ctx: HandlerContext,
  phase: CloseoutPhase,
  work: (control: CloseoutPhaseControl) => T | Promise<T>,
  parent: Pick<DonePrepareArgs, 'abortSignal' | 'deadlineAt' | 'deadlineError'> = {},
): Promise<T> {
  const parentTimeoutReason = (): Error | null => {
    if (parent.abortSignal?.aborted) {
      return parent.abortSignal.reason instanceof Error
        ? parent.abortSignal.reason
        : new Error('CLI watchdog aborted done_prepare');
    }
    if (typeof parent.deadlineAt === 'number' && Date.now() >= parent.deadlineAt) {
      return parent.deadlineError?.() ?? new CliWatchdogTimeoutError('max', 1);
    }
    return null;
  };
  const throwIfParentTimedOut = (): void => {
    const reason = parentTimeoutReason();
    if (reason) throw reason;
  };
  throwIfParentTimedOut();
  const heartbeatMs = donePrepareHeartbeatMs();
  const budget = donePreparePhaseTimeoutBudget(ctx.root, phase);
  const timeoutMs = budget.timeoutMs;
  const started = Date.now();
  const childProcessDeadline = installCloseoutPhaseChildProcessDeadline(phase, timeoutMs, budget.source, started);
  const abortController = new AbortController();
  const timeoutError = () => markChildProcessPhaseTimeout(childProcessDeadline);
  const phaseControl: CloseoutPhaseControl = {
    signal: abortController.signal,
    deadlineAt: childProcessDeadline.deadlineAt,
    timeoutMs,
    timeoutError,
  };
  ctx.log?.(`done_prepare progress: ${phase.label}`);
  ctx.log?.(`done_prepare timeout budget: phase=${phase.id} timeoutMs=${timeoutMs} budgetSource=${budget.source}`);

  const heartbeat = setInterval(() => {
    ctx.log?.(`done_prepare heartbeat: ${phase.label} elapsedMs=${Date.now() - started} timeoutMs=${timeoutMs}`);
  }, heartbeatMs);
  heartbeat.unref?.();

  let timeout: NodeJS.Timeout | undefined;
  timeout = setTimeout(() => {
      const err = timeoutError();
      abortController.abort(err);
  }, timeoutMs);
  const onParentAbort = () => {
    const reason = parent.abortSignal?.reason instanceof Error ? parent.abortSignal.reason : new Error('CLI watchdog aborted done_prepare');
    abortController.abort(reason);
  };
  if (parent.abortSignal?.aborted) onParentAbort();
  else parent.abortSignal?.addEventListener('abort', onParentAbort, { once: true });

  const task = Promise.resolve().then(async () => {
    try {
      throwIfParentTimedOut();
      await maybeSmokeHangCloseoutPhase(phase, phaseControl.signal);
      const result = await work(phaseControl);
      throwIfParentTimedOut();
      if (abortController.signal.aborted) {
        throw abortController.signal.reason instanceof Error
          ? abortController.signal.reason
          : new Error('closeout phase aborted');
      }
      if (childProcessDeadline.timeoutError) throw childProcessDeadline.timeoutError;
      return result;
    } catch (err) {
      if (childProcessDeadline.timeoutError) throw childProcessDeadline.timeoutError;
      throw err;
    }
  });

  try {
    // Await the cooperative task after aborting it. Returning from a timeout race
    // before the child/lock owner settles would recreate the convergence leak this
    // path is meant to prevent. Synchronous JavaScript cannot be pre-empted; the
    // deadline checks before/after work and bounded sync child wrappers enforce the
    // timeout at the first safe event-loop boundary.
    const result = await task;
    throwIfParentTimedOut();
    ctx.log?.(`done_prepare progress: completed ${phase.label} elapsedMs=${Date.now() - started}`);
    return result;
  } catch (err) {
    if (isDonePreparePhaseTimeout(err) && !abortController.signal.aborted) {
      abortController.abort(err);
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
    childProcessDeadline.restore();
    parent.abortSignal?.removeEventListener('abort', onParentAbort);
  }
}

function isDonePreparePhaseTimeout(err: unknown): err is DonePreparePhaseTimeoutError {
  return err instanceof DonePreparePhaseTimeoutError;
}

function phaseTimeoutBlock(storyId: string, steps: DonePrepareStep[], err: DonePreparePhaseTimeoutError, dryRun = false): string {
  const reason = `${err.message}; disposition=executed result=timed_out existingEvidenceBasis=stale refusalReasons=phase-timeout timeoutLayer=phase budgetSource=${err.budgetSource}; heartbeat output is diagnostic only and does not extend the phase deadline`;
  setStep(steps, err.phase.stepId, 'blocked', reason);
  return block({
    blockedAt: err.phase.stepId,
    reason,
    dryRun,
    next: err.phase.id === 'doneRequiredValidation'
      ? `inspect the timed-out receipt command with proof-or-stop done_required_validate --storyId=${storyId}; rerun done_prepare only after fixing the hang or explicitly raising ${err.phase.timeoutEnv}`
      : `inspect the "${err.phase.label}" closeout phase; if its work is legitimately longer, rerun with ${err.phase.timeoutEnv} set above ${err.timeoutMs}`,
    steps,
  });
}

function cliWatchdogTimeoutBlock(
  phase: CloseoutPhase,
  steps: DonePrepareStep[],
  err: unknown,
  dryRun = false,
  validationContext?: ObservedValidationTerminalContext,
): string | null {
  const timeoutLayer = timeoutLayerFromReason(err);
  if (timeoutLayer !== 'idle' && timeoutLayer !== 'max') return null;
  const message = err instanceof Error ? err.message : `CLI ${timeoutLayer} timeout`;
  const terminalContext = validationContext
    ? `disposition=${validationContext.disposition} result=timed_out refusalReasons=${[
      ...new Set([...validationContext.refusalReasons, `cli-${timeoutLayer}-timeout`]),
    ].join(',')} timeoutLayer=${timeoutLayer} existingEvidenceBasis=${validationContext.existingEvidenceBasis}`
    : `result=timed_out timeoutLayer=${timeoutLayer}`;
  const reason = `${message}; ${terminalContext}; synchronous JavaScript is cooperative and stops at the first phase/deadline checkpoint`;
  setStep(steps, phase.stepId, 'blocked', reason);
  return block({
    blockedAt: phase.stepId,
    reason,
    dryRun,
    next: `inspect the ${timeoutLayer} watchdog budget and the "${phase.label}" segment, then rerun only after correcting the blocking work or budget`,
    steps,
  });
}

function observedValidationTerminalContext(steps: DonePrepareStep[]): ObservedValidationTerminalContext | undefined {
  const text = steps.find((step) => step.id === 'validate')?.reason ?? '';
  const disposition = text.match(/\bdisposition=(reused|executed|skipped_explicitly)/)?.[1] as ObservedValidationTerminalContext['disposition'] | undefined;
  const result = text.match(/\bresult=(pass|failed|timed_out|blocked|not_run)/)?.[1] as ObservedValidationTerminalContext['result'] | undefined;
  const basis = text.match(/\bexistingEvidenceBasis=(fresh|stale|missing)/)?.[1] as ObservedValidationTerminalContext['existingEvidenceBasis'] | undefined;
  const timeoutToken = text.match(/\btimeoutLayer=(command|phase|idle|max|null)/)?.[1];
  const refusalText = text.match(/\brefusalReasons=([^;\n]*?)(?=\s+timeoutLayer=|\s+existingEvidenceBasis=|;|$)/)?.[1];
  if (!disposition || !result || !basis || !timeoutToken || !refusalText) return undefined;
  return {
    disposition,
    result,
    existingEvidenceBasis: basis,
    timeoutLayer: timeoutToken === 'null' ? null : timeoutToken as NonNullable<ObservedValidationTerminalContext['timeoutLayer']>,
    refusalReasons: refusalText === 'none' ? [] : refusalText.split(',').filter(Boolean),
  };
}

export function donePrepareJsonResult(storyId: string, transcript: string): DonePrepareJsonResult {
  const status: DonePrepareJsonResult['status'] = transcript.startsWith('DONE prepare: PASS')
    ? 'pass'
    : transcript.startsWith('DONE prepare: BLOCKED')
      ? 'blocked'
      : 'unknown';
  const blockedAt = transcript.match(/^blockedAt: (.+)$/m)?.[1];
  const reason = transcript.match(/^reason: (.+)$/m)?.[1];
  const disposition = transcript.match(/\bdisposition=(reused|executed|skipped_explicitly)/)?.[1] as DonePrepareJsonResult['disposition'];
  const result = transcript.match(/\bresult=(pass|failed|timed_out|blocked|not_run)/)?.[1] as DonePrepareJsonResult['result'];
  const basis = transcript.match(/existingEvidenceBasis=(fresh|stale|missing)/)?.[1] as DonePrepareJsonResult['existingEvidenceBasis'];
  const timeoutLayer = transcript.match(/timeoutLayer=(command|phase|idle|max)/)?.[1] as Exclude<DonePrepareJsonResult['timeoutLayer'], null> | undefined;
  const refusalText = transcript.match(/refusalReasons=([^;\n]*?)(?=\s+timeoutLayer=|\s+existingEvidenceBasis=|;|$)/)?.[1];
  // B-f824: reviewWindowSuiteExecutions is an optional group so transcripts
  // rendered before the phase-anchored split (old line shape) still parse;
  // the missing field defaults to 0.
  const convergenceMatch = transcript.match(
    /convergence: metadataRollbacks=(\d+) reviewerReattestations=(\d+) postTestReviewerReattestations=(\d+) humanConfirmations=(\d+) unchangedSuiteExecutions=(\d+)(?: reviewWindowSuiteExecutions=(\d+))? successfulCloseout=(\d+)/,
  );
  return {
    schemaVersion: DONE_PREPARE_SCHEMA,
    storyId,
    status,
    transcript,
    ...(blockedAt ? { blockedAt } : {}),
    ...(reason ? { reason } : {}),
    ...(disposition ? { disposition } : {}),
    ...(result ? { result } : {}),
    ...(basis ? { existingEvidenceBasis: basis } : {}),
    ...(timeoutLayer ? { timeoutLayer } : /\btimeoutLayer=null\b/.test(transcript) ? { timeoutLayer: null } : {}),
    ...(refusalText ? { refusalReasons: refusalText === 'none' ? [] : refusalText.split(',') } : {}),
    ...(convergenceMatch ? {
      convergence: {
        metadataRollbacks: Number(convergenceMatch[1]),
        reviewerReattestations: Number(convergenceMatch[2]),
        postTestReviewerReattestations: Number(convergenceMatch[3]),
        humanConfirmations: Number(convergenceMatch[4]),
        unchangedSuiteExecutions: Number(convergenceMatch[5]),
        reviewWindowSuiteExecutions: convergenceMatch[6] === undefined ? 0 : Number(convergenceMatch[6]),
        successfulCloseout: Number(convergenceMatch[7]),
      },
    } : {}),
  };
}

function parseValidateOutput(text: string, next = 'proof-or-stop validate --story=<storyId> --json'): {
  ok: boolean;
  summary: string;
  next: string;
  disposition?: string;
  result?: string;
  refusalReasons?: string[];
  timeoutLayer?: string | null;
  existingEvidenceBasis?: string;
  identityDigest?: string;
} {
  try {
    const parsed = JSON.parse(text);
    const status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
    const ok = typeof parsed.allPass === 'boolean'
      ? parsed.allPass
      : !['fail', 'failed', 'error'].includes(status);
    const detail = [
      typeof parsed.summary === 'string' ? parsed.summary : '',
      Array.isArray(parsed.details) ? parsed.details.slice(0, 3).join('; ') : '',
      Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 3).join('; ') : '',
    ].filter(Boolean).join(': ');
    return {
      ok,
      summary: detail || (ok ? 'validation passed' : 'validation failed'),
      next,
      ...(typeof parsed.disposition === 'string' ? { disposition: parsed.disposition } : {}),
      ...(typeof parsed.result === 'string' ? { result: parsed.result } : {}),
      ...(Array.isArray(parsed.refusalReasons) ? { refusalReasons: parsed.refusalReasons.map(String) } : {}),
      ...(parsed.timeoutLayer === null || typeof parsed.timeoutLayer === 'string' ? { timeoutLayer: parsed.timeoutLayer } : {}),
      ...(typeof parsed.existingEvidenceBasis === 'string' ? { existingEvidenceBasis: parsed.existingEvidenceBasis } : {}),
      ...(typeof parsed.reuse?.identityDigest === 'string' ? { identityDigest: parsed.reuse.identityDigest } : {}),
    };
  } catch {
    return {
      ok: !/status["']?\s*:\s*["']fail|allPass["']?\s*:\s*false|validation failed/i.test(text),
      summary: text.split('\n').find((line) => line.trim())?.trim() || 'validation output was not JSON',
      next,
    };
  }
}

export function safeDoneRequiredRecoveryCommand(storyId: string, text: string, fallback: string): string {
  const next = text.match(/^Next:\s*(proof-or-stop\s+[^\r\n]+)$/m)?.[1]?.trim();
  if (!next || /[;&|`$()<>'"]/.test(next)) return fallback;

  const allowed = new Set([
    `proof-or-stop review_inventory_finalize --storyId=${storyId}`,
    `proof-or-stop done_prepare --storyId=${storyId}`,
    `proof-or-stop done_prepare --storyId=${storyId} --mergeMain`,
    `proof-or-stop finding_list --storyId=${storyId}`,
    `proof-or-stop validate --story=${storyId}`,
    `proof-or-stop certification_window_begin --storyId=${storyId}`,
    `proof-or-stop certification_window_status --storyId=${storyId}`,
    `proof-or-stop done_required_validate --storyId=${storyId}`,
    `proof-or-stop story_advance --storyId=${storyId} --phase=REVIEW`,
  ]);
  return allowed.has(next) ? next : fallback;
}

function classifyStaleEvidence(ctx: HandlerContext, storyId: string, gitCwd: string): StaleEvidencePlan {
  // B-1507 CHK-002: metadata-only DRY preview (no command execution) — done_prepare
  // refuses / reruns command-backed rows on its own path, so it must never take the
  // re-executing refresh handler.
  const dryRunTranscript = asText(refreshStaleEvidenceMetadataOnly(ctx, storyId, true));
  const cl = ctx.store.readChecklist(storyId);
  const headHash = currentGitHead(gitCwd);
  if (!headHash) {
    throw new Error('done_prepare: cannot read git HEAD for stale evidence classification');
  }
  const coverage = buildVerificationCoverage(
    cl,
    headHash,
    (oldHeadHash, evidence) => {
      if (verificationReceiptLostCurrentReuseAuthority(evidence?.receipt)) return false;
      return (
        verificationReceiptHasCurrentReuseAuthority(evidence?.receipt)
        && isCanonicalGitHeadHash(oldHeadHash)
        && isCanonicalSha256Hash(evidence?.materialHash)
        && isCanonicalSha256Hash(evidence?.storyFilesHash)
        ? checkEvidenceFreshnessForGit(gitCwd, oldHeadHash, evidence?.materialHash, ctx.root, evidence?.storyFilesHash)
        : checkStrictVerificationEvidenceFreshnessForGit(gitCwd, oldHeadHash, evidence?.materialHash, ctx.root, evidence?.storyFilesHash)
      ).fresh;
    },
    {
      deferredGateEvidence: 'missing',
      receiptAdmissibility: createVerificationEvidenceGateEvaluator(ctx.root, storyId),
    },
  );
  const stale = coverage.entries.filter((entry) => entry.status === 'stale' && entry.evidence);
  const invalid = coverage.entries.filter(entry => entry.status === 'non_mechanical' && entry.evidence?.mechanical === true);
  if (invalid.length > 0) {
    throw new Error(`done_prepare: invalid verification evidence cannot be renewed implicitly: ${invalid.map(entry => `${entry.intentRef}: ${entry.evidence?.nonMechanicalReason}`).join('; ')}`);
  }
  const safeRefresh: StaleEvidencePlan['safeRefresh'] = [];
  const rerunRequired: StaleEvidencePlan['rerunRequired'] = [];
  for (const entry of stale) {
    const ev = entry.evidence!;
    const command = typeof ev.command === 'string' ? ev.command.trim() : '';
    const subject = command || ev.file || ev.kind || 'evidence';
    if (command) {
      rerunRequired.push({ intentRef: entry.intentRef, command });
    } else {
      safeRefresh.push({ intentRef: entry.intentRef, subject });
    }
  }
  return {
    dryRunTranscript,
    staleCount: stale.length,
    safeRefresh,
    rerunRequired,
  };
}

function conflictFiles(gitCwd: string): string[] {
  const result = gitMaybe(gitCwd, ['diff', '--name-only', '--diff-filter=U']);
  if (!result.ok || !result.output.trim()) return [];
  return result.output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function commitSummariesSince(gitCwd: string, beforeHead: string, afterHead: string): string[] {
  if (!beforeHead || !afterHead || beforeHead === afterHead) return [];
  const result = gitMaybe(gitCwd, ['log', '--reverse', '--pretty=format:%h %s', `${beforeHead}..${afterHead}`]);
  if (result.ok && result.output.trim()) {
    return result.output.split('\n').map((line) => line.trim()).filter(Boolean);
  }
  return [afterHead.slice(0, 12)];
}

const VALIDATION_CLOSEOUT_PROTOCOL_PATHS = new Set([
  'closeout-write-receipts.jsonl',
  'process-events.jsonl',
  'process-metrics.json',
  'test-runs.json',
  'owner-lease.json',
]);

export function validationCloseoutAdvancePaths(
  ctx: HandlerContext,
  storyId: string,
  gitCwd: string,
  beforeHead: string,
  afterHead: string,
): { eligible: boolean; paths: string[]; reasons: string[] } {
  const result = gitMaybe(gitCwd, ['diff', '--name-only', `${beforeHead}..${afterHead}`]);
  if (!result.ok) return { eligible: false, paths: [], reasons: ['unable to read validation commit paths'] };
  const paths = result.output.split('\n').map((line) => line.trim()).filter(Boolean);
  const storyPrefix = `${ctx.store.storyDirRel().replace(/\\/g, '/').replace(/\/+$/, '')}/${storyId}/`;
  const reasons: string[] = [];
  for (const path of paths) {
    if (!path.startsWith(storyPrefix)) {
      reasons.push(`validation commit changed non-story path: ${path}`);
      continue;
    }
    const relativePath = path.slice(storyPrefix.length);
    const policy = closeoutArtifactPolicyFor(relativePath);
    if (policy?.artifactClass === 'closeout-evidence') continue;
    if (VALIDATION_CLOSEOUT_PROTOCOL_PATHS.has(relativePath)) continue;
    reasons.push(`validation commit changed non-closeout metadata: ${relativePath}`);
  }
  return { eligible: paths.length > 0 && reasons.length === 0, paths, reasons };
}

function blockingRows(runbook: DoneClosureRunbook) {
  return runbook.blockers.filter((row) => row.blocking && row.status === 'fail');
}

function hasReviewAssuranceBlocker(runbook: DoneClosureRunbook): boolean {
  return blockingRows(runbook).some((row) => row.id === 'review-assurance-floor' || row.id === 'review-escalation');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function buildDonePrepareReviewAssurancePlan(
  ctx: HandlerContext,
  storyId: string,
  gitCwd: string,
  currentBinding: DonePrepareCurrentBinding,
): DonePrepareReviewAssurancePlan {
  const materialHash = currentBinding.currentMaterialHash;
  const storyFilesHash = currentBinding.currentStoryFilesHash;
  const escalation = evaluateReviewEscalation({
    projectRoot: ctx.root,
    gitCwd,
    storyId,
    store: ctx.store,
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
  });
  const floor = evaluateReviewAssuranceFloor({
    projectRoot: ctx.root,
    gitCwd,
    storyId,
    store: ctx.store,
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
  });
  const guidances = [
    buildReviewEscalationGuidance(escalation, storyId),
    buildReviewAssuranceFloorGuidance(floor),
  ].filter((guidance) => guidance.required && !guidance.ok);
  const ownerRunnableCommands = uniqueStrings(guidances.flatMap((guidance) =>
    guidance.legalWriterPaths.ownerRunnable.map((recipe) => recipe.command),
  ));
  return {
    requiredGates: guidances.map((guidance) => ({
      source: guidance.source,
      reasonCode: guidance.reasonCode,
      requiredAssurance: guidance.requiredAssurance,
      fallbackStatus: guidance.fallback.status,
    })),
    ownerRunnableCommands,
    reviewerHostWriterPaths: uniqueStrings(guidances.flatMap((guidance) =>
      guidance.legalWriterPaths.reviewerHost.map((recipe) => recipe.command),
    )),
    humanApprovedFallbackWriterPaths: uniqueStrings(guidances.flatMap((guidance) =>
      guidance.legalWriterPaths.humanApprovedFallback.map((recipe) => recipe.command),
    )),
    warnings: uniqueStrings(guidances.map((guidance) => guidance.cannotAutoSignWarning)),
    renderedGuidance: guidances.map((guidance) => renderReviewAssuranceGuidance(guidance)),
  };
}

function nextForDoneClosureBlock(
  storyId: string,
  runbook: DoneClosureRunbook,
  reviewAssurancePlan?: DonePrepareReviewAssurancePlan,
): string {
  if (hasReviewAssuranceBlocker(runbook)) {
    return reviewAssurancePlan?.ownerRunnableCommands[0]
      || `inspect review status, submit current-material review/quorum evidence through legal reviewer/host paths, then rerun proof-or-stop done_prepare '{"storyId":"${storyId}"}'`;
  }
  const row = blockingRows(runbook).find((candidate) => candidate.nextCommand);
  return row?.nextCommand || `proof-or-stop done_closure '{"storyId":"${storyId}"}'`;
}

function commandsForDoneClosureBlock(
  storyId: string,
  runbook: DoneClosureRunbook,
  reviewAssurancePlan?: DonePrepareReviewAssurancePlan,
): string[] {
  if (hasReviewAssuranceBlocker(runbook)) {
    if (reviewAssurancePlan) return reviewAssurancePlan.ownerRunnableCommands;
    return [
      `proof-or-stop review_escalation_status '{"storyId":"${storyId}"}'`,
      `proof-or-stop autopilot_review_status --storyId=${storyId}`,
      `proof-or-stop validate --story=${storyId} --json`,
      `proof-or-stop verification_evidence_refresh_stale --storyId=${storyId} --dryRun`,
      `proof-or-stop done_prepare '{"storyId":"${storyId}"}'`,
    ];
  }
  const blockers = blockingRows(runbook);
  return blockers.map((row) => row.nextCommand).filter((value): value is string => Boolean(value));
}

function reviewAssuranceText(runbook: DoneClosureRunbook): string {
  const floor = runbook.blockers.find((row) => row.id === 'review-assurance-floor');
  const escalation = runbook.blockers.find((row) => row.id === 'review-escalation');
  const detail = floor?.reason || escalation?.reason || '';
  const level = detail.match(/: ([a-z0-9-]+);/i)?.[1] || detail.match(/\b(degraded-single-host|full-3x2|local-one-round|ordinary-review|not required)\b/i)?.[1];
  return level || 'not-required';
}

function isRuntimePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (RUNTIME_FILES.has(normalized)) return true;
  return RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isDocumentationOrMetadataPath(path: string): boolean {
  const lower = path.replace(/\\/g, '/').toLowerCase();
  return lower.startsWith('docs/')
    // B-cc10 CHK-007: read-both state-dir recognition. The previous
    // `lower.startsWith('.proof-or-stop/')` matched only the deprecated spelling, so
    // canonical state-dir paths stopped classifying as metadata after the rename.
    // Both accepted spellings are already lowercase, so testing the lowercased
    // path against the resolver is exact.
    || isStateDirPath(lower)
    || lower.endsWith('.md')
    || lower.endsWith('.mdx');
}

function isCommentLikeLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === ''
    || trimmed.startsWith('//')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('*')
    || trimmed.startsWith('*/')
    || trimmed.startsWith('#');
}

function runtimeDiffHasOnlyComments(gitCwd: string, path: string): boolean {
  const result = gitMaybe(gitCwd, ['diff', '--unified=0', 'main...HEAD', '--', path]);
  if (!result.ok) return false;
  const changed = result.output
    .split('\n')
    .filter((line) => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
    .map((line) => line.slice(1));
  return changed.length > 0 && changed.every(isCommentLikeLine);
}

function readPackageVersion(root: string, relPath: string): string | undefined {
  const path = join(root, relPath);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function readBrandVersion(root: string): string | undefined {
  const path = join(root, 'packages/main/src/core/proof-or-stop-brand.ts');
  if (!existsSync(path)) return undefined;
  const match = readFileSync(path, 'utf-8').match(/PROOF_OR_STOP_CLI_VERSION\s*=\s*['"]([^'"]+)['"]/);
  return match?.[1];
}

function readVersionSources(root: string): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const rel of VERSION_SOURCE_FILES) {
    const value = rel.endsWith('proof-or-stop-brand.ts')
      ? readBrandVersion(root)
      : readPackageVersion(root, rel);
    if (value) sources[rel] = value;
  }
  return sources;
}

function detectRuntimeChanges(root: string, gitCwd: string): RuntimeChangeReport {
  const diff = gitMaybe(gitCwd, ['diff', '--name-only', 'main...HEAD']);
  const changedFiles = diff.ok && diff.output.trim()
    ? diff.output.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
  const runtimeFiles = changedFiles
    .filter(isRuntimePath)
    .filter((path) => !runtimeDiffHasOnlyComments(gitCwd, path));
  const docsOnly = changedFiles.length > 0 && changedFiles.every(isDocumentationOrMetadataPath);
  const versionSources = readVersionSources(root);
  const uniqueVersions = [...new Set(Object.values(versionSources))];
  const postDoneVersionState = Object.keys(versionSources).length === 0
    ? 'unknown'
    : uniqueVersions.length === 1
      ? 'consistent'
      : 'inconsistent';
  const versionMismatches = postDoneVersionState === 'inconsistent'
    ? Object.entries(versionSources).map(([file, version]) => `${file}=${version}`)
    : [];
  return {
    postDoneRuntimeVersionBumpRequired: runtimeFiles.length > 0,
    changedFiles,
    runtimeFiles,
    docsOnly,
    postDoneVersionState,
    versionSources,
    versionMismatches,
  };
}

function renderRuntimeReport(report: RuntimeChangeReport): string[] {
  const lines = [
    `postDoneRuntimeVersionBumpRequired: ${report.postDoneRuntimeVersionBumpRequired}`,
    `postDoneVersionState: ${report.postDoneVersionState}`,
  ];
  if (report.versionMismatches.length > 0) {
    lines.push('postDoneVersionMismatches:');
    for (const mismatch of report.versionMismatches) lines.push(`  - ${mismatch}`);
  }
  if (report.runtimeFiles.length > 0) {
    lines.push('runtimeChangedFiles:');
    for (const file of report.runtimeFiles.slice(0, 12)) lines.push(`  - ${file}`);
  } else if (report.docsOnly) {
    lines.push('runtimeChangeClassification: docs-only');
  } else {
    lines.push('runtimeChangeClassification: no runtime source changes detected');
  }
  return lines;
}

/**
 * @task B-4363
 * @checklist CHK-001
 * @title done_prepare current-material review guidance
 * @type bugfix
 * @priority high
 * @description
 *   Report the post-main-sync HEAD/material/story file binding when DONE
 *   closure blocks on review assurance, so reviewers do not keep submitting
 *   stale pre-merge host verdicts.
 * @changes
 *   - [CHK-001] Add current binding output and ordered review/quorum commands to done_prepare blockers.
 * @test current-done-material-binding
 */
function currentDoneMaterialBinding(ctx: HandlerContext, gitCwd: string): DonePrepareCurrentBinding {
  return {
    currentHead: currentGitHead(gitCwd),
    currentMaterialHash: currentMaterialHash(gitCwd, 'HEAD', ctx.root),
    currentStoryFilesHash: currentStoryFilesHash(gitCwd, 'HEAD', ctx.root),
  };
}

function eventText(event: ProcessEvent, field: string): string {
  return typeof event[field] === 'string' ? event[field] as string : '';
}

function eventNumber(event: ProcessEvent, field: string): number {
  const value = event[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function collectDonePrepareConvergenceFacts(
  ctx: HandlerContext,
  storyId: string,
): DonePrepareConvergenceFacts | null {
  const events = ctx.store.readProcessEvents(storyId);
  const transitions = events
    .filter((event) => event.type === 'phase_transition' && eventText(event, 'storyId') === storyId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const currentTestEntry = transitions.filter((event) => eventText(event, 'toPhase') === 'TEST').at(-1);
  if (!currentTestEntry) return null;
  const currentAttemptId = eventText(currentTestEntry, 'attemptId');
  const currentMaterial = eventText(currentTestEntry, 'materialHash');
  const currentStoryFiles = eventText(currentTestEntry, 'storyFilesHash');
  const currentReviewRound = eventText(currentTestEntry, 'reviewRound');
  if (!currentAttemptId || !currentMaterial || !currentStoryFiles || !currentReviewRound) return null;
  const anchorEvent = transitions.filter((event) => (
    eventText(event, 'toPhase') === 'REVIEW'
    && event.timestamp <= currentTestEntry.timestamp
    && eventText(event, 'attemptId') === currentAttemptId
    && eventText(event, 'materialHash') === currentMaterial
    && eventText(event, 'storyFilesHash') === currentStoryFiles
    && eventText(event, 'reviewRound') === currentReviewRound
  )).at(-1);
  if (!anchorEvent) return null;
  const anchor = {
    timestamp: anchorEvent.timestamp,
    attemptId: eventText(anchorEvent, 'attemptId'),
    materialHash: eventText(anchorEvent, 'materialHash'),
    storyFilesHash: eventText(anchorEvent, 'storyFilesHash'),
    reviewRound: eventText(anchorEvent, 'reviewRound'),
  };
  if (!anchor.attemptId || !anchor.materialHash || !anchor.storyFilesHash || !anchor.reviewRound) return null;
  const windowEvents = events.filter((event) => event.timestamp >= anchor.timestamp);
  const phaseTransitions = transitions.filter((event) => event.timestamp >= anchor.timestamp);
  const runs = ctx.store.readReviewRuns(storyId).runs
    .filter((run) => (
      run.startedAt >= anchor.timestamp
      && run.reviewRound === anchor.reviewRound
      && run.materialHash === anchor.materialHash
      && run.storyFilesHash === anchor.storyFilesHash
      && verifyReviewRun(run)
    ));
  const runsById = new Map(runs.map((run) => [run.reviewRunId, run]));
  const completedIdentityByRunId = new Map<string, { reviewRunId: string; completedAt: string; passId: string }>();
  for (const pass of ctx.store.readReviewPasses(storyId).passes
    .filter((pass) => {
      if (pass.createdAt < anchor.timestamp || pass.reviewRound !== anchor.reviewRound || !verifyReviewPass(storyId, pass)) {
        return false;
      }
      const run = pass.reviewRunId ? runsById.get(pass.reviewRunId) : undefined;
      return Boolean(run && agentRoleIdsEqual(pass.agent, run.agent));
    })
    .sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || (left.reviewRunId ?? '').localeCompare(right.reviewRunId ?? '')
      || left.id.localeCompare(right.id)
    ))) {
    if (!completedIdentityByRunId.has(pass.reviewRunId!)) {
      completedIdentityByRunId.set(pass.reviewRunId!, {
        reviewRunId: pass.reviewRunId!,
        completedAt: pass.createdAt,
        passId: pass.id,
      });
    }
  }
  const completedRunsByLane = new Map<string, Array<{ reviewRunId: string; completedAt: string; passId: string }>>();
  for (const identity of completedIdentityByRunId.values()) {
    const run = runsById.get(identity.reviewRunId)!;
    completedRunsByLane.set(run.lane, [
      ...(completedRunsByLane.get(run.lane) ?? []),
      identity,
    ]);
  }
  // The first completed identity per lane is the attempt baseline. Any later
  // identity on the same material/story/round is a real re-attestation,
  // including one completed while still in REVIEW before the TEST entry.
  const reviewerIdentities = [...completedRunsByLane.values()].flatMap((identities) => identities
    .sort((left, right) => (
      left.completedAt.localeCompare(right.completedAt)
      || left.reviewRunId.localeCompare(right.reviewRunId)
      || left.passId.localeCompare(right.passId)
    ))
    .slice(1));
  const reviewerIdentityIds = reviewerIdentities.map((identity) => identity.reviewRunId);
  const postTestReviewerIdentityIds = reviewerIdentities
    .filter((identity) => identity.completedAt >= currentTestEntry.timestamp)
    .map((identity) => identity.reviewRunId);
  let receipts: ReturnType<typeof readCloseoutWriteReceipts> = [];
  try { receipts = readCloseoutWriteReceipts(ctx.store.storyDirPath(storyId)); } catch { return null; }
  return {
    anchor,
    testEntryAt: currentTestEntry.timestamp,
    phaseTransitions,
    humanConfirmations: windowEvents.filter((event) => event.type === 'human_confirmation'),
    validationTerminals: windowEvents.filter((event) => event.type === 'validation_terminal'),
    reviewerIdentityIds,
    postTestReviewerIdentityIds,
    closeoutWriterSequence: receipts
      .filter((receipt) => receipt.timestamp >= anchor.timestamp)
      .map((receipt) => `${receipt.writerCommand}:${receipt.artifactPath}`),
  };
}

export function deriveDonePreparePassConvergence(
  steps: DonePrepareStep[],
  runbook: DoneClosureRunbook,
  facts: DonePrepareConvergenceFacts | null,
): DonePrepareConvergence | null {
  if (!facts) return null;
  const metadataRollbacks = facts.phaseTransitions.filter((event) => (
    (eventText(event, 'fromPhase') === 'REVIEW' || eventText(event, 'fromPhase') === 'TEST')
    && eventText(event, 'toPhase') === 'DEV'
    && eventText(event, 'materialHash') === facts.anchor.materialHash
    && eventText(event, 'storyFilesHash') === facts.anchor.storyFilesHash
  )).length;
  const reviewerReattestations = facts.reviewerIdentityIds.length;
  const postTestReviewerReattestations = facts.postTestReviewerIdentityIds.length;
  const humanConfirmations = facts.humanConfirmations.length;
  const validationGroups = new Map<string, ProcessEvent[]>();
  for (const event of facts.validationTerminals) {
    const key = [
      eventText(event, 'commandSetHash'),
      eventText(event, 'materialHash'),
      eventText(event, 'storyFilesHash'),
    ].join(':');
    if (!eventText(event, 'commandSetHash') || !eventText(event, 'materialHash') || !eventText(event, 'storyFilesHash')) {
      return null;
    }
    validationGroups.set(key, [...(validationGroups.get(key) ?? []), event]);
  }
  // B-f824: phase-anchored suite-execution split, mirroring the
  // reviewerReattestations / postTestReviewerReattestations split above. The
  // B-956f incident showed reviewer-lane independent validates during REVIEW
  // (review policy) plus one forced closeout re-execution permanently poisoned
  // the whole-window count and deadlocked DONE. Blocking unchangedSuiteExecutions
  // now counts only per-group duplicate executed terminals at or after the
  // current TEST entry (>= facts.testEntryAt, same convention as
  // postTestReviewerIdentityIds) plus contradictory reused terminals with
  // commandExecutions > 0 in any phase; reviewWindowSuiteExecutions keeps the
  // whole-window per-group duplicate count as observable, non-blocking telemetry.
  let unchangedSuiteExecutions = 0;
  let reviewWindowSuiteExecutions = 0;
  for (const terminals of validationGroups.values()) {
    const executed = terminals.filter((event) => eventText(event, 'disposition') === 'executed' && eventNumber(event, 'commandExecutions') > 0);
    const postTestExecuted = executed.filter((event) => event.timestamp >= facts.testEntryAt);
    unchangedSuiteExecutions += Math.max(0, postTestExecuted.length - 1);
    unchangedSuiteExecutions += terminals.filter(
      (event) => eventText(event, 'disposition') === 'reused' && eventNumber(event, 'commandExecutions') > 0,
    ).length;
    reviewWindowSuiteExecutions += Math.max(0, executed.length - 1);
  }
  const successfulCloseout = steps.every((step) => step.status !== 'blocked')
    && blockingRows(runbook).length === 0
    ? 1
    : 0;
  return {
    metadataRollbacks,
    reviewerReattestations,
    postTestReviewerReattestations,
    humanConfirmations,
    unchangedSuiteExecutions,
    reviewWindowSuiteExecutions,
    successfulCloseout,
  };
}

export function assertDonePreparePassConvergence(convergence: DonePrepareConvergence): void {
  // B-f824: reviewWindowSuiteExecutions is observable telemetry only and is
  // deliberately NOT asserted here (asserting it recreated the B-956f deadlock).
  if (
    convergence.metadataRollbacks !== 0
    || convergence.postTestReviewerReattestations !== 0
    || convergence.humanConfirmations !== 0
    || convergence.unchangedSuiteExecutions !== 0
    || convergence.successfulCloseout !== 1
  ) {
    throw new Error(`done_prepare convergence invariant failed: ${JSON.stringify(convergence)}`);
  }
}

function renderPass(args: {
  storyId: string;
  phase: string;
  steps: DonePrepareStep[];
  runbook: DoneClosureRunbook;
  runtime: RuntimeChangeReport;
  dryRun: boolean;
  showMemoryPack: boolean;
  convergenceFacts: DonePrepareConvergenceFacts | null;
}): string {
  const convergence = deriveDonePreparePassConvergence(args.steps, args.runbook, args.convergenceFacts);
  if (convergence) assertDonePreparePassConvergence(convergence);
  const lines = [
    'DONE prepare: PASS',
    `storyId: ${args.storyId}`,
    `phase: ${args.phase}`,
    `dryRun: ${args.dryRun}`,
    ...(args.dryRun ? ['dryRun: no files will be written'] : []),
    `mergeMain: ${ensureStep(args.steps, 'mergeMain').status.toUpperCase()}`,
    `staleEvidenceRefresh: ${ensureStep(args.steps, 'staleEvidenceRefresh').status.toUpperCase()}`,
    `validate: ${ensureStep(args.steps, 'validate').status.toUpperCase()}`,
    `doneClosure: ${ensureStep(args.steps, 'doneClosure').status.toUpperCase()}`,
    `worktreeClean: ${ensureStep(args.steps, 'cleanTree').status.toUpperCase()}`,
    `closeoutWriteSequence: ${args.convergenceFacts?.closeoutWriterSequence.join('->') || 'unavailable'}`,
    ...(convergence ? [`convergence: metadataRollbacks=${convergence.metadataRollbacks} reviewerReattestations=${convergence.reviewerReattestations} ` +
      `postTestReviewerReattestations=${convergence.postTestReviewerReattestations} ` +
      `humanConfirmations=${convergence.humanConfirmations} unchangedSuiteExecutions=${convergence.unchangedSuiteExecutions} ` +
      `reviewWindowSuiteExecutions=${convergence.reviewWindowSuiteExecutions} ` +
      `successfulCloseout=${convergence.successfulCloseout}`] : [
      'convergenceUnavailable: missing durable REVIEW-to-TEST attempt window; no zero-cost convergence claim emitted',
    ]),
    ...renderRuntimeReport(args.runtime),
    '',
    'Local assurance:',
    '  localDoneReady: true',
    '  releaseReadiness: not-established',
    `  admissibilityStatus: ${args.runbook.localAssurance.admissibilityStatus}`,
    `  assuranceLevel: ${args.runbook.localAssurance.assuranceLevel}`,
    `  evidenceScope: ${args.runbook.localAssurance.evidenceScope}`,
    `  reviewAssurance: ${reviewAssuranceText(args.runbook)}`,
    // B-ab8d CHK-002: control arm hides the rendered memory summary section
    // only; the runbook JSON keeps the pack for lossless measurement.
    ...(args.showMemoryPack ? [
      '',
      'Advisory memory considered:',
      ...renderMemoryFreshnessPackSummary(args.runbook.memoryFreshnessPack).split('\n').map((line) => `  ${line}`),
      `  completionClaimSource: ${args.runbook.completionClaimSource}`,
      '  memoryCompletionProof: false',
    ] : []),
    '',
    renderSteps(args.steps),
    '',
    'Next:',
    `proof-or-stop story_advance '{"storyId":"${args.storyId}","phase":"DONE"}'`,
  ];
  return lines.join('\n');
}

function injectAutoCloseoutSummary(
  transcript: string,
  commitResult: DonePrepareGeneratedMetadataCommitResult,
): string {
  const lines = transcript.split('\n');
  const first = lines.shift() ?? transcript;
  const summary = [
    'autoCloseGeneratedMetadata: PASS',
    `autoCloseoutCommit: ${commitResult.commitSha || '(unknown)'}`,
    `autoCloseoutMessage: ${commitResult.message}`,
    'validationReused: true',
    'validationReuseRecord: done-required-evidence.json',
    'autoCloseoutFiles:',
    ...commitResult.files.map((file) => `  - ${file}`),
  ];
  return [first, ...summary, ...lines].join('\n');
}

async function runDonePrepare(ctx: HandlerContext, rawArgs: DonePrepareArgs): Promise<string> {
  const args = defaulted(rawArgs);
  const storyId = args.storyId.trim();
  const steps: DonePrepareStep[] = [
    { id: 'preflight', status: 'pending' },
    { id: 'mergeMain', status: 'pending' },
    { id: 'staleEvidenceRefresh', status: 'pending' },
    { id: 'validate', status: 'pending' },
    { id: 'doneClosure', status: 'pending' },
    { id: 'runtimeChange', status: 'pending' },
    { id: 'cleanTree', status: 'pending' },
  ];
  const blocked = (blockedArgs: Omit<DonePrepareBlocked, 'dryRun'>): string => block({
    ...blockedArgs,
    dryRun: args.dryRun,
  });

  if (!storyId) {
    setStep(steps, 'preflight', 'blocked', 'storyId is required');
    return blocked({
      blockedAt: 'preflight',
      reason: 'storyId is required',
      next: 'proof-or-stop done_prepare \'{"storyId":"B-xxxx"}\'',
      steps,
    });
  }

  let story;
  try {
    story = ctx.store.readStory(storyId);
  } catch (err: any) {
    setStep(steps, 'preflight', 'blocked', `story ${storyId} cannot be read`);
    return blocked({
      blockedAt: 'preflight',
      reason: err?.message || `story ${storyId} cannot be read`,
      next: `proof-or-stop story_get '{"storyId":"${storyId}"}'`,
      steps,
    });
  }

  const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });

  try {
    assertCwdInWorktree(ctx.store, storyId);
  } catch (err: any) {
    setStep(steps, 'preflight', 'blocked', 'current cwd is not the requested story worktree');
    return blocked({
      blockedAt: 'preflight',
      reason: err?.message || 'current cwd is not the requested story worktree',
      next: story.worktree?.path ? `cd ${story.worktree.path}` : `proof-or-stop story_resolve '{"storyId":"${storyId}"}'`,
      steps,
    });
  }

  if (story.phase !== 'TEST') {
    setStep(steps, 'preflight', 'blocked', `story phase is ${story.phase}, expected TEST`);
    return blocked({
      blockedAt: 'preflight',
      reason: `story ${storyId} is in ${story.phase}; done_prepare only runs for TEST stories`,
      next: `proof-or-stop story_advance '{"storyId":"${storyId}","phase":"TEST"}'`,
      steps,
    });
  }

  const expectedBranch = story.worktree?.branch || `story/${storyId}`;
  const branch = gitMaybe(gitCwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.ok || branch.output !== expectedBranch) {
    setStep(steps, 'preflight', 'blocked', `current branch is ${branch.ok ? branch.output : '<unknown>'}, expected ${expectedBranch}`);
    return blocked({
      blockedAt: 'preflight',
      reason: `current branch is ${branch.ok ? branch.output : '<unknown>'}, expected ${expectedBranch}`,
      next: story.worktree?.path ? `cd ${story.worktree.path}` : `git switch ${expectedBranch}`,
      steps,
    });
  }

  const mainRef = gitMaybe(gitCwd, ['rev-parse', '--verify', 'main^{commit}']);
  if (!mainRef.ok) {
    setStep(steps, 'preflight', 'blocked', 'local main ref is unavailable');
    return blocked({
      blockedAt: 'preflight',
      reason: `local main cannot be found: ${mainRef.error}`,
      next: 'fetch or create a local main branch, then rerun proof-or-stop done_prepare',
      steps,
    });
  }

  const initialDirty = nonLeaseDirtyRows(ctx, storyId, gitStatusRows(gitCwd));
  const initialDirtyClassification = classifyDirtyRows(ctx, storyId, initialDirty);
  const initialBlockingEntries = initialDonePrepareBlockingEntries(ctx, storyId, initialDirtyClassification);
  if (initialBlockingEntries.length > 0) {
    const files = entryFiles(initialBlockingEntries);
    const hasMergeOverwriteHazard = initialBlockingEntries.some(
      (entry) => entry.statusCode === '??' && pathExistsOnMain(gitCwd, entry.path),
    );
    setStep(steps, 'cleanTree', 'blocked', 'worktree must be clean before DONE prepare can mutate');
    return blocked({
      blockedAt: 'cleanTree',
      reason: 'worktree has dirty files that are not Proof-or-Stop story lifecycle metadata; done_prepare cannot mutate yet',
      files,
      guidanceSections: buildInitialDirtyGuidance(gitCwd, initialBlockingEntries),
      next: hasMergeOverwriteHazard
        ? 'preserve or move the file, then rerun done_prepare'
        : 'inspect the dirty file classification above, then rerun done_prepare after the worktree is safe',
      steps,
    });
  }
  const initialAllowedMetadataSignatures = new Set(
    initialDirtyClassification.groups.proof_or_stop_metadata_changes
      .filter((entry) => isDonePrepareAllowedInitialMetadataEntry(ctx, storyId, entry))
      .map((entry) => dirtyEntrySignature(gitCwd, entry)),
  );
  setStep(
    steps,
    'preflight',
    'pass',
    initialAllowedMetadataSignatures.size > 0
      ? 'only pre-existing Proof-or-Stop story lifecycle metadata is dirty'
      : undefined,
  );

  if (!args.mergeMain) {
    setStep(steps, 'mergeMain', 'skipped', 'mergeMain=false');
  } else if (args.dryRun) {
    setStep(
      steps,
      'mergeMain',
      isMainAncestor(gitCwd) ? 'pass' : 'skipped',
      isMainAncestor(gitCwd) ? undefined : 'planned mutation skipped: dryRun would run git merge main',
      'git merge main',
    );
  } else {
    const merge = gitMaybe(gitCwd, ['merge', 'main', '--no-edit']);
    if (!merge.ok) {
      const files = conflictFiles(gitCwd);
      setStep(steps, 'mergeMain', 'blocked', 'git merge main failed with conflicts', 'git merge main');
      return blocked({
        blockedAt: 'mergeMain',
        reason: merge.error || 'git merge main failed',
        files,
        guidanceSections: buildMergeConflictGuidance(),
        next: 'resolve the listed merge conflict files manually, commit the merge, then rerun proof-or-stop done_prepare',
        steps,
      });
    }
    setStep(steps, 'mergeMain', 'pass', merge.output || 'main already merged', 'git merge main');
  }

  const prepareMutationStartHead = currentGitHead(gitCwd);
  if (!prepareMutationStartHead) {
    setStep(steps, 'preflight', 'blocked', 'cannot read git HEAD before refresh/validate');
    return blocked({
      blockedAt: 'preflight',
      reason: 'cannot read git HEAD before refresh/validate',
      next: 'git rev-parse HEAD',
      steps,
    });
  }
  const prepareMutationStartBinding = currentDoneMaterialBinding(ctx, gitCwd);
  const generatedMetadataBaseline = captureDonePrepareGeneratedMetadataBaseline({
    root: ctx.root,
    storyDirRel: ctx.store.storyDirRel(),
    storyId,
    initialDirtyRows: nonLeaseDirtyRows(ctx, storyId, gitStatusRows(gitCwd)),
  });
  let validationReuseBasis: DonePrepareValidationReuseBasis | undefined;
  let expectedProcessEventBinding: DonePrepareGeneratedProcessEventBinding | undefined;

  let stalePlan: StaleEvidencePlan;
  try {
    stalePlan = classifyStaleEvidence(ctx, storyId, gitCwd);
  } catch (err: any) {
    setStep(steps, 'staleEvidenceRefresh', 'blocked', err?.message || 'stale evidence classification failed');
    return blocked({
      blockedAt: 'evidenceFreshness',
      reason: err?.message || 'stale evidence classification failed',
      next: `proof-or-stop verification_evidence_refresh_stale --storyId=${storyId} --dryRun`,
      steps,
    });
  }

  if (stalePlan.staleCount === 0) {
    setStep(steps, 'staleEvidenceRefresh', 'pass', 'no stale verification evidence');
  } else if (!args.refreshStale) {
    setStep(steps, 'staleEvidenceRefresh', 'blocked', `${stalePlan.staleCount} stale evidence item(s); refreshStale=false`);
    return blocked({
      blockedAt: 'evidenceFreshness',
      reason: `${stalePlan.staleCount} stale verification evidence item(s) found; refreshStale=false`,
      next: `proof-or-stop verification_evidence_refresh_stale --storyId=${storyId}`,
      commands: stalePlan.rerunRequired.map((entry) => entry.command),
      steps,
    });
  } else if (stalePlan.rerunRequired.length > 0) {
    const commands = [...new Set(stalePlan.rerunRequired.map((entry) => entry.command))];
    setStep(steps, 'staleEvidenceRefresh', 'blocked', 'stale command-backed evidence must be rerun');
    return blocked({
      blockedAt: 'evidenceFreshness',
      reason: 'stale command-backed verification evidence must be rerun; done_prepare will not freshen it by rewriting hashes',
      commands,
      next: commands[0] || `proof-or-stop validate --story=${storyId} --json`,
      steps,
    });
  } else if (args.dryRun) {
    setStep(steps, 'staleEvidenceRefresh', 'skipped', `planned mutation skipped: dryRun would refresh ${stalePlan.safeRefresh.length} metadata-only stale evidence item(s)`);
  } else {
    const refreshed = asText(refreshStaleEvidenceMetadataOnly(ctx, storyId));
    setStep(steps, 'staleEvidenceRefresh', 'pass', refreshed.split('\n').find((line) => line.trim()) || stalePlan.dryRunTranscript);
  }

  if (!args.validate) {
    const existing = evaluateDoneRequiredPreRunReuse({ root: ctx.root, gitCwd, storyId, store: ctx.store });
    setStep(steps, 'validate', 'skipped',
      `validate=false; disposition=skipped_explicitly result=not_run existingEvidenceBasis=${existing.existingEvidenceBasis} refusalReasons=${existing.refusalReasons.join(',') || 'none'} timeoutLayer=null`);
  } else if (args.dryRun) {
    setStep(steps, 'validate', 'skipped', 'planned mutation skipped: dryRun does not run proof-or-stop validate');
  } else {
    const verifier = createVerifierHandlers(ctx);
    const routineValidationStartedAt = new Date().toISOString();
    let validateText = '';
    const validationSummaries: string[] = [];
    try {
      validateText = asText(await verifier.validate({
        story: storyId,
        json: true,
        noSync: true,
        abortSignal: rawArgs.abortSignal,
        deadlineAt: rawArgs.deadlineAt,
        deadlineError: rawArgs.deadlineError,
      }));
    } catch (err: any) {
      const timeoutLayer = timeoutLayerFromReason(rawArgs.abortSignal?.reason) ?? timeoutLayerFromReason(err);
      const terminal = timeoutLayer
        ? `${err?.message || 'proof-or-stop validate timed out'}; disposition=executed result=timed_out refusalReasons=${err?.message || 'routine-validation-timeout'} timeoutLayer=${timeoutLayer} existingEvidenceBasis=stale`
        : (err?.message || 'proof-or-stop validate failed');
      setStep(steps, 'validate', 'blocked', terminal);
      return blocked({
        blockedAt: 'validate',
        reason: terminal,
        next: `proof-or-stop validate --story=${storyId} --json`,
        steps,
      });
    }
    const parsed = parseValidateOutput(validateText);
    const routineValidationEndedAt = new Date().toISOString();
    const routineTimeoutLayer = timeoutLayerFromReason(rawArgs.abortSignal?.reason);
    if (routineTimeoutLayer) {
      const reason = `routine validation exceeded CLI ${routineTimeoutLayer} timeout; disposition=executed result=timed_out refusalReasons=routine-validation-${routineTimeoutLayer}-timeout timeoutLayer=${routineTimeoutLayer} existingEvidenceBasis=stale`;
      setStep(steps, 'validate', 'blocked', reason);
      return blocked({ blockedAt: 'validate', reason, next: `inspect routine validation and ${routineTimeoutLayer} timeout configuration`, steps });
    }
    if (!parsed.ok) {
      setStep(steps, 'validate', 'blocked', parsed.summary);
      return blocked({
        blockedAt: 'validate',
        reason: parsed.summary,
        next: parsed.next.replace('<storyId>', storyId),
        steps,
      });
    }
    validationSummaries.push(parsed.summary);
    if (parsed.disposition === 'reused' && parsed.identityDigest) {
      const materialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
      const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', ctx.root);
      if (materialHash && storyFilesHash) {
        expectedProcessEventBinding = {
          storyId,
          attemptId: story.currentReviewRound ?? '',
          reviewRound: story.currentReviewRound ?? '',
          commandSetHash: parsed.identityDigest,
          materialHash,
          storyFilesHash,
          phase: 'TEST',
          disposition: 'reused',
          result: 'pass',
          commandExecutions: 0,
          notBefore: routineValidationStartedAt,
          notAfter: routineValidationEndedAt,
        };
      }
    }

    const doneRequiredPolicy = resolveDoneRequiredPolicy(ctx.root);
    if (doneRequiredPolicy.required) {
      const doneRequiredHandlers = createDoneRequiredValidationHandlers(ctx);
      const command = `proof-or-stop done_required_validate --storyId=${storyId}`;
      const reuse = evaluateDoneRequiredPreRunReuse({ root: ctx.root, gitCwd, storyId, store: ctx.store });
      if (args.reuseFreshDoneRequired && reuse.reusable) {
        validationSummaries.push(
          `DONE-required validation reused: disposition=reused result=pass existingEvidenceBasis=fresh refusalReasons=none timeoutLayer=null lineage=${reuse.lineage}`,
        );
      } else {
        let doneRequiredText = '';
        try {
          doneRequiredText = asText(await runCloseoutPhase(
            ctx,
            CLOSEOUT_PHASES.doneRequiredValidation,
            (phaseControl) => doneRequiredHandlers.done_required_validate({
              storyId,
              json: true,
              progress: (event: Parameters<typeof formatValidationProgressEvent>[0]) => {
                ctx.log?.(formatValidationProgressEvent(event));
              },
              abortSignal: phaseControl.signal,
              deadlineAt: phaseControl.deadlineAt,
              deadlineError: phaseControl.timeoutError,
            }),
            rawArgs,
          ));
        } catch (err: any) {
          if (isDonePreparePhaseTimeout(err)) return phaseTimeoutBlock(storyId, steps, err, args.dryRun);
          const watchdogBlock = cliWatchdogTimeoutBlock(CLOSEOUT_PHASES.doneRequiredValidation, steps, err, args.dryRun);
          if (watchdogBlock) return watchdogBlock;
          setStep(steps, 'validate', 'blocked', `${err?.message || 'DONE-required validation failed'}; disposition=executed result=blocked existingEvidenceBasis=${reuse.existingEvidenceBasis} refusalReasons=${reuse.refusalReasons.join(',') || 'execution-failed'}`, command);
          return blocked({
            blockedAt: 'validate',
            reason: `${err?.message || 'DONE-required validation failed'}; disposition=executed result=blocked existingEvidenceBasis=${reuse.existingEvidenceBasis} refusalReasons=${reuse.refusalReasons.join(',') || 'execution-failed'}`,
            next: safeDoneRequiredRecoveryCommand(storyId, err?.message || '', command),
            steps,
          });
        }
        const parsedDoneRequired = parseValidateOutput(
          doneRequiredText,
          safeDoneRequiredRecoveryCommand(storyId, doneRequiredText, command),
        );
        if (!parsedDoneRequired.ok) {
          setStep(steps, 'validate', 'blocked', parsedDoneRequired.summary, command);
          return blocked({
            blockedAt: 'validate',
            reason: `${parsedDoneRequired.summary}; disposition=${parsedDoneRequired.disposition ?? 'executed'} result=${parsedDoneRequired.result ?? 'failed'} existingEvidenceBasis=${parsedDoneRequired.existingEvidenceBasis ?? reuse.existingEvidenceBasis} refusalReasons=${parsedDoneRequired.refusalReasons?.join(',') || reuse.refusalReasons.join(',') || 'validation-failed'} timeoutLayer=${parsedDoneRequired.timeoutLayer ?? 'null'}`,
            next: parsedDoneRequired.next,
            steps,
          });
        }
        validationSummaries.push(
          `DONE-required validation passed: ${parsedDoneRequired.summary}; disposition=${parsedDoneRequired.disposition ?? 'executed'} result=${parsedDoneRequired.result ?? 'pass'} existingEvidenceBasis=${parsedDoneRequired.existingEvidenceBasis ?? reuse.existingEvidenceBasis} refusalReasons=${parsedDoneRequired.refusalReasons?.join(',') || reuse.refusalReasons.join(',') || (args.reuseFreshDoneRequired ? 'none' : 'reuse-disabled')} timeoutLayer=${parsedDoneRequired.timeoutLayer ?? 'null'}`,
        );
      }
    }

    setStep(
      steps,
      'validate',
      'pass',
      validationSummaries.join('; '),
      `proof-or-stop validate --story=${storyId} --json`,
    );
    validationReuseBasis = captureDonePrepareValidationReuseBasis({
      root: ctx.root,
      gitCwd,
      storyId,
      store: ctx.store,
    });
  }

  const validationContext = observedValidationTerminalContext(steps);
  const prepareMutationEndHead = currentGitHead(gitCwd);
  if (prepareMutationEndHead && prepareMutationEndHead !== prepareMutationStartHead) {
    const commits = commitSummariesSince(gitCwd, prepareMutationStartHead, prepareMutationEndHead);
    const dirtyRows = nonLeaseDirtyRows(ctx, storyId, gitStatusRows(gitCwd));
    const files = statusFiles(dirtyRows);
    const currentBinding = currentDoneMaterialBinding(ctx, gitCwd);
    const advance = validationCloseoutAdvancePaths(
      ctx,
      storyId,
      gitCwd,
      prepareMutationStartHead,
      prepareMutationEndHead,
    );
    const materialUnchanged = Boolean(prepareMutationStartBinding.currentMaterialHash)
      && prepareMutationStartBinding.currentMaterialHash === currentBinding.currentMaterialHash;
    const storyFilesUnchanged = Boolean(prepareMutationStartBinding.currentStoryFilesHash)
      && prepareMutationStartBinding.currentStoryFilesHash === currentBinding.currentStoryFilesHash;
    if (!validationReuseBasis || !advance.eligible || !materialUnchanged || !storyFilesUnchanged) {
      const driftReasons = [
        ...advance.reasons,
        ...(!validationReuseBasis ? ['validation reuse basis missing after validation'] : []),
        ...(!materialUnchanged ? ['materialHash changed during validation'] : []),
        ...(!storyFilesUnchanged ? ['storyFilesHash changed during validation'] : []),
      ];
      setStep(steps, 'cleanTree', 'blocked', 'refresh/validate produced non-closeout or material-changing commit(s); rerun required');
      return blocked({
        blockedAt: 'cleanTree',
        reason: `done_prepare produced commit(s) that are not a trusted nonmaterial validation closeout advance: ${driftReasons.join('; ')}`,
        commits,
        ...(files.length > 0 ? { files } : {}),
        guidanceSections: buildRerunReasonGuidance(commits, currentBinding),
        commands: [
          `git log --oneline ${prepareMutationStartHead}..HEAD`,
          `proof-or-stop done_prepare '{"storyId":"${storyId}"}'`,
        ],
        next: 'inspect the generated commits and rerun only after resolving real drift',
        steps,
      });
    }
    ctx.log?.(
      `done_prepare convergence: retained review across trusted validation metadata advance ` +
      `paths=${advance.paths.join(',')} metadataRollbacks=0 reviewerReattestations=0 humanConfirmations=0`,
    );
  }

  if (args.build) {
    if (args.dryRun) {
      setStep(steps, 'worktreeVersionCheck', 'skipped', 'planned mutation skipped: dryRun does not build');
    } else {
      try {
        childProcess.execFileSync('npm', ['--prefix', 'packages/main', 'run', 'build'], {
          cwd: ctx.root,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        childProcess.execFileSync(process.execPath, ['packages/main/dist/cli.js', '--version'], {
          cwd: ctx.root,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        setStep(steps, 'worktreeVersionCheck', 'pass', 'worktree CLI build executes');
      } catch (err: any) {
        setStep(steps, 'worktreeVersionCheck', 'blocked', 'worktree CLI build does not execute');
        return blocked({
          blockedAt: 'worktreeVersionCheck',
          reason: String(err?.stderr || err?.stdout || err?.message || err).trim() || 'worktree CLI build does not execute',
          next: 'npm --prefix packages/main run build',
          steps,
        });
      }
    }
  }

  let runbook: DoneClosureRunbook;
  let packSurface: ReturnType<typeof surfaceRuntimeMemoryPack>;
  try {
    ({ runbook, packSurface } = await runCloseoutPhase(ctx, CLOSEOUT_PHASES.doneClosure, () => {
      const computedRunbook = buildDoneClosureRunbook(ctx, storyId);
      // B-ab8d CHK-002: experiment-arm surfacing for the done_prepare entrypoint —
      // the runbook pack is already computed; fire the once-per-key event on both
      // arms and gate ONLY the rendered summary section (control hides it).
      const computedPackSurface = surfaceRuntimeMemoryPack(ctx.root, {
        consumer: 'done_prepare',
        storyId,
        roundKey: story.phase,
        buildPack: () => computedRunbook.memoryFreshnessPack,
      });
      return { runbook: computedRunbook, packSurface: computedPackSurface };
    }, rawArgs));
  } catch (err) {
    if (isDonePreparePhaseTimeout(err)) return phaseTimeoutBlock(storyId, steps, err, args.dryRun);
    const watchdogBlock = cliWatchdogTimeoutBlock(CLOSEOUT_PHASES.doneClosure, steps, err, args.dryRun, validationContext);
    if (watchdogBlock) return watchdogBlock;
    throw err;
  }

  let nonCleanBlockers: ReturnType<typeof blockingRows>;
  let reviewAssuranceBlocked = false;
  let reviewAssuranceCurrentBinding: DonePrepareCurrentBinding | undefined;
  let reviewAssurancePlan: DonePrepareReviewAssurancePlan | undefined;
  try {
    ({ nonCleanBlockers, reviewAssuranceBlocked, currentBinding: reviewAssuranceCurrentBinding, reviewAssurancePlan } = await runCloseoutPhase(ctx, CLOSEOUT_PHASES.reviewAssurance, () => {
      const allBlockers = blockingRows(runbook);
      const assuranceBlocked = hasReviewAssuranceBlocker(runbook);
      const currentBinding = assuranceBlocked ? currentDoneMaterialBinding(ctx, gitCwd) : undefined;
      return {
        nonCleanBlockers: allBlockers.filter((row) => row.id !== 'git-working-tree'),
        reviewAssuranceBlocked: assuranceBlocked,
        currentBinding,
        reviewAssurancePlan: currentBinding
          ? buildDonePrepareReviewAssurancePlan(ctx, storyId, gitCwd, currentBinding)
          : undefined,
      };
    }, rawArgs));
  } catch (err) {
    if (isDonePreparePhaseTimeout(err)) return phaseTimeoutBlock(storyId, steps, err, args.dryRun);
    const watchdogBlock = cliWatchdogTimeoutBlock(CLOSEOUT_PHASES.reviewAssurance, steps, err, args.dryRun, validationContext);
    if (watchdogBlock) return watchdogBlock;
    throw err;
  }

  if (nonCleanBlockers.length > 0) {
    const currentBinding = reviewAssuranceBlocked ? reviewAssuranceCurrentBinding : undefined;
    const reason = nonCleanBlockers.map((row) => `${row.id}: ${row.reason}`).join('; ');
    setStep(steps, 'doneClosure', 'blocked', reason);
    return blocked({
      blockedAt: 'doneClosure',
      reason,
      currentBinding,
      reviewAssurancePlan,
      ...(packSurface.shouldRender ? { memoryFreshnessPack: runbook.memoryFreshnessPack } : {}),
      next: nextForDoneClosureBlock(storyId, runbook, reviewAssurancePlan),
      commands: commandsForDoneClosureBlock(storyId, runbook, reviewAssurancePlan),
      steps,
    });
  }
  setStep(steps, 'doneClosure', 'pass', runbook.canAttemptDone ? 'canAttemptDone=true' : 'only git clean-tree remains');

  let runtime: RuntimeChangeReport;
  try {
    runtime = await runCloseoutPhase(ctx, CLOSEOUT_PHASES.runtimeChange, () => detectRuntimeChanges(ctx.root, gitCwd), rawArgs);
  } catch (err) {
    if (isDonePreparePhaseTimeout(err)) return phaseTimeoutBlock(storyId, steps, err, args.dryRun);
    const watchdogBlock = cliWatchdogTimeoutBlock(CLOSEOUT_PHASES.runtimeChange, steps, err, args.dryRun, validationContext);
    if (watchdogBlock) return watchdogBlock;
    throw err;
  }
  setStep(steps, 'runtimeChange', 'pass', runtime.postDoneRuntimeVersionBumpRequired ? 'runtime behavior change detected' : 'no runtime version bump required before DONE');

  let finalDirtyClassification: DirtyWorktreeClassification;
  let finalBlockingEntries: DirtyWorktreeEntry[];
  try {
    ({ finalDirtyClassification, finalBlockingEntries } = await runCloseoutPhase(ctx, CLOSEOUT_PHASES.cleanTree, () => {
      const finalDirty = nonLeaseDirtyRows(ctx, storyId, gitStatusRows(gitCwd));
      const classification = classifyDirtyRows(ctx, storyId, finalDirty);
      return {
        finalDirtyClassification: classification,
        finalBlockingEntries: classification.entries.filter(
          (entry) => !unchangedFromInitialAllowedMetadata(ctx, storyId, gitCwd, entry, initialAllowedMetadataSignatures),
        ),
      };
    }, rawArgs));
  } catch (err) {
    if (isDonePreparePhaseTimeout(err)) return phaseTimeoutBlock(storyId, steps, err, args.dryRun);
    const watchdogBlock = cliWatchdogTimeoutBlock(CLOSEOUT_PHASES.cleanTree, steps, err, args.dryRun, validationContext);
    if (watchdogBlock) return watchdogBlock;
    throw err;
  }
  if (finalBlockingEntries.length > 0) {
    const files = entryFiles(finalBlockingEntries);
    const generatedMetadataManifest = buildDonePrepareGeneratedMetadataManifest({
      root: ctx.root,
      storyId,
      storyDirRel: ctx.store.storyDirRel(),
      baseline: generatedMetadataBaseline,
      statusRows: nonLeaseDirtyRows(ctx, storyId, gitStatusRowsForDonePrepareGeneratedMetadata(gitCwd)),
      expectedProcessEventBinding,
    });
    if (args.autoCloseGeneratedMetadata && !args.dryRun) {
      if (!args.reuseFreshValidation) {
        setStep(steps, 'cleanTree', 'blocked', 'auto-closeout requires reuseFreshValidation=true to re-evaluate without rerunning validation');
        return blocked({
          blockedAt: 'cleanTree',
          reason: 'autoCloseGeneratedMetadata was requested, but reuseFreshValidation=false; refusing to skip validation after metadata-only HEAD drift',
          files,
          guidanceSections: buildGeneratedMetadataDirtyGuidance(generatedMetadataManifest),
          next: `rerun proof-or-stop done_prepare '{"storyId":"${storyId}","autoCloseGeneratedMetadata":true,"reuseFreshValidation":true}' when validation reuse is intended`,
          steps,
        });
      }
      if (!validationReuseBasis) {
        setStep(steps, 'validate', 'blocked', 'validation reuse basis is missing');
        return blocked({
          blockedAt: 'validate',
          reason: 'reuseFreshValidation requires this done_prepare invocation to run validation and DONE-required validation before auto-closeout',
          files,
          guidanceSections: buildGeneratedMetadataDirtyGuidance(generatedMetadataManifest),
          next: `proof-or-stop done_prepare '{"storyId":"${storyId}","validate":true,"autoCloseGeneratedMetadata":true,"reuseFreshValidation":true}'`,
          steps,
        });
      }
      const manifestPreflight = generatedMetadataManifest;
      if (manifestPreflight.safePaths.length === 0 || manifestPreflight.unsafePaths.length > 0) {
        const reason = manifestPreflight.safePaths.length === 0
          ? 'no current-run generated DONE/test lifecycle metadata is safe to auto-close'
          : 'git status contains path(s) outside the safe generated metadata manifest';
        setStep(steps, 'cleanTree', 'blocked', reason);
        return blocked({
          blockedAt: 'cleanTree',
          reason: `DONE prepare auto-closeout refused: ${reason}`,
          files: manifestPreflight.unsafePaths.length > 0 ? manifestPreflight.unsafePaths : files,
          guidanceSections: buildGeneratedMetadataDirtyGuidance(manifestPreflight),
          next: 'inspect git status and commit only generated Proof-or-Stop lifecycle metadata manually, then rerun done_prepare',
          steps,
        });
      }
      const reuseRecordPath = normalizeRelPath(`${ctx.store.storyDirRel()}/${storyId}/done-required-evidence.json`);
      const autoCloseoutTransactionPaths = sortedUniqueRelPaths([...manifestPreflight.safePaths, reuseRecordPath]);
      let autoCloseoutTransaction: DonePrepareGeneratedMetadataTransaction;
      try {
        autoCloseoutTransaction = captureDonePrepareGeneratedMetadataTransaction({
          root: ctx.root,
          gitCwd,
          paths: autoCloseoutTransactionPaths,
        });
      } catch (err: any) {
        const reason = `auto-closeout transaction capture failed: ${String(err?.stderr || err?.stdout || err?.message || err).trim()}`;
        setStep(steps, 'cleanTree', 'blocked', reason);
        return blocked({
          blockedAt: 'cleanTree',
          reason: `DONE prepare auto-closeout refused: ${reason}`,
          files,
          guidanceSections: buildGeneratedMetadataDirtyGuidance(generatedMetadataManifest),
          next: 'inspect git status and commit only generated Proof-or-Stop lifecycle metadata manually, then rerun done_prepare',
          steps,
        });
      }
      const reuse = writeDonePrepareValidationReuseRecord({
        root: ctx.root,
        gitCwd,
        storyId,
        store: ctx.store,
        basis: validationReuseBasis,
        generatedMetadataPaths: manifestPreflight.safePaths,
      });
      if (!reuse.ok) {
        setStep(steps, 'validate', 'blocked', `validation reuse not eligible: ${reuse.reasons.join('; ')}`);
        return blocked({
          blockedAt: 'validate',
          reason: `validation reuse not eligible: ${reuse.reasons.join('; ')}`,
          files,
          guidanceSections: buildGeneratedMetadataDirtyGuidance(generatedMetadataManifest),
          next: `rerun full validation: proof-or-stop done_prepare '{"storyId":"${storyId}","validate":true}'`,
          steps,
        });
      }
      const autoCommit = commitDonePrepareGeneratedMetadata({
        root: ctx.root,
        gitCwd,
        storyId,
        storyDirRel: ctx.store.storyDirRel(),
        baseline: generatedMetadataBaseline,
        expectedProcessEventBinding,
        ignoredPaths: [ownerLeaseRelPath(ctx, storyId)],
      });
      if (!autoCommit.ok) {
        const rollback = rollbackDonePrepareGeneratedMetadataTransaction({
          root: ctx.root,
          gitCwd,
          transaction: autoCloseoutTransaction,
        });
        const rollbackSuffix = rollback.ok ? '' : `; rollback failed: ${rollback.errors.join('; ')}`;
        setStep(steps, 'cleanTree', 'blocked', `${autoCommit.reason || 'auto-closeout refused'}${rollbackSuffix}`);
        return blocked({
          blockedAt: 'cleanTree',
          reason: `DONE prepare auto-closeout refused: ${autoCommit.reason || 'unsafe generated metadata manifest'}${rollbackSuffix}`,
          files: autoCommit.files.length > 0 ? autoCommit.files : files,
          guidanceSections: buildGeneratedMetadataDirtyGuidance(generatedMetadataManifest),
          next: 'inspect git status and commit only generated Proof-or-Stop lifecycle metadata manually, then rerun done_prepare',
          steps,
        });
      }
      ctx.log?.(`done_prepare auto-closeout: committed generated metadata ${autoCommit.commitSha}`);
      const reevaluated = await runDonePrepare(ctx, {
        storyId,
        mergeMain: false,
        refreshStale: false,
        validate: false,
        build: false,
        dryRun: false,
        json: false,
        autoCloseGeneratedMetadata: false,
        reuseFreshValidation: false,
      });
      return injectAutoCloseoutSummary(reevaluated, autoCommit);
    }
    setStep(steps, 'cleanTree', 'blocked', 'done_prepare produced files that must be committed before DONE');
    const generatedPaths = generatedMetadataManifest.safePaths;
    const unsafePaths = generatedMetadataManifest.unsafePaths;
    const next = generatedPaths.length > 0 && unsafePaths.length === 0
      ? `git add ${generatedPaths.map((file) => `"${file}"`).join(' ')} && git commit -m "proof-or-stop: prepare ${storyId} for DONE"`
      : generatedPaths.length > 0
        ? 'commit only the current-run generated metadata listed above; preserve or resolve unsafe/pre-existing dirty files separately, then rerun done_prepare'
        : 'inspect the unsafe/pre-existing dirty files listed above, then rerun done_prepare after the worktree is safe';
    return blocked({
      blockedAt: 'cleanTree',
      reason: 'done_prepare produced metadata changes that must be committed before DONE',
      files,
      guidanceSections: buildGeneratedMetadataDirtyGuidance(generatedMetadataManifest),
      next,
      steps,
    });
  }
  setStep(
    steps,
    'cleanTree',
    'pass',
    finalDirtyClassification.total > 0 ? 'only unchanged pre-existing Proof-or-Stop story lifecycle metadata remains dirty' : undefined,
  );

  try {
    return await runCloseoutPhase(ctx, CLOSEOUT_PHASES.produceCommand, () => renderPass({
      storyId,
      phase: story.phase,
      steps,
      runbook,
      runtime,
      dryRun: args.dryRun,
      showMemoryPack: packSurface.shouldRender,
      convergenceFacts: collectDonePrepareConvergenceFacts(ctx, storyId),
    }), rawArgs);
  } catch (err) {
    if (isDonePreparePhaseTimeout(err)) return phaseTimeoutBlock(storyId, steps, err, args.dryRun);
    const watchdogBlock = cliWatchdogTimeoutBlock(CLOSEOUT_PHASES.produceCommand, steps, err, args.dryRun, validationContext);
    if (watchdogBlock) return watchdogBlock;
    throw err;
  }
}

export function createDonePrepareHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    async done_prepare(args: DonePrepareArgs) {
      let transcript: string;
      try {
        transcript = await runDonePrepare(ctx, args);
      } catch (error) {
        const timeoutLayer = timeoutLayerFromReason(args.abortSignal?.reason) ?? timeoutLayerFromReason(error);
        const reason = error instanceof Error ? error.message : String(error);
        if (!timeoutLayer && args.validate !== false) throw error;
        transcript = [
          'DONE prepare: BLOCKED',
          'blockedAt: validate',
          `reason: ${reason}; disposition=${timeoutLayer ? 'executed' : 'skipped_explicitly'} result=${timeoutLayer ? 'timed_out' : 'not_run'} refusalReasons=${timeoutLayer ? reason : `evidence-malformed-or-unreadable:${reason}`} timeoutLayer=${timeoutLayer ?? 'null'} existingEvidenceBasis=stale`,
          'next: inspect the attributed timeout layer, verify child/lock cleanup, then rerun with a corrected command or explicit legal budget',
        ].join('\n');
      }
      if (args?.json === true) return donePrepareJsonResult(args.storyId ?? '', transcript);
      return transcript;
    },
  };
}
