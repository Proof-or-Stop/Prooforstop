/**
 * Canonical inventory for controller-owned artifacts projected into a Story.
 * Producers, scope classification, process facts and contract checks consume
 * these descriptors so adding a projected file cannot silently omit a gate.
 */
export interface ManagedArtifactDescriptor {
  id: string;
  path: string;
  owner: 'proof-or-stop';
  origin: 'controller-projection';
  category: 'lifecycle';
  producer: string;
  validationPolicy: string;
  projectionPolicy: string;
  trackedPolicy: 'untracked-only';
  signature: string;
  consumerGate: string;
  rationale: string;
  producerSourceRefs: readonly string[];
  consumerSourceRefs: readonly string[];
  name: `artifact:${string}`;
  kind: 'signed-artifact';
  semantics: readonly ['artifact', 'signed-artifact', 'schema-contract', 'atomic-persistence', 'workspace-binding', 'gate-evidence'];
  level: 'L4';
  artifact: {
    name: string;
    path: string;
    signed: true;
    signature: string;
    consumerGate: string;
  };
}

function defineManagedArtifactDescriptor(
  input: Omit<ManagedArtifactDescriptor, 'name' | 'kind' | 'semantics' | 'level' | 'artifact'>,
): ManagedArtifactDescriptor {
  return {
    ...input,
    name: `artifact:${input.path}`,
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'atomic-persistence', 'workspace-binding', 'gate-evidence'],
    level: 'L4',
    artifact: {
      name: input.id,
      path: input.path,
      signed: true,
      signature: input.signature,
      consumerGate: input.consumerGate,
    },
  };
}

export const CONTROLLER_CONFIG_PROJECTION_ARTIFACT = defineManagedArtifactDescriptor({
  id: 'controller-config-projection-receipt',
  path: 'evidence/controller-config-projection.json',
  owner: 'proof-or-stop',
  origin: 'controller-projection',
  category: 'lifecycle',
  producer: 'cli/runtime-root via core/controller-config-projection',
  validationPolicy: 'signed first-projection config identity in Git-common and current Story receipts',
  projectionPolicy: 'exact registered Story worktree only',
  trackedPolicy: 'untracked-only',
  signature: 'signValidationArtifact/verifyValidationArtifact binds first projected config digest, Story, controller root, worktree root, and config path',
  consumerGate: 'scope-path classifier and scope-contract REVIEW admission',
  rationale: 'Only an untracked config pair matching both immutable first-projection receipts can be classified as a control artifact. Editing either copy or receipt returns the path to ordinary fail-closed scope enforcement.',
  producerSourceRefs: [
    'packages/main/src/core/managed-artifact-descriptors.ts',
    'packages/main/src/core/controller-config-projection.ts',
  ],
  consumerSourceRefs: [
    'packages/main/src/core/lifecycle-registry.ts',
    'packages/main/src/core/runtime-artifact-registry.ts',
    'packages/main/src/core/scope-path-classifier.ts',
    'packages/main/src/core/scope-contract.ts',
  ],
});

export const CONTROLLER_RUNTIME_PROJECTION_ARTIFACT = defineManagedArtifactDescriptor({
  id: 'controller-runtime-projection-receipt',
  path: 'evidence/controller-runtime-projection.json',
  owner: 'proof-or-stop',
  origin: 'controller-projection',
  category: 'lifecycle',
  producer: 'cli/runtime-root via core/controller-runtime-projection',
  validationPolicy: 'signed exact hook digests in Git-common and current Story receipts with byte-identical controller/worktree assets',
  projectionPolicy: 'exact registered global-thin Story worktree only',
  trackedPolicy: 'untracked-only',
  signature: 'signValidationArtifact/verifyValidationArtifact binds Story, controller root, worktree root, exact hook paths and digests',
  consumerGate: 'scope-path classifier and scope-contract REVIEW admission',
  rationale: 'The Story receipt is admitted only while its signed common receipt, workspace identity, exact hook set and byte identity remain valid. Tampering fails closed as a framework-owned projection error and never widens Story scope.',
  producerSourceRefs: [
    'packages/main/src/core/managed-artifact-descriptors.ts',
    'packages/main/src/core/controller-runtime-projection.ts',
  ],
  consumerSourceRefs: [
    'packages/main/src/core/lifecycle-registry.ts',
    'packages/main/src/core/runtime-artifact-registry.ts',
    'packages/main/src/core/scope-path-classifier.ts',
    'packages/main/src/core/scope-contract.ts',
  ],
});

export const CONTROLLER_PROJECTION_ARTIFACTS = [
  CONTROLLER_CONFIG_PROJECTION_ARTIFACT,
  CONTROLLER_RUNTIME_PROJECTION_ARTIFACT,
] as const satisfies readonly ManagedArtifactDescriptor[];
