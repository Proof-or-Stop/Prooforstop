import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runtimePackageRoot } from './runtime-layout.js';
import { loadConfig, PROJECT_CONFIG_FILENAMES } from './config.js';
import {
  RUNTIME_FACT_REGISTRY,
  type RuntimeFactId,
  type RuntimeFactOutputKey,
  type RuntimeFactRegistryEntry,
  type RuntimeFactScope,
  type RuntimeFactSeverity,
} from './runtime-fact-registry.js';
import {
  PROOF_OR_STOP_ROOT_PACKAGE_NAME,
} from './proof-or-stop-brand.js';
import { readBrandEnv } from './brand-env.js';
import { PROOF_OR_STOP_CLI_VERSION } from './proof-or-stop-brand.js';
import { findBrandExport } from './version-bump.js';
import ts from 'typescript';

export type RuntimeFactStatus = 'pass' | 'warn' | 'fail';
export type RuntimeMode = 'global-cli' | 'project-local-package' | 'packaged-runtime' | 'compatibility-launcher' | 'diagnostic-only';
export type RuntimeModeSource = 'repo-local-dist' | 'project-node-modules' | 'packaged-runtime' | 'external-development-engine' | 'global-cli' | 'unknown';
export type RuntimeModeAuthority = 'local-runtime-diagnostic-only';

export interface RuntimeModeContract {
  mode: RuntimeMode;
  source: RuntimeModeSource;
  requiresProjectJavaScriptRuntime: boolean;
  authority: RuntimeModeAuthority;
  message: string;
}

export interface RuntimeFactCheckResult {
  id: RuntimeFactId;
  outputKey: RuntimeFactOutputKey;
  status: RuntimeFactStatus;
  severity: RuntimeFactSeverity;
  scope: RuntimeFactScope;
  rationale: string;
  driftMessage: string;
  repairHint?: string;
  actual?: unknown;
  expected?: unknown;
  details?: string[];
  warnings?: string[];
  connectivityChecked?: boolean;
}

export type RuntimeEnvironmentReport = {
  isSelfProject: boolean;
  scope: 'self' | 'external';
  runtimeMode: RuntimeModeContract;
  summary: {
    status: RuntimeFactStatus;
    pass: number;
    warn: number;
    fail: number;
  };
} & Record<RuntimeFactOutputKey, RuntimeFactCheckResult>;

export interface RuntimeEnvironmentOptions {
  commandResolver?: (projectRoot: string) => string | null;
  globalNpmRootResolver?: (projectRoot: string) => string | null;
  // B-e256 cross-host review B-e256-xhr-r13 MAJOR: test seam for a STRUCTURED
  // `npm root -g` probe. Unlike `globalNpmRootResolver` above (a plain string
  // that cannot distinguish "genuinely nothing installed" from "the probe
  // itself failed"), this carries a `failureReason` so npm being missing, a
  // non-zero exit, a timeout, or unparsable output is reported as unverifiable
  // drift instead of collapsing into the informational "not installed" pass.
  // Takes priority over `globalNpmRootResolver` when both are supplied.
  // Production always uses the default (a real `npm root -g` probe with the
  // failure captured).
  globalNpmRootProbeResolver?: (projectRoot: string) => GlobalNpmRootProbeResult;
  corePackageRoot?: string;
  // B-e256-xhr-r6: test seam for the access(2) X_OK probe behind the
  // global-core-realpath executable fact (owner/group cases cannot be built
  // hermetically by an unprivileged test). Production always uses the default.
  executableAccessProbe?: (path: string) => boolean;
  // Test seam for host-specific command rendering and executable semantics.
  // Production always uses process.platform.
  platform?: NodeJS.Platform;
  // Test seam for failures while inspecting the declared global bin target.
  // Production uses statSync; tests can inject EACCES/EPERM without depending
  // on the uid or host filesystem permissions.
  binTargetStatProbe?: (path: string) => { mode: number; isFile(): boolean };
  // Test seam for resolving the declared bin target after stat. Production
  // uses realpathSync and preserves the errno when resolution fails.
  binTargetRealpathProbe?: (path: string) => GlobalCoreRealpathProbeResult;
  // Test seam for reading the Windows npm command shim selected from PATH.
  commandShimReadProbe?: (path: string) => string;
  // Test seam for the bounded Windows launchability witness. Production runs
  // the exact canonical `proof-or-stop.cmd --version` command from the
  // already-validated npm shim directory; simulated win32 tests inject the
  // result because a POSIX host cannot execute cmd.exe semantics.
  windowsCommandRuntimeProbe?: (commandPath: string, expectedVersion: string) => WindowsCommandRuntimeProbeResult;
  // B-e256 cross-host review B-e256-xhr-r12 MAJOR: test seam for the realpath(3)
  // resolution of the global core package. A candidate that lstat/exists as
  // `resolved` can still fail realpath (EACCES/EPERM/EIO on the target, or the
  // checkout disappearing between the presence probe and the resolution), and an
  // unprivileged hermetic fixture cannot build that divergence: every
  // construction that makes realpath(3) fail makes the presence probe fail
  // first, so it would be classified before this code is reached. Production
  // always uses the default (realpathSync plus errno capture).
  globalCoreRealpathProbe?: (path: string) => GlobalCoreRealpathProbeResult;
  // B-e256 cross-host review B-e256-xhr-r13 MAJOR: test seam for the compiled
  // runtime's OWN reported version, read from the authoritative build artifact
  // (`dist/core/proof-or-stop-brand.js`) instead of the package.json manifest a
  // stale/skipped rebuild never touches. Production always uses the default
  // (reads that compiled file).
  compiledCoreVersionProbe?: (globalRealpath: string) => CompiledCoreVersionProbeResult;
}

export interface GlobalCoreRealpathProbeResult {
  realpath: string | null;
  errorCode: string | null;
}

// B-e256 cross-host review B-e256-xhr-r13 MAJOR: `npm root -g` itself can fail
// (npm missing from PATH, a non-zero exit, a timeout, or unparsable output).
// `root` is only ever non-null on a genuinely successful probe; any failure
// carries a human-readable `failureReason` instead of collapsing into
// `root: null`, which downstream was otherwise indistinguishable from "npm
// succeeded and there is genuinely nothing installed" - the false-pass class
// this MAJOR finding closes.
export interface GlobalNpmRootProbeResult {
  root: string | null;
  failureReason: string | null;
}

// B-e256 cross-host review B-e256-xhr-r13 MAJOR: the compiled runtime's actual
// reported version, read from the authoritative build artifact instead of the
// package.json manifest (which stays whatever it was hand-edited to even when
// `dist/` was never rebuilt - exactly the failure mode this story targets).
export interface CompiledCoreVersionProbeResult {
  version: string | null;
  failureReason: string | null;
}

export interface WindowsCommandRuntimeProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode: string | null;
  failureReason: string | null;
}

interface RuntimeCheckContext {
  projectRoot: string;
  isSelfProject: boolean;
  runtimeScope: 'self' | 'external';
  corePackageRoot: string;
  canonicalSelfCoreRoot: string | null;
  cliEntrypoint: string | null;
  activeCliEntrypoint: string | null;
  globalNpmRoot: string | null;
  globalNpmRootProbe: GlobalNpmRootProbeResult;
  executableAccessProbe: (path: string) => boolean;
  platform: NodeJS.Platform;
  binTargetStatProbe: (path: string) => { mode: number; isFile(): boolean };
  binTargetRealpathProbe: (path: string) => GlobalCoreRealpathProbeResult;
  commandShimReadProbe: (path: string) => string;
  windowsCommandRuntimeProbe: (commandPath: string, expectedVersion: string) => WindowsCommandRuntimeProbeResult;
  globalCoreRealpathProbe: (path: string) => GlobalCoreRealpathProbeResult;
  compiledCoreVersionProbe: (globalRealpath: string) => CompiledCoreVersionProbeResult;
}

export const STALE_GLOBAL_RUNTIME_REASON_CODE = 'stale_global_runtime_in_worktree' as const;

export type RuntimeEntrypointAuthorityReasonCode =
  | typeof STALE_GLOBAL_RUNTIME_REASON_CODE
  | 'foreign_self_project_runtime_for_story_write'
  | 'runtime_authority_unresolved_in_worktree'
  | 'runtime_authority_probe_timeout_in_worktree';

export interface RuntimeEntrypointAuthorityInput {
  command: string;
  commandArgs: string[];
  projectRoot: string;
  invokedEntrypoint?: string | null;
  loadedCorePackageRoot?: string | null;
  env?: Record<string, string | undefined>;
  requiresAuthoritativeRuntime?: boolean;
}

export interface RuntimeEntrypointAuthorityDecision {
  status: 'pass' | 'exempt' | 'blocked';
  reasonCode?: RuntimeEntrypointAuthorityReasonCode;
  selfHostWorktree: boolean;
  projectRoot: string;
  worktreeRoot: string | null;
  mainRoot: string | null;
  gitCommonDir: string | null;
  invokedEntrypoint: string | null;
  runtimeRoot: string | null;
  recoveryCommand?: string;
  detail: string;
}

interface ExternalReference {
  file: string;
  value: string;
  line: number;
  healthSemantics: boolean;
}


