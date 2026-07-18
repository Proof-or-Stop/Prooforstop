/**
 * Task B-3506: Shared auto-commit helper for Proofbound metadata writes
 *
 * Extracted from packages/main/src/handlers/story-advance.ts:autoCommitStoryMetadata
 * (B-6326 lifecycle). All lattice CLI handlers that mutate files under the
 * configured story directory should call this AFTER a successful write so the
 * worktree-dirty gate stops blocking on Proofbound's own bookkeeping.
 *
 * Safety contract (preMortem #1 anchor):
 *   - Path scope is derived from the configured storyDir plus `storyId` itself.
 *     The caller cannot broaden the scope by passing a different path argument
 *     — there is no such argument.
 *   - storyId must match /^B-[A-Za-z0-9][A-Za-z0-9-]*$/. Anything else throws
 *     synchronously before any git invocation.
 *   - The classifier (B-6326 classifyDirtyWorktree) is consulted ONLY for the
 *     tail-note about coexisting non-metadata dirt. It is NOT used to decide
 *     whether to stage paths — `git add` is always scoped to the story dir.
 *
 * Idempotency (preMortem #2 anchor):
 *   - When nothing under the story dir is dirty, the function returns ''.
 *   - Two consecutive calls produce at most one commit; the second call sees
 *     an empty staged set and returns ''.
 *
 * Vocabulary (preMortem #3 anchor):
 *   - User-visible prefix is the literal `\n✓ lattice metadata auto-committed:`,
 *     re-exported as AUTO_COMMIT_METADATA_PREFIX so callers and tests can pin it.
 *   - Coexisting non-metadata dirt is announced with the anchor word
 *     `untouched` — never `handled` / `committed` / `all clean`.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { reportHealthIssue } from './health.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsFromConfig,
  DIRTY_WORKTREE_CATEGORIES,
  type DirtyWorktreeCategory,
  type DirtyWorktreeClassification,
} from './dirty-worktree.js';
import { loadConfig } from './config.js';
import { LATTICE_STORY_DIR, normalizeRelPath } from './lattice-paths.js';
import { StoryStore } from './store.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import {
  CLOSEOUT_ARTIFACT_POLICIES,
  CLOSEOUT_WRITE_RECEIPT_SCHEMA,
  appendCloseoutWriteReceipt,
  buildCloseoutWriteReceipt,
  rawArtifactDigest,
  readCloseoutWriteReceipts,
} from './closeout-trust.js';
import {
  captureDonePrepareGeneratedMetadataTransaction,
  commitImmutableMetadataTree,
  rollbackDonePrepareGeneratedMetadataTransaction,
  type DonePrepareGeneratedMetadataTransaction,
} from './done-prepare-generated-metadata.js';

/**
 * Literal byte-equal user-visible prefix. Pinned for vocabulary consistency
 * across handlers + smoke (preMortem #3 anchor — CHK-003 / CHK-004).
 */
export const AUTO_COMMIT_METADATA_PREFIX = '\n✓ lattice metadata auto-committed:';

/** Canonical literal path prefix the helper is allowed to stage. */
export const AUTO_COMMIT_STORY_DIR_PREFIX = `${LATTICE_STORY_DIR}/`;

