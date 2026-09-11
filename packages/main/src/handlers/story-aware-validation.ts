import { VALIDATION_RUNTIME_TRACE_POLICY, VALIDATION_SOURCE_PROVENANCE_SCHEMA } from '../core/runtime-fact-registry.js';
/**
 * Runtime adapter for story-aware validation.
 *
 * The core planner is deliberately pure. This adapter is the only layer that
 * launches commands and owns the small, volatile receipt cache used by the
 * dynamic path. Observe and shadow always hand the ordinary complete plan
 * back to the caller as the authority oracle; low-risk enforcement is only
 * accepted when the core authority predicate says so.
 */
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ValidationCommand, ValidationCommandResult, ValidationProgressReporter, ValidationResult } from '../core/validation-types.js';
import { validateResourceClaims } from '../core/keyed-scheduler.js';
import { StoryStore } from '../core/store.js';
import { assertFindingValidationConstraintsCurrent } from '../core/finding-validation.js';
import { PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';
import { buildDualRevisionImpactGraph } from '../core/dual-revision-impact-graph.js';
import { buildStoryChangeManifest } from '../core/story-change-resolver.js';
import {
  buildDynamicValidationPlan,
  buildRevocationLedger,
  buildValidationSchedule,
  assertValidValidationCatalog,
  compileValidationCatalog,
  createCanonicalFullBaseline,
  createValidationShardReceipt,
  createValidationClosureCertificate,
  createValidationCommandReceipt,
  discoverValidationInventory,
  evaluateDynamicAuthority,
  aggregateValidationShards,
  buildValidationShards,
  formatDynamicValidationReport,
  stableDigest,
  verifyRevocationLedger,
  verifyValidationSchedule,
  type DynamicValidationContext,
  type DynamicValidationMode,
  type DynamicAuthorityDecision,
  type CanonicalFullBaseline,
  type ReceiptRevocationLedger,
  type ScopeContractData,
  type StoryChangedFile,
  type ValidationCatalogEntry,
  type ValidationClosureCertificate,
  type ValidationCommandReceipt,
  type ValidationCase,
  type ValidationShard,
  type ValidationShardReceipt,
  type ValidationShardResult,
  type ValidationRuntimeTrace,
  type ValidationSelectionManifest,
  type VerificationIntent,
  verifyCanonicalFullBaseline,
  verifyValidationCommandReceipt,
  verifyValidationSelectionManifest,
  verifyValidationClosureCertificate,
  isReceiptRevoked,
  verifyValidationShardReceipt,
} from '../core/story-aware-validation.js';
import { executeValidationPlan } from '../core/validation-executor.js';

export interface PrepareStoryAwareValidationArgs {
  findingConstraints?: import('../core/finding-validation.js').FindingValidationConstraints;
  projectRoot: string;
  /** Git worktree root may differ from the config/project root on wrapper layouts. */
  gitCwd?: string;
  storyId: string;
  baseHead: string;
  head?: string;
  scopeContract?: ScopeContractData;
  verificationIntents?: VerificationIntent[];
  changedFiles?: StoryChangedFile[];
  affectedProcessFacts?: string[];
  affectedCapabilities?: string[];
  mode?: DynamicValidationMode;
  baselineEpochId?: string;
  buildProofDigest?: string;
  toolchainDigest?: string;
  runtimeTraces?: Map<string, ValidationRuntimeTrace>;
  receipts?: ValidationCommandReceipt[];
  revocationLedger?: ReceiptRevocationLedger;
  /** Configured commands retain env/optional/focus fields omitted by inventory discovery. */
  commands?: ValidationCommand[];
}

export interface PreparedStoryAwareValidation {
  inventoryDigest: string;
  catalogDigest: string;
  catalog: ValidationCatalogEntry[];
  closures: Map<string, ValidationClosureCertificate>;
  manifest: ValidationSelectionManifest;
  report: string;
  revocationLedger: ReceiptRevocationLedger;
}

function currentHead(gitCwd: string): string {
  // Callers resolve this through the story-keyed resolveGitCwd boundary before
  // entering the adapter. Keeping the parameter named gitCwd prevents a
  // wrapper-root metadataRoot from being mistaken for the authoritative repo.
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitCwd, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

function baselineEpoch(args: PrepareStoryAwareValidationArgs): string {
  return args.baselineEpochId || args.baseHead;
}

const DYNAMIC_RUNNER_DIGEST = stableDigest({ provider: 'story-aware-dynamic', version: 6, executor: 'validation-executor' });

function waveZeroCommand(catalog: ValidationCatalogEntry[]): string | undefined {
  const build = catalog.find((entry) =>
    entry.args.some((arg) => arg === 'build') || /(?:^|[-_:])build(?:$|[-_:])|\bbuild\b/i.test(entry.label),
  );
  // A dynamic source-first receipt is not safe without an explicit build
  // proof. An arbitrary first test must never be promoted to Wave-0.
  // A validate.ts/js/mts project may expose one authoritative command rather
  // than a separately named build row.  In that bounded one-command inventory
  // the command itself is the Wave-0 source-first proof; multi-command plans
  // still fail closed until an explicit build row is declared.
  return build?.id || (catalog.length === 1 ? catalog[0]?.id : undefined);
}

function initialLedger(args: PrepareStoryAwareValidationArgs): ReceiptRevocationLedger {
  if (args.revocationLedger && verifyRevocationLedger(args.revocationLedger)) return args.revocationLedger;
  return buildRevocationLedger([], []);
}

function canonicalBaselinePath(projectRoot: string): string {
  return join(projectRoot, PROOF_OR_STOP_STATE_DIR, 'runtime', 'dynamic-validation', 'canonical-baseline.json');
}

export function readCanonicalFullBaseline(projectRoot: string): CanonicalFullBaseline | undefined {
  try {
    if (!existsSync(canonicalBaselinePath(projectRoot))) return undefined;
    const parsed = JSON.parse(readFileSync(canonicalBaselinePath(projectRoot), 'utf8')) as CanonicalFullBaseline;
    return verifyCanonicalFullBaseline(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sourceAuthorityPath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!/\.(?:c?m?js|mjs|mts|ts|tsx|json)$/.test(normalized)) return undefined;
  if (normalized.startsWith('packages/main/dist/')) {
    return normalized.replace(/^packages\/main\/dist\//, 'packages/main/src/').replace(/\.(?:c?m?js|mjs)$/, '.ts');
  }
  if (normalized.startsWith('dist/')) {
    return normalized.replace(/^dist\//, 'packages/main/src/').replace(/\.(?:c?m?js|mjs)$/, '.ts');
  }
  return normalized;
}

/**
 * Convert the executor's real spawn-boundary result into the closure trace.
 *
 * This intentionally does not inspect catalog args.  A catalog row describes
 * what may run; only the result emitted by the process executor is evidence of
 * what did run.  Missing instrumentation remains an unknown input and is
 * consumed by createValidationClosureCertificate's fail-closed branch.
 */
export function runtimeTraceForResult(result: ValidationCommandResult | undefined, projectRoot: string): ValidationRuntimeTrace {
  if (!result?.runtimeTrace) {
    return { unknownRuntimeInputs: ['executor did not emit runtime trace'] };
  }
  const boundary = result.runtimeTrace;
  const normalizeObserved = (value: string): string | undefined => {
    if (!value) return undefined;
    if (/^node:/.test(value) || builtinModules.includes(value)) return undefined;
    // Do not realpath the captured read after exit: it may be deleted or retargeted.
    if (!isAbsolute(value)) return `__unresolved__/${value.replace(/\\/g, '/')}`;
    const absolute = value;
    const rel = relative(realpathSync(projectRoot), absolute).replace(/\\/g, '/');
    if (rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) return sourceAuthorityPath(rel) || rel;
    return `__external__/${absolute.replace(/^[\\/]+/, '').replace(/\\/g, '/')}`;
  };
  const unknownRuntimeInputs = [...boundary.unknownRuntimeInputs];
  if (boundary.readPathSchema !== VALIDATION_RUNTIME_TRACE_POLICY.schemaVersion) unknownRuntimeInputs.push('legacy or unsupported physical read trace');
  if ((boundary.readPaths ?? []).some(value => !isAbsolute(value))) unknownRuntimeInputs.push('nonabsolute physical read observation');
  const normalizedReads = (boundary.readPaths || []).map((value) => ({ value, path: normalizeObserved(value) }));
  for (const row of normalizedReads) {
    if ((!row.path || row.path.startsWith('__unresolved__/')) && (isAbsolute(row.value) || row.value.includes('/') || row.value.includes('\\'))) {
      unknownRuntimeInputs.push(`unmapped-runtime-read:${row.value}`);
    }
  }
  for (const [kind, values] of [['module-load', boundary.loadedPaths || []], ['process-spawn', boundary.spawnedPaths || []]] as const) {
    for (const value of values) {
      if (isAbsolute(value) && !normalizeObserved(value)) unknownRuntimeInputs.push(`unmapped-runtime-${kind}:${value}`);
    }
  }
  const readPaths = normalizedReads.map((row) => row.path).filter((path): path is string => Boolean(path));
  const loadedPaths = (boundary.loadedPaths || []).map(normalizeObserved).filter((path): path is string => Boolean(path));
  const spawnedPaths = (boundary.spawnedPaths || boundary.argv)
    .filter((value) => !/^(?:node|bun|npm|npx|tsx|-[-A-Za-z])$/.test(value) && !/(?:^|[\\/])(?:node|bun)(?:\.exe)?$/.test(value) && (isAbsolute(value) || value.includes('/') || /\.(?:c?m?js|mjs|mts|ts|tsx|json)$/.test(value)))
    .map(normalizeObserved)
    .filter((path): path is string => Boolean(path));
  return {
    command: boundary.command,
    argv: [...boundary.argv],
    cwd: boundary.cwd,
    startedAt: boundary.startedAt,
    endedAt: boundary.endedAt,
    exitCode: boundary.exitCode,
    events: [...boundary.events],
    readPaths: [...new Set(readPaths)],
    loadedPaths: [...new Set(loadedPaths)],
    spawnedPaths: [...new Set(spawnedPaths)],
    registryKeys: [...(boundary.registryKeys || [])],
    environmentKeys: [...boundary.environmentKeys],
    unknownRuntimeInputs: [...new Set(unknownRuntimeInputs)],
  };
}

export function persistCanonicalFullBaseline(args: {
  projectRoot: string;
  sourceHead: string;
  result: ValidationResult;
  buildProofDigest?: string;
  toolchainDigest?: string;
  commands?: ValidationCommand[];
}): CanonicalFullBaseline | undefined {
  if (!args.result.allPass) return undefined;
  const injected = args.commands?.map((row, index) => ({ ...row, id: `validation-${stableDigest({ command: row.command, args: row.args }).slice(0, 16)}`, originalIndex: index }));
  const inventory = discoverValidationInventory(args.projectRoot, injected);
  const catalog = compileValidationCatalog(inventory);
  assertValidValidationCatalog(inventory, catalog);
  const catalogDigest = stableDigest(catalog);
  const traces: Record<string, ValidationRuntimeTrace> = {};
  const closureCertificates: Record<string, ValidationClosureCertificate> = {};
  for (const entry of catalog) {
    const result = args.result.commands.find((row) => row.command === entry.command
      && row.args.length === entry.args.length
      && row.args.every((arg, index) => arg === entry.args[index]));
    const trace = runtimeTraceForResult(result, args.projectRoot);
    traces[entry.id] = trace;
    closureCertificates[entry.id] = createValidationClosureCertificate({
      commandId: entry.id,
      baseHead: args.sourceHead,
      inventoryDigest: inventory.digest,
      catalogDigest,
      staticPaths: entry.inputRoots,
      runtimeTrace: trace,
      // Only keys explicitly declared by the catalog are admissible.  The
      // tracer records actual reads; inheriting the full parent environment
      // here would turn an undeclared secret/config read into a false PASS.
      declaredEnvironmentKeys: entry.declaredEnvironmentKeys || Object.keys(entry.env || {}),
      processFacts: entry.triggerExtensions.processFacts,
      capabilities: entry.triggerExtensions.capabilities,
      producedBy: 'canonical-full-baseline-compiler',
    });
  }
  const baseline = createCanonicalFullBaseline({
    epochId: args.sourceHead,
    sourceHead: args.sourceHead,
    inventoryDigest: inventory.digest,
    catalogDigest,
    toolchainDigest: args.toolchainDigest || stableDigest({ node: process.version, platform: process.platform, arch: process.arch }),
    runnerDigest: DYNAMIC_RUNNER_DIGEST,
    buildProofDigest: args.buildProofDigest || stableDigest(args.result.commands.map((row) => ({ command: row.command, args: row.args, code: row.code, output: row.output }))),
    allPass: true,
    createdAt: new Date().toISOString(),
    traces,
    closureCertificates,
  });
  const dir = join(args.projectRoot, PROOF_OR_STOP_STATE_DIR, 'runtime', 'dynamic-validation');
  mkdirSync(dir, { recursive: true });
  writeFileSync(canonicalBaselinePath(args.projectRoot), JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  return baseline;
}

function prepare(args: PrepareStoryAwareValidationArgs): PreparedStoryAwareValidation {
  const gitCwd = args.gitCwd || args.projectRoot;
  const head = args.head || currentHead(gitCwd);
  const injectedInventory = args.commands?.map((row, index) => ({
    ...row,
    id: `validation-${stableDigest({ command: row.command, args: row.args }).slice(0, 16)}`,
    originalIndex: index,
  }));
  const inventory = discoverValidationInventory(args.projectRoot, injectedInventory);
  const catalog = compileValidationCatalog(inventory);
  assertValidValidationCatalog(inventory, catalog);
  for (const entry of catalog) validateResourceClaims(entry.resources, entry.id);
  const catalogDigest = stableDigest(catalog);
  const changes = buildStoryChangeManifest({
    storyId: args.storyId,
    gitCwd,
    baseHead: args.baseHead,
    head,
    scopeContract: args.scopeContract,
    verificationIntents: args.verificationIntents,
    changedFiles: args.changedFiles,
    affectedProcessFacts: args.affectedProcessFacts,
    affectedCapabilities: args.affectedCapabilities,
  });
  const graph = args.changedFiles && args.changedFiles.length === 0
    ? undefined
    : buildDualRevisionImpactGraph({
      gitCwd,
      baseHead: args.baseHead,
      head,
      catalog,
      storyId: args.storyId,
      changeManifest: changes,
      scopeContract: args.scopeContract,
      verificationIntents: args.verificationIntents,
      changedFiles: args.changedFiles,
      affectedProcessFacts: args.affectedProcessFacts,
      affectedCapabilities: args.affectedCapabilities,
    });
  const toolchainDigest = args.toolchainDigest || stableDigest({ node: process.version, platform: process.platform, arch: process.arch });
  const baseline = readCanonicalFullBaseline(args.projectRoot);
  const baselineUsable = baseline
    && baseline.sourceHead === args.baseHead
    && baseline.inventoryDigest === inventory.digest
    && baseline.catalogDigest === catalogDigest
    && baseline.runnerDigest === DYNAMIC_RUNNER_DIGEST
    && baseline.toolchainDigest === toolchainDigest
    ? baseline
    : undefined;
  const closures = new Map<string, ValidationClosureCertificate>();
  for (const entry of catalog) {
    const baselineCertificate = baselineUsable?.closureCertificates[entry.id];
    if (baselineCertificate && baselineCertificate.baseHead === args.baseHead && verifyCanonicalFullBaseline(baselineUsable)) {
      closures.set(entry.id, baselineCertificate);
      continue;
    }
    const trace = args.runtimeTraces?.get(entry.id) || baselineUsable?.traces[entry.id];
    // Static closure allows first source-first execution. Isolated runtime
    // traces can still turn it into unverified when an undeclared read occurs.
    closures.set(entry.id, createValidationClosureCertificate({
      commandId: entry.id,
      baseHead: args.baseHead,
      inventoryDigest: inventory.digest,
      catalogDigest,
      staticPaths: entry.inputRoots,
      runtimeTrace: trace,
      processFacts: entry.triggerExtensions.processFacts,
      capabilities: entry.triggerExtensions.capabilities,
      producedBy: 'story-closure-preview',
    }));
  }
  const context: DynamicValidationContext = {
    projectRoot: args.projectRoot,
    storyId: args.storyId,
    baseHead: args.baseHead,
    head,
    inventory,
    catalog,
    changes,
    ...(graph ? { graph } : {}),
    closures,
    receipts: args.receipts,
    baselineEpochId: baselineEpoch(args),
    revocationLedger: initialLedger(args),
    runnerDigest: DYNAMIC_RUNNER_DIGEST,
    mode: args.mode || 'observe',
    gitCwd,
    buildProofDigest: args.buildProofDigest,
    toolchainDigest,
    scopeContract: args.scopeContract,
    buildCommandId: waveZeroCommand(catalog),
    findingConstraints: args.findingConstraints,
  };
  const manifest = buildDynamicValidationPlan(context);
  return {
    inventoryDigest: inventory.digest,
    catalogDigest,
    catalog,
    closures,
    manifest,
    report: formatDynamicValidationReport({ manifest }),
    revocationLedger: context.revocationLedger!,
  };
}

export function prepareStoryAwareValidation(args: PrepareStoryAwareValidationArgs): PreparedStoryAwareValidation {
  return prepare(args);
}

export interface DynamicValidationArtifacts {
  receipts: ValidationCommandReceipt[];
  revocationLedger: ReceiptRevocationLedger;
}

/** Consumer-side integrity checks; never executes commands or repairs runtime evidence. */
export function storedDynamicReceiptIntegrityReasons(projectRoot: string, storyId: string, head: string, value: unknown): string[] {
  try {
    const manifest = value as ValidationSelectionManifest;
    if (!verifyValidationSelectionManifest(manifest, { storyId, head })
      || manifest.mode !== 'enforce-low-risk' || manifest.fullEscalated) return ['dynamic_manifest_invalid'];
    if (manifest.toolchainDigest !== stableDigest({ node: process.version, platform: process.platform, arch: process.arch }))
      return ['dynamic_toolchain_changed'];
    const dir = artifactDir(projectRoot, storyId);
    // Strict reads are deliberate: the execution cache's empty-ledger recovery
    // cannot be used to accept an existing PASS after evidence disappears.
    const ledger = JSON.parse(readFileSync(join(dir, 'revocation-ledger.json'), 'utf8')) as ReceiptRevocationLedger;
    const receipts = JSON.parse(readFileSync(join(dir, 'receipts.json'), 'utf8')) as ValidationCommandReceipt[];
    if (!verifyRevocationLedger(ledger) || ledger.digest !== manifest.receiptRevocationLedgerDigest)
      return ['dynamic_revocation_ledger_changed_or_invalid'];
    if (!Array.isArray(receipts)) return ['dynamic_receipts_invalid'];
    const baseline = readCanonicalFullBaseline(projectRoot);
    if (!baseline || baseline.sourceHead !== manifest.baseHead || baseline.epochId !== manifest.canonicalBaselineEpochId
      || baseline.inventoryDigest !== manifest.inventoryDigest || baseline.catalogDigest !== manifest.catalogDigest
      || baseline.runnerDigest !== DYNAMIC_RUNNER_DIGEST || baseline.toolchainDigest !== manifest.toolchainDigest)
      return ['dynamic_baseline_invalid'];
    for (const row of manifest.rows) {
      const closure = baseline.closureCertificates[row.commandId];
      if (!closure || !verifyValidationClosureCertificate(closure)
        || closure.signature !== row.closureCertificateDigest) return ['dynamic_closure_invalid'];
      const candidates = receipts.filter(receipt => receipt.commandId === row.commandId
        && (row.disposition === 'reuse' ? receipt.id === row.receiptId : receipt.sourceHead === manifest.head));
      const accepted = candidates.some(receipt => verifyValidationCommandReceipt(receipt).ok
        && !isReceiptRevoked(receipt, ledger) && receipt.revocationLedgerDigest === ledger.digest
        && receipt.inputDigest === row.inputDigest && receipt.closureCertificateDigest === closure.signature
        && receipt.catalogDigest === manifest.catalogDigest && receipt.inventoryDigest === manifest.inventoryDigest
        && receipt.runnerDigest === DYNAMIC_RUNNER_DIGEST && receipt.toolchainDigest === manifest.toolchainDigest
        && receipt.buildProofDigest === manifest.buildProofDigest && receipt.sourceBaseHead === manifest.baseHead
        && receipt.canonicalBaselineEpochId === manifest.canonicalBaselineEpochId);
      if (!accepted) return ['dynamic_receipt_missing_invalid_expired_or_revoked'];
    }
    return [];
  } catch { return ['dynamic_evidence_unavailable_or_malformed']; }
}

export interface DynamicShardArtifact {
  commandId: string;
  domain: string;
  shards: ValidationShard[];
  receipts: ValidationShardReceipt[];
  aggregation: ReturnType<typeof aggregateValidationShards>;
  residue: string[];
  /**
   * The unchanged complete-plan command is the DYN-5 oracle.  Shard coverage
   * is not admissible merely because every mini-case passed: the aggregate
   * verdict must agree with this command executed without the shard adapter.
   */
  originalOracle?: {
    commandId: string;
    executed: boolean;
    allPass: boolean;
    verdict: 'PASS' | 'FAIL';
    exitCode: number;
    outputDigest: string;
    equivalent: boolean;
  };
}

function artifactDir(projectRoot: string, storyId: string): string {
  const safe = storyId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(projectRoot, PROOF_OR_STOP_STATE_DIR, 'runtime', 'dynamic-validation', safe);
}

/** Whole-PASS reuse must not turn an invalid existing ledger into an empty ledger. */
export function readRoutineReuseRevocationBasis(projectRoot: string, storyId: string): string | null {
  const path = join(artifactDir(projectRoot, storyId), 'revocation-ledger.json');
  if (!existsSync(path)) return buildRevocationLedger([], []).digest;
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as ReceiptRevocationLedger;
    return verifyRevocationLedger(ledger) ? ledger.digest : null;
  } catch { return null; }
}

/** Runtime state only; this path is covered by the runtime artifact registry. */
export function readStoryAwareValidationArtifacts(projectRoot: string, storyId: string): DynamicValidationArtifacts {
  const dir = artifactDir(projectRoot, storyId);
  let receipts: ValidationCommandReceipt[] = [];
  let revocationLedger = buildRevocationLedger([], []);
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'receipts.json'), 'utf8')) as unknown;
    if (Array.isArray(parsed)) receipts = parsed as ValidationCommandReceipt[];
  } catch { /* first run / corrupt cache -> fail closed and execute */ }
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'revocation-ledger.json'), 'utf8')) as ReceiptRevocationLedger;
    if (verifyRevocationLedger(parsed)) revocationLedger = parsed;
  } catch { /* first run / invalid ledger -> empty signed ledger */ }
  return { receipts, revocationLedger };
}

