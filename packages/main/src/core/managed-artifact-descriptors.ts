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
}

export const CONTROLLER_CONFIG_PROJECTION_ARTIFACT = {
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
  consumerGate: 'scope-contract REVIEW admission',
  rationale: 'Only an untracked config pair matching both immutable first-projection receipts can be classified as a control artifact. Editing either copy or receipt returns the path to ordinary fail-closed scope enforcement.',
} as const satisfies ManagedArtifactDescriptor;

export const CONTROLLER_RUNTIME_PROJECTION_ARTIFACT = {
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
} as const satisfies ManagedArtifactDescriptor;

export const CONTROLLER_PROJECTION_ARTIFACTS = [
  CONTROLLER_CONFIG_PROJECTION_ARTIFACT,
  CONTROLLER_RUNTIME_PROJECTION_ARTIFACT,
] as const satisfies readonly ManagedArtifactDescriptor[];
