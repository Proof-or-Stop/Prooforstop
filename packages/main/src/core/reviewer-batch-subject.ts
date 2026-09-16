import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StoryStore } from './store.js';
import { loadConfig } from './config.js';
import { captureReviewRunSnapshot, verifyReviewRun } from './review-run.js';
import { currentOpenReviewInventory, inventoryPurposeMatchesEpoch, reviewInventoryPurposeBinding, reviewInventoryDigest, verifyReviewInventoryEpoch } from './review-inventory-epoch.js';
import { resolveStoryCommandWorkspace } from '../handlers/context.js';
import { captureReviewInventoryScope } from '../handlers/review-inventory.js';
import type { ReviewerBatchAssignment } from './reviewer-batch-admission.js';

const INVENTORY_CRITIC_LANE = 'proof-or-stop-review-topology-critic';

/** Equal content is insufficient: preserve the signed root's real Git lineage. */
function criticHeadLineage(root: string, cutoffHead: string, runHead: string):
  { state: 'descendant' | 'divergent' } | { state: 'unverifiable'; diagnostic: string } {
  const timeoutMs = 5000;
  const started = Date.now();
  const unavailable = (reason: string) => ({ state: 'unverifiable' as const,
    diagnostic: `timeoutMs=${timeoutMs}; elapsedMs=${Date.now() - started}; ${reason}` });
  const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  if (!oid.test(cutoffHead) || !oid.test(runHead)) return unavailable('malformed commit identity');
  // Do not let ambient Git redirection or replacement history override signedRoot.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_GRAFT_FILE = devNull;
  const result = spawnSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', cutoffHead, runHead], {
    cwd: root, env, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024,
  });
  if (!result.error && !result.signal && result.status === 0) return { state: 'descendant' };
  if (!result.error && !result.signal && result.status === 1) return { state: 'divergent' };
  return unavailable(`code=${(result.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'}; status=${result.status}; signal=${result.signal}; stderr=${(result.stderr ?? '').trim().slice(0, 2000)}`);
}

export function reviewerBatchAdmissionLanes(requiredLanes: readonly string[], includeInventoryCritic: boolean): string[] {
  const lanes = [...requiredLanes];
  if (includeInventoryCritic && !lanes.includes(INVENTORY_CRITIC_LANE)) lanes.push(INVENTORY_CRITIC_LANE);
  return lanes;
}