const MIN_NODE_MAJOR = 20;
const CANONICAL_ROOT_PACKAGE_NAME = PROOF_OR_STOP_ROOT_PACKAGE_NAME;
const CANONICAL_CORE_PACKAGE_NAME = '@proof-or-stop/core';
const DEPRECATED_CORE_PACKAGE_NAME = CANONICAL_CORE_PACKAGE_NAME;
const SELF_ROOT_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  CANONICAL_ROOT_PACKAGE_NAME,
]);
// Self-project detection must accept EITHER core spelling: a miss makes runtimeScope flip
// self -> external, which downgrades drift checks to advisory (the B-cdf6 regression class).
const SELF_CORE_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  CANONICAL_CORE_PACKAGE_NAME,
  DEPRECATED_CORE_PACKAGE_NAME,
]);
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const HOST_PORT_RE = /\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}:\d{2,5}\b/g;
const LOCAL_HOST_RE = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?(?:[/?#]|$)/i;
const HEALTH_SEMANTICS_RE = /\b(health\s*check|healthcheck|health\s*command|doctor|ping|readiness|liveness)\b|health check|health command/i;
const RUNTIME_MODE_AUTHORITY: RuntimeModeAuthority = 'local-runtime-diagnostic-only';

export interface ActiveIdentityOperationPath {
  sourcePath: string;
  scope: 'runtime-package' | 'project';
  path: string;
}

export interface ActiveIdentityOperationBoundary {
  id: string;
  /** Exact consumer identity must be checked before any CLI write surface. */
  preSideEffect?: boolean;
  commands: readonly string[];
  paths: readonly ActiveIdentityOperationPath[];
  identitySites: readonly ActiveIdentityOperationIdentitySite[];
  pathBindings: readonly ActiveIdentityOperationPathBinding[];
  retiredIdentityCases: readonly ActiveIdentityOperationIdentityCase[];
}

export interface ActiveIdentityOperationIdentitySite {
  siteId: string;
  sourcePath: string;
  canonical: string;
  retired: string;
  sourceNeedle: string;
  retiredNeedle: string;
  mutationKind: 'historical-retired' | 'unsupported-family-control';
  retiredProvenance?: {
    commit: string;
    sourcePath: string;
    value: string;
    use: 'producer-or-domain' | 'reader-or-type-alternative';
  };
  sourceOccurrences?: { canonical: number; retired: number };
  identityOrigin?: { sourcePath: string; exportName: string; scope?: 'project' };
  valueBinding?:
    | { kind: 'export-const'; name: string }
    | { kind: 'property'; name: string; functionName: string }
    | { kind: 'comparison'; expression: string; functionName: string };
}

export interface ActiveIdentityOperationIdentityCase extends ActiveIdentityOperationIdentitySite {
  command?: string;
}

export interface ActiveIdentityOperationPathBinding {
  sourcePath: string;
  classification: 'owned-site' | 'identity-free';
  siteIds?: readonly string[];
  evidence?: string;
}

interface ActiveIdentityOperationCaseRef {
  siteId: string;
  command?: string;
}

interface ActiveIdentityFreePath {
  sourcePath: string;
  evidence: string;
}

const identitySiteId = (sourcePath: string, canonical: string): string => `${sourcePath}#${canonical}`;
const retiredIdentityNeedle = (suffix: string): string => ['proof', 'bound', suffix].join('');

const identitySite = (
  sourcePath: string,
  canonical: string,
  sourceNeedle = canonical,
  retiredNeedle = canonical.replace(/^proof-or-stop/u, 'proofbound'),
  retired = canonical.replace(/^proof-or-stop/u, 'proofbound'),
  retiredProvenance?: ActiveIdentityOperationIdentitySite['retiredProvenance'],
  sourceOccurrences?: ActiveIdentityOperationIdentitySite['sourceOccurrences'],
): ActiveIdentityOperationIdentitySite => Object.freeze({
  siteId: identitySiteId(sourcePath, canonical),
  sourcePath,
  canonical,
  retired,
  sourceNeedle,
  retiredNeedle,
  mutationKind: retiredProvenance ? 'historical-retired' : 'unsupported-family-control',
  ...(retiredProvenance ? { retiredProvenance } : {}),
  ...(sourceOccurrences ? { sourceOccurrences } : {}),
});

// These counterparts are individually verified against the imported source,
// never inferred from the current spelling. Already-canonical values instead
// use identitySite's explicitly synthetic unsupported-family control.
const historicalIdentitySite = (
  sourcePath: string,
  canonical: string,
  retired: string,
  use: 'producer-or-domain' | 'reader-or-type-alternative' = 'producer-or-domain',
  sourceOccurrences?: ActiveIdentityOperationIdentitySite['sourceOccurrences'],
): ActiveIdentityOperationIdentitySite => identitySite(sourcePath, canonical, canonical, retired, retired, {
  commit: '69403365ae9a19422564babf93f6c10de869c81d', sourcePath, value: retired, use,
}, sourceOccurrences);

const identityMutationCase = (
  sourcePath: string,
  canonical: string,
  command?: string,
): ActiveIdentityOperationCaseRef => Object.freeze({
  siteId: identitySiteId(sourcePath, canonical),
  ...(command ? { command } : {}),
});

const identityFreePath = (sourcePath: string, evidence: string): ActiveIdentityFreePath => Object.freeze({ sourcePath, evidence });

const runtimeSource = (sourcePath: string): ActiveIdentityOperationPath => ({
  sourcePath,
  scope: 'runtime-package',
  path: sourcePath
    .replace(/^packages\/main\/src\//, 'dist/')
    .replace(/\.ts$/u, '.js')
    .replace(/^packages\/main\//, ''),
});
const projectSource = (sourcePath: string): ActiveIdentityOperationPath => ({
  sourcePath,
  scope: 'project',
  path: sourcePath,
});

type ActiveIdentityOperationBoundarySeed = Omit<ActiveIdentityOperationBoundary, 'pathBindings' | 'retiredIdentityCases'> & {
  mutationCases: readonly ActiveIdentityOperationCaseRef[];
  identityFreePaths?: readonly ActiveIdentityFreePath[];
};

// SHA-256 of emitted dist JavaScript parsed/printed by canonicalIdentityExecutableDigest (comments removed, LF); not raw TypeScript bytes.
// Enforced by assertCanonicalActiveIdentityBoundary; scripts/verify-review-inventory-identity.mjs checks the inventory pin and a live executable mutation.
const ACTIVE_IDENTITY_EXECUTABLE_SOURCE_BINDINGS: Readonly<Record<string, string>> = Object.freeze({
  // Lab digest-stat-cache (2026-09-29) caches stat-validated digests; repinned.
  'packages/main/src/core/executable-digest-observation.ts': '434861970b49d76c2813c7994a141f5550dabf7a85026a6709d6bb37ecc01e96',
  'packages/main/src/core/lifecycle-control/control-status.ts': 'e015e86e23e400c8d7e43bd253938f3ee2105bba9925d42c599747b6b87fcc58',
  'packages/main/src/core/experience-layer-types.ts': '8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881',
  // Lab gate-command-cost (2026-10-03): ref-state reads delegate to git-ref-witness-memo; repinned.
  // Lab framework-perf (2026-10-13): the observation key's sorted environment is rebuilt only after a process.env write (core/process-env-version.ts); repinned.
  'packages/main/src/core/git-tree-observation.ts': '9510e37d63d007b8b7da4cc1bf77ba2aab04f5470863f0521a1763606bf09059',
  // Lab cli-bundle (2026-09-30): resolveStoryChangedFiles/MergeBase now imported from the story-change-manifest leaf; repinned.
  // Lab runtime-info-exclude (2026-09-30): checkEvidenceHashSnapshotReuse now forwards trustedControllerProjectionStoryId to readMaterialDirtyFiles; repinned.
  // Lab next-driver-cost (2026-10-01): the rename-aware name-status read passes through observedGit; repinned.
  'packages/main/src/core/evidence-freshness.ts': '0b4671d80799500b0c7aedc8de84e3d692237ab7da521c046e47c012e21877e0',
  // 3270fa6c84 changed the emitted inventory executable after its previous pin was recorded.
  // Lab review-epoch-lineage (2026-09-30): zero-wave completeness-only receipts route to cancel; repinned.
  // Lab ab-variant-switches (2026-10-06): consume replay accepts an A/B criticSkip wave only while review.criticOnCleanRound=skip; repinned.
  // Lab run44-fixes (2026-10-10): no live epoch / a consumed receipt point at `next --run` (not review_inventory_status / session_brief); repinned.
  // Lab run52-fixes (2026-10-11): a finding closed at import as a recurring pre-existing finding is not a verified family of its wave; repinned.
  'packages/main/src/core/review-inventory-epoch.ts': '48101bea03bc6f6401961f79487286d744da63337cd78493c5d9c8c2baf544a4',
  // Lab verification-env-digest (2026-09-30): ordinary receipts bind the v2 environment identity projection; repinned.
  // Lab gate-command-cost (2026-10-03): the signer-key common-dir probe goes through observedGit; repinned.
  'packages/main/src/core/verification-execution-evidence.ts': '915f3b1d386ce37f12caa69e98124886fc466fd4ce1159188fb12e5ad444b5e6',
  // Labs plan-pin-allowlist and plan-intent-precheck (2026-09-30) changed checklist_update; repinned.
  // Lab plan-author-before-scope (2026-10-07): the intent-classification refusal moved to core/verification-intent-classification.ts; repinned.
  // Lab pin-derivation-audit (2026-10-08): checklist_add/_update and plan_acceptance_* refuse an underived intent example (core/intent-derivation.ts); repinned.
  // Lab request-probes (2026-10-09): checklist_update done runs the framework probe rows first (core/request-probes.ts); repinned.
  // Lab metadata-findings (2026-10-09): checklist_update metadataCorrection (verified Story-metadata correction, REVIEW in place), plan acceptance no-op refusal; repinned.
  // Lab run44-fixes (2026-10-10): an applied metadata correction is journaled (metadata_correction_applied); the REVIEW intent-row refusal points at next --run; repinned.
  // Lab run58-fixes (2026-10-12): a PLAN pin keeps a done item whose pinned tests pass (core/pin-amendment.ts), [pin_reversal_unstated]; repinned.
  // Lab round-cut (2026-10-14): checklist_update refuses a whole-intent payload built from older rows (intentBasis, core/intent-basis.ts); repinned.
  // Lab initplan (2026-10-15): the derivation refusal names a row patch / the staged payload, a CJK refusal also lists the underived rows, an INIT intent edit reprints the PLAN pre-check; repinned.
  // Lab run95 (2026-10-16): a row patch names removed rows and index moves (intentRowPatchNote); an excludes entry its own userSees names gets the one command for both fields; repinned.
  'packages/main/src/handlers/checklist.ts': '3874fc566a12be0b449a8aee07c13f0b3e82233755d848362851c688a5f29585',
  'packages/main/src/core/maintenance-command-mode.ts': '9c94f1c1a20abf5ed3b93208f5d52e13d63246af12a85612c1e07f99e72258e2',
});

const identityBoundary = (
  seed: ActiveIdentityOperationBoundarySeed,
): ActiveIdentityOperationBoundary => {
  const identitySites = Object.freeze([...seed.identitySites]);
  const freePaths = seed.identityFreePaths ?? [];
  const pathBindings = seed.paths.map((entry) => {
    const owned = identitySites.filter((site) => site.sourcePath === entry.sourcePath);
    const identityFree = freePaths.find((candidate) => candidate.sourcePath === entry.sourcePath);
    if ((owned.length > 0) === Boolean(identityFree)) {
      throw new Error(`${seed.id}/${entry.sourcePath}: path must declare owned identity sites or one identity-free proof, never both/neither`);
    }
    if (identityFree && !ACTIVE_IDENTITY_EXECUTABLE_SOURCE_BINDINGS[entry.sourcePath]) {
      throw new Error(`${seed.id}/${entry.sourcePath}: identity-free path requires a reviewed executable source binding`);
    }
    return owned.length > 0
      ? Object.freeze({ sourcePath: entry.sourcePath, classification: 'owned-site' as const, siteIds: Object.freeze(owned.map((site) => site.siteId)) })
      : Object.freeze({ sourcePath: entry.sourcePath, classification: 'identity-free' as const, evidence: identityFree!.evidence });
  });
  const retiredIdentityCases = seed.mutationCases.map((caseRef) => {
    const matches = identitySites.filter((site) => site.siteId === caseRef.siteId);
    if (matches.length !== 1) throw new Error(`${seed.id}/${caseRef.siteId}: mutation case must resolve exactly one independently declared identity site`);
    return Object.freeze({ ...matches[0], ...(caseRef.command ? { command: caseRef.command } : {}) });
  });
  const declaredCaseIds = retiredIdentityCases.map((entry) => entry.siteId).sort();
  const declaredSiteIds = identitySites.map((entry) => entry.siteId).sort();
  if (new Set(declaredCaseIds).size !== declaredCaseIds.length || JSON.stringify(declaredCaseIds) !== JSON.stringify(declaredSiteIds)) {
    throw new Error(`${seed.id}: every independently declared identity site requires exactly one mutation case`);
  }
  return Object.freeze({
    id: seed.id,
    ...(seed.preSideEffect ? { preSideEffect: true } : {}),
    commands: seed.commands,
    paths: seed.paths,
    identitySites,
    pathBindings: Object.freeze(pathBindings),
    retiredIdentityCases: Object.freeze(retiredIdentityCases),
  });
};

/**
 * F-050: each active identity-bearing source is tied to the public operation
 * that consumes or exposes it. This is intentionally a runtime-path registry,
 * not a static source inventory: the CLI checks the exact loaded JavaScript,
 * template, config, baseline, or verifier bytes before the handler can run.
 */
export const ACTIVE_IDENTITY_OPERATION_BOUNDARIES = Object.freeze([
  identityBoundary({
    id: 'canonical-journal-authority',
    preSideEffect: true,
    commands: Object.freeze(['acceptance_amendment_propose', 'acceptance_amendment_review', 'acceptance_amendment_approve', 'acceptance_amendment_cancel', 'review_inventory_begin', 'review_inventory_finalize', 'story_advance']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/acceptance-amendment-journal.ts'),
      runtimeSource('packages/main/src/core/convergence-effective-progress.ts'),
      runtimeSource('packages/main/src/core/convergence-progress-journal.ts'),
      runtimeSource('packages/main/src/core/store.ts'),
    ]),
    identitySites: Object.freeze([
      { ...identitySite('packages/main/src/core/acceptance-amendment-journal.ts', 'proof-or-stop.acceptance_amendment.v1', 'schemaVersion: ACCEPTANCE_AMENDMENT_ENTRY_SCHEMA', "schemaVersion: 'proofbound.acceptance_amendment.v1'"), identityOrigin: { sourcePath: 'packages/main/src/core/artifact-schema.ts', exportName: 'ACCEPTANCE_AMENDMENT_ENTRY_SCHEMA' } },
      { ...identitySite('packages/main/src/core/acceptance-amendment-journal.ts', 'proof-or-stop.acceptance_amendments.v1', 'schemaVersion: ACCEPTANCE_AMENDMENT_JOURNAL_SCHEMA', "schemaVersion: 'proofbound.acceptance_amendments.v1'"), identityOrigin: { sourcePath: 'packages/main/src/core/artifact-schema.ts', exportName: 'ACCEPTANCE_AMENDMENT_JOURNAL_SCHEMA' } },
      { ...identitySite('packages/main/src/core/convergence-effective-progress.ts', 'proof-or-stop.effective_progress.v1', 'schemaVersion: EFFECTIVE_PROGRESS_SCHEMA', "schemaVersion: 'proofbound.effective_progress.v1'"), identityOrigin: { sourcePath: 'packages/main/src/core/artifact-schema.ts', exportName: 'EFFECTIVE_PROGRESS_SCHEMA' } },
      { ...identitySite('packages/main/src/core/convergence-progress-journal.ts', 'proof-or-stop.convergence_progress_journal.v1', 'schemaVersion: CONVERGENCE_PROGRESS_JOURNAL_SCHEMA', "schemaVersion: 'proofbound.convergence_progress_journal.v1'"), identityOrigin: { sourcePath: 'packages/main/src/core/artifact-schema.ts', exportName: 'CONVERGENCE_PROGRESS_JOURNAL_SCHEMA' } },
      { ...identitySite('packages/main/src/core/store.ts', 'proof-or-stop.causal-evidence-index.v1', 'schemaVersion: CAUSAL_EVIDENCE_INDEX_SCHEMA', "schemaVersion: 'proofbound.causal-evidence-index.v1'"), identityOrigin: { sourcePath: 'packages/main/src/core/causal-evidence.ts', exportName: 'CAUSAL_EVIDENCE_INDEX_SCHEMA' } },
      identitySite('packages/main/src/core/store.ts', 'proof-or-stop.decision_doc_proposals.v1'),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/acceptance-amendment-journal.ts', 'proof-or-stop.acceptance_amendment.v1'),
      identityMutationCase('packages/main/src/core/acceptance-amendment-journal.ts', 'proof-or-stop.acceptance_amendments.v1'),
      identityMutationCase('packages/main/src/core/convergence-effective-progress.ts', 'proof-or-stop.effective_progress.v1'),
      identityMutationCase('packages/main/src/core/convergence-progress-journal.ts', 'proof-or-stop.convergence_progress_journal.v1'),
      identityMutationCase('packages/main/src/core/store.ts', 'proof-or-stop.causal-evidence-index.v1'),
      identityMutationCase('packages/main/src/core/store.ts', 'proof-or-stop.decision_doc_proposals.v1'),
    ]),
  }),
  identityBoundary({
    id: 'acceptance-amendment-review',
    commands: Object.freeze(['agent_prompt', 'acceptance_amendment_review', 'acceptance_amendment_approve']),
    paths: Object.freeze([runtimeSource('packages/main/src/core/acceptance-amendment-review.ts')]),
    identitySites: Object.freeze([
      { ...identitySite('packages/main/src/core/acceptance-amendment-review.ts', 'proof-or-stop-acceptance-intent-reviewer'),
        valueBinding: { kind: 'export-const', name: 'ACCEPTANCE_REVIEW_LANE' } },
      { ...identitySite('packages/main/src/core/acceptance-amendment-review.ts', 'proof-or-stop.acceptance_amendment_review_final.v1'),
        valueBinding: { kind: 'export-const', name: 'ACCEPTANCE_REVIEW_FINAL_SCHEMA' } },
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/acceptance-amendment-review.ts', 'proof-or-stop-acceptance-intent-reviewer'),
      identityMutationCase('packages/main/src/core/acceptance-amendment-review.ts', 'proof-or-stop.acceptance_amendment_review_final.v1'),
    ]),
  }),
  identityBoundary({
    id: 'candidate-spec-routing',
    commands: Object.freeze(['candidate_spec_route', 'candidate_spec_rollout_check']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/candidate-spec-routing.ts'),
      runtimeSource('packages/main/src/handlers/candidate-spec-routing.ts'),
    ]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/candidate-spec-routing.ts', 'proof-or-stop.corpus-index.v1'),
      historicalIdentitySite("packages/main/src/core/candidate-spec-routing.ts", "proof-or-stop.candidate-spec-set.v1", "proofbound.candidate-spec-set.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/candidate-spec-routing.ts", "proof-or-stop.keyword-proposal.v1", "proofbound.keyword-proposal.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/candidate-spec-routing.ts", "proof-or-stop.keyword-seeds.v1", "proofbound.keyword-seeds.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/handlers/candidate-spec-routing.ts', 'proof-or-stop.keyword-proposal.v1',
        'Return only one compact JSON object matching proof-or-stop.keyword-proposal.v1.',
        'Return only one compact JSON object matching proofbound.keyword-proposal.v1.'),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/candidate-spec-routing.ts', 'proof-or-stop.corpus-index.v1'),
      identityMutationCase("packages/main/src/core/candidate-spec-routing.ts", "proof-or-stop.candidate-spec-set.v1"),
      identityMutationCase("packages/main/src/core/candidate-spec-routing.ts", "proof-or-stop.keyword-proposal.v1"),
      identityMutationCase("packages/main/src/core/candidate-spec-routing.ts", "proof-or-stop.keyword-seeds.v1"),
      identityMutationCase('packages/main/src/handlers/candidate-spec-routing.ts', 'proof-or-stop.keyword-proposal.v1'),
    ]),
  }),
  identityBoundary({
    id: 'certification-window',
    commands: Object.freeze(['certification_window_begin', 'certification_window_status', 'certification_window_cancel']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/certification-window.ts'),
    ]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/certification-window.ts', 'proof-or-stop.certification_window.v1'),
      historicalIdentitySite("packages/main/src/core/certification-window.ts", "proof-or-stop.certification-window.v1", "proofbound.certification-window.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/certification-window.ts", "proof-or-stop.certification_windows.v1", "proofbound.certification_windows.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/certification-window.ts", "proof-or-stop.precert-receipt.v1", "proofbound.precert-receipt.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/certification-window.ts", "proof-or-stop.precert_receipt.v1", "proofbound.precert_receipt.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/certification-window.ts", "proof-or-stop.precert_cheap_check_receipt.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/certification-window.ts", "proof-or-stop.precert-cheap-check-receipt.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/certification-window.ts', 'proof-or-stop.certification_window.v1'),
      identityMutationCase("packages/main/src/core/certification-window.ts", "proof-or-stop.certification-window.v1"),
      identityMutationCase("packages/main/src/core/certification-window.ts", "proof-or-stop.certification_windows.v1"),
      identityMutationCase("packages/main/src/core/certification-window.ts", "proof-or-stop.precert-receipt.v1"),
      identityMutationCase("packages/main/src/core/certification-window.ts", "proof-or-stop.precert_receipt.v1"),
      identityMutationCase("packages/main/src/core/certification-window.ts", "proof-or-stop.precert_cheap_check_receipt.v1"),
      identityMutationCase("packages/main/src/core/certification-window.ts", "proof-or-stop.precert-cheap-check-receipt.v1"),
    ]),
  }),
  identityBoundary({
    id: 'review-incremental-context',
    commands: Object.freeze(['review_incremental_context', 'review_run_start']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/git-tree-observation.ts'),
      runtimeSource('packages/main/src/core/evidence-freshness.ts'),
      runtimeSource('packages/main/src/core/verification-execution-evidence.ts'),
      runtimeSource('packages/main/src/core/executable-digest-observation.ts'),
      runtimeSource('packages/main/src/core/impact-classification-policy.ts'),
      runtimeSource('packages/main/src/core/review-incremental-context.ts'),
      runtimeSource('packages/main/src/handlers/review-run.ts'),
    ]),
    identityFreePaths: Object.freeze([identityFreePath('packages/main/src/core/executable-digest-observation.ts', 'Synchronous executable byte observation has no artifact or role identity literal; emitted delegate bytes are independently pinned and mutation-tested'), identityFreePath('packages/main/src/core/git-tree-observation.ts', 'Raw Git observation delegate contains no artifact/domain/role identity literal; its emitted executable bytes are independently pinned and mutation-tested')]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/evidence-freshness.ts', 'proof-or-stop.evidence-freshness-classifier.v1'),
      { ...identitySite('packages/main/src/core/evidence-freshness.ts', 'proof-or-stop.verifier-dependency-manifest.v1'), valueBinding: { kind: 'export-const', name: 'VERIFIER_DEPENDENCY_MANIFEST_VERSION' } },
      { ...identitySite('packages/main/src/core/evidence-freshness.ts', 'proof-or-stop.verifier-dependency-manifest-binding.v1'), valueBinding: { kind: 'export-const', name: 'VERIFIER_DEPENDENCY_MANIFEST_BINDING_VERSION' } },
      identitySite('packages/main/src/core/verification-execution-evidence.ts', 'proof-or-stop.verifier-dependency-manifest-binding.v1'),
      { ...identitySite('packages/main/src/core/evidence-freshness.ts', 'proof-or-stop.evidence_hash_snapshot.v1', 'schemaVersion: EVIDENCE_HASH_SNAPSHOT_SCHEMA', "schemaVersion: 'lattice.evidence_hash_snapshot.v1'", 'lattice.evidence_hash_snapshot.v1', { commit: '69403365ae9a19422564babf93f6c10de869c81d', sourcePath: 'packages/main/src/core/artifact-schema.ts', value: 'lattice.evidence_hash_snapshot.v1', use: 'producer-or-domain' }), identityOrigin: { sourcePath: 'packages/main/src/core/artifact-schema.ts', exportName: 'EVIDENCE_HASH_SNAPSHOT_SCHEMA' } },
      identitySite('packages/main/src/core/impact-classification-policy.ts', 'proof-or-stop.impact-classification.v1'),
      identitySite('packages/main/src/handlers/review-run.ts', 'proof-or-stop-review-topology-critic', undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/core/review-incremental-context.ts', 'proof-or-stop-review-topology-critic', undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite(
        'packages/main/src/core/review-incremental-context.ts',
        'proof-or-stop.incremental-review-basis.v1',
        'schemaVersion: CURRENT_PROMPT_IDENTITIES.incrementalReviewBasis',
        `schemaVersion: '${retiredIdentityNeedle('.incremental-review-basis.v1')}'`,
      ),
      identitySite("packages/main/src/core/review-incremental-context.ts", "proof-or-stop.post-remediation-review-selection.v2", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite(
        'packages/main/src/handlers/review-run.ts',
        'proof-or-stop.prompt-envelope.v1',
        'const assembly = assembleConditionalReviewPromptEnvelope({',
        `const assembly = assembleConditionalReviewPromptEnvelope({ activeIdentitySchema: '${retiredIdentityNeedle('.prompt-envelope.v1')}',`,
      ),
      historicalIdentitySite("packages/main/src/handlers/review-run.ts", "proof-or-stop.review_run_list.v1", "proofbound.review_run_list.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/evidence-freshness.ts', 'proof-or-stop.evidence-freshness-classifier.v1'),
      identityMutationCase('packages/main/src/core/evidence-freshness.ts', 'proof-or-stop.verifier-dependency-manifest.v1'),
      identityMutationCase('packages/main/src/core/evidence-freshness.ts', 'proof-or-stop.verifier-dependency-manifest-binding.v1'),
      identityMutationCase('packages/main/src/core/verification-execution-evidence.ts', 'proof-or-stop.verifier-dependency-manifest-binding.v1'),
      identityMutationCase('packages/main/src/core/evidence-freshness.ts', 'proof-or-stop.evidence_hash_snapshot.v1'),
      identityMutationCase('packages/main/src/core/impact-classification-policy.ts', 'proof-or-stop.impact-classification.v1'),
      identityMutationCase('packages/main/src/handlers/review-run.ts', 'proof-or-stop-review-topology-critic'),
      identityMutationCase('packages/main/src/core/review-incremental-context.ts', 'proof-or-stop-review-topology-critic'),
      identityMutationCase('packages/main/src/core/review-incremental-context.ts', 'proof-or-stop.incremental-review-basis.v1'),
      identityMutationCase("packages/main/src/core/review-incremental-context.ts", "proof-or-stop.post-remediation-review-selection.v2"),
      identityMutationCase('packages/main/src/handlers/review-run.ts', 'proof-or-stop.prompt-envelope.v1'),
      identityMutationCase("packages/main/src/handlers/review-run.ts", "proof-or-stop.review_run_list.v1"),
    ]),
  }),
  identityBoundary({
    id: 'maintenance-command-mode',
    // Authenticated by the earlier argument-delegate preflight, before modes
    // are interpreted. Do not repeat that same check in the consumer loop.
    commands: Object.freeze(['story_reconcile', 'quorum_prune', 'capability_release_backfill', 'verification_evidence_refresh_stale']),
    paths: Object.freeze([runtimeSource('packages/main/src/core/maintenance-command-mode.ts')]),
    identityFreePaths: Object.freeze([identityFreePath('packages/main/src/core/maintenance-command-mode.ts', 'Boolean preview/execute delegate contains no artifact or role identity literal; emitted executable bytes are pinned before argument classification')]),
    identitySites: Object.freeze([]),
    mutationCases: Object.freeze([]),
  }),
  identityBoundary({
    id: 'review-inventory-epoch',
    commands: Object.freeze(['review_inventory_finalize', 'certification_window_begin', 'certification_window_status']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/review-inventory-epoch.ts'),
      runtimeSource('packages/main/src/core/verification-execution-evidence.ts'),
      runtimeSource('packages/main/src/core/executable-digest-observation.ts'),
      runtimeSource('packages/main/src/handlers/checklist.ts'),
    ]),
    identityFreePaths: Object.freeze([identityFreePath('packages/main/src/core/executable-digest-observation.ts', 'Synchronous executable byte observation has no artifact or role identity literal; emitted delegate bytes are independently pinned and mutation-tested')]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/review-inventory-epoch.ts', 'proof-or-stop.review_inventory_epochs.v1'),
      { ...identitySite('packages/main/src/core/review-inventory-epoch.ts', 'proof-or-stop.inventory-verification-observation.v1'), valueBinding: { kind: 'property', name: 'schemaVersion', functionName: 'reviewInventoryAcceptanceSubjectDigest' } },
      { ...identitySite('packages/main/src/core/review-inventory-epoch.ts', 'proof-or-stop.verification-receipt-bundle.v5'), valueBinding: { kind: 'comparison', expression: 'evidence.receipt.schemaVersion', functionName: 'reviewInventoryAcceptanceSubjectDigest' } },
      { ...identitySite('packages/main/src/core/verification-execution-evidence.ts', 'proof-or-stop.verification-receipt-bundle.v5', 'schemaVersion: VERIFICATION_RECEIPT_BUNDLE_V5', "schemaVersion: 'proofbound.verification-receipt-bundle.v5'"), identityOrigin: { sourcePath: 'packages/main/src/core/artifact-schema.ts', exportName: 'VERIFICATION_RECEIPT_BUNDLE_V5' } },
      identitySite('packages/main/src/handlers/checklist.ts', 'proof-or-stop.verification-receipt-bundle.v5', undefined, undefined, undefined, undefined, { canonical: 10, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop-verification-receipt-signer-v1.key", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-assertion-receipt.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-assertion-receipt.v2", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-identity.v1", undefined, undefined, undefined, undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-key.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-lock.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-receipt.v2", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-receipt.v3", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-ticket.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-output.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-publication-binding.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-receipt-bundle-binding.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-receipt-bundle.v2", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-receipt-bundle.v3", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-receipt-bundle.v4", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-record-authenticity.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-record.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-reuse-receipt.v1", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/handlers/checklist.ts', 'proof-or-stop.plan-acceptance-batch.v1', undefined, undefined, undefined, undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/handlers/checklist.ts", "proof-or-stop-implementer", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/handlers/checklist.ts", "proof-or-stop-product-reviewer", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/handlers/checklist.ts", "proof-or-stop-review-story-init", undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/handlers/checklist.ts", "proof-or-stop.verification-execution-receipt.v3", undefined, undefined, undefined, undefined, { canonical: 5, retired: 0 }),
      identitySite("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop-review-topology-critic", "proof-or-stop-review-topology-critic", "proofbound-review-topology-critic", "proofbound-review-topology-critic", undefined, { canonical: 2, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review-inventory-critic-receipt.v1", "proofbound.review-inventory-critic-receipt.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review-inventory-epoch.v1", "proofbound.review-inventory-epoch.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review-inventory-receipt.v1", "proofbound.review-inventory-receipt.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review_inventory_critic_receipt.v1", "proofbound.review_inventory_critic_receipt.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review_inventory_epoch.v1", "proofbound.review_inventory_epoch.v1", "producer-or-domain", { canonical: 2, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review_inventory_receipt.v1", "proofbound.review_inventory_receipt.v1", "producer-or-domain", { canonical: 2, retired: 0 }),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/review-inventory-epoch.ts', 'proof-or-stop.review_inventory_epochs.v1'),
      identityMutationCase('packages/main/src/core/review-inventory-epoch.ts', 'proof-or-stop.inventory-verification-observation.v1'),
      identityMutationCase('packages/main/src/core/review-inventory-epoch.ts', 'proof-or-stop.verification-receipt-bundle.v5'),
      identityMutationCase('packages/main/src/core/verification-execution-evidence.ts', 'proof-or-stop.verification-receipt-bundle.v5'),
      identityMutationCase('packages/main/src/handlers/checklist.ts', 'proof-or-stop.plan-acceptance-batch.v1'),
      identityMutationCase('packages/main/src/handlers/checklist.ts', 'proof-or-stop.verification-receipt-bundle.v5'),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop-verification-receipt-signer-v1.key"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-assertion-receipt.v1"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-assertion-receipt.v2"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-identity.v1"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-key.v1"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-lock.v1"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-receipt.v2"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-receipt.v3"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-execution-ticket.v1"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-output.v1"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-publication-binding.v1"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-receipt-bundle-binding.v1"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-receipt-bundle.v2"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-receipt-bundle.v3"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-receipt-bundle.v4"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-record-authenticity.v1"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-record.v1"),
      identityMutationCase("packages/main/src/core/verification-execution-evidence.ts", "proof-or-stop.verification-reuse-receipt.v1"),
      identityMutationCase("packages/main/src/handlers/checklist.ts", "proof-or-stop-implementer"),
      identityMutationCase("packages/main/src/handlers/checklist.ts", "proof-or-stop-product-reviewer"),
      identityMutationCase("packages/main/src/handlers/checklist.ts", "proof-or-stop-review-story-init"),
      identityMutationCase("packages/main/src/handlers/checklist.ts", "proof-or-stop.verification-execution-receipt.v3"),
      identityMutationCase("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop-review-topology-critic"),
      identityMutationCase("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review-inventory-critic-receipt.v1"),
      identityMutationCase("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review-inventory-epoch.v1"),
      identityMutationCase("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review-inventory-receipt.v1"),
      identityMutationCase("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review_inventory_critic_receipt.v1"),
      identityMutationCase("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review_inventory_epoch.v1"),
      identityMutationCase("packages/main/src/core/review-inventory-epoch.ts", "proof-or-stop.review_inventory_receipt.v1"),
    ]),
  }),
  identityBoundary({
    id: 'learning-source-lineage',
    commands: Object.freeze(['source_lineage_audit']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/experience-layer-types.ts'),
      runtimeSource('packages/main/src/core/learning-store.ts'),
      runtimeSource('packages/main/src/core/playbook-seed.ts'),
      runtimeSource('packages/main/src/core/source-lineage-audit.ts'),
      runtimeSource('packages/main/src/handlers/playbook.ts'),
    ]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/learning-store.ts', 'proof-or-stop.playbook-outcome.v1'),
      historicalIdentitySite("packages/main/src/core/learning-store.ts", "proof-or-stop.non-deducible-source.v1", "proofbound.non-deducible-source.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/learning-store.ts", "proof-or-stop.non-deducible-sources.v1", "proofbound.non-deducible-sources.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/learning-store.ts", "proof-or-stop.playbook-auto-activation.v1", "proofbound.playbook-auto-activation.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/learning-store.ts", "proof-or-stop.playbook-promotion-decision.v1", "proofbound.playbook-promotion-decision.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/learning-store.ts", "proof-or-stop.playbook-promotion-health.v1", "proofbound.playbook-promotion-health.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/learning-store.ts", "proof-or-stop.playbook-promotion-observe.v1", "proofbound.playbook-promotion-observe.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/learning-store.ts", "proof-or-stop.playbook-trial-control.v1", "proofbound.playbook-trial-control.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/core/playbook-seed.ts', 'proof-or-stop.playbook-seed-observe.v1'),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.evidence-activated-advisory-playbook.v1", "proofbound.evidence-activated-advisory-playbook.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-auto-activation.v1", "proofbound.playbook-auto-activation.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-auto-promotion-apply.v1", "proofbound.playbook-auto-promotion-apply.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-candidate-batch-manifest.v1", "proofbound.playbook-candidate-batch-manifest.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-candidate-ingest.v1", "proofbound.playbook-candidate-ingest.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-outcome.v1", "proofbound.playbook-outcome.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-promotion-decision.v1", "proofbound.playbook-promotion-decision.v1", "producer-or-domain", { canonical: 2, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-promotion-timer.v1", "proofbound.playbook-promotion-timer.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-runtime-consumption-verify.v1", "proofbound.playbook-runtime-consumption-verify.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-seed-backfill.v1", "proofbound.playbook-seed-backfill.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-seed-propose-batch.v1", "proofbound.playbook-seed-propose-batch.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-trial-control.v1", "proofbound.playbook-trial-control.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-trial-run.v1", "proofbound.playbook-trial-run.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/core/source-lineage-audit.ts', 'proof-or-stop.source-lineage-audit.v1'),
      historicalIdentitySite("packages/main/src/core/source-lineage-audit.ts", "proof-or-stop.learning-source-key.v1", "proofbound.learning-source-key.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/handlers/playbook.ts', 'proof-or-stop.playbook-outcome.v1'),
      historicalIdentitySite("packages/main/src/handlers/playbook.ts", "proof-or-stop.playbook-promotion-decision.v1", "proofbound.playbook-promotion-decision.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/learning-store.ts', 'proof-or-stop.playbook-outcome.v1'),
      identityMutationCase("packages/main/src/core/learning-store.ts", "proof-or-stop.non-deducible-source.v1"),
      identityMutationCase("packages/main/src/core/learning-store.ts", "proof-or-stop.non-deducible-sources.v1"),
      identityMutationCase("packages/main/src/core/learning-store.ts", "proof-or-stop.playbook-auto-activation.v1"),
      identityMutationCase("packages/main/src/core/learning-store.ts", "proof-or-stop.playbook-promotion-decision.v1"),
      identityMutationCase("packages/main/src/core/learning-store.ts", "proof-or-stop.playbook-promotion-health.v1"),
      identityMutationCase("packages/main/src/core/learning-store.ts", "proof-or-stop.playbook-promotion-observe.v1"),
      identityMutationCase("packages/main/src/core/learning-store.ts", "proof-or-stop.playbook-trial-control.v1"),
      identityMutationCase('packages/main/src/core/playbook-seed.ts', 'proof-or-stop.playbook-seed-observe.v1'),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.evidence-activated-advisory-playbook.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-auto-activation.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-auto-promotion-apply.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-candidate-batch-manifest.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-candidate-ingest.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-outcome.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-promotion-decision.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-promotion-timer.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-runtime-consumption-verify.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-seed-backfill.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-seed-propose-batch.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-trial-control.v1"),
      identityMutationCase("packages/main/src/core/playbook-seed.ts", "proof-or-stop.playbook-trial-run.v1"),
      identityMutationCase('packages/main/src/core/source-lineage-audit.ts', 'proof-or-stop.source-lineage-audit.v1'),
      identityMutationCase("packages/main/src/core/source-lineage-audit.ts", "proof-or-stop.learning-source-key.v1"),
      identityMutationCase('packages/main/src/handlers/playbook.ts', 'proof-or-stop.playbook-outcome.v1'),
      identityMutationCase("packages/main/src/handlers/playbook.ts", "proof-or-stop.playbook-promotion-decision.v1"),
    ]),
    identityFreePaths: Object.freeze([
      identityFreePath('packages/main/src/core/experience-layer-types.ts', 'type-only source has no artifact or role identity literal; its emitted module (including export marker) is independently pinned'),
    ]),
  }),
  identityBoundary({
    id: 'playbook-runtime-memory',
    commands: Object.freeze(['playbook_runtime_health', 'final_response_check']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/playbook-runtime-baseline.ts'),
      runtimeSource('packages/main/src/core/playbook-runtime-memory-cache.ts'),
      runtimeSource('packages/main/src/core/playbook-runtime-memory-index.ts'),
      runtimeSource('packages/main/src/core/playbook-runtime-memory.ts'),
      runtimeSource('packages/main/src/handlers/playbook-runtime-memory.ts'),
    ]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/playbook-runtime-baseline.ts', 'proof-or-stop.memory-playbook-baseline.v1'),
      historicalIdentitySite("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop-memory-baseline-global-", "proofbound-memory-baseline-global-", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop-memory-baseline-matrix-", "proofbound-memory-baseline-matrix-", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop-memory-baseline-runtime-", "proofbound-memory-baseline-runtime-", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop-memory-baseline-runtime-corpus-", "proofbound-memory-baseline-runtime-corpus-", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop.memory-playbook-baseline.gold.v1", "proofbound.memory-playbook-baseline.gold.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop.memory-playbook-optimized-parity.v1", "proofbound.memory-playbook-optimized-parity.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/core/playbook-runtime-memory-cache.ts', 'proof-or-stop.runtime-memory-pack-cache.v2'),
      identitySite('packages/main/src/core/playbook-runtime-memory-index.ts', 'proof-or-stop.runtime-memory-index.v3'),
      identitySite('packages/main/src/core/playbook-runtime-memory.ts', 'proof-or-stop.memory-pack.v1'),
      identitySite('packages/main/src/core/playbook-runtime-memory.ts', 'proof-or-stop.dev-memory-finish-decision.v1'),
      identitySite('packages/main/src/handlers/playbook-runtime-memory.ts', 'proof-or-stop.playbook-runtime-health.v1'),
      historicalIdentitySite("packages/main/src/handlers/playbook-runtime-memory.ts", "proof-or-stop.dev-memory-finish-decision.v1", "proofbound.dev-memory-finish-decision.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/handlers/playbook-runtime-memory.ts", "proof-or-stop.final-response-check.v1", "proofbound.final-response-check.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/playbook-runtime-baseline.ts', 'proof-or-stop.memory-playbook-baseline.v1'),
      identityMutationCase("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop-memory-baseline-global-"),
      identityMutationCase("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop-memory-baseline-matrix-"),
      identityMutationCase("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop-memory-baseline-runtime-"),
      identityMutationCase("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop-memory-baseline-runtime-corpus-"),
      identityMutationCase("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop.memory-playbook-baseline.gold.v1"),
      identityMutationCase("packages/main/src/core/playbook-runtime-baseline.ts", "proof-or-stop.memory-playbook-optimized-parity.v1"),
      identityMutationCase('packages/main/src/core/playbook-runtime-memory-cache.ts', 'proof-or-stop.runtime-memory-pack-cache.v2'),
      identityMutationCase('packages/main/src/core/playbook-runtime-memory-index.ts', 'proof-or-stop.runtime-memory-index.v3'),
      identityMutationCase('packages/main/src/core/playbook-runtime-memory.ts', 'proof-or-stop.memory-pack.v1'),
      identityMutationCase('packages/main/src/core/playbook-runtime-memory.ts', 'proof-or-stop.dev-memory-finish-decision.v1'),
      identityMutationCase('packages/main/src/handlers/playbook-runtime-memory.ts', 'proof-or-stop.playbook-runtime-health.v1'),
      identityMutationCase("packages/main/src/handlers/playbook-runtime-memory.ts", "proof-or-stop.dev-memory-finish-decision.v1"),
      identityMutationCase("packages/main/src/handlers/playbook-runtime-memory.ts", "proof-or-stop.final-response-check.v1"),
    ]),
  }),
  identityBoundary({
    id: 'lifecycle-control',
    commands: Object.freeze(['global_control_status', 'runtime_closure_status', 'queue_governance_status']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/lifecycle-control/control-status.ts'),
      runtimeSource('packages/main/src/core/lifecycle-control/queue/index.ts'),
    ]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/lifecycle-control/queue/index.ts', 'proof-or-stop.queue_governance_status.v1'),
      historicalIdentitySite("packages/main/src/core/lifecycle-control/queue/index.ts", "proof-or-stop.queue_exception.v1", "proofbound.queue_exception.v1", "producer-or-domain", { canonical: 6, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/lifecycle-control/queue/index.ts", "proof-or-stop.queue_exception_registry.v1", "lattice.queue_exception_registry.v1", "producer-or-domain", { canonical: 2, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/lifecycle-control/queue/index.ts", "proof-or-stop.queue_exception_set.v1", "lattice.queue_exception_set.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/lifecycle-control/queue/index.ts', 'proof-or-stop.queue_governance_status.v1'),
      identityMutationCase("packages/main/src/core/lifecycle-control/queue/index.ts", "proof-or-stop.queue_exception.v1"),
      identityMutationCase("packages/main/src/core/lifecycle-control/queue/index.ts", "proof-or-stop.queue_exception_registry.v1"),
      identityMutationCase("packages/main/src/core/lifecycle-control/queue/index.ts", "proof-or-stop.queue_exception_set.v1"),
    ]),
    identityFreePaths: Object.freeze([
      identityFreePath('packages/main/src/core/lifecycle-control/control-status.ts', 'Emitted constants are classification/lane/status vocabulary, carry no artifact or reviewer-role identity literal, and are independently pinned'),
    ]),
  }),
  identityBoundary({
    id: 'milestone-status',
    commands: Object.freeze(['milestone_status', 'milestone_closeout']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/milestone-status.ts'),
    ]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/milestone-status.ts', 'proof-or-stop.milestone_status.v1'),
      historicalIdentitySite("packages/main/src/core/milestone-status.ts", "proof-or-stop.milestone_closeout.v1", "proofbound.milestone_closeout.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/milestone-status.ts", "proof-or-stop.milestone_closeout_missing.v1", "proofbound.milestone_closeout_missing.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/milestone-status.ts', 'proof-or-stop.milestone_status.v1'),
      identityMutationCase("packages/main/src/core/milestone-status.ts", "proof-or-stop.milestone_closeout.v1"),
      identityMutationCase("packages/main/src/core/milestone-status.ts", "proof-or-stop.milestone_closeout_missing.v1"),
    ]),
  }),
  identityBoundary({
    id: 'process-fact-registry',
    commands: Object.freeze(['session_brief']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/process-fact-registry.ts'),
    ]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/process-fact-registry.ts', 'proof-or-stop.candidate-spec-set.v1'),
      identitySite("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-product-reviewer", "proof-or-stop-product-reviewer", "proofbound-product-reviewer", "proofbound-product-reviewer", undefined, { canonical: 4, retired: 0 }),
      identitySite("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-behavior", "proof-or-stop-review-behavior", "proofbound-review-behavior", "proofbound-review-behavior", undefined, { canonical: 4, retired: 0 }),
      identitySite("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-channel", "proof-or-stop-review-channel", "proofbound-review-channel", "proofbound-review-channel", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-concept", "proof-or-stop-review-concept", "proofbound-review-concept", "proofbound-review-concept", undefined, { canonical: 4, retired: 0 }),
      identitySite("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-delivery", "proof-or-stop-review-delivery", "proofbound-review-delivery", "proofbound-review-delivery", undefined, { canonical: 5, retired: 0 }),
      identitySite("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-docs", "proof-or-stop-review-docs", "proofbound-review-docs", "proofbound-review-docs", undefined, { canonical: 4, retired: 0 }),
      identitySite("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-quality", "proof-or-stop-review-quality", "proofbound-review-quality", "proofbound-review-quality", undefined, { canonical: 4, retired: 0 }),
      identitySite("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-scope-plan", "proof-or-stop-review-scope-plan", "proofbound-review-scope-plan", "proofbound-review-scope-plan", undefined, { canonical: 6, retired: 0 }),
      identitySite("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-story-init", "proof-or-stop-review-story-init", "proofbound-review-story-init", "proofbound-review-story-init", undefined, { canonical: 5, retired: 0 }),
      identitySite("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-test-coverage", "proof-or-stop-review-test-coverage", "proofbound-review-test-coverage", "proofbound-review-test-coverage", undefined, { canonical: 4, retired: 0 }),
      identitySite("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-topology-critic", "proof-or-stop-review-topology-critic", "proofbound-review-topology-critic", "proofbound-review-topology-critic", undefined, { canonical: 6, retired: 0 }),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/process-fact-registry.ts', 'proof-or-stop.candidate-spec-set.v1'),
      identityMutationCase("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-product-reviewer"),
      identityMutationCase("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-behavior"),
      identityMutationCase("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-channel"),
      identityMutationCase("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-concept"),
      identityMutationCase("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-delivery"),
      identityMutationCase("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-docs"),
      identityMutationCase("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-quality"),
      identityMutationCase("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-scope-plan"),
      identityMutationCase("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-story-init"),
      identityMutationCase("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-test-coverage"),
      identityMutationCase("packages/main/src/core/process-fact-registry.ts", "proof-or-stop-review-topology-critic"),
    ]),
  }),
  identityBoundary({
    id: 'prompt-runtime',
    commands: Object.freeze(['agent_prompt', 'dispatch', 'prompt_measurement_report']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/config.ts'),
      runtimeSource('packages/main/src/core/prompt-budget.ts'),
      runtimeSource('packages/main/src/core/delivery-review-authority.ts'),
      runtimeSource('packages/main/src/core/prompt-contracts.ts'),
      runtimeSource('packages/main/src/core/prompt-envelope.ts'),
      runtimeSource('packages/main/src/core/prompt-measurement.ts'),
      runtimeSource('packages/main/src/core/prompt-registry.ts'),
      runtimeSource('packages/main/src/core/prompt-role-contract-registry.ts'),
      runtimeSource('packages/main/src/core/review-run.ts'),
      runtimeSource('packages/main/src/handlers/agent-prompt.ts'),
      runtimeSource('packages/main/src/handlers/story-dispatch.ts'),
      runtimeSource('packages/main/src/cli-init.ts'),
      projectSource('docs/requirements/baselines/role-prompt-measurement-baseline.json'),
      ...[
        'proof-or-stop-evaluator.md',
        'proof-or-stop-implementer.md',
        'proof-or-stop-review-behavior.md',
        'proof-or-stop-review-concept.md',
        'proof-or-stop-review-delivery.md',
        'proof-or-stop-review-docs.md',
        'proof-or-stop-review-quality.md',
        'proof-or-stop-review-scope-plan.md',
        'proof-or-stop-review-story-init.md',
        'proof-or-stop-review-test-coverage.md',
      ].map((name) => runtimeSource(`packages/main/templates/agents/${name}`)),
    ]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/config.ts', 'proof-or-stop.prompt-envelope-rollout.v1'),
      identitySite('packages/main/src/core/prompt-budget.ts', 'proof-or-stop.prompt-budget-observation.v1'),
      identitySite("packages/main/src/core/prompt-budget.ts", "proof-or-stop-implementer", "proof-or-stop-implementer", "proofbound-implementer", "proofbound-implementer", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-budget.ts", "proof-or-stop-review-delivery", "proof-or-stop-review-delivery", "proofbound-review-delivery", "proofbound-review-delivery", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-budget.ts", "proof-or-stop-review-scope-plan", "proof-or-stop-review-scope-plan", "proofbound-review-scope-plan", "proofbound-review-scope-plan", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-budget.ts", "proof-or-stop-review-story-init", "proof-or-stop-review-story-init", "proofbound-review-story-init", "proofbound-review-story-init", undefined, { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.prompt-envelope.v1'),
      identitySite("packages/main/src/core/prompt-contracts.ts", "proof-or-stop.canonical-json.code-point-keys.v1", "proof-or-stop.canonical-json.code-point-keys.v1", "proofbound.canonical-json.code-point-keys.v1", "proofbound.canonical-json.code-point-keys.v1", undefined, { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.agent-runtime.v1'),
      identitySite('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.role-contract.v1'),
      identitySite('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.prompt-measurement.v1'),
      identitySite('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.known-execution-environment.v1'),
      identitySite('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.full-task-context.v1'),
      identitySite('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.incremental-review-basis.v1'),
      identitySite('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.full-context-assembler.v1'),
      identitySite('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.prompt-dispatch.v1'),
      identitySite('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.digest.v1'),
      identitySite(
        'packages/main/src/core/prompt-envelope.ts',
        'proof-or-stop.prompt-envelope.v1',
        'schemaVersion: CURRENT_PROMPT_IDENTITIES.promptEnvelope',
        `schemaVersion: '${retiredIdentityNeedle('.prompt-envelope.v1')}'`,
      ),
      identitySite('packages/main/src/core/prompt-measurement.ts', 'proof-or-stop.prompt-measurement-report.v1'),
      identitySite("packages/main/src/core/prompt-measurement.ts", "proof-or-stop.lifecycle.init-to-done.v2", "proof-or-stop.lifecycle.init-to-done.v2", "proofbound.lifecycle.init-to-done.v2", "proofbound.lifecycle.init-to-done.v2", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-measurement.ts", "proof-or-stop.signed-process-facts.v1", "proof-or-stop.signed-process-facts.v1", "proofbound.signed-process-facts.v1", "proofbound.signed-process-facts.v1", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-measurement.ts", "proof-or-stop.story-owner-boundaries.v1", "proof-or-stop.story-owner-boundaries.v1", "proofbound.story-owner-boundaries.v1", "proofbound.story-owner-boundaries.v1", undefined, { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/core/prompt-registry.ts', 'proof-or-stop.prompt-registry.v1'),
      historicalIdentitySite("packages/main/src/core/prompt-registry.ts", "proof-or-stop-evaluator", "lattice-evaluator", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-registry.ts", "proof-or-stop-implementer", "lattice-implementer", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-behavior", "lattice-review-behavior", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-concept", "lattice-review-concept", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-delivery", "lattice-review-delivery", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-docs", "lattice-review-docs", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-quality", "lattice-review-quality", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-scope-plan", "lattice-review-scope-plan", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-story-init", "lattice-review-story-init", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-test-coverage", "lattice-review-test-coverage", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-topology-critic", "lattice-review-topology-critic", "reader-or-type-alternative", { canonical: 3, retired: 0 }),
      identitySite('packages/main/src/core/delivery-review-authority.ts', 'proof-or-stop-review-delivery', 'proof-or-stop-review-delivery', 'proofbound-review-delivery', 'proofbound-review-delivery', undefined, { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/core/prompt-role-contract-registry.ts', 'proof-or-stop.prompt-role-contract-registry.v1'),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-evaluator", "proof-or-stop-evaluator", "proofbound-evaluator", "proofbound-evaluator", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-evaluator-cli", "proof-or-stop-evaluator-cli", "proofbound-evaluator-cli", "proofbound-evaluator-cli", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-implementation-reviewer", "proof-or-stop-implementation-reviewer", "proofbound-implementation-reviewer", "proofbound-implementation-reviewer", undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-implementer", "proof-or-stop-implementer", "proofbound-implementer", "proofbound-implementer", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-product-reviewer", "proof-or-stop-product-reviewer", "proofbound-product-reviewer", "proofbound-product-reviewer", undefined, { canonical: 3, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-behavior", "proof-or-stop-review-behavior", "proofbound-review-behavior", "proofbound-review-behavior", undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-channel", "proof-or-stop-review-channel", "proofbound-review-channel", "proofbound-review-channel", undefined, { canonical: 4, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-concept", "proof-or-stop-review-concept", "proofbound-review-concept", "proofbound-review-concept", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-delivery", "proof-or-stop-review-delivery", "proofbound-review-delivery", "proofbound-review-delivery", undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-docs", "proof-or-stop-review-docs", "proofbound-review-docs", "proofbound-review-docs", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-quality", "proof-or-stop-review-quality", "proofbound-review-quality", "proofbound-review-quality", undefined, { canonical: 3, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-scope-plan", "proof-or-stop-review-scope-plan", "proofbound-review-scope-plan", "proofbound-review-scope-plan", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-story-init", "proof-or-stop-review-story-init", "proofbound-review-story-init", "proofbound-review-story-init", undefined, { canonical: 1, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-test-coverage", "proof-or-stop-review-test-coverage", "proofbound-review-test-coverage", "proofbound-review-test-coverage", undefined, { canonical: 3, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-topology-critic", "proof-or-stop-review-topology-critic", "proofbound-review-topology-critic", "proofbound-review-topology-critic", undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-test-case-reviewer", "proof-or-stop-test-case-reviewer", "proofbound-test-case-reviewer", "proofbound-test-case-reviewer", undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-test-intent", "proof-or-stop-test-intent", "proofbound-test-intent", "proofbound-test-intent", undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-verification-intent", "proof-or-stop-verification-intent", "proofbound-verification-intent", "proofbound-verification-intent", undefined, { canonical: 3, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop.prompt-envelope-rollout.v1", "proofbound.prompt-envelope-rollout.v1", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop.reviewer-host-render-identity.v1", "proofbound.reviewer-host-render-identity.v1", "reader-or-type-alternative", { canonical: 1, retired: 0 }),
      identitySite('packages/main/src/core/review-run.ts', 'proof-or-stop.review_run_workspace_binding.v1'),
      historicalIdentitySite("packages/main/src/core/review-run.ts", "proof-or-stop-review-run-workspace-binding-v1", "lattice-review-run-workspace-binding-v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      historicalIdentitySite("packages/main/src/core/review-run.ts", "proof-or-stop-review-topology-critic", "lattice-review-topology-critic", "reader-or-type-alternative", { canonical: 2, retired: 0 }),
      identitySite(
        'packages/main/src/core/review-run.ts',
        'proof-or-stop-review-run-integrity-v1',
        'proof-or-stop-review-run-integrity-v1',
        ['lat', 'tice-review-run-integrity-v1'].join(''),
        ['lat', 'tice-review-run-integrity-v1'].join(''),
        { commit: '69403365ae9a19422564babf93f6c10de869c81d', sourcePath: 'packages/main/src/core/review-run.ts', value: ['lat', 'tice-review-run-integrity-v1'].join(''), use: 'producer-or-domain' },
      ),
      identitySite('packages/main/src/handlers/agent-prompt.ts', 'proof-or-stop.agent-prompt-response.v1'),
      identitySite('packages/main/src/handlers/story-dispatch.ts', 'proof-or-stop-review-story-init'),
      identitySite("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-implementer", "proof-or-stop-implementer", "proofbound-implementer", "proofbound-implementer", undefined, { canonical: 9, retired: 0 }),
      identitySite("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-behavior", "proof-or-stop-review-behavior", "proofbound-review-behavior", "proofbound-review-behavior", undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-channel", "proof-or-stop-review-channel", "proofbound-review-channel", "proofbound-review-channel", undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-concept", "proof-or-stop-review-concept", "proofbound-review-concept", "proofbound-review-concept", undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-docs", "proof-or-stop-review-docs", "proofbound-review-docs", "proofbound-review-docs", undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-quality", "proof-or-stop-review-quality", "proofbound-review-quality", "proofbound-review-quality", undefined, { canonical: 2, retired: 0 }),
      identitySite("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-scope-plan", "proof-or-stop-review-scope-plan", "proofbound-review-scope-plan", "proofbound-review-scope-plan", undefined, { canonical: 6, retired: 0 }),
      identitySite("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-topology-critic", "proof-or-stop-review-topology-critic", "proofbound-review-topology-critic", "proofbound-review-topology-critic", undefined, { canonical: 6, retired: 0 }),
      identitySite('packages/main/src/cli-init.ts', 'proof-or-stop.prompt-envelope-rollout.v1', undefined, undefined, undefined, undefined, { canonical: 1, retired: 0 }),
      identitySite(
        'packages/main/src/cli-init.ts',
        'proof-or-stop.js',
        "const CANONICAL_BOOTSTRAP_REL = 'bin/proof-or-stop.js';",
        `const CANONICAL_BOOTSTRAP_REL = 'bin/${retiredIdentityNeedle('.js')}';`,
      ),
      identitySite('docs/requirements/baselines/role-prompt-measurement-baseline.json', 'proof-or-stop.prompt-measurement.v1'),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-evaluator", "proof-or-stop-evaluator", "proofbound-evaluator", "proofbound-evaluator", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-evaluator-cli", "proof-or-stop-evaluator-cli", "proofbound-evaluator-cli", "proofbound-evaluator-cli", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-implementation-reviewer", "proof-or-stop-implementation-reviewer", "proofbound-implementation-reviewer", "proofbound-implementation-reviewer", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-implementer", "proof-or-stop-implementer", "proofbound-implementer", "proofbound-implementer", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-product-reviewer", "proof-or-stop-product-reviewer", "proofbound-product-reviewer", "proofbound-product-reviewer", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-behavior", "proof-or-stop-review-behavior", "proofbound-review-behavior", "proofbound-review-behavior", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-channel", "proof-or-stop-review-channel", "proofbound-review-channel", "proofbound-review-channel", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-concept", "proof-or-stop-review-concept", "proofbound-review-concept", "proofbound-review-concept", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-delivery", "proof-or-stop-review-delivery", "proofbound-review-delivery", "proofbound-review-delivery", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-docs", "proof-or-stop-review-docs", "proofbound-review-docs", "proofbound-review-docs", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-quality", "proof-or-stop-review-quality", "proofbound-review-quality", "proofbound-review-quality", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-scope-plan", "proof-or-stop-review-scope-plan", "proofbound-review-scope-plan", "proofbound-review-scope-plan", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-story-init", "proof-or-stop-review-story-init", "proofbound-review-story-init", "proofbound-review-story-init", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-test-coverage", "proof-or-stop-review-test-coverage", "proofbound-review-test-coverage", "proofbound-review-test-coverage", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-topology-critic", "proof-or-stop-review-topology-critic", "proofbound-review-topology-critic", "proofbound-review-topology-critic", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-test-case-reviewer", "proof-or-stop-test-case-reviewer", "proofbound-test-case-reviewer", "proofbound-test-case-reviewer", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-test-intent", "proof-or-stop-test-intent", "proofbound-test-intent", "proofbound-test-intent", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-verification-intent", "proof-or-stop-verification-intent", "proofbound-verification-intent", "proofbound-verification-intent", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.agent-runtime.v1", "proof-or-stop.agent-runtime.v1", "proofbound.agent-runtime.v1", "proofbound.agent-runtime.v1", undefined, { canonical: 19, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.canonical-json.code-point-keys.v1", "proof-or-stop.canonical-json.code-point-keys.v1", "proofbound.canonical-json.code-point-keys.v1", "proofbound.canonical-json.code-point-keys.v1", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.lifecycle.init-to-done.v2", "proof-or-stop.lifecycle.init-to-done.v2", "proofbound.lifecycle.init-to-done.v2", "proofbound.lifecycle.init-to-done.v2", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.prompt-measurement-report.v1", "proof-or-stop.prompt-measurement-report.v1", "proofbound.prompt-measurement-report.v1", "proofbound.prompt-measurement-report.v1", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.prompt-role-contract-registry.v1", "proof-or-stop.prompt-role-contract-registry.v1", "proofbound.prompt-role-contract-registry.v1", "proofbound.prompt-role-contract-registry.v1", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.role-contract.v1", "proof-or-stop.role-contract.v1", "proofbound.role-contract.v1", "proofbound.role-contract.v1", undefined, { canonical: 18, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.signed-process-facts.v1", "proof-or-stop.signed-process-facts.v1", "proofbound.signed-process-facts.v1", "proofbound.signed-process-facts.v1", undefined, { canonical: 1, retired: 0 }),
      identitySite("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.story-owner-boundaries.v1", "proof-or-stop.story-owner-boundaries.v1", "proofbound.story-owner-boundaries.v1", "proofbound.story-owner-boundaries.v1", undefined, { canonical: 1, retired: 0 }),
      identitySite('packages/main/templates/agents/proof-or-stop-evaluator.md', 'proof-or-stop-evaluator'),
      identitySite('packages/main/templates/agents/proof-or-stop-implementer.md', 'proof-or-stop-implementer'),
      identitySite('packages/main/templates/agents/proof-or-stop-review-behavior.md', 'proof-or-stop-review-behavior'),
      identitySite('packages/main/templates/agents/proof-or-stop-review-concept.md', 'proof-or-stop-review-concept'),
      identitySite('packages/main/templates/agents/proof-or-stop-review-delivery.md', 'proof-or-stop-review-delivery'),
      identitySite('packages/main/templates/agents/proof-or-stop-review-docs.md', 'proof-or-stop-review-docs'),
      identitySite('packages/main/templates/agents/proof-or-stop-review-quality.md', 'proof-or-stop-review-quality'),
      identitySite('packages/main/templates/agents/proof-or-stop-review-scope-plan.md', 'proof-or-stop-review-scope-plan'),
      identitySite('packages/main/templates/agents/proof-or-stop-review-story-init.md', 'proof-or-stop-review-story-init'),
      identitySite('packages/main/templates/agents/proof-or-stop-review-test-coverage.md', 'proof-or-stop-review-test-coverage'),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/config.ts', 'proof-or-stop.prompt-envelope-rollout.v1'),
      identityMutationCase('packages/main/src/core/prompt-budget.ts', 'proof-or-stop.prompt-budget-observation.v1'),
      identityMutationCase("packages/main/src/core/prompt-budget.ts", "proof-or-stop-implementer"),
      identityMutationCase("packages/main/src/core/prompt-budget.ts", "proof-or-stop-review-delivery"),
      identityMutationCase("packages/main/src/core/prompt-budget.ts", "proof-or-stop-review-scope-plan"),
      identityMutationCase("packages/main/src/core/prompt-budget.ts", "proof-or-stop-review-story-init"),
      identityMutationCase('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.prompt-envelope.v1'),
      identityMutationCase("packages/main/src/core/prompt-contracts.ts", "proof-or-stop.canonical-json.code-point-keys.v1"),
      identityMutationCase('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.agent-runtime.v1'),
      identityMutationCase('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.role-contract.v1'),
      identityMutationCase('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.prompt-measurement.v1'),
      identityMutationCase('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.known-execution-environment.v1'),
      identityMutationCase('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.full-task-context.v1'),
      identityMutationCase('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.incremental-review-basis.v1'),
      identityMutationCase('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.full-context-assembler.v1'),
      identityMutationCase('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.prompt-dispatch.v1'),
      identityMutationCase('packages/main/src/core/prompt-contracts.ts', 'proof-or-stop.digest.v1'),
      identityMutationCase('packages/main/src/core/prompt-envelope.ts', 'proof-or-stop.prompt-envelope.v1'),
      identityMutationCase('packages/main/src/core/prompt-measurement.ts', 'proof-or-stop.prompt-measurement-report.v1'),
      identityMutationCase("packages/main/src/core/prompt-measurement.ts", "proof-or-stop.lifecycle.init-to-done.v2"),
      identityMutationCase("packages/main/src/core/prompt-measurement.ts", "proof-or-stop.signed-process-facts.v1"),
      identityMutationCase("packages/main/src/core/prompt-measurement.ts", "proof-or-stop.story-owner-boundaries.v1"),
      identityMutationCase('packages/main/src/core/prompt-registry.ts', 'proof-or-stop.prompt-registry.v1'),
      identityMutationCase("packages/main/src/core/prompt-registry.ts", "proof-or-stop-evaluator"),
      identityMutationCase("packages/main/src/core/prompt-registry.ts", "proof-or-stop-implementer"),
      identityMutationCase("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-behavior"),
      identityMutationCase("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-concept"),
      identityMutationCase("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-delivery"),
      identityMutationCase("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-docs"),
      identityMutationCase("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-quality"),
      identityMutationCase("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-scope-plan"),
      identityMutationCase("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-story-init"),
      identityMutationCase("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-test-coverage"),
      identityMutationCase("packages/main/src/core/prompt-registry.ts", "proof-or-stop-review-topology-critic"),
      identityMutationCase('packages/main/src/core/prompt-role-contract-registry.ts', 'proof-or-stop.prompt-role-contract-registry.v1'),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-evaluator"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-evaluator-cli"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-implementation-reviewer"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-implementer"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-product-reviewer"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-behavior"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-channel"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-concept"),
      identityMutationCase('packages/main/src/core/delivery-review-authority.ts', 'proof-or-stop-review-delivery'),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-delivery"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-docs"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-quality"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-scope-plan"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-story-init"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-test-coverage"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-review-topology-critic"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-test-case-reviewer"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-test-intent"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop-verification-intent"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop.prompt-envelope-rollout.v1"),
      identityMutationCase("packages/main/src/core/prompt-role-contract-registry.ts", "proof-or-stop.reviewer-host-render-identity.v1"),
      identityMutationCase('packages/main/src/core/review-run.ts', 'proof-or-stop.review_run_workspace_binding.v1'),
      identityMutationCase("packages/main/src/core/review-run.ts", "proof-or-stop-review-run-workspace-binding-v1"),
      identityMutationCase("packages/main/src/core/review-run.ts", "proof-or-stop-review-topology-critic"),
      identityMutationCase('packages/main/src/core/review-run.ts', 'proof-or-stop-review-run-integrity-v1'),
      identityMutationCase('packages/main/src/handlers/agent-prompt.ts', 'proof-or-stop.agent-prompt-response.v1'),
      identityMutationCase('packages/main/src/handlers/story-dispatch.ts', 'proof-or-stop-review-story-init'),
      identityMutationCase("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-implementer"),
      identityMutationCase("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-behavior"),
      identityMutationCase("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-channel"),
      identityMutationCase("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-concept"),
      identityMutationCase("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-docs"),
      identityMutationCase("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-quality"),
      identityMutationCase("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-scope-plan"),
      identityMutationCase("packages/main/src/handlers/story-dispatch.ts", "proof-or-stop-review-topology-critic"),
      identityMutationCase('packages/main/src/cli-init.ts', 'proof-or-stop.prompt-envelope-rollout.v1'),
      identityMutationCase('packages/main/src/cli-init.ts', 'proof-or-stop.js'),
      identityMutationCase('docs/requirements/baselines/role-prompt-measurement-baseline.json', 'proof-or-stop.prompt-measurement.v1'),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-evaluator"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-evaluator-cli"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-implementation-reviewer"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-implementer"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-product-reviewer"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-behavior"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-channel"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-concept"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-delivery"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-docs"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-quality"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-scope-plan"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-story-init"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-test-coverage"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-review-topology-critic"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-test-case-reviewer"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-test-intent"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop-verification-intent"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.agent-runtime.v1"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.canonical-json.code-point-keys.v1"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.lifecycle.init-to-done.v2"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.prompt-measurement-report.v1"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.prompt-role-contract-registry.v1"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.role-contract.v1"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.signed-process-facts.v1"),
      identityMutationCase("docs/requirements/baselines/role-prompt-measurement-baseline.json", "proof-or-stop.story-owner-boundaries.v1"),
      identityMutationCase('packages/main/templates/agents/proof-or-stop-evaluator.md', 'proof-or-stop-evaluator'),
      identityMutationCase('packages/main/templates/agents/proof-or-stop-implementer.md', 'proof-or-stop-implementer'),
      identityMutationCase('packages/main/templates/agents/proof-or-stop-review-behavior.md', 'proof-or-stop-review-behavior'),
      identityMutationCase('packages/main/templates/agents/proof-or-stop-review-concept.md', 'proof-or-stop-review-concept'),
      identityMutationCase('packages/main/templates/agents/proof-or-stop-review-delivery.md', 'proof-or-stop-review-delivery'),
      identityMutationCase('packages/main/templates/agents/proof-or-stop-review-docs.md', 'proof-or-stop-review-docs'),
      identityMutationCase('packages/main/templates/agents/proof-or-stop-review-quality.md', 'proof-or-stop-review-quality'),
      identityMutationCase('packages/main/templates/agents/proof-or-stop-review-scope-plan.md', 'proof-or-stop-review-scope-plan'),
      identityMutationCase('packages/main/templates/agents/proof-or-stop-review-story-init.md', 'proof-or-stop-review-story-init'),
      identityMutationCase('packages/main/templates/agents/proof-or-stop-review-test-coverage.md', 'proof-or-stop-review-test-coverage'),
    ]),
  }),
  identityBoundary({
    id: 'claim-admissibility-pack',
    commands: Object.freeze(['pinn_claim_check']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/claim-admissibility/pack-framework.ts'),
    ]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/claim-admissibility/pack-framework.ts', 'proof-or-stop.claim_admissibility_pack.v1'),
      { ...identitySite('packages/main/src/core/claim-admissibility/pack-framework.ts', 'proof-or-stop.proof_admissibility.v1', 'version: PROOF_ADMISSIBILITY_CONTRACT_VERSION', "version: 'lattice.proof_admissibility.v1'", 'lattice.proof_admissibility.v1', { commit: '69403365ae9a19422564babf93f6c10de869c81d', sourcePath: 'packages/main/src/core/proof-admissibility.ts', value: 'lattice.proof_admissibility.v1', use: 'producer-or-domain' }), identityOrigin: { sourcePath: 'packages/main/src/core/proof-admissibility.ts', exportName: 'PROOF_ADMISSIBILITY_CONTRACT_VERSION' } },
      { ...identitySite('packages/main/src/core/claim-admissibility/pack-framework.ts', 'proof-or-stop.proof_admissibility_verifier.v1', 'version: PROOF_ADMISSIBILITY_VERIFIER_VERSION', "version: 'lattice.proof_admissibility_verifier.v1'", 'lattice.proof_admissibility_verifier.v1', { commit: '69403365ae9a19422564babf93f6c10de869c81d', sourcePath: 'packages/main/src/core/proof-admissibility.ts', value: 'lattice.proof_admissibility_verifier.v1', use: 'producer-or-domain' }), identityOrigin: { sourcePath: 'packages/main/src/core/proof-admissibility.ts', exportName: 'PROOF_ADMISSIBILITY_VERIFIER_VERSION' } },
      { ...identitySite('packages/main/src/core/claim-admissibility/pack-framework.ts', 'proof-or-stop.quantum_claim_admissibility.v1', 'version: QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION', "version: 'lattice.quantum_claim_admissibility.v1'", 'lattice.quantum_claim_admissibility.v1', { commit: '69403365ae9a19422564babf93f6c10de869c81d', sourcePath: 'packages/main/src/core/claim-admissibility/quantum.ts', value: 'lattice.quantum_claim_admissibility.v1', use: 'producer-or-domain' }), identityOrigin: { sourcePath: 'packages/main/src/core/claim-admissibility/quantum.ts', exportName: 'QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION' } },
      { ...identitySite('packages/main/src/core/claim-admissibility/pack-framework.ts', 'proof-or-stop.quantum_claim_admissibility_verifier.v1', 'QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,\n', "'lattice.quantum_claim_admissibility_verifier.v1',\n", 'lattice.quantum_claim_admissibility_verifier.v1', { commit: '69403365ae9a19422564babf93f6c10de869c81d', sourcePath: 'packages/main/src/core/claim-admissibility/quantum.ts', value: 'lattice.quantum_claim_admissibility_verifier.v1', use: 'producer-or-domain' }), identityOrigin: { sourcePath: 'packages/main/src/core/claim-admissibility/quantum.ts', exportName: 'QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION' } },
      historicalIdentitySite("packages/main/src/core/claim-admissibility/pack-framework.ts", "proof-or-stop-code-runtime", "proofbound-code-runtime", "producer-or-domain", { canonical: 1, retired: 0 }),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/claim-admissibility/pack-framework.ts', 'proof-or-stop.claim_admissibility_pack.v1'),
      identityMutationCase('packages/main/src/core/claim-admissibility/pack-framework.ts', 'proof-or-stop.proof_admissibility.v1'),
      identityMutationCase('packages/main/src/core/claim-admissibility/pack-framework.ts', 'proof-or-stop.proof_admissibility_verifier.v1'),
      identityMutationCase('packages/main/src/core/claim-admissibility/pack-framework.ts', 'proof-or-stop.quantum_claim_admissibility.v1'),
      identityMutationCase('packages/main/src/core/claim-admissibility/pack-framework.ts', 'proof-or-stop.quantum_claim_admissibility_verifier.v1'),
      identityMutationCase("packages/main/src/core/claim-admissibility/pack-framework.ts", "proof-or-stop-code-runtime"),
    ]),
  }),
  identityBoundary({
    id: 'release-ledgers',
    commands: Object.freeze(['artifact_release_list', 'capability_release_list']),
    paths: Object.freeze([
      runtimeSource('packages/main/src/core/artifact-release.ts'),
      runtimeSource('packages/main/src/core/capability-release.ts'),
      runtimeSource('packages/main/src/handlers/done-effects.ts'),
      projectSource('scripts/identity-cutover/rules.mjs'),
      projectSource('scripts/identity-cutover/release-history.mjs'),
      projectSource('scripts/identity-cutover/provenance-data.mjs'),
      projectSource('scripts/identity-cutover/self-test.mjs'),
    ]),
    identitySites: Object.freeze([
      identitySite('packages/main/src/core/artifact-release.ts', 'proof-or-stop.artifact-release.v1'),
      identitySite('packages/main/src/core/capability-release.ts', 'proof-or-stop.product-capability-release.v1'),
      historicalIdentitySite("packages/main/src/core/capability-release.ts", "proof-or-stop.capability-release-backfill.v1", "proofbound.capability-release-backfill.v1", "producer-or-domain", { canonical: 1, retired: 0 }),
      identitySite(
        'packages/main/src/handlers/done-effects.ts',
        'proof-or-stop-identity-cutover.mjs',
        'verify-proof-or-stop-identity-cutover.mjs',
        `verify-${retiredIdentityNeedle('-identity-cutover.mjs')}`,
      ),
      historicalIdentitySite("packages/main/src/handlers/done-effects.ts", "proof-or-stop.playbook-promotion-health.v1", "proofbound.playbook-promotion-health.v1", "producer-or-domain", { canonical: 2, retired: 0 }),
      identitySite('scripts/identity-cutover/rules.mjs', 'proof-or-stop.artifact-release.v1'),
      { ...identitySite("scripts/identity-cutover/release-history.mjs", "proof-or-stop.artifact-release.v1", "schemaVersion === CANONICAL_ARTIFACT_RELEASE_SCHEMA", `schemaVersion === '${retiredIdentityNeedle('.artifact-release.v1')}'`, retiredIdentityNeedle('.artifact-release.v1'), undefined, { canonical: 2, retired: 0 }), identityOrigin: { sourcePath: 'scripts/identity-cutover/rules.mjs', exportName: "CANONICAL_ARTIFACT_RELEASE_SCHEMA", scope: 'project' } },
      { ...identitySite("scripts/identity-cutover/release-history.mjs", "proof-or-stop.product-capability-release.v1", "schemaVersion === CANONICAL_CAPABILITY_RELEASE_SCHEMA", "schemaVersion === 'proofbound.product-capability-release.v1'", "proofbound.product-capability-release.v1", { commit: '69403365ae9a19422564babf93f6c10de869c81d', sourcePath: 'scripts/verify-proof-or-stop-identity-cutover.mjs', value: "proofbound.product-capability-release.v1", use: 'reader-or-type-alternative' }, { canonical: 2, retired: 0 }), identityOrigin: { sourcePath: 'scripts/identity-cutover/rules.mjs', exportName: "CANONICAL_CAPABILITY_RELEASE_SCHEMA", scope: 'project' } },
      { ...identitySite("scripts/identity-cutover/provenance-data.mjs", "proof-or-stop.artifact-release.v1", "CANONICAL_ARTIFACT_RELEASE_SCHEMA]", `'${retiredIdentityNeedle('.artifact-release.v1')}']`, retiredIdentityNeedle('.artifact-release.v1'), undefined, { canonical: 1, retired: 0 }), identityOrigin: { sourcePath: 'scripts/identity-cutover/rules.mjs', exportName: "CANONICAL_ARTIFACT_RELEASE_SCHEMA", scope: 'project' } },
      { ...identitySite("scripts/identity-cutover/provenance-data.mjs", "proof-or-stop.product-capability-release.v1", "CANONICAL_CAPABILITY_RELEASE_SCHEMA]", "'proofbound.product-capability-release.v1']", "proofbound.product-capability-release.v1", { commit: '69403365ae9a19422564babf93f6c10de869c81d', sourcePath: 'scripts/verify-proof-or-stop-identity-cutover.mjs', value: "proofbound.product-capability-release.v1", use: 'reader-or-type-alternative' }, { canonical: 1, retired: 0 }), identityOrigin: { sourcePath: 'scripts/identity-cutover/rules.mjs', exportName: "CANONICAL_CAPABILITY_RELEASE_SCHEMA", scope: 'project' } },
      { ...identitySite("scripts/identity-cutover/self-test.mjs", "proof-or-stop.artifact-release.v1", "=== CANONICAL_ARTIFACT_RELEASE_SCHEMA", `=== '${retiredIdentityNeedle('.artifact-release.v1')}'`, retiredIdentityNeedle('.artifact-release.v1'), undefined, { canonical: 2, retired: 0 }), identityOrigin: { sourcePath: 'scripts/identity-cutover/rules.mjs', exportName: "CANONICAL_ARTIFACT_RELEASE_SCHEMA", scope: 'project' } },
      { ...identitySite("scripts/identity-cutover/self-test.mjs", "proof-or-stop.product-capability-release.v1", "=== CANONICAL_CAPABILITY_RELEASE_SCHEMA", "=== 'proofbound.product-capability-release.v1'", "proofbound.product-capability-release.v1", { commit: '69403365ae9a19422564babf93f6c10de869c81d', sourcePath: 'scripts/verify-proof-or-stop-identity-cutover.mjs', value: "proofbound.product-capability-release.v1", use: 'reader-or-type-alternative' }, { canonical: 1, retired: 0 }), identityOrigin: { sourcePath: 'scripts/identity-cutover/rules.mjs', exportName: "CANONICAL_CAPABILITY_RELEASE_SCHEMA", scope: 'project' } },
      identitySite("scripts/identity-cutover/rules.mjs", "proof-or-stop.product-capability-release.v1", "proof-or-stop.product-capability-release.v1", "proofbound.product-capability-release.v1", "proofbound.product-capability-release.v1", { commit: "69403365ae9a19422564babf93f6c10de869c81d", sourcePath: "scripts/verify-proof-or-stop-identity-cutover.mjs", value: "proofbound.product-capability-release.v1", use: "reader-or-type-alternative" }, { canonical: 1, retired: 0 }),
    ]),
    mutationCases: Object.freeze([
      identityMutationCase('packages/main/src/core/artifact-release.ts', 'proof-or-stop.artifact-release.v1', 'artifact_release_list'),
      identityMutationCase('packages/main/src/core/capability-release.ts', 'proof-or-stop.product-capability-release.v1', 'capability_release_list'),
      identityMutationCase("packages/main/src/core/capability-release.ts", "proof-or-stop.capability-release-backfill.v1", "capability_release_list"),
      identityMutationCase('packages/main/src/handlers/done-effects.ts', 'proof-or-stop-identity-cutover.mjs', 'artifact_release_list'),
      identityMutationCase("packages/main/src/handlers/done-effects.ts", "proof-or-stop.playbook-promotion-health.v1", "artifact_release_list"),
      identityMutationCase('scripts/identity-cutover/rules.mjs', 'proof-or-stop.artifact-release.v1', 'artifact_release_list'),
      identityMutationCase("scripts/identity-cutover/release-history.mjs", "proof-or-stop.artifact-release.v1", 'artifact_release_list'),
      identityMutationCase("scripts/identity-cutover/release-history.mjs", "proof-or-stop.product-capability-release.v1", 'artifact_release_list'),
      identityMutationCase("scripts/identity-cutover/provenance-data.mjs", "proof-or-stop.artifact-release.v1", 'artifact_release_list'),
      identityMutationCase("scripts/identity-cutover/provenance-data.mjs", "proof-or-stop.product-capability-release.v1", 'artifact_release_list'),
      identityMutationCase("scripts/identity-cutover/self-test.mjs", "proof-or-stop.artifact-release.v1", 'artifact_release_list'),
      identityMutationCase("scripts/identity-cutover/self-test.mjs", "proof-or-stop.product-capability-release.v1", 'artifact_release_list'),
      identityMutationCase("scripts/identity-cutover/rules.mjs", "proof-or-stop.product-capability-release.v1", "artifact_release_list"),
    ]),
  }),
] satisfies readonly ActiveIdentityOperationBoundary[]);

const RETIRED_ACTIVE_PROTOCOL_PREFIX = ['proof', 'bound.'].join('');
const RETIRED_ACTIVE_ROLE_PREFIX = ['proof', 'bound-'].join('');

function assertNoRetiredPromptConfigIdentity(projectRoot: string, label: string): void {
  const configPath = resolve(projectRoot, 'proof-or-stop.config.json');
  if (!existsSync(configPath) || !statSync(configPath).isFile()) return;
  const configBytes = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(configBytes);
  } catch {
    return; // loadConfig owns malformed JSON and duplicate-key diagnostics.
  }
  const envelope = parsed && typeof parsed === 'object'
    ? (parsed as { promptEnvelope?: unknown }).promptEnvelope
    : undefined;
  if (!envelope || typeof envelope !== 'object') return;
  const version = (envelope as { version?: unknown }).version;
  const roles = (envelope as { roles?: unknown }).roles;
  const identities = [
    ...(typeof version === 'string' ? [version] : []),
    ...(roles && typeof roles === 'object' ? Object.keys(roles) : []),
  ];
  const offendingIdentity = identities.find(identity =>
    identity.startsWith(RETIRED_ACTIVE_PROTOCOL_PREFIX) || identity.startsWith(RETIRED_ACTIVE_ROLE_PREFIX));
  if (!offendingIdentity) return;
  throw new Error(
    `retired active protocol identity ${JSON.stringify(offendingIdentity)} at proof-or-stop.config.json is not admitted by ${label}; ` +
    `restore the canonical proof-or-stop.* runtime before retrying`,
  );
}

// This exact source fragment is mutation-input data, not an active schema
// reader. Its byte/count witness grants no exemption to surrounding code.
const IDENTITY_MUTATION_DATA_FRAGMENTS = [
  { marker: 'const OWNED_IDENTITY_MUTATION_CONTEXT_ROWS = [', sha256: '28f99961af3041b336f572261734d75e889b56e86de9e06b3e809ea77f7c54a6' },
  { marker: 'const BOTH_FAMILY_CONTEXT_ROWS = [', sha256: '0871916e7ded35a2029c795bb9b6bd800a7847a11e7d2ae7edeedfe4794158ed' },
] as const;
function activeIdentitySourceBytes(sourcePath: string, bytes: string): string {
  if (sourcePath !== 'scripts/identity-cutover/reviewed-contexts.mjs') return bytes;
  let activeBytes = bytes;
  for (const pin of IDENTITY_MUTATION_DATA_FRAGMENTS) {
    const start = activeBytes.indexOf(pin.marker);
    const end = activeBytes.indexOf('\n].map(', start) + 2;
    if (start < 0 || end <= start || activeBytes.split(pin.marker).length !== 2) {
      throw new Error('identity verifier mutation-data fragment missing or duplicated');
    }
    const fragment = activeBytes.slice(start, end);
    if (createHash('sha256').update(fragment).digest('hex') !== pin.sha256) {
      throw new Error('identity verifier mutation-data fragment integrity mismatch');
    }
    activeBytes = activeBytes.slice(0, start) + activeBytes.slice(end);
  }
  return activeBytes;
}

const IDENTITY_VERIFIER_PROJECT_SOURCE_PATHS = Object.freeze([
  "scripts/verify-proof-or-stop-identity-cutover.mjs",
  "scripts/identity-cutover/active-scan.mjs",
  "scripts/identity-cutover/base-contexts.mjs",
  "scripts/identity-cutover/bootstrap.mjs",
  "scripts/identity-cutover/certification.mjs",
  "scripts/identity-cutover/cli.mjs",
  "scripts/identity-cutover/deny-contexts.mjs",
  "scripts/identity-cutover/guidance.mjs",
  "scripts/identity-cutover/history-contexts.mjs",
  "scripts/identity-cutover/integration-contexts.mjs",
  "scripts/identity-cutover/memory-provenance.mjs",
  "scripts/identity-cutover/negative-contexts.mjs",
  "scripts/identity-cutover/ordering.mjs",
  "scripts/identity-cutover/provenance-data.mjs",
  "scripts/identity-cutover/public-api.mjs",
  "scripts/identity-cutover/release-history.mjs",
  "scripts/identity-cutover/repository.mjs",
  "scripts/identity-cutover/reviewed-contexts.mjs",
  "scripts/identity-cutover/rules.mjs",
  "scripts/identity-cutover/runtime-contexts.mjs",
  "scripts/identity-cutover/scanner-contexts.mjs",
  "scripts/identity-cutover/schema-data.mjs",
  "scripts/identity-cutover/schema-scan.mjs",
  "scripts/identity-cutover/self-test.mjs",
  "scripts/identity-cutover/source-integrity.mjs",
  "scripts/identity-cutover/witness-controls.mjs"
]);

// The former one-file prefix guard covers the complete modular source set.
// External projects without this repository verifier retain the optional boundary.
function assertIdentityVerifierProjectSources(projectRoot: string, label: string): void {
  const entry = resolve(projectRoot, IDENTITY_VERIFIER_PROJECT_SOURCE_PATHS[0]);
  if (!existsSync(entry) && !IDENTITY_VERIFIER_PROJECT_SOURCE_PATHS.slice(1).some(path => existsSync(resolve(projectRoot, path)))) return;
  for (const sourcePath of IDENTITY_VERIFIER_PROJECT_SOURCE_PATHS) {
    const absolute = resolve(projectRoot, sourcePath);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`${label}/${sourcePath}: identity verifier module is missing`);
    }
    const bytes = activeIdentitySourceBytes(sourcePath, readFileSync(absolute, 'utf8'));
    if (bytes.includes(RETIRED_ACTIVE_PROTOCOL_PREFIX)) {
      throw new Error(`${label}/${sourcePath}: retired active protocol identity is not admitted`);
    }
  }
}

export function assertCanonicalActiveIdentityRuntime(input: {
  command: string;
  projectRoot: string;
  runtimePackageRoot?: string;
}): void {
  const runtimePackageRoot = resolve(input.runtimePackageRoot ?? currentCorePackageRoot());
  const projectRoot = resolve(input.projectRoot);
  if (['agent_prompt', 'dispatch', 'prompt_measurement_report'].includes(input.command)) {
    assertNoRetiredPromptConfigIdentity(projectRoot, input.command);
  }
  for (const boundary of ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
    if (!boundary.commands.includes(input.command)) continue;
    if (boundary.id === 'release-ledgers') assertIdentityVerifierProjectSources(projectRoot, input.command);
    for (const registeredPath of boundary.paths) {
      const base = registeredPath.scope === 'runtime-package' ? runtimePackageRoot : projectRoot;
      const absolute = resolve(base, registeredPath.path);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
      const bytes = activeIdentitySourceBytes(registeredPath.sourcePath, readFileSync(absolute, 'utf8'));
      if (!bytes.includes(RETIRED_ACTIVE_PROTOCOL_PREFIX)) continue;
      throw new Error(
        `retired active protocol identity at ${registeredPath.sourcePath} is not admitted by ` +
        `${input.command}; restore the canonical proof-or-stop.* runtime before retrying`,
      );
    }
  }
}

/**
 * The boundary's public consumer calls this after command dispatch. Unlike the
 * CLI-wide preflight, this verifies the exact canonical value registered for
 * every identity site owned by that consumer. Tests deliberately ablate the
 * CLI preflight, so a retired mutation can only be rejected here or by the
 * consumer's own parser/verifier.
 */
// These reviewed executable modules own the declarations AND their producers/
// consumers. A local syntactic decoy cannot authorize a different live dataflow.
// Intentional implementation changes require explicit review and re-pinning;
// the runtime never computes a new expected digest from the candidate itself.




// Memoize only the pure parse/print/hash projection of exact source bytes.
// Callers still reread files and compare the current expected binding on every
// observation. Neither filesystem metadata nor a prior PASS authorizes reuse.
const identityCanonicalDigests = new Map<string, { text: string; digest: string }>();
const IDENTITY_CANONICAL_MAX_ENTRIES = 32;
const IDENTITY_CANONICAL_MAX_CHARACTERS = 4 * 1024 * 1024;
let identityCanonicalCharacters = 0;
function canonicalIdentityExecutableDigest(sourcePath: string, text: string): string {
  const prior = identityCanonicalDigests.get(sourcePath);
  if (prior?.text === text) {
    identityCanonicalDigests.delete(sourcePath);
    identityCanonicalDigests.set(sourcePath, prior);
    return prior.digest;
  }
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const canonical = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printFile(source);
  const digest = createHash('sha256').update(canonical).digest('hex');
  if (prior) {
    identityCanonicalDigests.delete(sourcePath);
    identityCanonicalCharacters -= prior.text.length;
  }
  if (text.length <= IDENTITY_CANONICAL_MAX_CHARACTERS) {
    while (identityCanonicalDigests.size >= IDENTITY_CANONICAL_MAX_ENTRIES
      || identityCanonicalCharacters + text.length > IDENTITY_CANONICAL_MAX_CHARACTERS) {
      const key = identityCanonicalDigests.keys().next().value!;
      identityCanonicalCharacters -= identityCanonicalDigests.get(key)!.text.length;
      identityCanonicalDigests.delete(key);
    }
    identityCanonicalDigests.set(sourcePath, { text, digest });
    identityCanonicalCharacters += text.length;
  }
  return digest;
}

function assertIdentityExecutableSource(sourcePath: string, text: string, label: string): void {
  const expected = ACTIVE_IDENTITY_EXECUTABLE_SOURCE_BINDINGS[sourcePath];
  if (!expected) return;
  const actual = canonicalIdentityExecutableDigest(sourcePath, text);
  if (actual !== expected) throw new Error(`${label}/${sourcePath} consumer rejected active identity bytes; executable declaration/producer/consumer binding changed`);
}

function assertIdentitySiteValueBinding(site: ActiveIdentityOperationIdentitySite, text: string, label: string): void {
  const binding = site.valueBinding;
  if (!binding) return;
  const source = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const values: Array<ts.Expression | undefined> = [];
  if (binding.kind === 'export-const') {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== binding.name) continue;
        const isExportedConst = Boolean(statement.declarationList.flags & ts.NodeFlags.Const)
          && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        values.push(isExportedConst ? declaration.initializer : undefined);
      }
    }
  } else {
    const functions = source.statements.filter((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === binding.functionName);
    if (functions.length === 1 && functions[0].body) {
      const visit = (node: ts.Node): void => {
        if (binding.kind === 'property' && ts.isPropertyAssignment(node)
          && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === binding.name) {
          values.push(node.initializer);
        }
        if (binding.kind === 'comparison' && ts.isBinaryExpression(node)
          && node.left.getText(source).replace(/\s/g, '') === binding.expression) {
          values.push(node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? node.right : undefined);
        }
        ts.forEachChild(node, visit);
      };
      visit(functions[0].body);
    }
  }
  // Comments, unrelated literals, computed expressions and duplicate selectors
  // cannot satisfy the live declaration/producer/comparison contract.
  if (values.length !== 1 || !values[0] || !ts.isStringLiteral(values[0]) || values[0].text !== site.canonical) {
    const observed = values.map(value => value ? value.getText(source).slice(0, 256) : '<unsupported declaration>').join(', ') || '<missing binding>';
    throw new Error(`${label}/${site.siteId} consumer rejected active identity value; expected exact ${site.canonical}; observed ${observed}`);
  }
}

