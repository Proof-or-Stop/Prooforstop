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

function normalizeOptionalBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * M8: `capability_release_backfill` — bind ALREADY-EXISTING under-bound candidate
 * playbooks to the product capability release recorded for their source story.
 *
 * Default dry-run (default true unless --apply): reads the capability-releases
 * ledger + playbooks, finds candidate playbooks whose lineage.sourceStoryId has a
 * capability release but whose lineage.capabilityReleaseId is absent, and emits a
 * plan + deterministic plan digest. --apply requires --digest to equal the current
 * dry-run planDigest, then enriches exactly the eligible candidates' lineage
 * (capabilityReleaseId/capabilityId/capabilityVersion/artifactReleaseId). It never
 * changes .status, never touches usage.surfacedCount, never appends a
 * playbook-outcome, and never mutates the capability-releases ledger. Idempotent:
 * a re-run finds 0 eligible.
 */
export function createCapabilityReleaseBackfillHandlers(
  ctx: HandlerContext,
): Record<string, (...args: any[]) => any> {
  return {
    capability_release_backfill(args: CapabilityReleaseBackfillArgs = {}): string {
      const apply = normalizeOptionalBoolean(args.apply);
      const dryRunFlag = normalizeOptionalBoolean(args.dryRun);
      if (apply && dryRunFlag) {
        throw new Error('capability_release_backfill: pass either apply or dryRun, not both');
      }
      const report = buildCapabilityReleaseBackfillReport({
        root: ctx.root,
        storyId: args.storyId,
        apply,
        digest: args.digest,
      });
      return renderCapabilityReleaseBackfill(report, args.json);
    },
  };
}
