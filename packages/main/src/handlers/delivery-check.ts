/**
 * Delivery Check handler — lattice delivery_check_set
 *
 * Signing utility functions for the TEST → DONE hard gate artifact delivery-check.json.
 *
 * Invoked when the lattice-review-delivery reviewer is spawned at the end of TEST,
 * reverse-scans git diff to list docsPromises + real-machine transcript + closing self-check,
 * writes a signed JSON as the third key for DONE (first two: test-evidence PASS + all bugs fixed).
 *
 * Signing domain: storyId + JSON.stringify(docsPromises) + JSON.stringify(realMachineTests)
 *          + JSON.stringify(closingSelfCheck) + reviewRound + salt
 *
 * waiverReason (≥ 30 chars) enters JSON.stringify of realMachineTests, automatically included in the signature.
 */

import type { HandlerContext } from './context.js';
import type { DeliveryCheckData, DocsPromise, RealMachineTest, ClosingSelfCheck } from '../core/types.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash, EMPTY_STORY_FILES_HASH } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { evaluateOptionalLiveSmokeTranscript } from '../core/live-smoke-transcript-evidence.js';

// Signature primitives live in core/delivery-check-hash.ts (single source of
// truth) so core consumers can verify the hash without a core→handlers import.
// No re-export here: all callers (core/machine.ts, core/done-oracle.ts, tasks/*)
// import directly from core/delivery-check-hash.js — keep that the only path.

/**
 * delivery_check_set handler factory.
 *
 * Invoked by the lattice-review-delivery subagent, writes delivery-check.json.
 * Validation logic:
 * - When waiverReason is non-empty it must be ≥ 30 chars (enters _hash to prevent post-hoc tampering)
 * - closingSelfCheck.summary ≥ 10 chars
 */
