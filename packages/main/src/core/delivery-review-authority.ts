import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import { agentRoleIdsEqual } from './agent-role-identity.js';
import { getSessionIdentity } from './owner-session.js';
import { domainSeparatedDigest, reviewerDispatchPromptDigest } from './prompt-contracts.js';
import { reviewerHostRenderIdentity, resolvePromptEnvelopeRolloutMode } from './prompt-role-contract-registry.js';
import { loadConfig } from './config.js';
import { issueNativeReviewEvidenceBinding, type NativeReviewDispatchAuthority } from './native-review-evidence.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';
import type { StoryStore } from './store.js';

export const DELIVERY_REVIEW_LANE = 'lattice-review-delivery' as const;

export interface VerifiedDeliveryReviewDispatch {
  invocationId: string;
  dispatch: NativeReviewDispatchAuthority;
}

export function deliveryReviewDispatchBindingDigest(value: {
  storyId: string;
  lane: typeof DELIVERY_REVIEW_LANE;
  dispatchPromptDigest: string;
  hostRenderIdentityDigest: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string | null;
}): string {
  return domainSeparatedDigest('delivery-review-dispatch-binding.v1', value);
}

export function deliveryReviewInvocationId(storyId: string, dispatchBindingDigest: string): string {
  return `${storyId}:DELIVERY:${dispatchBindingDigest}`;
}

/** Verify the latest native delivery dispatch against the exact current tree. */
export function verifyCurrentDeliveryReviewDispatch(args: {
  store: StoryStore;
  storyId: string;
  projectRoot: string;
}): { ok: true; binding: VerifiedDeliveryReviewDispatch } | { ok: false; reason: string } {
  const event = [...args.store.readProcessEvents(args.storyId)].reverse().find(candidate =>
    candidate.type === 'dispatch'
    && candidate.targetKind === 'delivery-review'
    // B-137a main-merge fix: dispatch records the CANONICAL agentType
    // (`proof-or-stop-review-delivery`), while DELIVERY_REVIEW_LANE is the
    // retired alias. A literal comparison therefore never matched any recorded
    // dispatch, so every delivery-review provenance check reported "no trusted
    // delivery-review dispatch event exists" -- breaking the TEST->DONE
    // delivery gate. Compare through the canonical role identity so both
    // spellings resolve to the same lane.
    && agentRoleIdsEqual(String(candidate.agentType ?? ''), DELIVERY_REVIEW_LANE));
  if (!event) return { ok: false, reason: 'no trusted delivery-review dispatch event exists' };
  const hostRenderHost = event.hostRenderHost;
  if (hostRenderHost !== 'codex' && hostRenderHost !== 'claude') {
    return { ok: false, reason: 'delivery-review dispatch is missing a supported host render identity' };
  }
  const dispatchPrompt = typeof event.dispatchPrompt === 'string' ? event.dispatchPrompt : '';
  const dispatchPromptDigest = typeof event.dispatchPromptDigest === 'string' ? event.dispatchPromptDigest : '';
  const hostRenderIdentityDigest = typeof event.hostRenderIdentityDigest === 'string'
    ? event.hostRenderIdentityDigest
    : '';
  const dispatchBindingDigest = typeof event.dispatchBindingDigest === 'string' ? event.dispatchBindingDigest : '';
  if (!dispatchPrompt || dispatchPromptDigest !== reviewerDispatchPromptDigest(dispatchPrompt)) {
    return { ok: false, reason: 'delivery-review dispatch prompt bytes or digest are missing or tampered' };
  }
  let hostIdentity;
  try {
    hostIdentity = reviewerHostRenderIdentity(
      args.projectRoot,
      DELIVERY_REVIEW_LANE,
      hostRenderHost,
      resolvePromptEnvelopeRolloutMode(DELIVERY_REVIEW_LANE, loadConfig(args.projectRoot).promptEnvelope),
    );
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (hostIdentity.identityDigest !== hostRenderIdentityDigest) {
    return { ok: false, reason: 'delivery-review host render identity is stale or tampered' };
  }
  const gitCwd = resolveGitCwd({
    store: args.store,
    storyId: args.storyId,
    metadataRoot: args.projectRoot,
    projectRoot: args.projectRoot,
  });
  const headHash = currentGitHead(gitCwd);
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', args.projectRoot);
  if (!headHash || !materialHash) {
    return { ok: false, reason: 'delivery-review dispatch current git binding cannot be computed' };
  }
  const rawStoryFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', args.projectRoot);
  const storyFilesHash = rawStoryFilesHash ?? null;
  if (event.headHash !== headHash || event.materialHash !== materialHash
    || (typeof event.storyFilesHash === 'string' ? event.storyFilesHash : null) !== storyFilesHash) {
    return {
      ok: false,
      reason: `delivery-review dispatch is stale for the current head/material/story files `
        + `(head=${String(event.headHash)}/${headHash}, material=${String(event.materialHash)}/${materialHash}, `
        + `storyFiles=${String(event.storyFilesHash ?? null)}/${String(storyFilesHash)})`,
    };
  }
  const expectedBindingDigest = deliveryReviewDispatchBindingDigest({
    storyId: args.storyId,
    lane: DELIVERY_REVIEW_LANE,
    dispatchPromptDigest,
    hostRenderIdentityDigest,
    headHash,
    materialHash,
    storyFilesHash,
  });
  if (dispatchBindingDigest !== expectedBindingDigest) {
    return { ok: false, reason: 'delivery-review dispatch binding digest is missing or tampered' };
  }
  return {
    ok: true,
    binding: {
      invocationId: deliveryReviewInvocationId(args.storyId, dispatchBindingDigest),
      dispatch: {
        hostRenderHost,
        dispatchPromptDigest,
        hostRenderIdentityDigest,
        dispatchBindingDigest,
      },
    },
  };
}

/** Consume one broker-issued capability immediately before delivery evidence persistence. */
export function authorizeNativeDeliveryReview(args: {
  store: StoryStore;
  storyId: string;
  projectRoot: string;
}): import('./types.js').NativeReviewEvidenceBinding {
  const verified = verifyCurrentDeliveryReviewDispatch(args);
  if (!verified.ok) {
    throw new Error(`delivery_check_set has no trusted delivery-review dispatch provenance: ${verified.reason}`);
  }
  return issueNativeReviewEvidenceBinding({
    projectRoot: args.projectRoot,
    storyId: args.storyId,
    agent: DELIVERY_REVIEW_LANE,
    lane: DELIVERY_REVIEW_LANE,
    reviewRunId: verified.binding.invocationId,
    identity: getSessionIdentity(),
    dispatch: verified.binding.dispatch,
  });
}
