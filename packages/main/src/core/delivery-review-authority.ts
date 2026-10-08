import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
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

/**
 * Old-PoS run 27 (B-c562 §4): the Story-metadata publishers that may commit
 * between a delivery-review dispatch and its delivery_check_set without
 * changing anything the delivery reviewer reads, each with the exact Story
 * artifacts it may touch. The reviewer reads the Story diff (material and story
 * files, both re-checked as hashes), the live-smoke transcript, the checklist,
 * plan, candidate route and delivery context pack; it is fenced off from
 * process-events, the owner's claims (summary.json) and other reviewers'
 * results (agents/proof-or-stop-review-delivery.md §1). N1 overlaps exactly
 * these writers with the live reviewer (next-driver testNext): the TEST
 * authoring (summary_set) and the review-assurance bookkeeping (quorum-submit,
 * autopilot_review_submit host verdicts, escalation fallback/policy, host
 * probe), plus the Codex command-terminal row any of them appends;
 * delivery_check_set is the reviewer's own re-seal (run 14). Any other subject, artifact, merge or rewrite of an
 * append-only journal keeps the dispatch stale (tests/bookkeeping-subject-lineage
 * classifies every TEST-phase writer against this table).
 */
const DELIVERY_NEUTRAL_BOOKKEEPING = ['process-events.jsonl', 'process-metrics.json', 'prompt-envelopes.json', 'closeout-write-receipts.jsonl'] as const;
export const DELIVERY_REVIEW_NEUTRAL_PUBLISHERS: Readonly<Record<string, readonly string[]>> = {
  delivery_check_set: [...DELIVERY_NEUTRAL_BOOKKEEPING, 'delivery-check.json'],
  summary_set: [...DELIVERY_NEUTRAL_BOOKKEEPING, 'summary.json'],
  'quorum-submit': DELIVERY_NEUTRAL_BOOKKEEPING,
  autopilot_review_submit: ['process-events.jsonl'],
  'codex-command-terminal': ['process-events.jsonl'],
  review_escalation_fallback_set: DELIVERY_NEUTRAL_BOOKKEEPING,
  review_escalation_policy_set: DELIVERY_NEUTRAL_BOOKKEEPING,
  review_host_availability_probe: DELIVERY_NEUTRAL_BOOKKEEPING,
};
/** Append-only journals: a neutral commit may only append to them. */
const APPEND_ONLY_ARTIFACTS = new Set(['process-events.jsonl', 'closeout-write-receipts.jsonl']);
const PROMPT_BODY_ARTIFACT = /^prompt-bodies\/[a-f0-9]{64}\.txt$/;

/**
 * Why HEAD drift since the dispatch head is NOT neutral for the delivery
 * reviewer, or null when every commit in dispatchHead..HEAD (HEAD descends from
 * it) is a single-parent commit of this Story by a DELIVERY_REVIEW_NEUTRAL_PUBLISHERS
 * subject that touches only that publisher's Story artifacts (append-only
 * journals only appended). The caller separately requires equal material and
 * story-files hashes.
 */
export function deliveryDispatchDriftRefusal(args: { gitCwd: string; store: Pick<StoryStore, 'storyDirPath'>; storyId: string; dispatchHead: string }): string | null {
  const { gitCwd, storyId, dispatchHead } = args;
  const git = (argv: string[]): string => execFileSync('git', argv, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  try {
    try { execFileSync('git', ['merge-base', '--is-ancestor', dispatchHead, 'HEAD'], { cwd: gitCwd, stdio: 'ignore' }); }
    catch { return `HEAD does not descend from the dispatch head ${dispatchHead.slice(0, 12)}`; }
    const prefix = relative(realpathSync(gitCwd), realpathSync(args.store.storyDirPath(storyId))).replaceAll('\\', '/') + '/';
    if (prefix.startsWith('../') || prefix.startsWith('/')) return 'the Story directory is outside the Git workspace';
    const commits = git(['rev-list', '--reverse', '--ancestry-path', `${dispatchHead}..HEAD`]).split('\n').filter(Boolean);
    if (!commits.length) return 'no commit since the dispatch head';
    for (const commit of commits) {
      const short = commit.slice(0, 12);
      const parents = git(['show', '-s', '--format=%P', commit]).trim().split(/\s+/).filter(Boolean);
      if (parents.length !== 1) return `commit ${short} is not a single-parent commit`;
      const subject = git(['show', '-s', '--format=%s', commit]).trim();
      const publisher = Object.keys(DELIVERY_REVIEW_NEUTRAL_PUBLISHERS).find(name =>
        subject === `proof-or-stop: record ${storyId} ${name} metadata`);
      if (!publisher) return `commit ${short} (${subject.slice(0, 80)}) is not a delivery-neutral Story metadata publisher`;
      const allowed = new Set(DELIVERY_REVIEW_NEUTRAL_PUBLISHERS[publisher]);
      const paths = git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).split('\n').filter(Boolean);
      for (const path of paths) {
        const artifact = path.startsWith(prefix) ? path.slice(prefix.length) : null;
        if (artifact === null || !(allowed.has(artifact) || PROMPT_BODY_ARTIFACT.test(artifact))) {
          return `commit ${short} (${publisher}) changes ${path}, outside that publisher's delivery-neutral Story artifacts`;
        }
        if (APPEND_ONLY_ARTIFACTS.has(artifact)) {
          let before = '';
          try { before = git(['show', `${parents[0]}:${path}`]); } catch { before = ''; }
          let after = '';
          try { after = git(['show', `${commit}:${path}`]); } catch { return `commit ${short} (${publisher}) deletes ${artifact}`; }
          if (!after.startsWith(before)) return `commit ${short} (${publisher}) rewrites the append-only ${artifact}`;
        }
      }
    }
    return null;
  } catch (error) {
    return `the drift since the dispatch head cannot be classified (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`;
  }
}

export function verifyCurrentDeliveryReviewDispatch(args: {
  store: StoryStore;
  storyId: string;
  projectRoot: string;
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
  // HEAD may have moved since the dispatch by commits that change nothing the
  // delivery reviewer reads (deliveryDispatchDriftRefusal): its own re-seal
  // (run 14: an early write moved HEAD by its own metadata commit) and the N1
  // overlap's TEST bookkeeping (run 27: summary_set, quorum-submit). Only with
  // unchanged material and story files; the binding stays the dispatch's own head.
  const drift = event.headHash !== headHash && sameMaterial && typeof event.headHash === 'string'
    ? deliveryDispatchDriftRefusal({ gitCwd, store: args.store, storyId: args.storyId, dispatchHead: event.headHash })
    : undefined;
  const boundHead = drift === null ? event.headHash as string : headHash;
  if (event.headHash !== boundHead || !sameMaterial) {
    return {
      ok: false,
      reason: `delivery-review dispatch is stale for the current head/material/story files `
        + `(head=${String(event.headHash)}/${headHash}, material=${String(event.materialHash)}/${materialHash}, `
        + `storyFiles=${String(event.storyFilesHash ?? null)}/${String(storyFilesHash)})${drift ? `: ${drift}` : ''}`,
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
