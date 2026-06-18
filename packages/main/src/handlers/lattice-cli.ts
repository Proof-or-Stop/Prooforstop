import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'path';
import type { HandlerContext } from './context.js';
import { type AuthorityConfig, type AuthoritySettings } from '../core/authority-mode.js';
import {
  loadAuthorityConfig,
  resolveAuthorityCustomerApiKey,
  type AuthorityConfigLoadOptions,
  type AuthorityTrustProfileBundle,
} from '../core/authority-client.js';
import {
  AUTHORITY_RUNNER_PLANNED_STEPS,
  readActorPrivateKeyFromPath,
  runLatticeAuthorityControlPlaneOnce,
  type AuthorityRunnerPlan,
} from '../core/authority-runner.js';
import type { LatticeAuthorityKeyEncoding } from '../core/lattice-authority-native.js';
import { verifyLatticeAuthorityReceipt } from '../core/lattice-authority-native.js';
import {
  LATTICE_CLI_VERSION,
  LATTICE_PRODUCT_NAME,
  formatLatticeProductLine,
} from '../core/lattice-brand.js';
import {
  buildLatticeHostInstallGuidance,
  buildLatticeHostList,
  buildLatticeHostProbe,
  buildLatticeHostStatus,
  renderLatticeHostInstallText,
  renderLatticeHostListText,
  renderLatticeHostProbeText,
  renderLatticeHostStatusText,
  type LatticeFormat,
} from '../core/lattice-hosts.js';
import {
  DEFAULT_AUTHORITY_RECEIPT_MAX_VERIFIED_AGE_MS,
  eligibleAuthorityGateReceiptDocument,
  type AuthorityGateDecisionReceiptRef,
  type AuthorityReceiptRefDocument,
} from '../core/authority-gate-receipts.js';
import { normalizeAuthorityGatePhase, type AuthorityGatePhase } from '../core/authority-gate-receipt-verifier.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import {
  LATTICE_CONFIG_FILENAME,
  loadConfig,
  pickProjectConfigPath,
  resetConfigCache,
} from '../core/config.js';
import { gitProbe } from '../core/git-probe.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';

type FormatArgs = { format?: LatticeFormat; json?: boolean };

const AUTHORITY_DISCLAIMER =
  'Receipt-aware status only: existing receipt refs may be reported, no new receipt is verified, no evidence is submitted, and productionDone remains false.';

const LOCAL_WORKFLOW_NOTE =
  'Local workflow (story_advance / verification_evidence_add / DONE gate) does not depend on remote authority; if you are consuming the generated lattice_authority_trust.env + lattice_staging-client.env bundle, generate it in the target workspace and keep the two files together on that machine because the bundle bakes local paths. Missing live runner fields like PROJECT_ID or GATE_ACTOR_* are expected until you switch to authority enforce runner --live. Missing enforce prerequisites are readiness warnings, not global blockers.';

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.format === 'json' || args?.json === true;
}

/**
 * Read presence-only env var indicators for enforce-runner prerequisites.
 *
 * These are pure diagnostics: the CLI never claims, generates, signs, or
 * verifies anything based on these env vars under PD-1 / PD-2. Their presence
 * just lets users sanity-check their env wiring; their absence becomes a
 * readiness warning when authority mode is shadow / enforce.
 *
 * No new behavior is gated on these env vars and they do NOT promote
 * productionDone / receiptVerified / canClaimProductionDone away from `false`.
 */
function readEnforceEnv(env: Record<string, string | undefined>): {
  actorKeyConfigured: boolean;
  runnerConfigured: boolean;
  sessionConfigured: boolean;
} {
  const present = (key: string): boolean => typeof envValue(env, key) === 'string';
  return {
    actorKeyConfigured:
      present('ACTOR_KEY') || present('ACTOR_KEY_PATH'),
    runnerConfigured: present('RUNNER_ID'),
    sessionConfigured: present('SESSION_ID'),
  };
}

function envValue(env: Record<string, string | undefined>, suffix: string): string | undefined {
  const canonical = env[`LATTICE_AUTHORITY_${suffix}`];
  if (typeof canonical === 'string' && canonical.trim().length > 0) return canonical.trim();
  return undefined;
}

interface AuthorityReadiness {
  /** Always true: local story / phase / DONE gates do not consume server receipts. */
  localWorkflowUsable: true;
  /** Top-level mode alias, matching `authorityMode`. */
  mode: AuthoritySettings['mode'];
  authorityUrlConfigured: boolean;
  actorKeyConfigured: boolean;
  runnerConfigured: boolean;
  sessionConfigured: boolean;
  /**
   * Actionable warnings when shadow / enforce is configured but prerequisites
   * are missing. Empty in `off` mode (user opted out of authority altogether).
   */
  readinessWarnings: string[];
  /** Suggested commands / env to address each readiness warning. */
  nextActions: string[];
}

interface AuthorityStatusArgs extends FormatArgs {
  authorityMode?: string;
  authorityURL?: string;
  authorityTimeoutMS?: number;
  storyId?: string;
  targetPhase?: AuthorityGatePhase | string;
  phase?: AuthorityGatePhase | string;
  headHash?: string;
  materialHash?: string;
  policyMode?: string;
  now?: string;
}

interface AuthorityStatusRuntime extends AuthorityConfigLoadOptions {
  root?: string;
  store?: HandlerContext['store'];
}

interface AuthorityReceiptStatus {
  storyId?: string;
  targetPhase?: AuthorityGatePhase;
  headHash?: string;
  materialHash?: string;
  policyMode?: string;
  latestReceiptId?: string;
  latestDecisionDigest?: string;
  statusReceiptId?: string;
  statusDecisionDigest?: string;
  receiptVerified: boolean;
  receiptEligible: boolean;
  receiptConsumed: boolean;
  eligibilityReason?: string;
  contextAvailable: boolean;
}

