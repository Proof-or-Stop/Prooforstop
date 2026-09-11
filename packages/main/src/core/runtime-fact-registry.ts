// DEV acceptance transport uses only proof-or-stop.acceptance_amendment_review_final.v1; old inner schemas cannot be produced or consumed. The outer worker-signed receipt remains a compatibility container, never an alias for the inner schema.
export const REVIEWER_BATCH_PRODUCER_RUNTIME_POLICY = { versionTimeoutMs: 10000, readinessTimeoutMs: 30000, maxRecordBytes: 4194304, ordinaryProfile: 'managed_reviewer', generatedPathPlan: { schema: 'batch-generated-paths.v1', probeCwd: 'canonical-verified-subject-workspace', providerHome: 'controller/provider-seeds/work/generation/host/provider-host', probeTemp: 'controller/provider-seeds/work/generation/host/tmp', lanePaths: 'separately-sealed-readonly-layout-no-base-env-omission' } } as const;
export const MANAGED_PROVIDER_SEED_RUNTIME_POLICY = { maxFiles: 2, encodedFileMultiplier: 4, envelopeAllowanceBytes: 4096 } as const;
export const MANAGED_EXECUTION_IDENTITY_RUNTIME_POLICY = { keyBytes: 32, maxExecutableBytes: 256 * 1024 * 1024, readChunkBytes: 64 * 1024 } as const;
export const REVIEWER_BATCH_ADMISSION_RUNTIME_POLICY = { maxWaitMs: 10000, readyTtlMs: 60000, lockStaleMs: 200, lockDeadlineMs: 500, lockPollMs: 20, waitPollMs: 25 } as const;
export const MANAGED_REVIEW_READONLY_RUNTIME_POLICY = { adapter: 'prooforstop-main-v1', providerStateAdapter: 'isolated-file-cache-v1', providerFileMaxBytes: 1024*1024, platform: 'darwin', buildTimeoutMs: 180000, builderGraceMs: 5000, capabilityTimeoutMs: 3000, directoryMode: 0o700, environmentKeys: ['TMPDIR','TMP','TEMP','XDG_CACHE_HOME','PROOF_OR_STOP_REVIEW_BUILD_SOURCE','PROOF_OR_STOP_REVIEW_BUILD_OUTPUT'], credentials: 'original-read-only-private-copy-refresh-writable', writable: 'declared-lane-output-temp-cache-only' } as const;
export const SUPERVISED_PROVIDER_RUNTIME_POLICY = { termGraceMs: 250, closeWaitMs: 300, parentGraceMs: 3000, maxOutputBytes: 8 * 1024 * 1024 } as const;
export const MACHINE_PROVIDER_ADMISSION_RUNTIME_POLICY = { maxConcurrent: 4, directoryMode: 0o700, scope: 'same-os-user-across-projects' } as const;
export const MACHINE_HEAVY_RESOURCE_POLICY = { cpuKey: 'heavy', processKey: 'fanout', access: 'exclusive', admission: 'one-heavy-member-per-os-user' } as const;
export const MACHINE_FIXED_PORT_RUNTIME_POLICY = { directoryMode: 0o700, probeTimeoutMs: 1000, queueDeadlineMs: 300000, scope: 'same-os-user-across-repositories', admissionBoundary: 'actual-command-child', unknownResources: 'exclusive-machine-queue', classifiedEmptyResources: 'shared-machine-barrier', barrierKey: 'admission' } as const;
export const MANAGED_REVIEW_TEMP_RUNTIME_POLICY = { environmentKeys: ['TMPDIR', 'TMP', 'TEMP'], directoryMode: 0o700, isolation: 'per-managed-review-scratch' } as const;

export const REQUIRED_RUNTIME_FACT_IDS = [
  'entrypoint-authority',
  'cli-entrypoint',
  'global-core-realpath',
  'project-local-bin',
  'node-version',
  'package-version',
  'validate-source',
  'external-reference-policy',
] as const;

/**
 * Gate-evidence runtime facts are not doctor/environment checks. They describe
 * the local execution/capture boundary and are verified by the runtime contract
 * alongside (but never inserted into) REQUIRED_RUNTIME_FACT_IDS.
 */
