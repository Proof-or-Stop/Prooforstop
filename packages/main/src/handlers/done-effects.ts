/**
 * B-9027 (Lifecycle Phase 2, Story 3b): done-effects — the DONE merge /
 * worktree cleanup pipeline of story_advance.
 *
 * The DONE pipeline was mechanically relocated here from
 * handlers/story-advance.ts with ZERO semantic change — step order, output
 * text, and failure semantics are byte-identical before and after the move
 * (Option A behavior-preserving extraction). After the B-6974 refactor,
 * handlers/transition-orchestrator.ts is the direct caller: its
 * runStoryTransition invokes the two exported functions at the exact same
 * call sites the DONE pipeline used to run them inline.
 *
 * The DONE pipeline straddles the actor.send boundary, so it is split into two
 * exported functions called at the same timing as the inline originals:
 *
 *   - runDonePreMergeGate    — block A: pre-merge gates that must run BEFORE
 *                              phase=DONE is persisted. Runs the done-oracle
 *                              gate, the F-020 stray-file dry-run, and the
 *                              merge-tree dry-run. Any failure throws while the
 *                              story is still TEST. Returns the rendered DONE
 *                              checklist string as an explicit value — the
 *                              caller holds it in a local variable across the
 *                              actor.send boundary (replaces the old global
 *                              cross-actor.send stash).
 *   - applyDoneMergeEffects  — block B: the real merge / worktree cleanup that
 *                              runs AFTER writeStory(phase=DONE). Step1 clears
 *                              the worktree field, Step2 commits metadata,
 *                              Step2.5 cleans stray whitelist files, Step3
 *                              merges the story branch, Step4 removes the
 *                              worktree, Step5 deletes the branch, then a
 *                              cleanupFailure throw and a non-blocking
 *                              maybeTriggerAudit. The caller passes in the
 *                              rendered checklist held since block A.
 *
 * Layering: this module lives in handlers/ (NOT core/) on purpose. It depends
 * on handler-only modules (phase-gates.ts, stray-file-cleanup.ts,
 * worktree.ts) and shares the layer with transition-orchestrator.ts. It must
 * NOT import handlers/transition-orchestrator.js (no circular import);
 * transition-orchestrator imports done-effects, never the reverse.
 */

import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { maybeTriggerAudit } from '../core/audit-trigger.js';
import { randomUUID } from 'crypto';
import { execFileSync, execSync, spawnSync } from 'child_process';
import { dirname, resolve, join } from 'path';
import { existsSync, rmSync } from 'fs';
import { cleanStrayWorktreeFiles } from './stray-file-cleanup.js';
import { repairGlobalLatticeLinkBeforeWorktreeDelete } from './worktree.js';
import { reportHealthIssue } from '../core/health.js';
import { runDoneOracleGate } from './phase-gates.js';
import type { AcquiredMkdirLock } from '../core/mkdir-lock.js';
import { acquireMainWriteLockRegistered, mainWriteLockPath, withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainBranchWorktree } from '../core/partial-done-recovery.js';
import {
  ARTIFACT_RELEASE_LEDGER_REL_PATH,
  type RecordArtifactReleaseResult,
  recordArtifactReleaseForDoneMerge,
  selectArtifactReleasePathsV1,
} from '../core/artifact-release.js';
import {
  cleanupAuxiliaryWorktreeResidues,
  renderAuxiliaryClassification,
} from '../core/auxiliary-worktree-cleanup.js';
import { bumpVersionOnDoneMerge } from '../core/version-bump.js';
import { deriveFindingSignalsFromStore } from '../core/finding-signals.js';
import { appendPlaybookPromotionHealthEvent, resolveLearningOwnerRoot, withLearningStoreLock } from '../core/learning-store.js';
import { buildPlaybookCandidateIngestReport } from '../core/playbook-seed.js';

// B-c622 CHK-004: DONE 阶段自动同步 main —— detect divergence + auto merge main.
// checkMainDivergence is defined in core/done-oracle.ts and imported by
// handlers/transition-orchestrator.ts (it is a DONE pre-check that runs before
// actor.can() / before this module's gate); autoSyncMain lives here as a
// DONE-only helper.