export function assertCanonicalActiveIdentityBoundary(input: {
  boundaryId: string;
  projectRoot?: string;
  runtimePackageRoot?: string;
}): void {
  const boundaryId = input.boundaryId === 'artifact-release-ledger' || input.boundaryId === 'capability-release-ledger'
    ? 'release-ledgers'
    : input.boundaryId;
  const boundary = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.find((candidate) => candidate.id === boundaryId);
  if (!boundary) throw new Error(`unregistered active identity operation boundary: ${input.boundaryId}`);
  const runtimePackageRoot = resolve(input.runtimePackageRoot ?? currentCorePackageRoot());
  const projectRoot = resolve(input.projectRoot ?? process.cwd());
  if (boundaryId === 'prompt-runtime') assertNoRetiredPromptConfigIdentity(projectRoot, boundaryId);
  if (boundaryId === 'release-ledgers') assertIdentityVerifierProjectSources(projectRoot, boundaryId);
  const sourceSnapshots = new Map<string, string>();
  const executableSources = new Map<string, string>();
  for (const site of boundary.identitySites) {
    const registeredPath = boundary.paths.find((candidate) => candidate.sourcePath === site.sourcePath);
    if (!registeredPath) throw new Error(`${boundary.id}/${site.siteId}: identity-site owner is not registered`);
    const base = registeredPath.scope === 'runtime-package' ? runtimePackageRoot : projectRoot;
    const absolute = resolve(base, registeredPath.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      if (registeredPath.scope === 'project') continue;
      throw new Error(`${boundary.id}/${site.siteId}: registered runtime identity-site bytes are missing`);
    }
    let sourceBytes = sourceSnapshots.get(absolute);
    if (sourceBytes === undefined) {
      sourceBytes = readFileSync(absolute, 'utf8');
      executableSources.set(registeredPath.sourcePath, sourceBytes);
      sourceSnapshots.set(absolute, sourceBytes);
    }
    const bytes = activeIdentitySourceBytes(registeredPath.sourcePath, sourceBytes);
    assertIdentitySiteValueBinding(site, sourceBytes, boundary.id);
    if (site.identityOrigin) {
      // Only explicitly bound imported authorities are inspected; this
      // is not recursive dependency discovery or generic legacy admission.
      const originPath = site.identityOrigin.scope === 'project'
        ? resolve(projectRoot, site.identityOrigin.sourcePath)
        : resolve(runtimePackageRoot, runtimeSource(site.identityOrigin.sourcePath).path);
      if (!existsSync(originPath) || !statSync(originPath).isFile()) {
        throw new Error(`${boundary.id}/${site.siteId}: imported identity origin is missing`);
      }
      const originBytes = readFileSync(originPath, 'utf8');
      const escapedName = site.identityOrigin.exportName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const declarations = [...originBytes.matchAll(new RegExp(`(?:^|\\n)export const ${escapedName}\\s*=\\s*([^;\\n]+);`, 'gu'))];
      if (declarations.length !== 1 || ![`'${site.canonical}'`, `"${site.canonical}"`].includes(declarations[0][1].trim())) {
        throw new Error(`${boundary.id}/${site.siteId} consumer rejected imported identity origin; expected exact canonical ${site.canonical}; observed ${declarations.map(declaration => declaration[1]).join(', ') || 'missing declaration'}`);
      }
    }
    const counts = site.sourceOccurrences;
    const countNeedle = (needle: string): number => {
      if (site.sourceNeedle !== site.canonical) return bytes.split(needle).length - 1;
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      return [...bytes.matchAll(new RegExp(`(?<![a-zA-Z0-9._-])${escaped}(?![a-zA-Z0-9._-])`, 'gu'))].length;
    };
    const exactOccurrenceDrift = counts && (
      countNeedle(site.sourceNeedle) !== counts.canonical
      || countNeedle(site.retiredNeedle) !== counts.retired
    );
    if (exactOccurrenceDrift || countNeedle(site.sourceNeedle) === 0 || (!counts && countNeedle(site.retiredNeedle) > 0)) {
      throw new Error(
        `${boundary.id}/${site.siteId} consumer rejected active identity bytes; ` +
        `expected exact ${site.canonical} and no ${site.retired}`,
      );
    }
  }
  // Explicitly registered executable-only delegates need no invented identity token.
  for (const registeredPath of boundary.paths) {
    if (!ACTIVE_IDENTITY_EXECUTABLE_SOURCE_BINDINGS[registeredPath.sourcePath] || executableSources.has(registeredPath.sourcePath)) continue;
    const base = registeredPath.scope === 'runtime-package' ? runtimePackageRoot : projectRoot;
    const absolute = resolve(base, registeredPath.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`${boundary.id}/${registeredPath.sourcePath} consumer rejected: registered executable bytes are missing`);
    }
    executableSources.set(registeredPath.sourcePath, readFileSync(absolute, 'utf8'));
  }
  // Exact value checks remain independently operative; the final syntax guard
  // then catches live rewiring and decoys that keep those values unchanged.
  for (const [sourcePath, sourceBytes] of executableSources) {
    assertIdentityExecutableSource(sourcePath, sourceBytes, boundary.id);
  }
}