function appendLocalCausalReceiptsBeforeCommit(args: {
  projectRoot: string;
  gitCwd: string;
  storyId: string;
  storyRel: string;
  reason: string;
  artifactPaths: readonly string[];
}): void {
  const declaredPaths = new Set(args.artifactPaths);
  const policies = CLOSEOUT_ARTIFACT_POLICIES.filter((policy) => declaredPaths.has(policy.path));
  if (!policies.length) return;
  const store = new StoryStore(args.projectRoot);
  const phase = store.readStory(args.storyId).phase;
  const headHash = currentGitHead(args.gitCwd);
  const materialHash = currentMaterialHash(args.gitCwd, 'HEAD', args.projectRoot);
  const storyFilesHash = currentStoryFilesHash(args.gitCwd, 'HEAD', args.projectRoot);
  if (!headHash || !materialHash || !storyFilesHash) throw new Error('closeout receipt provenance hashes unavailable');
  const storyDir = join(args.gitCwd, args.storyRel);
  for (const policy of policies) {
    if (!(policy.canonicalWriters as readonly string[]).includes(args.reason)) {
      throw new Error(`non-canonical writer for ${policy.path}: ${args.reason}`);
    }
    const artifactRel = `${args.storyRel}/${policy.path}`;
    const dirty = execFileSync('git', ['status', '--porcelain', '--', artifactRel], {
      cwd: args.gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!dirty) continue;
    const artifactPath = join(storyDir, policy.path);
    if (!existsSync(artifactPath)) continue;
    const bytes = readFileSync(artifactPath);
    const previous = readCloseoutWriteReceipts(storyDir)
      .filter((receipt) => receipt.schemaVersion === CLOSEOUT_WRITE_RECEIPT_SCHEMA && receipt.artifactPath === policy.path)
      .at(-1);
    const receipt = buildCloseoutWriteReceipt({
      storyId: args.storyId,
      artifactPath: policy.path,
      writerCommand: args.reason,
      artifactDigest: rawArtifactDigest(bytes),
      phase,
      headHash,
      materialHash,
      storyFilesHash,
      sequence: (previous?.sequence ?? 0) + 1,
      previousIntegrityHash: previous?.integrityHash ?? null,
    });
    appendCloseoutWriteReceipt(storyDir, receipt);
  }
}

export interface ValidationReuseMetadataTransactionCommitResult {
  ok: boolean;
  commitSha?: string;
  reason?: string;
}

export type LifecycleMetadataTransactionKind =
  | 'test-transition'
  | 'codex-command-terminal';

export interface LifecycleMetadataTransaction {
  kind: LifecycleMetadataTransactionKind;
  headHash: string;
  storyRel: string;
  transaction: DonePrepareGeneratedMetadataTransaction;
}

function lifecycleMetadataPaths(
  storyRel: string,
  kind: LifecycleMetadataTransactionKind,
): string[] {
  const prefix = `${normalizeRelPath(storyRel)}/`;
  const filenames = kind === 'test-transition'
    ? ['index.json', 'process-events.jsonl', 'process-metrics.json']
    : ['process-events.jsonl'];
  return filenames.map((filename) => `${prefix}${filename}`).sort((a, b) => a.localeCompare(b));
}

/**
 * Freeze the exact canonical paths owned by one TEST-transition writer.
 *
 * The capture refuses any pre-existing worktree/index change on those paths.
 * This is deliberately not a "trusted dirty metadata" classifier: the caller
 * receives no authority to adopt prior bytes based on path, event type, or
 * prose. A later commit is valid only for the exact delta from this clean
 * baseline.
 */
export function captureLifecycleMetadataTransaction(args: {
  root: string;
  gitCwd: string;
  storyId: string;
  storyRel: string;
  kind: LifecycleMetadataTransactionKind;
}): LifecycleMetadataTransaction {
  assertStoryIdShape(args.storyId);
  const storyRel = normalizeRelPath(args.storyRel);
  if (!storyRel || storyRel === '.' || storyRel === '..' || storyRel.startsWith('../') || isAbsolute(storyRel)) {
    throw new Error(`lifecycle metadata transaction escaped git workspace: ${args.storyRel}`);
  }
  if (storyRel !== args.storyId && !storyRel.endsWith(`/${args.storyId}`)) {
    throw new Error(`lifecycle metadata transaction story path mismatch: ${storyRel} does not end in ${args.storyId}`);
  }
  const paths = lifecycleMetadataPaths(storyRel, args.kind);
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--', ...paths], {
    cwd: args.gitCwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (dirty) {
    throw new Error(`canonical metadata was already dirty before ${args.kind}: ${dirty}`);
  }
  const headHash = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: args.gitCwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return {
    kind: args.kind,
    headHash,
    storyRel,
    transaction: captureDonePrepareGeneratedMetadataTransaction({
      root: args.root,
      gitCwd: args.gitCwd,
      paths,
    }),
  };
}

/**
 * Atomically install only the bytes produced since a clean lifecycle capture.
 * The caller supplies hashes recorded immediately after its own write. Hook or
 * concurrent mutation, HEAD movement, path broadening, or commit failure rolls
 * the exact managed paths back and never commits adjacent metadata.
 */
export function commitLifecycleMetadataTransaction(args: {
  root: string;
  gitCwd: string;
  storyId: string;
  capture: LifecycleMetadataTransaction;
  verifiedHashes: Map<string, string>;
}): ValidationReuseMetadataTransactionCommitResult {
  const expectedPaths = lifecycleMetadataPaths(args.capture.storyRel, args.capture.kind);
  const managedPaths = [...args.capture.transaction.paths].sort((a, b) => a.localeCompare(b));
  const rollback = (reason: string): ValidationReuseMetadataTransactionCommitResult => {
    const result = rollbackDonePrepareGeneratedMetadataTransaction({
      root: args.root,
      gitCwd: args.gitCwd,
      transaction: args.capture.transaction,
    });
    return {
      ok: false,
      reason: result.ok ? reason : `${reason}; rollback failed: ${result.errors.join(' | ')}`,
    };
  };
  if (
    managedPaths.length !== expectedPaths.length
    || managedPaths.some((path, index) => normalizeRelPath(path) !== expectedPaths[index])
  ) return rollback(`lifecycle metadata transaction path set broadened for ${args.capture.kind}`);
  if (
    args.verifiedHashes.size !== expectedPaths.length
    || expectedPaths.some((path) => !args.verifiedHashes.has(path))
  ) return rollback(`lifecycle metadata transaction hash set incomplete for ${args.capture.kind}`);
  const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: args.gitCwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (currentHead !== args.capture.headHash) {
    return rollback(`HEAD changed before ${args.capture.kind} metadata commit CAS`);
  }
  const changed = expectedPaths.filter((path) => {
    const absolute = join(args.root, path);
    return !existsSync(absolute) || rawArtifactDigest(readFileSync(absolute)) !== args.verifiedHashes.get(path);
  });
  if (changed.length > 0) {
    return rollback(`${args.capture.kind} metadata changed after writer verification: ${changed.join(', ')}`);
  }
  const changedPaths = expectedPaths.filter((path) => {
    const before = args.capture.transaction.states.find((state) => state.path === path)?.worktreeContent ?? null;
    const beforeHash = before === null ? null : rawArtifactDigest(before);
    return beforeHash !== args.verifiedHashes.get(path);
  });
  if (changedPaths.length === 0) return { ok: true };
  try {
    const committed = commitImmutableMetadataTree({
      root: args.root,
      gitCwd: args.gitCwd,
      paths: changedPaths,
      verifiedHashes: new Map(changedPaths.map((path) => [path, args.verifiedHashes.get(path)!])),
      message: `lattice: record ${args.storyId} ${args.capture.kind} metadata`,
    });
    if (!committed.ok) return rollback(committed.reason || `${args.capture.kind} immutable metadata commit failed`);
    return { ok: true, commitSha: committed.commitSha };
  } catch (error: any) {
    return rollback(`${args.capture.kind} metadata transaction failed: ${String(error?.stderr || error?.stdout || error?.message || error).trim()}`);
  }
}

/**
 * Commit the already-mutated canonical validation-reuse evidence, terminal,
 * and receipt through an isolated index. The caller captures `transaction`
 * before the first mutation. Every failure restores both managed worktree bytes
 * and their real-index entries; unrelated staged entries never enter the
 * isolated index and remain untouched.
 */
export function commitValidationReuseMetadataTransaction(args: {
  projectRoot: string;
  gitCwd: string;
  storyId: string;
  storyRel: string;
  reason: string;
  transaction: DonePrepareGeneratedMetadataTransaction;
  closeoutArtifactPaths: readonly string[];
}): ValidationReuseMetadataTransactionCommitResult {
  const managedPaths = [...args.transaction.paths].sort((a, b) => a.localeCompare(b));
  const rollback = (reason: string): ValidationReuseMetadataTransactionCommitResult => {
    const result = rollbackDonePrepareGeneratedMetadataTransaction({
      root: args.gitCwd,
      gitCwd: args.gitCwd,
      transaction: args.transaction,
    });
    return {
      ok: false,
      reason: result.ok ? reason : `${reason}; rollback failed: ${result.errors.join(' | ')}`,
    };
  };
  const expectedPrefix = `${normalizeRelPath(args.storyRel)}/`;
  const expectedPaths = [
    `${expectedPrefix}closeout-write-receipts.jsonl`,
    `${expectedPrefix}process-events.jsonl`,
    `${expectedPrefix}test-evidence.json`,
  ];
  if (
    managedPaths.length !== expectedPaths.length
    || managedPaths.some((path, index) => normalizeRelPath(path) !== expectedPaths[index])
  ) return rollback('validation reuse transaction must manage exactly evidence, terminal, and receipt');

  try {
    appendLocalCausalReceiptsBeforeCommit({
      projectRoot: args.projectRoot,
      gitCwd: args.gitCwd,
      storyId: args.storyId,
      storyRel: args.storyRel,
      reason: args.reason,
      artifactPaths: args.closeoutArtifactPaths,
    });
    const subject = `lattice: record ${args.storyId} ${args.reason} metadata`;
    const committed = commitImmutableMetadataTree({
      root: args.gitCwd,
      gitCwd: args.gitCwd,
      paths: managedPaths,
      verifiedHashes: new Map(managedPaths.map((path) => [
        path,
        rawArtifactDigest(readFileSync(join(args.gitCwd, path))),
      ])),
      message: subject,
    });
    if (!committed.ok) return rollback(committed.reason || 'immutable metadata commit failed');
    return { ok: true, commitSha: committed.commitSha };
  } catch (error: any) {
    return rollback(`metadata transaction failed: ${String(error?.stderr || error?.stdout || error?.message || error).trim()}`);
  }
}

/**
 * storyId form gate — anti-broadening defense (preMortem #1).
 *
 * Production generator (`nextStoryId`) emits `B-{4-6 hex}`. Tests and fixtures
 * use richer alphanumeric forms like `B-test1`, `B-init-authority`, `B-001`.
 * We accept any `B-` followed by ASCII alphanumerics and hyphens — narrow
 * enough to reject path traversal (`..`, `/`, `\`, `:`, `@`, spaces, null
 * bytes, shell metacharacters) but broad enough not to bake production-only
 * id shapes into helper plumbing. Empty string and bare `B-` are rejected.
 */
const STORY_ID_PATTERN = /^B-[A-Za-z0-9][A-Za-z0-9-]*$/;

function assertStoryIdShape(storyId: string): void {
  if (typeof storyId !== 'string' || !STORY_ID_PATTERN.test(storyId)) {
    throw new Error(
      `autoCommitStoryMetadata: storyId must match /^B-[A-Za-z0-9][A-Za-z0-9-]*$/ (got: ${JSON.stringify(storyId)}). ` +
      `Refusing to git-add — broadening the path scope is a preMortem #1 anchor violation.`,
    );
  }
}

/**
 * Run classifyDirtyWorktree on the current git status of `projectRoot`.
 * Caller takes a snapshot BEFORE invoking `git add` / `git commit`, because the
 * commit itself takes metadata rows out of the dirty list — and the tail-note
 * must describe what coexisted at the moment of decision.
 */
function snapshotDirtyClassification(projectRoot: string, gitCwd: string): DirtyWorktreeClassification | null {
  try {
    const raw = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = raw.split('\n').map(line => line.trimEnd()).filter(Boolean);
    const config = loadConfig(projectRoot);
    return classifyGitStatusRows(lines, dirtyWorktreeClassifierOptionsFromConfig(config, projectRoot));
  } catch {
    return null;
  }
}

function nonMetadataCounts(classification: DirtyWorktreeClassification): Array<{ category: DirtyWorktreeCategory; count: number }> {
  return DIRTY_WORKTREE_CATEGORIES
    .filter(category => category !== 'lattice_metadata_changes')
    .map(category => ({ category, count: classification.groups[category]?.length ?? 0 }))
    .filter(({ count }) => count > 0);
}

function renderCoexistTailNote(classification: DirtyWorktreeClassification | null): string {
  if (!classification) return '';
  const counts = nonMetadataCounts(classification);
  if (counts.length === 0) return '';
  const parts = counts.map(({ category, count }) => `${category}=${count}`).join(', ');
  return ` (coexisting non-metadata dirt left untouched: ${parts})`;
}

function isNonGitRepositoryError(error: unknown): boolean {
  const anyError = error as { message?: unknown; stderr?: unknown };
  const stderr = Buffer.isBuffer(anyError?.stderr)
    ? anyError.stderr.toString('utf-8')
    : (typeof anyError?.stderr === 'string' ? anyError.stderr : '');
  const message = typeof anyError?.message === 'string' ? anyError.message : '';
  return `${message}\n${stderr}`.includes('not a git repository');
}

/**
 * Auto-commit metadata under the configured story directory.
 *
 * @param projectRoot — repo root (must contain `.git`)
 * @param storyId    — `B-xxxx` form (runtime-validated)
 * @param reason     — operation name (e.g. `finding_add`, `review_pass_set`,
 *                     `summary_set`, or a phase string for story_advance).
 *
 * @returns User-visible suffix (multi-line) to append to the handler's primary
 *          response. Empty string when no commit was produced (non-story branch,
 *          no dirty metadata, etc.). On failure, returns a `⚠ ... failed` warning
 *          line and also writes a health issue (never throws).
 */
export function autoCommitStoryMetadata(
  projectRoot: string,
  storyId: string,
  reason: string,
  options: { closeoutArtifactPaths?: readonly string[] } = {},
): string {
  // 1. storyId runtime gate (anti-broadening defense — preMortem #1 anchor)
  assertStoryIdShape(storyId);

  // B-db56: resolve the actual git cwd ONCE at function entry via the
  // resolveGitCwd choke-point. In a wrapper-root layout the metadataRoot
  // (== projectRoot) is NOT a git repo and the real repo is a configured
  // gitRoot subdir; resolveGitCwd routes us there. Plain-repo layouts and
  // unresolved/throws cases fall back to projectRoot — byte-identical.
  let gitCwd: string;
  try {
    gitCwd = resolveGitCwd({
      store: new StoryStore(projectRoot),
      storyId,
      metadataRoot: projectRoot,
      projectRoot,
    });
  } catch {
    gitCwd = projectRoot;
  }

  try {
    // 2. branch check — non-story/* branches stay silent
    let branch = '';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: gitCwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (e: unknown) {
      if (isNonGitRepositoryError(e)) return '';
      throw e;
    }
    if (!branch.startsWith('story/')) return '';

    // 3. canonical path computation (scope = configured storyDir + storyId)
    const store = new StoryStore(projectRoot);
    const storyAbsolute = realpathSync(resolve(store.storyDirPath(storyId)));
    const gitAbsolute = realpathSync(resolve(gitCwd));
    const storyRel = normalizeRelPath(relative(gitAbsolute, storyAbsolute));
    if (!storyRel || storyRel === '.' || isAbsolute(storyRel) || storyRel === '..' || storyRel.startsWith('../')) {
      throw new Error(
        `autoCommitStoryMetadata: configured story directory for ${storyId} is outside the resolved git workspace `
        + `(git=${gitAbsolute}, story=${storyAbsolute}, relative=${storyRel}). `
        + 'Refusing to git-add because the path scope cannot be contained.',
      );
    }

    // 4. snapshot the FULL dirty classification BEFORE committing (so the
    //    tail-note describes coexisting non-metadata dirt as it stood at decision
    //    time — `git add` / `git commit` will drop metadata rows otherwise).
    const dirtySnapshot = snapshotDirtyClassification(projectRoot, gitCwd);

    // 5. fast-path: is anything under the story dir dirty?
    const before = execFileSync('git', ['status', '--porcelain', '--', storyRel], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!before) return '';

    // Provenance telemetry is best-effort at write time but fail-closed at the
    // review gate: a receipt failure never mints a partial/guessed receipt and
    // never changes this helper's historical never-throw commit behavior.
    let receiptFailureNote = '';
    try {
      appendLocalCausalReceiptsBeforeCommit({
        projectRoot,
        gitCwd,
        storyId,
        storyRel,
        reason,
        artifactPaths: options.closeoutArtifactPaths ?? [],
      });
    } catch (receiptError) {
      const message = receiptError instanceof Error ? receiptError.message : String(receiptError);
      reportHealthIssue('persist:closeoutWriteReceipt', receiptError instanceof Error ? receiptError : new Error(String(receiptError)), {
        storyId,
        reason,
        projectRoot,
      });
      receiptFailureNote = `\n⚠ local causal closeout receipt was not issued: ${message}`;
    }

    // 6. stage only paths inside the story dir (path-scoped — never `.` / `-A`)
    execFileSync('git', ['add', '--', storyRel], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 7. double-check what got staged — defends against `.gitignore` quirks.
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--', storyRel], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!staged) return '';

    // 8. commit
    const subject = `lattice: record ${storyId} ${reason} metadata`;
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', subject], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 9. capture short sha for audit
    let sha7 = '';
    try {
      sha7 = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
        cwd: gitCwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // PROBE: rev-parse failed right after a successful commit — extremely
      // unlikely; fall through to omit the sha suffix rather than throw.
    }

    // 10. assemble tail-note from the PRE-commit snapshot (post-commit would
    //     under-count because git status now hides what we just committed).
    const tailNote = renderCoexistTailNote(dirtySnapshot);
    const shaSuffix = sha7 ? ` (${sha7})` : '';
    return `${AUTO_COMMIT_METADATA_PREFIX} ${subject}${shaSuffix}${tailNote}${receiptFailureNote}`;
  } catch (e: any) {
    reportHealthIssue('mutation:storyMetadataCommit', e instanceof Error ? e : new Error(String(e)), {
      storyId,
      reason,
      projectRoot,
    });
    return `\n⚠ lattice metadata auto-commit failed: ${e?.message || e}`;
  }
}
