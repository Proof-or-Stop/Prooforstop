import { execFileSync } from 'child_process';
import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import type { ReviewRun, ReviewScopeBinding } from '../core/types.js';
import {
  buildReviewRunWorkspaceBinding,
  ensureCurrentReviewRound,
  captureReviewRunSnapshot,
  resolveReviewPromptHash,
  resolveReviewRunLane,
  signReviewRun,
} from '../core/review-run.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';
import { computeReviewScopeBinding } from '../core/review-scope-binding.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { loadConfig } from '../core/config.js';
import {
  readGitStatusLines,
  classifierOptionsForCheck,
  classifyGitStatusRows,
  isBlockingDirty,
} from '../core/dirty-worktree-gate.js';

function withReviewRunLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  const lockDir = ctx.store.storyFilePath(storyId, 'review-runs.lock');
  return withMkdirLock(lockDir, fn, { label: 'review-runs metadata' });
}

type ResolvedReviewWorkspace = ReturnType<typeof resolveStoryCommandWorkspace>;

function resolveSignedWorkspaceRoot(workspace: ResolvedReviewWorkspace, storyId: string): string {
  const signedWorkspaceRoot = workspace.signedWorkspaceRoot || workspace.snapshotRoot;
  if (!signedWorkspaceRoot) {
    throw new Error(
      `review_run_start: story ${storyId} cannot resolve a git-backed signed workspace.\n` +
      `metadataRoot: ${workspace.metadataRoot}\n` +
      `signedWorkspaceRoot: unresolved\n` +
      `Reason: ${workspace.unresolvedReason || 'requires_git_signed_workspace_but_no_binding'}\n` +
      'No reviewer run was created. Local host output is diagnostic only and no local proof-admissibility evidence was produced.',
    );
  }
  return signedWorkspaceRoot;
}

