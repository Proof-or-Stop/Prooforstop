export const HOST_RUN_BUDGET_RUNTIME_POLICY = { lockTimeoutMs: 2000, maxStateBytes: 8 * 1024 * 1024, scope: 'explicit-group-canonical-project', crash: 'retain-reservation' } as const;
import { posix as pathPosix } from 'node:path';

/** Per-plan synchronous provider admission; does not govern desktop model calls. */
export const PLANNED_PROVIDER_BUDGET_RUNTIME_POLICY = {
  minimumAttemptTimeoutMs: 1,
  admission: 'before-provider-transport',
  attemptAccounting: 'reported-attempts-not-step-count',
  scope: 'single-planned-execution',
} as const;

/** Bounded history transport; larger or incomplete Git output remains invalid. */
export const REVIEW_MAINTENANCE_GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// DEV acceptance transport uses only proof-or-stop.acceptance_amendment_review_final.v1; old inner schemas cannot be produced or consumed. The outer worker-signed receipt remains a compatibility container, never an alias for the inner schema.
export const REVIEWER_BATCH_PRODUCER_RUNTIME_POLICY = { versionTimeoutMs: 10000, readinessTimeoutMs: 30000, maxRecordBytes: 4194304, ordinaryProfile: 'managed_reviewer', generatedPathPlan: { schema: 'batch-generated-paths.v1', probeCwd: 'canonical-verified-subject-workspace', providerHome: 'controller/provider-seeds/work/generation/host/provider-host', probeTemp: 'controller/provider-seeds/work/generation/host/tmp', lanePaths: 'separately-sealed-readonly-layout-no-base-env-omission' } } as const;
export const MANAGED_PROVIDER_SEED_RUNTIME_POLICY = { maxFiles: 2, encodedFileMultiplier: 4, envelopeAllowanceBytes: 4096 } as const;
export const MANAGED_EXECUTION_IDENTITY_RUNTIME_POLICY = { keyBytes: 32, maxExecutableBytes: 256 * 1024 * 1024, readChunkBytes: 64 * 1024 } as const;
export const REVIEWER_BATCH_ADMISSION_RUNTIME_POLICY = { maxWaitMs: 10000, readyTtlMs: 60000, lockStaleMs: 200, lockDeadlineMs: 500, lockPollMs: 20, waitPollMs: 25 } as const;
export const MANAGED_REVIEW_READONLY_RUNTIME_POLICY = { crossHostProviderSandbox: { confined: 'danger-full-access', unconfined: 'read-only' }, adapter: 'prooforstop-main-v1', providerStateAdapter: 'isolated-file-cache-v1', providerFileMaxBytes: 1024*1024, platform: 'darwin', buildTimeoutMs: 180000, builderGraceMs: 5000, capabilityTimeoutMs: 3000, directoryMode: 0o700, environmentKeys: ['TMPDIR','TMP','TEMP','CLAUDE_CODE_TMPDIR','XDG_CACHE_HOME','PROOF_OR_STOP_REVIEW_BUILD_SOURCE','PROOF_OR_STOP_REVIEW_BUILD_OUTPUT'], optionalEnvironmentKeys: ['PROOF_OR_STOP_REVIEW_EXECUTION_CWD'], credentials: 'original-read-only-private-copy-refresh-writable', writable: 'sealed-source-plus-disposable-execution-worktree-and-declared-output-temp-cache' } as const;
export const SUPERVISED_PROVIDER_RUNTIME_POLICY = { termGraceMs: 250, closeWaitMs: 300, parentGraceMs: 3000, maxOutputBytes: 8 * 1024 * 1024 } as const;
export const MACHINE_PROVIDER_ADMISSION_RUNTIME_POLICY = { maxConcurrent: 4, directoryMode: 0o700, scope: 'same-os-user-across-projects' } as const;
// The parent includes launcher registration and proven group cleanup; the
// worker retains its existing execution limit. This is test infrastructure only.
export const FINDING_EVIDENCE_FIXTURE_RUNTIME_POLICY = {
  workerMs: 120000, lifecycleMarginMs: 30000, controllerMs: 150000,
} as const;
// Registered verifiers use 260s and 180s. Keep the existing composite envelope:
// 300s covers public/package fixtures and 640s is explicit conservative headroom,
// not a claim that any verifier has a 900s allowance. The budget regression binds
// this sum to the actual registrations. Other identity witnesses remain separate.
export const IDENTITY_CERTIFICATION_RUNTIME_POLICY = {
  runtimeGroupMs: 260000 + 180000 + 300000 + 640000,
  publicRuntimeAndPackageMarginMs: 300000, conservativeHeadroomMs: 640000,
  otherIdentityWitnessMs: 900000,
} as const;
export const MANAGED_CRITIC_FIXTURE_RUNTIME_POLICY = {
  environmentKey: 'PROOF_OR_STOP_MANAGED_CRITIC_FIXTURE_BUDGET',
  entry: 'managed-inventory-critic-import', standaloneMs: 120000,
  outerMs: 135000, cleanupMarginMs: 15000, parallelism: 3,
} as const;
// Test-only watchdog transport; never changes provider admission or production budgets.
export const REVIEW_EPOCH_FIXTURE_RUNTIME_POLICY = {
  environmentKey: 'PROOF_OR_STOP_FULL_SUITE_ENTRY_BUDGET',
  entry: 'test:review-epoch-certification-continuity',
  standaloneMs: 420000, maxConcurrentMs: 540000, outerStandaloneMs: 450000,
  maxOuterMs: 675000, cleanupMarginMs: 30000,
} as const;
export const MACHINE_HEAVY_RESOURCE_POLICY = { cpuKey: 'heavy', processKey: 'fanout', access: 'exclusive', admission: 'one-heavy-member-per-os-user' } as const;
export const VALIDATION_RESOURCE_KEY_RUNTIME_POLICY = { literalClasses: ['fixed-port', 'machine-cpu', 'machine-process', 'machine-validation'], pathResolution: 'command-cwd', validation: 'before-normalization' } as const;
export const VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY = { descriptor: 4, descriptorEnvironment: 'PROOF_OR_STOP_VALIDATION_RESERVATION_FD', diagnosticsEnvironment: 'PROOF_OR_STOP_DELEGATION_DIAGNOSTICS', maxMessageBytes: 32768, kernelObservationMs: 1000, workerRegistrationMs: 5000, cleanupMs: 2000, observationRetries: 3, observationBackoffMs: 50, retirementPollMs: 20, retirementPollMaxMs: 500, platform: 'darwin', authority: 'live-machine-ticket-and-kernel-matched-inherited-descriptor', forwarding: 'explicit-node-spawn-boundary-only', cleanup: 'registered-group-absence-before-release' } as const;
export const MACHINE_FIXED_PORT_RUNTIME_POLICY = { directoryMode: 0o700, probeTimeoutMs: 1000, queueDeadlineMs: 300000, scope: 'same-os-user-across-repositories', admissionBoundary: 'actual-command-child', unknownResources: 'exclusive-machine-queue', classifiedEmptyResources: 'shared-machine-barrier', barrierKey: 'admission' } as const;
export const MANAGED_REVIEW_AUTH_RUNTIME_POLICY = {
  hosts: ['codex', 'claude', 'grok'],
  claudeKeychainService: 'Claude Code-credentials', keychainExecutable: '/usr/bin/security',
  keychainTimeoutMs: 10000,
  grokEnvironmentKey: 'GROK_HOME', grokSharedLeader: false, grokAutoUpdate: false,
  grokDisableAutoUpdater: '1',
} as const;
export const MANAGED_REVIEW_TEMP_RUNTIME_POLICY = { environmentKeys: ['TMPDIR', 'TMP', 'TEMP'], directoryMode: 0o700, isolation: 'per-managed-review-scratch' } as const;
export const OWNER_SESSION_IDENTITY_RUNTIME_POLICY = {
  primaryWorktreeProbeCommand: 'git worktree list --porcelain -z',
  gitScope: 'primary-worktree-root',
  linkedWorktreeContinuity: true,
  foreignTaskIsolation: true,
} as const;

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
  { id: 'workspace-validation-coordination', owner: 'validation-execution-lock', semantics: 'Workspace capacity tickets live outside guarded repository roots in a private OS-user directory keyed by the canonical shared repository root. The original path remains a symlink to that single queue for legacy readers and writers. Migration only removes an atomically empty legacy directory; live or unknown tickets block migration under the original deadline, with holder and heartbeat progress plus the legacy path; new callers join only after that legacy queue drains. Unpublished preparation and quarantine residue is reclaimed only for a valid local holder PID with a kernel ESRCH observation; malformed PIDs and other observation errors preserve ownership; live, unknown, or unrecognized residue refuses migration immediately with its path and remediation diagnostic. The populated queue itself is never moved or erased. Foreign aliases and unsafe external directories refuse admission. Kernel mutation guards retain every material and runtime write-and-restore refusal. Disposable guard, residue and full capacity fixtures use private OS-user namespaces, removed in full after their child processes close, including external queues created on refused migration paths; persistent production queue identities are not recursively reclaimed on release.' },
  { id: 'finding-evidence-fixture-deadlines', owner: 'isolated-finding-fixture + red-dynamic-finding-evidence-closure', semantics: 'The default isolated Finding worker retains its 120-second execution deadline. The enclosing evidence regression allows a separate 30-second lifecycle margin for launcher registration, observation and proven process-group cleanup. A signal, timeout, missing output marker or failed assertion remains a failure. Composite audit commands have a finite 900-second serial acceptance budget; this is a configuration correction, not a performance claim.' },
  { id: 'identity-certification-composite-deadline', owner: 'verify-proof-or-stop-identity-cutover', semantics: 'The complete runtime certification retains both registered process/runtime verifier workloads, public operations and installed-package checks. Its finite parent budget covers the registered 260-second and 180-second verifier allowances, 300 seconds for public/package witnesses, and an explicit 640-second conservative headroom that preserves the existing composite envelope. The budget regression binds this sum to the actual registrations. The outer identity command retains a separate allowance for other identity witnesses. Timeouts, signals and missing success selectors remain non-PASS; no verification is skipped or reused by this budget policy.' },
  { id: 'story-integration-target', owner: 'story-create + story-integration-target + done-effects + release', semantics: 'Story creation freezes the checked-out non-Story parent branch and its commit. DONE synchronization, conflict checks, recovery and local release approval consume that branch; legacy Stories resolve the repository baseline without inventing main. A Story branch, detached HEAD, or missing target grants no integration authority.' },
  { id: 'global-thin-native-hook-projection', owner: 'runtime-root + controller-runtime-projection + scope-path-classifier', semantics: 'An explicitly registered linked Story worktree may receive only the exact Codex hook manifest and two Proof-or-Stop hook programs from a global-thin primary controller. Both copies and a signed common-dir plus Story receipt must remain byte-identical; symlinks, tracked-path replacement, controller drift and worktree drift fail closed. Controller HEAD and index own the selected regular config and every present native hook; a controller hook absent from disk, HEAD and index remains absent after a legitimate removal. The branch retains a tracked regular config, while candidate hook edits, deletions and renames remain ordinary material under cleanliness and scope gates. Canonical root aliases are accepted; no runtime exemption is granted and untracked controller hooks retain strict projection authority.' },
  { id: 'causal-environment-confidentiality', owner: 'causal-evidence', semantics: 'Causal identity stores plaintext only for a fixed locale and terminal allowlist; every other environment value is represented by a one-way digest. All persisted output projections share one credential-only redaction stream: token, secret, password, credential, authorization, cookie, credential-bearing proxy, database DSN, SSH private-key and cloud credential values are scrubbed, while benign profile, region, session-label and no-proxy values remain selector-visible.' },
  { id: 'adapter-lifecycle-completion-status', owner: 'playbook-runtime-memory + story-advance', semantics: 'The adapter-facing final response check reports the current Story phase, lifecycleComplete and continuation_required versus complete. story_advance may render its successful transition result as JSON so adapters can inspect lifecycle state instead of treating a shell exit wrapper as completion.' },
  { id: 'identity-canonical-digest-memo', owner: 'runtime-environment-checks', semantics: 'Canonical executable digests memoize only exact source text parse/print/hash results, bounded to 32 entries and 4 Mi characters. Every boundary still reads current source bytes, validates identity sites and imported origins, and compares the current pinned expected digest. Same-size or restored-mtime changes cannot reuse a prior text projection. No PASS, Story evidence or filesystem freshness is cached.' },
  { id: 'publication-recovery-plan-observation', owner: 'checklist', semantics: 'Publication recovery request keys consume the implementation digest already observed by their own producer plan, keeping both key projections coherent. Each invocation obtains a fresh plan. This grants no execution or receipt authority: current shared-execution identity, launch, completion and canonical publication checks remain independent, including changes between planning and recovery lookup. No cross-call cache is introduced.' },
  { id: 'implementation-scan-single-read', owner: 'execution-implementation + checklist', semantics: 'One synchronous implementation identity scan reads each file once: package descriptors, dependency roots, the entrypoint and every content digest consume the same bytes, while the full file scope, digests, symlink refusal and mutation visibility are unchanged and nothing outlives the scan. A batch row reuses the producer plan it computed inside its execution lock for its publication recovery key instead of scanning again, and the enforcement preflight binds its causal identity inputs and launch freshness to one strict freshness observation. Launch, completion and canonical publication checks, including the post-execution freshness capture, remain independent; no cross-call cache or receipt authority is introduced.' },
  { id: 'refresh-git-state-observation', owner: 'git-tree-observation + evidence-freshness + verification-execution-evidence', semantics: 'Each synchronous refresh scope resolves the current HEAD, the material and story-files hashes at that HEAD and the signer key directory once, so per-row freshness checks and receipt validation share one coherent repository observation instead of repeating the same git probes for every row. Nothing survives the scope callback, a thrown error or an await, a throwing probe is never memoized, and every call outside an observation still probes Git. Execution, publication and commit checks stay outside these scopes and observe independently; no PASS, receipt or freshness result is cached across calls.' },
  { id: 'synchronous-segment-implementation-observation', owner: 'checklist + verification-execution-evidence', semantics: 'One synchronous segment observes the implementation once. Every producer entrypoint passes the plan it computed inside its lock to its publication recovery and enforcement, whose launch preflight identity reuses that prepared identity only when command, cwd, timeout and manifest all match; the post-execution identity and the execution receipt identity share one completion observation; and a canonical causal commit shares one implementation and Git state observation between its bounded and fresh snapshots. Launch revalidation, the post-execution reread and every observation outside a scope still read the implementation afresh; nothing survives a scope callback, a thrown error or an await, and no receipt or PASS authority is cached.' },
  { id: 'synchronous-segment-git-observation', owner: 'git-tree-observation + evidence-freshness + git-baseline + story-git-bytes + verification-intent-checkpoint + checklist', semantics: 'One synchronous segment probes each git state once: identical read-only git commands (same cwd, argv and inherited environment) inside one synchronous observation run once through observedGit, and mutating commands never pass through it. Each producer opens one launch observation over planning, concurrent publication lookup, the recovery request and the enforcement preflight; the launch itself runs inside withoutGitObservation and its revalidation asserts that no observation is active; completion holds the post-execution identity and every receipt of that execution; a canonical commit and a stale refresh context each hold one observation, every checklist critical section holds one observation that its own checkpoint anchor writes and metadata auto-commits invalidate, and a freshness triple (checklist evidence hashes, captured verification freshness) outside any scope is its own observation: one resolved HEAD and one tree read serve its three hashes. Nothing survives a scope callback, a thrown error or an await; a command git itself refused (non-zero exit) is observed as failed for the rest of its segment, while a command the process could not complete (caller deadline, timeout, signal, buffer or spawn failure) is never memoized; every call outside an observation still runs git; no PASS, receipt or freshness result is cached across calls.' },
  { id: 'verification-refresh-observation', owner: 'verification-execution-evidence + checklist', semantics: 'Stale-refresh coverage, candidate grouping and final row evaluation each own a separate synchronous lazy implementation observation. Per-row command, environment, dependency, timeout, selector and receipt checks remain current. Observations restore in finally, including nested calls and exceptions, and cannot cross await. Initial and post-lock groups are separate. Launch, completion and canonical publication independently reread identity outside the row observation. No gate result or receipt authority is cached.' },
  { id: 'verification-planning-observation', owner: 'verification-execution-evidence + checklist', semantics: 'The initial synchronous batch-planning map shares a lazily observed implementation digest. Command, environment and dependency identities remain per row. The observation ends in finally before an async continuation, including exceptions. Current plans after lock acquisition, launch, completion and publication independently recompute identity; planning reuse grants no receipt authority.' },
  { id: 'validation-machine-reservation-delegation', owner: 'validation-execution-lock + validation-reservation-delegation + validation-executor', semantics: 'Controlled native descendants borrow only a live executor-owned machine reservation through an inherited read-only unlinked descriptor whose kernel identity matches the admitted owner. Signed grants bind own process identity, active invocation ancestry, exact claim subset, nonce and deadline. Conflicting siblings serialize; unknown foreign commands remain globally exclusive. Pre-spawn and registered orphan residuals fence machine-ticket release until absence is observed; a pre-spawn fence is owned by the process that performs the spawn call, carries a spawn-attempt marker written immediately before that call, is withdrawn at once when the call creates no child or when the mark itself is refused, and only an unmarked fence of a provably gone owner resolves without an observed target; a resolved enrollment leaves the residual record once its PID and whole group are proven absent while its consumed withdrawal capability survives one bounded cleanup window. Kernel process-table and descriptor observation failures, including the local frame subject observations of prepare, attempt and cancel, are typed refusals retried with the registered observation policy, and a non-JSON bootstrap is a typed refusal; no raw error escapes the reader. A transport setup failure is a named refusal that leaves no scratch state; a queued grant request survives transient kernel observation failures until its own deadline. Remote pending-token mutation additionally requires a process-local cleanup capability never persisted in residual files. Unknown residuals permit stale-ticket recovery only with a verified different kernel boot witness bound before publication under the existing private-filesystem trust boundary; same-boot, missing or invalid witnesses and live or reused owner PIDs retain the fence. An enrolled descendant whose command carries no classification resolves to the tightest enclosing declaration (its parent grant, else the owner) and never widens it. Forwarding is explicit only at Node spawn boundaries: the reserved descriptor and locator reach the child spawned with the controlled stdio and environment helpers, a non-Node child or shell wrapper passes both to its own descendants by ordinary exec inheritance, and no holder obtains a grant without the cooperating client, the kernel-matched owner identity and the signed protocol. Unsupported or dropped descriptor transport, including an unrelated linked file at the reserved slot, degrades to the ordinary queue while an unlinked foreign descriptor is refused; retirement polling backs off from retirementPollMs to retirementPollMaxMs while nothing changes; no reviewer or Story authority is granted.' },
  { id: 'memory-query-latency-boundary', owner: 'playbook-runtime-baseline + playbook-runtime-memory', semantics: 'Memory benchmark per-query latency encloses actual pack construction, including cache lookup. Shared batch source validation remains in total batch elapsed time, not per-query percentiles. Timing observations do not change pack identity, cache freshness, or the existing warm batch performance threshold.' },
  { id: 'static-scanner-source-ast-reuse', owner: 'verify-validation-static-edges', semantics: 'The static scanner retains one syntax tree per source path within its process and reuses it only for equal current source text. Every invocation still rereads source bytes and reevaluates argv, traversal, source evidence and dependency checks. Changed syntax replaces that path entry; no classification, receipt or authorization result is cached.' },
  { id: 'command-observation-boundaries', owner: 'cli/activity-policy + local-assurance-story-projection + validation-execution-lock', semantics: 'Hooks, activity and generic Story command events consume effective argument-aware ownership, with existing handler-owned transaction exclusions. Runtime readiness and leases use the same resolved Story workspace. Lock self-reentry requires the live async acquisition token and holder generation; Story ID and PID alone grant nothing. Unknown validation ownership remains a blocking runtime-closure issue. The transition orchestrator supplies that projection to enforce-mode phase/DONE preflight; other operation kinds are evaluator policy, not a claim of all caller integration. Observation never repairs it. Queue activity uses authoritative recorded progress and optional exclusive non-merge commits, never directory mtime. Progress probes default to four worktrees and 1000ms including baseline resolution, with explicit diagnostic increases bounded at 1000 worktrees and 60000ms. Candidate commits are cached per shared Git directory and ordinary/linked checkout mode for one projection; HEAD ancestry stays per worktree; exhaustion or unavailable authoritative state is unknown-worktree, not proof of staleness or cleanup authority. Dashboard queue rollup preserves unknown as non-green, and an empty projection never claims queue readiness.' },
  { id: 'validation-invocation-baseline-serialization', owner: 'shared-validation-execution', semantics: 'Within one shared validation invocation, canonical strings for the captured initial facts and input snapshot are computed once. Each later freshness check still collects and canonicalizes current facts and input bytes and checks workspace and loaded implementation identity. These canonical strings do not survive the invocation and never authorize reuse; cross-invocation cost observations remain governed by validation-reuse-economics.' },
  { id: 'verification-executable-observation', owner: 'executable-digest-observation + verification-execution-evidence', semantics: 'One synchronous execution identity observation reads each resolved executable once. Its implementation projection may serve the same synchronous preflight, including an identical shared timeout identity. Separate preflights, launch callbacks, completion and publication still reread bytes. No cached digest survives a promise continuation or separate observation; this is not execution or receipt reuse.' },
  { id: 'validation-git-tree-observation', owner: 'git-tree-observation + evidence-freshness + verifier', semantics: 'One synchronous observation projects material and Story hashes from one resolved Git object. Only the identical standard NUL-framed successful tree read shares bytes within that observation, bound to cwd and Git environment. Independent launch/publication observations reread; symbolic refs, errors and other tree formats are not cached. No execution result or policy authorization is shared.' },
  {id:'validation-reuse-economics',owner:'shared-validation-execution',semantics:'Measured uneconomic commands execute fresh instead of consuming a receipt. Bounded six-hour runtime cost observations may inform later invocations; they never grant reuse. Corrupt records fall back, unignored paths and symlinks refuse writes, failure or slower execution clears the observation. First-ever observation cost remains.'},
  {id: 'validation-signing-target-root', owner: 'validation-signing-context', semantics: 'Target-aware signing and reading share an async-local repository root; explicit root arguments retain precedence and wrong-root verification never creates a key.'},
  {
    id: 'validation-git-routing-observation',
    owner: 'validation-child-environment + validation-execution-lock',
    semantics: 'GIT_DIR, GIT_COMMON_DIR and GIT_WORK_TREE reads bind the lock-cache guard in the finite environment declaration; all GIT_ keys remain excluded from child forwarding and rejected as overrides. Declaring an observed dependency grants no routing authority.',
  },
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
    semantics: 'The store-backed inventory consumer authenticates the complete receipt and artifact before applying a versioned observation/input whitelist; genuine same-output same-input re-execution and authorized reuse preserve semantics, while changed inputs/output, tamper, and independent epoch material/scope cutoffs remain enforced. Reviewed inventory executable binding covers the explicit unlocked consumption implementation; its expected digest is pinned only after source review, never derived from a live candidate at runtime.',
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