function buildAuthorityReadiness(
  settings: AuthoritySettings,
  env: Record<string, string | undefined>,
  resolved: {
    authorityUrlConfigured?: boolean;
    actorKeyConfigured?: boolean;
    customerApiKeyConfigured?: boolean;
    runnerConfigured?: boolean;
    sessionConfigured?: boolean;
  } = {},
): AuthorityReadiness {
  const enforce = readEnforceEnv(env);
  const authorityUrlConfigured =
    resolved.authorityUrlConfigured ??
    (typeof settings.baseURL === 'string' && settings.baseURL.length > 0);
  const actorKeyConfigured = resolved.actorKeyConfigured ?? enforce.actorKeyConfigured;
  const customerApiKeyConfigured = resolved.customerApiKeyConfigured === true;
  const runnerConfigured = resolved.runnerConfigured ?? enforce.runnerConfigured;
  const sessionConfigured = resolved.sessionConfigured ?? enforce.sessionConfigured;
  const warnings: string[] = [];
  const actions: string[] = [];

  if (settings.mode === 'shadow') {
    if (!authorityUrlConfigured) {
      warnings.push(
        'shadow mode set but LATTICE_AUTHORITY_URL is empty; observational POSTs will be skipped',
      );
      actions.push('export LATTICE_AUTHORITY_URL=https://<authority-host>');
    }
  } else if (settings.mode === 'enforce') {
    if (!authorityUrlConfigured) {
      warnings.push(
        'enforce mode set but LATTICE_AUTHORITY_URL is empty; runner / policy discovery cannot reach the Lattice Authority server',
      );
      actions.push('export LATTICE_AUTHORITY_URL=https://<authority-host>');
    }
    if (!customerApiKeyConfigured) {
      warnings.push(
        'enforce mode set but no LATTICE_AUTHORITY_CUSTOMER_API_KEY / LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH detected; mutating Authority calls would be unauthorized',
      );
      actions.push(
        'configure a customer API key via LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH=<path>',
      );
    }
    if (!actorKeyConfigured) {
      warnings.push(
        'enforce mode set but no LATTICE_AUTHORITY_ACTOR_KEY / LATTICE_AUTHORITY_ACTOR_KEY_PATH detected; live runner submissions would be unsigned and rejected',
      );
      actions.push(
        'configure an actor private key via LATTICE_AUTHORITY_ACTOR_KEY_PATH=<path>',
      );
    }
    if (!runnerConfigured) {
      warnings.push(
        'enforce mode set but LATTICE_AUTHORITY_RUNNER_ID is empty; runner identity binding would be missing',
      );
      actions.push('export LATTICE_AUTHORITY_RUNNER_ID=<runner-id>');
    }
  }

  return {
    localWorkflowUsable: true,
    mode: settings.mode,
    authorityUrlConfigured,
    actorKeyConfigured,
    runnerConfigured,
    sessionConfigured,
    readinessWarnings: warnings,
    nextActions: actions,
  };
}

function latestReceiptRef(document: AuthorityReceiptRefDocument | null | undefined): AuthorityGateDecisionReceiptRef | undefined {
  const refs = document?.refs ?? [];
  if (refs.length === 0) return undefined;
  return [...refs].sort((left, right) => {
    const leftTime = Date.parse(left.verifiedAt ?? '');
    const rightTime = Date.parse(right.verifiedAt ?? '');
    const normalizedLeft = Number.isFinite(leftTime) ? leftTime : 0;
    const normalizedRight = Number.isFinite(rightTime) ? rightTime : 0;
    return normalizedRight - normalizedLeft;
  })[0];
}

function isVerifiedProductionGateReceipt(ref: AuthorityGateDecisionReceiptRef | undefined): ref is AuthorityGateDecisionReceiptRef {
  return ref?.classification === 'production-gate-decision'
    && ref.receiptKind === 'gate_decision'
    && ref.status !== 'stale'
    && ref.status !== 'revoked'
    && ref.status !== 'superseded';
}

function latestVerifiedProductionReceiptRef(document: AuthorityReceiptRefDocument | null | undefined): AuthorityGateDecisionReceiptRef | undefined {
  const refs = document?.refs ?? [];
  return latestReceiptRef({
    schemaVersion: 'lattice.authority_receipt_refs.v1',
    storyId: document?.storyId ?? '',
    updatedAt: document?.updatedAt ?? '',
    refs: refs.filter(isVerifiedProductionGateReceipt),
  });
}

function matchingConsumption(
  ref: AuthorityGateDecisionReceiptRef | undefined,
  args: { storyId?: string; targetPhase?: AuthorityGatePhase; headHash?: string; materialHash?: string },
): boolean {
  if (!ref || !args.storyId || !args.targetPhase || !args.headHash || !args.materialHash || !ref.decisionDigest) return false;
  return (ref.consumptionEvents ?? []).some((event) => (
    event.storyId === args.storyId
    && event.targetPhase === args.targetPhase
    && event.headHash === args.headHash
    && event.materialHash === args.materialHash
    && event.decisionDigest === ref.decisionDigest
  ));
}

function resolveStatusPolicyMode(
  args: AuthorityStatusArgs,
  runtime: AuthorityStatusRuntime | undefined,
  storyId: string | undefined,
): string | undefined {
  if (args.policyMode) return args.policyMode;
  if (!runtime?.root || !runtime.store || !storyId) return undefined;
  try {
    return resolveWorkflowPolicy(loadConfig(runtime.root), runtime.store.readStory(storyId)).profile;
  } catch {
    return undefined;
  }
}

function buildAuthorityReceiptStatus(
  args: AuthorityStatusArgs,
  runtime?: AuthorityStatusRuntime,
): AuthorityReceiptStatus {
  const storyId = args.storyId?.trim() || undefined;
  const targetPhase = normalizeAuthorityGatePhase(args.targetPhase ?? args.phase);
  const headHash = args.headHash ?? (runtime?.root ? currentGitHead(runtime.root) : undefined);
  const materialHash = args.materialHash ?? (runtime?.root ? currentMaterialHash(runtime.root) : undefined);
  const policyMode = resolveStatusPolicyMode(args, runtime, storyId);
  const document = storyId && runtime?.store ? runtime.store.readAuthorityReceiptRefs(storyId) : undefined;
  const latest = latestReceiptRef(document);
  const contextAvailable = Boolean(storyId && targetPhase && headHash && materialHash);
  let eligibleRef: AuthorityGateDecisionReceiptRef | undefined;
  let receiptEligible = false;
  let eligibilityReason: string | undefined;
  if (contextAvailable) {
    const eligibility = eligibleAuthorityGateReceiptDocument(document ?? undefined, {
      storyId: storyId!,
      targetPhase: targetPhase!,
      headHash: headHash!,
      materialHash: materialHash!,
      now: args.now ?? new Date().toISOString(),
      maxVerifiedAgeMs: DEFAULT_AUTHORITY_RECEIPT_MAX_VERIFIED_AGE_MS,
      acceptablePolicyModes: policyMode ? [policyMode] : undefined,
      acceptableAuthorityModes: ['enforce'],
    });
    receiptEligible = eligibility.eligible;
    eligibilityReason = eligibility.reason;
    if (eligibility.eligible) eligibleRef = eligibility.ref;
  }
  const verifiedRef = eligibleRef ?? latestVerifiedProductionReceiptRef(document);
  const statusRef = eligibleRef ?? verifiedRef ?? latest;
  const receiptVerified = Boolean(verifiedRef);
  if (!contextAvailable && !receiptVerified) {
    eligibilityReason = 'authority_receipt_missing';
  }
  return {
    storyId,
    targetPhase,
    headHash,
    materialHash,
    policyMode,
    latestReceiptId: latest?.receiptId,
    latestDecisionDigest: latest?.decisionDigest,
    statusReceiptId: statusRef?.receiptId,
    statusDecisionDigest: statusRef?.decisionDigest,
    receiptVerified,
    receiptEligible,
    receiptConsumed: matchingConsumption(statusRef, { storyId, targetPhase, headHash, materialHash }),
    eligibilityReason,
    contextAvailable,
  };
}

function readPackageVersion(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function packageBinHasLattice(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { bin?: Record<string, unknown> };
    return parsed.bin?.lattice === 'dist/cli.js' && parsed.bin?.koala === undefined;
  } catch {
    return false;
  }
}