function resolveGitTopLevel(gitCwd: string): string | null {
  // B-75f0 CHK-004: param named `gitCwd` because the sole caller
  // (review_run_start, below) passes the already-resolved signedWorkspaceRoot
  // (authoritativeCwd), never a bare metadataRoot. Pure rename, zero behavior
  // change — the inbound value is unchanged.
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export function createReviewRunHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    review_run_start(args: { storyId: string; agent?: string; lane?: string; prompt?: string; promptHash?: string; reviewedIntentRefs?: string[] }): string {
      const workspace = resolveStoryCommandWorkspace(store, args.storyId, ctx.root);
      const signedWorkspaceRoot = resolveSignedWorkspaceRoot(workspace, args.storyId);
      const preflightStory = store.readStory(args.storyId);
      if (preflightStory.phase !== 'REVIEW') {
        throw new Error(
          `review_run_start: story ${args.storyId} must be in REVIEW phase (current: ${preflightStory.phase})`,
        );
      }

      // B-7691: material-source clean-tree preflight. Reuse the DONE gate's
      // shared git-status read + DIRTY_GATE_POLICY blocking table so a reviewer
      // cannot snapshot a run over uncommitted material-source / fixture drift.
      // Fail-OPEN on an unreadable git status (convenience gate; mirrors how the
      // DONE gate tolerates an unreadable status) — never throw on a broken read.
      // The DONE verdict, materialHash computation, and the evidence-write-time
      // freshness guard are NOT touched; this only READS DIRTY_GATE_POLICY.
      const preflightRoot = workspace.metadataRoot || ctx.root;
      const status = readGitStatusLines(signedWorkspaceRoot);
      if (status.ok) {
        const classification = classifyGitStatusRows(
          status.lines,
          classifierOptionsForCheck(loadConfig(preflightRoot), args.storyId, store, preflightRoot),
        );
        const b = isBlockingDirty(classification);
        if (b.blocked) {
          throw new Error(
            `review_run_start: git working tree has uncommitted ${b.blockingCategories.join('/')} changes ` +
            `(${b.blockingPaths.slice(0, 5).join(', ')}). ` +
            'Commit or revert all code/config changes, then rerun review_run_start.',
          );
        }
      }
      // status.ok === false → fail-open: after this preflight declines to block, proceed to the snapshot.

      const lane = resolveReviewRunLane(args.agent || process.env.LATTICE_AGENT, args.lane);
      const promptHash = resolveReviewPromptHash(args.prompt, args.promptHash);
      const startedAt = new Date().toISOString();
      const { headHash, materialHash, storyFilesHash } = captureReviewRunSnapshot(signedWorkspaceRoot, {
        storyId: args.storyId,
        storyPhase: preflightStory.phase,
        currentReviewRound: preflightStory.currentReviewRound,
        workspaceMode: workspace.workspaceMode || workspace.resolutionSource || workspace.mode,
        expectedWorktreeRoot: workspace.expectedWorktreeRoot,
      });
      const workspaceBinding = buildReviewRunWorkspaceBinding({
        metadataRoot: workspace.metadataRoot || ctx.root,
        invocationCwd: workspace.cwd || process.cwd(),
        repoRoot: workspace.repoRoot ?? resolveGitTopLevel(signedWorkspaceRoot),
        signedWorkspaceRoot,
        workspaceMode: workspace.workspaceMode || workspace.resolutionSource || workspace.mode,
        headHash,
        materialHash,
        storyFilesHash,
      });
      const story = ensureCurrentReviewRound(store, args.storyId, 'review_run_start');

      // B-6bfd CHK-005: for a scope-protected story, capture the scope/diff/hunk
      // binding so this run is bound to the EXACT scope contract + diff the
      // reviewer inspects. Absent for unprotected/legacy stories (no contract) →
      // run signs without a binding and the gate stays backward compatible.
      const contract = store.readScopeContract(args.storyId);
      let scopeBinding: ReviewScopeBinding | undefined;
      if (contract) {
        const diffPack = buildScopeDiffPack(signedWorkspaceRoot);
        scopeBinding = computeReviewScopeBinding({
          contract,
          diffPack,
          reviewedIntentRefs: args.reviewedIntentRefs,
          projectRoot: signedWorkspaceRoot,
        }) ?? undefined;
      }

      return withReviewRunLock(ctx, args.storyId, () => {
        const data = store.readReviewRuns(args.storyId);
        const nextNum = data.runs.reduce((max, run) => {
          const match = run.reviewRunId.match(/:RR-(\d+)$/);
          return match ? Math.max(max, Number(match[1])) : max;
        }, 0) + 1;
        const reviewRunId = `${args.storyId}:RR-${String(nextNum).padStart(3, '0')}`;
        const run: ReviewRun = {
          reviewRunId,
          storyId: args.storyId,
          agent: lane,
          lane,
          reviewRound: story.currentReviewRound!,
          startedAt,
          headHash,
          materialHash,
          ...(storyFilesHash ? { storyFilesHash } : {}),
          promptHash,
          ...(scopeBinding ? { scopeBinding } : {}),
          workspaceBinding,
          _hash: signReviewRun(
            args.storyId,
            reviewRunId,
            lane,
            lane,
            story.currentReviewRound!,
            startedAt,
            headHash,
            materialHash,
            promptHash,
            scopeBinding?.bindingHash,
            workspaceBinding.bindingHash,
            storyFilesHash,
          ),
        };
        data.runs.push(run);
        store.writeReviewRuns(args.storyId, data);
        const persisted = store.readReviewRuns(args.storyId).runs.find((candidate) => candidate.reviewRunId === reviewRunId);
        if (
          !persisted || persisted._hash !== run._hash || persisted.materialHash !== materialHash
          || persisted.storyFilesHash !== storyFilesHash
          || persisted.scopeBinding?.bindingHash !== scopeBinding?.bindingHash
          || persisted.workspaceBinding?.bindingHash !== workspaceBinding.bindingHash
        ) {
          throw new Error(`review_run_start: ${reviewRunId} was not durably persisted; refusing to continue`);
        }
        const scopeNote = scopeBinding
          ? `, scope ${scopeBinding.scopeContractHash?.slice(0, 7)}/${scopeBinding.diffPackHash?.slice(0, 7)}`
          : '';
        const storyHashNote = storyFilesHash ? `, story ${storyFilesHash.slice(0, 7)}` : '';
        return `Review run ${reviewRunId} started for ${lane} (round ${story.currentReviewRound}, head ${headHash.slice(0, 7)}${storyHashNote}${scopeNote})`;
      });
    },
  };
}
