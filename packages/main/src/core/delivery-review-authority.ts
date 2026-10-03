import { execFileSync } from 'node:child_process';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import { agentRoleIdsEqual } from './agent-role-identity.js';
import { getSessionIdentity } from './owner-session.js';
import { domainSeparatedDigest, reviewerDispatchPromptDigest } from './prompt-contracts.js';
import { reviewerHostRenderIdentity, resolvePromptEnvelopeRolloutMode } from './prompt-role-contract-registry.js';
import { loadConfig } from './config.js';
import { issueNativeReviewEvidenceBinding, type NativeReviewDispatchAuthority } from './native-review-evidence.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';
import type { StoryStore } from './store.js';

export const DELIVERY_REVIEW_LANE = 'proof-or-stop-review-delivery' as const;

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
/** Commits in dispatchHead..HEAD are all this Story's delivery_check_set metadata commits (HEAD descends from dispatchHead). */
function onlyOwnDeliveryCheckCommitsSince(gitCwd: string, dispatchHead: string, storyId: string): boolean {
  try {
    const subjects = execFileSync('git', ['log', '--format=%s', '--ancestry-path', `${dispatchHead}..HEAD`], {
      cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').filter(Boolean);
    execFileSync('git', ['merge-base', '--is-ancestor', dispatchHead, 'HEAD'], { cwd: gitCwd, stdio: 'ignore' });
    const own = `proof-or-stop: record ${storyId} delivery_check_set metadata`;
    return subjects.length > 0 && subjects.every(subject => subject === own);
  } catch {
    return false;
  }
}

export function verifyCurrentDeliveryReviewDispatch(args: {
  store: StoryStore;
  storyId: string;
  projectRoot: string;
  /** Managed delivery re-seal: tolerate HEAD drift made only of this Story's delivery_check_set commits. */
  allowOwnDeliveryCheckCommits?: boolean;
}): { ok: true; binding: VerifiedDeliveryReviewDispatch } | { ok: false; reason: string } {
  const event = [...args.store.readProcessEvents(args.storyId)].reverse().find(candidate =>
    candidate.type === 'dispatch'
    && candidate.targetKind === 'delivery-review'
    // Active dispatch identity must resolve to the registered canonical lane.
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
  const sameMaterial = event.materialHash === materialHash
    && (typeof event.storyFilesHash === 'string' ? event.storyFilesHash : null) === storyFilesHash;
  // A managed delivery reviewer may re-seal its delivery-check (run 14: an early
  // write moved HEAD by its own metadata commit and the real seal was refused as
  // stale). Only HEAD drift made exclusively of delivery_check_set metadata
  // commits of this Story, on top of the dispatch head, with unchanged material
  // and story files, is tolerated; the binding stays the dispatch's own head.
  const boundHead = event.headHash !== headHash && sameMaterial && args.allowOwnDeliveryCheckCommits === true
    && typeof event.headHash === 'string'
    && onlyOwnDeliveryCheckCommitsSince(gitCwd, event.headHash, args.storyId)
    ? event.headHash
    : headHash;
  if (event.headHash !== boundHead || !sameMaterial) {
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
    headHash: boundHead,
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