/**
 * B-526c wrapper-root diagnostics (CHK-001).
 *
 * When the metadata root itself is not git-backed and no explicit `gitRoot`
 * is configured, story_resolve / review_run_start cannot resolve a git-backed
 * signed workspace. This diagnostic deterministically classifies the layout by
 * inspecting ONLY immediate child directories for git repository roots:
 *
 *  - `not-applicable` — metadata root is git-backed or gitRoot is configured.
 *  - `none`           — no immediate child git repository was found.
 *  - `single-candidate` — exactly one candidate; an operator-facing repair
 *                         suggestion is printed. This is a suggestion only and
 *                         is NEVER consumed by runtime resolution.
 *  - `ambiguous`      — multiple candidates; fail-closed, no target is chosen.
 */
type WrapperGitRootStatus = 'not-applicable' | 'none' | 'single-candidate' | 'ambiguous';

interface WrapperGitRootDiagnostics {
  metadataRoot: string;
  metadataRootGitBacked: boolean;
  configuredGitRoot: string | null;
  status: WrapperGitRootStatus;
  candidates: string[];
  suggestedGitRoot: string | null;
  repairCommand: string | null;
  note: string;
}

function canonicalFsPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

function isGitRepositoryRoot(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  const probe = gitProbe('git rev-parse --show-toplevel', { cwd: candidate });
  if (!probe.ok) return false;
  return canonicalFsPath(probe.output) === canonicalFsPath(candidate);
}

function listImmediateChildGitRoots(metadataRoot: string): string[] {
  let entries;
  try {
    entries = readdirSync(metadataRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const candidate = join(metadataRoot, entry.name);
    // Cheap pre-filter: a repo root has a .git directory (or worktree .git file).
    if (!existsSync(join(candidate, '.git'))) continue;
    if (!isGitRepositoryRoot(candidate)) continue;
    names.push(entry.name);
  }
  return names.sort();
}

function configRepairCommandFor(gitRoot: string): string {
  return `lattice config repair --set-git-root=${gitRoot} --confirm`;
}

function buildWrapperGitRootDiagnostics(metadataRoot: string): WrapperGitRootDiagnostics {
  const config = loadConfig(metadataRoot);
  const configuredGitRoot =
    typeof config.gitRoot === 'string' && config.gitRoot.trim().length > 0 ? config.gitRoot.trim() : null;
  const metadataRootGitBacked = gitProbe('git rev-parse --show-toplevel', { cwd: metadataRoot }).ok;
  const base = {
    metadataRoot: canonicalFsPath(metadataRoot),
    metadataRootGitBacked,
    configuredGitRoot,
  };
  if (metadataRootGitBacked || configuredGitRoot) {
    return {
      ...base,
      status: 'not-applicable',
      candidates: [],
      suggestedGitRoot: null,
      repairCommand: null,
      note: configuredGitRoot
        ? `gitRoot is explicitly configured (${configuredGitRoot}); no wrapper-root repair is suggested.`
        : 'metadataRoot is git-backed; no wrapper-root repair is needed.',
    };
  }
  const candidates = listImmediateChildGitRoots(metadataRoot);
  if (candidates.length === 0) {
    return {
      ...base,
      status: 'none',
      candidates,
      suggestedGitRoot: null,
      repairCommand: null,
      note: 'metadataRoot is not git-backed, no gitRoot is configured, and no immediate child git repository was found. If the material root lives elsewhere, configure gitRoot explicitly.',
    };
  }
  if (candidates.length === 1) {
    return {
      ...base,
      status: 'single-candidate',
      candidates,
      suggestedGitRoot: candidates[0],
      repairCommand: configRepairCommandFor(candidates[0]),
      note: 'Operator suggestion only: Lattice never applies this repair automatically and runtime resolution never guesses child repositories. Run the repair command to configure gitRoot explicitly.',
    };
  }
  return {
    ...base,
    status: 'ambiguous',
    candidates,
    suggestedGitRoot: null,
    repairCommand: null,
    note: 'Multiple immediate child git repositories were found; ambiguous layouts stay fail-closed and no repair target is chosen. Pick one explicitly: lattice config repair --set-git-root=<dir> --confirm.',
  };
}

function buildConfigDoctor(ctx: HandlerContext) {
  const rootPackagePath = join(ctx.root, 'package.json');
  const mainPackagePath = join(ctx.root, 'packages', 'main', 'package.json');
  const versions = {
    root: readPackageVersion(rootPackagePath),
    main: readPackageVersion(mainPackagePath),
    expected: LATTICE_CLI_VERSION,
  };
  const checks = [
    {
      id: 'root-package-version',
      ok: versions.root === LATTICE_CLI_VERSION,
      detail: `root package version=${versions.root ?? 'unreadable'}`,
    },
    {
      id: 'main-package-version',
      ok: versions.main === LATTICE_CLI_VERSION,
      detail: `packages/main version=${versions.main ?? 'unreadable'}`,
    },
    {
      id: 'lattice-local-wrapper',
      ok: existsSync(join(ctx.root, 'bin', 'lattice.js')),
      detail: 'bin/lattice.js exists as the primary local bootstrap wrapper',
    },
    {
      id: 'no-koala-local-wrapper',
      ok: !existsSync(join(ctx.root, 'bin', 'koala.js')),
      detail: 'legacy local wrapper is absent; lattice is the only active local bootstrap wrapper',
    },
    {
      id: 'package-bin-aliases',
      ok: packageBinHasLattice(mainPackagePath),
      detail: 'packages/main package.json exposes only the lattice bin',
    },
  ];
  const ok = checks.every(check => check.ok);
  return {
    schemaVersion: 'lattice.config_doctor.v1' as const,
    product: { name: LATTICE_PRODUCT_NAME, version: LATTICE_CLI_VERSION },
    ok,
    status: ok ? 'pass' as const : 'warn' as const,
    migration: {
      cliFirst: true as const,
      macAppRequired: false as const,
      macAppRole: 'optional-dashboard-archive' as const,
      legacyKoalaAliasPreserved: false as const,
    },
    versions,
    checks,
    wrapperGitRoot: buildWrapperGitRootDiagnostics(ctx.root),
    authority: {
      productionDone: false as const,
      receiptVerified: false as const,
      note: AUTHORITY_DISCLAIMER,
    },
  };
}

function renderConfigDoctorText(result: ReturnType<typeof buildConfigDoctor>): string {
  return [
    `${formatLatticeProductLine()} config doctor (${result.schemaVersion})`,
    `status: ${result.status}`,
    `migration: cliFirst=${result.migration.cliFirst}; macAppRequired=${result.migration.macAppRequired}; macAppRole=${result.migration.macAppRole}; activeCommand=lattice`,
    `versions: root=${result.versions.root ?? 'unreadable'}; main=${result.versions.main ?? 'unreadable'}; expected=${result.versions.expected}`,
    `authority: productionDone=${result.authority.productionDone}; receiptVerified=${result.authority.receiptVerified}`,
    '',
    'checks:',
    ...result.checks.map(check => `  - ${check.id}: ${check.ok ? 'pass' : 'warn'} — ${check.detail}`),
    '',
    ...renderWrapperGitRootDiagnosticsText(result.wrapperGitRoot),
    '',
    result.authority.note,
  ].join('\n');
}

function renderWrapperGitRootDiagnosticsText(wrapperGitRoot: WrapperGitRootDiagnostics): string[] {
  const lines = [
    'wrapperGitRoot:',
    `  metadataRoot: ${wrapperGitRoot.metadataRoot}`,
    `  metadataRootGitBacked: ${wrapperGitRoot.metadataRootGitBacked}`,
    `  configuredGitRoot: ${wrapperGitRoot.configuredGitRoot ?? 'none'}`,
    `  status: ${wrapperGitRoot.status}`,
  ];
  if (wrapperGitRoot.candidates.length > 0) {
    lines.push(`  candidates: ${wrapperGitRoot.candidates.join(', ')}`);
  }
  if (wrapperGitRoot.suggestedGitRoot) {
    lines.push(`  suggestedGitRoot: ${wrapperGitRoot.suggestedGitRoot}`);
  }
  if (wrapperGitRoot.repairCommand) {
    lines.push(`  repairCommand: ${wrapperGitRoot.repairCommand}`);
  }
  lines.push(`  note: ${wrapperGitRoot.note}`);
  return lines;
}

/**
 * B-526c explicit confirmed gitRoot repair (CHK-002).
 *
 * Deterministic operator-confirmed repair for wrapper-root layouts:
 *  - requires an explicit --set-git-root value (never guesses a target);
 *  - requires --confirm before any write; without it the command is a
 *    non-mutating preview that prints the exact confirm command;
 *  - validates the target is a relative path that stays strictly under the
 *    metadata root and is itself a git repository root;
 *  - writes ONLY the `gitRoot` field of the existing lattice.config.json file;
 *  - reports whether the configured git root verifies after the write. It
 *    does not claim story resolution; check story_resolve separately.
 */
interface ConfigRepairArgs extends FormatArgs {
  setGitRoot?: string;
  confirm?: boolean;
}

interface ValidatedRepairGitRootTarget {
  absolutePath: string;
  relativePath: string;
}

function normalizeConfigRelativePath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function validateRepairGitRootTarget(metadataRoot: string, requested: string): ValidatedRepairGitRootTarget {
  if (isAbsolute(requested)) {
    throw new Error(
      `--set-git-root must be a relative path under the metadata root (${metadataRoot}); got an absolute path: ${requested}`,
    );
  }
  // Lexical containment first: reject ../escapes before any existence check,
  // without realpath so a /var metadata root (realpath /private/var) does not
  // make a missing-but-contained target look like an escape.
  const lexicalRoot = resolvePath(metadataRoot);
  const lexicalCandidate = resolvePath(metadataRoot, requested);
  const lexicalRel = relative(lexicalRoot, lexicalCandidate);
  if (lexicalRel === '' || lexicalRel.startsWith('..') || isAbsolute(lexicalRel)) {
    throw new Error(
      `--set-git-root must stay strictly under the metadata root (${metadataRoot}); rejected unsafe path: ${requested}`,
    );
  }
  if (!existsSync(lexicalCandidate)) {
    throw new Error(`--set-git-root target does not exist: ${lexicalCandidate}`);
  }
  // Canonical containment second: the target exists, so realpath both sides to
  // catch symlink escapes out of the metadata root.
  const canonicalMetadataRoot = canonicalFsPath(metadataRoot);
  const candidate = canonicalFsPath(lexicalCandidate);
  const rel = relative(canonicalMetadataRoot, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `--set-git-root must stay strictly under the metadata root (${metadataRoot}); rejected unsafe path: ${requested}`,
    );
  }
  const probe = gitProbe('git rev-parse --show-toplevel', { cwd: candidate });
  if (!probe.ok) {
    throw new Error(`--set-git-root target is not a git repository: ${candidate}`);
  }
  if (canonicalFsPath(probe.output) !== candidate) {
    throw new Error(
      `--set-git-root target is not a git repository root (its git top-level is ${probe.output}): ${candidate}`,
    );
  }
  return {
    absolutePath: candidate,
    relativePath: normalizeConfigRelativePath(rel),
  };
}

