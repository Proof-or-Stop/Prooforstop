export const PROCESS_CAPABILITY_CATALOG = Object.freeze([
  {
    "id": "support",
    "module": "./support.mjs",
    "checks": [
      "assertCapabilityMaterialContract"
    ]
  },
  {
    "id": "proofstory-closeout",
    "module": "./proofstory-closeout.mjs",
    "checks": [
      "assertProofStoryProgressiveBoundary",
      "assertProofStoryGateConsumedFacts",
      "assertCloseoutTrustBoundary"
    ]
  },
  {
    "id": "reopen",
    "module": "./reopen.mjs",
    "checks": [
      "assertPhaseTransitionReopenAuditContract",
      "assertOutOfBandReopenAuditRescueContract",
      "assertReopenAuditConcurrencyResidualContract",
      "assertReopenAuditLockRejectionRationaleContract"
    ]
  },
  {
    "id": "prompt-contracts",
    "module": "./prompt-contracts.mjs",
    "checks": [
      "assertSyntheticAdversarialChecks"
    ]
  },
  {
    "id": "review-inventory",
    "module": "./review-inventory.mjs",
    "checks": [
      "assertValidationPersistenceTransactionContract",
      "assertReviewInventoryRemediationContract"
    ]
  },
  {
    "id": "registry-parser",
    "module": "./registry-parser.mjs",
    "checks": [
      "assertDonePreflightPredicateInventoryParity"
    ]
  },
  {
    "id": "command-contracts",
    "module": "./command-contracts.mjs",
    "checks": [
      "assertAcceptanceTopologyLifecycleFilenameContract"
    ]
  },
  {
    "id": "review-verification",
    "module": "./review-verification.mjs",
    "checks": [
      "assertCurrentPromptIdentityBoundary",
      "assertActiveLifecycleDocGuidance",
      "assertReviewRoundIsoDocs",
      "assertEvidenceBoundaryDocs",
      "assertCurrentVerificationReceiptModel"
    ]
  },
  {
    "id": "scope-runtime",
    "module": "./scope-runtime.mjs",
    "checks": [
      "assertLifecycleArtifactScopePolicy",
      "assertStrengtheningRoadmapGovernanceLedger",
      "assertParentRoadmapIntentTotalityPlan",
      "assertParentRoadmapTotalityRuntime",
      "assertStoryAwareDynamicValidationRuntime",
      "assertPromptMeasurementObservationBoundary",
      "assertStoryWriterRuntimeAdmissionContract",
      "assertProcessFactCommandInventory"
    ]
  },
  {
    "id": "story3",
    "module": "./story3.mjs",
    "checks": [
      "runStory3Contract"
    ],
    "obligations": [
      "assertStory3ProcessFactContract"
    ]
  }
]);