export const RUNTIME_EVIDENCE_FACT_REGISTRY = [
  {
    id: 'verification-output-integrity',
    owner: 'verification-execution-evidence',
    semantics: 'Canonical artifact digest and embedded complete-output digest are both verified on every authoritative read.',
  },
  {
    id: 'verification-receipt-layering',
    owner: 'verification-execution-evidence',
    semantics: 'Selector-free execution receipts and per-intent assertion receipts are independently digested; V2 assertions and V5 bundles bind executed versus reused publication and the exact reuse digest, while legacy receipts remain readable but non-reusable and non-promotable.',
  },
  {
    id: 'verification-receipt-authenticity',
    owner: 'verification-execution-evidence + authority-signing',
    semantics: 'Execution, every per-intent assertion, reuse lineage, and V5 publication context are independently Ed25519-signed with domain separation and verified against the fixed git-common-dir trusted key; publication binds Story, exact freshness tuple, mode, and every component/artifact link. Embedded key replacement, unsigned outer tuple rewrites, and whole-graph digest recomputation fail closed.',
  },
  {
    id: 'verification-input-scoped-reuse',
    owner: 'verification-execution-evidence',
    semantics: 'A v5 reused publication is admissible only when its required ReuseReceipt and digest-bound mode agree and command, argv, cwd, effective timeout, capture semantics, closed environment, toolchain, platform, architecture, Node, policy-owned capsule manifest, and evidence input digest are mechanically complete and unchanged.',
  },
  {
    id: 'verification-reuse-capsule-authority',
    owner: 'verification-reuse-capsule',
    semantics: 'Only the exact policy-owned declarative capsule may authorize input-scoped reuse; self-attested v1 manifests and arbitrary commands remain strict-fallback evidence, while Node permissions and a closed environment deny undeclared reads, network, writes, child processes, loaders, preloads, and permission widening.',
  },
  {
    id: 'verification-execution-producer-lock',
    owner: 'verification-execution-evidence',
    semantics: 'One selector-free repository-local execution key serializes add, batch, run, and stale-refresh publishers with asynchronous unique acquisition tickets. Live or uncertain owners survive heartbeat expiry; only a proven-dead local owner permits exact-ticket reclaim. Release and heartbeat never touch a successor, and legacy, mixed or malformed ownership fails closed. Batches lock sorted unique keys; waiters independently assert newly published full output while coordination is held through atomic publication.',
  },
  {
    id: 'verification-lifecycle-admissibility',
    owner: 'proof-admissibility',
    semantics: 'Lifecycle coverage validates the V5 bundle, V3 execution, V2 assertion, required mode-specific V1 reuse lineage, immutable selector, bundle cross-links, and full-output artifact integrity; prose, legacy, malformed, or caller-shaped records cannot satisfy executable gates. Shared producer paths retain distinct public-operation identity sites and complete independent literal/import inventory; signer-key filenames and reviewer-role identities remain bound alongside receipt schemas.',
  },
  {
    id: 'verification-current-execution-identity',
    owner: 'proof-admissibility + checklist + done-prepare',
    semantics: 'Gate, refresh, and DONE share current/stale-needs-execution/invalid classification for every tool-executed pin, including docs/manual and ordinary non-reusable commands. Receipt-less unpinned legacy metadata maintenance remains a separate non-authoritative scheduling path: it cannot mint execution authority and demotes unexecuted command-backed passes. Child executable bytes are resolved through the actual invocation environment and child cwd, with the absolute host runtime bound separately; invocation-selected closed environment is independent of manifest reuse eligibility. Unprovable executable resolution fails closed. Live environment/toolchain/input drift requires actual execution; invalid authenticated command or publication bindings cannot be renewed implicitly. Authentic V4 is audit-only and needs true V5 renewal.',
  },
  {
    id: 'verification-inventory-observation-projection',
    owner: 'review-inventory-epoch',
    semantics: 'The store-backed inventory consumer authenticates the complete receipt and artifact before applying a versioned observation/input whitelist; genuine same-output same-input re-execution and authorized reuse preserve semantics, while changed inputs/output, tamper, and independent epoch material/scope cutoffs remain enforced.',
  },
] as const;

export type RuntimeFactId = typeof REQUIRED_RUNTIME_FACT_IDS[number];

export type RuntimeFactScope = 'all' | 'self' | 'external';
export type RuntimeFactSeverity = 'hard' | 'warn' | 'advisory';

export type RuntimeFactChecker =
  | 'resolveEntrypointAuthority'
  | 'resolveCliEntrypoint'
  | 'resolveGlobalCoreRealpath'
  | 'resolveProjectLocalBin'
  | 'resolveNodeVersion'
  | 'resolvePackageVersion'
  | 'resolveValidateSource'
  | 'scanExternalReferencePolicy';