/**
 * Run every exact business-consumer boundary owned by a command. This remains
 * separate from the cheap retired-prefix runtime preflight: mutating commands
 * need their exact consumer refusal before hooks, owner leases, or activity
 * writers can observe the request.
 */
/** Argument-mode delegates run earlier than the ordinary consumer preflight. */
export function assertCanonicalActiveIdentityArgumentDelegates(input: {
  command: string;
  projectRoot: string;
}): void {
  const boundary = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.find(row => row.id === 'maintenance-command-mode');
  if (!boundary) throw new Error('unregistered active identity operation boundary: maintenance-command-mode');
  if (boundary.commands.includes(input.command)) {
    assertCanonicalActiveIdentityBoundary({ boundaryId: boundary.id, projectRoot: input.projectRoot });
  }
}

export function assertCanonicalActiveIdentityCommandConsumers(input: {
  command: string;
  projectRoot: string;
  runtimePackageRoot?: string;
}): void {
  for (const boundary of ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
    if (!boundary.preSideEffect || !boundary.commands.includes(input.command)) continue;
    assertCanonicalActiveIdentityBoundary({
      boundaryId: boundary.id,
      projectRoot: input.projectRoot,
      ...(input.runtimePackageRoot ? { runtimePackageRoot: input.runtimePackageRoot } : {}),
    });
  }
}
// B-e256 cross-host review B-e256-xhr-r11 MAJOR: presence is THREE-valued.
// `existsSync` follows symlinks, so a global `npm link` whose target checkout
// was deleted (exactly the failure this story targets) reads as `absent` and
// the global-core-realpath row silently passes with installed=false. A link
// entry that is present but does not resolve is its own state.
// B-e256 cross-host review B-e256-xhr-r12 MAJOR: presence is FOUR-valued. The
// probe itself can fail (EACCES on the scope directory, EPERM, EIO, ...); that
// observes NOTHING about whether a package is installed, so collapsing it into
// `absent` turned an unverifiable - possibly broken - global installation into a
// green "not installed" informational pass. Only ENOENT/ENOTDIR mean the path
// genuinely holds no package.
type CorePackagePresence = 'resolved' | 'dangling' | 'unreadable' | 'absent';