/** Auto-sync main into the current branch. Returns success/failure + message. */
export function autoSyncMain(gitCwd: string): { ok: boolean; message: string } {
  // B-75f0: the parameter is named `gitCwd` because it ALREADY receives the
  // resolved gitCwd — the sole caller (transition-orchestrator.ts
  // runStoryTransition DONE branch) routes ctx.root through resolveGitCwd ONCE
  // at the entry of the DONE pre-check block (doneGitCwd) and passes the
  // resolved value here. In a wrapper-root layout that is the configured
  // gitRoot subdir, not the metadataRoot. Plain-repo fallback is also handled
  // by resolveGitCwd, so this stays byte-identical (pure rename, B-75f0 CHK-004).
  // Try to fetch origin main first (fails silently for local-only repos)
  try {
    execSync('git fetch origin main:main', {
      cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { /* local-only repo or no remote — skip fetch */ }
  try {
    execSync('git merge main --no-edit', {
      cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, message: 'main 已自动同步到当前分支' };
  } catch {
    // conflict — abort merge to keep branch clean
    try {
      execSync('git merge --abort', {
        cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* abort failed — already clean */ }
    return { ok: false, message: 'merge main 有冲突（已 abort 保持分支干净）。\n→ 执�� git merge main，解决冲突后 git add + git commit，然后重跑 story_advance DONE' };
  }
}

function isRegisteredWorktree(repoRoot: string, worktreePath: string): boolean {
  try {
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const target = worktreePath.replace(/\\/g, '/');
    return raw
      .split(/\r?\n/)
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim().replace(/\\/g, '/'))
      .includes(target);
  } catch {
    return false;
  }
}

function pruneWorktreeRegistry(repoRoot: string): void {
  execFileSync('git', ['worktree', 'prune', '--expire', 'now'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export type DoneMainBuildCommandResult = {
  status: number | null;
  stdout?: unknown;
  stderr?: unknown;
  error?: unknown;
};

export type DoneMainBuildRunner = (cwd: string) => DoneMainBuildCommandResult;

export const DONE_MAIN_BUILD_COMMAND = 'npm --prefix packages/main run build';

function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

export function isDoneMainRuntimeBuildInput(path: string): boolean {
  const rel = normalizeGitPath(path);
  return rel.startsWith('packages/main/src/')
    || rel === 'packages/main/package.json'
    || rel === 'packages/main/package-lock.json'
    || rel === 'packages/main/tsconfig.json'
    || rel === 'package.json'
    || rel === 'package-lock.json';
}

export function shouldBuildDoneMainPackageForChangedPaths(paths: string[]): boolean {
  return paths.some(isDoneMainRuntimeBuildInput);
}

function listChangedPathsBetweenMainShas(mainMergeRoot: string, beforeMainSha: string, afterMainSha: string): string[] {
  if (beforeMainSha === afterMainSha) return [];
  const raw = execFileSync('git', ['diff', '--name-only', beforeMainSha, afterMainSha, '--'], {
    cwd: mainMergeRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function defaultDoneMainBuildRunner(cwd: string): DoneMainBuildCommandResult {
  const result = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

function stringifyCapturedOutput(value: unknown): string {
  if (!value) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return String(value);
}

function renderBuildCapturedOutput(result: DoneMainBuildCommandResult): string {
  return [
    stringifyCapturedOutput(result.stdout).trim(),
    stringifyCapturedOutput(result.stderr).trim(),
    result.error ? stringifyCapturedOutput(result.error).trim() : '',
  ].filter(Boolean).join('\n');
}

export function runDoneMainPackageBuildAfterMerge(
  mainMergeRoot: string,
  beforeMainSha: string,
  afterMainSha: string,
  opts: { changedPaths?: string[]; buildRunner?: DoneMainBuildRunner } = {},
): string {
  const changedPaths = opts.changedPaths ?? listChangedPathsBetweenMainShas(mainMergeRoot, beforeMainSha, afterMainSha);
  if (!shouldBuildDoneMainPackageForChangedPaths(changedPaths)) {
    return '✓ packages/main build skipped after DONE merge (no watched runtime inputs changed)';
  }

  const result = (opts.buildRunner ?? defaultDoneMainBuildRunner)(mainMergeRoot);
  if (!result.error && result.status === 0) {
    return `✓ packages/main build refreshed after DONE merge: ${DONE_MAIN_BUILD_COMMAND}`;
  }

  const captured = renderBuildCapturedOutput(result) || '(no captured output)';
  const exitDetail = result.error
    ? stringifyCapturedOutput(result.error)
    : `exit code ${result.status ?? 'unknown'}`;
  throw new Error(
    `DONE post-merge packages/main build failed (${exitDetail}); packages/main/dist may be stale.\n` +
    `Command: ${DONE_MAIN_BUILD_COMMAND}\n` +
    `Recovery: ${DONE_MAIN_BUILD_COMMAND}\n` +
    `Captured output:\n${captured}`,
  );
}

function renderArtifactReleaseDoneLine(result: RecordArtifactReleaseResult): string | null {
  if (result.status === 'skipped_empty' || !result.record) return null;
  const verb = result.status === 'already_recorded' ? 'already recorded' : 'recorded';
  return `✓ artifact release ${verb}: story=${result.record.storyId} commit=${result.record.mainCommit} artifactSetDigest=${result.record.artifactSetDigest} paths=${result.record.paths.length}`;
}

function commitArtifactReleaseLedgerIfNeeded(
  mainMergeRoot: string,
  storyId: string,
  result: RecordArtifactReleaseResult,
  runGit: (gitArgs: string[], cwd: string) => string,
): void {
  if (result.status !== 'recorded') return;
  try {
    runGit(['add', '-f', ARTIFACT_RELEASE_LEDGER_REL_PATH], mainMergeRoot);
    const staged = runGit(['diff', '--cached', '--name-only', '--', ARTIFACT_RELEASE_LEDGER_REL_PATH], mainMergeRoot);
    if (!staged) {
      throw new Error(`${ARTIFACT_RELEASE_LEDGER_REL_PATH} was not staged; check .gitignore and repository state`);
    }
    runGit(
      ['-c', 'commit.gpgsign=false', 'commit', '-m', `lattice: record artifact release for ${storyId}`],
      mainMergeRoot,
    );
  } catch (e: any) {
    throw new Error(
      `DONE post-merge artifact release ledger commit failed: ${e?.message ?? e}\n` +
      `Recovery: git add ${ARTIFACT_RELEASE_LEDGER_REL_PATH} && git commit -m "lattice: record artifact release for ${storyId}"`,
    );
  }
}

export type PostDoneLearningSettlementResult = {
  settlementStatus: 'disabled' | 'recorded' | 'failed';
  alreadyApplied: boolean;
  message: string;
  candidateIngestStatus: 'disabled' | 'applied' | 'no_candidates' | 'failed';
  candidateIngestAlreadyApplied: boolean;
  candidateIngestMessage: string;
  candidateIngestCandidateCreatedCount: number;
  candidateIngestObserveDigest?: string;
  candidateIngestProposalManifestDigest?: string;
  candidateIngestManifestDigest?: string;
};

function settlementEnvFlag(name: string): { enabled: boolean; raw: string; defaultPolicy: 'default-on'; explicitOptOut: boolean } {
  const raw = (process.env[name] ?? '').trim();
  const explicitOptOut = /^(0|false|no|off)$/i.test(raw);
  return { raw, enabled: !explicitOptOut, defaultPolicy: 'default-on', explicitOptOut };
}

function candidateHealthKeyPart(value: string): string {
  return value.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._:-]+/g, '').slice(0, 96) || 'none';
}

function appendDoneCandidateIngestHealth(
  projectRoot: string,
  storyId: string,
  status: 'recorded' | 'failed',
  message: string,
  keyPart: string,
): boolean {
  return withLearningStoreLock(projectRoot, 'playbook-done-candidate-ingest-health', () => {
    const observedAt = new Date().toISOString();
    const result = appendPlaybookPromotionHealthEvent(projectRoot, {
      schemaVersion: 'proofbound.playbook-promotion-health.v1',
      eventId: `PBH-${randomUUID()}`,
      idempotencyKey: `post-done-candidate-ingest:${storyId}:${status}:${candidateHealthKeyPart(keyPart)}`,
      observedAt,
      kind: 'done-settlement',
      settlementStatus: status,
      storyId,
      message,
      authority: 'non_authoritative',
      gateEvidence: false,
    });
    return result.alreadyApplied;
  }, { timeoutMs: 2000 });
}

function runPostDoneCandidateIngest(projectRoot: string, storyId: string): Pick<
  PostDoneLearningSettlementResult,
  | 'candidateIngestStatus'
  | 'candidateIngestAlreadyApplied'
  | 'candidateIngestMessage'
  | 'candidateIngestCandidateCreatedCount'
  | 'candidateIngestObserveDigest'
  | 'candidateIngestProposalManifestDigest'
  | 'candidateIngestManifestDigest'
> {
  const flag = settlementEnvFlag('PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED');
  if (!flag.enabled) {
    return {
      candidateIngestStatus: 'disabled',
      candidateIngestAlreadyApplied: false,
      candidateIngestMessage: 'PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED explicitly disables DONE candidate ingestion',
      candidateIngestCandidateCreatedCount: 0,
    };
  }

  try {
    const store = new StoryStore(projectRoot);
    const report = withLearningStoreLock(projectRoot, 'playbook-candidate-ingest', () =>
      withReentrantMainWriteLock(resolveLearningOwnerRoot(projectRoot), () => buildPlaybookCandidateIngestReport({
        projectRoot,
        store,
        source: 'done-experience',
        storyId,
        limit: 5,
        apply: true,
      }), {
        label: 'playbook_candidate_ingest',
        onContention: 'wait',
      }), { timeoutMs: 2000 });
    const status = report.candidateCreatedCount > 0 ? 'applied' : 'no_candidates';
    const message =
      `DONE candidate ingest ${status}; proposedCount=${report.proposedCount}; ` +
      `candidateCreatedCount=${report.candidateCreatedCount}; observeDigest=${report.observeDigest}; ` +
      `proposalManifestDigest=${report.proposalManifestDigest}; manifestDigest=${report.manifestDigest}; ` +
      'authority=non_authoritative; gateEvidence=false';
    let alreadyApplied = false;
    try {
      alreadyApplied = appendDoneCandidateIngestHealth(projectRoot, storyId, 'recorded', message, report.manifestDigest);
    } catch (healthErr: any) {
      return {
        candidateIngestStatus: status,
        candidateIngestAlreadyApplied: false,
        candidateIngestMessage: `${message}; health diagnostic write failed non-blocking: ${healthErr?.message || healthErr}`,
        candidateIngestCandidateCreatedCount: report.candidateCreatedCount,
        candidateIngestObserveDigest: report.observeDigest,
        candidateIngestProposalManifestDigest: report.proposalManifestDigest,
        candidateIngestManifestDigest: report.manifestDigest,
      };
    }
    return {
      candidateIngestStatus: status,
      candidateIngestAlreadyApplied: alreadyApplied,
      candidateIngestMessage: message,
      candidateIngestCandidateCreatedCount: report.candidateCreatedCount,
      candidateIngestObserveDigest: report.observeDigest,
      candidateIngestProposalManifestDigest: report.proposalManifestDigest,
      candidateIngestManifestDigest: report.manifestDigest,
    };
  } catch (e: any) {
    const message = `DONE candidate ingest failed non-blocking: ${e?.message || e}; authority=non_authoritative; gateEvidence=false`;
    let alreadyApplied = false;
    try {
      alreadyApplied = appendDoneCandidateIngestHealth(projectRoot, storyId, 'failed', message, String(e?.message || e));
    } catch {
      // Health diagnostics are also best-effort and must not block DONE.
    }
    return {
      candidateIngestStatus: 'failed',
      candidateIngestAlreadyApplied: alreadyApplied,
      candidateIngestMessage: message,
      candidateIngestCandidateCreatedCount: 0,
    };
  }
}

/**
 * Best-effort learning settlement after durable DONE effects. This is explicitly
 * learning-only: no story phase/checklist/review/validation/DONE evidence paths
 * are read or written, and the caller runs it after releasing the lifecycle main
 * write lock. DONE success never depends on this helper.
 */
export function runPostDoneLearningSettlement(projectRoot: string, storyId: string): PostDoneLearningSettlementResult {
  const flag = settlementEnvFlag('PLAYBOOK_DONE_SETTLEMENT_ENABLED');
  if (!flag.enabled) {
    return {
      settlementStatus: 'disabled',
      alreadyApplied: false,
      message: 'PLAYBOOK_DONE_SETTLEMENT_ENABLED explicitly disables learning settlement; no learning settlement row written',
      candidateIngestStatus: 'disabled',
      candidateIngestAlreadyApplied: false,
      candidateIngestMessage: 'DONE candidate ingestion skipped because PLAYBOOK_DONE_SETTLEMENT_ENABLED disabled post-DONE learning settlement',
      candidateIngestCandidateCreatedCount: 0,
    };
  }

  try {
    const settlement = withLearningStoreLock(projectRoot, 'playbook-done-settlement', () => {
      const observedAt = new Date().toISOString();
      const result = appendPlaybookPromotionHealthEvent(projectRoot, {
        schemaVersion: 'proofbound.playbook-promotion-health.v1',
        eventId: `PBH-${randomUUID()}`,
        idempotencyKey: `post-done-learning-settlement:${storyId}`,
        observedAt,
        kind: 'done-settlement',
        settlementStatus: 'recorded',
        storyId,
        message: 'DONE proof/effects completed; settlement recorded no helped outcome from DONE success alone',
        authority: 'non_authoritative',
        gateEvidence: false,
      });
      return {
        settlementStatus: 'recorded' as const,
        alreadyApplied: result.alreadyApplied,
        message: result.alreadyApplied
          ? 'learning settlement already recorded for this story'
          : 'learning settlement health row recorded; no candidate helped outcome inferred',
      };
    }, { timeoutMs: 2000 });
    const candidateIngest = runPostDoneCandidateIngest(projectRoot, storyId);
    return { ...settlement, ...candidateIngest };
  } catch (e: any) {
    return {
      settlementStatus: 'failed',
      alreadyApplied: false,
      message: `learning settlement failed non-blocking: ${e?.message || e}`,
      candidateIngestStatus: 'disabled',
      candidateIngestAlreadyApplied: false,
      candidateIngestMessage: 'DONE candidate ingestion skipped because learning settlement health row failed',
      candidateIngestCandidateCreatedCount: 0,
    };
  }
}

type DoneWorktreeContext = {
  invocationCwd: string;
  worktreeRoot: string;
  mainRepoRoot: string;
  branch: string;
};

/**
 * Resolve the main repo root the DONE main write lock contends on. DONE may be
 * invoked from inside a story worktree (or a nested subdir of it); the lock
 * must always live at the *main* repo root so the worktree and the main
 * checkout serialize on one directory.
 */
function resolveDoneLockMainRepoRoot(projectRoot: string, invocationCwd = process.cwd()): string {
  const doneWorktree = detectDoneStoryWorktreeContext(invocationCwd);
  return doneWorktree?.mainRepoRoot ?? projectRoot;
}

/**
 * Canonical DONE main write lock directory.
 *
 * B-f60c CHK-001: this now resolves to the unified main write lock path
 * (`.lattice/locks/main-write.lock/`). The former DONE-specific runtime lock
 * path is retired with no alias.
 */
export function doneMainMergeLockPath(projectRoot: string, invocationCwd = process.cwd()): string {
  return mainWriteLockPath(resolveDoneLockMainRepoRoot(projectRoot, invocationCwd));
}

/**
 * Acquire the unified main write lock for the DONE merge / worktree cleanup
 * critical section. Behavior-preserving wrapper over
 * `acquireMainWriteLockRegistered`: the operator-facing held message keeps the
 * legacy "DONE main merge lock is held" wording so external CLI output is
 * byte-identical.
 *
 * B-f60c CHK-003: uses the *registered* acquire so the in-process reentrancy
 * registry knows the DONE flow holds the lock. The DONE pipeline runs
 * `audit` in-process (`applyDoneMergeEffects` → `maybeTriggerAudit` →
 * full-auto `runAuditInProcess`); now that `audit` also takes the main write
 * lock, that nested call would self-deadlock on the on-disk mkdir lock. With
 * the registry, the nested `audit`'s `withReentrantMainWriteLock` sees the
 * DONE-held path and becomes a pass-through.
 */
export function acquireDoneMainMergeLock(
  storyId: string,
  projectRoot: string,
  invocationCwd = process.cwd(),
): AcquiredMkdirLock {
  const mainRepoRoot = resolveDoneLockMainRepoRoot(projectRoot, invocationCwd);
  return acquireMainWriteLockRegistered(mainRepoRoot, {
    label: 'DONE main merge',
    heldMessage:
      `DONE main merge lock is held by another Proofbound operation; story ${storyId} phase was not changed. ` +
      `Retry after the active DONE merge finishes.`,
  });
}

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/\\/g, '/') === resolve(b).replace(/\\/g, '/');
}

export function detectDoneStoryWorktreeContext(invocationCwd = process.cwd()): DoneWorktreeContext | null {
  try {
    const resolvedInvocationCwd = resolve(invocationCwd);
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const commonDirRaw = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mainRepoRoot = dirname(commonDirRaw);
    if (samePath(worktreeRoot, mainRepoRoot)) return null;

    return {
      invocationCwd: resolvedInvocationCwd,
      worktreeRoot: resolve(worktreeRoot),
      mainRepoRoot: resolve(mainRepoRoot),
      branch,
    };
  } catch {
    // PROBE: not in a git worktree or git metadata is unavailable.
    return null;
  }
}

export function assertDoneStoryBranchMatches(storyId: string, branch: string): void {
  const expectedBranch = `story/${storyId}`;
  if (branch !== expectedBranch) {
    throw new Error(
      `refusing DONE cleanup: detected branch ${branch} but expected ${expectedBranch}; ` +
      `merge/delete aborted before mutating story state.`,
    );
  }
}

function assertSafeResidualWorktreeRm(ctx: DoneWorktreeContext, target: string, wasRegisteredWorktree: boolean): void {
  if (!samePath(target, ctx.worktreeRoot)) {
    throw new Error(`refusing residual cleanup outside canonical worktree root: ${target}`);
  }
  if (!wasRegisteredWorktree) {
    throw new Error(`refusing residual cleanup for unregistered worktree path: ${target}`);
  }
  if (!samePath(ctx.invocationCwd, ctx.worktreeRoot) && samePath(target, ctx.invocationCwd)) {
    throw new Error(`refusing residual cleanup of nested invocation cwd: ${target}`);
  }
}

/**
 * B-e74e CHK-001: Assert that the main repo's working tree is on branch "main"
 * and is clean before we can execute a DONE merge into it.
 *
 * Runs BEFORE phase=DONE is persisted so any failure leaves the story at TEST.
 * Explicitly names the main worktree path in error messages so recovery
 * instructions point at the right directory.
 */
export function assertMainWorktreeReadyForMerge(storyId: string, mainRepoRoot: string): string {
  const mainMergeRoot = resolveMainBranchWorktree(mainRepoRoot);
  let mainBranch: string;
  try {
    mainBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: mainMergeRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    throw new Error(
      `Cannot enter DONE: cannot read git HEAD at main worktree "${mainMergeRoot}".\n` +
      `${e?.message ?? e}\n` +
      `Story ${storyId} phase was not changed.`,
    );
  }

  if (mainBranch !== 'main') {
    throw new Error(
      `Cannot enter DONE: resolved main merge worktree at "${mainMergeRoot}" is on branch "${mainBranch}", not "main".\n` +
      `Repository root: "${mainRepoRoot}".\n` +
      `The DONE merge runs from the main worktree — it must be checked out on branch main.\n` +
      `→ cd "${mainMergeRoot}" && git checkout main\n` +
      `Story ${storyId} phase was not changed.`,
    );
  }

  // B-72df: Check for staged or modified tracked files, but block ONLY when a
  // dirty tracked path OVERLAPS the set of paths this DONE merge will actually
  // touch. The over-broad B-e74e check threw on ANY dirty tracked file, which
  // wrongly blocked DONE when the shared main worktree had unrelated
  // uncommitted work (parallel-session edits the merge never touches). The
  // merge applies story/<storyId> into main, so the affected set is
  // `git diff main...story/<storyId>` (both rename endpoints included). A dirty
  // tracked path outside that set cannot be clobbered by the merge and must not
  // block it; a dirty path inside it still blocks (clobber protection).
  //
  // Untracked files in the main worktree are still not checked here
  // (--untracked-files=no) — they only block the merge if the story branch
  // would overwrite them, which the merge-tree dry-run already catches. Runtime
  // artifacts (e.g. .lattice/locks/ created by the merge lock) must not block the
  // preflight.
  //
  // NOTE: do NOT trim the leading whitespace of the porcelain output. The
  // porcelain v1 XY status field is exactly two characters and either may be a
  // space (e.g. " M path" for an unstaged modification); a global trim would
  // strip the first line's leading status space and corrupt path parsing.
  let status: string;
  try {
    // `-c core.quotePath=false` forces porcelain to emit RAW UTF-8 paths. With
    // git's default core.quotePath=true, non-ASCII paths are octal-escaped and
    // double-quoted (e.g. `"src/caf\303\251.ts"`), which does NOT match the raw
    // UTF-8 paths returned by `git diff ... -z` in listDoneMergeAffectedPaths().
    // A mismatch there would let a dirty non-ASCII-named file that IS in the
    // merge's affected set silently slip past the overlap check (clobber).
    // Disabling quotePath makes both encodings identical so they intersect.
    status = execFileSync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=no'], {
      cwd: mainMergeRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    throw new Error(
      `Cannot enter DONE: cannot inspect git status at main worktree "${mainMergeRoot}".\n` +
      `${e?.message ?? e}\n` +
      `Story ${storyId} phase was not changed.`,
    );
  }

  const dirtyPaths = parsePorcelainDirtyPaths(status);
  if (dirtyPaths.length > 0) {
    const affectedPaths = listDoneMergeAffectedPaths(mainMergeRoot, storyId);
    // If the affected set could not be computed (e.g. the story branch ref is
    // missing), fall back to the conservative B-e74e behavior and treat every
    // dirty tracked path as blocking — never silently allow a merge whose
    // clobber surface is unknown.
    const overlapping = affectedPaths === null
      ? dirtyPaths
      : dirtyPaths.filter(path => affectedPaths.has(path));

    if (overlapping.length > 0) {
      throw new Error(
        `Cannot enter DONE: main worktree at "${mainMergeRoot}" has uncommitted changes to tracked files ` +
        `that overlap the DONE merge of story/${storyId}.\n` +
        `${overlapping.join('\n')}\n\n` +
        `→ Commit or stash these changes in the main worktree before retrying DONE:\n` +
        `→ cd "${mainMergeRoot}" && git status\n` +
        `Story ${storyId} phase was not changed.`,
      );
    }
  }

  return mainMergeRoot;
}

/**
 * B-72df: parse `git status --porcelain --untracked-files=no` output into the
 * set of dirty tracked paths. Handles renamed-in-worktree entries
 * (`XY old -> new`) by returning BOTH endpoints so neither side can silently
 * collide with the merge's affected set.
 */
function parsePorcelainDirtyPaths(status: string): string[] {
  const paths = new Set<string>();
  for (const rawLine of status.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    // Porcelain v1: 2 status chars + a space, then the path(s).
    const body = line.slice(3);
    const arrowIdx = body.indexOf(' -> ');
    if (arrowIdx >= 0) {
      paths.add(normalizeGitPath(unquoteGitPath(body.slice(0, arrowIdx))));
      paths.add(normalizeGitPath(unquoteGitPath(body.slice(arrowIdx + 4))));
    } else {
      paths.add(normalizeGitPath(unquoteGitPath(body)));
    }
  }
  return [...paths].filter(Boolean);
}

/**
 * B-72df: compute the set of repo-relative paths the DONE merge of
 * story/<storyId> into main will touch, via
 * `git diff main...story/<storyId> --name-status -M`. The triple-dot form
 * diffs from the merge-base, matching exactly what `git merge story/<storyId>`
 * applies. For renames (`R<score>\told\tnew`) BOTH endpoints are included so a
 * dirty rename source OR target is caught. Returns null when the affected set
 * cannot be computed (e.g. missing story branch ref) so the caller can fall
 * back to the conservative block-all behavior.
 */
function listDoneMergeAffectedPaths(mainMergeRoot: string, storyId: string): Set<string> | null {
  const storyBranch = `story/${storyId}`;
  let raw: string;
  try {
    raw = execFileSync(
      'git',
      ['diff', `main...${storyBranch}`, '--name-status', '-M', '-z'],
      {
        cwd: mainMergeRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch {
    return null;
  }

  // `-z` output is NUL-separated. A rename/copy record is three fields:
  //   status\0oldPath\0newPath\0 ; every other record is two: status\0path\0.
  const fields = raw.split('\0').filter(field => field.length > 0);
  const affected = new Set<string>();
  let i = 0;
  while (i < fields.length) {
    const code = fields[i];
    const statusLetter = code.charAt(0);
    if ((statusLetter === 'R' || statusLetter === 'C') && i + 2 < fields.length) {
      affected.add(normalizeGitPath(fields[i + 1]));
      affected.add(normalizeGitPath(fields[i + 2]));
      i += 3;
    } else if (i + 1 < fields.length) {
      affected.add(normalizeGitPath(fields[i + 1]));
      i += 2;
    } else {
      // Malformed trailing record — stop defensively.
      break;
    }
  }
  return affected;
}

/**
 * B-72df: un-quote a git path that git emits with surrounding double quotes
 * when it contains "unusual" characters (default core.quotePath=true). The
 * `-z`/NUL diff output is never quoted, but porcelain status lines can be, so
 * dirty-path parsing normalizes them before intersecting with the affected set.
 */
function unquoteGitPath(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
}

function assertDoneMergeCanApplyBeforeStateMutation(storyId: string, worktreePath: string, mainRepoRoot: string): void {
  try {
    execFileSync('git', ['merge-tree', '--write-tree', 'main', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    const detail = e?.stderr?.toString?.() || e?.stdout?.toString?.() || e?.message || String(e);
    throw new Error(
      `Cannot enter DONE: story/${storyId} 尚不能干净合并到 main；未修改 story phase。\n` +
      `${detail}\n\n` +
      `→ 在 story worktree 内先同步 main，再重跑 story_advance --phase=DONE。\n` +
      `→ 可执行: cd "${worktreePath}" && git merge main\n` +
      `→ 主仓库 (main worktree): ${mainRepoRoot}`,
    );
  }
}

/**
 * Block A — DONE pre-merge gate.
 *
 * Runs BEFORE phase=DONE is persisted (transition-orchestrator.ts calls this
 * just before actor.send). Runs the done-oracle gate, the F-020 stray-file
 * dry-run, and the merge-tree dry-run. Any pre-merge gate failure throws while
 * the story is still TEST — phase=DONE is never written on failure.
 *
 * Returns the rendered DONE checklist string so the caller can hold it in a
 * local variable and pass it to applyDoneMergeEffects (replaces the old
 * cross-actor.send global stash).
 *
 * B-6974: this gate NO LONGER stops the actor on failure — actor lifecycle is
 * owned solely by transition-orchestrator.ts, which stops it in a single
 * finally on every exit path. The `actor` parameter is kept for signature
 * stability and is forwarded to runDoneOracleGate (which also no longer stops
 * it).
 */
export async function runDonePreMergeGate(
  storyId: string,
  store: StoryStore,
  root: string,
  actor: ReturnType<typeof import('../core/machine.js').createStoryActor>,
  // B-6666 CHK-001: the resolved git cwd (wrapper-root aware), resolved ONCE at
  // the transition-orchestrator DONE boundary and threaded down. `root`
  // (metadataRoot) is still used for store/metadata reads; only the DONE-oracle
  // git probes use gitCwd. Defaults to root so callers that have not resolved a
  // gitCwd stay byte-identical (plain repos: projectRoot==gitCwd).
  gitCwd: string = root,
): Promise<string> {
  // B-c622 CL-006: autoSyncMain moved before actor.can() to fix TOCTOU.

  const rendered = runDoneOracleGate(storyId, store, root, actor, gitCwd);

  // F-020 (B-9d95 Round 1 review): stray-file 检测提前到 phase=DONE 落盘
  // 之前。原实现（Step 2.5，line 632 附近）在 story.phase=DONE +
  // story.worktree=undefined 已 writeStory 之后才跑，若 throw（非白名单
  // 未追踪文件）story 会卡 DONE（merge 未发生、worktree 还活着、没有
  // lattice 自愈路径）。这里预检查：dry-run detection，发现 offender 立刻
  // throw，保留 phase=TEST 状态让 main agent 按错误提示修复后重跑。
  //
  // whitelist 文件在此**不删除**——只负责早期拦截。真正的 rm 延后到
  // Step 2.5 (actor.send 之后的 merge 流程) 做，因为此时才知道合并一定
  // 会发生。预检查只看"有没有 offender"：
  //   - 有 offender → throw（保留文件，不落盘 DONE）
  //   - 无 offender → 继续走完整流程，whitelist rm 在 Step 2.5 执行
  try {
    const doneWorktree = detectDoneStoryWorktreeContext();
    if (doneWorktree) {
      assertDoneStoryBranchMatches(storyId, doneWorktree.branch);
      // B-e74e CHK-001: verify main worktree is on branch "main" and clean
      // BEFORE writing phase=DONE. Fails fast with the actual main worktree
      // path so recovery instructions point at the right directory.
      const mainMergeRoot = assertMainWorktreeReadyForMerge(storyId, doneWorktree.mainRepoRoot);
      // 仅 dry-run：用 git ls-files 读出未追踪文件，按白名单分类。
      // 发现 offender → throw（此时 story.phase 仍为 TEST）。无 offender
      // → 返回，不做任何删除，后续 Step 2.5 才会真的 rm whitelist 文件。
      const { worktreeRoot } = doneWorktree;
      const storyDir = `${store.storyDirRel()}/${storyId}/`;
      if (existsSync(join(mainMergeRoot, storyDir))) {
        let raw = '';
        try {
          raw = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', storyDir], {
            cwd: mainMergeRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).toString();
        } catch { /* PROBE: 忽略，让 Step 2.5 兜底 */ }
        const relPaths = raw.split('\n').map(l => l.trim()).filter(Boolean);
        const { STRAY_FILE_WHITELIST: WL } = await import('./stray-file-cleanup.js');
        const offenders = relPaths.filter(rel => !WL.includes(rel.split('/').pop() || rel));
        if (offenders.length > 0) {
          // 复用 cleanStrayWorktreeFiles 的 throw 消息（单一真相源），
          // 传入 worktreePath 让消息含 git worktree remove / branch -d 指引。
          // B-6974: the actor-stop call this path used to make was removed —
          // actor lifecycle is owned solely by transition-orchestrator.ts,
          // which stops it in a single finally on every exit path (including
          // this thrown-error path).
          cleanStrayWorktreeFiles(mainMergeRoot, storyId, worktreeRoot);
          // cleanStrayWorktreeFiles 在有 offender 时必然 throw；能到这行
          // 说明逻辑偏离，fallback：主动抛错避免 phase 默认落盘。
          throw new Error(
            `Story ${storyId} DONE pre-merge stray 检测：检测到非白名单未追踪文件但 cleanStrayWorktreeFiles 未抛错（内部状态偏离），阻止推进。`,
          );
        }
      }
      assertDoneMergeCanApplyBeforeStateMutation(storyId, worktreeRoot, mainMergeRoot);
    }
  } catch (e: any) {
    // throw 的错误信息（含 stash / worktree remove 指引）直接冒给 caller，
    // 不吞。只有 git 探测本身的非 throw 失败被上面的 catch 吃掉。
    if (
      e?.message?.startsWith(`Story ${storyId} DONE `)
      || e?.message?.startsWith('Cannot enter DONE:')
      || e?.message?.startsWith('refusing DONE cleanup:')
    ) {
      throw e;
    }
    // 其他意外（如 import 失败 / unknown）转成可见错误
    throw new Error(`DONE pre-merge 预检查失败: ${e?.message ?? e}`);
  }

  return rendered;
}

/**
 * Block B — DONE merge / worktree cleanup effects.
 *
 * Runs AFTER writeStory(phase=DONE) (transition-orchestrator.ts calls this in
 * the DONE return segment). Performs the real git merge / worktree cleanup in
 * the exact step order of the inline original:
 *   Step1 clear story.worktree + writeStory
 *   Step2 commit story metadata
 *   Step2.5 cleanStrayWorktreeFiles (whitelist rm)
 *   Step3 git merge story branch into main
 *   Step4 worktree remove (+ rm -rf residue + prune)
 *   Step5 git branch -d
 *   cleanupFailure throw
 *   maybeTriggerAudit (non-blocking)
 *
 * `renderedChecklist` is the string returned by runDonePreMergeGate, held by
 * the caller across the actor.send boundary; it is prefixed onto the success
 * message via the returned `doneChecklistPrefix`.
 *
 * Returns the report pieces for the caller to splice into the advance success
 * message: `doneChecklistPrefix` (rendered checklist + blank lines) and
 * `doneMergeReport` (the merge log + optional audit hint).
 */
export async function applyDoneMergeEffects(
  storyId: string,
  store: StoryStore,
  story: StoryInfo,
  renderedChecklist: string | undefined,
): Promise<{ doneChecklistPrefix: string; doneMergeReport: string; mainMergeRoot?: string }> {
  let doneChecklistPrefix = '';
  let doneMergeReport = '';
  let resolvedMainMergeRoot: string | undefined;
  if (renderedChecklist) {
    doneChecklistPrefix = `${renderedChecklist}\n\n`;
  }

  // B-7eed: DONE 成功后自动 git merge 回 main + 清 worktree + 删 branch。
  // CLAUDE.md 承诺"内部自动合并"但旧代码没实现，每次 DONE 都要手动 cleanup。
  // 复用 dev_merge 的逻辑（worktree.ts:208）但走 story_advance 命令路径（经 transition-orchestrator 协调）触发。
  //
  // 关键的执行顺序（不能乱）：
  //   1. 清 story.worktree 字段 + writeStory（在 worktree fs 内）
  //   2. git add + git commit 把这一步以及之前的 phase=DONE 改动都落到 story 分支
  //   3. cd 到主仓库根目录，git merge story 分支（worktree 内不能 merge 自己）
  //   4. worktree remove
  //   5. branch -d
  // 注意：不能依赖 story.worktree 字段——INIT_CHECK 把这个字段写到了 main
  // 仓库的 index.json，但 worktree 内 checkout 的版本是 INIT_CHECK 之前的，
  // 没有这个字段。所以 readStory(from worktree) 永远拿到 worktree=undefined。
  // 改为从 git 实际状态推断：调用 cwd、git 顶层 worktree、当前分支、git common dir。
  // DONE 可从 worktree 子目录触发，所以 cleanup 目标必须是 git top-level，
  // 不能把 process.cwd() 当作可删除路径。
  const doneWorktree = detectDoneStoryWorktreeContext();

  if (doneWorktree) {
    const mergeLines: string[] = [];
    const { branch, mainRepoRoot, worktreeRoot: wtPathAbs } = doneWorktree;
    assertDoneStoryBranchMatches(storyId, branch);
    const mainMergeRoot = assertMainWorktreeReadyForMerge(storyId, mainRepoRoot);
    resolvedMainMergeRoot = mainMergeRoot;
    {
      const runGitArgs = (gitArgs: string[], cwd: string): string =>
        execFileSync('git', gitArgs, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

      // Step 1: 清 story.worktree 字段 + endedAt + writeStory，让 metadata 落盘
      story.worktree = undefined;
      story.endedAt = story.endedAt || new Date().toISOString();
      store.writeStory(storyId, story);

      // Step 2: commit 所有 story metadata（phase=DONE + worktree=undefined +
      // endedAt + reviewer/test 产物）。dev_merge:228 用的是同一招。
      try {
        runGitArgs(['add', store.storyDirRel()], wtPathAbs);
        const staged = runGitArgs(['diff', '--cached', '--name-only'], wtPathAbs);
        if (staged) {
          runGitArgs(
            ['-c', 'commit.gpgsign=false', 'commit', '-m', `lattice: mark ${storyId} DONE + clear worktree`],
            wtPathAbs,
          );
        }
      } catch { /* PROBE: 没东西 commit 也无所谓 */ }

      // Step 2.5 (B-9d95 CHK-003): merge 前清 stray whitelist 文件。
      // F-020: 非白名单 offender 检测已提前到 DONE gate（phase 落盘前），
      // 这里只负责 whitelist 自动 rm；理论上 offender 不可能到这行（上面
      // 已 throw），但保留 throw 路径作为 defense-in-depth。第三参数
      // wtPathAbs 用于 error message 的 worktree 清理指引（F-014）。
      const strayReport = cleanStrayWorktreeFiles(mainMergeRoot, storyId, wtPathAbs);
      for (const line of strayReport) mergeLines.push(line);

      // Step 3: 从主仓库根目录 merge story 分支。merge 冲突直接 throw 给上层
      // 让 agent 看到详细的手动 cleanup 步骤——phase 已经是 DONE，不回滚，但
      // 必须让 user 知道还有手动收尾要做。
      const mainBranch = runGitArgs(['rev-parse', '--abbrev-ref', 'HEAD'], mainMergeRoot);
      const mainShaBeforeDoneMerge = runGitArgs(['rev-parse', 'HEAD'], mainMergeRoot);
      let mainShaAfterDoneMerge = mainShaBeforeDoneMerge;
      try {
        runGitArgs(
          ['-c', 'commit.gpgsign=false', 'merge', branch, '--no-ff', '-m', `merge: ${storyId} ${story.title}`],
          mainMergeRoot,
        );
        mainShaAfterDoneMerge = runGitArgs(['rev-parse', 'HEAD'], mainMergeRoot);
        mergeLines.push(`✓ 分支 ${branch} 已合并到 ${mainBranch}`);
      } catch (e: any) {
        throw new Error(
          `Story ${storyId} 已标记为 DONE 但自动合并失败:\n` +
          `${e.stderr?.toString() || e.message}\n\n` +
          `请手动完成:\n` +
          `  cd "${mainMergeRoot}"\n` +
          `  git merge ${branch}\n` +
          `  git worktree remove --force "${wtPathAbs}"\n` +
          `  git branch -d ${branch}`,
        );
      }

      // Step 4: 清理 worktree
      let cleanupFailure: string | null = null;
      //
      // Two-step cleanup: `git worktree remove` deregisters the worktree
      // from git's internal list (so `git worktree list` no longer shows
      // it), then we `rm -rf` the directory to catch leftover files
      // that git didn't clean. Why the second step is needed:
      //
      // - activity.jsonl (Claude Code hook), tmp/llmlog.json and other
      //   gitignored runtime files are invisible to `git status` so git
      //   considers the worktree "dirty but all gitignored"
      // - with --force, git removes the worktree entry but leaves the
      //   directory (Windows + hook holding a file handle) or empty
      //   skeleton dirs behind
      // - result: `git worktree list` is clean but `.worktrees/B-xxx/`
      //   still exists with stray files
      //
      // The rm -rf is safe here because DONE gate already checked that
      // the working tree is clean AND the branch is merged into main —
      // anything left in the worktree is either gitignored runtime
      // state or genuine leakage we want to erase.
      if (existsSync(wtPathAbs) || isRegisteredWorktree(mainRepoRoot, wtPathAbs)) {
        const wasRegisteredWorktree = isRegisteredWorktree(mainRepoRoot, wtPathAbs);
        const repair = repairGlobalLatticeLinkBeforeWorktreeDelete(wtPathAbs, mainRepoRoot);
        if (repair.action === 'relinked') mergeLines.push(repair.message);
        let removeFailure: string | null = null;
        try {
          runGitArgs(['worktree', 'remove', wtPathAbs], mainRepoRoot);
          mergeLines.push(`✓ Worktree ${wtPathAbs} 已清理`);
        } catch {
          // worktree 内有 tmp/ llmlog 等运行时产物时 remove 会拒绝，用 --force
          try {
            runGitArgs(['worktree', 'remove', '--force', wtPathAbs], mainRepoRoot);
            mergeLines.push(`✓ Worktree ${wtPathAbs} 已强制清理`);
          } catch (e: any) {
            removeFailure = `git worktree remove failed: ${e.message}`;
            mergeLines.push(`⚠ Worktree 未清理: ${e.message}`);
          }
        }
        // Second step: rm -rf the directory if git left it behind.
        // This is the fix for "worktree folder still exists after
        // DONE merge" caused by activity.jsonl-style gitignored
        // leftovers from Claude Code hooks.
        if (existsSync(wtPathAbs)) {
          try {
            assertSafeResidualWorktreeRm(doneWorktree, wtPathAbs, wasRegisteredWorktree);
            rmSync(wtPathAbs, { recursive: true, force: true });
            mergeLines.push(`✓ Worktree 目录残留已清空`);
          } catch (e: any) {
            cleanupFailure = `worktree directory cleanup failed: ${e.message}`;
            mergeLines.push(`⚠ Worktree 目录残留清理失败: ${e.message}`);
          }
        }
        try {
          pruneWorktreeRegistry(mainRepoRoot);
          if (removeFailure && !existsSync(wtPathAbs) && !isRegisteredWorktree(mainRepoRoot, wtPathAbs)) {
            mergeLines.push(`✓ stale worktree registry 已 prune`);
          }
        } catch (e: any) {
          mergeLines.push(`⚠ git worktree prune 失败: ${e.message}`);
        }
        if (existsSync(wtPathAbs) && !cleanupFailure) {
          cleanupFailure = `worktree path still exists after cleanup: ${wtPathAbs}`;
        }
        if (isRegisteredWorktree(mainRepoRoot, wtPathAbs) && !cleanupFailure) {
          cleanupFailure = removeFailure || `worktree is still registered after cleanup: ${wtPathAbs}`;
          mergeLines.push(`⚠ Worktree 仍在 git registry 中: ${wtPathAbs}`);
        }
      }

      // Step 5: 删除分支
      try {
        runGitArgs(['branch', '-d', branch], mainMergeRoot);
        mergeLines.push(`✓ 分支 ${branch} 已删除`);
      } catch {
        mergeLines.push(`⚠ 分支 ${branch} 未删除（可能有未合并的提交）`);
      }

      if (cleanupFailure) {
        const err = new Error(cleanupFailure);
        reportHealthIssue('mutation:worktreeCleanup', err, {
          storyId,
          branch,
          worktreePath: wtPathAbs,
          mainRepoRoot,
        });
        throw new Error(
          `Story ${storyId} 已合并，但 worktree 清理未完成: ${cleanupFailure}\n` +
          `→ 请运行 lattice doctor 查看，或执行 lattice doctor --repair 清理终态 worktree 残留。`,
        );
      }

      try {
        const mainStore = new StoryStore(mainMergeRoot);
        const auxiliaryResults = cleanupAuxiliaryWorktreeResidues(mainMergeRoot, mainStore, { storyIds: [storyId] });
        for (const result of auxiliaryResults) {
          const label = renderAuxiliaryClassification(mainMergeRoot, result.before);
          if (result.cleaned) {
            mergeLines.push(`✓ Auxiliary worktree cleaned: ${label}`);
          } else {
            mergeLines.push(`⚠ Auxiliary worktree left for review: ${label}`);
          }
        }
      } catch (e: any) {
        reportHealthIssue('mutation:auxiliaryWorktreeCleanup', e, {
          storyId,
          mainMergeRoot,
        });
        mergeLines.push(`⚠ Auxiliary worktree cleanup skipped: ${e?.message || e}`);
      }

      // B-aa8a: auto patch-bump the 3 version sync points (root package.json +
      // packages/main/package.json + lattice-brand.ts LATTICE_CLI_VERSION) when the DONE
      // merge changed material code — gated on the SAME predicate as the dist rebuild so
      // metadata-only merges never churn the version. Commits the bump on main under this
      // merge-lock, BEFORE the rebuild below, so the rebuilt dist reports the new version
      // with no extra build. changedPaths is computed once and reused by the build.
      const doneMergeChangedPaths = listChangedPathsBetweenMainShas(
        mainMergeRoot,
        mainShaBeforeDoneMerge,
        mainShaAfterDoneMerge,
      );
      const runtimeSemverChanged = shouldBuildDoneMainPackageForChangedPaths(doneMergeChangedPaths);
      mergeLines.push(bumpVersionOnDoneMerge({
        mainMergeRoot,
        shouldBump: runtimeSemverChanged,
        runGit: runGitArgs,
      }));

      mergeLines.push(runDoneMainPackageBuildAfterMerge(
        mainMergeRoot,
        mainShaBeforeDoneMerge,
        mainShaAfterDoneMerge,
        { changedPaths: doneMergeChangedPaths },
      ));

      if (selectArtifactReleasePathsV1(doneMergeChangedPaths, { isRuntimeBuildInput: isDoneMainRuntimeBuildInput }).length > 0) {
        const artifactReleaseResult = recordArtifactReleaseForDoneMerge({
          root: mainMergeRoot,
          storyId,
          mainCommit: mainShaAfterDoneMerge,
          changedPaths: doneMergeChangedPaths,
          runtimeSemverChanged,
          isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
        });
        commitArtifactReleaseLedgerIfNeeded(mainMergeRoot, storyId, artifactReleaseResult, runGitArgs);
        const line = renderArtifactReleaseDoneLine(artifactReleaseResult);
        if (line) mergeLines.push(line);
      }

      // B-1a91 CHK-001: auto-refresh the Experience Layer finding-signals cache.
      // The cache only ever updated via an explicit out-of-band `learning_scan`,
      // so accumulated per-story experience could silently go stale. Here we
      // re-derive + persist it on EVERY DONE merge (NOT gated on the changed-paths
      // build predicate — findings accrue regardless of whether code changed) so
      // the just-completed story's findings are folded in with no manual scan.
      //
      // deriveFindingSignalsFromStore persists through the learning-store, whose
      // resolveLearningRoot canonicalizes any worktree root to the MAIN checkout
      // (post-B-37b3), so the cache always lands in the single shared
      // .lattice/learning/. We derive from a MAIN-rooted StoryStore (NOT the
      // worktree `store`): by this point Step 4 has already removed the story
      // worktree directory, so the worktree store can no longer enumerate/read
      // findings — but every story's metadata (including this just-merged story's
      // resolved findings) lives on main, where the merge just landed. mainMergeRoot
      // is the canonical main checkout already used for the merge.
      //
      // ADVISORY ONLY: no gate reads this cache. The refresh is wrapped so it can
      // NEVER throw or block the DONE merge; a failure is swallowed into a status
      // line, and CHK-003's coverage watermark + learning_validate gap report make
      // any silently-skipped refresh DETECTABLE and recoverable (run learning_scan).
      try {
        const refreshStore = new StoryStore(mainMergeRoot);
        // F-003: pass a wall-clock `now` so the persisted cache's updatedAt advances
        // on every DONE-merge auto-refresh. Without it, deriveFindingSignals falls
        // back to the epoch sentinel ('1970-01-01...'), defeating the userSees
        // "updatedAt advances" guarantee. (learning_scan passes `now` the same way.)
        const signalsCache = deriveFindingSignalsFromStore(refreshStore, { projectRoot: mainMergeRoot, now: new Date().toISOString() });
        const n = Array.isArray(signalsCache.signals) ? signalsCache.signals.length : 0;
        mergeLines.push(`✓ experience cache refreshed (${n} signals)`);
      } catch (e: any) {
        mergeLines.push(`⚠ experience cache refresh skipped: ${e?.message || e}`);
      }
    }

    if (mergeLines.length > 0) {
      doneMergeReport = `\n\n${mergeLines.join('\n')}`;
    }

    // B-9bd9 CHK-003: DONE 合并成功后，尝试触发 framework audit。
    // maybeTriggerAudit 内部已 try/catch + meta-story guard + mode=off 兜底；
    // 此处再包一层防御，确保任何 audit-trigger 路径异常都不影响 DONE 成功消息。
    // projectRoot uses the worktree that currently owns branch main.
    try {
      const auditResult = await maybeTriggerAudit(storyId, mainMergeRoot);
      if (auditResult.hint) {
        // semi-auto 提示行：前后各空一行单独成段，avoid 和 mergeLines/docsHint 挤在一起
        doneMergeReport += `\n${auditResult.hint}`;
      }
    } catch (e: any) {
      console.warn(`[audit-trigger] DONE hook failed: ${e?.message || e}`);
    }
  }

  return { doneChecklistPrefix, doneMergeReport, mainMergeRoot: resolvedMainMergeRoot };
}
