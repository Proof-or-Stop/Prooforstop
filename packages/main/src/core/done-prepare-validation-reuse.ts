import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type ProofOrStopConfig } from './config.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import { evaluateDoneRequiredEvidence, resolveDoneRequiredPolicy } from './done-required-validation.js';
import { digestScopeContract } from './guard-session.js';
import { LIFECYCLE_TRANSITIONS } from './lifecycle-registry.js';
import type { StoryStore } from './store.js';
import type { DoneRequiredEvidenceData, TestEvidenceData } from './types.js';
import { computeCompositeScopeDigest } from './closeout-trust.js';
import { classifyTrustedValidationLineage } from './validation-evidence-reuse.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsForStory,
  type DirtyWorktreeClassification,
  type DirtyWorktreeEntry,
} from './dirty-worktree.js';
import { gitStatusRowsForDonePrepareGeneratedMetadata } from './done-prepare-generated-metadata.js';
import { DONE_PREPARE_VALIDATION_REUSE_SCHEMA } from './artifact-schema.js';

export { DONE_PREPARE_VALIDATION_REUSE_SCHEMA };
export const DONE_PREPARE_VALIDATION_REUSE_CLASSIFIER_VERSION = 'done-prepare-generated-metadata-safe-set.v1' as const;

interface DonePrepareValidationReuseHashes {
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  validateCommandSetHash: string;
  doneRequiredCommandSetHash: string;
  doneRequiredPolicyHash: string;
  configHash: string;
  scopeContractHash: string | null;
  compositeScopeDigest: string | null;
  lifecycleRegistryHash: string;
  lifecycleClassifierVersion: typeof DONE_PREPARE_VALIDATION_REUSE_CLASSIFIER_VERSION;
}

export interface DonePrepareValidationReuseBasis {
  capturedAt: string;
  hashes: DonePrepareValidationReuseHashes;
  testEvidence: TestEvidenceData | null;
  doneRequiredEvidence: DoneRequiredEvidenceData | null;
}

export interface DonePrepareValidationReuseRecord {
  schema: typeof DONE_PREPARE_VALIDATION_REUSE_SCHEMA;
  status: 'reused';
  statement: string;
  createdAt: string;
  storyId: string;
  commandsRerunAfterAutoCloseout: false;
  reuseReason: 'metadata-only-head-drift';
  generatedMetadataPaths: string[];
  unchanged: DonePrepareValidationReuseHashes;
  priorEvidenceRefs: {
    testEvidence: {
      command: string;
      timestamp: string;
      headHash?: string;
      materialHash?: string;
      storyFilesHash?: string;
      outputDigest: string;
    };
    doneRequiredEvidence: {
      startedAt: string;
      endedAt: string;
      headHash?: string;
      materialHash?: string;
      storyFilesHash?: string;
      policyHash: string;
      commandSetHash: string;
      receipts: Array<{
        label: string;
        command: string;
        args: string[];
        startedAt: string;
        endedAt: string;
        outputDigest: string;
      }>;
    };
  };
}

export interface DonePrepareValidationReuseResult {
  ok: boolean;
  record?: DonePrepareValidationReuseRecord;
  reasons: string[];
}

export interface DoneRequiredPreRunReuseEvaluation {
  reusable: boolean;
  existingEvidenceBasis: 'fresh' | 'stale' | 'missing';
  refusalReasons: string[];
  lineage: 'exact-head' | 'trusted-story-metadata-descendant' | 'rejected';
}