export const RUNTIME_FACT_OUTPUT_KEYS = {
  'entrypoint-authority': 'runtimeEntrypointAuthority',
  'cli-entrypoint': 'cliEntrypoint',
  'global-core-realpath': 'globalCoreRealpath',
  'project-local-bin': 'projectLocalBin',
  'node-version': 'nodeVersion',
  'package-version': 'packageVersion',
  'validate-source': 'validateSource',
  'external-reference-policy': 'externalReferencePolicy',
} as const satisfies Record<RuntimeFactId, string>;

export type RuntimeFactOutputKey = typeof RUNTIME_FACT_OUTPUT_KEYS[RuntimeFactId];

export interface RuntimeFactRegistryEntry {
  id: RuntimeFactId;
  scope: RuntimeFactScope;
  selfSeverity: RuntimeFactSeverity;
  externalSeverity: RuntimeFactSeverity;
  checker: RuntimeFactChecker;
  outputKey: RuntimeFactOutputKey;
  rationale: string;
  driftMessage: string;
  repairHint?: string;
}

export const RUNTIME_FACT_REGISTRY = [
  {
    id: 'entrypoint-authority',
    scope: 'all',
    selfSeverity: 'hard',
    externalSeverity: 'advisory',
    checker: 'resolveEntrypointAuthority',
    outputKey: 'runtimeEntrypointAuthority',
    rationale: 'Every command in the command-policy-derived actual Story-write capability registry must execute the runtime belonging to the target self-project checkout, independent of owner/reviewer/dangerous/shared ownership class. Admitted extensions with intrinsic effective storyScopedMutating or reviewerWrite ownership share the same raw and final admission predicate without requiring a built-in command name. The command-bound active identity registry also rejects retired protocol bytes in each corresponding loaded producer/consumer before handlers or writes. An invalid prompt-envelope version checks its loaded boundary before the early config error, preserves the unsupported-version rejection prefix, and never falls back to defaults; valid config keeps its fast path. Eager role-policy rejection preserves unknown-role ordering and derives only missing canonical source sites from the independent package snapshot, never alias normalization. The dependency manifest, manifest binding, inventory observation and receipt bundle are registered as exact active identity sites with coupled negative controls. The four registered executable modules include the actual verification receipt producer and checklist consumers, with independently reviewed syntax fingerprints binding their declaration, producer, consumer and neighbouring identity behavior against decoys and rewiring. Exact value checks execute before the syntax guard. One byte snapshot supplies all checks in each invocation. Root configuration references retain an exact occurrence binding. Argument-aware read-only variants remain diagnostic-only.',
    driftMessage: 'The active CLI runtime is not authoritative for the target self-project checkout.',
    repairHint: 'From the target checkout, retry the same command with `node bin/proof-or-stop.js`.',
  },
  {
    id: 'cli-entrypoint',
    scope: 'all',
    selfSeverity: 'hard',
    externalSeverity: 'warn',
    checker: 'resolveCliEntrypoint',
    outputKey: 'cliEntrypoint',
    rationale: 'The CLI path determines which installed Proof-or-Stop runtime answers user commands.',
    driftMessage: 'The proof-or-stop executable on PATH is missing or does not resolve to the expected runtime.',
    repairHint: 'Run `command -v proof-or-stop`, rebuild/link the intended package, or use `node packages/main/dist/cli.js` for current-worktree checks.',
  },
  {
    id: 'global-core-realpath',
    scope: 'all',
    selfSeverity: 'hard',
    externalSeverity: 'warn',
    checker: 'resolveGlobalCoreRealpath',
    outputKey: 'globalCoreRealpath',
    rationale: 'Global @proof-or-stop/core drift makes bare `proof-or-stop` commands run stale handlers.',
    driftMessage: 'The globally installed @proof-or-stop/core realpath does not match the expected Proof-or-Stop core package.',
    repairHint: 'Relink or reinstall the global @proof-or-stop/core package, then rerun `proof-or-stop doctor --format=json`.',
  },
  {
    id: 'project-local-bin',
    scope: 'all',
    selfSeverity: 'warn',
    externalSeverity: 'warn',
    checker: 'resolveProjectLocalBin',
    outputKey: 'projectLocalBin',
    rationale: 'A project-local node_modules/.bin/proof-or-stop can shadow the global CLI inside npm scripts or modified PATHs.',
    driftMessage: 'A local proof-or-stop binary is present and may override the intended CLI entrypoint.',
    repairHint: 'Inspect `node_modules/.bin/proof-or-stop`, adjust PATH, or remove stale local installs before trusting bare CLI output.',
  },
  {
    id: 'node-version',
    scope: 'all',
    selfSeverity: 'warn',
    externalSeverity: 'advisory',
    checker: 'resolveNodeVersion',
    outputKey: 'nodeVersion',
    rationale: 'Node runtime version affects ESM loading, built-in APIs, and child process behavior.',
    driftMessage: 'The current Node runtime is below Proof-or-Stop runtime expectations.',
    repairHint: 'Use Node 20 or newer for Proof-or-Stop development and runtime checks.',
  },
  {
    id: 'package-version',
    scope: 'all',
    selfSeverity: 'hard',
    externalSeverity: 'advisory',
    checker: 'resolvePackageVersion',
    outputKey: 'packageVersion',
    rationale: 'Package version drift makes global and local Proof-or-Stop outputs hard to compare.',
    driftMessage: 'Proof-or-Stop package versions disagree between the current runtime, repository root, or global install.',
    repairHint: 'Align root/package versions and rebuild before publishing or using the global CLI as evidence.',
  },
  {
    id: 'validate-source',
    scope: 'all',
    selfSeverity: 'warn',
    externalSeverity: 'warn',
    checker: 'resolveValidateSource',
    outputKey: 'validateSource',
    rationale: 'Validation evidence depends on whether Proof-or-Stop uses explicit validate files, configured commands, or advisory fallback discovery.',
    driftMessage: 'No explicit validation source is configured, or Proof-or-Stop is relying on fallback discovery.',
    repairHint: 'Add validate.ts/js/mts or configure validate.command(s) in proof-or-stop.config.json.',
  },
  {
    id: 'external-reference-policy',
    scope: 'all',
    selfSeverity: 'warn',
    externalSeverity: 'warn',
    checker: 'scanExternalReferencePolicy',
    outputKey: 'externalReferencePolicy',
    rationale: 'External service and memory references must be policy-scanned without pretending connectivity was verified.',
    driftMessage: 'A bounded docs/config scan found external references without explicit health-check semantics.',
    repairHint: 'Document the owning health command or mark the reference as policy-only; localhost examples are treated as internal.',
  },
] as const satisfies readonly RuntimeFactRegistryEntry[];