interface CorePackageCandidate {
  path: string;
  packageName: typeof CANONICAL_CORE_PACKAGE_NAME | typeof DEPRECATED_CORE_PACKAGE_NAME;
  presence: CorePackagePresence;
  // errno of the failed probe when `presence === 'unreadable'`; null otherwise.
  errorCode: string | null;
}

export function runRuntimeEnvironmentChecks(
  projectRoot: string,
  options: RuntimeEnvironmentOptions = {},
): RuntimeEnvironmentReport {
  const resolvedRoot = resolve(projectRoot);
  const corePackageRoot = options.corePackageRoot ? resolve(options.corePackageRoot) : currentCorePackageRoot();
  const cliEntrypoint = (options.commandResolver ?? resolveCliCommandPath)(resolvedRoot);
  // B-e256 cross-host review B-e256-xhr-r13 MAJOR: `globalNpmRootProbeResolver`
  // (structured) takes priority. A plain legacy `globalNpmRootResolver` cannot
  // express a probe failure, but its `null` also is not a genuine success: the
  // real `npm root -g` probe never resolves to nothing on success (it always
  // names SOME directory, even one with nothing installed under it - real
  // absence is `probeCorePackagePresence` finding ENOENT/ENOTDIR under a
  // known-good root, not the root itself missing), so a legacy resolver
  // returning `null` is wrapped as an (unspecified-reason) failure rather than
  // silently treated as "genuinely absent".
  const globalNpmRootProbe: GlobalNpmRootProbeResult = options.globalNpmRootProbeResolver
    ? options.globalNpmRootProbeResolver(resolvedRoot)
    : options.globalNpmRootResolver
      ? wrapLegacyGlobalNpmRootResolver(options.globalNpmRootResolver(resolvedRoot))
      : probeGlobalNpmRoot(resolvedRoot);
  const globalNpmRoot = globalNpmRootProbe.root;
  const isSelfProject = detectSelfProject(resolvedRoot);
  const platform = options.platform ?? process.platform;
  const context: RuntimeCheckContext = {
    projectRoot: resolvedRoot,
    isSelfProject,
    runtimeScope: isSelfProject ? 'self' : 'external',
    corePackageRoot,
    canonicalSelfCoreRoot: isSelfProject ? resolveCanonicalSelfCoreRoot(resolvedRoot) : null,
    cliEntrypoint,
    activeCliEntrypoint: resolveActiveCliEntrypoint(resolvedRoot, corePackageRoot, cliEntrypoint),
    globalNpmRoot,
    globalNpmRootProbe,
    executableAccessProbe: options.executableAccessProbe ?? defaultExecutableAccessProbe,
    platform,
    binTargetStatProbe: options.binTargetStatProbe ?? statSync,
    binTargetRealpathProbe: options.binTargetRealpathProbe ?? defaultGlobalCoreRealpathProbe,
    commandShimReadProbe: options.commandShimReadProbe ?? ((path) => readFileSync(path, 'utf8')),
    windowsCommandRuntimeProbe: options.windowsCommandRuntimeProbe ?? defaultWindowsCommandRuntimeProbe,
    globalCoreRealpathProbe: options.globalCoreRealpathProbe ?? defaultGlobalCoreRealpathProbe,
    compiledCoreVersionProbe: options.compiledCoreVersionProbe ?? defaultCompiledCoreVersionProbe,
  };

  const results = RUNTIME_FACT_REGISTRY.map((entry) => runRegistryCheck(entry, context));
  const summary = summarize(results);
  const keyed = Object.fromEntries(results.map((result) => [result.outputKey, result])) as Record<RuntimeFactOutputKey, RuntimeFactCheckResult>;

  return {
    isSelfProject,
    scope: context.runtimeScope,
    runtimeMode: classifyRuntimeMode(context),
    summary,
    ...keyed,
  };
}

export function renderRuntimeFootprintSummary(runtimeMode: RuntimeModeContract, nextAction?: string): string {
  return [
    'Runtime footprint:',
    `Runtime mode: ${runtimeMode.mode}`,
    `Runtime source: ${runtimeMode.source}`,
    `Project-local JavaScript runtime required: ${runtimeMode.requiresProjectJavaScriptRuntime ? 'yes' : 'no'}`,
    `Authority: ${runtimeMode.authority}`,
    `Next action: ${nextAction ?? runtimeMode.message}`,
  ].join('\n');
}

export function renderRuntimeEnvironmentReport(report: RuntimeEnvironmentReport): string {
  const lines: string[] = [];
  lines.push('Runtime scan:');
  lines.push(`  scope: ${report.scope}`);
  lines.push(`  runtimeMode: ${report.runtimeMode.mode} (${report.runtimeMode.source})`);
  lines.push(`  status: ${report.summary.status} (${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail)`);
  for (const entry of RUNTIME_FACT_REGISTRY) {
    const result = report[entry.outputKey];
    const detail = compactFactDetail(result);
    lines.push(`  ${statusIcon(result.status)} ${entry.id} [${result.severity}] ${detail}`);
    const actual = result.actual && typeof result.actual === 'object'
      ? result.actual as Record<string, unknown>
      : null;
    if (
      entry.id === 'global-core-realpath'
      && result.status === 'pass'
      && actual?.installed === true
      && typeof actual.realpath === 'string'
      && typeof actual.version === 'string'
      && typeof actual.binMode === 'string'
      && actual.executable === true
      && actual.verification === 'ok'
    ) {
      lines.push('    contract: global-core-realpath-pass');
    }
    if (result.warnings && result.warnings.length > 0) {
      for (const warning of result.warnings.slice(0, 4)) {
        lines.push(`    - ${warning}`);
      }
      if (result.warnings.length > 4) {
        lines.push(`    - ... and ${result.warnings.length - 4} more`);
      }
    }
    if (result.status !== 'pass' && result.repairHint) {
      lines.push(`    repair: ${result.repairHint}`);
    }
  }
  lines.push('  note: runtime facts describe environment drift; process gates remain in process-fact-registry.');
  return lines.join('\n');
}

function runRegistryCheck(entry: RuntimeFactRegistryEntry, context: RuntimeCheckContext): RuntimeFactCheckResult {
  const severity = context.isSelfProject ? entry.selfSeverity : entry.externalSeverity;
  const base = {
    id: entry.id,
    outputKey: entry.outputKey,
    severity,
    scope: entry.scope,
    rationale: entry.rationale,
    driftMessage: entry.driftMessage,
    ...(entry.repairHint ? { repairHint: entry.repairHint } : {}),
  };

  switch (entry.checker) {
    case 'resolveEntrypointAuthority':
      return { ...base, ...checkEntrypointAuthority(context, severity) };
    case 'resolveCliEntrypoint':
      return { ...base, ...checkCliEntrypoint(context, severity) };
    case 'resolveGlobalCoreRealpath':
      return { ...base, ...checkGlobalCoreRealpath(context, severity) };
    case 'resolveProjectLocalBin':
      return { ...base, ...checkProjectLocalBin(context, severity) };
    case 'resolveNodeVersion':
      return { ...base, ...checkNodeVersion(severity) };
    case 'resolvePackageVersion':
      return { ...base, ...checkPackageVersion(context, severity) };
    case 'resolveValidateSource':
      return { ...base, ...checkValidateSource(context, severity) };
    case 'scanExternalReferencePolicy':
      return { ...base, ...checkExternalReferencePolicy(context, severity) };
  }
}

function checkEntrypointAuthority(
  context: RuntimeCheckContext,
  severity: RuntimeFactSeverity,
): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const runtimeEntrypointAuthority = classifyRuntimeEntrypointAuthority({
    command: process.argv[2] ?? 'doctor',
    commandArgs: process.argv.slice(3),
    projectRoot: context.projectRoot,
    invokedEntrypoint: context.activeCliEntrypoint,
    loadedCorePackageRoot: context.corePackageRoot,
    env: process.env,
  });
  const status = runtimeEntrypointAuthority.status === 'blocked' ? statusForDrift(severity) : 'pass';
  return {
    status,
    actual: runtimeEntrypointAuthority,
    expected: context.isSelfProject
      ? 'active CLI runtime belongs to the current worktree'
      : 'external consumer runtime remains advisory',
    ...(status === 'pass' ? {} : { warnings: [runtimeEntrypointAuthority.detail] }),
  };
}

/**
 * Classify the runtime before CLI dispatch. Identity comes from canonical
 * filesystem paths and git metadata, never argv[0], PATH order, or repository
 * basenames. External consumers are deliberately outside this self-host gate.
 */
export function classifyRuntimeEntrypointAuthority(
  input: RuntimeEntrypointAuthorityInput,
): RuntimeEntrypointAuthorityDecision {
  const projectRoot = safeRealpath(resolve(input.projectRoot)) ?? resolve(input.projectRoot);
  const invokedEntrypoint = input.invokedEntrypoint
    ? safeRealpath(resolve(input.invokedEntrypoint)) ?? resolve(input.invokedEntrypoint)
    : null;
  const loadedCorePackageRoot = input.loadedCorePackageRoot
    ? safeRealpath(resolve(input.loadedCorePackageRoot)) ?? resolve(input.loadedCorePackageRoot)
    : currentCorePackageRoot();
  const base = {
    projectRoot,
    invokedEntrypoint,
  };

  if (!detectSelfProject(projectRoot)) {
    const decision: RuntimeEntrypointAuthorityDecision = {
      status: 'pass',
      selfHostWorktree: false,
      ...base,
      worktreeRoot: null,
      mainRoot: null,
      gitCommonDir: null,
      runtimeRoot: null,
      detail: 'External consumer repository: self-host runtime authority is advisory.',
    };
    // The external-consumer runtimeRoot is advisory report data that no
    // admission decision reads; resolve it (one or two git subprocesses) only
    // when a caller actually reads it. Enumerable, so JSON/spread/deepEqual see
    // the same value an eager probe produced.
    let runtimeRoot: string | null | undefined;
    Object.defineProperty(decision, 'runtimeRoot', {
      enumerable: true,
      configurable: true,
      get: () => {
        if (runtimeRoot === undefined) {
          runtimeRoot = gitTopLevel(loadedCorePackageRoot)
            ?? (invokedEntrypoint ? gitTopLevel(dirname(invokedEntrypoint)) : null);
        }
        return runtimeRoot;
      },
      set: (value: string | null) => { runtimeRoot = value; },
    });
    return decision;
  }

  const identityProbe = { deadline: performance.now() + 16_000, timedOut: false, env: input.env ?? process.env };
  const { worktreeRoot, gitCommonDir } = gitTopLevelAndCommonDir(projectRoot, identityProbe);
  const mainRoot = worktreeRoot ? findMainWorktreeRoot(worktreeRoot, identityProbe) : null;
  const selfHostWorktree = !!worktreeRoot
    && !!gitCommonDir
    && !!mainRoot
    && !samePath(worktreeRoot, mainRoot);
  // The loaded module root is authoritative. A launcher can live outside git
  // (or spoof argv/PATH) while importing main-checkout dist; process.argv[1]
  // alone cannot identify that runtime. Entrypoint git identity is only the
  // fallback for packaged/compatibility launchers without a package root.
  const loadedCoreGitRoot = gitTopLevel(loadedCorePackageRoot, identityProbe);
  const loadedCoreRelation = worktreeRoot ? relative(worktreeRoot, loadedCorePackageRoot) : null;
  const loadedCoreInsideWorktree = loadedCoreRelation !== null
    && loadedCoreRelation !== '..' && !loadedCoreRelation.startsWith(`..${sep}`) && !isAbsolute(loadedCoreRelation);
  const runtimeRoot = loadedCoreGitRoot ?? (loadedCoreInsideWorktree ? worktreeRoot : null)
    ?? (invokedEntrypoint ? gitTopLevel(dirname(invokedEntrypoint), identityProbe) : null);
  const requiresAuthoritativeRuntime = input.requiresAuthoritativeRuntime !== false;

  if ((!worktreeRoot || !gitCommonDir || !mainRoot) && input.requiresAuthoritativeRuntime !== false) {
    const recoveryRoot = worktreeRoot ?? projectRoot;
    return {
      status: 'blocked',
      reasonCode: identityProbe.timedOut ? 'runtime_authority_probe_timeout_in_worktree' : 'runtime_authority_unresolved_in_worktree',
      selfHostWorktree: false,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      recoveryCommand: renderLocalEntrypointRecoveryCommand(recoveryRoot, input.command, input.commandArgs),
      detail: identityProbe.timedOut
        ? 'Self-host runtime authority git identity probe exceeded its bounded retry budget.'
        : 'Self-host runtime authority could not resolve a complete git worktree/common-dir/main-worktree identity.',
    };
  }

  const runtimeMatchesProjectWorktree = !!runtimeRoot && !!worktreeRoot && samePath(runtimeRoot, worktreeRoot);
  if (!selfHostWorktree && runtimeMatchesProjectWorktree) {
    return {
      status: 'pass',
      selfHostWorktree: false,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      detail: 'Not a linked self-host story worktree; no worktree runtime mismatch applies.',
    };
  }

  // B-49df: main-checkout commands were the missing half of the authority
  // boundary. A globally linked CLI could load a sibling story worktree while
  // targeting main, then run every registered Story writer. Treat any
  // self-project runtime root other than the target checkout as foreign when
  // the caller is admitting a write. Read-only diagnostics deliberately pass,
  // and external package consumers returned before this self-host branch.
  if (!selfHostWorktree && !runtimeMatchesProjectWorktree) {
    if (!requiresAuthoritativeRuntime) {
      return {
        status: 'pass',
        selfHostWorktree: false,
        ...base,
        worktreeRoot,
        mainRoot,
        gitCommonDir,
        runtimeRoot,
        recoveryCommand: worktreeRoot
          ? renderLocalEntrypointRecoveryCommand(worktreeRoot, input.command, input.commandArgs)
          : undefined,
        detail: 'Read-only command allowed with a foreign self-project runtime; Story writers remain fail-closed.',
      };
    }
    return {
      status: 'blocked',
      reasonCode: 'foreign_self_project_runtime_for_story_write',
      selfHostWorktree: false,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      recoveryCommand: renderLocalEntrypointRecoveryCommand(worktreeRoot ?? projectRoot, input.command, input.commandArgs),
      detail: runtimeRoot
        ? `Loaded runtime belongs to a different self-project checkout (${runtimeRoot}), not the target checkout (${worktreeRoot ?? projectRoot}).`
        : 'Could not bind the active runtime to the target self-project checkout.',
    };
  }

  const recoveryCommand = renderLocalEntrypointRecoveryCommand(worktreeRoot!, input.command, input.commandArgs);
  // B-cdf6:F-020 — read BOTH brand spellings, same as line ~1129 does for this exact
  // semantic check. A raw `input.env?.PROOF_OR_STOP_CODEX_ENTRYPOINT` access here would miss the
  // canonical PROOF_OR_STOP_CODEX_ENTRYPOINT spelling, which is equally valid under the
  // additive compat contract. Since classifyRuntimeEntrypointAuthority runs on EVERY command
  // in a self-host worktree (cli-engine.ts passes env: process.env), missing it would
  // misclassify a legitimate global-fallback session_brief heartbeat as a runtime-authority
  // violation. Same bug class as F-016 (idleProofOrStop), which is why this was swept for.
  const isExplicitSessionBriefFallback = input.command === 'session_brief'
    && readBrandEnv('CODEX_ENTRYPOINT', input.env) === 'global-fallback';
  if (isExplicitSessionBriefFallback) {
    return {
      status: 'exempt',
      selfHostWorktree: true,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      recoveryCommand,
      detail: 'Explicit global-fallback session_brief heartbeat is exempt; it is not current-worktree gate evidence.',
    };
  }

  const runtimeIsLocal = runtimeMatchesProjectWorktree;
  if (runtimeIsLocal) {
    return {
      status: 'pass',
      selfHostWorktree: true,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      detail: 'Runtime authority check: PASS — active CLI resolves inside the current story worktree.',
    };
  }

  const runtimeIsMain = !!runtimeRoot && !!mainRoot && samePath(runtimeRoot, mainRoot);
  if (runtimeIsMain && requiresAuthoritativeRuntime) {
    return {
      status: 'blocked',
      reasonCode: STALE_GLOBAL_RUNTIME_REASON_CODE,
      selfHostWorktree: true,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      recoveryCommand,
      detail: `Loaded runtime belongs to the main checkout (${runtimeRoot}), not the active worktree (${worktreeRoot}).`,
    };
  }

  if (requiresAuthoritativeRuntime) {
    return {
      status: 'blocked',
      reasonCode: 'runtime_authority_unresolved_in_worktree',
      selfHostWorktree: true,
      ...base,
      worktreeRoot,
      mainRoot,
      gitCommonDir,
      runtimeRoot,
      recoveryCommand,
      detail: invokedEntrypoint
        ? `Could not bind the active runtime (${invokedEntrypoint}) to the current worktree git identity.`
        : 'Could not resolve the active CLI entrypoint for this self-host worktree.',
    };
  }

  return {
    status: 'pass',
    selfHostWorktree: true,
    ...base,
    worktreeRoot,
    mainRoot,
    gitCommonDir,
    runtimeRoot,
    recoveryCommand,
    detail: 'Read-only command allowed with unresolved runtime identity; mutating commands remain fail-closed.',
  };
}

export function renderRuntimeEntrypointAuthorityFailure(decision: RuntimeEntrypointAuthorityDecision): string {
  if (decision.status !== 'blocked' || !decision.reasonCode) return decision.detail;
  return [
    `Blocked [${decision.reasonCode}] before dispatch.`,
    decision.detail,
    decision.recoveryCommand ? `Retry: ${decision.recoveryCommand}` : '',
  ].filter(Boolean).join('\n');
}