/** A stricter wrapper around the DONE gate evaluator used only to skip execution. */
export function evaluateDoneRequiredPreRunReuse(args: {
  root: string;
  gitCwd: string;
  storyId: string;
  store: StoryStore;
  /** Hermetic TOCTOU seam; production callers omit it. */
  beforeFinalHeadCheck?: () => void;
}): DoneRequiredPreRunReuseEvaluation {
  const headBefore = currentGitHead(args.gitCwd);
  let canonical: ReturnType<typeof evaluateDoneRequiredEvidence>;
  try {
    canonical = evaluateDoneRequiredEvidence({
      projectRoot: args.root,
      gitCwd: args.gitCwd,
      storyId: args.storyId,
      store: args.store,
    });
  } catch (error) {
    return {
      reusable: false,
      existingEvidenceBasis: 'stale',
      refusalReasons: [`evidence-malformed-or-unreadable:${error instanceof Error ? error.message : String(error)}`],
      lineage: 'rejected',
    };
  }
  const evidence = canonical.evidence;
  if (!evidence) {
    return { reusable: false, existingEvidenceBasis: 'missing', refusalReasons: canonical.reasons, lineage: 'rejected' };
  }
  const reasons = [...canonical.reasons];
  const currentHead = headBefore;
  let lineage: DoneRequiredPreRunReuseEvaluation['lineage'] = 'rejected';
  const lineageResult = classifyTrustedValidationLineage({
    root: args.root,
    gitCwd: args.gitCwd,
    evidenceHead: evidence.headHash,
    currentHead,
  });
  lineage = lineageResult.lineage;
  reasons.push(...lineageResult.reasons);
  args.beforeFinalHeadCheck?.();
  const headAfter = currentGitHead(args.gitCwd);
  if (!headBefore || headAfter !== headBefore) {
    reasons.push('head-changed-during-reuse-evaluation');
    lineage = 'rejected';
  }
  const unique = [...new Set(reasons)];
  const reusable = canonical.ok && unique.length === 0 && lineage !== 'rejected';
  return {
    reusable,
    existingEvidenceBasis: reusable ? 'fresh' : 'stale',
    refusalReasons: unique,
    lineage,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function configuredValidateSource(config: ProofOrStopConfig): unknown {
  const raw = config as ProofOrStopConfig & { validation?: unknown };
  return {
    validate: raw.validate ?? null,
    validation: raw.validation ?? null,
  };
}

function validateEntrypointDigests(root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const filename of ['validate.ts', 'validate.js', 'validate.mts']) {
    const path = join(root, filename);
    out[filename] = existsSync(path) ? sha256(readFileSync(path)) : null;
  }
  return out;
}

function configHash(root: string, config: ProofOrStopConfig): string {
  return sha256(stableStringify({
    scanRoot: config.scanRoot,
    rootDir: config.rootDir ?? null,
    storyDir: config.storyDir,
    requirementsDir: config.requirementsDir,
    gitRoot: config.gitRoot ?? null,
    validate: configuredValidateSource(config),
    doneRequiredCommands: (config as ProofOrStopConfig & Record<string, unknown>).doneRequiredCommands ?? null,
    validationProfiles: config.validationProfiles ?? null,
    proofAdmissibility: config.proofAdmissibility ?? null,
    proofStory: config.proofStory ?? null,
    validateEntrypoints: validateEntrypointDigests(root),
  }));
}

function validateCommandSetHash(root: string, config: ProofOrStopConfig): string {
  return sha256(stableStringify({
    configured: configuredValidateSource(config),
    entrypoints: validateEntrypointDigests(root),
  }));
}

function scopeContractHash(store: StoryStore, storyId: string): string | null {
  try {
    const contract = store.readScopeContract(storyId);
    return contract ? digestScopeContract(contract) : null;
  } catch {
    return 'unreadable';
  }
}

function compositeScopeDigest(store: StoryStore, storyId: string): string | null {
  try {
    const contract = store.readScopeContract(storyId);
    const ledger = store.readMilestoneLedger(storyId);
    if (!contract || !ledger) return null;
    return computeCompositeScopeDigest({
      contract,
      ledger,
      slicePlan: store.readProofStorySlicePlan(storyId),
    });
  } catch {
    return 'unreadable';
  }
}

function lifecycleRegistryHash(): string {
  return sha256(stableStringify({
    transitions: LIFECYCLE_TRANSITIONS,
    classifierVersion: DONE_PREPARE_VALIDATION_REUSE_CLASSIFIER_VERSION,
    generatedMetadataFiles: ['done-required-evidence.json', 'test-evidence.json'],
  }));
}

function currentHashes(args: {
  root: string;
  gitCwd: string;
  storyId: string;
  store: StoryStore;
}): DonePrepareValidationReuseHashes {
  const config = loadConfig(args.root);
  const doneRequiredPolicy = resolveDoneRequiredPolicy(args.root);
  return {
    ...(currentGitHead(args.gitCwd) ? { headHash: currentGitHead(args.gitCwd) } : {}),
    ...(currentMaterialHash(args.gitCwd, 'HEAD', args.root) ? { materialHash: currentMaterialHash(args.gitCwd, 'HEAD', args.root) } : {}),
    ...(currentStoryFilesHash(args.gitCwd, 'HEAD', args.root) ? { storyFilesHash: currentStoryFilesHash(args.gitCwd, 'HEAD', args.root) } : {}),
    validateCommandSetHash: validateCommandSetHash(args.root, config),
    doneRequiredCommandSetHash: doneRequiredPolicy.commandSetHash,
    doneRequiredPolicyHash: doneRequiredPolicy.policyHash,
    configHash: configHash(args.root, config),
    scopeContractHash: scopeContractHash(args.store, args.storyId),
    compositeScopeDigest: compositeScopeDigest(args.store, args.storyId),
    lifecycleRegistryHash: lifecycleRegistryHash(),
    lifecycleClassifierVersion: DONE_PREPARE_VALIDATION_REUSE_CLASSIFIER_VERSION,
  };
}

function sameHashField(
  reasons: string[],
  field: keyof DonePrepareValidationReuseHashes,
  before: DonePrepareValidationReuseHashes,
  after: DonePrepareValidationReuseHashes,
): void {
  if (before[field] !== after[field]) {
    reasons.push(`${field} changed`);
  }
}

function outputDigest(text: string): string {
  return sha256(text);
}

function buildRecord(args: {
  storyId: string;
  generatedMetadataPaths: string[];
  hashes: DonePrepareValidationReuseHashes;
  testEvidence: TestEvidenceData;
  doneRequiredEvidence: DoneRequiredEvidenceData;
}): DonePrepareValidationReuseRecord {
  return {
    schema: DONE_PREPARE_VALIDATION_REUSE_SCHEMA,
    status: 'reused',
    statement: 'Validation was reused for metadata-only done_prepare auto-closeout; validation commands were not rerun after the generated metadata commit.',
    createdAt: new Date().toISOString(),
    storyId: args.storyId,
    commandsRerunAfterAutoCloseout: false,
    reuseReason: 'metadata-only-head-drift',
    generatedMetadataPaths: [...args.generatedMetadataPaths].sort((left, right) => left.localeCompare(right)),
    unchanged: args.hashes,
    priorEvidenceRefs: {
      testEvidence: {
        command: args.testEvidence.command,
        timestamp: args.testEvidence.timestamp,
        ...(args.testEvidence.headHash ? { headHash: args.testEvidence.headHash } : {}),
        ...(args.testEvidence.materialHash ? { materialHash: args.testEvidence.materialHash } : {}),
        ...(args.testEvidence.storyFilesHash ? { storyFilesHash: args.testEvidence.storyFilesHash } : {}),
        outputDigest: outputDigest(args.testEvidence.output),
      },
      doneRequiredEvidence: {
        startedAt: args.doneRequiredEvidence.startedAt,
        endedAt: args.doneRequiredEvidence.endedAt,
        ...(args.doneRequiredEvidence.headHash ? { headHash: args.doneRequiredEvidence.headHash } : {}),
        ...(args.doneRequiredEvidence.materialHash ? { materialHash: args.doneRequiredEvidence.materialHash } : {}),
        ...(args.doneRequiredEvidence.storyFilesHash ? { storyFilesHash: args.doneRequiredEvidence.storyFilesHash } : {}),
        policyHash: args.doneRequiredEvidence.policyHash,
        commandSetHash: args.doneRequiredEvidence.commandSetHash,
        receipts: args.doneRequiredEvidence.receipts.map((receipt) => ({
          label: receipt.label,
          command: receipt.command,
          args: receipt.args,
          startedAt: receipt.startedAt,
          endedAt: receipt.endedAt,
          outputDigest: receipt.outputDigest,
        })),
      },
    },
  };
}

export function captureDonePrepareValidationReuseBasis(args: {
  root: string;
  gitCwd: string;
  storyId: string;
  store: StoryStore;
}): DonePrepareValidationReuseBasis {
  return {
    capturedAt: new Date().toISOString(),
    hashes: currentHashes(args),
    testEvidence: args.store.readTestEvidence(args.storyId),
    doneRequiredEvidence: args.store.readDoneRequiredEvidence(args.storyId),
  };
}

export function writeDonePrepareValidationReuseRecord(args: {
  root: string;
  gitCwd: string;
  storyId: string;
  store: StoryStore;
  basis: DonePrepareValidationReuseBasis;
  generatedMetadataPaths: string[];
}): DonePrepareValidationReuseResult {
  const reasons: string[] = [];
  const current = captureDonePrepareValidationReuseBasis(args);
  const testEvidence = current.testEvidence;
  const doneRequiredEvidence = current.doneRequiredEvidence;

  if (!testEvidence) reasons.push('missing test-evidence.json');
  else if (testEvidence.result !== 'PASS') reasons.push('test-evidence.json is not PASS');
  if (!doneRequiredEvidence) reasons.push('missing done-required-evidence.json');
  else if (doneRequiredEvidence.status !== 'PASS') reasons.push('done-required-evidence.json is not PASS');
  if (args.generatedMetadataPaths.length === 0) reasons.push('no generated metadata paths are available for reuse binding');

  for (const field of [
    'materialHash',
    'storyFilesHash',
    'validateCommandSetHash',
    'doneRequiredCommandSetHash',
    'doneRequiredPolicyHash',
    'configHash',
    'scopeContractHash',
    'compositeScopeDigest',
    'lifecycleRegistryHash',
    'lifecycleClassifierVersion',
  ] as const) {
    sameHashField(reasons, field, args.basis.hashes, current.hashes);
  }

  if (testEvidence && current.hashes.materialHash && testEvidence.materialHash !== current.hashes.materialHash) {
    reasons.push('test-evidence materialHash does not match current materialHash');
  }
  if (testEvidence && current.hashes.storyFilesHash && testEvidence.storyFilesHash !== current.hashes.storyFilesHash) {
    reasons.push('test-evidence storyFilesHash does not match current storyFilesHash');
  }
  if (doneRequiredEvidence && current.hashes.materialHash && doneRequiredEvidence.materialHash !== current.hashes.materialHash) {
    reasons.push('done-required-evidence materialHash does not match current materialHash');
  }
  if (doneRequiredEvidence && current.hashes.storyFilesHash && doneRequiredEvidence.storyFilesHash !== current.hashes.storyFilesHash) {
    reasons.push('done-required-evidence storyFilesHash does not match current storyFilesHash');
  }
  if (doneRequiredEvidence && doneRequiredEvidence.commandSetHash !== current.hashes.doneRequiredCommandSetHash) {
    reasons.push('done-required-evidence commandSetHash does not match current DONE-required commandSetHash');
  }
  if (doneRequiredEvidence && doneRequiredEvidence.policyHash !== current.hashes.doneRequiredPolicyHash) {
    reasons.push('done-required-evidence policyHash does not match current DONE-required policyHash');
  }

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0 || !testEvidence || !doneRequiredEvidence) {
    return { ok: false, reasons: uniqueReasons };
  }

  const record = buildRecord({
    storyId: args.storyId,
    generatedMetadataPaths: args.generatedMetadataPaths,
    hashes: current.hashes,
    testEvidence,
    doneRequiredEvidence,
  });
  args.store.writeDoneRequiredEvidence(args.storyId, {
    ...doneRequiredEvidence,
    donePrepareValidationReuse: record,
  } as DoneRequiredEvidenceData & { donePrepareValidationReuse: DonePrepareValidationReuseRecord });

  return { ok: true, record, reasons: [] };
}