export function createDeliveryCheckHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    delivery_waiver_add(args: {
      storyId: string;
      promiseId: string;
      waiverReason: string;
    }): string {
      // 1) waiverReason length check
      if (!args.waiverReason || args.waiverReason.trim().length < 30) {
        throw new Error('waiverReason must be at least 30 characters');
      }

      // 2) Read existing delivery-check.json
      const data = store.readDeliveryCheck(args.storyId);
      if (!data) {
        throw new Error('delivery-check.json not found, run delivery reviewer first');
      }

      // 3) Find matching promise by docPath
      const promise = data.docsPromises.find(p => p.docPath === args.promiseId);
      if (!promise) {
        throw new Error(`promiseId "${args.promiseId}" not found in docsPromises`);
      }

      // 3.5) Verify the existing _hash is valid (prevent laundering the signature by appending a waiver on an already-tampered file)
      const currentExpected = signDeliveryCheck(
        data.storyId,
        data.docsPromises,
        data.realMachineTests,
        data.closingSelfCheck,
        data.reviewRound,
        data.materialHash,
        data.storyFilesHash,
      );
      if (data._hash !== currentExpected) {
        throw new Error('delivery-check.json _hash is invalid (file may have been tampered with), please re-run the lattice-review-delivery reviewer');
      }
      if (!data.materialHash) {
        throw new Error('delivery-check.json is missing materialHash binding, please re-run the lattice-review-delivery reviewer');
      }

      // 4) Set waiverReason
      promise.waiverReason = args.waiverReason.trim();
      promise.status = 'waived';

      // 5) Re-sign (hash changes after docsPromises includes waiverReason)
      data._hash = signDeliveryCheck(
        data.storyId,
        data.docsPromises,
        data.realMachineTests,
        data.closingSelfCheck,
        data.reviewRound,
        data.materialHash,
        data.storyFilesHash,
      );

      // 6) Write back
      store.writeDeliveryCheck(args.storyId, data);

      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'delivery_waiver_add', {
        closeoutArtifactPaths: ['delivery-check.json'],
      });
      return `Waiver added for "${args.promiseId}" in ${args.storyId}: "${args.waiverReason.trim().slice(0, 50)}..."${commitHint}`;
    },

    delivery_check_set(args: {
      storyId: string;
      docsPromises: DocsPromise[];
      realMachineTests: RealMachineTest[];
      closingSelfCheck: ClosingSelfCheck;
      agentId?: string;
    }): string {
      // 1) story existence check
      let reviewRound = '';
      try {
        const story = store.readStory(args.storyId);
        reviewRound = story.currentReviewRound || '';
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }

      // 2) runtime validation
      const docsPromises = Array.isArray(args.docsPromises) ? args.docsPromises.map(p => ({ ...p })) : [];
      const realMachineTests = Array.isArray(args.realMachineTests) ? args.realMachineTests : [];
      const closingSelfCheck = args.closingSelfCheck;

      if (!closingSelfCheck || typeof closingSelfCheck.summary !== 'string' || closingSelfCheck.summary.trim().length < 10) {
        throw new Error('delivery_check_set: closingSelfCheck.summary must be ≥ 10 characters');
      }

      const liveSmokeTranscript = evaluateOptionalLiveSmokeTranscript(store, args.storyId);
      if (!liveSmokeTranscript.ok) {
        throw new Error(`delivery_check_set: ${liveSmokeTranscript.reason}; re-run live_smoke_transcript with a passing command and --write`);
      }

      for (const promise of docsPromises) {
        if (promise.status === 'met' || promise.status === 'verified') {
          promise.verifiedBy = promise.verifiedBy || `status:${promise.status}`;
        } else if (promise.status === 'waived') {
          if (!promise.waiverReason || promise.waiverReason.trim().length < 30) {
            throw new Error(
              `delivery_check_set: when docsPromises status=waived, waiverReason must be ≥ 30 characters (docPath: ${promise.docPath})`,
            );
          }
        }
      }

      // waiverReason validation: when non-empty, must be ≥ 30 characters
      for (const test of realMachineTests) {
        if (test.waiverReason && test.waiverReason.trim().length < 30) {
          throw new Error(
            `delivery_check_set: when waiverReason is non-empty, it must be ≥ 30 characters (featureId: ${test.featureId})`,
          );
        }
      }

      // 3) compute current material binding and signature
      const gitCwd = resolveGitCwd({
        store,
        storyId: args.storyId,
        metadataRoot: root,
        projectRoot: root,
      });
      const headHash = currentGitHead(gitCwd);
      if (!headHash) {
        throw new Error('delivery_check_set: unable to compute current headHash for audit metadata');
      }
      const materialHash = currentMaterialHash(gitCwd, 'HEAD', root);
      if (!materialHash) {
        throw new Error('delivery_check_set: unable to compute current materialHash for freshness binding');
      }
      // storyFilesHash: secondary freshness signal over the story-owned diff vs main.
      // Signed so the DONE-gate drift-advisory downgrade keyed on it is non-forgeable.
      // Undefined when HEAD is on main (no story diff) or it cannot be computed —
      // the freshness gate then falls back to strict materialHash.
      //
      // B-d243 (host-2 soundness fix): when there is NO story-owned diff (HEAD ==
      // main, or the story already resolved on main), currentStoryFilesHash
      // returns sha256('') — the EMPTY-set hash, not undefined. A delivery-check
      // signed with that empty-set value vouches for NOTHING, yet under later
      // whole-tree drift with HEAD still empty it would re-match and wrongly fire
      // the drift-advisory downgrade. Treat the empty-set value as no-signal and
      // persist `undefined` so a no-story-diff delivery-check falls back to strict
      // materialHash freshness.
      const rawStoryFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', root);
      const storyFilesHash =
        rawStoryFilesHash && rawStoryFilesHash !== EMPTY_STORY_FILES_HASH ? rawStoryFilesHash : undefined;

      const _hash = signDeliveryCheck(
        args.storyId,
        docsPromises,
        realMachineTests,
        closingSelfCheck,
        reviewRound,
        materialHash,
        storyFilesHash,
      );

      // 4) construct DeliveryCheckData and persist to disk
      const data: DeliveryCheckData = {
        storyId: args.storyId,
        checkedAt: new Date().toISOString(),
        headHash,
        materialHash,
        storyFilesHash,
        reviewRound,
        agentId: args.agentId ?? '',
        docsPromises,
        realMachineTests,
        closingSelfCheck,
        _hash,
      };
      store.writeDeliveryCheck(args.storyId, data);

      // 5) return summary
      const unverified = docsPromises.filter(p => !p.verifiedBy).length;
      const waived = realMachineTests.filter(t => !!t.waiverReason).length;
      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'delivery_check_set', {
        closeoutArtifactPaths: ['delivery-check.json'],
      });
      return `Delivery check saved for ${args.storyId}: ${docsPromises.length} docsPromises (${unverified} unverified), ${realMachineTests.length} realMachineTests (${waived} waived), selfCheck: ${closingSelfCheck.hasRealMachineTest ? 'hasRealMachine' : 'noRealMachine'}${commitHint}`;
    },
  };
}