export function renderLocalEntrypointRecoveryCommand(
  worktreeRoot: string,
  command: string,
  args: readonly string[],
): string {
  const tokens = [command, ...args].map(shellQuote);
  // B-cc10 CHK-006: was `bin/proofOrStop.js`. A recovery command must name a wrapper that
  // still exists, or the operator's retry fails for a second, unrelated reason.
  return `cd -- ${shellQuote(worktreeRoot)} && node bin/proof-or-stop.js ${tokens.join(' ')}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

type IdentityProbeBudget = { deadline: number; timedOut: boolean; env: NodeJS.ProcessEnv | Record<string, string | undefined> };

function gitTopLevel(cwd: string, budget?: IdentityProbeBudget): string | null {
  const top = budget
    ? runAuthoritativeIdentityCommand(['rev-parse', '--path-format=absolute', '--show-toplevel'], cwd, budget)
    : runCommand('git', ['rev-parse', '--path-format=absolute', '--show-toplevel'], cwd);
  return top ? safeRealpath(top) ?? resolve(top) : null;
}

/**
 * `--show-toplevel` and `--git-common-dir` in ONE rev-parse. When the combined
 * call fails (e.g. a bare repository has a common dir but no top level) the two
 * are probed separately, so each value is exactly what its own probe returns.
 */
function gitTopLevelAndCommonDir(cwd: string, budget: IdentityProbeBudget): { worktreeRoot: string | null; gitCommonDir: string | null } {
  const both = runAuthoritativeIdentityCommand(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], cwd, budget);
  const lines = both?.split(/\r?\n/);
  if (lines && lines.length === 2 && lines[0] && lines[1]) {
    return {
      worktreeRoot: safeRealpath(lines[0]) ?? resolve(lines[0]),
      gitCommonDir: safeRealpath(lines[1]) ?? resolve(lines[1]),
    };
  }
  return { worktreeRoot: gitTopLevel(cwd, budget), gitCommonDir: absoluteGitCommonDir(cwd, budget) };
}

function absoluteGitCommonDir(cwd: string, budget?: IdentityProbeBudget): string | null {
  const common = budget
    ? runAuthoritativeIdentityCommand(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, budget)
    : runCommand('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return common ? safeRealpath(common) ?? resolve(common) : null;
}

function findMainWorktreeRoot(cwd: string, budget?: IdentityProbeBudget): string | null {
  const raw = budget
    ? runAuthoritativeIdentityCommand(['worktree', 'list', '--porcelain'], cwd, budget)
    : runCommand('git', ['worktree', 'list', '--porcelain'], cwd);
  if (!raw) return null;
  for (const record of raw.split(/\n\s*\n/)) {
    const lines = record.split(/\r?\n/);
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length).trim();
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length).trim();
    if (path && branch === 'refs/heads/main') return safeRealpath(path) ?? resolve(path);
  }
  return null;
}

function checkCliEntrypoint(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'details' | 'warnings'> {
  const commandPath = context.cliEntrypoint;
  const expectedCore = context.isSelfProject ? context.canonicalSelfCoreRoot : null;
  const expectedCli = expectedCore ? join(expectedCore, 'dist', 'cli.js') : null;
  if (!commandPath) {
    return {
      status: statusForDrift(severity),
      actual: null,
      expected: context.isSelfProject ? expectedCli ?? 'canonical main CLI (git worktree discovery failed)' : 'proof-or-stop executable on PATH',
      warnings: ['PATH lookup for `proof-or-stop` did not resolve a CLI executable'],
    };
  }
  const commandRealpath = safeRealpath(commandPath);
  const matchesExpected = context.isSelfProject
    ? !!expectedCli && !!commandRealpath && samePath(commandRealpath, expectedCli)
    : true;
  const status = matchesExpected ? 'pass' : statusForDrift(severity);
  return {
    status,
    actual: {
      path: commandPath,
      realpath: commandRealpath,
    },
    expected: expectedCli ?? (context.isSelfProject ? 'canonical main CLI (git worktree discovery failed)' : null),
    ...(status === 'pass' ? {} : { warnings: [expectedCli
      ? `CLI entrypoint resolves to ${commandRealpath ?? commandPath}, expected ${expectedCli}`
      : `CLI entrypoint resolves to ${commandRealpath ?? commandPath}, but the canonical main worktree could not be discovered`] }),
  };
}

// B-e256 CHK-003: the global-core-realpath row must surface enough facts to
// repoint a drifted `proof-or-stop` executable without guessing, and it must
// only REPORT — doctor never mutates the host's global install.
//   (1) realpath inside a `.worktrees/` checkout (or any non-canonical path)
//       -> drift + an exact host-shell repoint (`cd --` on POSIX, encoded
//       PowerShell `Set-Location -LiteralPath` on Windows)
//   (2) package.json bin target not executable -> `chmod +x <abs path>` ONLY when
//       the execute bits are actually clear; a target that IS marked executable
//       yet fails X_OK is an ownership/ACL/noexec denial that chmod cannot
//       repair, so it gets the rebuild-and-relink action (B-e256-xhr-r11 MAJOR).
//       Windows uses npm-generated command shims and never prescribes chmod.
//   (3) no global install -> informational (pass) row naming how to link one
//   (3b) the global package entry EXISTS but is a broken link (its checkout was
//       removed) -> drift naming the broken target + the relink; never a pass
//       with installed=false (B-e256-xhr-r11 MAJOR)
//   (4) canonical realpath + executable bin -> pass with realpath/version/mode
//   (5) installed but unverifiable (package.json unreadable / no `bin` /
//       no proof-or-stop bin entry) -> drift naming the exact reason + path;
//       never a pass with executable=unverified (B-e256-xhr-r6 MAJOR)
//   (3c) the presence probe itself FAILED with something other than
//       ENOENT/ENOTDIR (EACCES / EPERM / EIO ...) -> drift naming the errno;
//       never "not installed", because nothing was observed (B-e256-xhr-r12)
//   (3d) a RESOLVED candidate whose realpath cannot be resolved -> drift naming
//       the errno; never "not installed" either (B-e256-xhr-r12 MAJOR)
//   (6) a missing or non-canonical version on a readable package.json -> drift
//       with rebuild-and-relink; the version is a verified fact, not a
//       display-only decoration (B-e256-xhr-r12 MAJOR)
type GlobalCoreExecutableVerification =
  | 'ok'
  | 'package-json-unreadable'
  | 'bin-field-missing'
  | 'bin-entry-missing'
  | 'bin-target-stat-failed'
  | 'bin-target-realpath-failed'
  | 'bin-target-realpath-escape'
  | 'command-entrypoint-missing'
  | 'command-entrypoint-realpath-failed'
  | 'command-entrypoint-target-mismatch'
  | 'windows-command-shim-missing'
  | 'windows-command-shim-unreadable'
  | 'windows-command-shim-target-mismatch'
  | 'windows-command-runtime-probe-failed';

interface GlobalCoreExecutableFacts {
  binTarget: string | null;
  binTargetRealpath: string | null;
  binMode: string | null;
  binTargetExists: boolean | null;
  verificationErrorCode: string | null;
  commandShim: string | null;
  commandEntrypointRealpath?: string | null;
  // B-e256-xhr-r11 MAJOR: whether ANY 0o111 bit is set on the target. This is
  // NOT the executable verdict (that is the X_OK probe); it is what decides
  // whether `chmod +x` is a plausible repair at all.
  executeBitsSet: boolean;
  // null = unverifiable; `verification` names why, and checkGlobalCoreRealpath
  // treats every non-'ok' reason on an INSTALLED package as drift.
  executable: boolean | null;
  verification: GlobalCoreExecutableVerification;
}

function describeGlobalCoreVerification(verification: Exclude<GlobalCoreExecutableVerification, 'ok'>): string {
  if (verification === 'package-json-unreadable') return 'package.json is missing or malformed';
  if (verification === 'bin-field-missing') return 'package.json declares no `bin` field';
  if (verification === 'bin-target-stat-failed') return 'the declared bin target could not be inspected';
  if (verification === 'bin-target-realpath-failed') return 'the declared bin target realpath could not be resolved';
  if (verification === 'bin-target-realpath-escape') return 'the declared bin target resolves outside the package dist tree';
  if (verification === 'command-entrypoint-missing') return 'no proof-or-stop command was found on PATH';
  if (verification === 'command-entrypoint-realpath-failed') return 'the proof-or-stop command selected from PATH could not be resolved';
  if (verification === 'command-entrypoint-target-mismatch') return 'the proof-or-stop command selected from PATH does not resolve to this package bin target';
  if (verification === 'windows-command-shim-missing') return 'the proof-or-stop command selected from PATH is missing';
  if (verification === 'windows-command-shim-unreadable') return 'the proof-or-stop command shim selected from PATH could not be read';
  if (verification === 'windows-command-shim-target-mismatch') return 'the proof-or-stop command shim does not invoke this package bin target';
  if (verification === 'windows-command-runtime-probe-failed') return 'the validated proof-or-stop command did not successfully report the expected compiled version';
  return `package.json \`bin\` has no ${CANONICAL_ROOT_PACKAGE_NAME} entry`;
}

