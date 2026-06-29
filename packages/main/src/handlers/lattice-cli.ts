import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'path';
import type { HandlerContext } from './context.js';
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
  LATTICE_CONFIG_FILENAME,
  loadConfig,
  pickProjectConfigPath,
  resetConfigCache,
} from '../core/config.js';
import { gitProbe } from '../core/git-probe.js';

type FormatArgs = { format?: LatticeFormat; json?: boolean };

const LOCAL_ASSURANCE_NOTE =
  'Local Proofbound assurance uses proof admissibility, gate-consumed local evidence, signed/offline receipt bundles, and local review quorum. Retired server Authority modes are not active CLI runtime paths.';

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.format === 'json' || args?.json === true;
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
    return parsed.bin?.lattice === 'dist/cli.js';
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
      note: 'Operator suggestion only: Proofbound never applies this repair automatically and runtime resolution never guesses child repositories. Run the repair command to configure gitRoot explicitly.',
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
    },
    versions,
    checks,
    wrapperGitRoot: buildWrapperGitRootDiagnostics(ctx.root),
    authority: {
      productionDone: false as const,
      receiptVerified: false as const,
      note: LOCAL_ASSURANCE_NOTE,
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

export function buildConduitStatus(
) {
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
    localWorkflowUsable: true as const,
    admissibilityStatus: 'local-admissible' as const,
    assuranceLevel: 'local' as const,
    evidenceScope: 'local-gate-evidence' as const,
    readinessWarnings: [] as string[],
    nextActions: ['Use story lifecycle commands, proof admissibility checks, receipt-bundle validation, and quorum_submit for local assurance.'],
    localWorkflowNote: LOCAL_ASSURANCE_NOTE,
    supportedSurfaces: [
      'host_list',
      'host_probe',
      'host_status',
      'host_install',
      'lattice_config_doctor',
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
    `localWorkflowUsable: ${result.localWorkflowUsable}`,
    `admissibilityStatus: ${result.admissibilityStatus}`,
    `assuranceLevel: ${result.assuranceLevel}`,
    `evidenceScope: ${result.evidenceScope}`,
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

function buildConduitExplain() {
  return {
    ...buildConduitStatus(),
    schemaVersion: 'lattice.conduit_explain.v1' as const,
    explanation: [
      'Proofbound CLI 0.3.6 replaces Mac App provider/config dashboard dependencies with CLI-first diagnostics.',
      'The conduit is a coordination surface for host capability reports, config migration checks, handoff packs, evidence freshness manifests, and parallel wave plans.',
      'It is intentionally not a model runner or receipt authority. Completion assurance is local: proof admissibility, signed/offline receipt bundles, and local review quorum remain the supported paths.',
      'Retired server Authority modes are no longer active Proofbound CLI runtime concepts. Use local Proofbound workflow commands and local assurance artifacts instead.',
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
    conduit_status(args: FormatArgs = {}) {
      const result = buildConduitStatus();
      return wantsJson(args) ? result : renderConduitStatusText(result);
    },
    conduit_explain(args: FormatArgs = {}) {
      const result = buildConduitExplain();
      return wantsJson(args) ? result : renderConduitExplainText(result);
    },
  };
}