/** Read-only: never call assertReviewInventoryCutoff or refresh...Locked, which persist invalidation. */
export function deriveReviewerBatchSubject(store: StoryStore, root: string, args: { storyId: string; epochId?: string; wave?: number }) {
  const fail = (code: string): never => { throw new Error(`${code}; Next: proof-or-stop review_inventory_begin --storyId=${args.storyId}`); };
  const story = store.readStory(args.storyId);
  if (story.phase !== 'REVIEW' || !story.currentReviewRound) fail('BATCH_SUBJECT_REQUIRES_CURRENT_REVIEW');
  const epoch = currentOpenReviewInventory(store, args.storyId);
  if (!epoch || !verifyReviewInventoryEpoch(epoch) || epoch.storyId !== args.storyId
    || store.readReviewInventoryEpochs(args.storyId).epochs.at(-1)?.epochId !== epoch.epochId
    || epoch.reviewRound !== story.currentReviewRound) fail('BATCH_SUBJECT_REQUIRES_SIGNED_CURRENT_OPEN_EPOCH');
  if (!epoch) throw new Error('unreachable');
  const binding = reviewInventoryPurposeBinding(epoch);
  if ((args.epochId !== undefined && args.epochId !== epoch.epochId) || (args.wave !== undefined && args.wave !== binding.wave)) fail('BATCH_SUBJECT_REQUEST_MISMATCH');
  const workspace = resolveStoryCommandWorkspace(store, args.storyId, root);
  const signedRoot = workspace.signedWorkspaceRoot || workspace.snapshotRoot;
  if (!signedRoot) fail('BATCH_SUBJECT_WORKSPACE_UNKNOWN');
  const metadataRoot = workspace.metadataRoot || root;
  const snapshot = captureReviewRunSnapshot(signedRoot!, { storyId: args.storyId, storyPhase: story.phase, currentReviewRound: story.currentReviewRound }, metadataRoot);
  const scope = captureReviewInventoryScope({ store, root: metadataRoot, scanRoot: resolve(metadataRoot, loadConfig(metadataRoot).scanRoot) }, args.storyId);
  if (snapshot.materialHash !== epoch.cutoff.materialHash || (snapshot.storyFilesHash ?? '') !== (epoch.cutoff.storyFilesHash ?? '')) fail('BATCH_SUBJECT_CUTOFF_DRIFT');
  if (scope.scopeDigest !== epoch.scopeDigest || reviewInventoryDigest(scope.requiredLanes) !== reviewInventoryDigest(epoch.requiredLanes)) fail('BATCH_SUBJECT_SCOPE_OR_ROSTER_DRIFT');
  if (scope.candidateArtifactInvalid || (scope.candidateSpecSetDigest ?? '') !== (epoch.candidateSpecSetDigest ?? '') || (scope.corpusDigest ?? '') !== (epoch.corpusDigest ?? '')) fail('BATCH_SUBJECT_CANDIDATE_DRIFT');
  const after = currentOpenReviewInventory(store, args.storyId);
  const afterStory = store.readStory(args.storyId);
  if (!after || after._hash !== epoch._hash || afterStory.phase !== 'REVIEW' || afterStory.currentReviewRound !== story.currentReviewRound) fail('BATCH_SUBJECT_CHANGED_DURING_CAPTURE');
  // The purpose binding retains the exact original cutoff (including HEAD).
  // A valid new run may start after a metadata-only descendant commit. Keep
  // ancestry as well as material identity; a divergent equal tree is refused.
  const candidates = store.readReviewRuns(args.storyId).runs.filter(run =>
    verifyReviewRun(run, store)
    && run.lane === INVENTORY_CRITIC_LANE
    && run.agent === INVENTORY_CRITIC_LANE
    && run.reviewPurpose === 'inventory-completeness'
    && inventoryPurposeMatchesEpoch(run.inventoryBinding, epoch)
    && run.reviewRound === epoch.reviewRound
    && run.materialHash === epoch.cutoff.materialHash
    && (run.storyFilesHash ?? '') === (epoch.cutoff.storyFilesHash ?? ''),
  );
  const retainsCutoff = (head: string): boolean => {
    const lineage = criticHeadLineage(signedRoot!, epoch.cutoff.headHash, head);
    if (lineage.state === 'unverifiable') {
      throw new Error(`BATCH_SUBJECT_LINEAGE_UNVERIFIABLE; ${lineage.diagnostic}; Repair the Git query environment and retry the same inventory; do not classify this failure as divergence or restart the epoch.`);
    }
    return lineage.state === 'descendant';
  };
  // Ordinary roster derivation needs no Git query when no eligible critic exists.
  const includeInventoryCritic = candidates.length > 0 && retainsCutoff(snapshot.headHash)
    && candidates.some(run => retainsCutoff(run.headHash));
  const requiredLanes = reviewerBatchAdmissionLanes(epoch.requiredLanes, includeInventoryCritic);
  const subject = { schema: 'reviewer-batch-subject.v1', worktreeRoot: realpathSync(signedRoot!), metadataRoot: realpathSync(metadataRoot), binding,
    candidateSpecSetDigest: scope.candidateSpecSetDigest ?? '', corpusDigest: scope.corpusDigest ?? '',
    admissionLanesDigest: reviewInventoryDigest(requiredLanes) };
  return { subjectIdentity: reviewInventoryDigest(subject), subject, requiredLanes };
}

export function validateReviewerBatchAssignments(requiredLanes: readonly string[], assignments: readonly ReviewerBatchAssignment[]): ReviewerBatchAssignment[] {
  if (!requiredLanes.length || new Set(requiredLanes).size !== requiredLanes.length || !Array.isArray(assignments)) throw new Error('BATCH_ROSTER_UNKNOWN');
  const required = new Set(requiredLanes), seen = new Set<string>();
  for (const row of assignments) {
    if (!row || !required.has(row.lane) || seen.has(row.lane)) throw new Error('BATCH_ASSIGNMENT_UNKNOWN_OR_DUPLICATE_LANE');
    if (row.kind === 'native') { if (row.host !== undefined) throw new Error('BATCH_NATIVE_ASSIGNMENT_HAS_MANAGED_HOST'); }
    else if (row.kind !== 'managed' || typeof row.host !== 'string' || !row.host.trim() || row.host !== row.host.trim()) throw new Error('BATCH_MANAGED_ASSIGNMENT_REQUIRES_EXPLICIT_HOST');
    seen.add(row.lane);
  }
  if (seen.size !== required.size) throw new Error('BATCH_ASSIGNMENT_MISSING_LANES');
  return assignments.map(row => ({ ...row })).sort((a, b) => a.lane.localeCompare(b.lane));
}
/** Consumer matches actual requested execution to the owner's frozen assignment; no provider inference. */
export function assertReviewerBatchAssignmentMatch(assignments: readonly ReviewerBatchAssignment[], request: ReviewerBatchAssignment): void {
  const rows = assignments.filter(row => row.lane === request.lane);
  if (rows.length !== 1 || rows[0]!.kind !== request.kind || rows[0]!.host !== request.host) throw new Error('BATCH_MANAGED_HOST_OR_EXECUTION_KIND_MISMATCH');
}
