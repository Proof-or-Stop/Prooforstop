import {
  buildDualRevisionImpactGraph as buildCanonicalDualRevisionImpactGraph,
  verifyStoryChangeManifest,
  type DualRevisionImpactGraph,
  type StoryChangeManifest,
  type StoryChangeResolverInput,
  type StoryChangedFile,
  type ScopeContractData,
  type VerificationIntent,
  type ValidationCatalogEntry,
} from './story-aware-validation.js';
import { buildStoryChangeManifest } from './story-change-resolver.js';

export * from './story-aware-validation.js';

export interface BoundDualRevisionImpactGraphArgs {
  gitCwd: string;
  baseHead: string;
  head: string;
  catalog?: ValidationCatalogEntry[];
  storyId: string;
  changeManifest: StoryChangeManifest;
  scopeContract?: ScopeContractData;
  verificationIntents?: VerificationIntent[];
  changedFiles?: StoryChangedFile[];
  affectedProcessFacts?: string[];
  affectedCapabilities?: string[];
}

/**
 * Compatibility entrypoint with an explicit producer binding. The graph is
 * only built after it recomputes the canonical Story change manifest and
 * verifies that the caller supplied the same signed payload. This keeps the
 * planned resolver→graph path real while preserving the pure core graph API.
 */
export function buildDualRevisionImpactGraph(args: BoundDualRevisionImpactGraphArgs): DualRevisionImpactGraph {
  const recomputed = buildStoryChangeManifest({
    storyId: args.storyId,
    gitCwd: args.gitCwd,
    baseHead: args.baseHead,
    head: args.head,
    scopeContract: args.scopeContract,
    verificationIntents: args.verificationIntents,
    changedFiles: args.changedFiles,
    affectedProcessFacts: args.affectedProcessFacts,
    affectedCapabilities: args.affectedCapabilities,
  } satisfies StoryChangeResolverInput);
  if (!verifyStoryChangeManifest(args.changeManifest)
    || args.changeManifest.storyId !== args.storyId
    || args.changeManifest.baseHead !== args.baseHead
    || args.changeManifest.head !== args.head
    || args.changeManifest.changeDigest !== recomputed.changeDigest) {
    throw new Error('dual-revision graph refused a Story change manifest that does not match the current base/HEAD inputs');
  }
  return buildCanonicalDualRevisionImpactGraph(args);
}
