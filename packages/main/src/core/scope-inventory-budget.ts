import type { FullTaskScopeContext } from './prompt-contracts.js';
import type { ScopeContractData } from './types.js';

/** Exact authority inventories have their own capacity; generic prompt lists do not. */
export const SCOPE_INVENTORY_LIMITS = Object.freeze({
  pathsPerList: 4096,
  serializedBytes: 1_048_576,
});

const SCOPE_INVENTORY_LISTS = [
  'allowedModify', 'allowedCreate', 'allowedTest', 'protectedFiles',
  'explicitExcludes',
] as const;

function canonicalStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].sort();
}

/** The exact projection signed into full task context, shared by producer and consumer. */
export function projectScopeInventory(contract: ScopeContractData): FullTaskScopeContext {
  return {
    mode: contract.mode,
    allowedModify: canonicalStrings(contract.allowedModify),
    allowedCreate: canonicalStrings(contract.allowedCreate),
    allowedTest: canonicalStrings(contract.allowedTest),
    protectedFiles: canonicalStrings(contract.protectedFiles),
    explicitExcludes: canonicalStrings(contract.explicitExcludes),
    protectedAnchors: canonicalStrings(contract.protectedAnchors),
    fileRules: [...(contract.fileRules ?? [])]
      .map(rule => ({
        path: rule.path,
        allowedAnchors: canonicalStrings(rule.allowedAnchors),
        deniedAnchors: canonicalStrings(rule.deniedAnchors),
        protectedAnchors: canonicalStrings(rule.protectedAnchors),
        allowedChangeKinds: canonicalStrings(rule.allowedChangeKinds),
        intentRefs: canonicalStrings(rule.intentRefs),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    ...(contract.pathCanonicalizerVersion ? {
      pathCanonicalizerVersion: contract.pathCanonicalizerVersion,
    } : {}),
    ...(contract.pathCanonicalizationMode ? {
      pathCanonicalizationMode: contract.pathCanonicalizationMode,
    } : {}),
    ...(contract.anchorParserVersion ? {
      anchorParserVersion: contract.anchorParserVersion,
    } : {}),
    ...(contract.anchorArtifactVersion ? {
      anchorArtifactVersion: contract.anchorArtifactVersion,
    } : {}),
    ...(contract.astAnchorMode ? { astAnchorMode: contract.astAnchorMode } : {}),
  };
}

/** Bound the complete projected authority, including rule arrays and optional metadata. */
export function validateScopeInventoryBudget(scope: FullTaskScopeContext): void {
  for (const key of SCOPE_INVENTORY_LISTS) {
    if (scope[key].length > SCOPE_INVENTORY_LIMITS.pathsPerList) {
      throw new Error(`FullTaskContext.scope.${key} exceeds ${SCOPE_INVENTORY_LIMITS.pathsPerList} entries`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(scope), 'utf8') > SCOPE_INVENTORY_LIMITS.serializedBytes) {
    throw new Error(`FullTaskContext.scope exceeds ${SCOPE_INVENTORY_LIMITS.serializedBytes} serialized UTF-8 bytes`);
  }
}