export type RuntimeFactKind = 'environment-check';
export const RUNTIME_REPRO_BOOTSTRAP_COMPONENT_IDS = ['P0m', 'P0p', 'P1', 'P1f', 'P2a', 'P2b'] as const;
export type RuntimeReproBootstrapComponentId = typeof RUNTIME_REPRO_BOOTSTRAP_COMPONENT_IDS[number];

export interface RuntimeFactRegistryEntry {
  id: RuntimeFactId;
  runtimeFactId: string;
  kind: RuntimeFactKind;
  paths: readonly string[];
  componentId?: RuntimeReproBootstrapComponentId;
  generatedFrom?: string;
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
    runtimeFactId: 'entrypoint-authority',
    kind: 'environment-check',
    paths: ['packages/main/src/core/runtime-environment-checks.ts'],
    scope: 'all',
    selfSeverity: 'hard',
    externalSeverity: 'advisory',
    checker: 'resolveEntrypointAuthority',
    outputKey: 'runtimeEntrypointAuthority',
    rationale: 'Every command in the command-policy-derived actual Story-write capability registry must execute the runtime belonging to the target self-project checkout, independent of owner/reviewer/dangerous/shared ownership class. Maintenance preview admission and typed handlers share strict parameter semantics; observational calls require no owner lease. Identity-free paths require an independently reviewed executable pin at registry construction, and missing executable bytes fail closed. The dedicated maintenance-command-mode boundary binds all four callers and authenticates the delegate before argument classification; a missing boundary gets an explicit unregistered-boundary refusal, never silent admission; malformed modes fail with command diagnostics, not bootstrap recovery. Admitted extensions with intrinsic effective storyScopedMutating or reviewerWrite ownership share the same raw and final admission predicate without requiring a built-in command name. The command-bound active identity registry also rejects retired protocol bytes in each corresponding loaded producer/consumer before handlers or writes. An invalid prompt-envelope version checks its loaded boundary before the early config error, preserves the unsupported-version rejection prefix, and never falls back to defaults; valid config keeps its fast path. Eager role-policy rejection preserves unknown-role ordering and derives only missing canonical source sites from the independent package snapshot, never alias normalization. The dependency manifest, manifest binding, inventory observation and receipt bundle are registered as exact active identity sites with coupled negative controls. The registered executable modules include the actual verification receipt producer and checklist consumers, with independently reviewed syntax fingerprints binding their declaration, producer, consumer and neighbouring identity behavior against decoys and rewiring. Exact value checks execute before the syntax guard. One byte snapshot supplies all checks in each invocation. Root configuration references retain an exact occurrence binding. Argument-aware read-only variants remain diagnostic-only. Inventory status defaults to observation and requires --refresh for writes; Story prompt --readOnly skips publication, while audit combinations stay gated. Managed check defaults to read-only and reserves --apply/--upgrade for writes.',
    driftMessage: 'The active CLI runtime is not authoritative for the target self-project checkout.',
    repairHint: 'From the target checkout, retry the same command with `node bin/proof-or-stop.js`.',
  },
  {
    id: 'cli-entrypoint',
    runtimeFactId: 'cli-entrypoint',
    kind: 'environment-check',
    paths: ['packages/main/src/core/runtime-environment-checks.ts'],
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
    runtimeFactId: 'global-core-realpath',
    kind: 'environment-check',
    paths: ['packages/main/src/core/runtime-environment-checks.ts'],
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
    runtimeFactId: 'project-local-bin',
    kind: 'environment-check',
    paths: ['packages/main/src/core/runtime-environment-checks.ts'],
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
    runtimeFactId: 'node-version',
    kind: 'environment-check',
    paths: ['packages/main/src/core/runtime-environment-checks.ts'],
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
    runtimeFactId: 'package-version',
    kind: 'environment-check',
    paths: ['packages/main/src/core/runtime-environment-checks.ts', 'packages/main/src/core/runtime-package-version.ts', 'packages/main/src/cli-engine.ts'],
    scope: 'all',
    selfSeverity: 'hard',
    externalSeverity: 'advisory',
    checker: 'resolvePackageVersion',
    outputKey: 'packageVersion',
    rationale: 'The diagnostic checker compares manifests only. Separately, CLI startup refuses a compiled version that differs from its own installed package manifest; this startup check is not a doctor-row measurement, and the caller project version is not an execution identity. Recovery distinguishes source/manifest disagreement, unreadable source, and matching source with a missing build entrypoint from ordinary stale compiled output, and never suggests a rebuild alone for known source desynchronization. Adapter heartbeat forwards line-start CLI_RUNTIME_VERSION_MISMATCH or CLI_RUNTIME_VERSION_METADATA_INVALID refusals even after warnings or the published Error prefix as heartbeat_runtime_version_mismatch, still failing without labeling the adapter defective; timeout and generic failure retain their distinct paths.',
    driftMessage: 'Proof-or-Stop package versions disagree between the current runtime, repository root, or global install.',
    repairHint: 'Align root/package versions and rebuild before publishing or using the global CLI as evidence.',
  },
  {
    id: 'validate-source',
    runtimeFactId: 'validate-source',
    kind: 'environment-check',
    paths: ['packages/main/src/core/runtime-environment-checks.ts'],
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
    runtimeFactId: 'external-reference-policy',
    kind: 'environment-check',
    paths: ['packages/main/src/core/runtime-environment-checks.ts'],
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

export interface RuntimeFactRegistryProjectionEntry {
  runtimeFactId: string;
  kind: RuntimeFactKind;
  paths: string[];
  componentId?: RuntimeReproBootstrapComponentId;
}

export interface ComponentRuntimeFactMappingEntry {
  runtimeFactId: string;
  componentId: RuntimeReproBootstrapComponentId;
  path: string;
  generatedFrom?: string;
}

export type RuntimeFactRegistryMappingFailure =
  | 'runtime-missing'
  | 'runtime-ambiguous'
  | 'runtime-non-total'
  | 'runtime-generated-without-lineage';

export class RuntimeFactRegistryMappingError extends Error {
  readonly code = 'registry-component-mapping-unavailable' as const;
  readonly reason: RuntimeFactRegistryMappingFailure;

  constructor(reason: RuntimeFactRegistryMappingFailure, detail: string) {
    super(`registry-component-mapping-unavailable: ${reason}: ${detail}`);
    this.name = 'RuntimeFactRegistryMappingError';
    this.reason = reason;
  }
}

const GENERATED_RUNTIME_FACT_PATH_PREFIXES = [
  '.claude/',
  '.codex/',
  '.proof-or-stop-codex/',
  'dist/',
  'packages/graph/assets/',
  'tests/output/',
] as const;
const GENERATED_RUNTIME_FACT_EXACT_PATHS = new Set(['AGENTS.md', 'CLAUDE.md']);

function compareRuntimeFactUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeRuntimeFactPath(value: unknown, reason: RuntimeFactRegistryMappingFailure): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\0')) {
    throw new RuntimeFactRegistryMappingError(reason, 'path must be a non-empty exact string');
  }
  if (value.includes('\\') || /^[A-Za-z]:/u.test(value) || pathPosix.isAbsolute(value)) {
    throw new RuntimeFactRegistryMappingError(reason, `absolute path is forbidden: ${value}`);
  }
  const normalized = pathPosix.normalize(value).replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new RuntimeFactRegistryMappingError(reason, `path escapes the repository: ${value}`);
  }
  return normalized;
}

