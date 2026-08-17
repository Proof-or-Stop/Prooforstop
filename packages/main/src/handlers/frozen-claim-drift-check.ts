/**
 * B-2296 CHK-003 (evidence-integrity §5 follow-on, Phase 1 of 2) — read-only,
 * NON-blocking FROZEN_CLAIM_DRIFT advisory surface.
 *
 * `proof-or-stop frozen_claim_drift_check --storyId=B-xxx [--json]` reads a story's
 * checklist and, for every item carrying a non-empty `userSees`, compares the
 * item's frozen {@link FrozenClaimSnapshot} (pinned once at the CHK-002
 * status→done attestation) against the CURRENT normalized claim digest + the
 * CURRENT story-owned material hash (storyFilesHash, the drift-authoritative
 * field per decision B). It reports:
 *   - `driftKind !== 'none'` — the claim text and/or the story-owned material
 *     moved since attestation, OR
 *   - `classification === 'legacy-unbound'` — a pre-feature userSees with no
 *     snapshot to drift against (grandfathered, NEVER an error).
 *
 * STRICTLY read-only + NON-blocking: writes no files/evidence, mutates nothing,
 * and ALWAYS returns normally (exit 0) even when drift or legacy-unbound is
 * present. It touches NO gate verdict (no canPassReview / delivery / DONE edits).
 * The blocking gate is Phase 2; Phase 1 only ever asks for `re_attestation`.
 *
 * To keep the advisory-assembly deterministically testable WITHOUT spawning a
 * process, the pure {@link buildDriftReport} helper is exported: it takes the
 * already-read checklist items + the ONCE-computed currentStoryFilesHash and
 * returns the advisory array with no I/O.
 */

import type { HandlerContext } from './context.js';
import type { ChecklistItem, FrozenClaimDriftAdvisory } from '../core/types.js';
import { claimDigest, detectDrift } from '../core/frozen-claim-drift.js';
import { currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';

/**
 * PURE Fn — no I/O, no git, no fs. Given the story's checklist items and the
 * story's ONCE-computed current storyFilesHash, assemble the FROZEN_CLAIM_DRIFT
 * advisory array.
 *
 * For each item with a non-empty `userSees`, compute the current normalized
 * claim digest and ask {@link detectDrift} for a bidirectional verdict against
 * the item's frozen snapshot. The item is INCLUDED in the report iff drift is
 * present (`driftKind !== 'none'`) OR it is `legacy-unbound` (no snapshot). A
 * clean, snapshot-bound, un-drifted item is omitted.
 *
 * The same `currentStoryFilesHash` is reused for every item (apples-to-apples
 * with CHK-002's capture hook, which pins one storyFilesHash per attestation),
 * so it is computed ONCE by the caller and passed in here.
 */
export function buildDriftReport(
  items: readonly ChecklistItem[],
  currentStoryFilesHashValue: string,
): FrozenClaimDriftAdvisory[] {
  const advisories: FrozenClaimDriftAdvisory[] = [];
  for (const item of items) {
    const userSees = item.userSees;
    if (!userSees || userSees.trim().length === 0) continue; // no frozen claim to check
    const currentNormalizedDigest = claimDigest(userSees);
    const snapshot = item.userSeesSnapshot;
    const verdict = detectDrift(snapshot, {
      currentNormalizedDigest,
      currentStoryFilesHash: currentStoryFilesHashValue,
    });
    // Report only drift or legacy-unbound; a clean bound item is silent.
    if (verdict.driftKind === 'none' && verdict.classification !== 'legacy-unbound') continue;
    advisories.push({
      code: 'FROZEN_CLAIM_DRIFT',
      itemId: item.id,
      claimRef: `${item.id}:userSees`,
      previousDigest: snapshot?.normalizedClaimDigest ?? '',
      currentDigest: currentNormalizedDigest,
      previousStoryFilesHash: snapshot?.storyFilesHash ?? '',
      currentStoryFilesHash: currentStoryFilesHashValue,
      driftKind: verdict.driftKind,
      classification: verdict.classification,
      actionRequired: 're_attestation',
    });
  }
  return advisories;
}

/** Count drifted (driftKind !== 'none') advisories. */
function countDrifted(advisories: readonly FrozenClaimDriftAdvisory[]): number {
  return advisories.filter((a) => a.driftKind !== 'none').length;
}

/** Count legacy-unbound (no snapshot) advisories. */
function countLegacyUnbound(advisories: readonly FrozenClaimDriftAdvisory[]): number {
  return advisories.filter((a) => a.classification === 'legacy-unbound').length;
}

export function createFrozenClaimDriftCheckHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;
  // Same gitCwd resolution primitive CHK-002's capture hook uses, so the
  // current-vs-snapshot storyFilesHash compare is apples-to-apples.
  const resolveStoryGitCwd = (storyId: string): string =>
    resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });

  return {
    frozen_claim_drift_check(args: { storyId: string; json?: boolean }): string {
      // Runtime-revalidate every constraint at the handler entry (CLAUDE.md
      // "Handler 编码约定": Zod is the first line only; each consuming path
      // re-checks). storyId must be a non-empty string; json is optional bool.
      if (typeof args.storyId !== 'string' || args.storyId.trim().length === 0) {
        throw new Error('frozen_claim_drift_check: storyId is required (non-empty string)');
      }
      if (args.json !== undefined && typeof args.json !== 'boolean') {
        throw new Error('frozen_claim_drift_check: json must be a boolean when provided');
      }
      const storyId = args.storyId;

      // Compute the story-owned material hash ONCE per invocation and reuse it
      // for every item. `?? ''` keeps the compare a plain string equality even
      // when git cannot produce a hash (non-git / detached probe): an empty
      // current hash vs a pinned non-empty snapshot hash reads as material drift
      // (never a throw), matching CHK-002's skip-rather-than-pin-partial policy.
      const gitCwd = resolveStoryGitCwd(storyId);
      const currentStoryFilesHashValue = currentStoryFilesHash(gitCwd, 'HEAD', root) ?? '';

      // Read-only: read the checklist, assemble the advisory, write nothing.
      const cl = store.readChecklist(storyId);
      const advisories = buildDriftReport(cl.items, currentStoryFilesHashValue);
      const drifted = countDrifted(advisories);
      const legacyUnbound = countLegacyUnbound(advisories);

      if (args.json) {
        return JSON.stringify(
          {
            storyId,
            code: 'FROZEN_CLAIM_DRIFT',
            blocking: false,
            advisories,
            summary: {
              drifted,
              legacyUnbound,
              total: advisories.length,
              blocking: false,
              actionRequired: advisories.length > 0 ? 're_attestation' : 'none',
            },
          },
          null,
          2,
        );
      }

      if (advisories.length === 0) {
        return `FROZEN_CLAIM_DRIFT advisory for ${storyId}: 0 drifted, 0 legacy-unbound -- clean`;
      }

      const lines: string[] = [
        `FROZEN_CLAIM_DRIFT advisory for ${storyId} (${drifted} drifted, ${legacyUnbound} legacy-unbound, non-blocking)`,
      ];
      for (const a of advisories) {
        const detail = a.classification === 'legacy-unbound'
          ? 'classification=legacy-unbound'
          : `driftKind=${a.driftKind}`;
        lines.push(`  ${a.itemId} ${detail} actionRequired=${a.actionRequired}`);
      }
      return lines.join('\n');
    },
  };
}