function buildConfigRepair(ctx: HandlerContext, args: ConfigRepairArgs) {
  const metadataRoot = ctx.root;
  const requested = typeof args.setGitRoot === 'string' ? args.setGitRoot.trim() : '';
  if (requested.length === 0) {
    throw new Error(
      'lattice_config_repair requires an explicit --set-git-root=<relative-dir>; it never guesses a repair target. Run `lattice config doctor` first to see wrapper-root candidates.',
    );
  }
  const verifiedTarget = validateRepairGitRootTarget(metadataRoot, requested);
  const picked = pickProjectConfigPath(metadataRoot);
  if (!picked) {
    throw new Error(
      `Cannot repair gitRoot because no existing ${LATTICE_CONFIG_FILENAME} was found at ${metadataRoot}. Initialize project config first.`,
    );
  }
  const configPath = picked.path;
  const configFilename = picked.filename;
  const base = {
    schemaVersion: 'lattice.config_repair.v1' as const,
    product: { name: LATTICE_PRODUCT_NAME, version: LATTICE_CLI_VERSION },
    metadataRoot: canonicalFsPath(metadataRoot),
    gitRoot: verifiedTarget.relativePath,
    verifiedGitRootPath: verifiedTarget.absolutePath,
    configPath,
    configFilename,
  };

  if (args.confirm !== true) {
    return {
      ...base,
      mutated: false as const,
      status: 'preview' as const,
      write: 'preview-only' as const,
      verification: 'configured-git-root verified' as const,
      gitRootVerified: true,
      confirmCommand: configRepairCommandFor(verifiedTarget.relativePath),
      note: `No changes were written (missing --confirm). The target validates as a git repository root. To write gitRoot=${verifiedTarget.relativePath} into ${configFilename}, run: ${configRepairCommandFor(verifiedTarget.relativePath)}`,
    };
  }

  let existing: Record<string, unknown> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(picked.path, 'utf-8'));
  } catch {
    throw new Error(`Cannot repair ${picked.path}: existing config is not valid JSON; fix it manually first.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Cannot repair ${picked.path}: existing config is not a JSON object; fix it manually first.`);
  }
  existing = parsed as Record<string, unknown>;

  writeFileSync(configPath, `${JSON.stringify({ ...existing, gitRoot: verifiedTarget.relativePath }, null, 2)}\n`);
  resetConfigCache();
  const reloaded = loadConfig(metadataRoot);
  const gitRootWritten = reloaded.gitRoot === verifiedTarget.relativePath;
  const gitRootVerified = gitRootWritten && isGitRepositoryRoot(verifiedTarget.absolutePath);
  return {
    ...base,
    mutated: true as const,
    status: gitRootVerified ? ('repaired' as const) : ('repair-unverified' as const),
    write: `updated ${configFilename}`,
    verification: gitRootVerified ? ('configured-git-root verified' as const) : ('configured-git-root unverified' as const),
    gitRootWritten,
    gitRootVerified,
    note: gitRootVerified
      ? `gitRoot=${verifiedTarget.relativePath} was written to ${configFilename} and verifies as a git repository root. Story resolution is not claimed here; check with: lattice story_resolve '{"storyId":"B-xxx"}'`
      : `gitRoot=${verifiedTarget.relativePath} was written to ${configFilename} but did not verify after reload; inspect ${configPath} manually.`,
  };
}

