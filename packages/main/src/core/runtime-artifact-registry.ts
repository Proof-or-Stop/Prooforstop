export const REVIEWER_BATCH_ADMISSION_ARTIFACT = { directoryName: 'reviewer-batch-admission', identityKeyFile: 'execution-identity.key', seedDirectoryName: 'provider-seeds', seedFileSuffix: '.seed.json', rosterFile: 'assignments.json', rosterLockDirectory: 'assignments.lock', probeWorkDirectoryName: 'work', probeTemporaryDirectoryName: 'tmp', inputPlanPrefix: 'input-plan-', inputPlanSuffix: '.json', launchReservationDirectoryName: 'launch-reservations', launchReservationFileSuffix: '.json', launchReservationLockSuffix: '.lock', location: 'canonical-project-runtime' } as const;
export const MANAGED_REVIEW_LANE_ARTIFACT = { directoryName: 'readonly-lane', buildSource: 'build-source', executionWorktree: 'execution-worktree', scratchAdminMarker: 'proof-or-stop-managed-review-identity', output: 'output', sourceOutput: '.proof-or-stop/runtime/managed-review-build', temporary: 'tmp', cache: 'cache', probe: 'probe', launchers: 'launchers', binding: 'build-binding.json', location: 'sealed-scratch-parent-and-git-admin', cleanup: 'owned-scratch-terminal-cleanup' } as const;
export const MACHINE_PROVIDER_ADMISSION_ARTIFACT = { directoryName: 'machine-provider-process-slots', location: 'os-user-home-runtime-locks' } as const;
export const MACHINE_FIXED_PORT_ARTIFACT = { directoryName: 'machine-fixed-port-capacity', location: 'os-user-home-runtime-locks' } as const;
export const MANAGED_REVIEW_TEMP_ARTIFACT = { directoryName: 'provider-temp', location: 'sealed-scratch-parent', cleanup: 'owned-scratch-terminal-cleanup' } as const;

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hasValidControllerConfigProjection, inspectControllerConfigProjection } from './controller-config-projection.js';
import {
  CONTROLLER_RUNTIME_ASSET_PATHS,
  existingControllerRuntimeAssetPaths,
  inspectControllerRuntimeProjection,
} from './controller-runtime-projection.js';
import { CONTROLLER_CONFIG_PROJECTION_ARTIFACT, CONTROLLER_RUNTIME_PROJECTION_ARTIFACT } from './managed-artifact-descriptors.js';
import { isManagedGlobalThinRoot, loadConfig, pickProjectConfigPath } from './config.js';