function normalizeRuntimeFactMappingEntry(entry: Partial<RuntimeFactRegistryEntry>): {
  runtimeFactId: string;
  kind: RuntimeFactKind;
  paths: string[];
  componentId?: RuntimeReproBootstrapComponentId;
  generatedFrom?: string;
} {
  if (typeof entry?.runtimeFactId !== 'string' || entry.runtimeFactId.length === 0
    || entry.runtimeFactId.trim() !== entry.runtimeFactId || entry.kind !== 'environment-check'
    || !Array.isArray(entry.paths)) {
    throw new RuntimeFactRegistryMappingError('runtime-missing', 'runtimeFactId, kind, and paths are required');
  }
  if (entry.paths.length === 0) {
    throw new RuntimeFactRegistryMappingError('runtime-non-total', `${entry.runtimeFactId} has no mapped path`);
  }
  const paths = entry.paths.map(path => normalizeRuntimeFactPath(path, 'runtime-non-total')).sort(compareRuntimeFactUtf8);
  if (new Set(paths).size !== paths.length) {
    throw new RuntimeFactRegistryMappingError('runtime-ambiguous', `${entry.runtimeFactId} maps the same normalized path more than once`);
  }
  const componentId = entry.componentId;
  if (componentId !== undefined && (typeof componentId !== 'string' || componentId.length === 0 || componentId.trim() !== componentId)) {
    throw new RuntimeFactRegistryMappingError('runtime-non-total', 'componentId must be a non-empty exact string');
  }
  if (componentId !== undefined && !(RUNTIME_REPRO_BOOTSTRAP_COMPONENT_IDS as readonly string[]).includes(componentId)) {
    throw new RuntimeFactRegistryMappingError('runtime-non-total', `unknown componentId: ${componentId}`);
  }
  const generatedFrom = entry.generatedFrom === undefined
    ? undefined
    : normalizeRuntimeFactPath(entry.generatedFrom, 'runtime-non-total');
  const generatedPath = (path: string) => GENERATED_RUNTIME_FACT_EXACT_PATHS.has(path)
    || GENERATED_RUNTIME_FACT_PATH_PREFIXES.some(prefix => path.startsWith(prefix))
    || path.includes('/dist/')
    || path.includes('/generated/');
  if (componentId && paths.some(generatedPath)
    && generatedFrom === undefined) {
    throw new RuntimeFactRegistryMappingError(
      'runtime-generated-without-lineage',
      `${entry.runtimeFactId} maps a generated component path without generatedFrom`,
    );
  }
  if (generatedFrom !== undefined
    && (componentId === undefined || paths.length !== 1 || !generatedPath(paths[0])
      || generatedPath(generatedFrom) || paths[0] === generatedFrom)) {
    throw new RuntimeFactRegistryMappingError(
      'runtime-non-total',
      `${entry.runtimeFactId} generatedFrom must bind exactly one generated component path to a different source path`,
    );
  }
  return { runtimeFactId: entry.runtimeFactId, kind: entry.kind, paths, componentId, generatedFrom };
}

