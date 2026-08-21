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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ValidationCommand, ValidationCommandResult, ValidationProgressReporter, ValidationResult } from '../core/validation-types.js';
import { validateResourceClaims } from '../core/keyed-scheduler.js';
import { PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';
import {
  buildDynamicValidationPlan,
  buildDualRevisionImpactGraph,
  buildRevocationLedger,
  buildStoryChangeManifest,
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
  verifyValidationShardReceipt,
} from '../core/story-aware-validation.js';
import { executeValidationPlan } from '../core/validation-executor.js';

export interface PrepareStoryAwareValidationArgs {
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

function waveZeroCommand(catalog: ValidationCatalogEntry[]): string | undefined {
  const build = catalog.find((entry) =>
    entry.args.some((arg) => arg === 'build') || /(?:^|[-_:])build(?:$|[-_:])|\bbuild\b/i.test(entry.label),
  );
  // A dynamic source-first receipt is not safe without an explicit build
  // proof. An arbitrary first test must never be promoted to Wave-0.
  return build?.id;
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
  if (!normalized.includes('/') || !/\.(?:c?m?js|mjs|mts|ts|tsx|json)$/.test(normalized)) return undefined;
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
function runtimeTraceForResult(result: ValidationCommandResult | undefined, projectRoot: string): ValidationRuntimeTrace {
  if (!result?.runtimeTrace) {
    return { unknownRuntimeInputs: ['executor did not emit runtime trace'] };
  }
  const boundary = result.runtimeTrace;
  const normalizeObserved = (value: string): string | undefined => {
    const candidate = sourceAuthorityPath(value);
    if (!candidate) return undefined;
    if (!isAbsolute(candidate)) return candidate;
    const root = resolve(projectRoot);
    const absolute = resolve(candidate);
    const rel = relative(root, absolute).replace(/\\/g, '/');
    return rel && !rel.startsWith('../') && rel !== '..' ? rel : undefined;
  };
  const readPaths = (boundary.readPaths || []).map(normalizeObserved).filter((path): path is string => Boolean(path));
  const loadedPaths = (boundary.loadedPaths || []).map(normalizeObserved).filter((path): path is string => Boolean(path));
  const spawnedPaths = (boundary.spawnedPaths || boundary.argv).map(normalizeObserved).filter((path): path is string => Boolean(path));
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
    unknownRuntimeInputs: [...boundary.unknownRuntimeInputs],
  };
}

export function persistCanonicalFullBaseline(args: {
  projectRoot: string;
  sourceHead: string;
  result: ValidationResult;
  buildProofDigest?: string;
  toolchainDigest?: string;
}): CanonicalFullBaseline | undefined {
  if (!args.result.allPass) return undefined;
  const inventory = discoverValidationInventory(args.projectRoot);
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
      declaredEnvironmentKeys: trace.environmentKeys,
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
    runnerDigest: stableDigest({ provider: 'lattice-verifier-configured-commands', version: 1 }),
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
  const inventory = discoverValidationInventory(args.projectRoot);
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
    : buildDualRevisionImpactGraph({ gitCwd, baseHead: args.baseHead, head, catalog });
  const baseline = readCanonicalFullBaseline(args.projectRoot);
  const baselineUsable = baseline
    && baseline.sourceHead === args.baseHead
    && baseline.inventoryDigest === inventory.digest
    && baseline.catalogDigest === catalogDigest
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
    mode: args.mode || 'observe',
    gitCwd,
    buildProofDigest: args.buildProofDigest,
    toolchainDigest: args.toolchainDigest || stableDigest({ node: process.version, platform: process.platform, arch: process.arch }),
    scopeContract: args.scopeContract,
    buildCommandId: waveZeroCommand(catalog),
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

export interface DynamicShardArtifact {
  commandId: string;
  domain: string;
  shards: ValidationShard[];
  receipts: ValidationShardReceipt[];
  aggregation: ReturnType<typeof aggregateValidationShards>;
  residue: string[];
}

function artifactDir(projectRoot: string, storyId: string): string {
  const safe = storyId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(projectRoot, PROOF_OR_STOP_STATE_DIR, 'runtime', 'dynamic-validation', safe);
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
}): void {
  const dir = artifactDir(args.projectRoot, args.storyId);
  mkdirSync(join(dir, 'receipts'), { recursive: true });
  writeFileSync(join(dir, 'selection.json'), JSON.stringify(args.manifest, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'report.txt'), args.report + '\n', 'utf8');
  writeFileSync(join(dir, 'receipts.json'), JSON.stringify(args.receipts, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'revocation-ledger.json'), JSON.stringify(args.revocationLedger, null, 2) + '\n', 'utf8');
  for (const receipt of args.receipts) writeFileSync(join(dir, 'receipts', `${receipt.id}.json`), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  if (args.shardArtifacts?.length) {
    const shardDir = join(dir, 'shards');
    mkdirSync(shardDir, { recursive: true });
    for (const artifact of args.shardArtifacts) {
      for (const receipt of artifact.receipts) {
        writeFileSync(join(shardDir, `${receipt.id}.json`), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
      }
      writeFileSync(join(shardDir, `${artifact.commandId}-${artifact.domain}-aggregate.json`), JSON.stringify(artifact.aggregation, null, 2) + '\n', 'utf8');
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
  buildProofDigest: string;
}): Promise<{ result: ValidationResult; artifact: DynamicShardArtifact }> {
  const domain = shardDomainForEntry(args.entry)!;
  const count = domain === 'review-pass' ? 3 : 4;
  const cases: ValidationCase[] = Array.from({ length: count }, (_, index) => ({
    caseId: `${domain}:${args.entry.id}:case-${index + 1}`,
    domain,
    sentinel: index === 0,
  }));
  const shards = buildValidationShards(cases, { domain, shardCount: count });
  const shardResults: ValidationShardResult[] = [];
  const receipts: ValidationShardReceipt[] = [];
  const results: ValidationResult[] = [];
  const residue: string[] = [];
  for (const shard of shards) {
    const shardDir = join(artifactDir(args.projectRoot, args.storyId), 'shard-work', shard.shardId);
    mkdirSync(shardDir, { recursive: true });
    const baseCommand = commandForEntry(args.entry, args.commands);
    const command: ValidationCommand = {
      ...baseCommand,
      env: {
        ...(baseCommand.env || {}),
        LATTICE_VALIDATION_SHARD_ID: shard.shardId,
        LATTICE_VALIDATION_SHARD_DOMAIN: domain,
        LATTICE_VALIDATION_SHARD_SENTINEL: shard.sentinelCaseId,
        LATTICE_VALIDATION_SHARD_DIR: shardDir,
      },
    };
    const result = await executeValidationPlan({
      provider: `story-aware-dynamic-${domain}-${shard.shardId}`,
      commands: [command], warnings: [],
    }, args.projectRoot, args.head, args.storyId, {
      progress: args.progress,
      abortSignal: args.abortSignal,
      deadlineAt: args.deadlineAt,
      deadlineError: args.deadlineError,
      jobs: 1,
    });
    results.push(result);
    const commandResult = result.commands[0];
    const commandResidue = commandResult?.worktreePollution?.paths || [];
    const localResidue = existsSync(shardDir) ? readdirSync(shardDir).sort() : [];
    const shardResidue = [...commandResidue, ...localResidue];
    residue.push(...shardResidue);
    const sentinelMarker = `PROOF_OR_STOP_SENTINEL:${shard.sentinelCaseId}`;
    const sentinelObserved = Boolean(
      commandResult?.output.includes(sentinelMarker)
      || existsSync(join(shardDir, `${shard.sentinelCaseId}.sentinel`)),
    );
    const shardResult: ValidationShardResult = {
      shardId: shard.shardId,
      domain,
      caseIds: [...shard.caseIds],
      verdict: result.allPass ? 'PASS' : 'FAIL',
      residue: shardResidue,
      executed: true,
      staticPass: false,
      sentinelObserved,
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
      sentinelObserved,
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
  const artifact: DynamicShardArtifact = { commandId: args.entry.id, domain, shards, receipts, aggregation, residue };
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
  const outputDigest = stableDigest(args.result.output);
  const cleanTreeDigest = stableDigest({ head: args.head, storyId: args.prepared.manifest.storyId, status: 'clean-at-command-start' });
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
    runnerDigest: stableDigest({ provider: 'story-aware-dynamic', version: 1 }),
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
  buildResult: ValidationResult;
  buildProofDigest: string;
  receipts: ValidationCommandReceipt[];
  shardArtifacts: DynamicShardArtifact[];
}): Partial<Parameters<typeof evaluateDynamicAuthority>[0]['prerequisites']> {
  const manifest = args.prepared.manifest;
  const baselineCurrent = Boolean(args.baseline
    && verifyCanonicalFullBaseline(args.baseline)
    && args.baseline.sourceHead === manifest.head
    && args.baseline.inventoryDigest === args.prepared.inventoryDigest
    && args.baseline.catalogDigest === args.prepared.catalogDigest
    && args.baseline.epochId === manifest.canonicalBaselineEpochId);
  const baselineClosureComplete = Boolean(args.baseline && Object.values(args.baseline.closureCertificates).length > 0
    && Object.values(args.baseline.closureCertificates).every((certificate) => certificate.status === 'complete'));
  const receiptsCurrent = args.receipts.every((receipt) => verifyValidationCommandReceipt(receipt).ok)
    && args.receipts.every((receipt) => !args.prepared.revocationLedger.revokedReceiptIds.includes(receipt.id));
  const catalogOwnershipGatePassed = args.prepared.catalog.length > 0
    && args.prepared.catalog.every((entry) => entry.id && entry.inputRoots.length > 0 && Array.isArray(entry.resources));
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
    sourceFirstBuildProofActive: Boolean(args.buildProofDigest) && args.buildResult.allPass,
    buildAlwaysExecuted: args.buildResult.commands.length === 1 && args.buildResult.allPass,
    storyRiskEligible: args.prepared.catalog.every((entry) => entry.riskTier === 'local') && !manifest.fullEscalated && shardEvidenceClean,
    periodicFullPolicyActive: baselineCurrent,
    revocationLedgerCurrent: verifyRevocationLedger(args.prepared.revocationLedger) && receiptsCurrent,
    catalogOwnershipGatePassed,
  };
}

/** Execute the actual Wave-0 + selected path and persist its signed receipts. */
export async function runStoryAwareDynamicValidation(args: RunStoryAwareValidationArgs): Promise<StoryAwareDynamicRun> {
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
    deadlineError: args.deadlineError,
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
  const scheduled = buildValidationSchedule(scheduleEntries, {
    workerCapacity: Number(process.env.LATTICE_VALIDATE_JOBS) || 4,
    cpuCapacity: Number(process.env.LATTICE_VALIDATE_CPU) || Number(process.env.LATTICE_VALIDATE_JOBS) || 4,
  });
  const scheduleCheck = verifyValidationSchedule(scheduled, scheduleEntries);
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
        deadlineError: args.deadlineError,
      }));
    }
    for (const entry of shardEntries) {
      shardCommandIds.add(entry.id);
      const sharded = await executeShardedEntry({
        entry, prepared: final, commands: args.commands, projectRoot: args.projectRoot,
        storyId: args.storyId, head, progress: args.progress, abortSignal: args.abortSignal,
        deadlineAt: args.deadlineAt, deadlineError: args.deadlineError, buildProofDigest,
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
    && shardArtifacts.every((artifact) => artifact.aggregation.ok && artifact.residue.length === 0);
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
    riskTier: final.catalog.every((entry) => entry.riskTier === 'local') ? 'local' : 'shared',
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
  persistStoryAwareValidationArtifacts({ projectRoot: args.projectRoot, storyId: args.storyId, manifest: final.manifest, report: runtimeReport, receipts, revocationLedger: final.revocationLedger, shardArtifacts });
  return { ...final, buildResult: wave, selectedResult, dynamicAllPass, authority, receipts, runtimeReport };
}