function hasGitMetadata(dir: string): boolean {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
/**
 * Runtime-artifact registry: shared classification for material hashing,
 * volatility, ignore patterns, and tracked-artifact repair. Canonical runtime
 * paths derive from brand-paths. Explicit retired generated-cache entries are
 * deny-only inventory: they never authorize old runtime reads or Story hiding.
 */
import {
  CONFIG_FILENAMES,
  PROOF_OR_STOP_STATE_DIR,
  STATE_DIR_NAMES,
} from './brand-paths.js';

export function isByteIdenticalControllerConfig(args: {
  projectRoot: string;
  gitCwd: string;
  storyId: string;
  path: string;
}): boolean {
  if (!CONFIG_FILENAMES.includes(args.path) || !/^B-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.storyId)) return false;
  try {
    const worktreeRoot = realpathSync(args.gitCwd);
    const projectRoot = realpathSync(args.projectRoot);
    if (worktreeRoot !== projectRoot) return false;
    const primaryRoot = realpathSync(resolveCanonicalRuntimeProjectRoot(worktreeRoot));
    if (primaryRoot === worktreeRoot) return false;
    const branch = execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: worktreeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (branch !== `refs/heads/story/${args.storyId}`) return false;
    for (const cwd of [worktreeRoot, primaryRoot]) {
      const tracked = execFileSync('git', ['ls-files', '--', args.path], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (tracked) return false;
    }
    const localPath = join(worktreeRoot, args.path);
    const controllerPath = join(primaryRoot, args.path);
    const localStat = lstatSync(localPath);
    const controllerStat = lstatSync(controllerPath);
    if (!localStat.isFile() || localStat.isSymbolicLink() || !controllerStat.isFile() || controllerStat.isSymbolicLink()) return false;
    const localBytes = readFileSync(localPath);
    const controllerBytes = readFileSync(controllerPath);
    return localBytes.equals(controllerBytes) && hasValidControllerConfigProjection({
      gitCwd: worktreeRoot,
      storyId: args.storyId,
      configPath: args.path,
      controllerRoot: primaryRoot,
      worktreeRoot,
      storyRoot: join(worktreeRoot, loadConfig(worktreeRoot).storyDir, args.storyId),
      configBytes: controllerBytes,
    });
  } catch {
    return false;
  }
}

export function isByteIdenticalControllerRuntimeAsset(args: {
  projectRoot: string;
  gitCwd: string;
  storyId: string;
  path: string;
}): boolean {
  if (!(CONTROLLER_RUNTIME_ASSET_PATHS as readonly string[]).includes(args.path) || !/^B-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.storyId)) return false;
  try {
    const worktreeRoot = realpathSync(args.gitCwd);
    if (realpathSync(args.projectRoot) !== worktreeRoot) return false;
    const controllerRoot = realpathSync(resolveCanonicalRuntimeProjectRoot(worktreeRoot));
    if (controllerRoot === worktreeRoot) return false;
    for (const cwd of [worktreeRoot, controllerRoot]) {
      if (execFileSync('git', ['ls-files', '--', args.path], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) return false;
    }
    return inspectControllerRuntimeProjection({
      gitCwd: worktreeRoot,
      storyId: args.storyId,
      controllerRoot,
      worktreeRoot,
      storyRoot: join(worktreeRoot, loadConfig(worktreeRoot).storyDir, args.storyId),
    }).valid;
  } catch { return false; }
}

export interface ExpectedControllerRuntimeProjectionStatus {
  expected: boolean;
  valid: boolean;
  reason: string;
  expectedPaths: string[];
  controllerRoot?: string;
}

/**
 * Verify the complete controller-owned runtime projection for a Story worktree.
 *
 * Per-path dirty classification cannot observe an absent untracked file. Review
 * admission therefore uses this whole-set check as well: when a global-thin
 * controller owns hook assets, every expected hook and both signed receipts
 * must still verify before a reviewer snapshots the candidate.
 */
export function inspectExpectedControllerRuntimeProjection(args: {
  projectRoot: string;
  gitCwd: string;
  storyId: string;
}): ExpectedControllerRuntimeProjectionStatus {
  if (!/^B-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.storyId)) {
    return { expected: false, valid: false, reason: 'invalid-story-id', expectedPaths: [] };
  }
  try {
    const worktreeRoot = realpathSync(args.gitCwd);
    if (realpathSync(args.projectRoot) !== worktreeRoot) {
      return { expected: false, valid: false, reason: 'project-root-mismatch', expectedPaths: [] };
    }
    const controllerRoot = realpathSync(resolveCanonicalRuntimeProjectRoot(worktreeRoot));
    if (controllerRoot === worktreeRoot || !isManagedGlobalThinRoot(controllerRoot)) {
      return { expected: false, valid: true, reason: 'not-controller-managed-worktree', expectedPaths: [], controllerRoot };
    }
    const expectedPaths = existingControllerRuntimeAssetPaths(controllerRoot);
    if (expectedPaths.length === 0) {
      return { expected: false, valid: true, reason: 'no-controller-assets', expectedPaths, controllerRoot };
    }
    const branch = execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], {
      cwd: worktreeRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (branch !== `refs/heads/story/${args.storyId}`) {
      return { expected: true, valid: false, reason: 'story-branch-mismatch', expectedPaths, controllerRoot };
    }
    const inspection = inspectControllerRuntimeProjection({
      gitCwd: worktreeRoot,
      storyId: args.storyId,
      controllerRoot,
      worktreeRoot,
      storyRoot: join(worktreeRoot, loadConfig(worktreeRoot).storyDir, args.storyId),
    });
    return { expected: true, valid: inspection.valid, reason: inspection.reason, expectedPaths, controllerRoot };
  } catch {
    return { expected: true, valid: false, reason: 'workspace-or-receipt-invalid', expectedPaths: [] };
  }
}

export interface ControllerProjectionReceiptStatus {
  matched: boolean;
  valid: boolean;
  reason: string;
  expectedPath?: string;
  controllerRoot?: string;
}