export function persistStoryAwareValidationArtifacts(args: {
  projectRoot: string;
  storyId: string;
  manifest: ValidationSelectionManifest;
  report: string;
  receipts: ValidationCommandReceipt[];
  revocationLedger: ReceiptRevocationLedger;
  shardArtifacts?: DynamicShardArtifact[];
  preserveExistingReceipts?: boolean;
}): void {
  const dir = artifactDir(args.projectRoot, args.storyId);
  mkdirSync(join(dir, 'receipts'), { recursive: true });
  writeFileSync(join(dir, 'selection.json'), JSON.stringify(args.manifest, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'report.txt'), args.report + '\n', 'utf8');
  if (!args.preserveExistingReceipts) {
    writeFileSync(join(dir, 'receipts.json'), JSON.stringify(args.receipts, null, 2) + '\n', 'utf8');
    for (const receipt of args.receipts) writeFileSync(join(dir, 'receipts', `${receipt.id}.json`), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  }
  // The revocation ledger is authoritative even during observe-only runs that
  // preserve the existing receipt set. Always persist the newest signed ledger
  // so a newly discovered invalid closure cannot be lost with the receipts.
  writeFileSync(join(dir, 'revocation-ledger.json'), JSON.stringify(args.revocationLedger, null, 2) + '\n', 'utf8');
  if (args.shardArtifacts?.length) {
    const shardDir = join(dir, 'shards');
    mkdirSync(shardDir, { recursive: true });
    for (const artifact of args.shardArtifacts) {
      for (const receipt of artifact.receipts) {
        writeFileSync(join(shardDir, `${receipt.id}.json`), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
      }
      writeFileSync(join(shardDir, `${artifact.commandId}-${artifact.domain}-aggregate.json`), JSON.stringify({ ...artifact.aggregation, originalOracle: artifact.originalOracle || null }, null, 2) + '\n', 'utf8');
      writeFileSync(join(shardDir, `${artifact.commandId}-${artifact.domain}-cleanup.json`), JSON.stringify({ residue: artifact.residue, residueCount: artifact.residue.length }, null, 2) + '\n', 'utf8');
    }
  }
}

function commandForEntry(entry: ValidationCatalogEntry, configured?: ValidationCommand[]): ValidationCommand {
  const source = configured?.find((candidate) => candidate.command === entry.command && candidate.args.join('\0') === entry.args.join('\0'))
    || configured?.[entry.originalIndex];
  return {
    label: source?.label || entry.label,
    command: source?.command || entry.command,
    args: source?.args || entry.args,
    ...(source?.shell !== undefined ? { shell: source.shell } : entry.shell !== undefined ? { shell: entry.shell } : {}),
    ...(source?.cwd !== undefined ? { cwd: source.cwd } : entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
    ...(source?.env !== undefined ? { env: source.env } : entry.env !== undefined ? { env: entry.env } : {}),
    ...(source?.declaredEnvironmentKeys !== undefined ? { declaredEnvironmentKeys: source.declaredEnvironmentKeys } : entry.declaredEnvironmentKeys !== undefined ? { declaredEnvironmentKeys: entry.declaredEnvironmentKeys } : {}),
    ...(source?.caseRegistryPath !== undefined ? { caseRegistryPath: source.caseRegistryPath } : entry.caseRegistryPath !== undefined ? { caseRegistryPath: entry.caseRegistryPath } : {}),
    ...(source?.runnerSourcePath !== undefined ? { runnerSourcePath: source.runnerSourcePath } : entry.runnerSourcePath !== undefined ? { runnerSourcePath: entry.runnerSourcePath } : {}),
    ...(source?.runnerSourceDigest !== undefined ? { runnerSourceDigest: source.runnerSourceDigest } : entry.runnerSourceDigest !== undefined ? { runnerSourceDigest: entry.runnerSourceDigest } : {}),
    ...(source?.assurance !== undefined ? { assurance: source.assurance } : entry.assurance !== undefined ? { assurance: entry.assurance } : {}),
    ...(source?.riskTier !== undefined ? { riskTier: source.riskTier } : entry.riskTier !== undefined ? { riskTier: entry.riskTier } : {}),
    ...(source?.closurePolicy !== undefined ? { closurePolicy: source.closurePolicy } : entry.closurePolicy !== undefined ? { closurePolicy: entry.closurePolicy } : {}),
    ...(source?.fullBaselineReusePolicy !== undefined ? { fullBaselineReusePolicy: source.fullBaselineReusePolicy } : entry.fullBaselineReusePolicy !== undefined ? { fullBaselineReusePolicy: entry.fullBaselineReusePolicy } : {}),
    ...(source?.cpuWeight !== undefined ? { cpuWeight: source.cpuWeight } : entry.cpuWeight !== undefined ? { cpuWeight: entry.cpuWeight } : {}),
    ...(source?.expectedP50Ms !== undefined ? { expectedP50Ms: source.expectedP50Ms } : entry.expectedP50Ms !== undefined ? { expectedP50Ms: entry.expectedP50Ms } : {}),
    ...(source?.timeoutMs !== undefined ? { timeoutMs: source.timeoutMs } : entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    ...(source?.optional !== undefined ? { optional: source.optional } : {}),
    ...(source?.focus !== undefined ? { focus: source.focus } : entry.focus !== undefined ? { focus: entry.focus } : {}),
    resources: entry.resources,
  };
}

function shardDomainForEntry(entry: ValidationCatalogEntry): 'quorum' | 'review-pass' | undefined {
  const text = `${entry.label} ${entry.args.join(' ')}`.toLowerCase();
  if (/review[-_: ]?pass|review_pass|reviewpass/.test(text)) return 'review-pass';
  if (/\bquorum\b/.test(text)) return 'quorum';
  return undefined;
}

const DYN5_ADAPTER_ENTRYPOINT = 'packages/main/src/tasks/story-aware-validation-case-adapter.mjs';
const DYN5_CHILD_ENVIRONMENT_SOURCE = 'packages/main/src/tasks/validation-child-environment.mjs';
const DYN5_ADAPTER_SOURCE_DIGEST = '6de0a88aea6964edb5d69ae696610f62c10d5b1f6046b56f36fdc9549efe03a4';
const DYN5_CHILD_ENVIRONMENT_SOURCE_DIGEST = '7db8412e767f9fe9e0c00cbd4b62b701caa51f7e268b8ef6b76aa0c264c5afe7';
const DYN5_ADAPTER_REGISTRY: Record<string, {
  digest: string;
  entrypoint: string;
  sourceDigest: string;
  sourceDependencies: readonly { entrypoint: string; sourceDigest: string }[];
}> = {
  'case-registry-output-v1': {
    digest: stableDigest({
      name: 'case-registry-output-v1',
      version: 1,
      entrypoint: DYN5_ADAPTER_ENTRYPOINT,
      contract: ['caseRegistryPath', 'runtime-read-of-registry', 'case-routing-marker', 'sentinel-marker', 'case-evidence-files'],
      sourceDependencies: [{
        entrypoint: DYN5_CHILD_ENVIRONMENT_SOURCE,
        sourceDigest: DYN5_CHILD_ENVIRONMENT_SOURCE_DIGEST,
      }],
    }),
    entrypoint: DYN5_ADAPTER_ENTRYPOINT,
    sourceDigest: DYN5_ADAPTER_SOURCE_DIGEST,
    sourceDependencies: [{
      entrypoint: DYN5_CHILD_ENVIRONMENT_SOURCE,
      sourceDigest: DYN5_CHILD_ENVIRONMENT_SOURCE_DIGEST,
    }],
  },
};

function registeredShardAdapter(projectRoot: string, command: ValidationCommand, name: unknown): { digest: string; entrypoint: string; useAdapterEntrypoint?: boolean } | undefined {
  if (typeof name !== 'string') return undefined;
  const adapter = DYN5_ADAPTER_REGISTRY[name];
  if (!adapter) return undefined;
  const expectedEntrypoint = resolve(projectRoot, adapter.entrypoint);
  // The registry binds both the semantic contract and the checked-in adapter
  // bytes.  A command cannot opt in by echoing markers or by replacing the
  // entrypoint under the same name.
  if (!existsSync(expectedEntrypoint)) return undefined;
  if (adapter.sourceDigest && stableDigest(readFileSync(expectedEntrypoint, 'utf8')) !== adapter.sourceDigest) return undefined;
  for (const dependency of adapter.sourceDependencies) {
    const dependencyPath = resolve(projectRoot, dependency.entrypoint);
    const dependencyRelative = relative(resolve(projectRoot), dependencyPath);
    if (dependencyRelative === '..' || dependencyRelative.startsWith('../')
      || !existsSync(dependencyPath)
      || stableDigest(readFileSync(dependencyPath, 'utf8')) !== dependency.sourceDigest) return undefined;
  }
  const commandPath = resolve(command.command);
  const runtimePath = resolve(process.execPath);
  const nodeLike = commandPath === runtimePath || /(?:^|[\\/])(?:node|bun)(?:\.exe)?$/i.test(commandPath);
  const entrypointBound = command.args.some((arg) => resolve(projectRoot, arg) === expectedEntrypoint);
  // The complete inventory keeps the original, end-to-end smoke command as
  // its full-plan oracle.  Dynamic DYN-5 execution is allowed to replace that
  // command boundary with the registered adapter only when the catalog row is
  // explicitly wired to one of the two known gate domains.  This keeps the
  // ordinary full plan authoritative while making the sharded path executable
  // from the repository's real configuration (rather than only temp fixtures).
  const domainCommand = command.args.some((arg) => /(?:review-pass-discard-smoke|quorum-submit-smoke)\.(?:m?js|ts)$/.test(arg));
  return nodeLike && (entrypointBound || domainCommand)
    ? { ...adapter, ...(domainCommand && !entrypointBound ? { useAdapterEntrypoint: true } : {}) }
    : undefined;
}

function loadShardCaseRegistry(projectRoot: string, entry: ValidationCatalogEntry, domain: string): { cases: ValidationCase[]; path: string; digest: string } | undefined {
  if (!entry.caseRegistryPath) return undefined;
  try {
    // Resolve before execution so the runtime observation and containment check
    // name the same physical registry, including /var aliases and symlinks.
    const path = realpathSync(resolve(projectRoot, entry.caseRegistryPath));
    const root = realpathSync(projectRoot);
    const rel = relative(root, path);
    if (!rel || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const cases = parsed.filter((row): row is ValidationCase => Boolean(row && typeof row === 'object'
      && typeof (row as Record<string, unknown>).caseId === 'string'
      && typeof (row as Record<string, unknown>).domain === 'string'
      && Boolean((row as Record<string, unknown>).runner)
      && typeof ((row as Record<string, unknown>).runner as Record<string, unknown>)?.command === 'string'
      && (row as Record<string, unknown>).domain === domain));
    if (cases.length < 3 || new Set(cases.map((row) => row.caseId)).size !== cases.length) return undefined;
    return { cases, path, digest: stableDigest(cases) };
  } catch {
    return undefined;
  }
}

/** Execute one catalog row as real isolated DYN-5 shards and collect signed evidence. */
async function executeShardedEntry(args: {
  entry: ValidationCatalogEntry;
  prepared: PreparedStoryAwareValidation;
  commands?: ValidationCommand[];
  projectRoot: string;
  storyId: string;
  head: string;
  progress?: ValidationProgressReporter;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
  beforeLaunch?: () => void;
  buildProofDigest: string;
}): Promise<{ result: ValidationResult; artifact: DynamicShardArtifact }> {
  const domain = shardDomainForEntry(args.entry)!;
  const baseCommand = commandForEntry(args.entry, args.commands);
  // Run the configured smoke command once, without shard routing, before the
  // adapter replaces its command boundary.  This is the unchanged complete
  // domain test required by DYN-5 aggregate equivalence.
  const oracleEnv = Object.fromEntries(Object.entries(baseCommand.env || {})
    .filter(([key]) => !key.startsWith('LATTICE_VALIDATION_SHARD_') && !key.startsWith('PROOF_OR_STOP_VALIDATION_SHARD_')));
  const oracle = await executeValidationPlan({
    provider: `story-aware-dynamic-${domain}-original-oracle`,
    commands: [{ ...baseCommand, ...(Object.keys(oracleEnv).length ? { env: oracleEnv } : { env: undefined }) }],
    warnings: [],
  }, args.projectRoot, args.head, args.storyId, {
    progress: args.progress,
    abortSignal: args.abortSignal,
    deadlineAt: args.deadlineAt,
    deadlineError: args.deadlineError, beforeLaunch: args.beforeLaunch,
    jobs: 1,
  });
  const oracleCommand = oracle.commands[0];
  const originalOracle = {
    commandId: args.entry.id,
    executed: Boolean(oracleCommand),
    allPass: oracle.allPass,
    verdict: oracle.allPass ? 'PASS' as const : 'FAIL' as const,
    exitCode: oracleCommand?.code ?? 1,
    outputDigest: stableDigest(oracleCommand?.output || ''),
    equivalent: false,
  };
  const registry = loadShardCaseRegistry(args.projectRoot, args.entry, domain);
  const failClosed = (reason: string): { result: ValidationResult; artifact: DynamicShardArtifact } => {
    const aggregation = { ok: false, verdict: 'FAIL' as const, errors: [reason], coveredCaseIds: [] };
    return {
      result: {
        provider: `story-aware-dynamic-${domain}-unwired`, status: 'fail', allPass: false,
        summary: reason, details: [reason], warnings: [], timestamp: new Date().toISOString(), headSha: args.head,
        commands: [], commandExecutions: 0, disposition: 'executed',
      },
      artifact: { commandId: args.entry.id, domain, shards: [], receipts: [], aggregation, residue: [], originalOracle },
    };
  };
  if (!registry) return failClosed(`DYN-5 ${domain} case registry is missing, outside the project root, malformed, or incomplete`);
  const count = domain === 'review-pass' ? 3 : Math.min(4, Math.max(3, registry.cases.length));
  const cases = registry.cases;
  const shards = buildValidationShards(cases, { domain, shardCount: count });
  const shardResults: ValidationShardResult[] = [];
  const receipts: ValidationShardReceipt[] = [];
  const results: ValidationResult[] = [];
  const residue: string[] = [];
  // Dynamic validation shard execution is canonical-only: the active runtime reads
  // PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER and does not accept the retired spelling.
  const shardAdapter = baseCommand.env?.PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER;
  const adapter = registeredShardAdapter(args.projectRoot, baseCommand, shardAdapter);
  if (!adapter) {
    const rejectedResults: ValidationShardResult[] = shards.map((shard) => ({
      shardId: shard.shardId, domain, caseIds: [...shard.caseIds], verdict: 'FAIL', executed: false, staticPass: false, sentinelObserved: false,
    }));
    const aggregation = aggregateValidationShards({ cases, shards, results: rejectedResults, domain });
    return {
      result: {
        provider: `story-aware-dynamic-${domain}-unwired`, status: 'fail', allPass: false,
        summary: `DYN-5 ${domain} adapter is not configured; dynamic sharding failed closed`,
        details: ['Configure a registered case-aware adapter and PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER before enabling this command.'],
        warnings: [], timestamp: new Date().toISOString(), headSha: args.head, commands: [], commandExecutions: 0, disposition: 'executed',
      },
      artifact: { commandId: args.entry.id, domain, shards, receipts: [], aggregation, residue: [], originalOracle },
    };
  }
  for (const shard of shards) {
    const shardDir = join(artifactDir(args.projectRoot, args.storyId), 'shard-work', shard.shardId);
    mkdirSync(shardDir, { recursive: true });
    const command: ValidationCommand = {
      ...(adapter.useAdapterEntrypoint ? {
        ...baseCommand,
        // Preserve the configured runtime identity.  Using the host Bun
        // executable here would bypass the Node preload tracer on projects
        // whose complete inventory is explicitly bound to `node`.
        command: baseCommand.command,
        args: [resolve(args.projectRoot, adapter.entrypoint), domain],
      } : baseCommand),
      env: {
        ...(baseCommand.env || {}),
        PROOF_OR_STOP_VALIDATION_SHARD_ID: shard.shardId,
        PROOF_OR_STOP_VALIDATION_SHARD_DOMAIN: domain,
        PROOF_OR_STOP_VALIDATION_SHARD_SENTINEL: shard.sentinelCaseId,
        PROOF_OR_STOP_VALIDATION_SHARD_CASE_IDS: shard.caseIds.join(','),
        PROOF_OR_STOP_VALIDATION_SHARD_CASE_REGISTRY: registry.path,
        PROOF_OR_STOP_VALIDATION_SHARD_CASE_REGISTRY_DIGEST: registry.digest,
        PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER_DIGEST: adapter.digest,
        PROOF_OR_STOP_VALIDATION_SHARD_DIR: shardDir,
        PROOF_OR_STOP_VALIDATION_PROJECT_ROOT: args.projectRoot,
      },
    };
    const result = await executeValidationPlan({
      provider: `story-aware-dynamic-${domain}-${shard.shardId}`,
      commands: [command], warnings: [],
    }, args.projectRoot, args.head, args.storyId, {
      progress: args.progress,
      abortSignal: args.abortSignal,
      deadlineAt: args.deadlineAt,
      deadlineError: args.deadlineError, beforeLaunch: args.beforeLaunch,
      jobs: 1,
    });
    results.push(result);
    const commandResult = result.commands[0];
    const sentinelMarker = `PROOF_OR_STOP_SENTINEL:${shard.sentinelCaseId}`;
    const caseMarker = `PROOF_OR_STOP_CASES:${shard.caseIds.join(',')}`;
    const registryObserved = Boolean(commandResult?.runtimeTrace?.readPaths?.some((path) => resolve(path) === registry.path)
      || commandResult?.runtimeTrace?.loadedPaths?.some((path) => resolve(path) === registry.path));
    const sentinelObserved = Boolean(
      commandResult?.output.includes(sentinelMarker)
      || false,
    );
    const caseRoutingObserved = Boolean(commandResult?.output.includes(caseMarker));
    const evidenceFiles = existsSync(shardDir)
      ? readdirSync(shardDir).filter((name) => name.endsWith('.case.json'))
      : [];
    const evidenceCaseIds: string[] = [];
    let evidenceValid = evidenceFiles.length === shard.caseIds.length;
    for (const file of evidenceFiles) {
      try {
        const evidence = JSON.parse(readFileSync(join(shardDir, file), 'utf8')) as Record<string, unknown>;
        const body = { ...evidence };
        delete body.evidenceDigest;
        const caseId = typeof evidence.caseId === 'string' ? evidence.caseId : '';
        evidenceCaseIds.push(caseId);
        evidenceValid = evidenceValid
          && evidence.schema === 'proof-or-stop.validation-shard-case-evidence.v1'
          && evidence.adapter === shardAdapter
          && evidence.adapterDigest === adapter.digest
          && evidence.registryDigest === registry.digest
          && evidence.shardId === shard.shardId
          && evidence.domain === domain
          && evidence.executed === true
          && evidence.exitCode === 0
          && typeof evidence.outputDigest === 'string'
          && typeof evidence.successMarker === 'string'
          && typeof evidence.evidenceDigest === 'string'
          && evidence.evidenceDigest === stableDigest(body)
          && shard.caseIds.includes(caseId)
          && (Boolean(evidence.sentinel) === (caseId === shard.sentinelCaseId));
        if (evidenceValid) rmSync(join(shardDir, file), { force: true });
      } catch {
        evidenceValid = false;
      }
    }
    evidenceValid = evidenceValid
      && new Set(evidenceCaseIds).size === shard.caseIds.length
      && shard.caseIds.every((caseId) => evidenceCaseIds.includes(caseId));
    const shardRel = relative(args.projectRoot, shardDir).replace(/\\/g, '/');
    const commandResidue = (commandResult?.worktreePollution?.paths || []).filter((path) => {
      const normalized = path.replace(/\\/g, '/');
      // The executor snapshots before its finally-cleanup removes the private
      // shard evidence and runtime trace sidecar.  Both are verified above or
      // owned by the runtime artifact registry, so they are not residue.
      return !normalized.startsWith(shardRel + '/') && !normalized.startsWith('.proof-or-stop/runtime/validation-traces/');
    });
    const localResidue = existsSync(shardDir) ? readdirSync(shardDir).sort() : [];
    const shardResidue = [...commandResidue, ...localResidue];
    residue.push(...shardResidue);
    const sentinelEvidenceObserved = evidenceValid && evidenceCaseIds.includes(shard.sentinelCaseId);
    const shardResult: ValidationShardResult = {
      shardId: shard.shardId,
      domain,
      caseIds: [...shard.caseIds],
      verdict: result.allPass ? 'PASS' : 'FAIL',
      residue: shardResidue,
      executed: true,
      staticPass: false,
      sentinelObserved: sentinelObserved && caseRoutingObserved && registryObserved && sentinelEvidenceObserved,
    };
    shardResults.push(shardResult);
    const output = commandResult?.output || '';
    const receipt = createValidationShardReceipt({
      id: `shard-receipt-${stableDigest({ commandId: args.entry.id, shardId: shard.shardId, head: args.head, output }).slice(0, 24)}`,
      shardId: shard.shardId,
      domain,
      commandId: args.entry.id,
      caseIds: [...shard.caseIds],
      sentinelCaseId: shard.sentinelCaseId,
      sentinelObserved: sentinelObserved && caseRoutingObserved && registryObserved && sentinelEvidenceObserved,
      caseRegistryDigest: registry.digest,
      adapterDigest: adapter.digest,
      registryObserved,
      sourceHead: args.head,
      result: result.allPass ? 'PASS' : 'FAIL',
      exitCode: commandResult?.code ?? 1,
      outputDigest: stableDigest(output),
      executed: true,
      staticPass: false,
      residue: shardResidue,
      cleanupDigest: stableDigest({ shardId: shard.shardId, residue: shardResidue, cleaned: true }),
      createdAt: new Date().toISOString(),
    });
    receipts.push(receipt);
    // The command gets a private work directory. Cleanup is explicit and the
    // residue is captured before removal, so aggregation can reject pollution.
    rmSync(shardDir, { recursive: true, force: true });
  }
  const aggregation = aggregateValidationShards({ cases, shards, results: shardResults, domain });
  if (!receipts.every((receipt) => verifyValidationShardReceipt(receipt))) {
    aggregation.ok = false;
    aggregation.verdict = 'FAIL';
    aggregation.errors.push('invalid shard receipt');
  }
  const aggregateVerdict = aggregation.verdict;
  originalOracle.equivalent = originalOracle.executed && aggregateVerdict === originalOracle.verdict;
  if (!originalOracle.equivalent) {
    aggregation.ok = false;
    aggregation.verdict = 'FAIL';
    aggregation.errors.push(`aggregate verdict mismatch: original=${originalOracle.verdict} aggregate=${aggregateVerdict}`);
  }
  const artifact: DynamicShardArtifact = { commandId: args.entry.id, domain, shards, receipts, aggregation, residue, originalOracle };
  return { result: combineResults(results, `story-aware-dynamic-${domain}`, args.head), artifact };
}

function combineResults(results: ValidationResult[], provider: string, head: string): ValidationResult {
  const commands = results.flatMap((result) => result.commands);
  const allPass = results.every((result) => result.allPass);
  return {
    provider,
    status: allPass ? (results.some((result) => result.status === 'warn') ? 'warn' : 'pass') : 'fail',
    allPass,
    summary: allPass ? 'Dynamic selected validation commands passed' : 'Dynamic selected validation commands failed',
    details: results.flatMap((result) => result.details),
    warnings: results.flatMap((result) => result.warnings),
    timestamp: new Date().toISOString(),
    headSha: head,
    commands,
    commandExecutions: commands.length,
    disposition: 'executed',
  };
}

function receiptForResult(args: {
  result: ValidationCommandResult;
  entry: ValidationCatalogEntry;
  row: ValidationSelectionManifest['rows'][number];
  prepared: PreparedStoryAwareValidation;
  baseHead: string;
  head: string;
  buildProofDigest: string;
  revocationLedger: ReceiptRevocationLedger;
}): ValidationCommandReceipt | undefined {
  if (args.result.code !== 0 || args.result.timedOut || !args.row.closureCertificateDigest) return undefined;
  const provenance = args.result.sourceProvenance;
  if (!provenance || provenance.schemaVersion !== VALIDATION_SOURCE_PROVENANCE_SCHEMA
    || !provenance.cleanBefore || !provenance.cleanAfter
    || provenance.headBefore !== args.head || provenance.headAfter !== args.head) return undefined;
  const outputDigest = stableDigest(args.result.output);
  const cleanTreeDigest = stableDigest({ head: args.head, storyId: args.prepared.manifest.storyId, status: 'clean-at-command-start-and-end', provenanceSchema: VALIDATION_SOURCE_PROVENANCE_SCHEMA });
  const executionEnvironmentDigest = stableDigest({ node: process.version, platform: process.platform, arch: process.arch });
  const createdAt = new Date().toISOString();
  return createValidationCommandReceipt({
    id: 'receipt-' + stableDigest({ commandId: args.entry.id, inputDigest: args.row.inputDigest, outputDigest, head: args.head }).slice(0, 24),
    commandId: args.entry.id,
    commandIdentityDigest: stableDigest({ command: args.entry.command, args: args.entry.args }),
    inputDigest: args.row.inputDigest,
    closureCertificateDigest: args.row.closureCertificateDigest,
    catalogDigest: args.prepared.catalogDigest,
    inventoryDigest: args.prepared.inventoryDigest,
    runnerDigest: DYNAMIC_RUNNER_DIGEST,
    toolchainDigest: args.prepared.manifest.toolchainDigest,
    buildProofDigest: args.buildProofDigest,
    sourceHead: args.head,
    sourceBaseHead: args.baseHead,
    canonicalBaselineEpochId: args.prepared.manifest.canonicalBaselineEpochId,
    producedBy: 'story-execution',
    cleanTreeDigest,
    executionEnvironmentDigest,
    result: 'PASS',
    exitCode: 0,
    outputDigest,
    durationMs: args.result.durationMs,
    createdAt,
    revocationLedgerDigest: args.revocationLedger.digest,
  });
}

export interface RunStoryAwareValidationArgs extends PrepareStoryAwareValidationArgs {
  commands?: ValidationCommand[];
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
  beforeLaunch?: () => void;
  progress?: ValidationProgressReporter;
  prerequisites?: Parameters<typeof evaluateDynamicAuthority>[0]['prerequisites'];
}

export interface StoryAwareDynamicRun extends PreparedStoryAwareValidation {
  buildResult: ValidationResult;
  selectedResult: ValidationResult;
  /** Verdict after accounting for both executed rows and admitted reuse rows. */
  dynamicAllPass: boolean;
  authority: DynamicAuthorityDecision;
  receipts: ValidationCommandReceipt[];
  runtimeReport: string;
}

/**
 * Gate-owned DYN-3 evidence provider.  These values are derived from the
 * current signed manifest, baseline, command receipts and actual Wave-0 run;
 * callers cannot turn enforcement on by supplying booleans in the request.
 */
function deriveGateOwnedPrerequisites(args: {
  projectRoot: string;
  prepared: PreparedStoryAwareValidation;
  baseline?: CanonicalFullBaseline;
  buildResult?: ValidationResult;
  buildProofDigest?: string;
  receipts: ValidationCommandReceipt[];
  shardArtifacts: DynamicShardArtifact[];
}): Partial<Parameters<typeof evaluateDynamicAuthority>[0]['prerequisites']> {
  const manifest = args.prepared.manifest;
  const currentToolchainDigest = stableDigest({ node: process.version, platform: process.platform, arch: process.arch });
  const baselineCurrent = Boolean(args.baseline
    && verifyCanonicalFullBaseline(args.baseline)
    && args.baseline.sourceHead === manifest.baseHead
    && args.baseline.inventoryDigest === args.prepared.inventoryDigest
    && args.baseline.catalogDigest === args.prepared.catalogDigest
    && args.baseline.epochId === manifest.canonicalBaselineEpochId
    && args.baseline.runnerDigest === DYNAMIC_RUNNER_DIGEST
    && args.baseline.toolchainDigest === currentToolchainDigest);
  const baselineClosureComplete = Boolean(args.baseline
    && args.prepared.catalog.every((entry) => args.baseline?.closureCertificates[entry.id]?.status === 'complete')
    && Object.values(args.baseline.closureCertificates).length === args.prepared.catalog.length);
  const receiptsCurrent = args.receipts.every((receipt) => verifyValidationCommandReceipt(receipt).ok)
    && args.receipts.every((receipt) => !args.prepared.revocationLedger.revokedReceiptIds.includes(receipt.id));
  const catalogOwnershipGatePassed = args.prepared.catalog.length > 0
    && args.prepared.catalog.every((entry) => entry.id
      && entry.inputRoots.length > 0
      && (!entry.runnerSourcePath || Boolean(entry.runnerSourceDigest))
      && Array.isArray(entry.resources)
      && entry.policySource === 'explicit'
      && ['static-and-traced', 'whole-repository', 'never-reuse'].includes(entry.closurePolicy)
      && ['always', 'story-selectable', 'full-only'].includes(entry.assurance)
      && ['local', 'shared', 'gate', 'validation-infra'].includes(entry.riskTier)
      && ['not-applicable', 'exact-current-epoch-only', 'forbidden'].includes(entry.fullBaselineReusePolicy));
  const processFactBindingsComplete = args.prepared.catalog.every((entry) =>
    (entry.triggerExtensions?.processFacts || []).every((fact) => typeof fact === 'string' && fact.length > 0));
  const changedTestPropagationVerified = manifest.totals.uncovered === 0
    && manifest.totals.unmappedChanges === 0
    && !manifest.rows.some((row) => row.disposition === 'unverified');
  const shardEvidenceClean = args.shardArtifacts.every((artifact) => artifact.aggregation.ok && artifact.residue.length === 0);
  return {
    baselineCurrent,
    expiryPolicyActive: baselineCurrent && baselineClosureComplete,
    environmentPolicyComplete: baselineCurrent && baselineClosureComplete,
    wholeRepoScannersClassified: catalogOwnershipGatePassed,
    processFactBindingsComplete,
    changedTestPropagationVerified,
    sourceFirstBuildProofActive: Boolean(args.buildProofDigest) && args.buildResult?.allPass === true,
    buildAlwaysExecuted: args.buildResult?.commands.length === 1 && args.buildResult?.allPass === true,
    // Gate/validation-infra rows remain in the inventory and are selected by
    // impact/full-escalation rules, but their mere presence must not make every
    // unrelated local Story ineligible.  Eligibility is about the rows this
    // manifest actually executes or reuses; a selected gate row still forces
    // full fallback through `manifest.fullEscalated`/risk below.
    storyRiskEligible: args.prepared.catalog
      .filter((entry) => manifest.rows.some((row) => row.commandId === entry.id && row.disposition !== 'unverified'))
      .every((entry) => entry.riskTier === 'local')
      && !manifest.fullEscalated && shardEvidenceClean,
    periodicFullPolicyActive: baselineCurrent,
    revocationLedgerCurrent: verifyRevocationLedger(args.prepared.revocationLedger) && receiptsCurrent,
    catalogOwnershipGatePassed,
  };
}

/** Read-only rejection preflight. It can require full execution, never grant authority. */
export function dynamicValidationPreflightFallbackReasons(projectRoot: string, prepared: PreparedStoryAwareValidation): string[] {
  const prior = readStoryAwareValidationArtifacts(projectRoot, prepared.manifest.storyId);
  const facts = deriveGateOwnedPrerequisites({ projectRoot, prepared,
    baseline: readCanonicalFullBaseline(projectRoot), receipts: prior.receipts, shardArtifacts: [] });
  return Object.entries(facts)
    .filter(([name, value]) => name !== 'sourceFirstBuildProofActive' && name !== 'buildAlwaysExecuted' && value === false)
    .map(([name]) => name);
}

/** Execute the actual Wave-0 + selected path and persist its signed receipts. */
export async function runStoryAwareDynamicValidation(args: RunStoryAwareValidationArgs): Promise<StoryAwareDynamicRun> {
  const originalBeforeLaunch = args.beforeLaunch;
  const checkFindingConstraints = () => assertFindingValidationConstraintsCurrent(new StoryStore(args.projectRoot), args.projectRoot, args.findingConstraints);
  checkFindingConstraints();
  args = { ...args, beforeLaunch: () => { checkFindingConstraints(); originalBeforeLaunch?.(); } };
  const prior = readStoryAwareValidationArtifacts(args.projectRoot, args.storyId);
  const first = prepare({ ...args, receipts: args.receipts || prior.receipts, revocationLedger: args.revocationLedger || prior.revocationLedger });
  const head = args.head || currentHead(args.gitCwd || args.projectRoot);
  const waveId = first.catalog.find((entry) => first.manifest.rows.some((row) => row.commandId === entry.id && row.reasons.includes('wave-0-build')))?.id
    || waveZeroCommand(first.catalog);
  if (!waveId) throw new Error('dynamic validation inventory is empty; cannot execute Wave-0 build');
  const waveEntry = first.catalog.find((entry) => entry.id === waveId)!;
  const waveCommand = commandForEntry(waveEntry, args.commands);
  const wave = await executeValidationPlan({ provider: 'story-aware-dynamic-wave-0', commands: [waveCommand], warnings: [] }, args.projectRoot, head, args.storyId, {
    progress: args.progress,
    abortSignal: args.abortSignal,
    deadlineAt: args.deadlineAt,
    deadlineError: args.deadlineError, beforeLaunch: args.beforeLaunch,
    jobs: 1,
  });
  const buildProofDigest = stableDigest({ commandId: waveId, allPass: wave.allPass, commands: wave.commands.map((row) => ({ code: row.code, timedOut: row.timedOut, output: row.output })) });
  const final = prepare({ ...args, receipts: prior.receipts, revocationLedger: prior.revocationLedger, buildProofDigest });
  const selectedEntries = final.manifest.rows
    .filter((row) => row.disposition === 'execute' && row.commandId !== waveId)
    .map((row) => final.catalog.find((entry) => entry.id === row.commandId)!)
    .filter(Boolean);
  const scheduleEntries = selectedEntries.map((entry) => ({
    commandId: entry.id,
    originalIndex: entry.originalIndex,
    cpuWeight: entry.cpuWeight,
    expectedP50Ms: entry.expectedP50Ms || Math.max(1, Math.min(300_000, entry.timeoutMs || 1_000)),
    resources: entry.resources,
  }));
  const schedulerCapacity = {
    workerCapacity: Number(process.env.PROOF_OR_STOP_VALIDATE_JOBS) || 4,
    cpuCapacity: Number(process.env.PROOF_OR_STOP_VALIDATE_CPU) || Number(process.env.PROOF_OR_STOP_VALIDATE_JOBS) || 4,
  };
  const scheduled = buildValidationSchedule(scheduleEntries, schedulerCapacity);
  const scheduleCheck = verifyValidationSchedule(scheduled, scheduleEntries, schedulerCapacity);
  if (!scheduleCheck.ok) throw new Error('dynamic resource schedule rejected: ' + scheduleCheck.errors.join('; '));
  const byWave = new Map<number, ValidationCatalogEntry[]>();
  for (const row of scheduled) {
    const entry = final.catalog.find((candidate) => candidate.id === row.commandId);
    if (entry) byWave.set(row.wave, [...(byWave.get(row.wave) || []), entry]);
  }
  const selectedResults: ValidationResult[] = [];
  const shardArtifacts: DynamicShardArtifact[] = [];
  const shardCommandIds = new Set<string>();
  for (const entries of [...byWave.entries()].sort(([a], [b]) => a - b).map(([, rows]) => rows)) {
    const shardEntries = entries.filter((entry) => shardDomainForEntry(entry));
    const ordinaryEntries = entries.filter((entry) => !shardDomainForEntry(entry));
    if (ordinaryEntries.length) {
      selectedResults.push(await executeValidationPlan({
        provider: 'story-aware-dynamic-selected',
        commands: ordinaryEntries.map((entry) => commandForEntry(entry, args.commands)), warnings: [],
      }, args.projectRoot, head, args.storyId, {
        progress: args.progress,
        abortSignal: args.abortSignal,
        deadlineAt: args.deadlineAt,
        deadlineError: args.deadlineError, beforeLaunch: args.beforeLaunch,
      }));
    }
    for (const entry of shardEntries) {
      shardCommandIds.add(entry.id);
      const sharded = await executeShardedEntry({
        entry, prepared: final, commands: args.commands, projectRoot: args.projectRoot,
        storyId: args.storyId, head, progress: args.progress, abortSignal: args.abortSignal,
        deadlineAt: args.deadlineAt, deadlineError: args.deadlineError, beforeLaunch: args.beforeLaunch, buildProofDigest,
      });
      selectedResults.push(sharded.result);
      shardArtifacts.push(sharded.artifact);
    }
  }
  const selectedResult = combineResults(selectedResults, 'story-aware-dynamic-selected', head);
  const dynamicExecution = combineResults([wave, selectedResult], 'story-aware-dynamic', head);
  // A reused row has no process result in this invocation, but its signed
  // receipt was already admitted by the final manifest. Therefore the
  // complete dynamic verdict is the execution verdict plus the zero-gap
  // manifest invariant, not selectedResult.allPass alone.
  const dynamicAllPass = dynamicExecution.allPass
    && final.manifest.totals.unverified === 0
    && final.manifest.totals.uncovered === 0
    && shardArtifacts.every((artifact) => artifact.aggregation.ok && artifact.residue.length === 0 && artifact.originalOracle?.equivalent === true);
  const receipts = [...prior.receipts];
  for (const result of [wave, ...selectedResults]) {
    for (const commandResult of result.commands) {
      const entry = final.catalog.find((candidate) => candidate.command === commandResult.command && candidate.args.join('\0') === commandResult.args.join('\0'));
      if (!entry) continue;
      if (shardCommandIds.has(entry.id)) continue;
      const row = final.manifest.rows.find((candidate) => candidate.commandId === entry.id);
      if (!row) continue;
      const receipt = receiptForResult({ result: commandResult, entry, row, prepared: final, baseHead: args.baseHead, head, buildProofDigest, revocationLedger: final.revocationLedger });
      if (receipt) {
        const index = receipts.findIndex((candidate) => candidate.id === receipt.id);
        if (index >= 0) receipts[index] = receipt; else receipts.push(receipt);
      }
    }
  }
  const pinnedExecuted = final.manifest.rows.filter((row) => row.reasons.includes('verification-intent-pin')).every((row) => row.disposition === 'execute');
  const authority = evaluateDynamicAuthority({
    mode: args.mode || 'observe',
    riskTier: final.catalog
      .filter((entry) => final.manifest.rows.some((row) => row.commandId === entry.id && row.disposition !== 'unverified'))
      .every((entry) => entry.riskTier === 'local') ? 'local' : 'shared',
    manifest: final.manifest,
    prerequisites: {
      // The gate-owned evidence provider below computes every prerequisite from
      // this current manifest/baseline/receipt run. Caller-provided booleans
      // are intentionally not authority inputs.
      baselineCurrent: false,
      expiryPolicyActive: false,
      environmentPolicyComplete: false,
      wholeRepoScannersClassified: false,
      processFactBindingsComplete: false,
      changedTestPropagationVerified: false,
      sourceFirstBuildProofActive: Boolean(buildProofDigest) && wave.allPass,
      buildAlwaysExecuted: wave.commands.length === 1 && wave.allPass,
      storyRiskEligible: false,
      periodicFullPolicyActive: false,
      revocationLedgerCurrent: verifyRevocationLedger(final.revocationLedger),
      catalogOwnershipGatePassed: false,
      ...deriveGateOwnedPrerequisites({
        projectRoot: args.projectRoot,
        prepared: final,
        baseline: readCanonicalFullBaseline(args.projectRoot),
        buildResult: wave,
        buildProofDigest,
        receipts,
        shardArtifacts,
      }),
    },
    pinnedCommandsExecuted: pinnedExecuted,
  });
  const runtimeReport = formatDynamicValidationReport({ manifest: final.manifest, authority, durationMs: dynamicExecution.commands.reduce((sum, row) => sum + row.durationMs, 0) });
  checkFindingConstraints();
  persistStoryAwareValidationArtifacts({ projectRoot: args.projectRoot, storyId: args.storyId, manifest: final.manifest, report: runtimeReport, receipts, revocationLedger: final.revocationLedger, shardArtifacts });
  return { ...final, buildResult: wave, selectedResult, dynamicAllPass, authority, receipts, runtimeReport };
}