export function runtimeFactIds(): RuntimeFactId[] {
  return RUNTIME_FACT_REGISTRY.map((entry) => entry.id);
}

export function runtimeFactOutputKeys(): RuntimeFactOutputKey[] {
  return RUNTIME_FACT_REGISTRY.map((entry) => entry.outputKey);
}

export function getRuntimeFactEntry(id: RuntimeFactId): RuntimeFactRegistryEntry {
  const entry = RUNTIME_FACT_REGISTRY.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`unknown runtime fact: ${id}`);
  return entry;
}

/** Optional self-maintenance runtime; this does not raise the general CLI floor. */
export const LAB_MAINTENANCE_RUNTIME_REQUIREMENTS = {
  scope: 'self-maintenance-only',
  nativeTypeScript: true,
  synchronousModuleHooks: true,
  execution: 'checkout-source',
  globalInstallationMutation: false,
} as const;


/** Conservative defaults consumed by official validation, independent of Lab. */
export const VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS = {
  declaredInvocationCapacity: 2,
  duplicateResourceClaims: 'one-per-exact-normalized-claim',
  ownerLeaseHeartbeatMs: 30000,
  ownerLeaseLossDuringCapacityWait: 'abort-before-callback-preserving-caller-cancellation',
  unknownResources: 'exclusive',
  receiptReusePolicy: 'exact-inputs',
} as const;

/** In-process scheduler coordination does not replace machine-wide leases. */
export const KEYED_SCHEDULER_RUNTIME_POLICY = {
  resourceOwnership: 'shared-within-module-instance',
  cancellationOwnership: 'per-invocation',
  blockedCancellationPollMs: 50,
} as const;

export const SCOPE_BUDGET_DECISION_RUNTIME_POLICY = {
  approvalLifetimeMs: 7 * 24 * 60 * 60 * 1000,
  agentEnvironmentMarkers: ['PROOF_OR_STOP_AGENT', 'LATTICE_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGY_SESSION_ID', 'ANTIGRAVITY_SESSION_ID',
    'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT', 'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK'],
  authority: 'interactive-operator-acknowledgement-not-proof-of-human-identity',
} as const;

/** Sealed at managed submit; provider text cannot change these supervisor limits. */
export const MANAGED_BURN_RUNTIME_POLICY = {
  tokenLimitEnvironment: 'PROOF_OR_STOP_MANAGED_BURN_TOKEN_LIMIT',
  defaultTokenLimit: 100_000_000,
  progressCheckIntervalMs: 5_000,
  terminalReason: 'burn_without_effective_progress',
  unknownProgress: 'advisory',
  usageAuthority: 'bounded-provider-stdout-event',
  closeAuthority: 'provider-child-close-before-cleanup',
} as const;