function renderConfigRepairText(result: ReturnType<typeof buildConfigRepair>): string {
  const lines = [
    `${formatLatticeProductLine()} config repair (${result.schemaVersion})`,
    `status: ${result.status}`,
    `mutated: ${result.mutated}`,
    `metadataRoot: ${result.metadataRoot}`,
    `gitRoot: ${result.gitRoot}`,
    `write: ${result.write}`,
    `verification: ${result.verification}`,
    `configPath: ${result.configPath}`,
    `gitRootVerified: ${result.gitRootVerified}`,
  ];
  if (!result.mutated && 'confirmCommand' in result) {
    lines.push(`confirmCommand: ${result.confirmCommand}`);
  }
  lines.push('', result.note);
  return lines.join('\n');
}

export function buildAuthorityStatus(
  args: AuthorityStatusArgs = {},
  env: Record<string, string | undefined> = process.env,
  runtime: AuthorityStatusRuntime = {},
) {
  // Full config (authority.md + localhost default + production-inert verdict).
  // Readiness is based on the same resolved config that live authority execution
  // uses, so authority.md/default URL behavior does not drift from runner behavior.
  const config = loadAuthorityConfig(env, args, runtime);
  const customerKey = config.mode === 'off'
    ? { source: 'none' as const }
    : resolveAuthorityCustomerApiKey(env, runtime);
  const actorKeyConfigured =
    readEnforceEnv(env).actorKeyConfigured ||
    typeof config.keyMaterial.actorKey === 'string' ||
    typeof config.keyMaterial.actorKeyPath === 'string';
  const readiness = buildAuthorityReadiness(config, env, {
    authorityUrlConfigured: typeof config.baseURL === 'string' && config.baseURL.length > 0,
    actorKeyConfigured,
    customerApiKeyConfigured: typeof customerKey.value === 'string' && customerKey.value.length > 0,
    runnerConfigured: typeof config.runnerId === 'string' && config.runnerId.length > 0,
    sessionConfigured: typeof config.sessionId === 'string' && config.sessionId.length > 0,
  });
  const baseURLConfigured = readiness.authorityUrlConfigured;
  const receiptStatus = buildAuthorityReceiptStatus(args, runtime);
  const authorityReady = config.mode !== 'off'
    && baseURLConfigured
    && readiness.readinessWarnings.length === 0;
  return {
    schemaVersion: 'lattice.authority_status.v1' as const,
    product: { name: LATTICE_PRODUCT_NAME, version: LATTICE_CLI_VERSION },
    authorityMode: config.mode,
    /** Alias of `authorityMode`; convenience for `mode:"off"` JSON consumers. */
    mode: readiness.mode,
    baseURLConfigured,
    baseURL: config.baseURL ?? null,
    timeoutMS: config.timeoutMS,
    // Resolved-config diagnostics (precedence + production-inert flag/reason):
    resolvedBaseURL: config.baseURL ?? null,
    urlSource: config.urlSource,
    defaultUrlApplied: config.defaultUrlApplied,
    authorityMdLoaded: config.authorityMdLoaded,
    authorityTrustEnvLoaded: config.authorityTrustEnvLoaded,
    testKeyProfile: config.keyMaterial.testKeyProfile ?? null,
    /** True when default / local-test material makes this config production-inert. */
    productionInert: config.productionInert,
    productionInertReasons: config.productionInertReasons,
    serverReachability: 'not-probed' as const,
    authorityReady,
    receiptVerified: receiptStatus.receiptVerified,
    receiptEligible: receiptStatus.receiptEligible,
    receiptConsumed: receiptStatus.receiptConsumed,
    productionDone: false as const,
    canClaimProductionDone: false as const,
    status: receiptStatus.receiptConsumed
      ? 'receipt-consumed-no-production-claim' as const
      : receiptStatus.receiptEligible
        ? 'verified-receipt-eligible' as const
        : receiptStatus.receiptVerified
          ? 'verified-receipt-not-eligible' as const
          : baseURLConfigured
            ? 'configured-no-verified-receipt' as const
            : 'not-configured' as const,
    receiptStatus,
    // Readiness diagnostics (B-b710 / Milestones 3-4):
    //   - localWorkflowUsable is always true; local lifecycle gates do not consume
    //     server receipts (PD-1 / PD-2 thin-client client role).
    //   - readinessWarnings / nextActions are surfaced when shadow / enforce is
    //     configured but prerequisites are missing — they are NOT global blockers
    //     and the local CLI workflow keeps working.
    localWorkflowUsable: readiness.localWorkflowUsable,
    authorityUrlConfigured: readiness.authorityUrlConfigured,
    customerApiKeyConfigured: typeof customerKey.value === 'string' && customerKey.value.length > 0,
    customerApiKeySource: customerKey.source === 'none' ? 'missing' as const : customerKey.source,
    customerApiKeyValid: 'unknown' as const,
    actorKeyConfigured,
    actorKeyRegistered: 'unknown' as const,
    serverPublicKeyPinned: typeof config.keyMaterial.serverPublicKey === 'string' && config.keyMaterial.serverPublicKey.length > 0,
    runnerConfigured: readiness.runnerConfigured,
    sessionConfigured: readiness.sessionConfigured,
    productionAuthorityUsable: false as const,
    readinessWarnings: readiness.readinessWarnings,
    nextActions: readiness.nextActions,
    localWorkflowNote: LOCAL_WORKFLOW_NOTE,
    note: AUTHORITY_DISCLAIMER,
  };
}