export function inspectControllerConfigProjectionReceipt(args: {
  projectRoot: string;
  gitCwd: string;
  storyId: string;
  path: string;
}): ControllerProjectionReceiptStatus {
  try {
    const worktreeRoot = realpathSync(args.gitCwd);
    if (realpathSync(args.projectRoot) !== worktreeRoot) return { matched: false, valid: false, reason: 'project-root-mismatch' };
    const config = loadConfig(worktreeRoot);
    const expectedPath = `${config.storyDir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')}/${args.storyId}/${CONTROLLER_CONFIG_PROJECTION_ARTIFACT.path}`;
    if (args.path.replace(/\\/g, '/').replace(/^\.\//, '') !== expectedPath) return { matched: false, valid: false, reason: 'different-path', expectedPath };
    const controllerRoot = realpathSync(resolveCanonicalRuntimeProjectRoot(worktreeRoot));
    if (controllerRoot === worktreeRoot) return { matched: true, valid: false, reason: 'not-linked-worktree', expectedPath, controllerRoot };
    const branch = execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: worktreeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (branch !== `refs/heads/story/${args.storyId}`) return { matched: true, valid: false, reason: 'story-branch-mismatch', expectedPath, controllerRoot };
    if (execFileSync('git', ['ls-files', '--', expectedPath], { cwd: worktreeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) {
      return { matched: true, valid: false, reason: 'tracked-story-receipt', expectedPath, controllerRoot };
    }
    const configRef = pickProjectConfigPath(controllerRoot);
    if (!configRef) return { matched: true, valid: false, reason: 'controller-config-missing', expectedPath, controllerRoot };
    for (const cwd of [worktreeRoot, controllerRoot]) {
      if (execFileSync('git', ['ls-files', '--', configRef.filename], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) {
        return { matched: true, valid: false, reason: 'tracked-controller-config', expectedPath, controllerRoot };
      }
    }
    const controllerStat = lstatSync(configRef.path);
    const worktreeConfig = join(worktreeRoot, configRef.filename);
    const worktreeStat = lstatSync(worktreeConfig);
    if (!controllerStat.isFile() || controllerStat.isSymbolicLink() || !worktreeStat.isFile() || worktreeStat.isSymbolicLink()) {
      return { matched: true, valid: false, reason: 'unsafe-controller-config', expectedPath, controllerRoot };
    }
    const configBytes = readFileSync(configRef.path);
    if (!configBytes.equals(readFileSync(worktreeConfig))) return { matched: true, valid: false, reason: 'config-bytes-differ', expectedPath, controllerRoot };
    const inspection = inspectControllerConfigProjection({
      gitCwd: worktreeRoot,
      storyId: args.storyId,
      configPath: configRef.filename,
      controllerRoot,
      worktreeRoot,
      storyRoot: join(worktreeRoot, config.storyDir, args.storyId),
      configBytes,
    });
    return { matched: true, valid: inspection.valid, reason: inspection.reason, expectedPath, controllerRoot };
  } catch {
    return { matched: true, valid: false, reason: 'workspace-or-receipt-invalid' };
  }
}

/** Classify the exact Story receipt path and verify its full projection proof. */
export function inspectControllerRuntimeProjectionReceipt(args: {
  projectRoot: string;
  gitCwd: string;
  storyId: string;
  path: string;
}): ControllerProjectionReceiptStatus {
  try {
    const worktreeRoot = realpathSync(args.gitCwd);
    if (realpathSync(args.projectRoot) !== worktreeRoot) return { matched: false, valid: false, reason: 'project-root-mismatch' };
    const config = loadConfig(worktreeRoot);
    const expectedPath = `${config.storyDir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')}/${args.storyId}/${CONTROLLER_RUNTIME_PROJECTION_ARTIFACT.path}`;
    if (args.path.replace(/\\/g, '/').replace(/^\.\//, '') !== expectedPath) return { matched: false, valid: false, reason: 'different-path', expectedPath };
    const controllerRoot = realpathSync(resolveCanonicalRuntimeProjectRoot(worktreeRoot));
    if (controllerRoot === worktreeRoot) return { matched: true, valid: false, reason: 'not-linked-worktree', expectedPath, controllerRoot };
    const branch = execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: worktreeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (branch !== `refs/heads/story/${args.storyId}`) return { matched: true, valid: false, reason: 'story-branch-mismatch', expectedPath, controllerRoot };
    if (execFileSync('git', ['ls-files', '--', expectedPath], { cwd: worktreeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) {
      return { matched: true, valid: false, reason: 'tracked-story-receipt', expectedPath, controllerRoot };
    }
    const inspection = inspectControllerRuntimeProjection({
      gitCwd: worktreeRoot,
      storyId: args.storyId,
      controllerRoot,
      worktreeRoot,
      storyRoot: join(worktreeRoot, config.storyDir, args.storyId),
    });
    return { matched: true, valid: inspection.valid, reason: inspection.reason, expectedPath, controllerRoot };
  } catch {
    return { matched: true, valid: false, reason: 'workspace-or-receipt-invalid' };
  }
}

export type RuntimeArtifactPathMatcher =
  | { kind: 'exact'; value: string }
  | { kind: 'prefix'; value: string }
  | { kind: 'regexp'; value: RegExp };

/**
 * Expand a state-dir-relative tail into canonical `exact` matchers.
 *
 * Callers never write the directory name, so a future rename cannot leave a
 * matcher recognizing only one spelling — the F-065/F-061 shape that
 * `core/brand-paths.ts` exists to prevent.
 */
function stateDirExact(tail: string): RuntimeArtifactPathMatcher[] {
  return STATE_DIR_NAMES.map((dir) => ({ kind: 'exact' as const, value: `${dir}/${tail}` }));
}

/** Same expansion for `prefix` matchers. */
function stateDirPrefix(tail: string): RuntimeArtifactPathMatcher[] {
  return STATE_DIR_NAMES.map((dir) => ({ kind: 'prefix' as const, value: `${dir}/${tail}` }));
}

/**
 * Ignore patterns for canonical state-directory-relative runtime paths.
 */
function stateDirIgnore(tail: string): string[] {
  return STATE_DIR_NAMES.map((dir) => `${dir}/${tail}`);
}

export interface RuntimeArtifactRegistryEntry {
  id: string;
  description: string;
  matchers: RuntimeArtifactPathMatcher[];
  ignorePatterns: string[];
  materialHash: 'exclude' | 'include';
  volatile: boolean;
  repairableTrackedArtifact: boolean;
}

export const PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_START = '# proof-or-stop runtime artifacts (managed)';
export const PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_END = '# /proof-or-stop runtime artifacts (managed)';

/**
 * Resolve the primary worktree that owns shared local runtime state. Linked
 * Story worktrees are intentionally not durable: DONE removes them. Runtime
 * ownership therefore follows the first primary entry from Git's NUL-delimited
 * worktree inventory. A proven non-git layout keeps the supplied root.
 * Transient or incomplete Git inventory fails closed instead of pinning a
 * linked-worktree fallback.
 */
/**
 * B-137a:F-125 — per-process memoization keyed by the RESOLVED search origin.
 *
 * Without it this forked `git worktree list` on every call, and the call sites
 * are hot: managed-host-run.ts resolves managedHostRunsRoot /
 * managedHostRunReceiptsRoot repeatedly, and provider slot admission resolves
 * the slots dir per acquire/release. Each fork costs a process spawn plus git
 * startup for an answer that cannot change within a process -- the primary
 * worktree of a given origin is fixed for the CLI's lifetime.
 *
 * Only SUCCESSFUL resolutions are cached. A proven non-git layout is not
 * cached as a primary root. Timeout or incomplete inventory throw rather than
 * pin a linked-worktree fallback.
 */
const canonicalRuntimeProjectRootCache = new Map<string, string>();

export function resolveCanonicalRuntimeProjectRoot(searchOrigin: string): string {
  const fallback = resolve(searchOrigin);
  const cached = canonicalRuntimeProjectRootCache.get(fallback);
  if (cached !== undefined) return cached;
  try {
    if (!existsSync(fallback)) return fallback;
    const inventory = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: fallback,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const primary = inventory
      .split('\0')
      .find(field => field.startsWith('worktree '))
      ?.slice('worktree '.length)
      .trim();
    if (!primary) {
      throw new Error('canonical runtime project root is uncertain: git worktree inventory was incomplete');
    }
    const resolved = resolve(primary);
    canonicalRuntimeProjectRootCache.set(fallback, resolved);
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('canonical runtime project root is uncertain:')) {
      throw error;
    }
    const err = error as { killed?: boolean; status?: number | null; stderr?: string };
    if (err.killed) {
      throw new Error('canonical runtime project root is uncertain: git worktree inventory timed out');
    }
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    if (err.status === 128 && /not a git repository/i.test(stderr)) {
      return fallback;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !hasGitMetadata(fallback)) {
      return fallback;
    }
    throw new Error(
      `canonical runtime project root is uncertain: git worktree inventory failed (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

function rx(value: string): RegExp {
  return new RegExp(value);
}

export const LAB_MAINTENANCE_GIT_DIR = 'lab-maintenance';

export const RUNTIME_ARTIFACT_REGISTRY: RuntimeArtifactRegistryEntry[] = [
  {
    id: 'retired-generated-cache-deny-only',
    description: 'Audited historical generated caches: ignore and classify only; never read, migrate, or treat as current authority. See b-49df-main-integration-provenance.md.',
    matchers: [
      { kind: 'prefix', value: '.lattice/runtime/host-runs/' },
      { kind: 'prefix', value: '.lattice/learning/runtime-memory-pack-cache/' },
      ...[
        '.lattice/runtime/framework-audit/state.json',
        '.lattice/learning/finding-signals.json',
        '.lattice/learning/playbook-promotion-health.jsonl',
        '.lattice/learning/playbooks.json',
        '.lattice/learning/signature-registry.json',
      ].map(value => ({ kind: 'exact' as const, value })),
    ],
    ignorePatterns: [
      '.lattice/runtime/host-runs/',
      '.lattice/learning/runtime-memory-pack-cache/',
      '.lattice/runtime/framework-audit/state.json',
      '.lattice/learning/finding-signals.json',
      '.lattice/learning/playbook-promotion-health.jsonl',
      '.lattice/learning/playbooks.json',
      '.lattice/learning/signature-registry.json',
    ],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: false,
  },
  {
    id: 'retired-root-import-residue-deny-only',
    description: 'Exact obsolete root files imported from the audited main integration: ignore and classify only; never read, migrate, repair, or treat as current authority. See b-49df-main-integration-provenance.md.',
    matchers: [
      { kind: 'exact', value: 'lattice.config.json' },
      { kind: 'exact', value: '.remember-scratch-readmanifest.json' },
    ],
    ignorePatterns: [
      '/lattice.config.json',
      '/.remember-scratch-readmanifest.json',
    ],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: false,
  },
  {
    id: 'lab-maintenance-git-records',
    description: 'Local Lab command records, output and key in the Git common directory; not Story evidence.',
    matchers: [{ kind: 'prefix', value: `.git/${LAB_MAINTENANCE_GIT_DIR}/` }],
    ignorePatterns: [], materialHash: 'exclude', volatile: false, repairableTrackedArtifact: false,
  },
  {
    id: 'proof-or-stop-runtime-root-ignore',
    description: `Ignore runtime state under the state directory (${STATE_DIR_NAMES.join(', ')}) while keeping tracked story evidence visible.`,
    matchers: [],
    // Order is load-bearing: within one spelling the broad ignore must precede
    // its own re-inclusions, so the patterns are grouped PER DIRECTORY rather
    // than interleaved across directories.
    ignorePatterns: STATE_DIR_NAMES.flatMap((dir) => [
      `${dir}/*`,
      `!${dir}/story/`,
      `${dir}/story/*`,
      `!${dir}/story/actives/`,
      `!${dir}/story/actives/**`,
      `${dir}/story/actives/**/activity.jsonl`,
    ]),
    materialHash: 'include',
    volatile: false,
    repairableTrackedArtifact: false,
  },
  {
    id: 'runtime-activity-log',
    description: 'Primary Proof-or-Stop runtime activity log.',
    matchers: stateDirExact('activity.jsonl'),
    ignorePatterns: ['**/activity.jsonl'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-c55d CHK-001: the per-story owner lease (`owner-lease.json`) is process
    // metadata, not story evidence. It lives under the git-tracked
    // `.proof-or-stop/story/actives/<id>/` subtree, so it MUST be ignored — an
    // un-ignored lease file would surface as a dirty write and could block the
    // DONE `git merge story/<id>` (the F-008 failure mode). The `**/` ignore
    // pattern mirrors `runtime-activity-log` above, which ignores the equally
    // story-scoped `activity.jsonl`.
    id: 'runtime-story-owner-lease',
    description: 'Per-story owner lease (local session ownership) written under .proof-or-stop/story/actives/<id>/.',
    matchers: [{ kind: 'regexp', value: rx(String.raw`(?:^|/)(?:owner-lease\.json|\.owner-lease-[a-f0-9-]+\.tmp)$`) }],
    ignorePatterns: ['**/owner-lease.json', '**/.owner-lease-*.tmp'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // Complete selector objects are durable evidence. They remain non-material
    // alongside their receipt, but must never be offered as disposable runtime data.
    id: 'causal-complete-selector-output',
    description: 'Signed-receipt-bound complete selector output objects.',
    matchers: [{kind:'regexp',value:rx(String.raw`(?:^|/)\.proof-or-stop/story/actives/[^/]+/causal-evidence/outputs(?:/|$)|(?:^|/)docs/story/actives/[^/]+/causal-evidence/outputs(?:/|$)`)}],
    ignorePatterns: [], materialHash: 'exclude', volatile: false, repairableTrackedArtifact: false,
  },
  {
    // B-5a15: immutable command receipts are lookup/runtime state, not story
    // source material. The CAS bytes remain auditable and story-scoped, but
    // writing them must not invalidate materialHash or make DONE's clean-tree
    // gate depend on a verification retry.
    id: 'runtime-causal-evidence-receipts',
    description: 'Story-scoped CausalEvidence CAS receipt bytes and execution-key index.',
    matchers: [{ kind: 'regexp', value: rx(String.raw`(?:^|/)\.proof-or-stop/story/actives/[^/]+/causal-evidence(?:/|$)|(?:^|/)docs/story/actives/[^/]+/causal-evidence(?:/|$)`) }],
    ignorePatterns: ['**/causal-evidence/index.json', '**/causal-evidence/receipts/', '**/causal-evidence/pending-publications/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-bbaf CHK-002/006: the convergence-breaker runtime state — breaker-state.json
    // (graduated freeze + auto-recovery budget), takeover-count.json (per-story
    // takeover counter), and gate-failure-counts.json (repeated-identical-gate-
    // failure counter) — are process/diagnostic metadata, NOT story evidence.
    // They live under the git-tracked .proof-or-stop/story/actives/<id>/ subtree, so
    // they MUST be ignored: an un-ignored breaker-state would surface as a dirty
    // write and could block the DONE `git merge story/<id>` (the F-008 failure
    // mode, exactly as for owner-lease.json above). materialHash-excluded so a
    // freeze/bump never perturbs currentMaterialHash and invalidates gate evidence.
    id: 'runtime-convergence-breaker-state',
    description: 'Per-story convergence-breaker runtime state (freeze state + takeover/gate-failure counters) under .proof-or-stop/story/actives/<id>/.',
    matchers: [
      { kind: 'regexp', value: rx(String.raw`(?:^|/)breaker-state\.json$`) },
      { kind: 'regexp', value: rx(String.raw`(?:^|/)takeover-count\.json$`) },
      { kind: 'regexp', value: rx(String.raw`(?:^|/)gate-failure-counts\.json$`) },
    ],
    ignorePatterns: ['**/breaker-state.json', '**/takeover-count.json', '**/gate-failure-counts.json'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'legacy-activity-log',
    description: 'Legacy activity log retained for compatibility reads, at the repo root or under any nested package directory.',
    // B-137a: the legacy path resolves against the CLI's CWD, so a command run
    // from a subdirectory (a reviewer doing `cd packages/main && node ...`)
    // writes `packages/main/docs/story/activity.jsonl` rather than the root
    // copy. That is the SAME artifact kind -- the repo already declares it
    // non-material via the `**/activity.jsonl` gitignore rule -- but an `exact`
    // matcher recognized only the root spelling, so a nested copy counted as
    // provider-created material and failed the managed-review scratch check
    // after a legitimate read-only investigation. Anchor the regexp to the full
    // `docs/story/activity.jsonl` tail so it still matches nothing else.
    matchers: [
      { kind: 'exact', value: 'docs/story/activity.jsonl' },
      { kind: 'regexp', value: /^(?:[^/]+\/)+docs\/story\/activity\.jsonl$/ },
    ],
    ignorePatterns: [],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'owner-session-token-store',
    description: 'Local generated owner-session tokens under <state-dir>/runtime/owner-session-tokens/.',
    matchers: stateDirPrefix('runtime/owner-session-tokens/'),
    ignorePatterns: stateDirIgnore('runtime/owner-session-tokens/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'reviewer-batch-admission',
    description: 'Signed operational batch readiness generations and controller locks, never reviewer verdict evidence.',
    matchers: stateDirPrefix(`runtime/${REVIEWER_BATCH_ADMISSION_ARTIFACT.directoryName}/`),
    ignorePatterns: stateDirIgnore(`runtime/${REVIEWER_BATCH_ADMISSION_ARTIFACT.directoryName}/`),
    materialHash: 'exclude', volatile: true, repairableTrackedArtifact: true,
  },
  {
    id: 'managed-host-runs',
    // B-137a: derive the path instead of hardcoding a retired state dir. These
    // matchers named `.lattice/runtime/host-runs/`, but the producers join
    // PROOF_OR_STOP_DIR (managed-host-run.ts:683), and STATE_DIR_NAMES accepts
    // no legacy spelling -- so the entry matched nothing. First-match-wins then
    // handed real artifacts to `runtime-cache` below, which agrees on
    // materialHash:'exclude' but NOT on repairableTrackedArtifact, silently
    // losing this entry's declared intent; `proof-or-stop init` also wrote an
    // ignore rule for a directory nothing writes.
    description: 'Durable local provider-run specs, one-shot inputs, journals, snapshots, terminals, and evidence bindings under <state-dir>/runtime/host-runs/.',
    matchers: stateDirPrefix('runtime/host-runs/'),
    ignorePatterns: stateDirIgnore('runtime/host-runs/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: false,
  },
  {
    id: 'managed-host-run-receipts',
    // B-137a: same derivation fix as `managed-host-runs` above -- the producer
    // is managed-host-run.ts:687, which joins PROOF_OR_STOP_DIR.
    description: 'Bounded terminal receipt archives preserved after heavy ManagedHostRun runtime GC, under <state-dir>/runtime/host-run-receipts/.',
    matchers: stateDirPrefix('runtime/host-run-receipts/'),
    ignorePatterns: stateDirIgnore('runtime/host-run-receipts/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: false,
  },
  {
    // B-137a: these two runtime directories are written by this story
    // (host-run.ts:1954 joins PROOF_OR_STOP_DIR/runtime/host-run-prompts/,
    // provider-process-registry.ts:37 joins .../provider-process-slots/) but had
    // no entry of their own, so first-match-wins handed them to the generic
    // `runtime-cache` below. That fallback agrees on materialHash:'exclude' but
    // NOT on repairableTrackedArtifact -- it reports `true` where every sibling
    // managed-run directory declares `false` -- so the declared intent for these
    // paths was silently replaced by a weaker one. Same defect shape as the
    // dead `managed-host-runs` matchers repaired earlier in this story.
    id: 'managed-host-run-prompts',
    description: 'One-shot provider prompt files for managed host runs under <state-dir>/runtime/host-run-prompts/.',
    matchers: stateDirPrefix('runtime/host-run-prompts/'),
    ignorePatterns: stateDirIgnore('runtime/host-run-prompts/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: false,
  },
  {
    id: 'provider-process-slots',
    description: 'Token-owned provider concurrency slots under <state-dir>/runtime/provider-process-slots/.',
    matchers: stateDirPrefix('runtime/provider-process-slots/'),
    ignorePatterns: stateDirIgnore('runtime/provider-process-slots/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: false,
  },
  {
    id: 'runtime-cache',
    description: 'Mutable runtime cache and trigger state under <state-dir>/runtime/, including bounded advisory validation-reuse-costs.json and atomic temporary files; never PASS authority.',
    matchers: stateDirPrefix('runtime/'),
    ignorePatterns: stateDirIgnore('runtime/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-a7c5 F-005: dev_memory_finish_decision (core/playbook-runtime-memory.ts
    // finishDecisionPath) writes OUTSIDE .proof-or-stop/story/actives/<storyId>/, so
    // autoCommitStoryMetadata (deliberately hard-scoped to the story dir --
    // its own anti-broadening preMortem #1 anchor) never covers it. Before this
    // entry existed, an uncommitted write here fell through classifyParsedRow
    // to `unexpected_dirty_files` (blocking) and stranded review_run_start and
    // other dirty-tree-sensitive gates -- found live during B-a7c5's own REVIEW
    // round 3. UNLIKE this registry's other entries, deliberately NO
    // ignorePatterns: .proof-or-stop/dev-memory/** is explicitly un-ignored (see
    // .gitignore) because these records are meant to be git-tracked and shared
    // across agents/hosts, not ephemeral runtime state. materialHash:'exclude'
    // is still required so writing/refreshing this record can never perturb
    // currentMaterialHash and thus never invalidate an already-signed evidence
    // freshness binding (test-evidence.json / delivery-check.json) -- this was
    // confirmed as a real regression risk when an earlier draft of this fix
    // tried auto-committing the write instead (that approach moved HEAD and
    // broke delivery-check materialHash freshness; excluding from materialHash
    // computation avoids the problem at its root instead).
    // B-5a15: dev_memory_capture writes <state-dir>/dev-memory/experience.jsonl,
    // a sibling of finish-decisions/ that the entry below does NOT match. Without
    // an entry it counted as story MATERIAL, and that broke certification:
    // deriveCertificationDomainInputHashes (handlers/certification-window.ts)
    // returns undefined for any story-owned path matching no CERTIFICATION_DOMAIN_PATH_RULES
    // entry, which drove causalInputHashes absent -> identityComplete false ->
    // certification_window_begin BLOCKED [pre_cert_causal_freshness_required]. The
    // DONE gate itself requires dev_memory_finish_decision, so capturing a lesson is
    // a mandatory closeout step that must not be able to block certification.
    // Same rationale and same shape as the finish-decision entry below: git-tracked
    // and shared across agents/hosts (hence NO ignorePatterns), but
    // materialHash:'exclude' so writing a lesson can never perturb currentMaterialHash
    // and invalidate an already-signed evidence freshness binding.
    id: 'dev-memory-experience-log',
    description: 'Append-only dev_memory_capture experience log under <state-dir>/dev-memory/experience.jsonl, tracked but non-authoritative.',
    // stateDirExact, not stateDirPrefix (B-5a15:F-392): this is always one fixed
    // filename -- resolveProjectMemoryPath/resolveGlobalMemoryPath never produce a
    // variant -- so it follows the activity.jsonl / learning-log.jsonl convention.
    // The prefix form was an imprecise copy from the finish-decisions sibling, which
    // is genuinely a directory; prefix also wrongly matched nested paths under the
    // filename, widening the materialHash exclusion beyond the one real file.
    matchers: stateDirExact('dev-memory/experience.jsonl'),
    ignorePatterns: [],
    materialHash: 'exclude',
    volatile: false,
    repairableTrackedArtifact: false,
  },
  {
    id: 'dev-memory-finish-decision',
    description: 'Per-story dev_memory_finish_decision record under <state-dir>/dev-memory/finish-decisions/, tracked but non-authoritative.',
    matchers: stateDirPrefix('dev-memory/finish-decisions/'),
    ignorePatterns: [],
    materialHash: 'exclude',
    volatile: false,
    repairableTrackedArtifact: false,
  },
  {
    id: 'runtime-traces',
    description: 'Trace artifacts emitted under <state-dir>/traces/.',
    matchers: stateDirPrefix('traces/'),
    ignorePatterns: stateDirIgnore('traces/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'verification-evidence-artifacts',
    description: 'Immutable content-addressed verification-output objects, refs, and the observed ledger; policy or unknown files elsewhere under evidence/ remain material.',
    matchers: STATE_DIR_NAMES.flatMap((dir) => [
      {
        kind: 'regexp' as const,
        value: rx(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/evidence/objects/sha256/[a-f0-9]{64}\\.json$`),
      },
      {
        kind: 'regexp' as const,
        value: rx(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/evidence/refs/by-id/[A-Za-z0-9][A-Za-z0-9._-]*\\.json$`),
      },
      { kind: 'exact' as const, value: `${dir}/evidence/ledger/observed.jsonl` },
    ]),
    ignorePatterns: stateDirIgnore('evidence/'),
    materialHash: 'exclude',
    volatile: false,
    repairableTrackedArtifact: false,
  },
  {
    // B-cc10 CHK-007 (F-004): this entry named ONLY the deprecated state
    // directory while the runtime had already moved to the canonical one, so
    // `.proof-or-stop/locks/` was neither gitignored nor recognized as runtime
    // state. Measured symptom: validate-execution-lock-smoke failed with
    // `unexpected_dirty_files=2` on the validation-capacity lock's holder.json /
    // heartbeat.json. Now derived, so it covers both spellings by construction.
    id: 'runtime-locks',
    description: 'Main write lock and other mkdir-style coordination locks under <state-dir>/locks/, including execution-key producer locks that serialize verification evidence publication.',
    matchers: stateDirPrefix('locks/'),
    // B-cc10 F-062: `**/*.lock/` must be REGISTRY-owned, not hand-typed into .gitignore.
    // It lived only as a literal inside the generator-owned managed block, so
    // mergeProofOrStopRuntimeIgnores() regenerated that block WITHOUT it — meaning the next
    // `init --upgrade` would delete the rule again (it had already been lost twice). The
    // pattern is deliberately state-dir-INDEPENDENT: transient <name>.lock/ dirs
    // (checklist/finding/review-run/init-check) each carry a holder.json token and appear
    // wherever the artifact they guard lives, not only under <state-dir>/locks/.
    ignorePatterns: [...stateDirIgnore('locks/'), '**/*.lock/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-253e CHK-005: the local LLM usage ledger (.proof-or-stop/usage/llm-usage.jsonl)
    // is a mutable runtime diagnostic — budget accounting and operator
    // diagnostics, NOT story evidence, validation evidence, or gate-consumed
    // proof. doctor / material-hash / runtime-artifact repair / gitignore must
    // treat it like other mutable runtime diagnostics under .proof-or-stop/. The
    // prefix matcher also covers future adjacent usage-runtime files under
    // .proof-or-stop/usage/ without catching unrelated paths (e.g. story evidence).
    id: 'llm-usage-ledger',
    description: 'local LLM usage diagnostic ledger',
    matchers: [
      ...stateDirExact('usage/llm-usage.jsonl'),
      ...stateDirPrefix('usage/'),
    ],
    ignorePatterns: stateDirIgnore('usage/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-000c CHK-003: the Experience Layer derived caches under
    // .proof-or-stop/learning/ (finding-signals.json + learning-log.jsonl) are mutable
    // runtime diagnostics derived from existing findings — NOT story evidence,
    // validation evidence, or gate-consumed proof. They MUST be materialHash-
    // excluded so deriving/refreshing the cache never perturbs currentMaterialHash
    // and thus never invalidates a gate's evidence freshness. Mirrors the
    // llm-usage-ledger entry above; the prefix matcher also covers future
    // adjacent learning-runtime files under .proof-or-stop/learning/.
    id: 'experience-layer-learning-cache',
    description: 'Experience Layer derived finding-signals cache and learning log under <state-dir>/learning/.',
    matchers: [
      ...stateDirExact('learning/finding-signals.json'),
      ...stateDirExact('learning/learning-log.jsonl'),
      ...stateDirPrefix('learning/'),
    ],
    ignorePatterns: stateDirIgnore('learning/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'serve-metadata',
    description: 'Transient dev-server handshake file.',
    // NOT derived, and not a bug: `.proof-or-stop-serve.json` is a SIBLING marker file,
    // not a path inside the state directory, and it is not one of the six
    // identities B-cc10 migrates. `verifier/serve.ts` and `verifier/dev-host.ts`
    // still write exactly this name, so the registry must keep matching it —
    // deriving it would rename the ignore pattern away from the file the runtime
    // actually creates. Same reasoning as `PROOF_OR_STOP_REPAIR_IGNORE` in
    // `core/proof-or-stop-paths.ts`: renaming a sibling marker stays a separate,
    // deliberate decision.
    matchers: [
      { kind: 'exact', value: '.proof-or-stop-serve.json' },
    ],
    ignorePatterns: ['.proof-or-stop-serve.json'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'proof-or-stop-authority-key-file',
    description: 'Internal Proof-or-Stop Authority key-management file; may contain local private key material.',
    // The capitalized `.proof-or-stop/` variant is retained deliberately: this file may
    // hold private key material, so on a case-insensitive filesystem a
    // differently-cased path must never fall out of the ignore set. It is kept as
    // an explicit legacy literal rather than derived, because the canonical
    // spelling is all-lowercase and has no capitalized twin to generate.
    matchers: [
      ...stateDirExact('authority.md'),
      { kind: 'exact', value: '.proof-or-stop/authority.md' },
    ],
    ignorePatterns: [...stateDirIgnore('authority.md'), '.proof-or-stop/authority.md'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'proof-or-stop-baseline-artifacts',
    description: 'Proof-or-Stop baseline proof artifacts kept outside the material tree.',
    // `.proof-or-stop/` retained for the same case-insensitive-filesystem reason as the
    // authority key file above.
    matchers: [
      ...stateDirPrefix('artifacts/baseline/'),
      { kind: 'prefix', value: '.proof-or-stop/artifacts/baseline/' },
    ],
    ignorePatterns: [
      ...stateDirIgnore('artifacts/baseline/'),
      '.proof-or-stop/artifacts/baseline/',
    ],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'memory-playbook-baseline-artifacts',
    description: 'Deterministic playbook runtime memory benchmark corpora and reports.',
    matchers: stateDirPrefix('benchmarks/memory-playbook/'),
    ignorePatterns: stateDirIgnore('benchmarks/memory-playbook/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'runtime-temp',
    description: 'Temporary runtime scratch files and directories.',
    matchers: [{ kind: 'regexp', value: rx(String.raw`^\.proof-or-stop-tmp-[^/]+(?:/.*)?$`) }],
    ignorePatterns: ['.proof-or-stop-tmp-*'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'debug-log',
    description: 'CLI debug log emitted in the repo root.',
    matchers: [
      { kind: 'exact', value: 'proof-or-stop-debug.log' },
    ],
    ignorePatterns: ['proof-or-stop-debug.log'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'browser-test-log',
    description: 'Browser verification log emitted in the repo root.',
    matchers: [{ kind: 'exact', value: 'browser-test.log' }],
    ignorePatterns: ['browser-test.log'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'project-root-scratch',
    description: 'Host scratch directory created by external adapters.',
    matchers: [{ kind: 'prefix', value: '$PROJECT_ROOT/' }],
    ignorePatterns: ['$PROJECT_ROOT/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
];

export function normalizeRuntimeArtifactPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

// Cache only pure string normalization, never a path classification. Registry
// order, matcher replacement/value changes and stateful regexes remain live.
const normalizedMatcherValues = new WeakMap<RuntimeArtifactPathMatcher, { value: string; normalized: string }>();

function normalizedMatcherValue(matcher: RuntimeArtifactPathMatcher & { value: string }): string {
  const value = matcher.value;
  const cached = normalizedMatcherValues.get(matcher);
  if (cached?.value === value) return cached.normalized;
  const normalized = normalizeRuntimeArtifactPath(value);
  normalizedMatcherValues.set(matcher, { value, normalized });
  return normalized;
}

function matchesRuntimeArtifact(entry: RuntimeArtifactRegistryEntry, normalized: string): boolean {
  return entry.matchers.some((matcher) => {
    if (matcher.kind === 'exact') return normalized === normalizedMatcherValue(matcher);
    if (matcher.kind === 'prefix') {
      const base = normalizedMatcherValue(matcher);
      return normalized === base || normalized.startsWith(`${base}/`);
    }
    return matcher.value.test(normalized);
  });
}

export function findRuntimeArtifactEntry(path: string): RuntimeArtifactRegistryEntry | undefined {
  // Keep the former two passes: each removes only one leading './'. Hoist the
  // per-entry pass without changing this deliberately non-idempotent behavior.
  const normalized = normalizeRuntimeArtifactPath(normalizeRuntimeArtifactPath(path));
  return RUNTIME_ARTIFACT_REGISTRY.find((entry) => entry.matchers.length > 0 && matchesRuntimeArtifact(entry, normalized));
}

export function isRuntimeArtifactPath(path: string): boolean {
  return Boolean(findRuntimeArtifactEntry(path));
}

export function isMaterialExcludedRuntimeArtifactPath(path: string): boolean {
  return findRuntimeArtifactEntry(path)?.materialHash === 'exclude';
}

export function isVolatileRuntimeArtifactPath(path: string): boolean {
  return findRuntimeArtifactEntry(path)?.volatile === true;
}

export function isRepairableTrackedRuntimeArtifactPath(path: string): boolean {
  return findRuntimeArtifactEntry(path)?.repairableTrackedArtifact === true;
}

export function listRuntimeArtifactIgnorePatterns(): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of RUNTIME_ARTIFACT_REGISTRY) {
    for (const pattern of entry.ignorePatterns) {
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      lines.push(pattern);
    }
  }
  return lines;
}
