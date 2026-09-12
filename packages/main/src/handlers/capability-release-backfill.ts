import { maintenanceCommandWrites } from '../core/maintenance-command-mode.js';
import { execFileSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import {
  buildCapabilityReleaseBackfillReport,
  renderCapabilityReleaseBackfill,
} from '../core/capability-release.js';

interface CapabilityReleaseBackfillArgs {
  storyId?: string;
  dryRun?: boolean;
  apply?: boolean;
  digest?: string;
  json?: boolean;
}

/** Plain git runner; used to `git add -f` + commit a backfilled capability release. */
function runGit(gitArgs: string[], cwd: string): string {
  return execFileSync('git', gitArgs, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * M8: `capability_release_backfill` — record-then-bind migration linking existing
 * artifact releases and under-bound candidate playbooks to product capability releases.
 *
 * Default dry-run (default true unless --apply): reads the capability-releases +
 * artifact-releases ledgers and playbooks, finds candidate playbooks whose
 * lineage.sourceStoryId lacks a capabilityReleaseId, and plans one of:
 *   - 'bind': a capability release already exists → bind it;
 *   - 'record-then-bind': the story has an artifact release but no capability release
 *     (it DONE'd before the feature) AND the classifier accepts the artifact paths →
 *     record a capability release, then bind.
 * It emits a plan + deterministic plan digest. --apply requires --digest to equal the
 * current dry-run planDigest, records any missing capability releases (git add -f +
 * commit, mirroring B-8128's DONE-merge ledger commit), then enriches exactly the
 * eligible candidates' lineage (capabilityReleaseId/capabilityId/capabilityVersion/
 * artifactReleaseId). It never changes .status, never touches usage.surfacedCount,
 * and never appends a playbook-outcome. Idempotent: a re-run finds 0 eligible.
 */
export function createCapabilityReleaseBackfillHandlers(
  ctx: HandlerContext,
): Record<string, (...args: any[]) => any> {
  return {
    capability_release_backfill(args: CapabilityReleaseBackfillArgs = {}): string {
      const apply = maintenanceCommandWrites('capability_release_backfill', args);
      const report = buildCapabilityReleaseBackfillReport({
        root: ctx.root,
        storyId: args.storyId,
        apply,
        digest: args.digest,
        runGit,
      });
      return renderCapabilityReleaseBackfill(report, args.json);
    },
  };
}
