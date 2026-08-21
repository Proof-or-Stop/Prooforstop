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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  createValidationClosureCertificate,
  createValidationCommandReceipt,
  discoverValidationInventory,
  evaluateDynamicAuthority,
  formatDynamicValidationReport,
  stableDigest,
  verifyRevocationLedger,
  verifyValidationSchedule,
  type DynamicValidationContext,
  type DynamicValidationMode,
  type DynamicAuthorityDecision,
  type ReceiptRevocationLedger,
  type ScopeContractData,
  type StoryChangedFile,
  type ValidationCatalogEntry,
  type ValidationClosureCertificate,
  type ValidationCommandReceipt,
  type ValidationRuntimeTrace,
  type ValidationSelectionManifest,
  type VerificationIntent,
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
  const closures = new Map<string, ValidationClosureCertificate>();
  for (const entry of catalog) {
    const trace = args.runtimeTraces?.get(entry.id);
    // Static closure allows first source-first execution. Isolated runtime
    // traces can still turn it into unverified when an undeclared read occurs.
    closures.set(entry.id, createValidationClosureCertificate({
      commandId: entry.id,
      baseHead: args.baseHead,
      inventoryDigest: inventory.digest,
      catalogDigest,
      staticPaths: entry.inputRoots,
      runtimeTrace: trace,
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
}): void {
  const dir = artifactDir(args.projectRoot, args.storyId);
  mkdirSync(join(dir, 'receipts'), { recursive: true });
  writeFileSync(join(dir, 'selection.json'), JSON.stringify(args.manifest, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'report.txt'), args.report + '\n', 'utf8');
  writeFileSync(join(dir, 'receipts.json'), JSON.stringify(args.receipts, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'revocation-ledger.json'), JSON.stringify(args.revocationLedger, null, 2) + '\n', 'utf8');
  for (const receipt of args.receipts) writeFileSync(join(dir, 'receipts', `${receipt.id}.json`), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
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
  for (const entries of [...byWave.entries()].sort(([a], [b]) => a - b).map(([, rows]) => rows)) {
    selectedResults.push(await executeValidationPlan({
      provider: 'story-aware-dynamic-selected',
      commands: entries.map((entry) => commandForEntry(entry, args.commands)), warnings: [],
    }, args.projectRoot, head, args.storyId, {
      progress: args.progress,
      abortSignal: args.abortSignal,
      deadlineAt: args.deadlineAt,
      deadlineError: args.deadlineError,
    }));
  }
  const selectedResult = combineResults(selectedResults, 'story-aware-dynamic-selected', head);
  const dynamicExecution = combineResults([wave, selectedResult], 'story-aware-dynamic', head);
  // A reused row has no process result in this invocation, but its signed
  // receipt was already admitted by the final manifest. Therefore the
  // complete dynamic verdict is the execution verdict plus the zero-gap
  // manifest invariant, not selectedResult.allPass alone.
  const dynamicAllPass = dynamicExecution.allPass
    && final.manifest.totals.unverified === 0
    && final.manifest.totals.uncovered === 0;
  const receipts = [...prior.receipts];
  for (const result of [wave, ...selectedResults]) {
    for (const commandResult of result.commands) {
      const entry = final.catalog.find((candidate) => candidate.command === commandResult.command && candidate.args.join('\0') === commandResult.args.join('\0'));
      if (!entry) continue;
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
      // These are authority claims, not implementation defaults. The runtime
      // has only proven command execution and receipt syntax here; all other
      // prerequisites remain false unless trusted current gate evidence is
      // supplied explicitly by the caller.
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
      ...(args.prerequisites || {}),
    },
    pinnedCommandsExecuted: pinnedExecuted,
  });
  const runtimeReport = formatDynamicValidationReport({ manifest: final.manifest, authority, durationMs: dynamicExecution.commands.reduce((sum, row) => sum + row.durationMs, 0) });
  persistStoryAwareValidationArtifacts({ projectRoot: args.projectRoot, storyId: args.storyId, manifest: final.manifest, report: runtimeReport, receipts, revocationLedger: final.revocationLedger });
  return { ...final, buildResult: wave, selectedResult, dynamicAllPass, authority, receipts, runtimeReport };
}
