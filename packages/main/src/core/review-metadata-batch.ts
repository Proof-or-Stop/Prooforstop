import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { StoryStore } from './store.js';
import { autoCommitStoryMetadata } from './auto-commit-metadata.js';
import { currentOpenReviewInventory, assertReviewInventoryEvidenceWritable, inventoryPurposeMatchesEpoch } from './review-inventory-epoch.js';
import { verifyReviewRun } from './review-run.js';
import { canonicalAgentRoleId } from './agent-role-identity.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';
import { commitImmutableMetadataTree } from './done-prepare-generated-metadata.js';
import { rawArtifactDigest } from './closeout-trust.js';
import { readPromptBody } from './prompt-body-store.js';

/** Exact review storage surface; never sweep unrelated staged files or Story authoring. */
export const REVIEW_EPOCH_COMMIT_ARTIFACTS = [
  'review-runs.json', 'prompt-envelopes.json', 'review-passes.json',
  'findings.json', 'finding-ledger.json', 'review-inventory-epochs.json',
  'convergence-progress.json', 'process-events.jsonl', 'process-metrics.json',
] as const;

/** Called only after individual signed results have passed durable readback. */
export function commitReviewResultMetadata(args: {
  root: string; store: StoryStore; storyId: string; reviewRunId?: string; reason: string;
  options?: Parameters<typeof autoCommitStoryMetadata>[3];
}): string {
  if (args.reviewRunId) {
    const epoch = currentOpenReviewInventory(args.store, args.storyId);
    const run = args.store.readReviewRuns(args.storyId).runs.find(row => row.reviewRunId === args.reviewRunId);
    if (epoch && run && verifyReviewRun(run) && run.reviewRound === epoch.reviewRound
      && run.materialHash === epoch.cutoff.materialHash
      && (run.storyFilesHash ?? '') === (epoch.cutoff.storyFilesHash ?? '')
      && (epoch.requiredLanes.includes(canonicalAgentRoleId(run.lane))
        || (run.reviewPurpose === 'inventory-completeness' && inventoryPurposeMatchesEpoch(run.inventoryBinding, epoch)))) {
      assertReviewInventoryEvidenceWritable(args.store, args.storyId, run);
      return `\nReview result durably recorded; Git metadata commit deferred to epoch ${epoch.epochId} finalize/cancel.`;
    }
  }
  return autoCommitStoryMetadata(args.root, args.storyId, args.reason, args.options);
}

/** Caller holds the inventory mutation lock. Retrying commits the same durable results, never reruns reviewers. */
export function commitReviewEpochMetadata(store: StoryStore, root: string, storyId: string, retryCommand: 'review_inventory_finalize' | 'review_inventory_finalize --remediation' | 'review_inventory_cancel' = 'review_inventory_finalize'): string {
  const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
  if (!gitCwd) return '';
  const git = (args: string[]) => execFileSync('git', args, { cwd: gitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  // Preserve standalone/synthetic non-Story compatibility. The production
  // auto-commit contract applies to story/* branches only.
  let branch: string;
  try { branch = git(['branch', '--show-current']).trim(); } catch { return ''; }
  if (!branch.startsWith('story/')) return '';
  const storyDir = realpathSync(store.storyDirPath(storyId));
  const storyRel = relative(realpathSync(gitCwd), storyDir).replace(/\\/g, '/');
  if (!storyRel || isAbsolute(storyRel) || storyRel === '..' || storyRel.startsWith('../')) throw new Error('review epoch metadata is outside its Git workspace');
  const names: string[] = [...REVIEW_EPOCH_COMMIT_ARTIFACTS];
  for (const run of store.readReviewRuns(storyId).runs) {
    if (run.assembledPromptRef === undefined) continue;
    if (!verifyReviewRun(run) || run.storyId !== storyId) throw new Error('review epoch commit refuses an invalid prompt reference');
    readPromptBody(storyDir, run.assembledPromptRef);
    names.push(`prompt-bodies/${run.assembledPromptRef}.txt`);
  }
  const paths = [...new Set(names)].filter(name => existsSync(join(storyDir, name))).map(name => {
    const stat = lstatSync(join(storyDir, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`review epoch commit requires a regular artifact: ${name}`);
    return `${storyRel}/${name}`;
  });
  const changed = new Set([
    ...git(['diff', '--name-only', '-z', 'HEAD', '--', ...paths]).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]).split('\0'),
  ].filter(Boolean));
  const pending = paths.filter(path => changed.has(path));
  if (!pending.some(path => !['process-events.jsonl', 'process-metrics.json'].some(name => path === `${storyRel}/${name}`))) return ''; // CLI telemetry alone never creates another epoch commit.
  const committed = commitImmutableMetadataTree({
    root: gitCwd, gitCwd, paths: pending,
    verifiedHashes: new Map(pending.map(path => [path, rawArtifactDigest(readFileSync(join(gitCwd, path)))])),
    message: `proof-or-stop: record ${storyId} review epoch metadata`,
  });
  if (!committed.ok) throw new Error(`REVIEW_EPOCH_COMMIT_PENDING: ${committed.reason}; results remain durable; retry ${retryCommand} without redispatch`);
  return `\nReview epoch metadata committed (${committed.commitSha}); individual signatures preserved.`;
}
