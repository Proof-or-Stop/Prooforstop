
export { type ILLMProvider, type LLMCallOptions, type LLMResponse } from './providers/types.js';
export { ClaudeCliProvider } from './providers/claude-cli.js';
export { storyMachine, createStoryActor, getStateName, getGuardFailureReason } from './core/machine.js';
export { browserVitePlugin } from './tasks/browser-vite-plugin.js';
export {
  allContextPackRequiredRefs,
  allTargetRequiredRefs,
  buildTargetBoundEvidenceEnvelope,
  canonicalJson,
  ContextPackDependencyEdgeContractSchema,
  ContextPackHunkContractSchema,
  ContextPackSnippetContractSchema,
  ContextPackSymbolContractSchema,
  digestCanonical,
  digestCommand,
  digestVerificationContextPack,
  parseVerificationContextPackContract,
  prepareEvidenceEnvelopeForSigning,
  RepoSnapshotContractSchema,
  type ContextPackDependencyEdgeContract,
  type ContextPackHunkContract,
  type ContextPackSnippetContract,
  type ContextPackSymbolContract,
  type EvidenceEnvelopeContract,
  type RepoSnapshotContract,
  type TargetBoundEvidenceInput,
  VerificationCommandContractSchema,
  VerificationContextPackContractSchema,
  type VerificationCommandContract,
  type VerificationContextPackContract,
  type VerificationTargetContract,
} from './core/authority-contracts.js';
export { EvidenceCollector, type EvidenceMaterial } from './core/evidence-collector.js';
export {
  createVerificationContextPack,
  createVerificationContextPackExpansion,
  parseGitDiffHunks,
  type VerificationContextPackExpansionInput,
  type VerificationContextPackInput,
  type VerificationContextPackResult,
} from './core/verification-context-pack.js';
export {
  buildStoryCapsule,
  validateCapsuleRefs,
  type StoryCapsuleData,
  type StoryCapsuleRunData,
} from './core/story-capsule.js';
export {
  buildScopeContract,
  checkScopeContract,
  readChangedFiles,
  renderScopeCheckResult,
  validateMode,
  validatePaths,
  validateAnchors,
  validateFileRules,
  validateHunkDigest,
} from './core/scope-contract.js';
export {
  buildScopeDiffPack,
  digestScopeDiffPack,
  parseUnifiedDiff,
} from './core/scope-diff-pack.js';
export {
  checkSemanticScope,
  mergeSemanticScopeResult,
  isSemanticContract,
} from './core/semantic-scope-gate.js';
export {
  GUARD_PRELAUNCH_PROVIDERS,
  providerSupportsPreToolBlocking,
  resolveGuardMode,
  digestScopeContract,
  buildGuardSession,
  detectGuardViolations,
  applyGuardCheck,
  guardSessionHasBlockingViolations,
  guardSessionStateLabel,
  renderGuardSessionLine,
  renderGuardSession,
} from './core/guard-session.js';
export {
  REVIEW_SCOPE_BINDING_SALT,
  materialDiffPackDigest,
  signReviewScopeBinding,
  computeReviewScopeBinding,
  verifyReviewScopeBinding,
  buildCurrentScopeContext,
  compareScopeBinding,
  type CurrentScopeContext,
  type ScopeBindingComparison,
  type ScopeBindingStaleCode,
} from './core/review-scope-binding.js';