// B-e256-xhr-r6 MAJOR: the executable fact is whether the CURRENT process may
// execute the target (access(2) X_OK), not whether any 0o111 bit is set. A
// root-owned 0100 file is "executable" by mode yet fails with EACCES for an
// unprivileged operator. Windows does not call this probe; it verifies the npm
// command shim that is actually selected from PATH.
function defaultExecutableAccessProbe(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface OfficialNpmWindowsShimSet {
  base: string;
  cmd: string;
  ps1: string;
  sh: string;
}

// npm's cmd-shim@8 writer emits one launcher contract through three shell
// surfaces. Certifying arbitrary batch/PowerShell text from a home-grown lexer
// is unsound: reachability, variable binding, caret escaping, quote
// concatenation, redirection, argv forwarding and exit propagation are all
// language semantics. Instead, doctor supports the bounded, deterministic
// cmd-shim@8 shape used by npm for this package's `#!/usr/bin/env node` bin and
// validates every peer byte-for-byte. Any other generator/template is reported
// as unverifiable until it has its own explicit contract.
function officialNpmWindowsShimSet(commandBase: string, installedPackageRoot: string, binRel: string): OfficialNpmWindowsShimSet | null {
  const lexicalTarget = resolve(installedPackageRoot, binRel);
  const relativeTarget = relative(dirname(commandBase), lexicalTarget);
  if (!relativeTarget || isAbsolute(relativeTarget)) return null;
  const shTarget = relativeTarget.replace(/\\/g, '/');
  const cmdTarget = shTarget.replace(/\//g, '\\');
  const cmd = '@ECHO off\r\n'
    + 'GOTO start\r\n'
    + ':find_dp0\r\n'
    + 'SET dp0=%~dp0\r\n'
    + 'EXIT /b\r\n'
    + ':start\r\n'
    + 'SETLOCAL\r\n'
    + 'CALL :find_dp0\r\n'
    + '\r\n'
    + 'IF EXIST "%dp0%\\node.exe" (\r\n'
    + '  SET "_prog=%dp0%\\node.exe"\r\n'
    + ') ELSE (\r\n'
    + '  SET "_prog=node"\r\n'
    + '  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n'
    + ')\r\n'
    + '\r\n'
    + `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${cmdTarget}" %*\r\n`;
  const sh = '#!/bin/sh\n'
    + 'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n'
    + '\n'
    + 'case `uname` in\n'
    + '    *CYGWIN*|*MINGW*|*MSYS*)\n'
    + '        if command -v cygpath > /dev/null 2>&1; then\n'
    + '            basedir=`cygpath -w "$basedir"`\n'
    + '        fi\n'
    + '    ;;\n'
    + 'esac\n'
    + '\n'
    + 'if [ -x "$basedir/node" ]; then\n'
    + `  exec "$basedir/node"  "$basedir/${shTarget}" "$@"\n`
    + 'else \n'
    + `  exec node  "$basedir/${shTarget}" "$@"\n`
    + 'fi\n';
  const ps1 = '#!/usr/bin/env pwsh\n'
    + '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n'
    + '\n'
    + '$exe=""\n'
    + 'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n'
    + '  # Fix case when both the Windows and Linux builds of Node\n'
    + '  # are installed in the same directory\n'
    + '  $exe=".exe"\n'
    + '}\n'
    + '$ret=0\n'
    + 'if (Test-Path "$basedir/node$exe") {\n'
    + '  # Support pipeline input\n'
    + '  if ($MyInvocation.ExpectingInput) {\n'
    + `    $input | & "$basedir/node$exe"  "$basedir/${shTarget}" $args\n`
    + '  } else {\n'
    + `    & "$basedir/node$exe"  "$basedir/${shTarget}" $args\n`
    + '  }\n'
    + '  $ret=$LASTEXITCODE\n'
    + '} else {\n'
    + '  # Support pipeline input\n'
    + '  if ($MyInvocation.ExpectingInput) {\n'
    + `    $input | & "node$exe"  "$basedir/${shTarget}" $args\n`
    + '  } else {\n'
    + `    & "node$exe"  "$basedir/${shTarget}" $args\n`
    + '  }\n'
    + '  $ret=$LASTEXITCODE\n'
    + '}\n'
    + 'exit $ret\n';
  return { base: commandBase, cmd, ps1, sh };
}

function windowsCommandBase(cliEntrypoint: string): string | null {
  const name = basename(cliEntrypoint).toLowerCase();
  if (name === CANONICAL_ROOT_PACKAGE_NAME) return cliEntrypoint;
  if (name === `${CANONICAL_ROOT_PACKAGE_NAME}.cmd`) return cliEntrypoint.slice(0, -4);
  if (name === `${CANONICAL_ROOT_PACKAGE_NAME}.ps1`) return cliEntrypoint.slice(0, -4);
  return null;
}

function defaultWindowsCommandRuntimeProbe(commandPath: string, expectedVersion: string): WindowsCommandRuntimeProbeResult {
  if (process.platform !== 'win32') {
    return { exitCode: null, stdout: '', stderr: '', errorCode: 'ENOTSUP', failureReason: 'cmd.exe runtime semantics are unavailable on this host' };
  }
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `${basename(commandPath)} --version`], {
    cwd: dirname(commandPath),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    env: process.env,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const errorCode = result.error ? errnoCode(result.error) : null;
  const expected = `Proof-or-Stop ${expectedVersion}`;
  const ok = !result.error && result.status === 0 && stdout.trim() === expected;
  return {
    exitCode: result.status,
    stdout,
    stderr,
    errorCode,
    failureReason: ok ? null : result.error?.message ?? `expected exit 0 and stdout ${JSON.stringify(expected)}, got exit ${String(result.status)} and stdout ${JSON.stringify(stdout.trim())}`,
  };
}

function validateWindowsCommandShim(
  cliEntrypoint: string | null,
  installedPackageRoot: string,
  binRel: string,
  expectedVersion: string,
  commandShimReadProbe: (path: string) => string,
  windowsCommandRuntimeProbe: (commandPath: string, expectedVersion: string) => WindowsCommandRuntimeProbeResult,
): { commandShim: string | null; executable: boolean; verification: GlobalCoreExecutableVerification; errorCode: string | null } {
  if (!cliEntrypoint) {
    return { commandShim: null, executable: false, verification: 'windows-command-shim-missing', errorCode: 'ENOENT' };
  }
  const base = windowsCommandBase(cliEntrypoint);
  const expected = base ? officialNpmWindowsShimSet(base, installedPackageRoot, binRel) : null;
  if (!base || !expected) {
    return { commandShim: cliEntrypoint, executable: false, verification: 'windows-command-shim-target-mismatch', errorCode: null };
  }
  const peers = [
    { path: base, expected: expected.sh },
    { path: `${base}.cmd`, expected: expected.cmd },
    { path: `${base}.ps1`, expected: expected.ps1 },
  ];
  for (const peer of peers) {
    let content: string;
    try {
      content = commandShimReadProbe(peer.path);
    } catch (error) {
      const errorCode = errnoCode(error);
      return {
        commandShim: cliEntrypoint,
        executable: false,
        verification: errorCode === 'ENOENT' || errorCode === 'ENOTDIR' ? 'windows-command-shim-missing' : 'windows-command-shim-unreadable',
        errorCode,
      };
    }
    if (content !== peer.expected) {
      return { commandShim: cliEntrypoint, executable: false, verification: 'windows-command-shim-target-mismatch', errorCode: null };
    }
  }
  const runtimeProbe = windowsCommandRuntimeProbe(`${base}.cmd`, expectedVersion);
  const runtimeProbePassed = runtimeProbe.failureReason === null
    && runtimeProbe.errorCode === null
    && runtimeProbe.exitCode === 0
    && runtimeProbe.stdout.trim() === `Proof-or-Stop ${expectedVersion}`;
  if (!runtimeProbePassed) {
    return {
      commandShim: cliEntrypoint,
      executable: false,
      verification: 'windows-command-runtime-probe-failed',
      errorCode: runtimeProbe.errorCode,
    };
  }
  return { commandShim: cliEntrypoint, executable: true, verification: 'ok', errorCode: null };
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function windowsPowerShellCommand(script: string): string {
  // cmd.exe expands %NAME% even inside double quotes. An encoded UTF-16LE
  // PowerShell payload contains only base64 characters, while the decoded
  // script uses -LiteralPath/single-quoted arguments. This keeps spaces,
  // apostrophes and literal percent-delimited path components byte-exact.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function globalCoreRelinkCommand(canonicalCoreRoot: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? windowsPowerShellCommand(`Set-Location -LiteralPath ${powershellLiteral(canonicalCoreRoot)}; & npm.cmd link`)
    : `cd -- ${shellQuote(canonicalCoreRoot)} && npm link`;
}

function globalCoreRebuildCommand(packageRoot: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? windowsPowerShellCommand(`& npm.cmd --prefix ${powershellLiteral(packageRoot)} run build`)
    : `npm --prefix ${shellQuote(packageRoot)} run build`;
}

function globalCoreInspectCommand(path: string, platform: NodeJS.Platform, endOfOptions: boolean): string {
  if (platform === 'win32') {
    return windowsPowerShellCommand(`Get-Item -Force -LiteralPath ${powershellLiteral(path)} | Format-List -Property FullName,Attributes,LinkType,Target`);
  }
  return `ls -ld${endOfOptions ? ' --' : ''} ${shellQuote(path)}`;
}

function pathSegments(path: string): string[] {
  return resolve(path).split(/[\\/]+/).filter(Boolean);
}

function isWorktreeCheckoutPath(path: string): boolean {
  return pathSegments(path).includes('.worktrees');
}

function formatFileMode(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function inspectGlobalCoreExecutable(
  packageRoot: string,
  installedPackageRoot: string,
  cliEntrypoint: string | null,
  platform: NodeJS.Platform,
  executableAccessProbe: (path: string) => boolean,
  binTargetStatProbe: (path: string) => { mode: number; isFile(): boolean },
  binTargetRealpathProbe: (path: string) => GlobalCoreRealpathProbeResult,
  commandShimReadProbe: (path: string) => string,
  windowsCommandRuntimeProbe: (commandPath: string, expectedVersion: string) => WindowsCommandRuntimeProbeResult,
): GlobalCoreExecutableFacts {
  const unverifiable = (verification: Exclude<GlobalCoreExecutableVerification, 'ok'>): GlobalCoreExecutableFacts =>
    ({ binTarget: null, binTargetRealpath: null, binMode: null, binTargetExists: false, verificationErrorCode: null, commandShim: null, executeBitsSet: false, executable: null, verification });
  const pkg = readPackageJson(packageRoot);
  if (!pkg || typeof pkg !== 'object') return unverifiable('package-json-unreadable');
  const bin = pkg.bin;
  if (bin === undefined || bin === null) return unverifiable('bin-field-missing');
  const binRel = typeof bin === 'string'
    ? bin
    : typeof bin === 'object' && typeof bin[CANONICAL_ROOT_PACKAGE_NAME] === 'string'
      ? bin[CANONICAL_ROOT_PACKAGE_NAME]
      : null;
  if (!binRel) return unverifiable('bin-entry-missing');
  const binTarget = resolve(packageRoot, binRel);
  let stat;
  try {
    stat = binTargetStatProbe(binTarget);
  } catch (error) {
    const errorCode = errnoCode(error);
    if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') {
      return { binTarget, binTargetRealpath: null, binMode: null, binTargetExists: false, verificationErrorCode: null, commandShim: null, executeBitsSet: false, executable: false, verification: 'ok' };
    }
    return { binTarget, binTargetRealpath: null, binMode: null, binTargetExists: null, verificationErrorCode: errorCode, commandShim: null, executeBitsSet: false, executable: null, verification: 'bin-target-stat-failed' };
  }
  const executeBitsSet = (stat.mode & 0o111) !== 0;
  if (!stat.isFile()) return { binTarget, binTargetRealpath: null, binMode: formatFileMode(stat.mode), binTargetExists: false, verificationErrorCode: null, commandShim: null, executeBitsSet, executable: false, verification: 'ok' };
  const targetRealpathProbe = binTargetRealpathProbe(binTarget);
  if (!targetRealpathProbe.realpath) {
    return { binTarget, binTargetRealpath: null, binMode: formatFileMode(stat.mode), binTargetExists: true, verificationErrorCode: targetRealpathProbe.errorCode ?? 'UNKNOWN', commandShim: null, executeBitsSet, executable: null, verification: 'bin-target-realpath-failed' };
  }
  const binTargetRealpath = targetRealpathProbe.realpath;
  if (!pathContains(join(packageRoot, 'dist'), binTargetRealpath)) {
    return { binTarget, binTargetRealpath, binMode: formatFileMode(stat.mode), binTargetExists: true, verificationErrorCode: null, commandShim: null, executeBitsSet, executable: false, verification: 'bin-target-realpath-escape' };
  }
  if (platform === 'win32') {
    const shim = validateWindowsCommandShim(
      cliEntrypoint,
      installedPackageRoot,
      binRel,
      readExpectedCoreVersion(packageRoot),
      commandShimReadProbe,
      windowsCommandRuntimeProbe,
    );
    return { binTarget, binTargetRealpath, binMode: formatFileMode(stat.mode), binTargetExists: true, verificationErrorCode: shim.errorCode, commandShim: shim.commandShim, executeBitsSet, executable: shim.executable, verification: shim.verification };
  }
  const commandRealpathProbe = defaultGlobalCoreRealpathProbe(cliEntrypoint!);
  if (!commandRealpathProbe.realpath) {
    return { binTarget, binTargetRealpath, binMode: formatFileMode(stat.mode), binTargetExists: true, verificationErrorCode: commandRealpathProbe.errorCode, commandShim: null, commandEntrypointRealpath: null, executeBitsSet, executable: null, verification: 'command-entrypoint-realpath-failed' };
  }
  const commandEntrypointRealpath = commandRealpathProbe.realpath;
  if (!samePath(commandEntrypointRealpath, binTargetRealpath)) {
    return { binTarget, binTargetRealpath, binMode: formatFileMode(stat.mode), binTargetExists: true, verificationErrorCode: null, commandShim: null, commandEntrypointRealpath, executeBitsSet, executable: false, verification: 'command-entrypoint-target-mismatch' };
  }
  // `binMode` is display-only; the POSIX executable verdict is access(2) X_OK,
  // after the PATH command has resolved to this exact declared target.
  const executable = executableAccessProbe(binTarget);
  return { binTarget, binTargetRealpath, binMode: formatFileMode(stat.mode), binTargetExists: true, verificationErrorCode: null, commandShim: null, commandEntrypointRealpath, executeBitsSet, executable, verification: 'ok' };
}

function checkGlobalCoreRealpath(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'details' | 'warnings'> {
  const globalRoot = context.globalNpmRoot;
  const globalPackage = globalRoot ? resolveCorePackageCandidate(globalRoot) : null;
  const globalPackagePath = globalPackage?.path ?? null;
  const realpathProbe: GlobalCoreRealpathProbeResult = globalPackage && globalPackage.presence === 'resolved'
    ? context.globalCoreRealpathProbe(globalPackage.path)
    : { realpath: null, errorCode: null };
  const globalRealpath = realpathProbe.realpath;
  const expected = context.isSelfProject ? context.canonicalSelfCoreRoot : resolveCanonicalCoreRoot(context.corePackageRoot);
  const expectedVersion = readExpectedCoreVersion(expected ?? context.corePackageRoot);
  const canonicalDiscoveryFailed = expected === null;
  const diagnoseCanonical = 'git worktree list --porcelain';
  const relink = expected ? globalCoreRelinkCommand(expected, context.platform) : diagnoseCanonical;
  if (globalRoot === null && context.globalNpmRootProbe.failureReason) {
    // (3a) B-e256 cross-host review B-e256-xhr-r13 MAJOR: the `npm root -g`
    // PROBE failed (npm missing, non-zero exit, timeout, unparsable output).
    // Nothing was observed about the global installation, so it must never be
    // reported as the informational "not installed" pass below - that collapse
    // is exactly the false-pass this finding names. Only a probe that actually
    // SUCCEEDED and named no package there is genuinely "not installed".
    const diagnose = 'npm root -g';
    return {
      status: statusForDrift(severity),
      actual: {
        installed: null,
        presence: 'npm-root-probe-failed',
        npmRoot: null,
        packageName: CANONICAL_CORE_PACKAGE_NAME,
        packagePath: null,
        linkTarget: null,
        realpath: null,
        version: null,
        expectedVersion,
        errorCode: null,
        compiledVersion: null,
        binTarget: null,
        binMode: null,
        executable: null,
        verification: null,
        worktreeCheckout: false,
        remediation: diagnose,
      },
      expected,
      warnings: [
        `the \`npm root -g\` probe failed: ${context.globalNpmRootProbe.failureReason}; the global ${CANONICAL_CORE_PACKAGE_NAME} installation could not be inspected - it is not known to be absent`,
        `diagnose: ${diagnose}`,
      ],
    };
  }
  if (globalPackage && globalPackagePath && globalPackage.presence === 'dangling') {
    // (3b) The scoped package entry is still there, so the global install is
    // NOT absent: it is broken and every `proof-or-stop` invocation through it
    // fails. Reporting this as "not installed" would hide the exact failure
    // this story targets (a linked worktree that was removed).
    const linkTarget = safeReadlinkTarget(globalPackagePath);
    const brokenTarget = linkTarget ?? '<unreadable link target>';
    const warnings = [
      `global ${describeCorePackageCandidate(globalPackage)} at ${globalPackagePath} is a broken link -> ${brokenTarget}; the linked checkout no longer exists, so the global installation cannot resolve`,
    ];
    if (linkTarget && isWorktreeCheckoutPath(linkTarget)) {
      warnings.push(`the broken link points inside a \`.worktrees/\` checkout; that worktree was removed or rebuilt`);
    }
    warnings.push(`repoint: ${relink}`);
    return {
      status: statusForDrift(severity),
      actual: {
        installed: true,
        presence: 'dangling',
        npmRoot: globalRoot,
        packageName: globalPackage.packageName,
        packagePath: globalPackagePath,
        linkTarget,
        realpath: null,
        version: null,
        expectedVersion,
        errorCode: null,
        binTarget: null,
        binMode: null,
        executable: null,
        verification: null,
        worktreeCheckout: linkTarget ? isWorktreeCheckoutPath(linkTarget) : false,
        remediation: relink,
      },
      expected,
      warnings,
    };
  }
  if (globalPackage && globalPackagePath && globalPackage.presence === 'unreadable') {
    // (3c) B-e256-xhr-r12 MAJOR: the presence PROBE failed (EACCES / EPERM /
    // EIO / ...). Nothing was observed, so nothing may be claimed: rendering
    // this as "not installed" turns an unverifiable - possibly broken - global
    // installation into a green informational pass. `installed` is null
    // (unknown), never false.
    const code = globalPackage.errorCode ?? 'UNKNOWN';
    return {
      status: statusForDrift(severity),
      actual: {
        installed: null,
        presence: 'unreadable',
        errorCode: code,
        npmRoot: globalRoot,
        packageName: globalPackage.packageName,
        packagePath: globalPackagePath,
        linkTarget: null,
        realpath: null,
        version: null,
        expectedVersion,
        binTarget: null,
        binMode: null,
        executable: null,
        verification: null,
        worktreeCheckout: false,
        remediation: relink,
      },
      expected,
      warnings: [
        `global ${describeCorePackageCandidate(globalPackage)} at ${globalPackagePath} could not be probed [${code}]: the filesystem refused the lookup, so this installation is UNVERIFIABLE - it is not known to be absent`,
        `inspect then repoint: ${globalCoreInspectCommand(globalPackagePath, context.platform, false)} && ${relink}`,
      ],
    };
  }
  if (globalPackage && globalPackagePath && globalPackage.presence === 'resolved' && !globalRealpath) {
    // (3d) B-e256-xhr-r12 MAJOR: the candidate WAS classified as an installed
    // package, then realpath resolution failed. Falling through to (3) reported
    // that broken install as "not installed" and passed.
    const code = realpathProbe.errorCode ?? 'UNKNOWN';
    return {
      status: statusForDrift(severity),
      actual: {
        installed: true,
        presence: 'resolved',
        errorCode: code,
        npmRoot: globalRoot,
        packageName: globalPackage.packageName,
        packagePath: globalPackagePath,
        linkTarget: null,
        realpath: null,
        version: null,
        expectedVersion,
        binTarget: null,
        binMode: null,
        executable: null,
        verification: null,
        worktreeCheckout: false,
        remediation: relink,
      },
      expected,
      warnings: [
        `global ${describeCorePackageCandidate(globalPackage)} at ${globalPackagePath} is installed but its realpath could not be resolved [${code}], so it is UNVERIFIABLE - it is not known to be absent`,
        `inspect then repoint: ${globalCoreInspectCommand(globalPackagePath, context.platform, false)} && ${relink}`,
      ],
    };
  }
  if (!globalPackage || !globalPackagePath || !globalRealpath) {
    // (3) Informational: nothing to verify, but tell the operator exactly how to link one.
    return {
      status: 'pass',
      actual: {
        installed: false,
        presence: 'absent',
        npmRoot: globalRoot,
        packageName: globalPackage?.packageName ?? CANONICAL_CORE_PACKAGE_NAME,
        packagePath: globalPackagePath,
        linkTarget: null,
        realpath: null,
        version: null,
        expectedVersion,
        errorCode: null,
        binTarget: null,
        binMode: null,
        executable: null,
        verification: null,
        worktreeCheckout: false,
        remediation: relink,
      },
      expected,
      details: [
        `global ${CANONICAL_CORE_PACKAGE_NAME} is not installed (informational; \`npm root -g\` has no ${CANONICAL_CORE_PACKAGE_NAME}); link one with: ${relink}`,
      ],
    };
  }
  if (!context.cliEntrypoint) {
    // The package being present under `npm root -g` does not prove that an
    // invokable proof-or-stop command exists. Keep this distinct from package
    // absence and do not emit the resolved-install PASS contract marker.
    return {
      status: statusForDrift(severity),
      actual: {
        installed: true,
        presence: 'resolved',
        availableOnPath: false,
        npmRoot: globalRoot,
        packageName: globalPackage.packageName,
        packagePath: globalPackagePath,
        linkTarget: null,
        realpath: globalRealpath,
        version: null,
        expectedVersion,
        errorCode: null,
        binTarget: null,
        binTargetRealpath: null,
        binMode: null,
        executable: null,
        verification: 'command-entrypoint-missing',
        verificationErrorCode: null,
        commandShim: null,
        worktreeCheckout: isWorktreeCheckoutPath(globalRealpath),
        remediation: relink,
      },
      expected,
      warnings: [
        `global ${describeCorePackageCandidate(globalPackage)} is installed at ${globalRealpath}, but no proof-or-stop command was found on PATH`,
        `link the installed package command: ${relink}`,
      ],
    };
  }
  const globalPackageJson = readPackageJson(globalRealpath);
  const declaredVersion = globalPackageJson?.version;
  const version = typeof declaredVersion === 'string' && declaredVersion.trim().length > 0 ? declaredVersion.trim() : null;
  const executableFacts = inspectGlobalCoreExecutable(
    globalRealpath,
    globalPackagePath,
    context.cliEntrypoint,
    context.platform,
    context.executableAccessProbe,
    context.binTargetStatProbe,
    context.binTargetRealpathProbe,
    context.commandShimReadProbe,
    context.windowsCommandRuntimeProbe,
  );
  const worktreeCheckout = isWorktreeCheckoutPath(globalRealpath);
  const pathMatches = expected !== null && samePath(globalRealpath, expected);
  const warnings: string[] = [];
  const remediations: string[] = [];
  // The same command can be the fix for two independent facts (a missing
  // version and a missing bin target both want rebuild-and-relink); the
  // operator must never be handed `x && y && x`.
  const addRemediation = (command: string): void => { if (!remediations.includes(command)) remediations.push(command); };
  if (canonicalDiscoveryFailed) {
    warnings.push(`the canonical main worktree could not be discovered; the current Story worktree cannot be treated as the stable global target`);
    warnings.push(`diagnose repository topology: ${diagnoseCanonical}`);
    addRemediation(diagnoseCanonical);
  } else if (!pathMatches) {
    // (1) Drift: keep the historical explanatory line, then the exact repoint command.
    warnings.push(`global ${describeCorePackageCandidate(globalPackage)} resolves to ${globalRealpath}, expected ${expected}`);
    if (worktreeCheckout) {
      warnings.push(`global realpath is inside a \`.worktrees/\` checkout; it will break when that worktree is removed or rebuilt`);
    }
    warnings.push(`repoint: ${relink}`);
    addRemediation(relink);
  }
  if (worktreeCheckout && !warnings.some((warning) => warning.includes('inside a `.worktrees/` checkout'))) {
    warnings.push(`global realpath is inside a \`.worktrees/\` checkout; it will break when that worktree is removed or rebuilt`);
  }
  if (executableFacts.verification === 'bin-target-stat-failed' && executableFacts.binTarget) {
    const inspect = globalCoreInspectCommand(executableFacts.binTarget, context.platform, true);
    warnings.push(`global bin target ${executableFacts.binTarget} could not be inspected [${executableFacts.verificationErrorCode ?? 'UNKNOWN'}]; its existence, mode, and executable state are unknown`);
    if (pathMatches) {
      warnings.push(`inspect filesystem access: ${inspect}`);
      addRemediation(inspect);
    } else {
      warnings.push(`reported for the obsolete target only; the repoint above is the fix`);
    }
  } else if (executableFacts.verification !== 'ok') {
    // (5) Installed but unverifiable is drift, never a silent pass: name the
    // exact reason and the package path. A canonical checkout gets a rebuild
    // in front of the relink; a drifted realpath already carries the relink.
    const reason = describeGlobalCoreVerification(executableFacts.verification);
    const targetDetail = executableFacts.binTarget
      ? `; declared target ${executableFacts.binTarget}${executableFacts.binTargetRealpath ? ` resolves to ${executableFacts.binTargetRealpath}` : ''}${executableFacts.commandShim ? `; command shim ${executableFacts.commandShim}` : ''}`
      : '';
    const errorDetail = executableFacts.verificationErrorCode ? ` [${executableFacts.verificationErrorCode}]` : '';
    warnings.push(`global ${describeCorePackageCandidate(globalPackage)} at ${globalRealpath} cannot be verified [${executableFacts.verification}]: ${reason}${errorDetail} (${join(globalRealpath, 'package.json')})${targetDetail}`);
    if (pathMatches) {
      const rebuild = globalCoreRebuildCommand(globalRealpath, context.platform);
      warnings.push(`rebuild and relink: ${rebuild} && ${relink}`);
      addRemediation(rebuild);
      addRemediation(relink);
    } else {
      warnings.push(`reported for the obsolete target only; the repoint above is the fix`);
    }
  } else if (executableFacts.executable === false && executableFacts.binTarget) {
    // (2) The bin symlink resolves here but the target cannot be executed.
    // B-e256-xhr-r7: a DRIFTED realpath reports the old target's facts but
    // never appends chmod/rebuild for that obsolete checkout; the relink
    // pushed in (1) stays the sole actionable remediation, so the combined
    // command never keeps mutating a path the repoint already abandons.
    if (!executableFacts.binTargetExists) {
      if (pathMatches) {
        const rebuild = globalCoreRebuildCommand(globalRealpath, context.platform);
        warnings.push(`global bin target ${executableFacts.binTarget} does not exist; rebuild: ${rebuild}`);
        addRemediation(rebuild);
      } else {
        warnings.push(`global bin target ${executableFacts.binTarget} does not exist (reported for the obsolete target only; the repoint above is the fix)`);
      }
    } else if (pathMatches && executableFacts.executeBitsSet) {
      // B-e256-xhr-r11 MAJOR: X_OK denied although the execute bits ARE set.
      // `chmod +x` is a no-op here (it would set bits that are already set) and
      // naming it as "the fix" leaves the operator with a global CLI that stays
      // unusable. The denial comes from something chmod cannot reach.
      const rebuild = globalCoreRebuildCommand(globalRealpath, context.platform);
      warnings.push(`global bin target ${executableFacts.binTarget} is marked executable (mode ${executableFacts.binMode}) but the current user still cannot execute it; \`chmod +x\` cannot repair this - the likely causes are file ownership or an ACL denying execute to this user, or a filesystem mounted noexec`);
      warnings.push(`rebuild and relink: ${rebuild} && ${relink}`);
      addRemediation(rebuild);
      addRemediation(relink);
    } else if (pathMatches && context.platform === 'win32') {
      // Defensive only: failed Windows shim validation is handled by the
      // verification branch above. If a future/injected probe reaches this
      // branch, chmod is still never a valid Windows repair.
      const rebuild = globalCoreRebuildCommand(globalRealpath, context.platform);
      warnings.push(`global npm command-shim target ${executableFacts.binTarget} could not be launched; Windows has no POSIX execute-bit repair`);
      warnings.push(`rebuild and relink: ${rebuild} && ${relink}`);
      addRemediation(rebuild);
      addRemediation(relink);
    } else if (pathMatches) {
      const chmod = `chmod +x ${shellQuote(executableFacts.binTarget)}`;
      warnings.push(`global bin target ${executableFacts.binTarget} is not executable by the current user (mode ${executableFacts.binMode}); fix: ${chmod}`);
      addRemediation(chmod);
    } else {
      warnings.push(`global bin target ${executableFacts.binTarget} is not executable by the current user (mode ${executableFacts.binMode}; reported for the obsolete target only; the repoint above is the fix)`);
    }
  }
  // (6) B-e256-xhr-r12 MAJOR: the version is a VERIFIED fact, not decoration.
  // It is only checked when package.json was readable at all: when it was not,
  // (5) above already reports that exact reason and the absent version is its
  // consequence, not an independent finding.
  //
  // This does NOT duplicate the separate `package-version` runtime fact. That
  // one is a cross-copy CONSISTENCY fact over the local workspace: it collects
  // runtime / root / packages-main / global versions, FILTERS missing ones out,
  // passes when <= 1 distinct value survives, and for an external project it
  // ignores the global version entirely. So it is structurally blind to exactly
  // the two cases below - a global install with no version at all, and any
  // global version drift outside a self project - while this check is the
  // per-install fact: the global core must carry the canonical version and its
  // remediation is that install's rebuild/repoint, not a workspace-wide notice.
  if (globalPackageJson && (version === null || version !== expectedVersion)) {
    const observed = version === null
      ? `declares no version in ${join(globalRealpath, 'package.json')}`
      : `reports version ${version}`;
    if (pathMatches) {
      const rebuild = globalCoreRebuildCommand(globalRealpath, context.platform);
      warnings.push(`global ${describeCorePackageCandidate(globalPackage)} at ${globalRealpath} ${observed}; expected ${expectedVersion}`);
      warnings.push(`rebuild and relink: ${rebuild} && ${relink}`);
      addRemediation(rebuild);
      addRemediation(relink);
    } else {
      // Same obsolete-target discipline as (2)/(5): the repoint pushed in (1)
      // stays the sole actionable remediation for a path we are abandoning.
      warnings.push(`global ${describeCorePackageCandidate(globalPackage)} at ${globalRealpath} ${observed}; expected ${expectedVersion} (reported for the obsolete target only; the repoint above is the fix)`);
    }
  }
  // (7) B-e256 cross-host review B-e256-xhr-r13 MAJOR: the version compared
  // above is read from package.json, which a rebuild that silently fails or is
  // skipped never touches - on the canonical path it is even the SAME file as
  // `expected`'s manifest, so (6) can only ever catch a missing declaration,
  // never a genuinely stale compiled runtime. This compares what the runtime
  // ACTUALLY compiles to (`dist/core/proof-or-stop-brand.js`'s
  // PROOF_OR_STOP_CLI_VERSION), independent of the manifest. A probe that
  // cannot even be read/parsed is unverifiable drift, never a pass - it is
  // exactly the "package.json says new, dist/ still serves old" case this
  // story targets.
  let compiledVersion: string | null = null;
  if (globalPackageJson) {
    const compiledVersionProbe = context.compiledCoreVersionProbe(globalRealpath);
    compiledVersion = compiledVersionProbe.version;
    if (compiledVersionProbe.failureReason) {
      warnings.push(`global ${describeCorePackageCandidate(globalPackage)} at ${globalRealpath} compiled runtime version could not be verified: ${compiledVersionProbe.failureReason}`);
      if (pathMatches) {
        const rebuild = globalCoreRebuildCommand(globalRealpath, context.platform);
        warnings.push(`rebuild and relink: ${rebuild} && ${relink}`);
        addRemediation(rebuild);
        addRemediation(relink);
      } else {
        warnings.push(`reported for the obsolete target only; the repoint above is the fix`);
      }
    } else if (compiledVersion !== expectedVersion) {
      if (pathMatches) {
        const rebuild = globalCoreRebuildCommand(globalRealpath, context.platform);
        warnings.push(`global ${describeCorePackageCandidate(globalPackage)} at ${globalRealpath} compiled runtime reports version ${compiledVersion}; expected ${expectedVersion} (dist appears stale)`);
        warnings.push(`rebuild and relink: ${rebuild} && ${relink}`);
        addRemediation(rebuild);
        addRemediation(relink);
      } else {
        warnings.push(`global ${describeCorePackageCandidate(globalPackage)} at ${globalRealpath} compiled runtime reports version ${compiledVersion}; expected ${expectedVersion} (reported for the obsolete target only; the repoint above is the fix)`);
      }
    }
  }
  const status = warnings.length === 0 ? 'pass' : statusForDrift(severity);
  return {
    status,
    actual: {
      installed: true,
      presence: 'resolved',
      errorCode: null,
      npmRoot: globalRoot,
      packageName: globalPackage.packageName,
      packagePath: globalPackagePath,
      linkTarget: null,
      realpath: globalRealpath,
      version,
      expectedVersion,
      compiledVersion,
      binTarget: executableFacts.binTarget,
      binTargetRealpath: executableFacts.binTargetRealpath,
      binMode: executableFacts.binMode,
      binTargetExists: executableFacts.binTargetExists,
      executable: executableFacts.executable,
      verification: executableFacts.verification,
      verificationErrorCode: executableFacts.verificationErrorCode,
      commandShim: executableFacts.commandShim,
      commandEntrypointRealpath: executableFacts.commandEntrypointRealpath ?? null,
      worktreeCheckout,
      remediation: remediations.length > 0 ? remediations.join(' && ') : null,
    },
    expected,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function checkProjectLocalBin(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const localBin = projectLocalBinPath(context.projectRoot);
  const localBinExists = existsSync(localBin);
  const localRealpath = localBinExists ? safeRealpath(localBin) : null;
  const cliRealpath = context.activeCliEntrypoint ? safeRealpath(context.activeCliEntrypoint) : context.cliEntrypoint ? safeRealpath(context.cliEntrypoint) : null;
  const matchesEntrypoint = localBinExists && !!localRealpath && !!cliRealpath && samePath(localRealpath, cliRealpath);
  const shadowsEntrypoint = localBinExists && !matchesEntrypoint;
  const status = shadowsEntrypoint ? statusForDrift(severity) : 'pass';
  return {
    status,
    actual: {
      path: localBin,
      present: localBinExists,
      realpath: localRealpath,
      cliRealpath,
      matchesEntrypoint,
      shadowsEntrypoint,
    },
    expected: 'project-local proof-or-stop should be absent or resolve to the active CLI entrypoint',
    ...(shadowsEntrypoint ? { warnings: [localBinWarning(localBin, localRealpath, cliRealpath, context.activeCliEntrypoint ?? context.cliEntrypoint)] } : {}),
  };
}

function classifyRuntimeMode(context: RuntimeCheckContext): RuntimeModeContract {
  const active = runtimeEntrypointRealpath(context);
  const localBin = projectLocalBinPath(context.projectRoot);
  const localBinPresent = existsSync(localBin);
  const localBinRealpath = localBinPresent ? safeRealpath(localBin) : null;

  if (localBinPresent) {
    if (!active.realpath) {
      return runtimeModeContract(
        'diagnostic-only',
        'unknown',
          'project-local CLI bin exists, but the active Proof-or-Stop entrypoint could not be resolved',
      );
    }
    if (!localBinRealpath) {
      return runtimeModeContract(
        'diagnostic-only',
        'unknown',
        `project-local CLI bin exists at ${localBin}, but its realpath could not be resolved`,
      );
    }
    if (samePath(localBinRealpath, active.realpath)) {
      if (isPackagedRuntime()) {
        return runtimeModeContract(
          'packaged-runtime',
          'packaged-runtime',
          'packaged runtime detected; project package.json/node_modules are not required for Proof-or-Stop diagnostics',
        );
      }
      return runtimeModeContract(
        'project-local-package',
        'project-node-modules',
        `active Proof-or-Stop is the project-local ${relative(context.projectRoot, localBin)} package`,
        true,
      );
    }
    return runtimeModeContract(
      'diagnostic-only',
      'unknown',
      `project-local CLI bin ${localBin} resolves to ${localBinRealpath}, but the active CLI resolves to ${active.realpath}`,
    );
  }

  if (isPackagedRuntime()) {
    return runtimeModeContract(
      'packaged-runtime',
      'packaged-runtime',
      'packaged runtime detected; project package.json/node_modules are not required for Proof-or-Stop diagnostics',
    );
  }

  if (!active.realpath) {
    return runtimeModeContract(
      'diagnostic-only',
      'unknown',
      'active Proof-or-Stop entrypoint could not be resolved; runtime classification is diagnostic-only',
    );
  }

  const source = runtimeModeSource(context, active.realpath);
  if (source === 'unknown') {
    return runtimeModeContract(
      'diagnostic-only',
      'unknown',
      `active Proof-or-Stop ${active.realpath} does not match a known runtime source`,
    );
  }

  if (source === 'global-cli' && !compatibilityLauncherSignal(active.path)) {
    return runtimeModeContract(
      'global-cli',
      'global-cli',
      'active Proof-or-Stop resolves to the global installation; project package.json/node_modules are not required',
    );
  }

  return runtimeModeContract(
    'compatibility-launcher',
    source,
    compatibilityRuntimeMessage(source),
  );
}

function runtimeModeContract(
  mode: RuntimeMode,
  source: RuntimeModeSource,
  message: string,
  requiresProjectJavaScriptRuntime = false,
): RuntimeModeContract {
  return {
    mode,
    source,
    requiresProjectJavaScriptRuntime,
    authority: RUNTIME_MODE_AUTHORITY,
    message,
  };
}

function runtimeEntrypointRealpath(context: RuntimeCheckContext): { path: string | null; realpath: string | null } {
  const path = context.activeCliEntrypoint ?? context.cliEntrypoint;
  return {
    path,
    realpath: path ? safeRealpath(path) ?? resolve(path) : null,
  };
}

function runtimeModeSource(context: RuntimeCheckContext, activeRealpath: string): RuntimeModeSource {
  const selfDistRoot = join(context.projectRoot, 'packages', 'main', 'dist');
  const projectNodeModulesCore = resolveCorePackageCandidate(join(context.projectRoot, 'node_modules'));
  const globalCoreRoot = context.globalNpmRoot ? resolveCorePackageCandidate(context.globalNpmRoot) : null;

  if (pathContains(selfDistRoot, activeRealpath) || samePath(context.corePackageRoot, join(context.projectRoot, 'packages', 'main'))) {
    return 'repo-local-dist';
  }
  if (pathContains(projectNodeModulesCore.path, activeRealpath) || pathContains(projectNodeModulesCore.path, context.corePackageRoot)) {
    return 'project-node-modules';
  }
  if (globalCoreRoot && (pathContains(globalCoreRoot.path, activeRealpath) || pathContains(globalCoreRoot.path, context.corePackageRoot))) {
    return 'global-cli';
  }
  if (pathContains(context.corePackageRoot, activeRealpath) || !pathContains(context.projectRoot, context.corePackageRoot)) {
    return 'external-development-engine';
  }
  return 'unknown';
}

function compatibilityRuntimeMessage(source: RuntimeModeSource): string {
  switch (source) {
    case 'repo-local-dist':
      return 'compatibility launcher is using the repository-local Proof-or-Stop dist runtime; run npm --prefix packages/main run build after core edits';
    case 'project-node-modules':
      return 'compatibility launcher is using the project node_modules Proof-or-Stop package without requiring node_modules/.bin/proof-or-stop as the active CLI';
    case 'packaged-runtime':
      return 'compatibility launcher is using a packaged Proof-or-Stop runtime; project package.json/node_modules are not required';
    case 'external-development-engine':
      return 'compatibility launcher is using an external Proof-or-Stop development engine; project package.json/node_modules are not required';
    case 'global-cli':
      return 'compatibility launcher is using the global Proof-or-Stop; project package.json/node_modules are not required';
    case 'unknown':
      return 'runtime source is unknown; classification is diagnostic-only';
  }
}

function checkNodeVersion(severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const major = Number(process.versions.node.split('.')[0]);
  const ok = Number.isFinite(major) && major >= MIN_NODE_MAJOR;
  return {
    status: ok ? 'pass' : statusForDrift(severity),
    actual: process.version,
    expected: `>=${MIN_NODE_MAJOR}.0.0`,
    ...(ok ? {} : { warnings: [`Node ${process.version} is below ${MIN_NODE_MAJOR}.x`] }),
  };
}

function checkPackageVersion(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const runtimePackage = readPackageJson(context.corePackageRoot);
  const rootPackage = readPackageJson(context.projectRoot);
  const selfCorePackage = context.isSelfProject ? readPackageJson(join(context.projectRoot, 'packages', 'main')) : null;
  const globalPackageCandidate = context.globalNpmRoot ? resolveCorePackageCandidate(context.globalNpmRoot) : null;
  const globalPackagePath = globalPackageCandidate?.path ?? null;
  const globalPackage = globalPackagePath ? readPackageJson(globalPackagePath) : null;
  const versions = [
    runtimePackage?.version,
    context.isSelfProject ? rootPackage?.version : undefined,
    context.isSelfProject ? selfCorePackage?.version : undefined,
    context.isSelfProject ? globalPackage?.version : undefined,
  ].filter((version): version is string => typeof version === 'string' && version.length > 0);
  const unique = new Set(versions);
  const ok = unique.size <= 1 && versions.length > 0;
  return {
    status: ok ? 'pass' : statusForDrift(severity),
    actual: {
      runtime: packageSummary(runtimePackage, context.corePackageRoot),
      root: packageSummary(rootPackage, context.projectRoot),
      selfCore: selfCorePackage ? packageSummary(selfCorePackage, join(context.projectRoot, 'packages', 'main')) : null,
      globalCore: globalPackagePath ? packageSummary(globalPackage, globalPackagePath) : null,
    },
    expected: context.isSelfProject ? 'root, packages/main, runtime, and global core versions match' : 'runtime package version readable',
    ...(ok ? {} : { warnings: ['Proof-or-Stop package versions are missing or inconsistent'] }),
  };
}

function checkValidateSource(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings'> {
  const scan = scanValidateSource(context.projectRoot);
  const status = scan.source === 'missing' || scan.source === 'fallback' ? statusForDrift(severity) : 'pass';
  return {
    status,
    actual: scan,
    expected: 'validate.ts/js/mts or configured validate.command(s); fallback discovery is advisory only',
    ...(status === 'pass' ? {} : { warnings: scan.warnings }),
  };
}

function checkExternalReferencePolicy(context: RuntimeCheckContext, severity: RuntimeFactSeverity): Pick<RuntimeFactCheckResult, 'status' | 'actual' | 'expected' | 'warnings' | 'connectivityChecked'> {
  const scan = scanExternalReferences(context.projectRoot);
  const referencesMissingHealth = scan.references.filter((ref) => !ref.healthSemantics);
  const status = referencesMissingHealth.length > 0 ? statusForDrift(severity) : 'pass';
  const warnings = referencesMissingHealth.map((ref) => `${ref.file}:${ref.line} ${ref.value} is reference-only; no health command semantics found`);
  return {
    status,
    connectivityChecked: false,
    actual: {
      scannedFiles: scan.scannedFiles,
      ignoredExamples: scan.ignoredExamples,
      externalReferenceCount: scan.references.length,
      references: scan.references.slice(0, 20),
      policy: 'reference-only',
    },
    expected: 'bounded docs/config references either stay internal or document explicit health command semantics',
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function scanValidateSource(projectRoot: string): {
  validateFiles: Array<{ name: string; present: boolean }>;
  validateFile: string | null;
  configuredCommands: number;
  discoveredFallbackLabels: string[];
  source: 'validate-file' | 'configured' | 'fallback' | 'missing';
  warnings: string[];
} {
  const validateFiles = ['validate.ts', 'validate.js', 'validate.mts'].map((name) => ({
    name,
    present: existsSync(join(projectRoot, name)),
  }));
  const validateFile = validateFiles.find((file) => file.present)?.name ?? null;
  const configuredCommands = countConfiguredValidationCommands(projectRoot);
  const discoveredFallbackLabels = discoverFallbackValidationLabels(projectRoot);
  const source = validateFile
    ? 'validate-file'
    : configuredCommands > 0
      ? 'configured'
      : discoveredFallbackLabels.length > 0
        ? 'fallback'
        : 'missing';
  const warnings: string[] = [];
  if (source === 'fallback') {
    warnings.push('validate.ts/js/mts and configured validate.command(s) are missing; using advisory fallback discovery');
  }
  if (source === 'missing') {
    warnings.push('No validate.ts/js/mts, configured validate.command(s), or fallback validation commands found');
  }
  return { validateFiles, validateFile, configuredCommands, discoveredFallbackLabels, source, warnings };
}

function countConfiguredValidationCommands(projectRoot: string): number {
  const cfg = loadConfig(projectRoot) as any;
  const validate = cfg.validate || cfg.validation;
  if (!validate || typeof validate !== 'object') return 0;
  let count = 0;
  if (typeof validate.command === 'string' && validate.command.trim()) count++;
  if (Array.isArray(validate.commands)) {
    for (const entry of validate.commands) {
      if (typeof entry === 'string' && entry.trim()) count++;
      else if (entry && typeof entry === 'object' && typeof entry.command === 'string' && entry.command.trim()) count++;
    }
  }
  return count;
}

function discoverFallbackValidationLabels(projectRoot: string): string[] {
  const labels: string[] = [];
  const packageJson = readPackageJson(projectRoot);
  if (typeof packageJson?.scripts?.test === 'string' && packageJson.scripts.test.trim() && !/no test specified/i.test(packageJson.scripts.test)) {
    labels.push('package.json test script');
  }
  if (existsSync(join(projectRoot, 'go.mod'))) labels.push('go test');
  if (existsSync(join(projectRoot, 'Cargo.toml'))) labels.push('cargo test');
  // Swift / Package.swift is intentionally NOT advertised as a standard
  // automatic fallback (Mac Native App demoted). Opt in explicitly via
  // validate.commands if needed.
  if (existsSync(join(projectRoot, 'pom.xml'))) labels.push('maven test');
  if (existsSync(join(projectRoot, 'build.gradle')) || existsSync(join(projectRoot, 'build.gradle.kts')) || existsSync(join(projectRoot, 'settings.gradle')) || existsSync(join(projectRoot, 'settings.gradle.kts'))) {
    labels.push('gradle test');
  }
  if (
    existsSync(join(projectRoot, 'pyproject.toml')) ||
    existsSync(join(projectRoot, 'pytest.ini')) ||
    existsSync(join(projectRoot, 'setup.cfg')) ||
    existsSync(join(projectRoot, 'tox.ini')) ||
    hasDirectoryEntry(projectRoot, 'tests', '.py')
  ) {
    labels.push('pytest');
  }
  return labels;
}

function scanExternalReferences(projectRoot: string): {
  scannedFiles: string[];
  ignoredExamples: number;
  references: ExternalReference[];
} {
  const relFiles = boundedReferenceFiles(projectRoot);
  const references: ExternalReference[] = [];
  let ignoredExamples = 0;
  for (const relFile of relFiles) {
    const absFile = join(projectRoot, relFile);
    const text = readText(absFile);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const values = externalValuesFromLine(line);
      for (const value of values) {
        if (LOCAL_HOST_RE.test(value)) {
          ignoredExamples++;
          continue;
        }
        const windowText = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join('\n');
        references.push({
          file: relFile,
          value,
          line: index + 1,
          healthSemantics: HEALTH_SEMANTICS_RE.test(windowText),
        });
      }
    }
  }
  return { scannedFiles: relFiles, ignoredExamples, references };
}

function boundedReferenceFiles(projectRoot: string): string[] {
  // Scan the same active project config surface as loadConfig.
  const candidates = [...PROJECT_CONFIG_FILENAMES, 'AGENTS.md', 'CLAUDE.md', 'README.md'];
  const files = candidates.filter((relPath) => existsSync(join(projectRoot, relPath)));
  const requirementsRoot = join(projectRoot, 'docs', 'requirements');
  for (const relPath of listMarkdownFiles(requirementsRoot, join('docs', 'requirements'))) {
    files.push(relPath);
  }
  return files;
}

function listMarkdownFiles(absDir: string, relDir: string): string[] {
  const out: string[] = [];
  if (!existsSync(absDir)) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(absDir);
  } catch {
    // PROBE: unreadable optional docs/requirements directory means there are no bounded docs to scan.
    return out;
  }
  for (const entry of entries) {
    const abs = join(absDir, entry);
    const rel = join(relDir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      // PROBE: skip entries that disappear or cannot be statted during the bounded scan.
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...listMarkdownFiles(abs, rel));
    } else if (entry.endsWith('.md')) {
      out.push(rel);
    }
  }
  return out;
}

function externalValuesFromLine(line: string): string[] {
  const values = new Set<string>();
  for (const match of line.matchAll(URL_RE)) values.add(stripTrailingPunctuation(match[0]));
  for (const match of line.matchAll(HOST_PORT_RE)) values.add(stripTrailingPunctuation(match[0]));
  return [...values];
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;]+$/g, '');
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs = 2_000): string | null {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: process.env,
    }).trim();
  } catch {
    // PROBE: command discovery is best-effort for runtime diagnostics.
    return null;
  }
}

