


import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';



import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


import ts from 'typescript';



import { createIdentityTextFactsCache, identityLookalikes } from "./identity-inventory.mjs";
export const state = { freshFixture: null, runtimeTopologyFixture: undefined, publicIdentityOperationFixture: undefined, runtimeFixture: null, identityCutoverFixture: null, identityVerifierResult: null };
export let selectedGroup = null;
export let selectedGroups = null;
export function setSelection(groups) { selectedGroups = groups; selectedGroup = groups === null ? null : groups.join(','); }

export const { base: journalFixtureBase, delta: journalFixtureDelta } = await import("../../../../scripts/verify-acceptance-amendment-delta.mjs");

export const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const packageRoot = resolve(here, '..');

export const repoRoot = resolve(packageRoot, '..', '..');

export const commonGitDir = resolve(repoRoot, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim());

export const mainRoot = dirname(commonGitDir);

export const distRoot = join(packageRoot, 'dist');

export const {
  buildScopeBoundary,
  buildScopeFreezeCheckArtifact,
  digestExecutionBoundary,
  digestScopeBoundary,
  digestScopeFreezeCheck,
  evaluateScopeFreeze,
  executionBoundaryHashIsFresh,
  normalizeExecutionBoundary,
  normalizeScopeBoundary,
  scopeBoundaryHashIsFresh,
} = await import(join(distRoot, 'core/scope-anti-expansion.js'));

export const {
  initCheckAgentMatches,
  initCheckSignatureIsValid,
  recomputeInitCheckHash,
  REQUIRED_INIT_CHECK_AGENTS,
} = await import(join(distRoot, 'core/init-check-gate.js'));

export const { resolveAgentMutationAuthority } = await import(join(distRoot, 'core/agent-dispatch-registry.js'));

export const {
  COMMAND_POLICIES,
  STORY_WRITE_CAPABILITY_COMMANDS,
  commandRequiresAuthoritativeRuntime,
} = await import(join(distRoot, 'core/command-policy.js'));

export const {
  ACTIVE_IDENTITY_OPERATION_BOUNDARIES,
  assertCanonicalActiveIdentityRuntime,
  assertCanonicalActiveIdentityBoundary,
  classifyRuntimeEntrypointAuthority,
} = await import(join(distRoot, 'core/runtime-environment-checks.js'));

export const { enforceStoryRuntimeAdmission } = await import(join(distRoot, 'cli/story-runtime-admission.js'));

export const { resolveEffectiveOwnershipClass } = await import(join(distRoot, 'cli/ownership-gate.js'));

export const { StoryStore } = await import(join(distRoot, 'core/store.js'));

export const { currentMaterialHash } = await import(join(distRoot, 'core/evidence-freshness.js'));

export const { RUNTIME_ARTIFACT_REGISTRY: runtimeArtifactRegistry } = await import(join(distRoot, 'core/runtime-artifact-registry.js'));

export const { signDeliveryCheck } = await import(join(distRoot, 'core/delivery-check-hash.js'));

export const { getGuardFailureReason, getScopeAntiExpansionGuardFailureReason } = await import(join(distRoot, 'core/machine.js'));

export const promptContracts = await import(join(distRoot, 'core/prompt-contracts.js'));

export const promptEnvelope = await import(join(distRoot, 'core/prompt-envelope.js'));

export const promptMeasurement = await import(join(distRoot, 'core/prompt-measurement.js'));

export const promptRegistry = await import(join(distRoot, 'core/prompt-registry.js'));

export const promptRoleContracts = await import(join(distRoot, 'core/prompt-role-contract-registry.js'));

export const processFacts = await import(join(distRoot, 'core/process-fact-registry.js'));

export const reviewRunContracts = await import(join(distRoot, 'core/review-run.js'));

export const { artifactReleaseLedgerPath, readArtifactReleaseLedger, appendArtifactReleaseRecord, buildArtifactReleaseRecord, artifactReleaseRecordValidationErrors, ArtifactReleaseLedgerError, ARTIFACT_RELEASE_SCHEMA_VERSION } = await import(join(distRoot, 'core/artifact-release.js'));

export const { capabilityReleaseLedgerPath, readCapabilityReleaseLedger } = await import(join(distRoot, 'core/capability-release.js'));

export const {
  runArtifactReleaseLedgerAfterDoneMergeDetailed,
  runCapabilityReleaseLedgerAfterDoneMerge,
} = await import(join(distRoot, 'handlers/done-effects.js'));

export const { createStoryAdvanceHandlers } = await import(join(distRoot, 'handlers/story-advance.js'));

export const { createPlaybookRuntimeMemoryHandlers } = await import(join(distRoot, 'handlers/playbook-runtime-memory.js'));

export const failures = [];

export const NOW = '2026-09-02T00:00:00.000Z';

export const cliPath = join(distRoot, 'cli.js');

export const retiredInitActor = ['lat', 'tice-review-story-init'].join('');

export const fixtureRoots = [];

export const fixtureFindingKeyTargets = new Map();

export const canonicalBoundary = buildScopeBoundary({
  storyId: 'B-fresh',
  mode: 'custom',
  allowed: ['Unicode scope 范围'],
  excluded: [],
  confirmedBy: 'human',
  confirmationNote: 'fresh B-49df contract',
  now: NOW,
});

export const INERT_PUBLIC_FIXTURE_LOG_SUBTREE = '.remember/logs/autonomous/';

export const retiredProtocolPrefix = ['proof', 'bound.'].join('');

export const retiredProtocolStem = ['proof', 'bound'].join('');

export const retiredBrandStem = ['lat', 'tice'].join('');

export const retiredIdentityPattern = new RegExp(
  `${retiredProtocolStem}[.:\\-][a-z0-9._:-]+|${retiredBrandStem}[.:\\-][a-z0-9._:-]+`,
  'gi',
);

export const retiredReviewRunSalt = ['lat', 'tice-review-run-integrity-v1'].join('');

export const currentDigestPrefix = 'proof-or-stop.digest.v1';

export const currentReviewRunSalt = 'proof-or-stop-review-run-integrity-v1';

export const IDENTITY_CUTOVER_REQUIRED_PATHS = Object.freeze([
  "packages/main/src/core/git-tree-observation.ts",
  "packages/main/src/core/executable-digest-observation.ts",
  "packages/main/src/core/maintenance-command-mode.ts",
  'packages/main/src/core/acceptance-amendment-journal.ts',
  'packages/main/src/core/convergence-effective-progress.ts',
  'packages/main/src/core/convergence-progress-journal.ts',
  'packages/main/src/core/store.ts',

  'packages/main/src/core/delivery-review-authority.ts',
  'packages/main/src/core/acceptance-amendment-review.ts',
  'docs/requirements/baselines/role-prompt-measurement-baseline.json',
  'packages/main/src/core/artifact-release.ts',
  'packages/main/src/core/candidate-spec-routing.ts',
  'packages/main/src/core/capability-release.ts',
  'packages/main/src/core/certification-window.ts',
  'packages/main/src/core/config.ts',
  'packages/main/src/core/evidence-freshness.ts',
  'packages/main/src/core/experience-layer-types.ts',
  'packages/main/src/core/impact-classification-policy.ts',
  'packages/main/src/core/learning-store.ts',
  'packages/main/src/core/lifecycle-control/control-status.ts',
  'packages/main/src/core/lifecycle-control/queue/index.ts',
  'packages/main/src/core/milestone-status.ts',
  'packages/main/src/core/playbook-runtime-baseline.ts',
  'packages/main/src/core/playbook-runtime-memory-cache.ts',
  'packages/main/src/core/playbook-runtime-memory-index.ts',
  'packages/main/src/core/playbook-runtime-memory.ts',
  'packages/main/src/core/playbook-seed.ts',
  'packages/main/src/core/process-fact-registry.ts',
  'packages/main/src/core/prompt-budget.ts',
  'packages/main/src/core/prompt-contracts.ts',
  'packages/main/src/core/prompt-envelope.ts',
  'packages/main/src/core/prompt-measurement.ts',
  'packages/main/src/core/prompt-registry.ts',
  'packages/main/src/core/prompt-role-contract-registry.ts',
  'packages/main/src/core/review-incremental-context.ts',
  'packages/main/src/core/review-inventory-epoch.ts',
  'packages/main/src/core/review-run.ts',
  'packages/main/src/core/source-lineage-audit.ts',
  'packages/main/src/core/verification-execution-evidence.ts',
  'packages/main/src/handlers/agent-prompt.ts',
  'packages/main/src/handlers/candidate-spec-routing.ts',
  'packages/main/src/handlers/checklist.ts',
  'packages/main/src/handlers/done-effects.ts',
  'packages/main/src/handlers/playbook-runtime-memory.ts',
  'packages/main/src/handlers/playbook.ts',
  'packages/main/src/handlers/review-run.ts',
  'packages/main/src/handlers/story-dispatch.ts',
  'packages/main/src/core/claim-admissibility/pack-framework.ts',
  'packages/main/src/cli-init.ts',
  'packages/main/templates/agents/proof-or-stop-evaluator.md',
  'packages/main/templates/agents/proof-or-stop-implementer.md',
  'packages/main/templates/agents/proof-or-stop-review-behavior.md',
  'packages/main/templates/agents/proof-or-stop-review-concept.md',
  'packages/main/templates/agents/proof-or-stop-review-delivery.md',
  'packages/main/templates/agents/proof-or-stop-review-docs.md',
  'packages/main/templates/agents/proof-or-stop-review-quality.md',
  'packages/main/templates/agents/proof-or-stop-review-scope-plan.md',
  'packages/main/templates/agents/proof-or-stop-review-story-init.md',
  'packages/main/templates/agents/proof-or-stop-review-test-coverage.md',
  'scripts/verify-proof-or-stop-identity-cutover.mjs',
  'proof-or-stop.config.json',
]);