const GIT_EXEC = { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };

/** Same merge-base check done_prepare uses: local main must be an ancestor of HEAD. */
export function isDonePrepareMainAncestor(gitCwd: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', 'main', 'HEAD'], { cwd: gitCwd, ...GIT_EXEC });
    return true;
  } catch {
    return false;
  }
}

/** SHA of local `main^{commit}`; null when the ref is missing. */
export function donePrepareExpectedMainSha(gitCwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'main^{commit}'], { cwd: gitCwd, ...GIT_EXEC }).trim();
  } catch {
    return null;
  }
}

/** Cheap preflight: Git can resolve and read the index. */
export function isDonePrepareGitIndexReadable(gitCwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-path', 'index'], { cwd: gitCwd, ...GIT_EXEC });
    execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: gitCwd, ...GIT_EXEC });
    return true;
  } catch {
    return false;
  }
}

export function isEvidenceTargetWritable(targetDir: string): boolean {
  try {
    if (!existsSync(targetDir)) return false;
    accessSync(targetDir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Reuses done_prepare's porcelain + dirty-worktree classifier. */
export function classifyDonePrepareWorktree(args: {
  root: string;
  gitCwd: string;
  storyId: string;
  store: StoryStore;
}): DirtyWorktreeClassification {
  const config = loadConfig(args.root);
  return classifyGitStatusRows(
    gitStatusRowsForDonePrepareGeneratedMetadata(args.gitCwd),
    dirtyWorktreeClassifierOptionsForStory(config, args.storyId, args.store, args.root),
  );
}

const NON_RUNTIME_DIRTY_CATEGORIES = new Set([
  'material_source_changes',
  'fixture_changes',
  'unexpected_dirty_files',
  'declared_artifact_changes',
]);

/** Non-runtime dirty rows: source/fixture/unexpected/declared. Runtime artifacts and story metadata are allowed. */
export function nonRuntimeDirtyEntries(classification: DirtyWorktreeClassification): DirtyWorktreeEntry[] {
  return classification.entries.filter(entry => NON_RUNTIME_DIRTY_CATEGORIES.has(entry.category));
}