/** Single and aggregate observers share delivery acknowledgement semantics. */
export const MANAGED_STATUS_OBSERVATION_POLICY = {
  observation: 'read-only',
  cursor: 'generation-acknowledges-progress-and-terminal-delivery',
  firstTerminalObservation: 'immediately-actionable',
  heartbeat: 'not-provider-progress',
  implementation: 'core/managed-host-run.ts',
} as const;

/** Independent recovery must survive both the submitting CLI and its worker. */
export const MANAGED_SUPERVISOR_RUNTIME_POLICY = {
  readyTimeoutMs: 5_000,
  pollIntervalMs: 1_000,
  diagnosticGraceMs: 5_000,
  stalledStageMs: 30_000,
  orphanReason: 'worker_orphaned',
  launchOrder: 'supervisor-ready-before-worker',
  cleanupAuthority: 'recorded-provider-process-identity',
} as const;

/** Independent early diagnostics must survive unavailable runtime dependencies. */
export const ENTRY_PREFLIGHT_RUNTIME_POLICY = {
  entry: 'scripts/entry-preflight.mjs',
  bootstrapDependencies: 'node-builtins-only',
  probeTimeoutMs: 30_000,
  unavailable: 'not-pass',
  authority: 'diagnostic-only',
} as const;

/** Local fast diagnostics execute actual negative controls; elapsed time is not cohort evidence. */
export const PRECERT_FAST_RUNTIME_POLICY = {
  entry: 'scripts/run-precert-fast.mjs',
  registry: 'scripts/precert-fast-contracts.mjs',
  invocationBudgetMs: 180_000,
  result: 'exit-pass-and-exact-unique-contract-marker',
  unsupported: 'not-pass',
  scheduling: 'serial-within-invocation',
  processOwner: 'full-suite-runner-isolated-run-state',
  authority: 'diagnostic-until-consumed-by-validate',
} as const;

/** Local duration estimates are optional observations, never progress or evidence. */
export const MANAGED_DURATION_ESTIMATE_RUNTIME_POLICY = {
  minSamples: 5, maxSamples: 20, maxDirectoryEntries: 256,
  maxCandidateArtifactBytes: 16 * 1024 * 1024, maxArtifactBytes: 1024 * 1024,
  scanTargetMs: 200, maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  sampleBoundary: 'same-host-phase-agent-profile-lane-completed-replacement-safe',
  acquisition: 'once-before-spec-sealing',
  timeBudgetBoundary: 'between-candidates-not-hard-IO-deadline',
  byteBudgetBoundary: 'candidate-artifact-size-not-physical-read-count',
  statusHistoryReads: 'none',
  authority: 'diagnostic-only',
} as const;

/** Shared contract with the CJS preloader, checked by runtime contract verification. */
export const VALIDATION_RUNTIME_TRACE_POLICY = { schemaVersion: 'validation-runtime-trace.physical-read.v2', readIdentity: 'call-time-physical-path-observation' } as const;

/** Executor-owned before/after source observations required for reusable receipts. */
export const VALIDATION_SOURCE_PROVENANCE_SCHEMA = 'validation-source-provenance.v1' as const;

/** The existing Graph status poll consumes only verified retained run projections. */
export const MANAGED_RUN_DASHBOARD_POLICY = {
  maxDirectoryEntries: 1000,
  maxScanBytes: 64 * 1024 * 1024,
  maxRuntimeArtifactBytes: 128 * 1024 * 1024,
  authority: 'read-only-operational-projection',
} as const;

/** Optional explicit host transport pin; no package-version equality fallback. */
export const EXECUTION_IMPLEMENTATION_PIN_POLICY = {
  schema: 'execution-implementation.v1',
  sessionSchema: 'execution-session.v1',
  witnessSchema: 'execution-session-witness.v1',
  activityWitness: 'existing-records-only-entry-admission-or-unverified',
  sessionEntryTransport: 'inherited-node-entry.v1',
  legacyEntryPolicy: 'preload-refuses-unapproved-recognized-cli-before-old-core',
  hostTimeoutCleanup: 'pipe-lifetime-anchor-owned-posix-group-or-direct-child-fallback',
  hostCompletionCleanup: 'flushed-output-live-anchor-group-signal-required-before-success',
  hostAnchorScope: 'plain-host-no-managed-pid-observer-or-invocation-descriptor',
  mismatch: 'refuse-before-dispatch',
  missingWhenRequired: 'refuse',
  scope: 'loaded-core-bootstrap-workspace-extensions-dependency-closure-and-node',
} as const;