/** Complete §4 projection. It deliberately omits generatedFrom. */
export function projectRuntimeFactRegistry(
  entries: readonly Partial<RuntimeFactRegistryEntry>[] = RUNTIME_FACT_REGISTRY,
): RuntimeFactRegistryProjectionEntry[] {
  const normalized = entries.map(normalizeRuntimeFactMappingEntry);
  const ids = normalized.map(entry => entry.runtimeFactId);
  if (new Set(ids).size !== ids.length) {
    throw new RuntimeFactRegistryMappingError('runtime-ambiguous', 'runtimeFactId values must be unique');
  }
  return normalized
    .map(({ runtimeFactId, kind, paths, componentId }) => ({
      runtimeFactId,
      kind,
      paths,
      ...(componentId === undefined ? {} : { componentId }),
    }))
    .sort((left, right) => compareRuntimeFactUtf8(left.runtimeFactId, right.runtimeFactId));
}

/** Complete §12 component projection. It never consults checker/output/rationale hints. */
export function projectComponentRuntimeFactMapping(
  componentId: string,
  entries: readonly Partial<RuntimeFactRegistryEntry>[] = RUNTIME_FACT_REGISTRY,
): ComponentRuntimeFactMappingEntry[] {
  if (typeof componentId !== 'string' || componentId.length === 0 || componentId.trim() !== componentId) {
    throw new RuntimeFactRegistryMappingError('runtime-non-total', 'componentId is required');
  }
  if (!(RUNTIME_REPRO_BOOTSTRAP_COMPONENT_IDS as readonly string[]).includes(componentId)) {
    throw new RuntimeFactRegistryMappingError('runtime-non-total', `unknown componentId: ${componentId}`);
  }
  const requested = componentId as RuntimeReproBootstrapComponentId;
  const normalized = entries.map(normalizeRuntimeFactMappingEntry);
  const tuples = normalized
    .filter(entry => entry.componentId === requested)
    .flatMap(entry => entry.paths.map(path => ({
      runtimeFactId: entry.runtimeFactId,
      componentId: requested,
      path,
      ...(entry.generatedFrom === undefined ? {} : { generatedFrom: entry.generatedFrom }),
    })))
    .sort((left, right) => compareRuntimeFactUtf8(left.runtimeFactId, right.runtimeFactId)
      || compareRuntimeFactUtf8(left.path, right.path)
      || compareRuntimeFactUtf8(left.generatedFrom ?? '', right.generatedFrom ?? ''));
  const tupleKeys = tuples.map(tuple => `${tuple.runtimeFactId}\0${tuple.componentId}\0${tuple.path}\0${tuple.generatedFrom ?? ''}`);
  if (new Set(tupleKeys).size !== tupleKeys.length) {
    throw new RuntimeFactRegistryMappingError('runtime-ambiguous', `duplicate component tuple for ${requested}`);
  }
  const ids = normalized.map(entry => entry.runtimeFactId);
  if (new Set(ids).size !== ids.length) {
    throw new RuntimeFactRegistryMappingError('runtime-ambiguous', 'runtimeFactId values must be unique');
  }
  return tuples;
}

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
  worktreeOnlyActions: ['red', 'green', 'audit'],
  statusAccess: 'read-only-without-lock-or-trust-initialization',
  mutationLockOrder: 'lab-then-main',
  operationHeartbeatMs: 30000,
  operationStaleMs: 120000,
  auditBuiltinVendors: { codex: 'openai', claude: 'anthropic' },
  auditCustomProtocol: 'lab-json',
  auditIndependence: 'different-vendor',
  auditRequired: true,
  auditTimeoutMs: 900000,
  auditStartupTimeoutMs: 90000,
  recordSchema: 3,
  readableRecordSchemas: [1, 2, 3],
} as const;


/** Conservative defaults consumed by official validation, independent of Lab. */
export const VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS = {
  metadataWriteWaitMs: 250,
  metadataValidationGraceMs: 500,
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

const SCOPE_APPROVAL_CONTINUITY_HISTORY_COMMITS = 256;
export const SCOPE_BUDGET_DECISION_RUNTIME_POLICY = {
  approvalLifetimeMs: 7 * 24 * 60 * 60 * 1000,
  continuityHistoryCommits: SCOPE_APPROVAL_CONTINUITY_HISTORY_COMMITS,
  continuityGitTimeoutMs: 5000,
  continuityGitOutputBytes: 4 * 1024 * 1024,
  continuityTotalGitCommands: 3 * SCOPE_APPROVAL_CONTINUITY_HISTORY_COMMITS + 8,
  continuityTotalGitBytes: 32 * 1024 * 1024,
  continuityTotalMs: 15000,
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

/** Existing managed-dispatch authority also carries independent TEST delivery output. */
export const MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY = {
  role: 'proof-or-stop-review-delivery', phase: 'TEST', profile: 'managed_dispatch',
  artifact: 'delivery-check.json',
  authority: 'live-one-shot-invocation-and-safe-terminal-sealed-output',
} as const;