export const HISTORICAL_SCOPE_READER_IDENTITIES = Object.freeze([
  ['packages/main/src/core/process-fact-registry.ts', 'lattice.execution_boundary.v1', 1],
  ['packages/main/src/core/process-fact-registry.ts', 'lattice.scope_freeze_check.v1', 1],
  ['packages/main/src/core/scope-anti-expansion.ts', 'lattice.scope_boundary.v1', 1],
  ['packages/main/src/core/scope-anti-expansion.ts', 'lattice.execution_boundary.v1', 1],
  ['packages/main/src/core/scope-anti-expansion.ts', 'lattice.scope_freeze_check.v1', 1],
  ['packages/main/src/core/types.ts', 'lattice.scope_boundary.v1', 1],
  ['packages/main/src/core/types.ts', 'lattice.execution_boundary.v1', 1],
  ['packages/main/src/core/types.ts', 'lattice.scope_freeze_check.v1', 1],
]);

export const PROMPT_ENVELOPE_IDENTITY_VALUE_BY_PATH = Object.freeze({
  schemaVersion: promptContracts.CURRENT_PROMPT_IDENTITIES.promptEnvelope,
  runtimeContractVersion: promptContracts.CURRENT_PROMPT_IDENTITIES.runtimeContract,
  roleContractVersion: promptContracts.CURRENT_PROMPT_IDENTITIES.roleContract,
  assemblerVersion: promptContracts.CURRENT_PROMPT_IDENTITIES.assembler,
  dispatchProtocolVersion: promptContracts.CURRENT_PROMPT_IDENTITIES.dispatchProtocol,
});

export const RETIRED_PROMPT_ENVELOPE_IDENTITY_BOUNDARIES = Object.freeze(
  promptContracts.PROMPT_ENVELOPE_ACTIVE_IDENTITY_PATHS.map((path) => Object.freeze({
    id: `prompt-envelope.${path}`,
    class: 'persisted-reader-verifier',
    path,
    canonical: PROMPT_ENVELOPE_IDENTITY_VALUE_BY_PATH[path],
    retired: PROMPT_ENVELOPE_IDENTITY_VALUE_BY_PATH[path].replace(/^proof-or-stop\./, retiredProtocolPrefix),
    publicOperation: 'review_pass_set',
  })),
);

export const identityTextFactsCache = createIdentityTextFactsCache();

export const OWNED_IMPORTED_IDENTITY_ORIGINS = [
  ['packages/main/src/core/store.ts', 'packages/main/src/core/causal-evidence.ts', 'CAUSAL_EVIDENCE_INDEX_SCHEMA'],
  ['packages/main/src/core/acceptance-amendment-journal.ts', 'packages/main/src/core/artifact-schema.ts', 'ACCEPTANCE_AMENDMENT_ENTRY_SCHEMA'],
  ['packages/main/src/core/acceptance-amendment-journal.ts', 'packages/main/src/core/artifact-schema.ts', 'ACCEPTANCE_AMENDMENT_JOURNAL_SCHEMA'],
  ['packages/main/src/core/convergence-effective-progress.ts', 'packages/main/src/core/artifact-schema.ts', 'EFFECTIVE_PROGRESS_SCHEMA'],
  ['packages/main/src/core/convergence-progress-journal.ts', 'packages/main/src/core/artifact-schema.ts', 'CONVERGENCE_PROGRESS_JOURNAL_SCHEMA'],

  ['packages/main/src/core/verification-execution-evidence.ts', 'packages/main/src/core/artifact-schema.ts', 'VERIFICATION_RECEIPT_BUNDLE_V5'],
  ['packages/main/src/core/evidence-freshness.ts', 'packages/main/src/core/artifact-schema.ts', 'EVIDENCE_HASH_SNAPSHOT_SCHEMA'],
  ['packages/main/src/core/claim-admissibility/pack-framework.ts', 'packages/main/src/core/proof-admissibility.ts', 'PROOF_ADMISSIBILITY_CONTRACT_VERSION'],
  ['packages/main/src/core/claim-admissibility/pack-framework.ts', 'packages/main/src/core/proof-admissibility.ts', 'PROOF_ADMISSIBILITY_VERIFIER_VERSION'],
  ['packages/main/src/core/claim-admissibility/pack-framework.ts', 'packages/main/src/core/claim-admissibility/quantum.ts', 'QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION'],
  ['packages/main/src/core/claim-admissibility/pack-framework.ts', 'packages/main/src/core/claim-admissibility/quantum.ts', 'QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION'],
];

export const PROJECT_CONFIG_IDENTITY_CASES = [
  ...['evaluator', 'implementer', 'review-behavior', 'review-concept', 'review-delivery',
    'review-docs', 'review-quality', 'review-scope-plan', 'review-story-init',
    'review-test-coverage', 'review-topology-critic'].map(name => ({
      canonical: `proof-or-stop-${name}`, field: 'role-key',
    })),
  { canonical: 'proof-or-stop.prompt-envelope-rollout.v1', field: 'version' },
].map(row => ({ ...row, sourcePath: 'proof-or-stop.config.json',
  siteId: `proof-or-stop.config.json#${row.canonical}` }));

export const OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS = [
  { sourcePath: 'proof-or-stop.config.json', canonical: 'proof-or-stop.config.json', occurrences: 14,
    contextSha256: 'e016954e5d457ab0d561bc0bafe2fc8096c4fcc39ea99ea74a34165bd58e5cb6',
    kind: 'scope-source-path', reason: 'Fourteen exact scope and validation source references, including the registered production-budget regression resource, name the config file; these are not prompt schema or role values.',
    proof: 'node scripts/verify-root-scope-budget-policy.mjs' },
  {"sourcePath": "packages/main/src/core/process-fact-registry.ts", "canonical": "proof-or-stop.config.json", "occurrences": 1, "contextSha256": "d76aa4750daa0a3bd2e672550d9704eb42847abd42415fae9a20f8fe301b6eb1", "kind": "registry-source-path", "reason": "Exact P0m source inventory path; not a parser, protocol producer, or compatibility reader.", "proof": "node packages/main/tests/red/red-repro-first-p0m-component-mapping.mjs"},
  {"sourcePath":"proof-or-stop.config.json","canonical":"proof-or-stop-experience-layer-v1.1-zh.md","occurrences":1,"contextSha256":"a0430b5c5f5727862f4f3c486638fdda0d0dd464c26f80a09fafe6c6acded30c","kind":"scope-governance-document-path","reason":"Exact responsibility-domain source path names the existing experience-layer design document; not an executable protocol identity or compatibility reader.","proof":"node scripts/verify-root-scope-budget-policy.mjs"},
  {"sourcePath": "proof-or-stop.config.json", "canonical": "proof-or-stop-real-root-admission", "occurrences": 8, "contextSha256": "6925f132289490e9370c679f50b5c425477621b904ff14ce6d94fc8eb7ddcc41", "kind": "validation-resource-key", "reason": "Eight exact exclusive admission claims name a scheduler resource, not a protocol producer or compatibility alias. Removing claims is independently mutation-tested.", "proof": "node packages/main/tests/red/red-bcae-admission-coscheduling.mjs"},
  {
    sourcePath: 'scripts/verify-proof-or-stop-identity-cutover.mjs',
    canonical: 'proof-or-stop-finish-decision-boundary-',
    occurrences: 1,
    contextSha256: '6ee1f02d86f754e263fb70ea412c9a1e287a542026c509add7810fa5a37333dd',
    kind: 'scanner-self-test-fixture',
    reason: 'Exact temporary fixture directory prefix for the unlisted finish-decision neighbor control; not a product identity reader.',
    proof: 'node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test',
  },
  {
    sourcePath: 'scripts/verify-proof-or-stop-identity-cutover.mjs',
    canonical: 'proof-or-stop.dev-memory-finish-decision.v1',
    occurrences: 1,
    contextSha256: 'b1a24599294674d975c6c461516d3ecb6d9b2a8f5352025513042daeb7834cdb',
    kind: 'scanner-self-test-fixture',
    reason: 'Exact fresh canonical same-directory neighbor positive control paired with the retired-schema scanner negative; not runtime admission.',
    proof: 'node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test',
  },
  {
    "sourcePath": "packages/main/src/core/prompt-contracts.ts",
    "canonical": "proof-or-stop-observational-baseline",
    "occurrences": 1,
    "contextSha256": "9beff0b18570e6bfa770e29f85443d0a90ad78619c0259b0421005cb7cba57d0",
    "kind": "ignored-estimator-label",
    "reason": "Estimator first argument is ignored; estimatePromptTokens returns only a number, not an emitted or accepted identity.",
    "proof": "identity-sites: real bytesCharsEstimator is model-label-independent"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-f051-identity-subtree-",
    "occurrences": 1,
    "contextSha256": "6d4466164ff151da41860f41dfcc68f2160974f72c03bf0251e601515cb020d4",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-implementer",
    "occurrences": 1,
    "contextSha256": "8e67e4fa1a4f2799b80205a8c9b705a10b71fc7a223e6258afa80a4d7e065783",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-ordering-self-test-",
    "occurrences": 1,
    "contextSha256": "77d40517e529992c6536c529970ea70b4e01086cce0c04b10cfc5e423cc326a6",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-review-integrity-v1",
    "occurrences": 1,
    "contextSha256": "74a4b66994582f80451a52ec32f1ca42fef19d1a7c87b80b580695cddd142373",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-review-quality",
    "occurrences": 1,
    "contextSha256": "040d88b1da27abad29983a0ad14e7e03fd59cd49a3c77694828e0a354f4b64a5",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-review-story-init",
    "occurrences": 1,
    "contextSha256": "040d88b1da27abad29983a0ad14e7e03fd59cd49a3c77694828e0a354f4b64a5",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-review-topology-critic",
    "occurrences": 1,
    "contextSha256": "040d88b1da27abad29983a0ad14e7e03fd59cd49a3c77694828e0a354f4b64a5",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-verifier-pass",
    "occurrences": 1,
    "contextSha256": "040d88b1da27abad29983a0ad14e7e03fd59cd49a3c77694828e0a354f4b64a5",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  }
];

