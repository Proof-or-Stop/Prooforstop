
export { type ILLMProvider, type LLMCallOptions, type LLMResponse } from './providers/types.js';
export { ClaudeCliProvider } from './providers/claude-cli.js';
export { storyMachine, createStoryActor, getStateName, getGuardFailureReason } from './core/machine.js';
export { browserVitePlugin } from './tasks/browser-vite-plugin.js';
export {
  allContextPackRequiredRefs,
  allTargetRequiredRefs,
  buildTargetBoundEvidenceEnvelope,
  canonicalJson,
  digestCanonical,
  digestVerificationContextPack,
  prepareEvidenceEnvelopeForSigning,
  type ContextPackDependencyEdgeContract,
  type ContextPackHunkContract,
  type ContextPackSnippetContract,
  type ContextPackSymbolContract,
  type EvidenceEnvelopeContract,
  type RepoSnapshotContract,
  type TargetBoundEvidenceInput,
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
