/**
 * Adapter boundary for story-aware validation.
 *
 * The adapter constructs a preview/final manifest before the existing complete
 * plan executor is called. It does not run a second command plan; the complete
 * executor remains the oracle in observe and shadow mode.
 */
import { execFileSync } from 'node:child_process';
import {
  discoverValidationInventory,
  compileValidationCatalog,
  buildStoryChangeManifest,
  buildDualRevisionImpactGraph,
  buildDynamicValidationPlan,
  formatDynamicValidationReport,
  createValidationClosureCertificate,
  stableDigest,
  type DynamicValidationContext,
  type ScopeContractData,
  type VerificationIntent,
  type StoryChangedFile,
  type ValidationSelectionManifest,
  type DynamicValidationMode,
  type ValidationRuntimeTrace,
} from '../core/story-aware-validation.js';

export interface PrepareStoryAwareValidationArgs {
  projectRoot: string;
  storyId: string;
  baseHead: string;
  head?: string;
  scopeContract?: ScopeContractData;
  verificationIntents?: VerificationIntent[];
  changedFiles?: StoryChangedFile[];
  affectedProcessFacts?: string[];
  affectedCapabilities?: string[];
  mode?: DynamicValidationMode;
  baselineEpochId?: string;
  buildProofDigest?: string;
  toolchainDigest?: string;
  runtimeTraces?: Map<string, ValidationRuntimeTrace>;
}

function currentHead(projectRoot: string): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

export function prepareStoryAwareValidation(args: PrepareStoryAwareValidationArgs): {
  inventoryDigest: string;
  catalogDigest: string;
  manifest: ValidationSelectionManifest;
  report: string;
} {
  const head = args.head || currentHead(args.projectRoot);
  const inventory = discoverValidationInventory(args.projectRoot);
  const catalog = compileValidationCatalog(inventory);
  const changes = buildStoryChangeManifest({
    storyId: args.storyId,
    gitCwd: args.projectRoot,
    baseHead: args.baseHead,
    head,
    scopeContract: args.scopeContract,
    verificationIntents: args.verificationIntents,
    changedFiles: args.changedFiles,
    affectedProcessFacts: args.affectedProcessFacts,
    affectedCapabilities: args.affectedCapabilities,
  });
  const graph = args.changedFiles && args.changedFiles.length === 0
    ? undefined
    : buildDualRevisionImpactGraph({ gitCwd: args.projectRoot, baseHead: args.baseHead, head, catalog });
  const closures = new Map<string, ReturnType<typeof createValidationClosureCertificate>>();
  for (const entry of catalog) {
    const trace = args.runtimeTraces && args.runtimeTraces.get(entry.id);
    if (!trace) continue;
    closures.set(entry.id, createValidationClosureCertificate({
      commandId: entry.id,
      baseHead: args.baseHead,
      inventoryDigest: inventory.digest,
      catalogDigest: stableDigest(catalog),
      staticPaths: entry.inputRoots,
      runtimeTrace: trace,
    }));
  }
  const context: DynamicValidationContext = {
    storyId: args.storyId,
    baseHead: args.baseHead,
    head,
    inventory,
    catalog,
    changes,
    ...(graph ? { graph } : {}),
    closures,
    mode: args.mode || 'observe',
    gitCwd: args.projectRoot,
    baselineEpochId: args.baselineEpochId,
    buildProofDigest: args.buildProofDigest,
    toolchainDigest: args.toolchainDigest,
    scopeContract: args.scopeContract,
  };
  const manifest = buildDynamicValidationPlan(context);
  return {
    inventoryDigest: inventory.digest,
    catalogDigest: stableDigest(catalog),
    manifest,
    report: formatDynamicValidationReport({ manifest }),
  };
}