function renderAuthorityStatusText(result: ReturnType<typeof buildAuthorityStatus>): string {
  const lines = [
    `${formatLatticeProductLine()} authority status (${result.schemaVersion})`,
    `status: ${result.status}`,
    `mode: ${result.mode}`,
    `authorityMode: ${result.authorityMode}`,
    `localWorkflowUsable: ${result.localWorkflowUsable}`,
    `authorityUrlConfigured: ${result.authorityUrlConfigured}`,
    `customerApiKeyConfigured: ${result.customerApiKeyConfigured}`,
    `customerApiKeySource: ${result.customerApiKeySource}`,
    `customerApiKeyValid: ${result.customerApiKeyValid}`,
    `actorKeyConfigured: ${result.actorKeyConfigured}`,
    `actorKeyRegistered: ${result.actorKeyRegistered}`,
    `serverPublicKeyPinned: ${result.serverPublicKeyPinned}`,
    `runnerConfigured: ${result.runnerConfigured}`,
    `serverReachability: ${result.serverReachability}`,
    `authorityReady: ${result.authorityReady}`,
    `receiptVerified: ${result.receiptVerified}`,
    `receiptEligible: ${result.receiptEligible}`,
    `receiptConsumed: ${result.receiptConsumed}`,
    `productionDone: ${result.productionDone}`,
    `canClaimProductionDone: ${result.canClaimProductionDone}`,
    `urlSource: ${result.urlSource}${result.defaultUrlApplied ? ` (${result.resolvedBaseURL})` : ''}`,
    `productionInert: ${result.productionInert}${result.productionInert ? ` (${result.productionInertReasons.join(', ')})` : ''}`,
  ];
  if (result.receiptStatus.storyId || result.receiptStatus.latestReceiptId) {
    lines.push(
      `receiptStoryId: ${result.receiptStatus.storyId ?? '(none)'}`,
      `receiptTargetPhase: ${result.receiptStatus.targetPhase ?? '(none)'}`,
      `latestReceiptId: ${result.receiptStatus.latestReceiptId ?? '(none)'}`,
      `latestDecisionDigest: ${result.receiptStatus.latestDecisionDigest ?? '(none)'}`,
      `statusReceiptId: ${result.receiptStatus.statusReceiptId ?? '(none)'}`,
      `statusDecisionDigest: ${result.receiptStatus.statusDecisionDigest ?? '(none)'}`,
      `receiptEligibilityReason: ${result.receiptStatus.eligibilityReason ?? '(none)'}`,
    );
  }
  if (result.readinessWarnings.length > 0) {
    lines.push('', 'readinessWarnings:');
    for (const w of result.readinessWarnings) lines.push(`  - ${w}`);
  }
  if (result.nextActions.length > 0) {
    lines.push('', 'nextActions:');
    for (const a of result.nextActions) lines.push(`  - ${a}`);
  }
  lines.push('', result.localWorkflowNote);
  lines.push('', result.note);
  return lines.join('\n');
}

export function writeAuthorityTrustProfileBundle(
  outputDir: string,
  bundle: AuthorityTrustProfileBundle,
): { trustFilePath: string; clientFilePath: string } {
  const resolvedOutputDir = resolvePath(outputDir);
  mkdirSync(resolvedOutputDir, { recursive: true });
  const trustFilePath = join(resolvedOutputDir, bundle.trustFileName);
  const clientFilePath = join(resolvedOutputDir, bundle.clientFileName);
  writeFileSync(trustFilePath, bundle.trustFileText);
  writeFileSync(clientFilePath, bundle.clientFileText);
  return { trustFilePath, clientFilePath };
}

