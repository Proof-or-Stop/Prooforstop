import { mkdirSync, rmSync, statSync } from 'fs';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import type { ReviewRun, ReviewScopeBinding } from '../core/types.js';
import {
  captureReviewRunSnapshot,
  resolveReviewPromptHash,
  resolveReviewRunLane,
  signReviewRun,
} from '../core/review-run.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';
import { computeReviewScopeBinding } from '../core/review-scope-binding.js';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withReviewRunLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  const lockDir = ctx.store.storyFilePath(storyId, 'review-runs.lock');
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e: any) {
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > 10000) rmSync(lockDir, { recursive: true, force: true });
      } catch { /* PROBE: lock disappeared between retries */ }
      if (Date.now() > deadline) {
        throw new Error(`review_run_start: timed out waiting for metadata lock (${e?.message || e})`);
      }
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function createReviewRunHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    review_run_start(args: { storyId: string; agent?: string; lane?: string; prompt?: string; promptHash?: string; reviewedIntentRefs?: string[] }): string {
      assertCwdInWorktree(store, args.storyId);
      const story = store.readStory(args.storyId);
      if (!story.currentReviewRound) {
        throw new Error(`review_run_start: story ${args.storyId} 当前没有 currentReviewRound；先推进到 REVIEW 再启动 reviewer run`);
      }
      const lane = resolveReviewRunLane(args.agent || process.env.KOALA_AGENT, args.lane);
      const promptHash = resolveReviewPromptHash(args.prompt, args.promptHash);
      const startedAt = new Date().toISOString();
      const { headHash, materialHash } = captureReviewRunSnapshot(ctx.root);

      // B-6bfd CHK-005: for a scope-protected story, capture the scope/diff/hunk
      // binding so this run is bound to the EXACT scope contract + diff the
      // reviewer inspects. Absent for unprotected/legacy stories (no contract) →
      // run signs without a binding and the gate stays backward compatible.
      const contract = store.readScopeContract(args.storyId);
      let scopeBinding: ReviewScopeBinding | undefined;
      if (contract) {
        const diffPack = buildScopeDiffPack(ctx.root);
        scopeBinding = computeReviewScopeBinding({
          contract,
          diffPack,
          reviewedIntentRefs: args.reviewedIntentRefs,
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
          promptHash,
          ...(scopeBinding ? { scopeBinding } : {}),
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
          ),
        };
        data.runs.push(run);
        store.writeReviewRuns(args.storyId, data);
        const persisted = store.readReviewRuns(args.storyId).runs.find((candidate) => candidate.reviewRunId === reviewRunId);
        if (
          !persisted || persisted._hash !== run._hash || persisted.materialHash !== materialHash
          || persisted.scopeBinding?.bindingHash !== scopeBinding?.bindingHash
        ) {
          throw new Error(`review_run_start: ${reviewRunId} was not durably persisted; refusing to continue`);
        }
        const scopeNote = scopeBinding
          ? `, scope ${scopeBinding.scopeContractHash?.slice(0, 7)}/${scopeBinding.diffPackHash?.slice(0, 7)}`
          : '';
        return `Review run ${reviewRunId} started for ${lane} (round ${story.currentReviewRound}, head ${headHash.slice(0, 7)}${scopeNote})`;
      });
    },
  };
}