function runAuthoritativeIdentityCommand(args: string[], cwd: string, budget: IdentityProbeBudget): string | null {
  let attempt = 0;
  while (performance.now() < budget.deadline) {
    const remaining = Math.max(1, Math.floor(budget.deadline - performance.now()));
    const timeout = attempt === 0 ? Math.min(2_000, remaining) : remaining;
    try {
      return execFileSync('git', args, {
        cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout,
        env: budget.env as NodeJS.ProcessEnv,
      }).trim();
    } catch (error) {
      const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).code === 'ETIMEDOUT'
        || (error as { killed?: boolean }).killed === true;
      if (!timedOut) return null;
      budget.timedOut = true;
      attempt += 1;
    }
  }
  budget.timedOut = true;
  return null;
}

function resolveCliCommandPath(projectRoot: string): string | null {
  // This health fact promises the canonical user-visible command. A healthy
  // legacy `lattice` launcher cannot stand in for an absent `proof-or-stop`.
  return resolveCommandOnPath('proof-or-stop', projectRoot);
}

function resolveCommandOnPath(command: 'proof-or-stop', projectRoot: string): string | null {
  const pathEnv = process.platform === 'win32'
    ? process.env.Path ?? process.env.PATH ?? ''
    : process.env.PATH ?? '';
  for (const rawDir of pathEnv.split(delimiter)) {
    const dir = rawDir.length > 0 ? rawDir : '.';
    const absDir = isAbsolute(dir) ? dir : resolve(projectRoot, dir);
    for (const name of commandPathNames(command)) {
      const candidate = resolve(absDir, name);
      if (isRunnablePath(candidate)) return candidate;
    }
  }
  return null;
}

function commandPathNames(command: 'proof-or-stop'): string[] {
  if (process.platform !== 'win32') return [command];
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
  // CreateProcess/cmd resolve an unqualified command through PATHEXT order;
  // an extensionless sibling is not preferred over an executable extension.
  // Include case variants beside each extension solely so a win32 simulation
  // on a case-sensitive test host models Windows' case-insensitive lookup.
  return [...new Set(extensions.flatMap((extension) => {
    const suffix = extension.startsWith('.') ? extension : `.${extension}`;
    return [`${command}${suffix}`, `${command}${suffix.toLowerCase()}`, `${command}${suffix.toUpperCase()}`];
  }))];
}

function isRunnablePath(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// B-e256 cross-host review B-e256-xhr-r13 MAJOR: a legacy plain-string resolver
// has no vocabulary for "the probe failed", so its `null` is wrapped as an
// unspecified-reason failure rather than being trusted as "genuinely absent".
function wrapLegacyGlobalNpmRootResolver(root: string | null): GlobalNpmRootProbeResult {
  return root !== null
    ? { root, failureReason: null }
    : { root: null, failureReason: 'the configured globalNpmRootResolver reported no root (probe outcome unspecified)' };
}

// B-e256 cross-host review B-e256-xhr-r13 MAJOR: the generic `runCommand`
// collapses EVERY failure (missing binary, non-zero exit, timeout, empty
// output) into a bare `null`, which is exactly the signal
// `checkGlobalCoreRealpath` used to treat as "nothing installed". This probe
// captures WHICH failure happened so that check can tell "npm root -g really
// found nothing" apart from "the probe itself could not run" and report the
// latter as unverifiable drift instead of a silent pass.
function probeGlobalNpmRoot(projectRoot: string, timeoutMs = 2_000): GlobalNpmRootProbeResult {
  let stdout: string;
  try {
    stdout = execFileSync('npm', ['root', '-g'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: process.env,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null; status?: number | null; killed?: boolean };
    if (err.code === 'ENOENT') return { root: null, failureReason: 'npm was not found on PATH (ENOENT)' };
    if (err.killed || err.signal === 'SIGTERM') return { root: null, failureReason: `npm root -g did not respond within ${timeoutMs}ms and was killed` };
    const status = typeof err.status === 'number' ? err.status : null;
    return {
      root: null,
      failureReason: status !== null ? `npm root -g exited with code ${status}` : `npm root -g failed [${errnoCode(error)}]`,
    };
  }
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { root: null, failureReason: 'npm root -g produced no output' };
  if (/\r|\n/.test(trimmed) || !isAbsolute(trimmed)) {
    return { root: null, failureReason: `npm root -g produced invalid path output: ${JSON.stringify(trimmed)}` };
  }
  return { root: trimmed, failureReason: null };
}

// B-e256 cross-host review B-e256-xhr-r13 MAJOR: the ACTUAL version the
// compiled runtime reports, read from the build artifact tsc emits from
// proof-or-stop-brand.ts, never from package.json (a rebuild that silently
// fails or is skipped leaves the manifest bumped while dist/ still serves the
// old code, and comparing package.json to package.json can never observe
// that). Reuses version-bump.ts's `findBrandExport` (the SAME declaration
// shape and ambiguity guard as its BRAND_EXPORT_RE, applied here to the
// compiled JS instead of the TS source: tsc only strips `as const`, so the
// declaration shape survives compilation unchanged) rather than a second,
// unguarded regex match: a comment-stripped view is required so a comment
// containing an export-shaped line can never be picked over the real
// declaration, and a raw-vs-stripped count mismatch (that exact case) must be
// refused as ambiguous rather than silently resolved. A file read/spawn is
// deliberately NOT used here (the alternative this finding names is running
// the global executable's own `--version`); inspecting this artifact gets the
// same authoritative fact without the cost and hang risk of spawning the
// global CLI from inside a doctor check.
//
// B-e256 F-004: an artifact that cannot be read (missing/unbuilt dist) and one
// that CAN be read but is unparsable or ambiguous (no declaration, more than
// one declaration, or an export-shaped line hiding in a comment) are BOTH
// reported as unverifiable drift via `failureReason`, never as a pass and
// never as a silently wrong version — findBrandExport throws rather than
// picking a match in every one of those unparsable/ambiguous cases.
function defaultCompiledCoreVersionProbe(globalRealpath: string): CompiledCoreVersionProbeResult {
  const brandFile = join(globalRealpath, 'dist', 'core', 'proof-or-stop-brand.js');
  let content: string;
  try {
    content = readFileSync(brandFile, 'utf-8');
  } catch (error) {
    return { version: null, failureReason: `compiled runtime file ${brandFile} could not be read [${errnoCode(error)}]` };
  }
  try {
    return { version: findBrandExport(content, brandFile).version, failureReason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { version: null, failureReason: `compiled runtime file ${brandFile} does not declare an unambiguous PROOF_OR_STOP_CLI_VERSION: ${reason}` };
  }
}

function resolveActiveCliEntrypoint(projectRoot: string, corePackageRoot: string, fallbackEntrypoint: string | null): string | null {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
  if (invoked && looksLikeProofOrStopEntrypoint(invoked, projectRoot, corePackageRoot)) return invoked;
  return fallbackEntrypoint;
}

function looksLikeProofOrStopEntrypoint(path: string, projectRoot: string, corePackageRoot: string): boolean {
  const real = safeRealpath(path) ?? path;
  const name = basename(path);
  if (
    name === 'proof-or-stop'
    || name === 'proof-or-stop.cmd'
    || name === 'proof-or-stop.js'
    || name === 'proof-or-stop-codex.js'
  ) return true;
  if ((name === 'cli.js' || name === 'cli-engine.js') && pathContains(corePackageRoot, real)) return true;
  for (const rel of ['proof-or-stop.js', 'proof-or-stop-codex.js']) {
    if (samePath(real, join(projectRoot, 'bin', rel))) return true;
  }
  return false;
}

function currentCorePackageRoot(): string {
  return runtimePackageRoot();
}

function detectSelfProject(projectRoot: string): boolean {
  const rootPackage = readPackageJson(projectRoot);
  const corePackage = readPackageJson(join(projectRoot, 'packages', 'main'));
  const rootName = rootPackage?.name;
  const coreName = corePackage?.name;
  return SELF_ROOT_PACKAGE_NAMES.has(rootName)
    && typeof coreName === 'string'
    && SELF_CORE_PACKAGE_NAMES.has(coreName);
}

function packagePathFromName(root: string, packageName: string): string {
  const [scope, name] = packageName.split('/');
  if (!scope || !name) throw new Error(`invalid package name: ${packageName}`);
  return join(root, scope, name);
}

// B-e256-xhr-r11: lstat sees the link ENTRY (existsSync follows it), so a
// package directory that is a symlink to a removed checkout is reported as
// `dangling` instead of `absent`.
function probeCorePackagePresence(path: string): { presence: CorePackagePresence; errorCode: string | null } {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    const code = errnoCode(error);
    // B-e256-xhr-r12 MAJOR: ENOENT / ENOTDIR are the only two errors that mean
    // "nothing is installed here" (no entry, or a non-directory in the path).
    // EACCES, EPERM, EIO, ELOOP and friends mean the probe could not look, and
    // must never be reported as an absent install.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { presence: 'absent', errorCode: code };
    return { presence: 'unreadable', errorCode: code };
  }
  if (!entry.isSymbolicLink()) return { presence: 'resolved', errorCode: null };
  return { presence: existsSync(path) ? 'resolved' : 'dangling', errorCode: null };
}

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN';
}

// B-e256-xhr-r12 MAJOR: realpath failure on an installed package is drift, so
// the errno has to survive the probe (plain `safeRealpath` collapses it to null).
function defaultGlobalCoreRealpathProbe(path: string): GlobalCoreRealpathProbeResult {
  try {
    return { realpath: realpathSync(path), errorCode: null };
  } catch (error) {
    // PROBE: an unresolvable realpath is reported as drift with its errno.
    return { realpath: null, errorCode: errnoCode(error) };
  }
}

// B-e256-xhr-r11: the raw link target of a broken link, so the warning can name
// what the global installation still points at. Relative targets are resolved
// against the link's own directory.
function safeReadlinkTarget(path: string): string | null {
  try {
    const raw = readlinkSync(path);
    return isAbsolute(raw) ? raw : resolve(dirname(path), raw);
  } catch {
    return null;
  }
}

function resolveCorePackageCandidate(root: string): CorePackageCandidate {
  const canonicalPath = packagePathFromName(root, CANONICAL_CORE_PACKAGE_NAME);
  // B-cc10 CHK-005: fall back to the deprecated scope so an already-installed global
  // @proof-or-stop/core is still FOUND (and reported) instead of looking absent.
  const deprecatedPath = packagePathFromName(root, DEPRECATED_CORE_PACKAGE_NAME);
  const candidates: CorePackageCandidate[] = [
    { path: canonicalPath, packageName: CANONICAL_CORE_PACKAGE_NAME, ...probeCorePackagePresence(canonicalPath) },
    { path: deprecatedPath, packageName: DEPRECATED_CORE_PACKAGE_NAME, ...probeCorePackagePresence(deprecatedPath) },
  ];
  // A usable install always wins; a broken link is only reported when nothing
  // resolves; an unprobeable entry outranks `absent` because "we could not look"
  // must never be downgraded to "there is nothing there" (B-e256-xhr-r12).
  const resolved = candidates.find((candidate) => candidate.presence === 'resolved');
  if (resolved) return resolved;
  const dangling = candidates.find((candidate) => candidate.presence === 'dangling');
  if (dangling) return dangling;
  const unreadable = candidates.find((candidate) => candidate.presence === 'unreadable');
  if (unreadable) return unreadable;
  return { path: canonicalPath, packageName: CANONICAL_CORE_PACKAGE_NAME, presence: 'absent', errorCode: null };
}

function describeCorePackageCandidate(candidate: CorePackageCandidate): string {
  return candidate.packageName;
}

// Single source of truth for locating the refs/heads/main worktree's
// packages/main via `git worktree list --porcelain` (F-001): both the
// self-project and non-self canonicalizers parse identically and differ only
// in their fallbacks. Returns null when git fails, no main-branch worktree is
// listed, or the candidate directory does not exist.
function findMainWorktreeCoreRoot(anchorDir: string): string | null {
  const raw = runCommand('git', ['worktree', 'list', '--porcelain'], anchorDir);
  if (!raw) return null;
  const records = raw.split(/\n\s*\n/).map((record) => record.trim()).filter(Boolean);
  for (const record of records) {
    const lines = record.split(/\r?\n/);
    const worktree = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length).trim();
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length).trim();
    if (worktree && branch === 'refs/heads/main') {
      const candidate = join(worktree, 'packages', 'main');
      if (existsSync(candidate)) return safeRealpath(candidate) ?? resolve(candidate);
    }
  }
  return null;
}

function resolveCanonicalSelfCoreRoot(projectRoot: string): string | null {
  const canonical = findMainWorktreeCoreRoot(projectRoot);
  if (canonical) return canonical;
  // A Story worktree is explicitly disposable. When the topology probe fails,
  // falling back to its local packages/main path would certify that disposable
  // checkout as canonical and produce a false healthy global-runtime marker.
  if (isWorktreeCheckoutPath(projectRoot)) return null;
  const localCore = join(projectRoot, 'packages', 'main');
  return existsSync(localCore) ? safeRealpath(localCore) ?? resolve(localCore) : null;
}

// A worktree-built CLI evaluating a NON-self project must accept the global
// package resolving to the canonical main checkout of the CLI's own repository:
// linked worktrees are never relinked into `npm root -g`, so comparing against
// the raw corePackageRoot makes the check structurally unpassable from any
// story worktree (B-fa65). Canonicalize via `git worktree list` anchored at the
// core root itself; a different clone has a different repository, so its
// canonical path still differs from the global realpath and genuine drift
// keeps warning. A non-worktree checkout may safely fall back to its normalized
// core root, but a disposable Story worktree must remain unknown when topology
// discovery fails rather than certifying itself as canonical.
function resolveCanonicalCoreRoot(coreRoot: string): string | null {
  const canonical = findMainWorktreeCoreRoot(coreRoot);
  if (canonical) return canonical;
  const normalized = safeRealpath(coreRoot) ?? resolve(coreRoot);
  return isWorktreeCheckoutPath(normalized) ? null : normalized;
}

function readPackageJson(dir: string): any | null {
  const path = join(dir, 'package.json');
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // PROBE: missing or malformed package.json is reported as an unavailable package summary.
    return null;
  }
}

// B-e256-xhr-r12 MAJOR: the expectation for the global package's version is the
// CANONICAL core package this check already resolves as `expected` (the same
// root `expectedSelfCoreRoot` / `resolveCanonicalCoreRoot` produce). When that
// package.json cannot be read the expectation falls back to the running build's
// own PROOF_OR_STOP_CLI_VERSION instead of becoming null, because an
// unresolvable expectation would silently switch the comparison off - the exact
// silent-pass class this fix closes. That constant is not a second source of
// truth: it is the value those package.json files are bumped to in lockstep.
function readExpectedCoreVersion(canonicalCoreRoot: string): string {
  const declared = readPackageJson(canonicalCoreRoot)?.version;
  return typeof declared === 'string' && declared.trim().length > 0 ? declared.trim() : PROOF_OR_STOP_CLI_VERSION;
}

function packageSummary(pkg: any | null, dir: string): { path: string; name: unknown; version: unknown } | null {
  if (!pkg) return null;
  return { path: join(dir, 'package.json'), name: pkg.name, version: pkg.version };
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    // PROBE: optional bounded reference files may be absent or unreadable.
    return '';
  }
}

function hasDirectoryEntry(projectRoot: string, dir: string, suffix: string): boolean {
  const abs = join(projectRoot, dir);
  if (!existsSync(abs)) return false;
  try {
    return readdirSync(abs).some((entry) => entry.endsWith(suffix));
  } catch {
    // PROBE: optional test directories may be absent or unreadable.
    return false;
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // PROBE: unresolved realpaths are surfaced to callers as null for drift reporting.
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function projectLocalBinPath(projectRoot: string): string {
  const candidates = projectLocalBinCandidates(projectRoot);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function projectLocalBinCandidates(projectRoot: string): string[] {
  const binDir = join(projectRoot, 'node_modules', '.bin');
  return process.platform === 'win32'
    ? [join(binDir, 'proof-or-stop.cmd')]
    : [join(binDir, 'proof-or-stop')];
}

function isPackagedRuntime(): boolean {
  return readBrandEnv('DESKTOP_PACKAGED_RUNTIME') === '1'
    || Boolean((process as typeof process & { pkg?: unknown }).pkg);
}

// B-cc10 CHK-006: the deprecated basenames below remain recognized for older checkouts and
// compatibility provenance. This predicate
// asks "was a retained COMPATIBILITY launcher used?", so recognizing the old names is the
// whole point — adding the canonical spellings would make every ordinary canonical
// invocation look like a compatibility launcher and invert the classification at line 626.
// The current package ships only the proof-or-stop bin; an older checkout may still reach this
// signal through its legacy launcher and must remain classifiable as compatibility traffic.
function compatibilityLauncherSignal(activePath: string | null): boolean {
  if (readBrandEnv('ACTIVITY_SOURCE') === 'codex') return true;
  if (readBrandEnv('CODEX_ENTRYPOINT') === 'global-fallback' || readBrandEnv('CODEX_ENTRYPOINT') === 'local-wrapper') return true;
  return false;
}

function localBinWarning(localBin: string, localRealpath: string | null, cliRealpath: string | null, cliEntrypoint: string | null): string {
  if (!localRealpath) return `${localBin} exists but its realpath could not be resolved`;
  if (!cliRealpath) return `${localBin} exists but active Proof-or-Stop could not be resolved for comparison`;
  return `${localBin} resolves to ${localRealpath}, active CLI ${cliEntrypoint ?? 'proof-or-stop'} resolves to ${cliRealpath}`;
}

function statusForDrift(severity: RuntimeFactSeverity): RuntimeFactStatus {
  return severity === 'hard' ? 'fail' : 'warn';
}

function summarize(results: RuntimeFactCheckResult[]): RuntimeEnvironmentReport['summary'] {
  const pass = results.filter((result) => result.status === 'pass').length;
  const warn = results.filter((result) => result.status === 'warn').length;
  const fail = results.filter((result) => result.status === 'fail').length;
  return {
    status: fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'pass',
    pass,
    warn,
    fail,
  };
}

function compactFactDetail(result: RuntimeFactCheckResult): string {
  if (result.outputKey === 'externalReferencePolicy') {
    const actual = result.actual as any;
    return `${actual?.externalReferenceCount ?? 0} external refs, connectivityChecked=false`;
  }
  if (result.outputKey === 'validateSource') {
    const actual = result.actual as any;
    return `source=${actual?.source ?? 'unknown'}`;
  }
  if (result.outputKey === 'cliEntrypoint') {
    const actual = result.actual as any;
    return String(actual?.realpath ?? actual?.path ?? 'missing');
  }
  if (result.outputKey === 'globalCoreRealpath') {
    const actual = result.actual as any;
    if (actual?.presence === 'npm-root-probe-failed') {
      // B-e256 cross-host review B-e256-xhr-r13 MAJOR: the `npm root -g`
      // probe itself failing observed nothing, so it must never render as
      // "not installed" either.
      const hint = typeof actual?.remediation === 'string' ? ` (${actual.remediation})` : '';
      return `unverifiable (npm root -g probe failed; not known to be absent)${hint}`;
    }
    if (actual?.presence === 'dangling') {
      // B-e256-xhr-r11: a broken link must never render as "not installed".
      const hint = typeof actual?.remediation === 'string' ? ` (repoint: ${actual.remediation})` : '';
      return `broken link ${actual?.packagePath ?? 'unknown'} -> ${actual?.linkTarget ?? 'unreadable link target'}${hint}`;
    }
    if (actual?.presence === 'unreadable' || (actual?.presence === 'resolved' && !actual?.realpath)) {
      // B-e256-xhr-r12: a probe that could not look, or an installed package
      // whose realpath will not resolve, must never render as "not installed".
      const hint = typeof actual?.remediation === 'string' ? ` (repoint: ${actual.remediation})` : '';
      const reason = actual?.presence === 'unreadable' ? 'probe refused' : 'realpath unresolved';
      return `unverifiable ${actual?.packagePath ?? 'unknown'} [${actual?.errorCode ?? 'UNKNOWN'}] (${reason}; not known to be absent)${hint}`;
    }
    if (!actual?.realpath) {
      const hint = typeof actual?.remediation === 'string' ? ` (informational; link one with: ${actual.remediation})` : '';
      return `not installed${hint}`;
    }
    const mode = actual?.binMode ?? (actual?.binTarget ? 'missing' : 'unverified');
    const executable = actual?.executable === null || actual?.executable === undefined ? 'unverified' : actual.executable ? 'yes' : 'no';
    const unverifiable = typeof actual?.verification === 'string' && actual.verification !== 'ok' ? ` unverifiable=${actual.verification}` : '';
    const verificationError = actual?.verificationErrorCode ? ` error=${actual.verificationErrorCode}` : '';
    return `${actual.realpath} version=${actual?.compiledVersion ?? 'unknown'} mode=${mode} executable=${executable}${unverifiable}${verificationError}`;
  }
  if (result.outputKey === 'projectLocalBin') {
    const actual = result.actual as any;
    return actual?.present ? `present shadow=${actual.shadowsEntrypoint}` : 'absent';
  }
  if (result.outputKey === 'nodeVersion') return String(result.actual);
  if (result.outputKey === 'packageVersion') {
    const actual = result.actual as any;
    return String(actual?.runtime?.version ?? 'unknown');
  }
  return result.status;
}

function statusIcon(status: RuntimeFactStatus): string {
  if (status === 'pass') return '✓';
  if (status === 'warn') return '⚠';
  return '✗';
}