export function buildAuthorityEnforceRunnerPlan(
  args: { once?: boolean; dryRun?: boolean; live?: boolean; authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {},
  env: Record<string, string | undefined> = process.env,
  options: AuthorityConfigLoadOptions = {},
): AuthorityRunnerPlan {
  const settings = loadAuthorityConfig(env, { ...args, authorityMode: args.authorityMode ?? 'enforce' }, options);
  const customerKey = resolveAuthorityCustomerApiKey(env, options);
  const actorKeyConfigured =
    readEnforceEnv(env).actorKeyConfigured ||
    typeof settings.keyMaterial.actorKey === 'string' ||
    typeof settings.keyMaterial.actorKeyPath === 'string';
  const readiness = buildAuthorityReadiness({ ...settings, mode: 'enforce' }, env, {
    authorityUrlConfigured: typeof settings.baseURL === 'string' && settings.baseURL.length > 0,
    actorKeyConfigured,
    customerApiKeyConfigured: typeof customerKey.value === 'string' && customerKey.value.length > 0,
    runnerConfigured: typeof settings.runnerId === 'string' && settings.runnerId.length > 0,
    sessionConfigured: typeof settings.sessionId === 'string' && settings.sessionId.length > 0,
  });
  const missing = [...readiness.readinessWarnings];
  const actions = [...readiness.nextActions];
  if (args.live === true && !settings.projectId) {
    missing.push(
      'live enforce runner requires LATTICE_AUTHORITY_PROJECT_ID so runner registration is bound to a project',
    );
    actions.push('export LATTICE_AUTHORITY_PROJECT_ID=<project-id>');
  }
  return {
    schemaVersion: 'lattice.authority_enforce_runner.v1',
    mode: 'enforce',
    once: args.once !== false,
    dryRun: args.dryRun === true,
    live: args.live === true,
    plannedSteps: [...AUTHORITY_RUNNER_PLANNED_STEPS],
    spawned: false,
    providerEvents: [],
    localWorkflowUsable: true,
    status: missing.length === 0 ? 'pass' : 'fail',
    readinessWarnings: missing,
    nextActions: actions,
    note: args.dryRun === true
      ? 'Dry-run only: planned runner register/heartbeat/claim steps; no network mutation and no provider execution.'
      : args.live === true
        ? 'Live control-plane smoke: register runner, heartbeat, claim at most one job, and release it without provider execution.'
        : 'Runner execution stays local unless --live is provided; no provider execution occurs in this command.',
  };
}

function readLiveRunnerOptions(
  settings: AuthorityConfig,
  args: { once?: boolean },
  env: Record<string, string | undefined>,
  options: AuthorityConfigLoadOptions = {},
) {
  const actorKeyPath = envValue(env, 'ACTOR_KEY_PATH');
  const actorPrivateKey = envValue(env, 'ACTOR_KEY') ??
    (actorKeyPath ? readActorPrivateKeyFromPath(resolvePath(options.cwd ?? process.cwd(), actorKeyPath)) : undefined) ??
    settings.keyMaterial.actorKey ??
    (settings.keyMaterial.actorKeyPath ? readActorPrivateKeyFromPath(resolvePath(options.cwd ?? process.cwd(), settings.keyMaterial.actorKeyPath)) : undefined);
  if (!settings.baseURL) throw new Error('LATTICE_AUTHORITY_URL is required for live runner mode');
  if (!actorPrivateKey) throw new Error('LATTICE_AUTHORITY_ACTOR_KEY or LATTICE_AUTHORITY_ACTOR_KEY_PATH is required for live runner mode');
  const runnerId = settings.runnerId;
  if (!runnerId) throw new Error('LATTICE_AUTHORITY_RUNNER_ID is required for live runner mode');
  const sessionId = settings.sessionId ?? `${runnerId}:session`;
  const projectId = settings.projectId;
  if (!projectId) throw new Error('LATTICE_AUTHORITY_PROJECT_ID is required for live runner mode');
  const keyEncoding = (envValue(env, 'ACTOR_KEY_ENCODING') ?? settings.keyMaterial.actorKeyEncoding ?? 'auto') as LatticeAuthorityKeyEncoding;
  const customerApiKey = resolveAuthorityCustomerApiKey(env, options).value;
  if (!customerApiKey) throw new Error('LATTICE_AUTHORITY_CUSTOMER_API_KEY or LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH is required for live runner mode');
  return {
    baseURL: settings.baseURL,
    timeoutMS: settings.timeoutMS,
    actorId: envValue(env, 'ACTOR_ID') ?? settings.keyMaterial.actorId ?? runnerId,
    role: envValue(env, 'ACTOR_ROLE') ?? settings.keyMaterial.actorRole ?? 'runner',
    actorKeyId: envValue(env, 'ACTOR_KEY_ID') ?? settings.keyMaterial.actorKeyId ?? 'default',
    actorPrivateKey,
    actorPrivateKeyEncoding: keyEncoding,
    runnerId,
    sessionId,
    projectId,
    customerApiKey,
    bootstrapToken: envValue(env, 'BOOTSTRAP_TOKEN'),
    once: args.once !== false,
  };
}

export async function runAuthorityEnforceRunner(
  args: { once?: boolean; dryRun?: boolean; live?: boolean; authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {},
  env: Record<string, string | undefined> = process.env,
  options: AuthorityConfigLoadOptions = {},
): Promise<AuthorityRunnerPlan> {
  const plan = buildAuthorityEnforceRunnerPlan(args, env, options);
  if (args.live !== true || args.dryRun === true) return plan;
  if (plan.status === 'fail') {
    return {
      ...plan,
      dryRun: false,
      live: true,
      note: 'Live runner was not started because required Lattice Authority configuration is missing.',
    };
  }
  const settings = loadAuthorityConfig(env, { ...args, authorityMode: args.authorityMode ?? 'enforce' }, options);
  try {
    const live = await runLatticeAuthorityControlPlaneOnce(readLiveRunnerOptions(settings, args, env, options));
    return {
      ...plan,
      dryRun: false,
      live: true,
      status: live.status,
      networkEvents: live.networkEvents,
      claimedJobId: live.claimedJobId,
      releasedJobId: live.releasedJobId,
      releaseReason: live.releaseReason,
      note: live.note,
    };
  } catch (error: any) {
    return {
      ...plan,
      dryRun: false,
      live: true,
      status: 'fail',
      networkEvents: [],
      claimedJobId: null,
      releasedJobId: null,
      readinessWarnings: [...plan.readinessWarnings, error?.message || String(error)],
      note: 'Live runner failed before the first authority request.',
    };
  }
}

function renderAuthorityEnforceRunnerText(result: AuthorityRunnerPlan): string {
  const lines = [
    `${formatLatticeProductLine()} authority enforce runner (${result.schemaVersion})`,
    `status: ${result.status}`,
    `mode: ${result.mode}`,
    `once: ${result.once}`,
    `dryRun: ${result.dryRun}`,
    `live: ${result.live === true}`,
    `spawned: ${result.spawned}`,
    `providerEvents: ${result.providerEvents.length}`,
    'plannedSteps:',
    ...result.plannedSteps.map(step => `  - ${step}`),
  ];
  if (result.readinessWarnings.length > 0) {
    lines.push('', 'readinessWarnings:', ...result.readinessWarnings.map(w => `  - ${w}`));
  }
  if (result.nextActions.length > 0) {
    lines.push('', 'nextActions:', ...result.nextActions.map(a => `  - ${a}`));
  }
  if (result.networkEvents && result.networkEvents.length > 0) {
    lines.push('', 'networkEvents:', ...result.networkEvents.map(event => `  - ${event.step}: ${event.ok ? 'pass' : 'fail'}${event.status ? ` status=${event.status}` : ''}${event.message ? ` ${event.message}` : ''}`));
  }
  lines.push('', result.note);
  return lines.join('\n');
}

export function buildAuthorityReceiptVerify(
  args: {
    receiptFile?: string;
    serverPublicKey?: string;
    serverPublicKeyEncoding?: LatticeAuthorityKeyEncoding;
    receiptKind?: string;
    receiptProjectId?: string;
    receiptStoryId?: string;
    serverKeyId?: string;
    expectedDecisionDigest?: string;
    receiptMaxAgeMs?: number;
    receiptClockSkewMs?: number;
  },
) {
  if (!args.receiptFile || !args.serverPublicKey) {
    return {
      schemaVersion: 'lattice.authority_receipt_verify.v1' as const,
      ok: false,
      status: 'fail' as const,
      verified: false,
      reason: 'receiptFile and serverPublicKey are required',
    };
  }
  try {
    const receipt = JSON.parse(readFileSync(args.receiptFile, 'utf8')) as unknown;
    const result = verifyLatticeAuthorityReceipt(receipt, {
      serverPublicKey: args.serverPublicKey,
      serverPublicKeyEncoding: args.serverPublicKeyEncoding ?? 'auto',
      expectedKind: args.receiptKind,
      expectedProjectId: args.receiptProjectId,
      expectedStoryId: args.receiptStoryId,
      expectedServerKeyId: args.serverKeyId,
      expectedDecisionDigest: args.expectedDecisionDigest,
      maxAgeMs: args.receiptMaxAgeMs ?? numericEnv(process.env.LATTICE_AUTHORITY_RECEIPT_MAX_AGE_MS, 600_000),
      clockSkewMs: args.receiptClockSkewMs ?? numericEnv(process.env.LATTICE_AUTHORITY_RECEIPT_CLOCK_SKEW_MS, 300_000),
    });
    return {
      schemaVersion: 'lattice.authority_receipt_verify.v1' as const,
      ok: result.verified,
      status: result.verified ? 'pass' as const : 'fail' as const,
      verified: result.verified,
      receiptId: result.receipt.receiptId,
      kind: result.receipt.kind,
      projectId: result.receipt.projectId,
      storyId: result.receipt.storyId ?? null,
      serverKeyId: result.receipt.serverKeyId,
      decisionDigest: result.receipt.decisionDigest ?? null,
      reason: result.reason,
    };
  } catch (error: any) {
    return {
      schemaVersion: 'lattice.authority_receipt_verify.v1' as const,
      ok: false,
      status: 'fail' as const,
      verified: false,
      reason: error?.message || String(error),
    };
  }
}

function numericEnv(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function renderAuthorityReceiptVerifyText(result: ReturnType<typeof buildAuthorityReceiptVerify>): string {
  return [
    `${formatLatticeProductLine()} authority receipt verify (${result.schemaVersion})`,
    `status: ${result.status}`,
    `verified: ${result.verified}`,
    'receiptId' in result ? `receiptId: ${result.receiptId}` : null,
    'kind' in result ? `kind: ${result.kind}` : null,
    'serverKeyId' in result ? `serverKeyId: ${result.serverKeyId}` : null,
    '',
    result.reason,
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

export function buildConduitStatus(
  env: Record<string, string | undefined> = process.env,
  options: AuthorityConfigLoadOptions = {},
) {
  const settings = loadAuthorityConfig(env, {}, options);
  const customerKey = settings.mode === 'off'
    ? { source: 'none' as const }
    : resolveAuthorityCustomerApiKey(env, options);
  const actorKeyConfigured =
    readEnforceEnv(env).actorKeyConfigured ||
    typeof settings.keyMaterial.actorKey === 'string' ||
    typeof settings.keyMaterial.actorKeyPath === 'string';
  const readiness = buildAuthorityReadiness(settings, env, {
    authorityUrlConfigured: typeof settings.baseURL === 'string' && settings.baseURL.length > 0,
    actorKeyConfigured,
    customerApiKeyConfigured: typeof customerKey.value === 'string' && customerKey.value.length > 0,
    runnerConfigured: typeof settings.runnerId === 'string' && settings.runnerId.length > 0,
    sessionConfigured: typeof settings.sessionId === 'string' && settings.sessionId.length > 0,
  });
  return {
    schemaVersion: 'lattice.conduit_status.v1' as const,
    product: { name: LATTICE_PRODUCT_NAME, version: LATTICE_CLI_VERSION },
    conduitAvailable: true as const,
    conduitRole: 'cli-diagnostics-and-handoff' as const,
    runnerProvisioned: false as const,
    modelRunnerCreated: false as const,
    productionDone: false as const,
    receiptVerified: false as const,
    authorityChanged: false as const,
    // Readiness mirror (B-b710): same diagnostic surface as authority_status so
    // dashboards / agents can read either command and get a consistent picture.
    localWorkflowUsable: readiness.localWorkflowUsable,
    mode: readiness.mode,
    authorityUrlConfigured: readiness.authorityUrlConfigured,
    actorKeyConfigured: readiness.actorKeyConfigured,
    runnerConfigured: readiness.runnerConfigured,
    sessionConfigured: readiness.sessionConfigured,
    readinessWarnings: readiness.readinessWarnings,
    nextActions: readiness.nextActions,
    localWorkflowNote: LOCAL_WORKFLOW_NOTE,
    supportedSurfaces: [
      'host_list',
      'host_probe',
      'host_status',
      'host_install',
      'lattice_config_doctor',
      'authority_status',
      'handoff_create',
      'handoff_accept',
      'handoff_resume',
      'handoff_receipt_submit',
      'handoff_worktree_create',
      'host_dispatch',
      'evidence_manifest',
      'evidence_inspect',
      'parallel_wave_create',
      'parallel_plan',
    ],
    warnings: [
      'The CLI conduit coordinates diagnostics and handoff projections only.',
      'It does not provision a new model runner, sign envelopes, verify receipts, or grant production authority.',
    ],
  };
}

function renderConduitStatusText(result: ReturnType<typeof buildConduitStatus>): string {
  const lines = [
    `${formatLatticeProductLine()} conduit status (${result.schemaVersion})`,
    `conduitAvailable: ${result.conduitAvailable}`,
    `conduitRole: ${result.conduitRole}`,
    `mode: ${result.mode}`,
    `localWorkflowUsable: ${result.localWorkflowUsable}`,
    `authorityUrlConfigured: ${result.authorityUrlConfigured}`,
    `actorKeyConfigured: ${result.actorKeyConfigured}`,
    `runnerConfigured: ${result.runnerConfigured}`,
    `runnerProvisioned: ${result.runnerProvisioned}`,
    `modelRunnerCreated: ${result.modelRunnerCreated}`,
    `productionDone: ${result.productionDone}`,
    `receiptVerified: ${result.receiptVerified}`,
    `authorityChanged: ${result.authorityChanged}`,
  ];
  if (result.readinessWarnings.length > 0) {
    lines.push('', 'readinessWarnings:');
    for (const w of result.readinessWarnings) lines.push(`  - ${w}`);
  }
  if (result.nextActions.length > 0) {
    lines.push('', 'nextActions:');
    for (const a of result.nextActions) lines.push(`  - ${a}`);
  }
  lines.push(
    '',
    'supportedSurfaces:',
    ...result.supportedSurfaces.map(surface => `  - ${surface}`),
    '',
    'warnings:',
    ...result.warnings.map(warning => `  - ${warning}`),
    '',
    result.localWorkflowNote,
  );
  return lines.join('\n');
}

function buildConduitExplain(
  env: Record<string, string | undefined> = process.env,
  options: AuthorityConfigLoadOptions = {},
) {
  return {
    ...buildConduitStatus(env, options),
    schemaVersion: 'lattice.conduit_explain.v1' as const,
    explanation: [
      'Lattice CLI 0.3.5 replaces Mac App provider/config dashboard dependencies with CLI-first diagnostics.',
      'The conduit is a coordination surface for host capability reports, config migration checks, handoff packs, evidence freshness manifests, and parallel wave plans.',
      'It is intentionally not a model runner or receipt authority. Production completion remains false until an explicit receipt-backed authority path verifies a signed receipt.',
      'Authority modes: off = default local-only workflow (no network); shadow = observational POST when LATTICE_AUTHORITY_URL is reachable; enforce = Authority job path (requires Lattice Authority server + customer API key + actor key + runner identity + project id + pinned server key; jobs execute typed plannedSteps, upload evidence, request gate_decision, and verify native receipts).',
    ],
  };
}

function renderConduitExplainText(result: ReturnType<typeof buildConduitExplain>): string {
  return [
    `${formatLatticeProductLine()} conduit explain (${result.schemaVersion})`,
    ...result.explanation,
    '',
    renderConduitStatusText({ ...result, schemaVersion: 'lattice.conduit_status.v1' }),
  ].join('\n');
}

export function createLatticeCliHandlers(ctx: HandlerContext) {
  return {
    host_list(args: FormatArgs = {}) {
      const result = buildLatticeHostList();
      return wantsJson(args) ? result : renderLatticeHostListText(result);
    },
    host_probe(args: { host: string; format?: LatticeFormat }) {
      const result = buildLatticeHostProbe(args.host);
      return wantsJson(args) ? result : renderLatticeHostProbeText(result);
    },
    host_status(args: { host: string; format?: LatticeFormat }) {
      const result = buildLatticeHostStatus(args.host);
      return wantsJson(args) ? result : renderLatticeHostStatusText(result);
    },
    host_install(args: { host: string; format?: LatticeFormat }) {
      const result = buildLatticeHostInstallGuidance(args.host);
      return wantsJson(args) ? result : renderLatticeHostInstallText(result);
    },
    lattice_config_doctor(args: FormatArgs = {}) {
      const result = buildConfigDoctor(ctx);
      return wantsJson(args) ? result : renderConfigDoctorText(result);
    },
    lattice_config_repair(args: ConfigRepairArgs = {}) {
      const result = buildConfigRepair(ctx, args);
      return wantsJson(args) ? result : renderConfigRepairText(result);
    },
    authority_status(args: AuthorityStatusArgs = {}) {
      const result = buildAuthorityStatus(args, process.env, { cwd: ctx.root, root: ctx.root, store: ctx.store });
      return wantsJson(args) ? result : renderAuthorityStatusText(result);
    },
    async authority_enforce_runner(args: { format?: LatticeFormat; json?: boolean; once?: boolean; dryRun?: boolean; live?: boolean; authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {}) {
      const result = await runAuthorityEnforceRunner(args, process.env, { cwd: ctx.root });
      return wantsJson(args) ? result : renderAuthorityEnforceRunnerText(result);
    },
    conduit_status(args: FormatArgs = {}) {
      const result = buildConduitStatus(process.env, { cwd: ctx.root });
      return wantsJson(args) ? result : renderConduitStatusText(result);
    },
    conduit_explain(args: FormatArgs = {}) {
      const result = buildConduitExplain(process.env, { cwd: ctx.root });
      return wantsJson(args) ? result : renderConduitExplainText(result);
    },
  };
}