export const OWNED_IDENTITY_SITE_CONTEXTS = [
  ["packages/main/src/cli-init.ts", "proof-or-stop.prompt-envelope-rollout.v1", 1, "22eae501b4a9bc4f1be1ef4db9fdbfaf9f41b8283e44f832d832a32458b8b876"],
  ["packages/main/src/handlers/checklist.ts", "proof-or-stop.plan-acceptance-batch.v1", 2, "e89f46c374f4b7b4ba7b72bc891f5d83eedd1023463f833d2be4beb2226abf49"],
  ["packages/main/src/core/acceptance-amendment-journal.ts", "proof-or-stop.acceptance_amendment.v1", 2, "1e463e0e08311325a96d08af7b8af3c7696df7ffe6cd6ff0a60cf095a46b2691"],
  ["packages/main/src/core/acceptance-amendment-journal.ts", "proof-or-stop.acceptance_amendments.v1", 2, "d2c1713750a7a4735af15847ee69566291f17759a0297d21367ffcf7d9044913"],
  ["packages/main/src/core/convergence-effective-progress.ts", "proof-or-stop.effective_progress.v1", 1, "25f66117c33b2122f2e32ab982482b67d73e7cddf1111cc086f2a494c0a9be3d"],
  ["packages/main/src/core/convergence-progress-journal.ts", "proof-or-stop.convergence_progress_journal.v1", 2, "a2f9a312a8a9dae53c46d10167788efb79a95aa854497664e2569818e784d8d3"],
  ["packages/main/src/core/store.ts", "proof-or-stop.causal-evidence-index.v1", 2, "9beefb3d51fb92b6ce8f6e728186deac6cb04dc0da081e37f321a8a35c786d2c"],
  ["packages/main/src/core/store.ts", "proof-or-stop.decision_doc_proposals.v1", 1, "c6d404029421548dea27e30d14c13c18313e400404206a45d44375b96f8f2a0f"],

  ["packages/main/src/handlers/review-run.ts","proof-or-stop-review-topology-critic",1,"111ae2939a16bbebadfd9f53c9b6db912c913d07b4660fe5403fe7d27a2f7031"],
  ["packages/main/src/core/review-incremental-context.ts","proof-or-stop.post-remediation-review-selection.v2",9,"5216c8656c84594731994a4ccef8f2cb1e7c652721cbd28eb70c834bb51637fb"],
  ["packages/main/src/core/review-incremental-context.ts","proof-or-stop-review-topology-critic",1,"bd4d085a52f811f7ec3647df2867ceaaac77dc0daf2dd50556de852111f9d942"],
  ["packages/main/src/core/delivery-review-authority.ts","proof-or-stop-review-delivery",7,"4af8175e4056db818d9b2bd79c6c2e41d800a5488cd14e8f3a8d8a8537927622"],
  ["packages/main/src/core/acceptance-amendment-review.ts", "proof-or-stop-acceptance-intent-reviewer", 1, "4c52adee31cdcafa2286cd161574b7187aeb04e632c47826bb2cb1b252d168dc"],
  ["packages/main/src/core/acceptance-amendment-review.ts", "proof-or-stop.acceptance_amendment_review_final.v1", 3, "84493e355882b357c4fed55cf1a0afc72e749a55e00f7518b9ce50526c4b5b03"],
  ["packages/main/src/core/certification-window.ts", "proof-or-stop.precert-cheap-check-receipt.v1", 2, "598ac97fb601b4d8dd9a16f9a46e45b6df8d930c31731ae6c40f789d0ccce537"],
  ["packages/main/src/core/certification-window.ts", "proof-or-stop.precert_cheap_check_receipt.v1", 5, "88e1c3e63b56dede315423f02f00b5bc011a34610f487ad731d80226c5b4932b"],

  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop-verification-receipt-signer-v1.key",3,"c70020b7249196738a7ec9eb21c662e7b6805a5c80e5b6662d05e79257151fd3"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-assertion-receipt.v1",3,"4c05dc6a06dda209a6b3c012a5695335f6fec81c6d728d482457206fe7d0267f"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-assertion-receipt.v2",3,"7a26aa6c00db0c5ac11494b858642fa2015f4aab088ee4331a6c6494624eb1b8"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-execution-identity.v1",2,"7ea346cece80347dedf317a977b42205c3c6dd96fafe7168cbb5c4c560a92b9d"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-execution-key.v1",2,"899e8342d5ed31bb56ec93189f25410125c7863b9fdc16da5aa50aa944fc7076"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-execution-lock.v1",2,"82693e17f4e5bf028726abb6d044ecc2c831474a728b698927fbe5f59518e47e"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-execution-receipt.v2",2,"32871cbf8170d65116a38bdbfea7f7a5a4565de03654bd86c017b97231603e52"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-execution-receipt.v3",6,"f997451030218b33fb575301382da97e9b9dadeda39b258f95bd6cb8d82a5dbc"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-execution-ticket.v1",5,"c3398d425712a4a815118c367820018c48c8676d1198eda57b9ec2ee0c9c7fb7"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-output.v1",3,"17bc9c63c4bd06609b4470471ad0fba671befc9e4609c42a1367b17fd1829bf1"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-publication-binding.v1",4,"70bb9b1a24d4881689f1c1b2a3a26806b73d29434d66f1aefe70c3f799e2e6d0"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-receipt-bundle-binding.v1",3,"57f8f93b0e30f6f104aa6dfcc6aa27e2af020c684d793a27558d7c9ac6645e27"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-receipt-bundle.v2",3,"d8be8a1cf699ef5e0abca828258a8b033e547a6cbd1b5c05841ea108a6d98e3a"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-receipt-bundle.v3",4,"1d1f0f652b610bf61289c8a9cf4a10357822f71c997b618ad02e0b122dbda2ec"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-receipt-bundle.v4",6,"b76f8c79fa2371090e44678cfdf5eff00f3890a93b8e4522a51757217628a7f2"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-receipt-bundle.v5",8,"44d2e52212fb778f5a349c5618f2d25740312d079778a34d3958e166f72e8fda"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-record-authenticity.v1",3,"dd54d6ddceebf4f0266af639ba1b5c2d5e72785331b6cf70ca81929c3a952a4c"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-record.v1",2,"467bd70741396cce3c7ff4133b8503c1ea1728fad55372540a5126e95046efa8"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verification-reuse-receipt.v1",2,"49cb86dacf51a745bcb97d13e2f1af5f67ed5387959d86063ab1590fbf9f6484"],
  ["packages/main/src/core/verification-execution-evidence.ts","proof-or-stop.verifier-dependency-manifest-binding.v1",1,"6cdbe616948e4595c15ece6c9a50cb22bd41e5c6c186ed82c421e020c2d70849"],
  ["packages/main/src/handlers/checklist.ts","proof-or-stop-implementer",2,"19fcc470d02faf604a28e83ea8f710eaebb88868642d7cc7706d2b4d1092bfed"],
  ["packages/main/src/handlers/checklist.ts","proof-or-stop-product-reviewer",1,"54ea216564ffb2a3d1937f30aaed38faa3855aebe8e49a8dc5d8d2637de26104"],
  ["packages/main/src/handlers/checklist.ts","proof-or-stop-review-story-init",1,"54ea216564ffb2a3d1937f30aaed38faa3855aebe8e49a8dc5d8d2637de26104"],
  ["packages/main/src/handlers/checklist.ts","proof-or-stop.verification-execution-receipt.v3",4,"90bcf066b48695e791b83bc4ecd7f810814367e614337f98be5421f819a40cdb"],
  ["packages/main/src/handlers/checklist.ts","proof-or-stop.verification-receipt-bundle.v5",8,"383c91ad3d84d8fcf33cb22dddf299c839556694309da73c5875ffa08a1456df"],
  ["packages/main/src/core/evidence-freshness.ts","proof-or-stop.verifier-dependency-manifest-binding.v1",2,"594d7d8d86c1ee7608582e7da9cdaebb3a74646fccdff5abcb919f8ee763883b"],
  ["packages/main/src/core/evidence-freshness.ts","proof-or-stop.verifier-dependency-manifest.v1",3,"423fc8479e6108678ade451817d7b1d72fe6365fbfe9ade221c8978f6a72965d"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.inventory-verification-observation.v1",1,"22fe5b4a457d314f5fd429adbcb557fef1905cbf99649f531c3bed5d5321152b"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.verification-receipt-bundle.v5",1,"51aa57007901d8f5efb5f5afa2ae61410409a92432c562c6229916dc3c2aa72a"],
  ['packages/main/src/core/playbook-runtime-memory.ts', 'proof-or-stop.dev-memory-finish-decision.v1', 1, '5cd694d61af425589349b4cdcf96b38c2f9c975fb5208d5a9e40cf00c3ff523a'],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-evaluator",1,"3ae040c8146a54c17e0d8374e9a03657bc5423ae0ab0cdc58c62785b623f93cc"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-evaluator-cli",1,"ef41eb8e08326223b08cfaf3106c314378a1ae95355134fae0ac849378eb8a41"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-implementation-reviewer",1,"58c48aa88d5f50870fc18900ddf14da6b73f6a5c8f3ed1db02b864907a95def5"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-implementer",1,"6bdfabfbd966953748eda9a970f71a677e02a71bcb268448eec0089ff69767bd"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-product-reviewer",1,"84a56da4948bb33ece220d03eadee881d563d13b9b075fb2d6e49298ab563da7"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-behavior",1,"424ff1358e8717984428e6e175c93e5afbe0ec177d1509aa3fe05fefd09c717e"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-channel",1,"2bd9d24621eebdb0422bfbc0f992b30d03f6407612762fac71dcb2af23b5c923"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-concept",1,"86306218222cc6488e3e9a63c435005c5d29c4c1d25852d66a19c8e8846f51b9"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-delivery",1,"9627a2f5600be85ca767ac6444fd8babdaaf0f243b48cfa01c066f7e4d60d7a9"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-docs",1,"5a2cb4f47ac32f9d88b351c905fdf77e0c8f10580ab963422391891facfe7d03"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-quality",1,"53fde766430b4eab25a886a69ca05e2356e3ff795828df2b75393c9730d401da"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-scope-plan",1,"7fa2c718a3c1ae97099a7492ff0a74dc5c8d44b0fe6c833b87aa40c1035a6179"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-story-init",1,"830ca09fd551c1393c958e9d7b6ea71d242b6ace5367fe1f9c9a7f8b67a29642"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-test-coverage",1,"916c2e1e94c54e5691e1979088878e1803264901e2af5449bd8e2eac827f15a7"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-topology-critic",1,"944616b8e132d2eb339e1ff5ed58b25861e6ad6d521e0a2aa7162b8fbd8dad5e"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-test-case-reviewer",1,"222477172413cbf8c544a62b025888962cd00d843c39a3659854e4d5d2fd823c"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-test-intent",1,"a07d99089b2d87aa0d78e848c5cb832a4f6ac81c406c2568f5a329687e2e81a2"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-verification-intent",1,"9f7ec8a70a149f31841316b0541af18f2dd8c3a6a9be9de8f3734d571f6df799"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.agent-runtime.v1",19,"0c2d9c4932cd923d5e8750e75bfd6ab9904c74132b70b2be91209dfe5ba0eae9"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.canonical-json.code-point-keys.v1",1,"26eb0e7187ddeee6c2c2104875a32dc740827efb1cc5db59e8e9b12a772715cb"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.lifecycle.init-to-done.v2",1,"90cd0e1049cc86a38e0b81985f1b9b9275b8a4bc8b2ebcd174d83abfedd17626"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.prompt-measurement-report.v1",1,"b900b5f655dc43ddf2249de4f60f95b7b2b946eabc0c43f9f815a8283234dd5b"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.prompt-measurement.v1",18,"a5321c30d242bd7b0bf4f590b4d008d9f9303b78f22c6d93e9f89dd76b14b27b"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.prompt-role-contract-registry.v1",1,"946ad789b48af1945d82d2bb92aa36172755f557b939d54b86031bbdf4bc9522"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.role-contract.v1",18,"eb7a698e9dc3431cf02d912fe9d24d35f7f35209e34539cc7558bf024e947e0b"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.signed-process-facts.v1",1,"5e728c453cb903f696b07054fdf7cae1e270392d78dc4a3806c2728f8f7ee590"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.story-owner-boundaries.v1",1,"118528694699fb569bd59f2038ea9c2a338ee7c3ed2f5410a056a3227aafa143"],
  ["packages/main/src/core/artifact-release.ts","proof-or-stop.artifact-release.v1",7,"468e13e6f92a21719ec97f4ec21903db5c64cba78ffe2fe5484f70e694fb4dd5"],
  ["packages/main/src/core/candidate-spec-routing.ts","proof-or-stop.candidate-spec-set.v1",3,"8814401c9858f74d298e5456767c163561e89fc1526a04fbd07b2f2a92345daa"],
  ["packages/main/src/core/candidate-spec-routing.ts","proof-or-stop.corpus-index.v1",2,"21e37d460e54d039b597286597ce0aef6d2787328803afee26d8be8cccab04bd"],
  ["packages/main/src/core/candidate-spec-routing.ts","proof-or-stop.keyword-proposal.v1",2,"1d1017acab5e99b67de74ca61454e960527ee9f797ba74b559e79fda73cb10c3"],
  ["packages/main/src/core/candidate-spec-routing.ts","proof-or-stop.keyword-seeds.v1",2,"ae3f7e7a58d68ea822dc7f30c90dacc27b926236b1c7fe56d8612c9347292cae"],
  ["packages/main/src/core/capability-release.ts","proof-or-stop.capability-release-backfill.v1",4,"1b41811713727dfb2af98e6739a994f11cb5e9aa0005b2529f5caa983dae708a"],
  ["packages/main/src/core/capability-release.ts","proof-or-stop.product-capability-release.v1",7,"4a7ed917cdf9b57c1101e776f9a3228650297e7a878954cfe18ade07d50800c8"],
  ["packages/main/src/core/certification-window.ts","proof-or-stop.certification-window.v1",2,"55390816fce64f457e03a28e01a3b0a9a7ae6020fc5d16f28f08bb0cb7ab51e5"],
  ["packages/main/src/core/certification-window.ts", "proof-or-stop.certification_window.v1", 5, "4e3139e2337d0f6fd7518c48ecd2ebc5bad077118a915e608099766a43f6d11d"],
  ["packages/main/src/core/certification-window.ts", "proof-or-stop.certification_windows.v1", 3, "fdb90d7505a3ede59b8fccfef0220a83cbb1175eb9cb8bf4f40dfec885a9759b"],
  ["packages/main/src/core/certification-window.ts","proof-or-stop.precert-receipt.v1",2,"5894229aca4940c6bf82bb9a623db9b3e3cce063b13743f4f1d82fb1140d3c14"],
  ["packages/main/src/core/certification-window.ts", "proof-or-stop.precert_receipt.v1", 5, "5fa2528afd4219d840401427aa3e8755bfe57648312ae19270127d7f5fea8c4f"],
  ["packages/main/src/core/config.ts","proof-or-stop.prompt-envelope-rollout.v1",1,"dc2889324578f66914eba65d50ebc1839180e25e7ea22367b584b18df28a32c0"],
  ["packages/main/src/core/evidence-freshness.ts","proof-or-stop.evidence-freshness-classifier.v1",1,"f1d951fdc4ce3c3d1fcb8ffb355d4ecb69695755185adb135729d922de162fc9"],
  ["packages/main/src/core/evidence-freshness.ts","proof-or-stop.evidence_hash_snapshot.v1",1,"8ce5a7590a66f586e072d6739063d445915757c2241c7db3fe2dcee938632c9c"],
  ["packages/main/src/core/impact-classification-policy.ts","proof-or-stop.impact-classification.v1",2,"44d3864291a1830fdacdbb4f3c8b8e374d1cb5975a9abe08d0476a09beec5e28"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.non-deducible-source.v1",5,"a8f299dd9d289b9a54fde559113c32ef18da859e61ef6ee1328ada76a2c00210"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.non-deducible-sources.v1",5,"5f3a719e2f47e5ceb92d14e11cf3171b29e1a01b53f3c5a436a1bebf986e35f1"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-auto-activation.v1",3,"67ff459fa6d7b6d23d43d0a98cb88c43e047b072657e8c1c6725b3529870530e"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-outcome.v1",4,"907f449eaf19d6e71f1ddcb0c3cd8a28fb754a67680d25fa4c4cbaa7bb4a3525"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-promotion-decision.v1",4,"d004ae6902f8a2956ea7592f6e8540d71d15834bf4f5dafda2e36ea886567363"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-promotion-health.v1",4,"dc5728112910b60da1afe798417f2a6a4c6ae9d9b9a5408101c55012723b8c6a"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-promotion-observe.v1",2,"b5c13c0ad441656a7b4008af2c024a1cbf93174af37fd21d769fa0c6a168e00a"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-trial-control.v1",4,"0ec0eb62f9535ea05deb68ccfcf0b559c6a49d6c43ed214622326e316f0bb6a9"],
  ["packages/main/src/core/lifecycle-control/queue/index.ts","proof-or-stop.queue_exception.v1",6,"b60ea5e327758857c2a6ca8068516fe16d30e7f25f66a7d9af8cc24772d6f15e"],
  ["packages/main/src/core/lifecycle-control/queue/index.ts","proof-or-stop.queue_exception_registry.v1",2,"c7d41d9c671927c014fffafeea3227a9b23ff31d34a05c206a4abe0ec9bd7673"],
  ["packages/main/src/core/lifecycle-control/queue/index.ts","proof-or-stop.queue_exception_set.v1",1,"0fddf6cef9738e9b16c45fbb2f4d843870019e413d9cd60814004c35ad045184"],
  ["packages/main/src/core/lifecycle-control/queue/index.ts","proof-or-stop.queue_governance_status.v1",2,"8e544e5bf321c2b9012ba116ad70e881f7a04dca730259edca1780fa9cc2da0f"],
  ["packages/main/src/core/milestone-status.ts","proof-or-stop.milestone_closeout.v1",2,"7553c0c9f41ccb1edb02aacdc15dbc045483c288c70f3ceae90157913a3eb5c0"],
  ["packages/main/src/core/milestone-status.ts","proof-or-stop.milestone_closeout_missing.v1",2,"3339134b27e4027e6dd8ddf48c6deb63ca1418ef19701bd03364e0ce34e089cf"],
  ["packages/main/src/core/milestone-status.ts","proof-or-stop.milestone_status.v1",4,"353eb282894e74a9b7e686098f5391d4426d78bb5e1fea85910d4085b1820110"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop-memory-baseline-global-",1,"2b964b208939240b26aa8aed7a3489171b69feba7b80b7959ad4cc02e67665dd"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop-memory-baseline-matrix-",1,"d7a0a36b044f6a6f9be5a947791d67a64e9d71b97908e0c4a30cd724601d4208"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop-memory-baseline-runtime-",1,"3743a6d2dc6d66683dd5f570239987acfe10e97f04fb6c78b9ae04a4f6c2f8f9"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop-memory-baseline-runtime-corpus-",1,"ddde57000ff721e4a1db2ab6d9e3ef906de809cf5f40910abb11332bda0599ef"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop.memory-playbook-baseline.gold.v1",1,"0a1c020a16091416b828ecdb8a8ab5af26aa00f15442602d3ff978744dbbcbb0"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop.memory-playbook-baseline.v1",1,"f89f69813c32cfb09b1e040a7cb9db191df371e42319aa94151d9302dc532d8f"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop.memory-playbook-optimized-parity.v1",1,"2fa656065a5488110f8e971d8c339849a9930d38816959ad1dea9cd1daf08f58"],
  ["packages/main/src/core/playbook-runtime-memory-cache.ts","proof-or-stop.runtime-memory-pack-cache.v2",2,"5748cbed7e78b0381574fba3df6fb322a2dbbf10fb01a564a08739e74b74b1c8"],
  ["packages/main/src/core/playbook-runtime-memory-index.ts","proof-or-stop.runtime-memory-index.v3",4,"b76d39882c63ff78d942b606c28030c8cc1d7ecf06216787b790bb00318c6e86"],
  ["packages/main/src/core/playbook-runtime-memory.ts","proof-or-stop.memory-pack.v1",5,"d103aec33749b5a7779ea34ed1918c469b3277927e57f321f2e4b47c5f98af08"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.evidence-activated-advisory-playbook.v1",1,"9f8c22db1e652c8d05fc5c974f6bc220335f9c6b87c68ac9466ea4fe8fa1a807"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-auto-activation.v1",1,"31cf22ff33884fcd903ba3a039bdbb00bbbb5d1c3530dea2b1b11c14d6280d70"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-auto-promotion-apply.v1",2,"783943db80856a71a799643b55c813a131f51819d50b31e5af383f29e28f138a"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-candidate-batch-manifest.v1",4,"6c6984286f527a0a8a6c0ab7bb4960f601ea233271b63c290ec4ea468d4df5b7"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-candidate-ingest.v1",2,"329c50b46658e412a589659c5608b10246148fdc0211f96fc5db32081fa9433b"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-outcome.v1",1,"f683764715ab871d8991af93e96ec516fdf6989bd9048797d68c7169a59b4c05"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-promotion-decision.v1",2,"9b07b262dd06315d705530507bf27726be748700c71e4a83e54633603444dbc5"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-promotion-timer.v1",2,"24e40fca62bb319d90aff63c0d00b03dd21a5a75f77777af3e7f0dea9757a0b9"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-runtime-consumption-verify.v1",2,"5cba148e861efb3061fcd329b236290892612aaebee59e40a9aec39827e9bdab"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-seed-backfill.v1",2,"ebcb135d167cf101c7fcfaf2f5fd7bad3476b44c961de29bf269eb207dc6f99d"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-seed-observe.v1",2,"c93c68552304d39caec83c57bc84f3faefc1fe64f349afa02adfb34e6cbcc951"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-seed-propose-batch.v1",2,"1a2028f9f971baace3735f158c5ed654bebf80dcbecbb9b48b83cb3d7c316fe8"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-trial-control.v1",1,"4d615307511a4257e433ead896c279d2ac75079791d77abdb7236645edbd98ef"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-trial-run.v1",2,"a66d9a196e56b5c697990523a7563ed8b99a7205dbc2ab3a10177a8d72a8b281"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-product-reviewer",3,"65d7305a890d9c64cf4f4c1a3ee6b14a19d7afc7eaa628fc1292c1d9d6d4669f"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-behavior",3,"be17b15404bee444cf91897023aedd8d7691eae2c83a83132babf40c8582c550"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-channel",1,"547c368fabc1d69d4d45a1b1f8fbeaae264857a674c7a0c17262d1d881182cee"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-concept",3,"401b6c29b547d29028942eef2eab0898e0643ca76dc98922ff2f3dcbafb68786"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-delivery",4,"b0764d6f5e401673abda7e491b43827ade9f7e30fe7ac63e2c9c07900b643015"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-docs",3,"ab9e3a2706e26f97d2b7fcfd76acd480d01c0479946c93f868fe1eb865269e1a"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-quality",3,"8886e2a23af6c5c830099d6a6cad6c3b93f074e5e564654ec1e0136cd7dcd496"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-scope-plan",4,"3b42b3e417e35afd01c21acbf0857ee02ccc1d0ef3defd7fd92e10309d6c8a6f"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-story-init",4,"774702674324b1f7879c6fefdcef8663d8bd42d05f7e9b63597aef23335af764"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-test-coverage",3,"b53fc9789e3d6813548afe00f084ede23158acc45875675bbcb113a43b161f75"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-topology-critic",5,"d9555a2fdbdcaa1eef15412c2fe4f81e41a3828af42d3612df8062ad9e49ece6"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop.candidate-spec-set.v1",2,"9b6b2f24e3a72b282badaf7c58e3984d03e73387acf4da4aeb31d060a5bc5119"],
  ["packages/main/src/core/prompt-budget.ts","proof-or-stop-implementer",1,"9fd81a61216e661339bceb520341d5bd0c47b1a3de0902479a17f605b6c60bf5"],
  ["packages/main/src/core/prompt-budget.ts","proof-or-stop-review-delivery",1,"9fd81a61216e661339bceb520341d5bd0c47b1a3de0902479a17f605b6c60bf5"],
  ["packages/main/src/core/prompt-budget.ts","proof-or-stop-review-scope-plan",1,"9fd81a61216e661339bceb520341d5bd0c47b1a3de0902479a17f605b6c60bf5"],
  ["packages/main/src/core/prompt-budget.ts","proof-or-stop-review-story-init",1,"9fd81a61216e661339bceb520341d5bd0c47b1a3de0902479a17f605b6c60bf5"],
  ["packages/main/src/core/prompt-budget.ts","proof-or-stop.prompt-budget-observation.v1",1,"bc70b43954aace4be6d0be4926f55b86fa2a1728118b41d018b73817b9719b50"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.agent-runtime.v1",4,"fb68ef493859dd206307c141027f753fe4f4f88e54c6a35a08025beed609c46c"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.canonical-json.code-point-keys.v1",1,"cef1933b7b6c5b0340b121c5fbf9b24c42d3120e15d23405030d28c1127acf35"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.full-context-assembler.v1",2,"b119e67c6f52a72da678f420137e58628dbf75c8a97f1bdf16c590972330a2ef"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.full-task-context.v1",3,"c2ccd3bdd0a00dfab3c589183d22d77af2f4ebaceea1e71b84fcfc840db0300a"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.incremental-review-basis.v1",3,"8b404edf9782c116f8b9d094f5626afc899dc7674e1c712867831163b94e5890"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.known-execution-environment.v1",3,"7f298863b69dd99176c0b7fba767cdc42511a790c761ed66512964a70ccc6d67"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.prompt-dispatch.v1",2,"e10d43b58b455cb5d0dcdfdb9d37b37ed5cd039666646407e0469379c4a00b36"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.prompt-envelope.v1",3,"2aa929c1efa88afab325c307acb08e2cb843b4d4d2d0525d6d3b5370c43a390b"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.prompt-measurement.v1",3,"eb79b832eb82f99f2ec92dbc9f0d9aee38d663a7cf64f01185a7e6f68df0cb6c"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.role-contract.v1",4,"6bf02ef9f2dae5b643c05f4b487c3fb8b624d4704de2764801c5f694782cef4d"],
  ["packages/main/src/core/prompt-measurement.ts","proof-or-stop.lifecycle.init-to-done.v2",1,"9ce277910bcc869b99aedc1c6183af1188b5be7274d3e00721ba6cc682d3508e"],
  ["packages/main/src/core/prompt-measurement.ts","proof-or-stop.prompt-measurement-report.v1",3,"aeb788cc13ab6f93f3c6c8e640a227795595dac33a547ac8f600086cde13276c"],
  ["packages/main/src/core/prompt-measurement.ts","proof-or-stop.signed-process-facts.v1",1,"2a142b850892073f293b39f20d7eb58620b1fccfe9ae81684a0ab391392edba7"],
  ["packages/main/src/core/prompt-measurement.ts","proof-or-stop.story-owner-boundaries.v1",1,"2ef12a91c586105fd0d95d49479ca6684bd75451489abea9aa578539fb637c8a"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-evaluator",1,"68fcfa5c7dc0912d3e6e65dceacea49603214c7ff22b92c725104c756ffe3bc0"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-implementer",1,"68fcfa5c7dc0912d3e6e65dceacea49603214c7ff22b92c725104c756ffe3bc0"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-behavior",1,"0abb45f1366cd13f605513947231fdb071a041f759ebc24ff811fb62c430e17f"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-concept",1,"0abb45f1366cd13f605513947231fdb071a041f759ebc24ff811fb62c430e17f"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-delivery",1,"68fcfa5c7dc0912d3e6e65dceacea49603214c7ff22b92c725104c756ffe3bc0"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-docs",1,"0abb45f1366cd13f605513947231fdb071a041f759ebc24ff811fb62c430e17f"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-quality",1,"0abb45f1366cd13f605513947231fdb071a041f759ebc24ff811fb62c430e17f"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-scope-plan",1,"68fcfa5c7dc0912d3e6e65dceacea49603214c7ff22b92c725104c756ffe3bc0"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-story-init",1,"68fcfa5c7dc0912d3e6e65dceacea49603214c7ff22b92c725104c756ffe3bc0"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-test-coverage",1,"0abb45f1366cd13f605513947231fdb071a041f759ebc24ff811fb62c430e17f"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-topology-critic",3,"66e2d1168db787712fea28cdb6350b1008a812b75e9be49c5d6f526f24157a57"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop.prompt-registry.v1",9,"e91e32c7fbb2184b1d539a3712ed5c469961068c9559b123383fe8f7c4a8d285"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-evaluator",1,"c92be961323f140446966838401a73e735528f31ef87a0344a27ccfa4f35b91b"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-evaluator-cli",1,"3e8a068a52fdacb6250be32ecaac9b886966d875c0ab3b879d97da05e65ffe51"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-implementation-reviewer",2,"0183fee39fae706c82ba4819cca03396c1052ecd5ab32b7c842987f5aca76a05"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-implementer",1,"dc2c9f5dd02bd758f687d97f87de31e2f268440e2886fa4970683550782de892"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-product-reviewer",2,"2c9fdd46c8090a2a13581e6f06fca6b4f4cbdbee64e682c1558090494e74b774"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-behavior",1,"4da1ee933cca52f7d3ab52ee4dfd3be1a2e11fc76c20f2f5f177e97f482da686"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-channel",3,"67848bdb68a7b98374d94b5a54e9382c20fe2e3428d32739191404f111b15015"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-concept",1,"97446144206c4f867ebda05effef527dfd6761c885f4b75d515ee11fb7ed7c43"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-delivery",2,"70f299febbbe385671dd75590acd32d22d61edac56e105c01eaebba1d070a998"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-docs",1,"af317854885f1906359a4d843875ef482c6c959825b1c4c6a9c406b0d148f6a8"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-quality",2,"939b731c47e4d4edbeadb922acdd66b09c0d73ac63eed530da9c6a06b4e78269"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-scope-plan",1,"14e230e149e56ca51298f1113a17a95af8baacc17487c0e150dbb74f6a3f2a45"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-story-init",1,"206d77915eaa4d0e0523e8ffebad3a201cee3e2348893a68051aa42495a574c1"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-test-coverage",2,"783e6cc807aedd15e5cc59a179d8130d4c542cc6737764e9ace0e070cff5cf10"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-topology-critic",5,"01cbfc8a383326fa0fc26c5bd3883f4a0782a5d150aeb7cf28842391177344ed"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-test-case-reviewer",2,"e92653935944999c34f9d6f7cd6907a815603b4607d36c87a8cba459683ed9c7"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-test-intent",2,"e3399c860195403757ef129066411cf080fd27a6cd810cfaff14b63e102168c2"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-verification-intent",2,"48e182ae65f8b5fb796025190a0c6253c57ad03be63f2e84c0fcad2c89e99de2"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop.prompt-envelope-rollout.v1",3,"6cf43f22aaedbfb2abee51ad2a7b9a9ca13fc3fe2bf947f91c9e56ec5cc051d3"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop.prompt-role-contract-registry.v1",2,"f15b450075b0315c6b7d3ab37920115bbb99793f63ddfac8e740d7bb90d1f3ea"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop.reviewer-host-render-identity.v1",1,"365d4642ea43355f189ba8d6ad8351fc88449ff1c8a23e489e8117adf7ac85f2"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop-review-topology-critic",2,"978e340270cb78b6ad3c053ce6663fb5ce37e520df769d157fb7739205844d15"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review-inventory-critic-receipt.v1",2,"57f069c4d6c987e29e5b037c5cb08cb38390bc3bf2086bb9e14e772c222cb061"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review-inventory-epoch.v1",2,"8370fb367e9815835f99d509213ead0da671604308300f5be150d4710f4b6dd2"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review-inventory-receipt.v1",2,"faa983d2230868758c7bda51f93b01958aa5ec9a23fd611491b9d2be060cbe63"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review_inventory_critic_receipt.v1",1,"dbf7750a5ea4399754c9c621a6378c798ee42112d88331595f454b91f5f7166c"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review_inventory_epoch.v1",3,"1575de0d7ab62c9893ef8dc572430fd7aa3f034fc6d65c1f1632534cb7e6bda2"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review_inventory_epochs.v1",2,"5f3a059ce11b6cf1b599115d22fc96a87433d4b4a0d68dba49c04a25e6c1edcd"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review_inventory_receipt.v1",3,"1e9380a5370e76403c71c426a3620861b53a3790e84ff43829dd36f1b3536ead"],
  ["packages/main/src/core/review-run.ts","proof-or-stop-review-run-integrity-v1",2,"2e34c2f6b44bbd293a9d0181454a84b8d2b96b2727e2f32344b5ba058d57881a"],
  ["packages/main/src/core/review-run.ts","proof-or-stop-review-run-workspace-binding-v1",2,"ef4b314082ba5d7e8209712a7703cb6fba4670412685d0cc844f950c2d55337d"],
  ["packages/main/src/core/review-run.ts","proof-or-stop-review-topology-critic",2,"8665236ef7e20780970268a87325d743a06c594a1dc8245df43697d0d5b679e1"],
  ["packages/main/src/core/review-run.ts","proof-or-stop.review_run_workspace_binding.v1",3,"ebd2c315aa8aef07cbe695f9515b96d5bb2c4c1179eb5831a0d7246dbacef573"],
  ["packages/main/src/core/source-lineage-audit.ts","proof-or-stop.learning-source-key.v1",4,"b4ce85902d753eae474e91f522b6b3a45df7bbc96dc662b2ce728739cae9b1a8"],
  ["packages/main/src/core/source-lineage-audit.ts","proof-or-stop.source-lineage-audit.v1",2,"753b71eb955ac2773da2bf4eee59ddfdcd062af12756f090a7f14ec81a746107"],
  ["packages/main/src/handlers/agent-prompt.ts","proof-or-stop.agent-prompt-response.v1",3,"9aca1853ec68d2b60a8373e0f84b1ba8a146b591f9cc4637b801f4700c24ee8b"],
  ["packages/main/src/handlers/done-effects.ts","proof-or-stop.playbook-promotion-health.v1",2,"60dadb837f637fed6222eacda478b3ec11ad17ed8e67952c6cd7760f3ae901ca"],
  ["packages/main/src/handlers/playbook-runtime-memory.ts","proof-or-stop.dev-memory-finish-decision.v1",1,"b1a24599294674d975c6c461516d3ecb6d9b2a8f5352025513042daeb7834cdb"],
  ["packages/main/src/handlers/playbook-runtime-memory.ts","proof-or-stop.final-response-check.v1",1,"223cf92d48f4da6e18ae4e8cf3710385ec93d57046fd6f74c997b9631954a510"],
  ["packages/main/src/handlers/playbook-runtime-memory.ts","proof-or-stop.playbook-runtime-health.v1",1,"b2c7d4835166f7eda37f51ec06e456a4dd71f4a4f03e9b0dea0fa366b5641cb4"],
  ["packages/main/src/handlers/playbook.ts","proof-or-stop.playbook-outcome.v1",1,"f683764715ab871d8991af93e96ec516fdf6989bd9048797d68c7169a59b4c05"],
  ["packages/main/src/handlers/playbook.ts","proof-or-stop.playbook-promotion-decision.v1",1,"bcd4385e0b76f66f1ba68dac9ac474ef4a95703d7f4e6a7b473b46cc97f668d3"],
  ["packages/main/src/handlers/review-run.ts","proof-or-stop.review_run_list.v1",1,"e07c61407d782cf03b20793f1210d9764c05fe975495bce22ef6b21fc80c4d0c"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-implementer",3,"8db8864574a6ac41052364d1c1b47c53e804adeb859a80edbbae70cad72bd007"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-behavior",1,"455048f4336614857ebce1afe420d6a07dd06d91ad9b65bf28da561588e24137"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-channel",1,"c1c7397b28f000a0dbc575cbf87e4bcb25261d5f75b7022a84b7eaf4a5c2845f"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-concept",1,"0ba1287e59591305f6cb4659ac1deb23762845b6810deac473e6f50c39af7ccf"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-docs",1,"4ddb377e6c2a995fe0c5fd719bb71c99f6b086fb66e8e436ea9afb6ff132884d"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-quality",1,"a2cd9b9ae2556bb3c6e5315fde6421dc73e1567ca28fe31f5d25f8881ba9d412"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-scope-plan",1,"a42de68f06508c39f65881465453d06bba83d27af1662c882a942e5fc513ce10"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-topology-critic",1,"832a75497c422470aaf849da115ea117272279c86905458b2ca5619e7af80714"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop-code-runtime",1,"79c3dbf024b89f303a8738369f67d5cc113ed5fc7bea65c4fdcbe065f90ac4e7"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop.claim_admissibility_pack.v1",3,"b51a97ae59980c2083f627befb6c62b8c389be361d03c100b7d2724c804d36c2"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop.proof_admissibility.v1",3,"3c028112f0b1f93da3fbecf1e2dfa6952488b0a2e7dbb489439991e734b643b3"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop.proof_admissibility_verifier.v1",4,"645a2ea7c013c9e24ce0dece50325583c187b1e38b925a7796d154280a343fa7"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop.quantum_claim_admissibility.v1",3,"a218ad2338fb22a22043547206ca7faddb084d69249f8ffb0a81448ebdbb45e4"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop.quantum_claim_admissibility_verifier.v1",1,"b3acf615693cdaeab156adc531616752117d84a2b3c92a46fa29ea38002e3ca8"],
  ["packages/main/templates/agents/proof-or-stop-evaluator.md","proof-or-stop-evaluator",1,"7435623083b065bf19ec13c0651e4581df85bb2ac781e21b62d359287184269a"],
  ["packages/main/templates/agents/proof-or-stop-implementer.md","proof-or-stop-implementer",1,"c3cd3a9a9d1a95cc12289bdb1cc6927b1868da4c77ce6c087e01d0db796b3527"],
  ["packages/main/templates/agents/proof-or-stop-review-behavior.md","proof-or-stop-review-behavior",1,"a16d2dcf3f64457cbdd038a2533ffe8a488ed09076ebc138d68f0746c910ed5c"],
  ["packages/main/templates/agents/proof-or-stop-review-concept.md","proof-or-stop-review-concept",1,"2f97091366bf2edf9abe200fea67047d97b57a94827400b69f1201e0b2ef54ab"],
  ["packages/main/templates/agents/proof-or-stop-review-delivery.md","proof-or-stop-review-delivery",1,"f23fd7c161a331f7fd3aba838dc6dc5007b594db24750664918d88277b70a824"],
  ["packages/main/templates/agents/proof-or-stop-review-docs.md","proof-or-stop-review-docs",1,"085a2a1cf2ac37eebe59f8df7bc098bf02326efb72706a92ba5a1150088563f8"],
  ["packages/main/templates/agents/proof-or-stop-review-quality.md","proof-or-stop-review-quality",1,"8573bcea18a7525c70d421aa88e1556510f4956c58235dca8e83508aa8456365"],
  ["packages/main/templates/agents/proof-or-stop-review-scope-plan.md","proof-or-stop-review-scope-plan",1,"6005b05edecbbdbb7b14ccb9df99036fc246f039f46672798b8c7ed8b325a3f5"],
  ["packages/main/templates/agents/proof-or-stop-review-story-init.md","proof-or-stop-review-story-init",1,"cd42b34427b3104d10e703309695406a3fb9297cf88373b30be785fa67306ea7"],
  ["packages/main/templates/agents/proof-or-stop-review-test-coverage.md","proof-or-stop-review-test-coverage",1,"4c2b3ce82a5b971ca8d39f58f911223defc33bfc169c2a336576059ce02ff03d"],
  ["scripts/verify-proof-or-stop-identity-cutover.mjs","proof-or-stop.artifact-release.v1",6,"15d2f56ce3c3a824ea064a5e2b20482e79f0e6d31ca9a0f95cc1f9e6a28329b1"],
  ["scripts/verify-proof-or-stop-identity-cutover.mjs","proof-or-stop.product-capability-release.v1",5,"9e175785e3d485403957e9a11018036a99b6290810a877528f32dae433c457a8"],
  ["proof-or-stop.config.json","proof-or-stop-evaluator",1,"036870d52dfd2c953ec925b07b219c25937a93d1d04bc122e90bf08a807ba4c8"],
  ["proof-or-stop.config.json","proof-or-stop-implementer",1,"81dea2ea56a89958ab282359de6536e29230f718fda3678d6641d348938b0e22"],
  ["proof-or-stop.config.json","proof-or-stop-review-behavior",1,"b83a4ca2754542e22437f5d108480d57aee56b85a0fef6c51bfda8fc42bf3ca7"],
  ["proof-or-stop.config.json","proof-or-stop-review-concept",1,"bb11664d29351645373c30772ae0c694283ac92a079a11f694866b237ac60c4c"],
  ["proof-or-stop.config.json","proof-or-stop-review-delivery",1,"f9bf368693043d8c8f36fef896cf0cf0b0eaa10c002547a31892826fa366f144"],
  ["proof-or-stop.config.json","proof-or-stop-review-docs",1,"e1e4ccec3d025eb6a35ef6f0a000bd5280d66e034f6081b12296d9ff8705d46d"],
  ["proof-or-stop.config.json","proof-or-stop-review-quality",1,"45163111e6a00b95e95edf5d02f8e4a64e8650f8ec0b20c5fa72ba4dc3725397"],
  ["proof-or-stop.config.json","proof-or-stop-review-scope-plan",1,"a3f0d25abebfddad9ab3c0ae008174aca96bb4eda6edf47f5d01d49593cfc5a7"],
  ["proof-or-stop.config.json","proof-or-stop-review-story-init",1,"5ea47c68b9182e7ab115b79cb802b35ec1afd5ceba48f34d83f71e7fcf6524a3"],
  ["proof-or-stop.config.json","proof-or-stop-review-test-coverage",1,"32564b076fb47134fc47aee191af578c83a565f5fc5e9c77047302b669d7889c"],
  ["proof-or-stop.config.json","proof-or-stop-review-topology-critic",1,"6d9565bbb95a41a02dff2e93bbcc7f493ff87ce5958d656f1c534e0fc8529099"],
  ["proof-or-stop.config.json", "proof-or-stop.config.json", 14, "e016954e5d457ab0d561bc0bafe2fc8096c4fcc39ea99ea74a34165bd58e5cb6"],
  ["proof-or-stop.config.json","proof-or-stop.prompt-envelope-rollout.v1",1,"3dd20408fa21226f6db5e926c57851e63443785775af0f734591ee2c6384f503"],
].map(([sourcePath, canonical, occurrences, contextSha256]) => ({ sourcePath, canonical, occurrences, contextSha256 }));

export const OWNED_IMPORT_USE_CONTEXTS = [
  {"sourcePath":"packages/main/src/core/git-tree-observation.ts","occurrences":19,"contextSha256":"add70073c7794496189777db23fab2c08e57fb95eafe2c9bd013add0fb11ee8f"},
  {"sourcePath":"packages/main/src/core/executable-digest-observation.ts","occurrences":12,"contextSha256":"4ad68ee819a37a752af8a80fe1b17eddaede59b25761b0f92a2c673a7d42c2d2"},
  {"sourcePath":"packages/main/src/core/maintenance-command-mode.ts","occurrences":0,"contextSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
  {"sourcePath": "packages/main/src/core/acceptance-amendment-journal.ts", "occurrences": 142, "contextSha256": "d28ea6092aab3965a3cd60fe223b52a5a872555987eddbc3dd8759a2556c66e1"},
  {"sourcePath": "packages/main/src/core/convergence-effective-progress.ts", "occurrences": 10, "contextSha256": "bc2270202ea1d97d87984dcb1d4b9b100d761160d5cef8791985d335eff515ed"},
  {"sourcePath": "packages/main/src/core/convergence-progress-journal.ts", "occurrences": 78, "contextSha256": "f10c90cfef4cc8702ef4747345bce332cc539ded292a04fae34ce7dbb304b1fd"},
  {"sourcePath": "packages/main/src/core/store.ts", "occurrences": 415, "contextSha256": "463fd53536b0d5848e1ee356e75024ef42ae831a3d3f06978ed72fbcc2204c7e"},

  {"sourcePath":"packages/main/src/core/delivery-review-authority.ts","occurrences":68,"contextSha256":"d140fc7cff221fdaddf92834a0e97b7fa777608ae309f08b574a6f169c72e893"},
  {"sourcePath": "packages/main/src/core/acceptance-amendment-review.ts", "occurrences": 0, "contextSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},

  {
    "sourcePath": "packages/main/src/core/artifact-release.ts",
    "occurrences": 39,
    "contextSha256": "b95e9b29eb348caf5e4f06a088ff48c7bbda588ee1ed885994d036eee0a0e0a6"
  },
  {"sourcePath": "packages/main/src/core/candidate-spec-routing.ts", "occurrences": 130, "contextSha256": "cae5a9e88c5c0fd437993ba6d31f239c0010fa7d6fd0786bc99f4daa6c60b348"},
  {
    "sourcePath": "packages/main/src/core/capability-release.ts",
    "occurrences": 77,
    "contextSha256": "da05592fe9ce8137db1b38e50343b62c3b6ebfc5ebf4bf20ccc56bafcf0e5ca7"
  },
  {"sourcePath": "packages/main/src/core/certification-window.ts", "occurrences": 65, "contextSha256": "b9c6c0fe1ae6c6868cd307a530afe9ed9f493901a9d88d330de5f519295590b9"},
  {"sourcePath": "packages/main/src/core/config.ts", "occurrences": 82, "contextSha256": "e00e3b3edb548526d08264ec8014522c8609df05f55c8f7ac54c9625076c4bf5"},
  {"sourcePath": "packages/main/src/core/evidence-freshness.ts", "occurrences": 190, "contextSha256": "a1735afb675fd2bebcc2214f9899f1638a03a50d1ecd8299b2f2cdff8eb1c8bb"},
  {
    "sourcePath": "packages/main/src/core/experience-layer-types.ts",
    "occurrences": 0,
    "contextSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  {
    "sourcePath": "packages/main/src/core/impact-classification-policy.ts",
    "occurrences": 2,
    "contextSha256": "22cd0c48dccc24a06725b104fc987d3fe81f8737bd2a73f6b6831976b0ad82a3"
  },
  {
    "sourcePath": "packages/main/src/core/learning-store.ts",
    "occurrences": 110,
    "contextSha256": "cb4347a34f2b75df8af681d08ae104c8270bd258d82d9131d544dbf74f833c92"
  },
  {
    "sourcePath": "packages/main/src/core/lifecycle-control/control-status.ts",
    "occurrences": 0,
    "contextSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  {
    "sourcePath": "packages/main/src/core/lifecycle-control/queue/index.ts",
    "occurrences": 53,
    "contextSha256": "8cb59637cafa3ec554118d5a2a6134d668c14983ad73f73928c28cbff3db0398"
  },
  {
    "sourcePath": "packages/main/src/core/milestone-status.ts",
    "occurrences": 33,
    "contextSha256": "69605cbc54ae31743693b2577300c078fbca243daf24fa1bac24689d5d0c81c0"
  },
  {
    "sourcePath": "packages/main/src/core/playbook-runtime-baseline.ts",
    "occurrences": 420,
    "contextSha256": "68b897e1e59afd15679929b4b0b24a10f59ef8485f21a2bc40bca2ca342512f7"
  },
  {
    "sourcePath": "packages/main/src/core/playbook-runtime-memory-cache.ts",
    "occurrences": 67,
    "contextSha256": "b73da086525fb2d32ec95d2ee0ca184013b72e320e443ec2003a70c66d52d4e4"
  },
  {
    "sourcePath": "packages/main/src/core/playbook-runtime-memory-index.ts",
    "occurrences": 82,
    "contextSha256": "6b811926042e86dd8312554d23f977b7aada9b85c05cc3fe4c9cdc5b350f7b0b"
  },
  {
    "sourcePath": "packages/main/src/core/playbook-runtime-memory.ts",
    "occurrences": 124,
    "contextSha256": "2bf680df4c10f9661cefd9b9d65d07c163ddbe18b080a4051b7605e1ca564340"
  },
  {
    "sourcePath": "packages/main/src/core/playbook-seed.ts",
    "occurrences": 377,
    "contextSha256": "3f79c6ccaf1d5bbca3bbbe8a19b48db43926794b35a6b852e5748c94e04945cf"
  },
  {"sourcePath": "packages/main/src/core/process-fact-registry.ts", "occurrences": 32, "contextSha256": "bda76d115a3c7032cf406769ad1895976162ba85aaa4f8db14dc5ac262524317"},
  {
    "sourcePath": "packages/main/src/core/prompt-budget.ts",
    "occurrences": 4,
    "contextSha256": "b1bc3fea6f42db25be7b71baf9b4a8d4a685fa3127c16e1e9179215e0c77ea22"
  },
  {
    "sourcePath": "packages/main/src/core/prompt-contracts.ts",
    "occurrences": 17,
    "contextSha256": "528ba74400e06c1dd9654a13ee964fed61bb13ca5137e73fa27d901aa5227f35"
  },
  {
    "sourcePath": "packages/main/src/core/prompt-envelope.ts",
    "occurrences": 130,
    "contextSha256": "fd645991675f7f75b089b6387878be8f1876eb16ef317d4244bb0099ca332f68"
  },
  {
    "sourcePath": "packages/main/src/core/prompt-measurement.ts",
    "occurrences": 77,
    "contextSha256": "a36196e3591cb29c3559138ad39ed2c631871c56c0d97bfc1a49e8b92ffe251a"
  },
  {
    "sourcePath": "packages/main/src/core/prompt-registry.ts",
    "occurrences": 64,
    "contextSha256": "c2c708cc827fcd45f8d24a5843a26d59e2d0324fc1b0e776f2e0e1b5a160461b"
  },
  {
    "sourcePath": "packages/main/src/core/prompt-role-contract-registry.ts",
    "occurrences": 137,
    "contextSha256": "fd828982bd0633d28b94af5f8ca03b09e6f6035be4e44495b2ded6a229fc15c1"
  },
  {"sourcePath": "packages/main/src/core/review-incremental-context.ts", "occurrences": 332, "contextSha256": "e04750f29c13f37e7f17b60122b66df61bf715f53ef26f92c9b4403aa0ffa62c"},
  {"sourcePath": "packages/main/src/core/review-inventory-epoch.ts", "occurrences": 63, "contextSha256": "0c751e0c5d92604e461b1fd5d0df82538f3313cc4b3840c818a3a06157972aa7"},
  {"sourcePath": "packages/main/src/core/review-run.ts", "occurrences": 293, "contextSha256": "e70a77d9c0980112eff92daf83103575c63f132ee8ad289eba724056e1718a18"},
  {
    "sourcePath": "packages/main/src/core/source-lineage-audit.ts",
    "occurrences": 131,
    "contextSha256": "ee2d591e1f0fad9b2de7d1cde798eb873dd6e1fc743e6190109d8b6255debade"
  },
  {"sourcePath": "packages/main/src/core/verification-execution-evidence.ts", "occurrences": 307, "contextSha256": "0743090c1c375cda6541dfa5358ce83005efae266f3bea33a801675eee7ddb8a"},
  {"sourcePath": "packages/main/src/handlers/agent-prompt.ts", "occurrences": 130, "contextSha256": "41f4365fe97330bf11de73586d60cda95e7b0c3c408ba67fcef3a0ad1bbddcdf"},
  {"sourcePath": "packages/main/src/handlers/candidate-spec-routing.ts", "occurrences": 98, "contextSha256": "805e2b7f0ad70e9ae12ce6cf5b6f67e44dec22d603a47dc3e6dd626ad3684900"},
  {"sourcePath": "packages/main/src/handlers/checklist.ts", "occurrences": 929, "contextSha256": "3202569cee6b15eb64fdb1e2fac98656cc8eeed4cd619c3d0a16ef7c020afccd"},
  {"sourcePath": "packages/main/src/handlers/done-effects.ts", "occurrences": 295, "contextSha256": "d11789fc61fe6745b79c47cbbc920defc06b8971c2c0cff7b9f5c8bd34768eaf"},
  {
    "sourcePath": "packages/main/src/handlers/playbook-runtime-memory.ts",
    "occurrences": 66,
    "contextSha256": "9c7acfd9ea18acb7500db7e70ac6d6ba984db239b75834160042ba4a13897883"
  },
  {
    "sourcePath": "packages/main/src/handlers/playbook.ts",
    "occurrences": 297,
    "contextSha256": "40a0d7eb4476cc7d20ed1b91a0e1be4e6c5cb70d0422b70dcacd5ccca7c17477"
  },
  {"sourcePath": "packages/main/src/handlers/review-run.ts", "occurrences": 237, "contextSha256": "9b3fa36ca2e4c05deecf4f0f7fc428043a3e00302e3140d2efd238c9859d8896"},
  {"sourcePath": "packages/main/src/handlers/story-dispatch.ts", "occurrences": 342, "contextSha256": "c8a7cd5c5e2137aef624f99cd9605fac7fb407d77eefb0d8c4f78ec58cc08957"},
  {
    "sourcePath": "packages/main/src/core/claim-admissibility/pack-framework.ts",
    "occurrences": 49,
    "contextSha256": "ccd4fe3e8ae44b0b260c36ee4ed2c71d095e98d904df2d200655aa1360d91fea"
  },
  {"sourcePath": "packages/main/src/cli-init.ts", "occurrences": 521, "contextSha256": "d10e5c27a6c8083295649d2ec4c932763b26c71f3d3595e2254b4338aedd3de6"},
  {"sourcePath":"scripts/verify-proof-or-stop-identity-cutover.mjs","occurrences":576,"contextSha256":"9faf50d76aeac99b60428270dba913500179d2df8efb766945871f8b1c8c13a1"}
];

export const ACTIVE_STORY_IDENTITY_PATHS = Object.freeze([
  Object.freeze({ artifact: 'scope-boundary.json', path: 'schemaVersion', kind: 'schema' }),
  Object.freeze({ artifact: 'scope-boundary.json', path: 'confirmedBy', kind: 'command' }),
  Object.freeze({ artifact: 'execution-boundary.json', path: 'schemaVersion', kind: 'schema' }),
  Object.freeze({ artifact: 'execution-boundary.json', path: 'confirmedBy', kind: 'command' }),
  Object.freeze({ artifact: 'scope-freeze-check.json', path: 'schemaVersion', kind: 'schema' }),
  Object.freeze({ artifact: 'init-check.json', path: 'agentId', kind: 'agent' }),
  Object.freeze({ artifact: 'init-check.json', path: 'agentResults.*.agentId', kind: 'agent' }),
  Object.freeze({ artifact: 'index.json', path: 'events.*.agent', kind: 'agent' }),
  Object.freeze({ artifact: 'owner-lease.json', path: 'command', kind: 'command' }),
  // A managed INIT dispatch persists the reviewer prompt envelopes it delivered, so the
  // fresh Story fixture now carries this artifact; its schema identities stay bound by the
  // canonical-value assertion below like every other registered path.
  Object.freeze({ artifact: 'prompt-envelopes.json', path: 'envelopes.*.schemaVersion', kind: 'schema' }),
]);

export const ACTIVE_IDENTITY_KEYS = new Set(['schemaVersion', 'agentId', 'agent', 'role', 'command', 'environment', 'config', 'product', 'runtime', 'confirmedBy']);

export const artifactAppendMutations = [
  ['retired schema', record => ({ ...record, schemaVersion: record.schemaVersion.replace(/^proof-or-stop\./, retiredProtocolPrefix) })],
  ...identityLookalikes(ARTIFACT_RELEASE_SCHEMA_VERSION).map(({ kind, value }) => [
    `${kind} schema`, record => ({ ...record, schemaVersion: value }),
  ]),
  ['missing schema', ({ schemaVersion: _schemaVersion, ...record }) => record],
  ['invalid shape', record => ({ ...record, paths: null })],
];
