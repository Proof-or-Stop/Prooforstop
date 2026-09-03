import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  FINDING_LEDGER_LOCAL_FS_CAPABILITY,
  FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
  FINDING_LEDGER_SCHEMA_EPOCH,
  LedgerRefusal,
  appendLedgerTransaction,
  emptyLedger,
  readLedger,
  recoverLedger,
  type AppendRequest,
  type DurableCommitTrace,
  type JsonValue,
} from '../core/finding-ledger.js';
import { canonicalDigest, generateEd25519KeyPair, verifyCanonical } from '../core/authority-signing.js';
import {
  appendAssessmentProposal,
  appendDeferralExpiryPolicy,
  appendFindingLedger,
  bindLegacyFindingLedgerReceipts,
  canonicalHash,
  canonicalJson,
  classifyMandatoryRepair,
  closeMandatoryRepair,
  createFindingLedgerHandlers,
  exactLedgerRecordHash,
  findingLedgerSignerFromWorkspace,
  findingLedgerTrustFromWorkspace,
  queryFindingLedger,
  RUNTIME_EVIDENCE_BUILD_POLICY_DIGEST,
  RUNTIME_EVIDENCE_PRIVATE_KEY_ENV,
  RUNTIME_EVIDENCE_PUBLIC_KEY_ENV,
  runtimeEvidenceSignerFromWorkspace,
  setRuntimeEvidenceKeyStatusForTest,
  signFindingLedgerReceipt,
  signAssessmentProposal,
  verifyAssessmentProposal,
  verifyFindingLedgerQueryRow,
  verifyFindingLedgerReceipt,
  verifyRuntimeReceiptCarrier,
  type LedgerAppendOptions,
  type LedgerReceiptTrust,
  type LedgerSigner,
} from '../handlers/finding-ledger.js';
import {
  MemoryRuntimeEvidenceBlobStore,
  RUNTIME_REALPATH_POLICY_DIGEST,
  RuntimeEvidenceRefusal,
  createRuntimeEvidenceReceipt,
  executeRuntimeEvidence,
  redactEnvironment,
  signRuntimeEvidenceReceipt,
  verifyRuntimeEvidenceCurrent,
  verifyRuntimeEvidenceReceiptBlobs,
  verifyRuntimeEvidenceReceiptSignature,
  type RuntimeEvidenceReceipt,
  type RuntimeReceiptSigner,
  type RuntimeReceiptTrust,
} from '../core/runtime-evidence-receipt.js';
import {
  RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
  createRuntimeEvidenceBlobStore,
  writeRuntimeEvidenceBlob,
} from '../core/evidence/artifact-store.js';
import {
  acquireMkdirLock,
  captureMkdirLockFence,
} from '../core/mkdir-lock.js';
import {
  acquireMainWriteLock,
  mainWriteLockPath,
} from '../core/main-write-lock.js';
import { StoryStore } from '../core/store.js';
import { createMainRegistry } from '../registry.js';
import { createFindingHandlers } from '../handlers/finding.js';
import { createFindingRuntimeEvidenceHandlers, FINDING_RUNTIME_EVIDENCE_COMMANDS } from '../handlers/finding-runtime-evidence.js';
import { FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT } from '../core/finding-runtime-evidence.js';
import type { HandlerContext } from '../handlers/context.js';
import type { Finding, StoryInfo } from '../core/types.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import {
  PROCESS_FACT_STORY3_PERSISTENCE_ONLY_RECORD_POLICIES,
  PROCESS_FACT_STORY3_FINDING_LIFECYCLE_POLICY,
  PROCESS_FACT_STORY3_RUNTIME_RECEIPT_POLICY,
  getProcessFactRegistryEntry,
} from '../core/process-fact-registry.js';
import { isCommandAllowed } from '../core/config.js';
import {
  REVIEW_RETENTION_PROTOCOL_METADATA_PATHS,
  findLifecycleTransition,
} from '../core/lifecycle-registry.js';
import {
  assertPlanDevDependenciesDone,
  runStoryTransition,
} from '../handlers/transition-orchestrator.js';
import { adapterSessionEnv } from './adapter-session-env.js';

// This smoke launches several fresh CLI processes against one synthetic Story.
// Give every one the same fixture-only host-adapter identity so correctness does
// not depend on ambient session transport fields that validation intentionally
// strips before executing pinned commands.
const RUNTIME_CLI_TEST_SESSION_ENV = adapterSessionEnv(
  'bfe8f-runtime-evidence-smoke',
  'proof-or-stop-implementer',
);
const require = createRequire(import.meta.url);

interface WorkerSpec {
  ledgerFile: string;
  lockDir: string;
  prefix: string;
  count: number;
  recordType: string;
  payloadBase: Record<string, JsonValue>;
  uniqueBindingKey?: string;
}

function request(
  fenceToken: string,
  idempotencyKey: string,
  recordType: string,
  payload: JsonValue,
  uniqueBindingKey?: string,
): AppendRequest<JsonValue> {
  return {
    operation: recordType === 'legacy_identity_binding'
      ? 'append_legacy_identity_binding'
      : `append_${recordType}`,
    idempotencyKey,
    records: [{ recordType, payload, ...(uniqueBindingKey ? { uniqueBindingKey } : {}) }],
    ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH,
    writerCapability: FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
    writerSessionId: `smoke-${process.pid}`,
    writerFenceToken: fenceToken,
    storageCapability: FINDING_LEDGER_LOCAL_FS_CAPABILITY,
  };
}

function appendUnderLock(spec: WorkerSpec): Array<{ recordId: string; receiptId: string }> {
  const committed: Array<{ recordId: string; receiptId: string }> = [];
  for (let index = 0; index < spec.count; index += 1) {
    const lock = acquireMkdirLock(spec.lockDir, {
      label: 'finding ledger smoke worker',
      requireHolderToken: true,
      deadlineMs: 60_000,
      staleMs: 20_000,
    });
    try {
      const fence = captureMkdirLockFence(spec.lockDir);
      const idempotencyKey = `${spec.prefix}:${index}`;
      const payload = spec.uniqueBindingKey
        ? spec.payloadBase as JsonValue
        : { ...spec.payloadBase, writer: spec.prefix, index } as JsonValue;
      const result = appendLedgerTransaction(
        spec.ledgerFile,
        request(fence.writerFenceToken, idempotencyKey, spec.recordType, payload, spec.uniqueBindingKey),
        fence,
      );
      committed.push({ recordId: result.records[0]!.recordId, receiptId: result.receipt.receiptId });
    } finally {
      lock.release();
    }
  }
  return committed;
}

async function runWorkers(specs: WorkerSpec[]): Promise<void> {
  const self = fileURLToPath(import.meta.url);
  await Promise.all(specs.map((spec) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [self, '--ledger-worker', JSON.stringify(spec)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ledger worker exited ${code}: ${stderr || stdout}`));
    });
  })));
}

function signedApplicableProposal(
  privateKey: string,
  publicKey: string,
  authorityDigest: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const issuedAt = '2030-01-01T00:00:00.000Z';
  const findingRef = { storyId: 'B-CAS', findingId: 'B-CAS:F-001', recordId: 'finding-record-001' };
  const dependencyBundleUnsigned = {
    sourceFinding: { ...findingRef, hash: 'finding-hash-001', version: 'v1' },
    proofPolicyDigest: 'proof-policy',
    reviewerAuthorityPolicyDigest: 'reviewer-policy',
    ledgerSnapshotDigest: 'ledger-snapshot',
  };
  return signAssessmentProposal({
    schemaVersion: 1,
    proposalId: 'proposal-001',
    findingRef,
    findingHash: 'finding-hash-001',
    findingVersion: 'v1',
    evaluationScope: 'target_story',
    owner: 'current_story',
    issuedAt,
    expiresAt: '2030-01-01T02:00:00.000Z',
    freshnessPolicyVersion: 'v1',
    maxAgeSeconds: 7200,
    dependencyBundle: {
      digest: canonicalHash(dependencyBundleUnsigned),
      ...dependencyBundleUnsigned,
    },
    evidenceRefs: ['evidence:1'],
    historicalSourceRefs: [],
    protectedSurfaceEvaluation: [],
    reviewRunId: 'review-run-001',
    reviewRound: '1',
    scopeDigest: 'scope-001',
    headHash: 'head-001',
    materialHash: 'material-001',
    storyFilesHash: 'story-files-001',
    runtimeReceiptIds: [],
    assessedBy: 'assessment-authority',
    proposalSigner: {
      actorId: 'assessment-authority', authorityDigest,
      keyId: `assessment-proposal-${canonicalHash({ publicKey }).slice(0, 24)}`,
      algorithm: 'ed25519',
      trustRootDigest: canonicalHash({ profile: 'assessment-proposal-trust-root-v1', publicKey }),
    },
    verdict: 'applicable',
    basis: 'direct_scope',
    currentWitness: { receiptIds: ['runtime-001'], reproduced: true },
    ...overrides,
  }, privateKey);
}

function proposalUnsignedForSmoke(proposal: Record<string, unknown>): Record<string, unknown> {
  const { proposalDigest: _digest, proposalSignature: _signature, ...unsigned } = proposal;
  return unsigned;
}

function runtimeStory(storyId: string): StoryInfo {
  const now = '2030-01-01T00:00:00.000Z';
  return {
    storyId,
    name: 'runtime-evidence-smoke',
    title: 'Runtime evidence smoke',
    description: 'Synthetic DEV story for RuntimeEvidenceReceipt production adapter verification.',
    type: 'chore',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
  };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function parseCliJson(output: string): Record<string, unknown> {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, `runtime CLI output is not JSON: ${output.slice(0, 200)}`);
  return JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
}

function runRuntimeCli(
  repositoryRoot: string,
  projectRoot: string,
  command: 'finding_ledger_query' | 'finding_runtime_evidence_run' | 'finding_runtime_evidence_verify',
  args: Record<string, unknown>,
  signingEnv: Record<string, string>,
): { status: number | null; stdout: string; stderr: string; json?: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'packages', 'main', 'dist', 'cli.js'), command, JSON.stringify(args)], {
    cwd: projectRoot,
    env: { ...process.env, ...RUNTIME_CLI_TEST_SESSION_ENV, ...signingEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.status === 0 ? { json: parseCliJson(result.stdout ?? '') } : {}),
  };
}

function hasProtectedPathSurface(value: unknown, protectedValues: readonly string[]): boolean {
  if (typeof value === 'string') return protectedValues.some((candidate) => candidate && value.includes(candidate));
  if (Array.isArray(value)) return value.some((item) => hasProtectedPathSurface(item, protectedValues));
  if (!value || typeof value !== 'object') return false;
  const forbiddenKeys = new Set([
    'path', 'file', 'directory', 'root', 'realPath', 'absolutePath', 'ledgerPath',
    'lockPath', 'tempPath', 'artifactStoreRoot', 'storagePath',
  ]);
  return Object.entries(value).some(([key, item]) => forbiddenKeys.has(key) || hasProtectedPathSurface(item, protectedValues));
}

function story3VerifierMutationAccepted(repositoryRoot: string, mutation: string): boolean {
  return spawnSync(process.execPath, [join(repositoryRoot, 'scripts', 'verify-process-fact-contract.mjs'), '--quiet'], {
    cwd: repositoryRoot,
    env: { ...process.env, PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION: mutation },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0;
}

async function runStory3DependencyFixture(root: string): Promise<void> {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }, null, 2));
  const dependencyStore = new StoryStore(root);
  const plan = (storyId: string, depends: string[] = []): StoryInfo => ({
    ...runtimeStory(storyId), phase: 'PLAN', depends,
  });
  dependencyStore.writeStory('B-fe8f', plan('B-fe8f'));
  dependencyStore.writeStory('B-03b7', plan('B-03b7', ['B-fe8f']));
  dependencyStore.writeStory('B-e6d9', plan('B-e6d9', ['B-fe8f', 'B-03b7']));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=dependency-smoke', '-c', 'user.email=dependency@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial dependency plans']);
  const transitionCtx: HandlerContext = { store: dependencyStore, root, scanRoot: root };
  const beforeBlockedTransitions = new Map(['B-03b7', 'B-e6d9'].map((storyId) => [
    storyId, canonicalJson(dependencyStore.readStory(storyId)),
  ]));
  await assert.rejects(
    runStoryTransition(transitionCtx, { storyId: 'B-03b7', phase: 'DEV' }),
    /unfinished Story dependencies: B-fe8f\(PLAN\)/,
  );
  await assert.rejects(
    runStoryTransition(transitionCtx, { storyId: 'B-e6d9', phase: 'DEV' }),
    /unfinished Story dependencies: B-fe8f\(PLAN\), B-03b7\(PLAN\)/,
  );
  for (const [storyId, bytes] of beforeBlockedTransitions) {
    assert.equal(canonicalJson(dependencyStore.readStory(storyId)), bytes);
  }
  let transitionWrites = 0;
  const attempt = (storyId: string): string[] => {
    assert.ok(findLifecycleTransition('PLAN', 'DEV'), 'fixture dependency boundary must be a real lifecycle transition');
    const story = dependencyStore.readStory(storyId);
    try {
      assertPlanDevDependenciesDone(dependencyStore, story, 'DEV');
      transitionWrites += 1;
      return [];
    } catch (error) {
      return [...String((error as Error).message).matchAll(/(B-[A-Za-z0-9]+)\(/g)].map((match) => match[1]!);
    }
  };
  assert.deepEqual(attempt('B-03b7'), ['B-fe8f']);
  assert.deepEqual(attempt('B-e6d9'), ['B-fe8f', 'B-03b7']);
  assert.equal(transitionWrites, 0);
  console.log('dependency.lifecycle_gate: PASS B-03b7=blocked_by_B-fe8f B-e6d9=blocked_by_B-fe8f+B-03b7 transitionWrites=0');

  dependencyStore.writeStory('B-fe8f', { ...dependencyStore.readStory('B-fe8f'), phase: 'DONE' });
  assert.deepEqual(attempt('B-03b7'), ['B-fe8f']);
  assert.equal(transitionWrites, 0);
  git(root, ['checkout', '-q', '-b', 'story/B-fe8f']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=dependency-smoke', '-c', 'user.email=dependency@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'partial done dependency']);
  assert.deepEqual(attempt('B-03b7'), ['B-fe8f']);
  assert.equal(transitionWrites, 0);
  git(root, ['checkout', '-q', 'main']);
  git(root, ['merge', '-q', '--ff-only', 'story/B-fe8f']);
  assert.deepEqual(attempt('B-03b7'), []);
  assert.deepEqual(attempt('B-e6d9'), ['B-03b7']);
  dependencyStore.writeStory('B-03b7', { ...dependencyStore.readStory('B-03b7'), phase: 'DONE' });
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=dependency-smoke', '-c', 'user.email=dependency@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'merged second dependency']);
  assert.deepEqual(attempt('B-e6d9'), []);
  assert.equal(transitionWrites, 2);
  console.log('dependency.partial_done_gate: PASS phaseDoneOnly=reject unmergedStoryBranch=reject mergedMainFact=accept transitionWritesBeforeMerge=0');
  console.log('green.lifecycle_dependency_gate: PASS B-03b7=release_after_B-fe8f B-e6d9=release_after_B-fe8f+B-03b7');
}

let sparseProjectionRegressionCompleted = false;

function runFindingProjectionRegression(root: string): void {
  const store = new StoryStore(root);
  const storyId = 'B-SPARSE';
  store.writeStory(storyId, runtimeStory(storyId));
  store.writeFindings(storyId, {
    findings: [
      { id: `${storyId}:F-001`, desc: 'historical one', severity: 'low', category: 'edge', status: 'resolved' },
      { id: `${storyId}:F-003`, desc: 'historical three', severity: 'medium', category: 'missing', status: 'open' },
    ],
  });
  const ctx: HandlerContext = { root, scanRoot: root, store };
  const runtimeFacade = createFindingRuntimeEvidenceHandlers(ctx);
  // The exported command list is the published facade contract: the handler
  // surface, the canonical registry, and the adapter contract must all agree
  // with it exactly, so widening any one of them is caught here.
  assert.deepEqual([...FINDING_RUNTIME_EVIDENCE_COMMANDS].sort(), [
    'finding_runtime_evidence_run',
    'finding_runtime_evidence_verify',
  ]);
  assert.deepEqual(Object.keys(runtimeFacade).sort(), [...FINDING_RUNTIME_EVIDENCE_COMMANDS].sort());
  assert.equal('finding_ledger_query' in runtimeFacade, false);
  assert.ok(FINDING_RUNTIME_EVIDENCE_COMMANDS.includes(FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT.runCommand));
  assert.ok(FINDING_RUNTIME_EVIDENCE_COMMANDS.includes(FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT.verifyCommand));
  const registry = createMainRegistry(ctx);
  assert.equal(registry.has('finding_ledger_query'), true);
  for (const command of FINDING_RUNTIME_EVIDENCE_COMMANDS) assert.equal(registry.has(command), true, `${command} missing from registry`);
  console.log(`registry.runtime_facade_boundary: PASS exactCommands=${FINDING_RUNTIME_EVIDENCE_COMMANDS.length} canonicalRegistry=true adapterContract=true`);

  const handlers = createFindingHandlers(ctx);
  const args = {
    storyId,
    desc: 'new sparse-history regression finding',
    severity: 'medium',
    category: 'edge',
    agent: 'main',
    idempotencyKey: 'finding-add:sparse-history',
  };
  const first = handlers.finding_add(args);
  const replay = handlers.finding_add(args);
  assert.match(first, /Finding B-SPARSE:F-004 created/);
  assert.match(replay, /Finding B-SPARSE:F-004 created/);
  const projection = store.readFindings(storyId);
  assert.deepEqual(projection.findings.map((finding) => finding.id), [
    'B-SPARSE:F-001', 'B-SPARSE:F-003', 'B-SPARSE:F-004',
  ]);
  const ledger = store.readFindingLedger<JsonValue>(storyId);
  assert.equal(ledger.records.filter((record) => record.recordType === 'finding').length, 1);
  assert.equal(ledger.receipts.length, 1);
  const trust = findingLedgerTrustFromWorkspace(root);
  assert.equal(ledger.receipts.every((receipt) => (
    !!(receipt as typeof receipt & { findingLedgerReceipt?: unknown }).findingLedgerReceipt
    && verifyFindingLedgerReceipt(
      (receipt as typeof receipt & { findingLedgerReceipt: ReturnType<typeof appendFindingLedger> }).findingLedgerReceipt,
      trust,
    )
  )), true);
  const query = queryFindingLedger(ledger, storyId, findingLedgerSignerFromWorkspace(root));
  assert.equal(query.signedRows, true);
  assert.equal(query.rows.every((row) => verifyFindingLedgerQueryRow(row, trust)), true);
  const outerRequestDigestTamper = structuredClone(ledger);
  outerRequestDigestTamper.receipts[0]!.requestDigest = '0'.repeat(64);
  let outerRequestDigestAccepted = false;
  try {
    queryFindingLedger(outerRequestDigestTamper, storyId, findingLedgerSignerFromWorkspace(root));
    outerRequestDigestAccepted = true;
  } catch {
    // Expected: the signed receipt must remain bound to the persisted carrier request.
  }
  if (outerRequestDigestAccepted) {
    console.log('query.carrier_request_digest_binding: RED outerMutation=accepted');
  }
  assert.equal(
    outerRequestDigestAccepted,
    false,
    'query accepted a current signed receipt after only the outer carrier requestDigest changed',
  );
  console.log('query.carrier_request_digest_binding: PASS outerMutation=refused legacyQuery=preserved');

  const legacyCrashStoryId = 'B-LEGACY-LIFECYCLE-CRASH';
  store.writeStory(legacyCrashStoryId, runtimeStory(legacyCrashStoryId));
  const legacyOpenFinding: Finding = {
    id: `${legacyCrashStoryId}:F-001`,
    desc: 'legacy terminal transition crash-window regression',
    severity: 'high',
    category: 'edge',
    status: 'open',
  };
  store.writeFindings(legacyCrashStoryId, { findings: [legacyOpenFinding] });
  const legacyMirrorPath = store.storyFilePath(legacyCrashStoryId, 'findings.json');
  const legacyMirrorBytes = readFileSync(legacyMirrorPath, 'utf8');
  const originalWriteFindings = store.writeFindings.bind(store);
  store.writeFindings = (candidateStoryId, candidate) => {
    if (candidateStoryId === legacyCrashStoryId
      && candidate.findings.some((finding) => finding.status === 'resolved')) {
      throw new Error('injected omitted legacy mirror write');
    }
    originalWriteFindings(candidateStoryId, candidate);
  };
  const priorLegacyCrashAgent = process.env.PROOF_OR_STOP_AGENT;
  process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-implementer';
  try {
    assert.throws(() => handlers.finding_resolve({
      storyId: legacyCrashStoryId,
      findingId: legacyOpenFinding.id,
      resolution: 'signed transition committed before legacy mirror write',
      resolutionType: 'fixed',
      resolveEvidenceStrength: 'strong',
    }), /injected omitted legacy mirror write/);
  } finally {
    store.writeFindings = originalWriteFindings;
    if (priorLegacyCrashAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = priorLegacyCrashAgent;
  }
  assert.equal(readFileSync(legacyMirrorPath, 'utf8'), legacyMirrorBytes);
  const legacyCrashLedger = store.readFindingLedger<JsonValue>(legacyCrashStoryId);
  const legacyIdentityBinding = legacyCrashLedger.records.find((record) => (
    record.recordType === 'legacy_identity_binding'
  ))!;
  assert.ok(legacyIdentityBinding, 'kill-window fixture did not commit the legacy identity binding');
  assert.equal(
    legacyCrashLedger.records.filter((record) => record.recordType === 'finding_lifecycle_transition').length,
    1,
    'kill-window fixture did not commit exactly one signed lifecycle transition',
  );
  const legacyCrashProjection = store.readFindings(legacyCrashStoryId).findings[0]!;
  if (legacyCrashProjection.status !== 'resolved') {
    console.log(`finding.lifecycle_legacy_kill_window: RED durableTransition=1 mirrorWrite=omitted projected=${legacyCrashProjection.status}`);
  }
  assert.equal(
    legacyCrashProjection.recordId,
    legacyIdentityBinding.recordId,
    'signed legacy identity binding did not recover the durable recordId after the mirror write was omitted',
  );
  assert.equal(
    legacyCrashProjection.status,
    'resolved',
    'signed legacy terminal transition was lost after the mirror write was omitted',
  );
  originalWriteFindings(legacyCrashStoryId, {
    findings: [{ ...legacyOpenFinding, desc: 'unsigned mirror relabel', recordId: legacyIdentityBinding.recordId }],
  });
  assert.equal(
    store.readFindings(legacyCrashStoryId).findings[0]?.status,
    'open',
    'an unsigned mirror relabel must not acquire signed lifecycle authority',
  );
  console.log('finding.lifecycle_legacy_kill_window: PASS durableTransition=1 mirrorWrite=omitted projected=resolved unsignedMirror=open');
  console.log('finding.sparse_display_id: PASS next=F-004 reused=0 ledgerRows=1');
  const reviewerFindingEvents = store.readProcessEvents(storyId)
    .filter((event) => event.type === 'reviewer_finding' && event.findingId === `${storyId}:F-004`);
  assert.equal(
    reviewerFindingEvents.length,
    1,
    'an idempotent finding_add replay must not duplicate reviewer_finding process facts',
  );
  console.log('finding.idempotency_contract: PASS callerKey=true replayRows=0 processEvents=1 signedQuery=true');

  const ledgerAuthoritativeOpen = store.readFindings(storyId);
  const terminalFindingRecordId = ledgerAuthoritativeOpen.findings
    .find((finding) => finding.id === `${storyId}:F-004`)!.recordId!;
  const mirrorShadowResults: Array<{ variant: string; status: string | undefined; recordId: string | undefined }> = [];
  for (const variant of ['missing', 'wrong'] as const) {
    const shadowedMirror = structuredClone(ledgerAuthoritativeOpen);
    const shadowedFinding = shadowedMirror.findings.find((finding) => finding.id === `${storyId}:F-004`)!;
    shadowedFinding.status = 'resolved';
    shadowedFinding.resolvedAt = '2026-09-01T00:00:00.000Z';
    shadowedFinding.resolvedReason = `unsigned ${variant} recordId shadow`;
    if (variant === 'missing') delete shadowedFinding.recordId;
    else shadowedFinding.recordId = 'lr_unsigned_wrong_record_id';
    delete shadowedFinding.ledgerCommitReceiptId;
    if (!shadowedMirror.findings.some((finding) => finding.id === `${storyId}:F-LEGACY`)) {
      shadowedMirror.findings.push({
        id: `${storyId}:F-LEGACY`,
        desc: 'genuine mirror-only legacy finding',
        severity: 'low',
        category: 'edge',
        status: 'resolved',
      });
    }
    shadowedMirror.findings.push({
      id: `${storyId}:F-004`,
      desc: `duplicate unsigned ${variant} mirror row`,
      severity: 'high',
      category: 'adversarial',
      status: 'open',
      recordId: `lr_unsigned_duplicate_${variant}`,
    });
    store.writeFindings(storyId, shadowedMirror);
    const projectedShadow = store.readFindings(storyId);
    const projectedRows = projectedShadow.findings.filter((finding) => finding.id === `${storyId}:F-004`);
    assert.equal(
      projectedRows.length,
      1,
      'every duplicate mirror row sharing a ledger-backed display id must collapse before a terminal transition',
    );
    const projectedFinding = projectedRows[0]!;
    mirrorShadowResults.push({
      variant,
      status: projectedFinding.status,
      recordId: projectedFinding.recordId,
    });
    assert.equal(
      projectedShadow.findings.find((finding) => finding.id === `${storyId}:F-LEGACY`)?.status,
      'resolved',
      'a distinct genuine mirror-only legacy Finding must remain readable',
    );
  }
  if (mirrorShadowResults.some((result) => result.status !== 'open')) {
    console.log(`finding.lifecycle_mirror_shadow_refused: RED ${mirrorShadowResults.map((result) => `${result.variant}=${result.status}`).join(' ')}`);
  }
  assert.deepEqual(
    mirrorShadowResults.map((result) => result.status),
    ['open', 'open'],
    'a ledger-backed Finding id must remain authoritative when mirror recordId is missing or wrong',
  );
  assert.equal(
    mirrorShadowResults.every((result) => result.recordId === terminalFindingRecordId),
    true,
    'ledger projection must restore the canonical durable recordId for the same Finding id',
  );
  console.log('finding.lifecycle_mirror_shadow_refused: PASS missing=open wrong=open duplicateBefore=collapsed legacyOnly=preserved');

  const terminalMirror = store.readFindings(storyId);
  const terminalFinding = terminalMirror.findings.find((finding) => finding.id === `${storyId}:F-004`)!;
  terminalFinding.status = 'resolved';
  terminalFinding.resolvedAt = '2026-09-01T00:00:00.000Z';
  terminalFinding.resolvedReason = 'fixture terminal transition';
  store.writeFindings(storyId, terminalMirror);
  const rereadTerminal = store.readFindings(storyId).findings
    .find((finding) => finding.id === `${storyId}:F-004`)!;
  assert.equal(
    rereadTerminal.status,
    'open',
    'unsigned mirror bytes must not close a ledger-backed Finding',
  );
  console.log('finding.lifecycle_unsigned_mirror: PASS terminal=open authority=none');

  assert.equal(REVIEW_RETENTION_PROTOCOL_METADATA_PATHS.has('finding-ledger.json'), true);
  const second = handlers.finding_add({ ...args, desc: 'second same-round finding', idempotencyKey: 'finding-add:same-round-2' });
  assert.match(second, /Finding B-SPARSE:F-005 created/);
  assert.equal(store.readFindingLedger<JsonValue>(storyId).records.filter((record) => record.recordType === 'finding').length, 2);
  assert.equal(store.readFindings(storyId).findings.some((finding) => finding.id === 'B-SPARSE:F-005'), true);
  const priorAgent = process.env.PROOF_OR_STOP_AGENT;
  process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-implementer';
  try {
    const resolved = handlers.finding_resolve({
      storyId,
      findingId: `${storyId}:F-004`,
      resolution: 'canonical lifecycle regression resolution',
      resolutionType: 'fixed',
      resolveEvidenceStrength: 'strong',
    });
    const resolvedReplay = handlers.finding_resolve({
      storyId,
      findingId: `${storyId}:F-004`,
      resolution: 'canonical lifecycle regression resolution',
      resolutionType: 'fixed',
      resolveEvidenceStrength: 'strong',
    });
    assert.match(resolved, /resolved/);
    assert.match(resolvedReplay, /resolved/);
    const dismissed = handlers.finding_dismiss({
      storyId,
      findingId: `${storyId}:F-005`,
      reason: 'separate terminal transition regression',
      dismissReasonType: 'out_of_scope',
      dismissEvidenceStrength: 'medium',
    });
    const dismissedReplay = handlers.finding_dismiss({
      storyId,
      findingId: `${storyId}:F-005`,
      reason: 'separate terminal transition regression',
      dismissReasonType: 'out_of_scope',
      dismissEvidenceStrength: 'medium',
    });
    assert.match(dismissed, /dismissed/);
    assert.match(dismissedReplay, /dismissed/);
  } finally {
    if (priorAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = priorAgent;
  }
  const duplicateTerminalMirror = structuredClone(store.readFindings(storyId));
  duplicateTerminalMirror.findings.push({
    id: `${storyId}:F-004`,
    desc: 'duplicate unsigned open mirror row after signed resolution',
    severity: 'high',
    category: 'adversarial',
    status: 'open',
    recordId: 'lr_unsigned_duplicate_after_terminal',
  });
  store.writeFindings(storyId, duplicateTerminalMirror);
  const terminalProjection = store.readFindings(storyId);
  const resolvedProjectionRows = terminalProjection.findings
    .filter((finding) => finding.id === `${storyId}:F-004`);
  assert.equal(
    resolvedProjectionRows.length,
    1,
    'every duplicate mirror row sharing a ledger-backed display id must collapse after a signed terminal transition',
  );
  assert.equal(resolvedProjectionRows[0]?.status, 'resolved');
  assert.equal(resolvedProjectionRows[0]?.recordId, terminalFindingRecordId);
  assert.equal(
    terminalProjection.findings.some((finding) => finding.id === `${storyId}:F-LEGACY`),
    true,
    'a distinct mirror-only legacy id must survive duplicate collapse',
  );
  assert.equal(terminalProjection.findings.find((finding) => finding.id === `${storyId}:F-005`)?.status, 'dismissed');
  console.log('finding.lifecycle_projection: PASS terminal=resolved resurrected=0 duplicateAfter=collapsed legacyOnly=preserved');
  const lifecycleLedger = store.readFindingLedger<JsonValue>(storyId);
  assert.equal(lifecycleLedger.records.filter((record) => record.recordType === 'finding_lifecycle_transition').length, 2);
  assert.equal(lifecycleLedger.receipts.filter((receipt) => receipt.operation === 'append_finding_lifecycle_transition').length, 2);
  assert.equal(queryFindingLedger(lifecycleLedger, storyId, findingLedgerSignerFromWorkspace(root)).signedRows, true);
  console.log('finding.lifecycle_transition: PASS appendOnly=true resolveReplay=stable dismissReplay=stable terminalRows=2 resurrected=0');

  const authorityStoryId = 'B-LIFECYCLE-AUTHORITY';
  store.writeStory(authorityStoryId, runtimeStory(authorityStoryId));
  const authorityHandlers = createFindingHandlers({ root, scanRoot: root, store });
  assert.match(authorityHandlers.finding_add({
    storyId: authorityStoryId,
    desc: 'lifecycle authority carrier regression',
    severity: 'high',
    category: 'adversarial',
    agent: 'main',
    idempotencyKey: 'finding-add:lifecycle-authority',
  }), /Finding B-LIFECYCLE-AUTHORITY:F-001 created/);
  const authorityOpenMirror = structuredClone(store.readFindings(authorityStoryId));
  const priorAuthorityAgent = process.env.PROOF_OR_STOP_AGENT;
  process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-implementer';
  try {
    assert.match(authorityHandlers.finding_resolve({
      storyId: authorityStoryId,
      findingId: `${authorityStoryId}:F-001`,
      resolution: 'signed lifecycle authority regression',
      resolutionType: 'fixed',
      resolveEvidenceStrength: 'strong',
    }), /resolved/);
  } finally {
    if (priorAuthorityAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = priorAuthorityAgent;
  }
  store.writeFindings(authorityStoryId, authorityOpenMirror);
  const authorityLedgerPath = store.findingLedgerPath(authorityStoryId);
  const validAuthorityLedger = store.readFindingLedger<JsonValue>(authorityStoryId);
  const authorityTransition = validAuthorityLedger.records.find((record) => (
    record.recordType === 'finding_lifecycle_transition'
  ))!;
  assert.equal(store.readFindings(authorityStoryId).findings[0]?.status, 'resolved');

  const writeAuthorityCandidate = (candidate: typeof validAuthorityLedger): void => {
    writeFileSync(authorityLedgerPath, `${JSON.stringify(candidate, null, 2)}\n`);
  };
  const expectAuthorityRefusal = (candidate: typeof validAuthorityLedger): void => {
    writeAuthorityCandidate(candidate);
    assert.equal(store.readFindings(authorityStoryId).findings[0]?.status, 'open');
    assert.throws(() => queryFindingLedger(
      store.readFindingLedger<JsonValue>(authorityStoryId),
      authorityStoryId,
      findingLedgerSignerFromWorkspace(root),
    ));
  };

  const unsignedAuthority = structuredClone(validAuthorityLedger) as typeof validAuthorityLedger & {
    receipts: Array<Record<string, unknown>>;
  };
  const unsignedCarrier = unsignedAuthority.receipts.find((receipt) => (
    (receipt.recordIds as string[]).includes(authorityTransition.recordId)
  ))!;
  delete (unsignedCarrier as unknown as Record<string, unknown>).findingLedgerReceipt;
  expectAuthorityRefusal(unsignedAuthority);

  const badSignatureAuthority = structuredClone(validAuthorityLedger) as typeof validAuthorityLedger & {
    receipts: Array<Record<string, unknown>>;
  };
  const badSignatureCarrier = badSignatureAuthority.receipts.find((receipt) => (
    (receipt.recordIds as string[]).includes(authorityTransition.recordId)
  ))!;
  ((badSignatureCarrier as unknown as Record<string, unknown>).findingLedgerReceipt as Record<string, unknown>)
    .signature = 'bad-signature';
  expectAuthorityRefusal(badSignatureAuthority);

  const missingSignedDigestAuthority = structuredClone(validAuthorityLedger) as typeof validAuthorityLedger & {
    receipts: Array<Record<string, unknown>>;
  };
  const missingSignedDigestCarrier = missingSignedDigestAuthority.receipts.find((receipt) => (
    (receipt.recordIds as string[]).includes(authorityTransition.recordId)
  ))!;
  const signedWithDigest = (missingSignedDigestCarrier as unknown as Record<string, unknown>)
    .findingLedgerReceipt as ReturnType<typeof signFindingLedgerReceipt>;
  const {
    exactRequestDigest: _exactRequestDigest,
    receiptHash: _receiptHash,
    signature: _signature,
    ...legacySignedPayload
  } = signedWithDigest;
  const resignedWithoutDigest = signFindingLedgerReceipt(
    legacySignedPayload,
    findingLedgerSignerFromWorkspace(root),
  );
  (missingSignedDigestCarrier as unknown as Record<string, unknown>).findingLedgerReceipt = resignedWithoutDigest;
  assert.equal(
    typeof (missingSignedDigestCarrier as unknown as Record<string, unknown>).exactRequestDigest,
    'string',
  );
  assert.equal(resignedWithoutDigest.exactRequestDigest, undefined);
  assert.equal(verifyFindingLedgerReceipt(resignedWithoutDigest, trust), true);
  writeAuthorityCandidate(missingSignedDigestAuthority);
  assert.equal(
    store.readFindings(authorityStoryId).findings[0]?.status,
    'open',
    'a current-key signed lifecycle receipt without a signed exactRequestDigest must not receive lifecycle authority',
  );
  assert.equal(
    queryFindingLedger(
      store.readFindingLedger<JsonValue>(authorityStoryId),
      authorityStoryId,
      findingLedgerSignerFromWorkspace(root),
    ).signedRows,
    true,
    'legacy receipt compatibility may remain available to the read-only query surface',
  );
  const currentOmissionLockDir = store.storyFilePath(authorityStoryId, 'findings.lock');
  const currentOmissionLock = acquireMkdirLock(currentOmissionLockDir, {
    label: 'current lifecycle omission migration refusal regression', requireHolderToken: true,
  });
  try {
    const fence = captureMkdirLockFence(currentOmissionLockDir);
    assert.equal(bindLegacyFindingLedgerReceipts({
      storyId: authorityStoryId,
      store,
      writerSessionId: 'current-omission-smoke',
      writerLeaseId: 'current-omission-smoke',
      writerFenceToken: fence.writerFenceToken,
      fence,
      signer: findingLedgerSignerFromWorkspace(root),
    }), null, 'a post-boundary current omission must not be eligible for legacy migration');
  } finally {
    currentOmissionLock.release();
  }
  assert.equal(
    store.readFindingLedger<JsonValue>(authorityStoryId).records
      .some((record) => record.recordType === 'legacy_lifecycle_receipt_binding'),
    false,
    'migration appended a legacy binding for a post-boundary current omission',
  );
  console.log('finding.lifecycle_signed_exact_request_digest: PASS missingSigned=open legacyQuery=accepted');

  const tamperedAuthority = structuredClone(validAuthorityLedger);
  const tamperedTransition = tamperedAuthority.records.find((record) => (
    record.recordId === authorityTransition.recordId
  ))!;
  tamperedTransition.payload = {
    ...(tamperedTransition.payload as Record<string, JsonValue>),
    reason: 'tampered transition reason',
  };
  tamperedTransition.payloadHash = canonicalHash(tamperedTransition.payload);
  tamperedAuthority.committedLedgerDigest = canonicalHash(tamperedAuthority.records);
  tamperedAuthority.receipts.at(-1)!.committedLedgerDigest = tamperedAuthority.committedLedgerDigest;
  expectAuthorityRefusal(tamperedAuthority);

  writeAuthorityCandidate(validAuthorityLedger);
  assert.equal(store.readFindings(authorityStoryId).findings[0]?.status, 'resolved');
  console.log('finding.lifecycle_transition_authority: PASS unsigned=open badSignature=open missingSignedExactRequestDigest=open tampered=open signed=resolved exactCas=true');

  const preUpgradeAuthority = structuredClone(validAuthorityLedger) as typeof validAuthorityLedger & {
    receipts: Array<Record<string, unknown>>;
  };
  const preUpgradeCarrier = preUpgradeAuthority.receipts.find((receipt) => (
    (receipt.recordIds as string[]).includes(authorityTransition.recordId)
  ))!;
  const preUpgradeSigned = (preUpgradeCarrier as unknown as Record<string, unknown>)
    .findingLedgerReceipt as ReturnType<typeof signFindingLedgerReceipt>;
  const {
    exactRequestDigest: _preUpgradeExactRequestDigest,
    receiptHash: _preUpgradeReceiptHash,
    signature: _preUpgradeSignature,
    ...preUpgradeUnsigned
  } = preUpgradeSigned;
  (preUpgradeCarrier as unknown as Record<string, unknown>).findingLedgerReceipt = signFindingLedgerReceipt(
    preUpgradeUnsigned,
    findingLedgerSignerFromWorkspace(root),
  );
  const preUpgradeSourceCarrier = preUpgradeAuthority.receipts.find((receipt) => (
    receipt.receiptId !== (preUpgradeCarrier as unknown as { receiptId: string }).receiptId
    && receipt.recordIds.includes((authorityTransition.payload as Record<string, string>).findingRecordId)
  )) as typeof preUpgradeAuthority.receipts[number] & {
    findingLedgerReceipt: ReturnType<typeof signFindingLedgerReceipt>;
  };
  const {
    exactRequestDigest: _preUpgradeSourceExactRequestDigest,
    receiptHash: _preUpgradeSourceReceiptHash,
    signature: _preUpgradeSourceSignature,
    ...preUpgradeSourceUnsigned
  } = preUpgradeSourceCarrier.findingLedgerReceipt;
  preUpgradeSourceCarrier.findingLedgerReceipt = signFindingLedgerReceipt(
    preUpgradeSourceUnsigned,
    findingLedgerSignerFromWorkspace(root),
  );
  writeAuthorityCandidate(preUpgradeAuthority);
  store.writeFindings(authorityStoryId, authorityOpenMirror);
  const preMigrationProjection = store.readFindings(authorityStoryId).findings
    .find((finding) => finding.id === `${authorityStoryId}:F-001`)!;
  assert.equal(
    preMigrationProjection.status,
    'open',
    'a pre-upgrade lifecycle receipt without a current re-attestation must fail closed',
  );
  assert.match(authorityHandlers.finding_add({
    storyId: authorityStoryId,
    desc: 'strict successor proving the pre-upgrade lifecycle boundary',
    severity: 'low',
    category: 'edge',
    agent: 'main',
    idempotencyKey: 'finding-add:post-upgrade-boundary',
  }), /Finding B-LIFECYCLE-AUTHORITY:F-002 created/);
  assert.equal(
    store.readFindings(authorityStoryId).findings
      .find((finding) => finding.id === `${authorityStoryId}:F-001`)?.status,
    'open',
    'the strict successor boundary alone must not grant legacy lifecycle authority',
  );
  console.log('finding.lifecycle_preupgrade_pre_migration: PASS outerExact=true signedExact=false strictSuccessor=true binding=absent projected=open');
  const historicalTransitionBytes = canonicalJson({
    carrier: preUpgradeCarrier,
    record: preUpgradeAuthority.records.find((record) => record.recordId === authorityTransition.recordId),
  });
  const migrationLockDir = store.storyFilePath(authorityStoryId, 'findings.lock');
  const runLifecycleMigration = (): void => {
    const migrationLock = acquireMkdirLock(migrationLockDir, {
      label: 'pre-upgrade lifecycle re-attestation regression', requireHolderToken: true,
    });
    try {
      const fence = captureMkdirLockFence(migrationLockDir);
      bindLegacyFindingLedgerReceipts({
        storyId: authorityStoryId,
        store,
        writerSessionId: 'f029-migration-smoke',
        writerLeaseId: 'f029-migration-smoke',
        writerFenceToken: fence.writerFenceToken,
        fence,
        signer: findingLedgerSignerFromWorkspace(root),
      });
    } finally {
      migrationLock.release();
    }
  };
  runLifecycleMigration();
  const migratedPreUpgradeLedger = store.readFindingLedger<JsonValue>(authorityStoryId);
  const bindingRecords = migratedPreUpgradeLedger.records.filter((record) => (
    record.recordType === 'legacy_lifecycle_receipt_binding'
  ));
  assert.equal(bindingRecords.length, 1, 'migration must append exactly one lifecycle re-attestation set');
  const migratedHistoricalCarrier = migratedPreUpgradeLedger.receipts.find((receipt) => (
    receipt.receiptId === (preUpgradeCarrier as unknown as { receiptId: string }).receiptId
  ))!;
  assert.equal(canonicalJson({
    carrier: migratedHistoricalCarrier,
    record: migratedPreUpgradeLedger.records.find((record) => record.recordId === authorityTransition.recordId),
  }), historicalTransitionBytes, 'migration rewrote immutable historical transition bytes');
  const migratedCounts = {
    records: migratedPreUpgradeLedger.records.length,
    receipts: migratedPreUpgradeLedger.receipts.length,
  };
  runLifecycleMigration();
  assert.deepEqual({
    records: store.readFindingLedger<JsonValue>(authorityStoryId).records.length,
    receipts: store.readFindingLedger<JsonValue>(authorityStoryId).receipts.length,
  }, migratedCounts, 'lifecycle re-attestation replay appended duplicate rows');

  const currentLedgerSigner = findingLedgerSignerFromWorkspace(root);
  const resignBindingCandidate = (
    candidate: typeof migratedPreUpgradeLedger,
    signer: LedgerSigner = currentLedgerSigner,
  ): void => {
    const record = candidate.records.find((entry) => (
      entry.recordType === 'legacy_lifecycle_receipt_binding'
    ))!;
    const payload = record.payload as Record<string, JsonValue>;
    const idempotencyKey = `legacy-lifecycle-binding:${canonicalHash(payload.bindings)}`;
    record.idempotencyKey = idempotencyKey;
    record.uniqueBindingKey = idempotencyKey;
    record.payloadHash = canonicalHash(record.payload);
    const carrier = candidate.receipts.find((entry) => entry.recordIds.includes(record.recordId)) as (
      typeof candidate.receipts[number] & {
        exactRequestDigest?: string;
        findingLedgerReceipt?: ReturnType<typeof signFindingLedgerReceipt>;
      }
    );
    carrier.idempotencyKey = idempotencyKey;
    carrier.requestDigest = canonicalHash({
      operation: carrier.operation,
      idempotencyKey,
      records: [{
        recordType: record.recordType,
        payload: record.payload,
        uniqueBindingKey: record.uniqueBindingKey,
      }],
      ledgerSchemaEpoch: candidate.ledgerSchemaEpoch,
      writerCapability: candidate.minimumWriterCapability,
    });
    const exactRequestDigest = canonicalHash({
      storyId: payload.storyId,
      operation: carrier.operation,
      idempotencyKey,
      records: [{
        recordType: record.recordType,
        payload: record.payload,
        uniqueBindingKey: record.uniqueBindingKey,
      }],
      casBindings: [],
      expectedPriorLedgerDigest: payload.observedLedgerDigest,
    });
    candidate.committedLedgerDigest = canonicalHash(candidate.records);
    carrier.exactRequestDigest = exactRequestDigest;
    carrier.committedLedgerDigest = candidate.committedLedgerDigest;
    const priorSigned = carrier.findingLedgerReceipt!;
    const {
      receiptHash: _candidateReceiptHash,
      signature: _candidateSignature,
      ...priorUnsigned
    } = priorSigned;
    carrier.findingLedgerReceipt = signFindingLedgerReceipt({
      ...priorUnsigned,
      storyId: String(payload.storyId),
      idempotencyKey,
      exactRequestDigest,
      committedLedgerDigest: candidate.committedLedgerDigest,
      keyId: signer.keyId,
      trustRootDigest: signer.trustRootDigest,
      keyFreshnessPolicyDigest: signer.keyFreshnessPolicyDigest,
    }, signer);
  };
  const expectLegacyBindingRefusal = (
    label: string,
    mutate: (candidate: typeof migratedPreUpgradeLedger, binding: Record<string, unknown>) => void,
    signer: LedgerSigner = currentLedgerSigner,
  ): void => {
    const candidate = structuredClone(migratedPreUpgradeLedger);
    const bindingRecord = candidate.records.find((record) => (
      record.recordType === 'legacy_lifecycle_receipt_binding'
    ))!;
    mutate(candidate, bindingRecord.payload as Record<string, unknown>);
    resignBindingCandidate(candidate, signer);
    writeAuthorityCandidate(candidate);
    let projectedStatus: string | undefined;
    try {
      projectedStatus = store.readFindings(authorityStoryId).findings
        .find((finding) => finding.id === `${authorityStoryId}:F-001`)?.status;
    } catch {
      // Invalid envelopes and invalid current signatures are both fail-closed.
    }
    assert.notEqual(projectedStatus, 'resolved', `${label} binding received lifecycle authority`);
  };
  const bindingEntry = (payload: Record<string, unknown>): Record<string, unknown> => (
    (payload.bindings as Array<Record<string, unknown>>)[0]!
  );
  expectLegacyBindingRefusal('wrong receipt', (_candidate, payload) => {
    bindingEntry(payload).receiptId = 'wrong-receipt';
  });
  expectLegacyBindingRefusal('wrong transition hash', (_candidate, payload) => {
    bindingEntry(payload).transitionRecordHash = '0'.repeat(64);
  });
  expectLegacyBindingRefusal('wrong story', (_candidate, payload) => {
    payload.storyId = 'B-WRONG-STORY';
  });
  const attackerPair = generateEd25519KeyPair();
  const attackerSigner: LedgerSigner = {
    privateKey: attackerPair.privateKey,
    publicKey: attackerPair.publicKey,
    keyId: `retired-${canonicalHash({ publicKey: attackerPair.publicKey }).slice(0, 24)}`,
    trustRootDigest: canonicalHash({ profile: 'retired-ledger-key', publicKey: attackerPair.publicKey }),
    keyFreshnessPolicyDigest: currentLedgerSigner.keyFreshnessPolicyDigest,
  };
  expectLegacyBindingRefusal('wrong current key', () => {}, attackerSigner);
  expectLegacyBindingRefusal('wrong chain', (_candidate, payload) => {
    bindingEntry(payload).priorLedgerDigest = '1'.repeat(64);
  });
  expectLegacyBindingRefusal('partial', (_candidate, payload) => {
    delete bindingEntry(payload).findingRecordHash;
  });
  expectLegacyBindingRefusal('duplicate', (_candidate, payload) => {
    (payload.bindings as Array<Record<string, unknown>>).push(structuredClone(bindingEntry(payload)));
  });
  writeAuthorityCandidate(migratedPreUpgradeLedger);
  const historicalProjection = store.readFindings(authorityStoryId).findings
    .find((finding) => finding.id === `${authorityStoryId}:F-001`)!;
  assert.equal(
    historicalProjection.status,
    'resolved',
    'pre-upgrade signed lifecycle transition was not restored by an append-only current-trust re-attestation',
  );
  console.log('finding.lifecycle_preupgrade_reattestation: PASS preMigration=open currentReattestation=valid immutableBytes=true replayRows=0 projected=resolved');
  console.log('finding.lifecycle_preupgrade_adversarial: PASS noBinding=reject wrongReceipt=reject wrongHash=reject wrongStory=reject wrongKey=reject wrongChain=reject partial=reject duplicate=reject currentOmission=open');
  sparseProjectionRegressionCompleted = true;
  console.log('lifecycle.finding_ledger_retention: PASS consecutiveFindings=2 authority=none');
}

function runRealBfe8fLifecycleMigrationRegression(repositoryRoot: string, scratch: string): void {
  const historicalCommit = 'bed6e0bf392bd2b082787994ae17304809631376';
  const ledgerText = git(repositoryRoot, [
    'show', `${historicalCommit}:.proof-or-stop/story/actives/B-fe8f/finding-ledger.json`,
  ]);
  const corpusRoot = join(scratch, 'f029-real-bfe8f-corpus');
  const corpusStore = new StoryStore(corpusRoot);
  const storyId = 'B-fe8f';
  mkdirSync(corpusStore.storyDirPath(storyId), { recursive: true });
  writeFileSync(corpusStore.findingLedgerPath(storyId), `${ledgerText}\n`);
  writeFileSync(corpusStore.storyFilePath(storyId, 'findings.json'), '{"findings":[]}\n');
  const commonDirRaw = git(repositoryRoot, ['rev-parse', '--git-common-dir']);
  const commonDir = resolve(repositoryRoot, commonDirRaw);
  const corpusKeyDir = join(corpusRoot, '.proof-or-stop', 'keys');
  mkdirSync(corpusKeyDir, { recursive: true });
  writeFileSync(
    join(corpusKeyDir, 'proof-or-stop-finding-ledger-v1.key'),
    readFileSync(join(commonDir, 'proof-or-stop-finding-ledger-v1.key')),
    { mode: 0o600 },
  );

  const before = corpusStore.readFindingLedger<JsonValue>(storyId);
  const recordsById = new Map(before.records.map((record) => [record.recordId, record]));
  const historicalCarriers = before.receipts.filter((carrier) => {
    const signed = (carrier as typeof carrier & {
      findingLedgerReceipt?: { exactRequestDigest?: string };
    }).findingLedgerReceipt;
    return carrier.operation === 'append_finding_lifecycle_transition'
      && typeof (carrier as typeof carrier & { exactRequestDigest?: string }).exactRequestDigest === 'string'
      && signed?.exactRequestDigest === undefined;
  });
  const historicalFindingIds = historicalCarriers.map((carrier) => (
    (recordsById.get(carrier.recordIds[0]!)!.payload as Record<string, string>).findingId
  ));
  assert.equal(historicalCarriers.length, 16, 'immutable B-fe8f corpus lost its 16 pre-upgrade lifecycle receipts');
  assert.equal(
    historicalFindingIds.every((findingId) => (
      corpusStore.readFindings(storyId).findings.find((finding) => finding.id === findingId)?.status === 'open'
    )),
    true,
    'pre-upgrade B-fe8f corpus did not reproduce the terminal projection loss',
  );
  const historicalBytes = canonicalJson(historicalCarriers);
  const migrationLockDir = corpusStore.storyFilePath(storyId, 'findings.lock');
  const migrate = (): void => {
    const lock = acquireMkdirLock(migrationLockDir, {
      label: 'real B-fe8f lifecycle migration regression', requireHolderToken: true,
    });
    try {
      const fence = captureMkdirLockFence(migrationLockDir);
      bindLegacyFindingLedgerReceipts({
        storyId,
        store: corpusStore,
        writerSessionId: 'f029-real-corpus-smoke',
        writerLeaseId: 'f029-real-corpus-smoke',
        writerFenceToken: fence.writerFenceToken,
        fence,
        signer: findingLedgerSignerFromWorkspace(corpusRoot),
      });
    } finally {
      lock.release();
    }
  };
  migrate();
  const after = corpusStore.readFindingLedger<JsonValue>(storyId);
  assert.equal(after.records.filter((record) => record.recordType === 'legacy_lifecycle_receipt_binding').length, 1);
  assert.equal(canonicalJson(after.receipts.filter((carrier) => (
    historicalCarriers.some((historical) => historical.receiptId === carrier.receiptId)
  ))), historicalBytes, 'real B-fe8f migration rewrote historical carrier bytes');
  const projection = corpusStore.readFindings(storyId);
  assert.equal(
    historicalFindingIds.every((findingId) => (
      ['resolved', 'dismissed'].includes(projection.findings.find((finding) => finding.id === findingId)?.status ?? '')
    )),
    true,
    'real B-fe8f terminal projection was not restored after current-trust migration',
  );
  const migratedCounts = { records: after.records.length, receipts: after.receipts.length };
  migrate();
  const replayed = corpusStore.readFindingLedger<JsonValue>(storyId);
  assert.deepEqual(
    { records: replayed.records.length, receipts: replayed.receipts.length },
    migratedCounts,
    'real B-fe8f migration replay appended rows',
  );
  console.log('finding.lifecycle_real_bfe8f_corpus: PASS historical=16 preMigration=open postMigration=terminal immutableBytes=true replayRows=0');
}

function readTreeText(root: string): string {
  if (!existsSync(root)) return '';
  const chunks: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) chunks.push(readTreeText(path));
    else if (entry.isFile()) chunks.push(readFileSync(path).toString('utf8'));
  }
  return chunks.join('\n');
}

function unsignedRuntimeReceipt(receipt: RuntimeEvidenceReceipt): Omit<RuntimeEvidenceReceipt, 'receiptHash' | 'signature'> {
  const { receiptHash: _hash, signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

function assertRedGreenRelation(repositoryRoot: string): void {
  const redPath = join(repositoryRoot, 'packages', 'main', 'tests', 'red', 'red-bfe8f-ledger-runtime-integrity.mjs');
  const immutableRedBlob = '1b913dab2f52e904afc1b7b1870a3a98be0739bc';
  const immutableRed = git(repositoryRoot, ['cat-file', 'blob', immutableRedBlob]);
  const historicalAllocatorAssertion = immutableRed.split('\n').find((line) => (
    line.includes('pre-GREEN Finding ID baseline changed without the accepted allocator')
  ));
  assert.ok(historicalAllocatorAssertion, 'immutable RED blob lost the reviewed allocator assertion');
  assert.equal(
    historicalAllocatorAssertion.replaceAll('\\', '').includes(
      'assert.match(findingSource, /const nextNum = data.findings.length + 1;/',
    ),
    true,
    'immutable RED blob lost the old allocator sentinel',
  );
  const pinnedSelectors = [
    'red.audit_summary:',
    'red.genuine_contract_failure:',
    'red.production_unchanged: PASS',
    'red.official_evidence_create: PASS',
    'red.relation_create: PASS unchangedAssertionBound=true',
    'red.no_fabricated_race: PASS',
    'red.evidence_binding: PASS',
    'red.primitive_scope: PASS',
    'red.relation_evaluate: PASS baselineFails=true currentFails=true assertionUnchanged=true',
    'red.mutation_isolation: PASS',
    'red.reproducibility_guard: PASS',
    'red.green_substitution_refused: PASS',
    'red.relation_mutation_refused: PASS',
  ];
  const current = spawnSync(process.execPath, [redPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(current.status, 0, `current historical RED/GREEN verifier failed: ${current.stderr}`);
  for (const selector of pinnedSelectors) {
    assert.match(current.stdout, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const arbitraryCwd = mkdtempSync(join(tmpdir(), 'bfe8f-red-arbitrary-cwd-'));
  try {
    const arbitrary = spawnSync(process.execPath, [redPath], {
      cwd: arbitraryCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(arbitrary.status, 0, `arbitrary-cwd historical verifier failed: ${arbitrary.stderr}`);
    for (const selector of pinnedSelectors) assert.ok(arbitrary.stdout.includes(selector));
  } finally {
    rmSync(arbitraryCwd, { recursive: true, force: true });
  }
  const productionFindingHandler = readFileSync(
    join(repositoryRoot, 'packages', 'main', 'src', 'handlers', 'finding.ts'),
    'utf8',
  );
  assert.doesNotMatch(productionFindingHandler, /const nextNum = data\.findings\.length \+ 1;/);
  assert.match(productionFindingHandler, /const historicalDisplayIds = \[/);
  assert.match(productionFindingHandler, /historicalDisplayIds\.reduce\(\(max, candidate\) =>/);
  assert.equal(
    sparseProjectionRegressionCompleted,
    true,
    'sparse F-001/F-003 -> F-004 projection regression did not execute before RED/GREEN evaluation',
  );
  console.log('green.red_green_relation_evaluate: PASS baselineFails=true currentPasses=true assertionUnchanged=true coreContractsPass=true immutableBlob=true sparseAllocatorSupersedesBaseline=true');
  console.log('green.red_historical_anchor_verifier: PASS exactBaselineCheckout=true expectedFailure=ERR_MODULE_NOT_FOUND currentGreenImport=true arbitraryCwdAccepted=false');
}

function assertVersionSync(repositoryRoot: string): void {
  const previous = '0.3.272';
  const expected = '0.3.273';
  const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { version: string };
  const mainPackage = JSON.parse(readFileSync(join(repositoryRoot, 'packages', 'main', 'package.json'), 'utf8')) as { version: string };
  const lockfile = JSON.parse(readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8')) as {
    version: string;
    packages?: Record<string, { version?: string }>;
  };
  const runtimeConstant = readFileSync(join(repositoryRoot, 'packages', 'main', 'src', 'core', 'proof-or-stop-brand.ts'), 'utf8');
  const parts = (value: string): number[] => value.split('.').map((part) => Number(part));
  const [previousMajor, previousMinor, previousPatch] = parts(previous);
  const [major, minor, patch] = parts(expected);
  assert.deepEqual([major, minor, patch], [previousMajor, previousMinor, (previousPatch ?? -1) + 1]);
  assert.equal(rootPackage.version, expected);
  assert.equal(mainPackage.version, expected);
  assert.equal(lockfile.version, expected);
  assert.equal(lockfile.packages?.['']?.version, expected);
  assert.match(runtimeConstant, /PROOF_OR_STOP_CLI_VERSION = '0\.3\.273' as const/);

  const local = spawnSync(process.execPath, [join(repositoryRoot, 'packages', 'main', 'dist', 'cli.js'), '--version'], {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(local.status, 0, `local CLI version failed: ${local.stderr}`);
  assert.match(local.stdout, /Proof-or-Stop 0\.3\.273/);
  const installed = spawnSync('proof-or-stop', ['--version'], {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(installed.status, 0, `installed CLI version failed: ${installed.stderr}`);
  // The installed binary is only required to carry the bumped version once the
  // Story has merged back to main and main has been rebuilt; inside a linked
  // story worktree it legitimately still resolves to the main checkout at the
  // previous patch. Any other version means the install is desynchronized.
  const installedVersion = /Proof-or-Stop (\d+\.\d+\.\d+)/.exec(installed.stdout)?.[1];
  assert.ok(installedVersion === expected || installedVersion === previous,
    `installed CLI version ${installedVersion ?? installed.stdout.trim()} is neither ${expected} nor the pre-merge ${previous}`);
  // installedCli=true reports that the installed-binary assertion above held;
  // installedState says which of the two legitimate versions it observed.
  const installedState = installedVersion === expected ? 'bumped' : 'main-checkout-pending-merge';
  console.log(`green.version_sync: PASS patchIncrement=1 rootPackage=true mainPackage=true lockfile=true runtimeConstant=true localCli=true installedCli=true installedState=${installedState}`);
}

function assertCleanPackInstall(repositoryRoot: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'bfe8f-clean-pack-'));
  const consumer = join(scratch, 'consumer');
  try {
    mkdirSync(consumer, { recursive: true });
    // Lab is an independently versioned sibling package that core depends on by
    // exact version; it is supplied as a local tarball (never fetched from a
    // registry) so the clean-install proof stays offline and deterministic.
    const packages = ['main', 'lab'] as const;
    const tarballs: Record<string, string> = {};
    for (const directory of packages) {
      const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch, '.'], {
        cwd: join(repositoryRoot, 'packages', directory),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(packed.status, 0, `npm pack ${directory} failed: ${packed.stderr}\n${packed.stdout}`);
      const records = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      assert.equal(records.length, 1, `npm pack ${directory} did not emit exactly one tarball`);
      tarballs[directory] = join(scratch, records[0].filename);
      assert.ok(existsSync(tarballs[directory]), `npm pack ${directory} tarball missing`);
    }
    const tarListing = spawnSync('tar', ['-tf', tarballs.main], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(tarListing.status, 0, `tar listing failed: ${tarListing.stderr}`);
    assert.match(tarListing.stdout, /^package\/dist\/cli\.js$/m);
    assert.doesNotMatch(tarListing.stdout, /package\/node_modules\//, 'core tarball must not bundle sibling packages');
    const initialized = spawnSync('npm', ['init', '-y'], {
      cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(initialized.status, 0, `clean consumer init failed: ${initialized.stderr}`);
    const installed = spawnSync('npm', [
      'install', tarballs.lab, tarballs.main, '--ignore-scripts', '--no-audit', '--no-fund', '--offline',
    ], {
      cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(installed.status, 0, `clean tarball install failed: ${installed.stderr}\n${installed.stdout}`);
    const core = JSON.parse(readFileSync(join(consumer, 'node_modules', '@proof-or-stop', 'core', 'package.json'), 'utf8')) as {
      name: string; dependencies?: Record<string, string>;
    };
    const lab = JSON.parse(readFileSync(join(consumer, 'node_modules', '@proof-or-stop', 'lab', 'package.json'), 'utf8')) as {
      name: string; version: string;
    };
    assert.equal(core.name, '@proof-or-stop/core');
    assert.equal(lab.name, '@proof-or-stop/lab');
    assert.equal(core.dependencies?.['@proof-or-stop/lab'], lab.version, 'installed lab must satisfy the exact core dependency');
    const cli = spawnSync(join(consumer, 'node_modules', '.bin', 'proof-or-stop'), ['--version'], {
      cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(cli.status, 0, `clean-installed CLI failed: ${cli.stderr}`);
    assert.match(cli.stdout, /Proof-or-Stop 0\.3\.273/);
    console.log('green.clean_pack_install: PASS core=@proof-or-stop/core lab=@proof-or-stop/lab bundled=false registryFetch=false cli=true');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runRollbackKillSwitchMatrix(scratch: string): void {
  const ledgerFile = join(scratch, 'rollback', 'finding-ledger.json');
  const lockDir = join(scratch, 'locks', 'rollback.lock');
  const lock = acquireMkdirLock(lockDir, { label: 'rollback kill-switch', requireHolderToken: true });
  try {
    const fence = captureMkdirLockFence(lockDir);
    appendLedgerTransaction(
      ledgerFile,
      request(fence.writerFenceToken, 'rollback:seed', 'finding', { id: 'history-before-kill-switch' }),
      fence,
    );
    const committedBefore = readFileSync(ledgerFile, 'utf8');
    const unsupported = request(fence.writerFenceToken, 'rollback:unsupported', 'finding', { id: 'must-not-commit' });
    assert.throws(() => appendLedgerTransaction(
      ledgerFile,
      { ...unsupported, ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH + 1 },
      fence,
    ), /SCHEMA_EPOCH_UNSUPPORTED|schema epoch/i);
    assert.equal(readFileSync(ledgerFile, 'utf8'), committedBefore, 'kill-switch refusal changed committed history');
    const restored = appendLedgerTransaction(
      ledgerFile,
      request(fence.writerFenceToken, 'rollback:restored', 'finding', { id: 'supported-after-rollback' }),
      fence,
    );
    assert.equal(restored.action, 'append');
  } finally {
    lock.release();
  }
  const recovered = readLedger(ledgerFile);
  assert.deepEqual(recovered.records.map((record) => (record.payload as Record<string, JsonValue>).id), [
    'history-before-kill-switch', 'supported-after-rollback',
  ]);
  console.log('green.rollback_kill_switch: PASS dataLoss=0');
}

async function runCombinedConcurrencyMatrix(scratch: string): Promise<void> {
  const ledgerFile = join(scratch, 'combined', 'finding-ledger.json');
  const lockDir = join(scratch, 'locks', 'combined.lock');
  const specs: WorkerSpec[] = ['finding', 'candidate_route', 'assessment', 'manifest'].map((recordType, index) => ({
    ledgerFile,
    lockDir,
    prefix: `combined-${index}`,
    count: 5,
    recordType,
    payloadBase: { matrix: 'combined', ref: 'root' },
  }));
  const workers = runWorkers(specs);

  // These independent writes run while the external ledger workers contend,
  // covering the repository's separate process-event and B-META lock trees.
  const activityStore = new StoryStore(join(scratch, 'combined-activity'));
  activityStore.writeStory('B-COMBINED', runtimeStory('B-COMBINED'));
  for (let index = 0; index < 8; index += 1) {
    activityStore.appendProcessEvent('B-COMBINED', {
      type: 'verification', storyId: 'B-COMBINED', command: `combined-${index}`, role: 'main', result: 'pass',
    });
  }
  const metaLock = acquireMainWriteLock(join(scratch, 'combined-activity'), {
    label: 'combined B-META append', onContention: 'wait',
  });
  try {
    const fence = captureMkdirLockFence(metaLock.lockDir);
    appendLedgerTransaction(
      activityStore.storyFilePath('B-META-combined', 'finding-ledger.json'),
      request(fence.writerFenceToken, 'combined:meta', 'finding', { id: 'B-META-combined:F-001' }),
      fence,
    );
  } finally {
    metaLock.release();
  }

  const crashLock = acquireMkdirLock(lockDir, {
    label: 'combined crash injection', requireHolderToken: true, deadlineMs: 60_000,
  });
  try {
    const fence = captureMkdirLockFence(lockDir);
    assert.throws(() => appendLedgerTransaction(
      ledgerFile,
      request(fence.writerFenceToken, 'combined:crash', 'manifest', { id: 'half-visible' }),
      fence,
      { beforeRename: () => { throw new Error('combined crash injection'); } },
    ), /combined crash injection/);
  } finally {
    crashLock.release();
  }
  await workers;

  const beforeReplay = readLedger(ledgerFile);
  assert.equal(beforeReplay.records.length, 20);
  assert.equal(beforeReplay.receipts.length, 20);
  assert.equal(new Set(beforeReplay.records.map((record) => record.recordId)).size, 20);
  assert.equal(beforeReplay.records.some((record) => canonicalJson(record.payload).includes('half-visible')), false);
  const replayLock = acquireMkdirLock(lockDir, { label: 'combined replay', requireHolderToken: true });
  try {
    const fence = captureMkdirLockFence(lockDir);
    for (const record of beforeReplay.records) {
      const replay = appendLedgerTransaction(
        ledgerFile,
        request(fence.writerFenceToken, record.idempotencyKey, record.recordType, record.payload),
        fence,
      );
      assert.equal(replay.action, 'replay');
    }
  } finally {
    replayLock.release();
  }
  const afterReplay = readLedger(ledgerFile);
  assert.equal(afterReplay.records.length, 20);
  assert.equal(afterReplay.receipts.length, 20);
  assert.equal(activityStore.readProcessEvents('B-COMBINED').length, 8);
  assert.equal(activityStore.readFindingLedger('B-META-combined').records.length, 1);
  console.log('green.combined_concurrency: PASS lost=0 duplicates=0 halfVisible=0 deadlocks=0');
}

function runFailClosedBoundaryMatrix(scratch: string): void {
  const ledgerFile = join(scratch, 'fail-closed', 'finding-ledger.json');
  const lockDir = join(scratch, 'locks', 'fail-closed.lock');
  const lock = acquireMkdirLock(lockDir, { label: 'fail-closed boundary', requireHolderToken: true });
  try {
    const fence = captureMkdirLockFence(lockDir);
    const base = request(fence.writerFenceToken, 'fail-closed', 'finding', { id: 'unsafe' });
    const unsafeRequests: AppendRequest<JsonValue>[] = [
      { ...base, storageCapability: 'nfs-multi-host' },
      { ...base, ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH + 1 },
      { ...base, writerCapability: 'unsupported-writer-v0' },
    ];
    const refusals = unsafeRequests.map((attempt) => {
      try {
        appendLedgerTransaction(ledgerFile, attempt, fence);
        return false;
      } catch (error) {
        return error instanceof LedgerRefusal;
      }
    });
    assert.deepEqual(refusals, [true, true, true]);
  } finally {
    lock.release();
  }
  assert.equal(existsSync(ledgerFile), false, 'an unsafe boundary request wrote a ledger');
  console.log('green.fail_closed_boundary: PASS unsafeWrites=0');
}

function runAggregateTamperMatrix(repositoryRoot: string): void {
  const mutations = [
    'story3-promote-query-l4',
    'story3-promote-runtime-run-l4',
    'story3-drop-runtime-freshness',
    'story3-unregistered-direct-consumer',
  ];
  const lifecycleBefore = git(repositoryRoot, ['status', '--porcelain=v1']);
  assert.equal(mutations.filter((mutation) => story3VerifierMutationAccepted(repositoryRoot, mutation)).length, 0);
  assert.equal(git(repositoryRoot, ['status', '--porcelain=v1']), lifecycleBefore, 'mutation verifier changed lifecycle/worktree state');
  console.log('green.tamper_matrix: PASS lifecycleDelta=0');
}

function runDependencyScorecardBoundary(repositoryRoot: string): void {
  const query = getProcessFactRegistryEntry('finding_ledger_query');
  assert.ok(query);
  assert.equal(query.level, 'L0');
  assert.equal(query.consumerGate, undefined);
  assert.equal(query.semantics.includes('gate-evidence'), false);
  assert.equal(story3VerifierMutationAccepted(repositoryRoot, 'story3-forbidden-story2-import'), false);
  assert.equal(story3VerifierMutationAccepted(repositoryRoot, 'story3-forbidden-story1-import'), false);
  assert.equal(story3VerifierMutationAccepted(repositoryRoot, 'story3-query-path-leak'), false);
  console.log('green.dependency_scorecard_boundary: PASS');
}

function runBuildLockFifoRegression(repositoryRoot: string, scratch: string): void {
  const buildLockPath = join(repositoryRoot, 'scripts', 'build-lock.mjs');
  const fixture = String.raw`
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const {
      BUILD_LOCK_MAX_IN_PROCESS_WAITERS,
      buildLockAdmissionState,
      buildLockAdmissionTargetCount,
      buildLockTarget,
      withBuildLock,
    } = await import(pathToFileURL(process.argv[1]).href);
    const scratch = process.argv[2];
    const fifoTarget = join(scratch, 'fifo-target');
    const order = [];
    let active = 0;
    let maxActive = 0;
    const enter = async (label, shouldFail = false) => withBuildLock(fifoTarget, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(label + '-enter');
      assert.equal(existsSync(buildLockTarget(fifoTarget) + '.lock'), true, 'proper-lockfile lock directory missing');
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      order.push(label + (shouldFail ? '-fail' : '-exit'));
      if (shouldFail) throw new Error('injected build failure');
      return label;
    });
    const jobs = [enter('first'), enter('second', true), enter('third')];
    assert.deepEqual(buildLockAdmissionState(fifoTarget), { running: true, waiting: 2 });
    const settled = await Promise.allSettled(jobs);
    assert.deepEqual(settled.map((item) => item.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.deepEqual(order, [
      'first-enter', 'first-exit', 'second-enter', 'second-fail', 'third-enter', 'third-exit',
    ]);
    assert.equal(maxActive, 1);
    assert.equal(buildLockAdmissionState(fifoTarget), undefined);

    let releaseFirst;
    let markEntered;
    const releaseGate = new Promise((resolve) => { releaseFirst = resolve; });
    const entered = new Promise((resolve) => { markEntered = resolve; });
    const independentA = join(scratch, 'independent-a');
    const independentB = join(scratch, 'independent-b');
    const a = withBuildLock(independentA, async () => {
      markEntered();
      await releaseGate;
    });
    await entered;
    const b = withBuildLock(independentB, async () => {
      assert.equal(existsSync(buildLockTarget(independentB) + '.lock'), true);
      return 'independent';
    });
    const winner = await Promise.race([
      b,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    assert.equal(winner, 'independent', 'a different target was serialized behind the first target');
    releaseFirst();
    await a;
    assert.equal(buildLockAdmissionTargetCount(), 0);

    let releaseBounded;
    let markBoundedEntered;
    const boundedGate = new Promise((resolve) => { releaseBounded = resolve; });
    const boundedEntered = new Promise((resolve) => { markBoundedEntered = resolve; });
    const boundedTarget = join(scratch, 'bounded-target');
    const boundedHolder = withBuildLock(boundedTarget, async () => {
      markBoundedEntered();
      await boundedGate;
    });
    await boundedEntered;
    const boundedWaiters = Array.from({ length: BUILD_LOCK_MAX_IN_PROCESS_WAITERS }, () => (
      withBuildLock(boundedTarget, async () => undefined)
    ));
    assert.equal(buildLockAdmissionState(boundedTarget).waiting, BUILD_LOCK_MAX_IN_PROCESS_WAITERS);
    await assert.rejects(
      withBuildLock(boundedTarget, async () => undefined),
      (error) => error?.code === 'EBUILDLOCKQUEUEFULL',
    );
    releaseBounded();
    await Promise.all([boundedHolder, ...boundedWaiters]);
    assert.equal(buildLockAdmissionState(boundedTarget), undefined);
    assert.equal(buildLockAdmissionTargetCount(), 0);
  `;
  const result = spawnSync(process.execPath, [
    '--input-type=module', '-e', fixture, buildLockPath, join(scratch, 'build-lock-fifo'),
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, `build-lock FIFO regression failed: ${result.stderr}\n${result.stdout}`);
  console.log('build-lock.fifo_admission: PASS order=true bounded=true mutualExclusion=true failureRecovery=true targetIndependence=true queueCleanup=true properLockfile=true');
}

async function runRuntimeEvidenceMatrix(scratch: string): Promise<void> {
  const repositoryRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const root = join(scratch, 'runtime-project');
  const storyId = 'B-RUNTIME';
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }, null, 2));
  writeFileSync(join(root, 'source.txt'), 'runtime evidence source\n');
  git(root, ['init', '-q']);
  git(root, ['add', 'proof-or-stop.config.json', 'source.txt']);
  git(root, ['-c', 'user.name=runtime-smoke', '-c', 'user.email=runtime@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'runtime source']);
  const store = new StoryStore(root);
  store.writeStory(storyId, runtimeStory(storyId));

  const legacyStoryId = 'B-LEGACY-QUERY';
  store.writeStory(legacyStoryId, runtimeStory(legacyStoryId));
  store.writeFindings(legacyStoryId, {
    findings: [
      { id: `${legacyStoryId}:F-001`, desc: 'first legacy finding', severity: 'low', category: 'edge', status: 'open' },
      { id: `${legacyStoryId}:F-002`, desc: 'second legacy finding', severity: 'low', category: 'edge', status: 'open' },
    ],
  });
  const legacyLockDir = store.storyFilePath(legacyStoryId, 'findings.lock');
  const legacyLock = acquireMkdirLock(legacyLockDir, {
    label: 'legacy receipt migration regression', requireHolderToken: true,
  });
  let unsignedReceiptBytesBefore = '';
  try {
    const fence = captureMkdirLockFence(legacyLockDir);
    store.appendFindingLedgerTransaction(
      legacyStoryId,
      request(fence.writerFenceToken, 'legacy-query:unsigned', 'finding', {
        id: `${legacyStoryId}:F-001`, desc: 'bounded legacy row', severity: 'low', category: 'edge', status: 'open',
      }),
      fence,
    );
    store.appendFindingLedgerTransaction(
      legacyStoryId,
      request(fence.writerFenceToken, 'legacy-query:unsigned-2', 'finding', {
        id: `${legacyStoryId}:F-002`, desc: 'second bounded legacy row', severity: 'low', category: 'edge', status: 'open',
      }),
      fence,
    );
    unsignedReceiptBytesBefore = canonicalJson(
      store.readFindingLedger<JsonValue>(legacyStoryId).receipts,
    );
  } finally {
    legacyLock.release();
  }

  const legacyHandlers = createFindingHandlers({ root, scanRoot: root, store });
  const priorLegacyAgent = process.env.PROOF_OR_STOP_AGENT;
  process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-implementer';
  try {
    assert.match(legacyHandlers.finding_resolve({
      storyId: legacyStoryId,
      findingId: `${legacyStoryId}:F-001`,
      resolution: 'first sequential legacy resolution',
      resolutionType: 'fixed',
      resolveEvidenceStrength: 'strong',
    }), /resolved/);
    assert.match(legacyHandlers.finding_resolve({
      storyId: legacyStoryId,
      findingId: `${legacyStoryId}:F-002`,
      resolution: 'second sequential legacy resolution',
      resolutionType: 'fixed',
      resolveEvidenceStrength: 'strong',
    }), /resolved/);
  } finally {
    if (priorLegacyAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = priorLegacyAgent;
  }

  const ledgerSigner = findingLedgerSignerFromWorkspace(root);
  const migrated = store.readFindingLedger<JsonValue>(legacyStoryId);
  assert.equal(
    canonicalJson(migrated.receipts.filter((receipt) => !(
      receipt as typeof receipt & { findingLedgerReceipt?: unknown }
    ).findingLedgerReceipt)),
    unsignedReceiptBytesBefore,
    'legacy unsigned receipt bytes were rewritten during lifecycle migration',
  );
  assert.equal(migrated.records.filter((record) => record.recordType === 'legacy_receipt_binding').length, 1);
  assert.equal(migrated.records.filter((record) => record.recordType === 'finding_lifecycle_transition').length, 2);
  assert.equal(queryFindingLedger(migrated, legacyStoryId, ledgerSigner).signedRows, true);
  const tampered = structuredClone(migrated);
  (tampered.receipts[0] as typeof tampered.receipts[0] & { writerSessionId: string }).writerSessionId = 'tampered';
  assert.throws(
    () => queryFindingLedger(tampered, legacyStoryId, ledgerSigner),
    /ledger_receipt_unsigned|ledger_incomplete/,
  );

  const postMigrationLock = acquireMkdirLock(legacyLockDir, {
    label: 'post-migration unsigned refusal regression', requireHolderToken: true,
  });
  try {
    const fence = captureMkdirLockFence(legacyLockDir);
    store.appendFindingLedgerTransaction(
      legacyStoryId,
      request(fence.writerFenceToken, 'legacy-query:unbound-after-migration', 'finding', {
        id: `${legacyStoryId}:F-003`, desc: 'must remain untrusted', severity: 'low', category: 'edge', status: 'open',
      }),
      fence,
    );
    assert.throws(
      () => queryFindingLedger(store.readFindingLedger<JsonValue>(legacyStoryId), legacyStoryId, ledgerSigner),
      /ledger_receipt_unsigned/,
    );
  } finally {
    postMigrationLock.release();
  }
  console.log('ledger.legacy_receipt_binding_sequential: PASS resolutions=2 bindingRecords=1 exactBytes=true conflict=0');
  console.log('ledger.legacy_receipt_binding: PASS query=migrated exactBytes=bound tamper=reject postMigrationUnsigned=reject rewrites=0');

  const registeredSigner = runtimeEvidenceSignerFromWorkspace(root);
  const keyPair = generateEd25519KeyPair();
  const signingEnv = {
    [RUNTIME_EVIDENCE_PRIVATE_KEY_ENV]: keyPair.privateKey,
    [RUNTIME_EVIDENCE_PUBLIC_KEY_ENV]: keyPair.publicKey,
    RUNTIME_SAFE: 'visible-safe-value',
    RUNTIME_SECRET_TOKEN: 'never-store-this-secret-value',
  };
  const previousEnv = Object.fromEntries(Object.keys(signingEnv).map((name) => [name, process.env[name]]));
  Object.assign(process.env, signingEnv);
  try {
    const buildCommand = {
      executable: process.execPath,
      args: ['-e', "const fs=require('node:fs');fs.mkdirSync('build',{recursive:true});fs.writeFileSync('build/runtime-artifact.mjs','process.stdout.write(\\\"runtime-ok\\\\n\\\");\\n')"],
      cwd: '.',
    };
    const executionCommand = { executable: process.execPath, args: ['build/runtime-artifact.mjs'], cwd: '.' };
    const runArgs = {
      storyId,
      idempotencyKey: 'runtime-cli-once',
      buildCommand,
      executionCommand,
      artifactPaths: ['build/runtime-artifact.mjs'],
      environmentAllowlist: ['RUNTIME_SAFE', 'RUNTIME_SECRET_TOKEN'],
      excludedEnvironmentVariables: ['RUNTIME_SECRET_TOKEN'],
      compilerVersion: 'typescript-5.9-smoke',
      timeoutMs: 30_000,
      storageCapability: RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
    };
    const phaseBefore = store.readStory(storyId).phase;
    const cliRun = runRuntimeCli(repositoryRoot, root, 'finding_runtime_evidence_run', runArgs, signingEnv);
    assert.equal(cliRun.status, 0, `real runtime run CLI failed: ${cliRun.stderr}\n${cliRun.stdout}`);
    const runJson = cliRun.json!;
    assert.equal(runJson.command, 'finding_runtime_evidence_run');
    assert.equal(runJson.persisted, true);
    const receipt = runJson.receipt as unknown as RuntimeEvidenceReceipt;
    const runtimeRecordId = String(runJson.runtimeRecordId);
    const ledgerReceiptId = String(runJson.ledgerReceiptId);
    const fileBlobStore = createRuntimeEvidenceBlobStore(root);
    assert.equal(verifyRuntimeEvidenceReceiptBlobs(receipt, fileBlobStore), true);
    assert.equal(
      canonicalDigest(unsignedRuntimeReceipt(receipt)),
      receipt.receiptHash,
      `runtime receipt hash changed across CLI serialization; keys=${Object.keys(receipt).sort().join(',')}`,
    );
    assert.equal(verifyCanonical(
      { ...unsignedRuntimeReceipt(receipt), receiptHash: receipt.receiptHash },
      receipt.signature,
      registeredSigner.publicKey,
    ), true, 'runtime receipt Ed25519 signature is invalid');
    assert.equal(verifyRuntimeEvidenceReceiptSignature(receipt, registeredSigner.publicKey), true);
    assert.notEqual(receipt.keyId, `runtime-evidence-${canonicalDigest({ publicKey: keyPair.publicKey }).slice(0, 24)}`);
    console.log('runtime.content_addressed_receipt: PASS blobs=complete signature=valid');

    const signer: RuntimeReceiptSigner = {
      privateKey: registeredSigner.privateKey,
      publicKey: registeredSigner.publicKey,
      keyId: receipt.keyId,
      trustRootDigest: receipt.trustRootDigest,
      keyFreshnessPolicyDigest: receipt.keyFreshnessPolicyDigest,
      algorithm: 'ed25519',
    };
    const trust: RuntimeReceiptTrust = {
      publicKey: registeredSigner.publicKey,
      keyId: receipt.keyId,
      algorithm: 'ed25519',
      trustRootDigest: receipt.trustRootDigest,
      keyFreshnessPolicyDigest: receipt.keyFreshnessPolicyDigest,
      keyStatus: 'fresh',
    };
    const environment = redactEnvironment(process.env, {
      allowlist: runArgs.environmentAllowlist,
      excludedVariableNames: runArgs.excludedEnvironmentVariables,
    });
    const expected = {
      storyId,
      headHash: currentGitHead(root)!,
      sourceMaterialHash: currentMaterialHash(root, 'HEAD', root)!,
      buildPolicyDigest: RUNTIME_EVIDENCE_BUILD_POLICY_DIGEST,
      buildCommand: { ...buildCommand, executable: realpathSync(process.execPath) },
      executionCommand: { ...executionCommand, executable: realpathSync(process.execPath) },
      environment,
      toolchain: receipt.toolchain,
      trust,
      blobStore: fileBlobStore,
      artifactRoot: root,
      producer: 'finding_runtime_evidence_run',
    };
    assert.equal(verifyRuntimeEvidenceCurrent(receipt, expected).valid, true);

    const stableStore = new MemoryRuntimeEvidenceBlobStore();
    const stable = executeRuntimeEvidence({
      storyId,
      headHash: expected.headHash,
      sourceMaterialHash: expected.sourceMaterialHash,
      buildPolicyDigest: expected.buildPolicyDigest,
      buildCommand: expected.buildCommand,
      executionCommand: expected.executionCommand,
      environment,
      toolchain: receipt.toolchain,
      producer: 'runtime-stability-smoke',
      root,
      artifactInputs: [{ path: 'build/runtime-artifact.mjs', sourceHead: expected.headHash }],
      blobStore: stableStore,
      run: () => ({ stdout: 'stable', stderr: '', exitCode: 0 }),
    }, signer);
    assert.deepEqual([stable.preStable, stable.duringStable, stable.postStable], [true, true, true]);
    console.log('runtime.artifact_stability: PASS pre=true during=true post=true');

    assert.equal(store.readStory(storyId).phase, phaseBefore);
    console.log('runtime.execution_not_semantics: PASS lifecycleDelta=0');
    console.log('runtime.real_cli_run_adapter: PASS command=finding_runtime_evidence_run persisted=true');

    const verifyArgs = {
      storyId,
      runtimeReceiptId: receipt.receiptId,
      buildCommand,
      executionCommand,
      environmentAllowlist: runArgs.environmentAllowlist,
      excludedEnvironmentVariables: runArgs.excludedEnvironmentVariables,
      compilerVersion: runArgs.compilerVersion,
      publicKey: registeredSigner.publicKey,
      storageCapability: RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
    };
    const cliVerify = runRuntimeCli(repositoryRoot, root, 'finding_runtime_evidence_verify', verifyArgs, signingEnv);
    assert.equal(cliVerify.status, 0, `real runtime verify CLI failed: ${cliVerify.stderr}\n${cliVerify.stdout}`);
    assert.equal(cliVerify.json?.verified, true);
    console.log('runtime.real_cli_verify_adapter: PASS command=finding_runtime_evidence_verify verified=true');

    const attackerPair = generateEd25519KeyPair();
    const callerSelectedKey = runRuntimeCli(repositoryRoot, root, 'finding_runtime_evidence_verify', {
      ...verifyArgs, publicKey: attackerPair.publicKey,
    }, signingEnv);
    assert.notEqual(callerSelectedKey.status, 0);
    assert.match(`${callerSelectedKey.stdout}\n${callerSelectedKey.stderr}`, /unknown_signing_key/);
    for (const keyStatus of ['unknown', 'revoked', 'expired'] as const) {
      const rejectedKeyStatus = runRuntimeCli(repositoryRoot, root, 'finding_runtime_evidence_verify', {
        ...verifyArgs, keyStatus,
      }, signingEnv);
      assert.notEqual(rejectedKeyStatus.status, 0);
      assert.match(`${rejectedKeyStatus.stdout}\n${rejectedKeyStatus.stderr}`, /signing_key/);
    }
    setRuntimeEvidenceKeyStatusForTest(root, 'revoked');
    const revokedRegistry = runRuntimeCli(repositoryRoot, root, 'finding_runtime_evidence_verify', verifyArgs, signingEnv);
    assert.notEqual(revokedRegistry.status, 0);
    assert.match(`${revokedRegistry.stdout}\n${revokedRegistry.stderr}`, /revoked_signing_key/);
    setRuntimeEvidenceKeyStatusForTest(root, 'fresh');
    console.log('runtime.registered_key_trust: PASS callerSelected=reject unknown=reject revoked=reject expired=reject');

    const queryPhaseBefore = store.readStory(storyId).phase;
    const cliQuery = runRuntimeCli(repositoryRoot, root, 'finding_ledger_query', { storyId }, signingEnv);
    const cliQueryRepeat = runRuntimeCli(repositoryRoot, root, 'finding_ledger_query', { storyId }, signingEnv);
    assert.equal(cliQuery.status, 0, `real ledger query CLI failed: ${cliQuery.stderr}\n${cliQuery.stdout}`);
    assert.equal(cliQueryRepeat.status, 0, `repeat ledger query CLI failed: ${cliQueryRepeat.stderr}\n${cliQueryRepeat.stdout}`);
    const query = cliQuery.json!;
    const repeatedQuery = cliQueryRepeat.json!;
    const queryRows = query.rows as unknown as ReturnType<typeof queryFindingLedger>['rows'];
    const queryTrust = findingLedgerTrustFromWorkspace(root);
    assert.deepEqual(queryRows.map((row) => row.category), ['ledger', 'cas', 'idempotency', 'runtime', 'migration']);
    assert.equal(queryRows.every((row) => verifyFindingLedgerQueryRow(row, queryTrust)), true);
    assert.equal(queryRows.every((row) => row.gateEvidence === false && row.lifecycleAuthority === 'none'), true);
    assert.equal(queryRows.every((row) => row.numerator === row.denominator), true);
    assert.equal(query.snapshotDigest, canonicalHash(queryRows));
    assert.equal(store.readStory(storyId).phase, queryPhaseBefore);
    assert.equal(hasProtectedPathSurface(query, [root, store.storyDirPath(storyId), '.runtime-evidence-blobs', 'finding-ledger.json', 'findings.lock']), false);
    console.log('query.protected_read_only: PASS signedRows=true pathsExposed=0');
    assert.equal(canonicalJson(query), canonicalJson(repeatedQuery));
    console.log('query.deterministic_scorecard: PASS');

    const querySigner = findingLedgerSignerFromWorkspace(root);
    const persistedLedger = store.readFindingLedger<JsonValue>(storyId);
    const runtimeRecord = persistedLedger.records.find((candidate) => candidate.recordId === runtimeRecordId)!;
    assert.equal(verifyRuntimeReceiptCarrier(persistedLedger, storyId, runtimeRecord, queryTrust), true);
    const attackerSigner: RuntimeReceiptSigner = {
      privateKey: attackerPair.privateKey,
      publicKey: attackerPair.publicKey,
      keyId: `runtime-evidence-${canonicalDigest({ publicKey: attackerPair.publicKey }).slice(0, 24)}`,
      trustRootDigest: canonicalDigest({ profile: 'runtime-evidence-trust-root-v1', publicKey: attackerPair.publicKey }),
      keyFreshnessPolicyDigest: receipt.keyFreshnessPolicyDigest,
      algorithm: 'ed25519',
    };
    const launderedReceipt = signRuntimeEvidenceReceipt({
      ...unsignedRuntimeReceipt(receipt),
      keyId: attackerSigner.keyId,
      trustRootDigest: attackerSigner.trustRootDigest,
    }, attackerSigner);
    const launderedLedger = structuredClone(persistedLedger);
    const launderedRecord = launderedLedger.records.find((candidate) => candidate.recordId === runtimeRecordId)!;
    launderedRecord.payload = launderedReceipt as unknown as JsonValue;
    launderedRecord.payloadHash = canonicalHash(launderedRecord.payload);
    launderedLedger.committedLedgerDigest = canonicalHash(launderedLedger.records);
    launderedLedger.receipts.at(-1)!.committedLedgerDigest = launderedLedger.committedLedgerDigest;
    assert.equal(verifyRuntimeReceiptCarrier(launderedLedger, storyId, launderedRecord, queryTrust), false);
    const tamperedCarrier = structuredClone(persistedLedger);
    const tamperedCarrierReceipts = tamperedCarrier.receipts as unknown as Array<Record<string, unknown>>;
    (tamperedCarrierReceipts.find((candidate) => (candidate.recordIds as string[]).includes(runtimeRecordId))!
      .findingLedgerReceipt as Record<string, unknown>).signature = 'attacker-signature';
    assert.equal(verifyRuntimeReceiptCarrier(
      tamperedCarrier as unknown as typeof persistedLedger,
      storyId,
      tamperedCarrier.records.find((candidate) => candidate.recordId === runtimeRecordId)!,
      queryTrust,
    ), false);
    const missingSignedDigestLedger = structuredClone(persistedLedger) as typeof persistedLedger & {
      receipts: Array<Record<string, unknown>>;
    };
    const missingSignedDigestCarrier = missingSignedDigestLedger.receipts.find((candidate) => (
      (candidate.recordIds as string[]).includes(runtimeRecordId)
    ))! as unknown as Record<string, unknown>;
    const signedRuntimeCarrier = missingSignedDigestCarrier.findingLedgerReceipt as
      ReturnType<typeof signFindingLedgerReceipt>;
    const {
      exactRequestDigest: _exactRequestDigest,
      receiptHash: _receiptHash,
      signature: _signature,
      ...legacySignedRuntimeCarrier
    } = signedRuntimeCarrier;
    const resignedRuntimeCarrier = signFindingLedgerReceipt(legacySignedRuntimeCarrier, querySigner);
    missingSignedDigestCarrier.findingLedgerReceipt = resignedRuntimeCarrier;
    assert.equal(typeof missingSignedDigestCarrier.exactRequestDigest, 'string');
    assert.equal(resignedRuntimeCarrier.exactRequestDigest, undefined);
    assert.equal(verifyFindingLedgerReceipt(resignedRuntimeCarrier, queryTrust), true);
    try {
      writeFileSync(
        store.findingLedgerPath(storyId),
        `${JSON.stringify(missingSignedDigestLedger, null, 2)}\n`,
      );
      const legacyQueryOnly = runRuntimeCli(repositoryRoot, root, 'finding_ledger_query', { storyId }, signingEnv);
      assert.equal(
        legacyQueryOnly.status,
        0,
        `legacy-shaped signed receipt must remain queryable: ${legacyQueryOnly.stderr}\n${legacyQueryOnly.stdout}`,
      );
      const missingSignedDigestVerify = runRuntimeCli(
        repositoryRoot,
        root,
        'finding_runtime_evidence_verify',
        verifyArgs,
        signingEnv,
      );
      assert.notEqual(
        missingSignedDigestVerify.status,
        0,
        'runtime verify must refuse a current-key signed carrier without a signed exactRequestDigest',
      );
      assert.match(
        `${missingSignedDigestVerify.stdout}\n${missingSignedDigestVerify.stderr}`,
        /runtime receipt carrier trust chain is invalid/,
      );
      assert.equal(verifyRuntimeReceiptCarrier(
        missingSignedDigestLedger,
        storyId,
        missingSignedDigestLedger.records.find((candidate) => candidate.recordId === runtimeRecordId)!,
        queryTrust,
      ), false);
    } finally {
      writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(persistedLedger, null, 2)}\n`);
    }
    console.log('runtime.carrier_signed_exact_request_digest: PASS verify=refused legacyQuery=accepted');
    const outerIdentityResults: Array<{
      variant: 'operation' | 'requestDigest';
      carrierAccepted: boolean;
      verifyReturnedVerified: boolean;
    }> = [];
    for (const variant of ['operation', 'requestDigest'] as const) {
      const mutatedLedger = structuredClone(persistedLedger);
      const mutatedCarrier = mutatedLedger.receipts.find((candidate) => (
        candidate.recordIds.includes(runtimeRecordId)
      ))!;
      if (variant === 'operation') mutatedCarrier.operation = 'append_finding';
      else mutatedCarrier.requestDigest = '0'.repeat(64);
      try {
        writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(mutatedLedger, null, 2)}\n`);
        const mutatedVerify = runRuntimeCli(
          repositoryRoot,
          root,
          'finding_runtime_evidence_verify',
          verifyArgs,
          signingEnv,
        );
        outerIdentityResults.push({
          variant,
          carrierAccepted: verifyRuntimeReceiptCarrier(
            mutatedLedger,
            storyId,
            mutatedLedger.records.find((candidate) => candidate.recordId === runtimeRecordId)!,
            queryTrust,
          ),
          verifyReturnedVerified: mutatedVerify.status === 0 && mutatedVerify.json?.verified === true,
        });
      } finally {
        writeFileSync(store.findingLedgerPath(storyId), `${JSON.stringify(persistedLedger, null, 2)}\n`);
      }
    }
    if (outerIdentityResults.some((result) => result.carrierAccepted || result.verifyReturnedVerified)) {
      console.log(`runtime.carrier_outer_identity: RED ${outerIdentityResults.map((result) => (
        `${result.variant}=carrier:${result.carrierAccepted},verified:${result.verifyReturnedVerified}`
      )).join(' ')}`);
    }
    assert.deepEqual(
      outerIdentityResults.map((result) => ({
        variant: result.variant,
        carrierAccepted: result.carrierAccepted,
        verifyReturnedVerified: result.verifyReturnedVerified,
      })),
      [
        { variant: 'operation', carrierAccepted: false, verifyReturnedVerified: false },
        { variant: 'requestDigest', carrierAccepted: false, verifyReturnedVerified: false },
      ],
      'runtime verification must reject outer operation or requestDigest disagreement with the signed persisted request',
    );
    console.log('runtime.carrier_outer_identity: PASS operation=refused requestDigest=refused');
    console.log('runtime.carrier_trust_chain: PASS callerResign=reject tamperedCarrier=reject missingSignedExactRequestDigest=reject outerIdentityMismatch=reject zeroAuthority=true');
    let refusedQueries = 0;
    const expectRefusal = (candidate: typeof persistedLedger): void => {
      assert.throws(() => queryFindingLedger(candidate, storyId, querySigner));
      refusedQueries += 1;
    };
    expectRefusal(emptyLedger<JsonValue>());
    const digestMismatch = structuredClone(persistedLedger);
    digestMismatch.records[0]!.payloadHash = '0'.repeat(64);
    expectRefusal(digestMismatch);
    const incomplete = structuredClone(persistedLedger);
    incomplete.receipts[0]!.recordIds = [];
    expectRefusal(incomplete);
    const unsigned = structuredClone(persistedLedger) as typeof persistedLedger & { receipts: Array<Record<string, unknown>> };
    delete (unsigned.receipts[0]!.findingLedgerReceipt as Record<string, unknown>).signature;
    expectRefusal(unsigned);
    const signatureMismatch = structuredClone(persistedLedger) as typeof persistedLedger & { receipts: Array<Record<string, unknown>> };
    (signatureMismatch.receipts[0]!.findingLedgerReceipt as Record<string, unknown>).signature = 'tampered-signature';
    expectRefusal(signatureMismatch);
    const tamperedQueryRow = structuredClone(queryRows[0]!);
    tamperedQueryRow.numerator = Math.max(0, tamperedQueryRow.numerator - 1);
    assert.equal(verifyFindingLedgerQueryRow(tamperedQueryRow, queryTrust), false);
    assert.equal(refusedQueries, 5);
    console.log('query.incomplete_tamper_refusal: PASS partialRows=0');

    const queryEntry = getProcessFactRegistryEntry('finding_ledger_query')!;
    const runEntry = getProcessFactRegistryEntry('finding_runtime_evidence_run')!;
    const verifyEntry = getProcessFactRegistryEntry('finding_runtime_evidence_verify')!;
    assert.deepEqual([queryEntry.level, runEntry.level, verifyEntry.level], ['L0', 'L2', 'L3']);
    assert.equal(runEntry.semantics.includes('atomic-persistence'), true);
    assert.equal(verifyEntry.semantics.includes('execution-evidence') && verifyEntry.semantics.includes('freshness-policy'), true);
    assert.equal([queryEntry, runEntry, verifyEntry].some((entry) => entry.semantics.includes('gate-evidence') || entry.consumerGate), false);
    assert.equal(PROCESS_FACT_STORY3_RUNTIME_RECEIPT_POLICY.level, 'L3');
    assert.equal(PROCESS_FACT_STORY3_RUNTIME_RECEIPT_POLICY.gateEvidence, false);
    assert.equal(PROCESS_FACT_STORY3_RUNTIME_RECEIPT_POLICY.lifecycleAuthority, 'gate-eligible-input-only');
    assert.deepEqual({
      recordType: PROCESS_FACT_STORY3_FINDING_LIFECYCLE_POLICY.recordType,
      level: PROCESS_FACT_STORY3_FINDING_LIFECYCLE_POLICY.level,
      gateEvidence: PROCESS_FACT_STORY3_FINDING_LIFECYCLE_POLICY.gateEvidence,
      lifecycleAuthority: PROCESS_FACT_STORY3_FINDING_LIFECYCLE_POLICY.lifecycleAuthority,
    }, {
      recordType: 'finding_lifecycle_transition',
      level: 'L4',
      gateEvidence: true,
      lifecycleAuthority: 'terminal-finding-state',
    });
    console.log('registry.story3_fact_contract: PASS');

    const phases = ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'];
    assert.equal(phases.every((phase) => isCommandAllowed('finding_ledger_query', phase)), true);
    assert.equal(isCommandAllowed('finding_runtime_evidence_run', 'DEV'), true);
    assert.equal(isCommandAllowed('finding_runtime_evidence_verify', 'DEV'), true);
    assert.equal(phases.filter((phase) => phase !== 'DEV').some((phase) => isCommandAllowed('finding_runtime_evidence_run', phase) || isCommandAllowed('finding_runtime_evidence_verify', phase)), false);
    console.log('registry.command_phase_policy: PASS bypasses=0');

    assert.deepEqual(
      PROCESS_FACT_STORY3_PERSISTENCE_ONLY_RECORD_POLICIES.map((policy) => policy.recordClass),
      ['persistence', 'candidate', 'route', 'baseline', 'history', 'standalone-receipt', 'ledger-receipt'],
    );
    const lifecycleBefore = canonicalJson(store.readStory(storyId));
    assert.equal(PROCESS_FACT_STORY3_PERSISTENCE_ONLY_RECORD_POLICIES.every((policy) => (
      policy.level === 'L2'
      && policy.gateEvidence === false
      && policy.lifecycleAuthority === 'none'
      && canonicalJson(policy.allowedConsumers) === canonicalJson(['finding_ledger_query'])
    )), true);
    assert.equal(canonicalJson(store.readStory(storyId)), lifecycleBefore);
    console.log('registry.persistence_non_authority: PASS lifecycleDelta=0');

    const nonAuthorityMutations = [
      'story3-promote-query-l4',
      'story3-promote-runtime-run-l4',
      'story3-drop-runtime-freshness',
      ...PROCESS_FACT_STORY3_PERSISTENCE_ONLY_RECORD_POLICIES.map((policy) => `story3-promote-record-${policy.recordClass}`),
    ];
    assert.equal(nonAuthorityMutations.filter((mutation) => story3VerifierMutationAccepted(repositoryRoot, mutation)).length, 0);
    console.log('registry.non_authority_mutations: PASS acceptedMutations=0');

    const boundaryMutations = [
      'story3-forbidden-story2-import',
      'story3-forbidden-story1-import',
      'story3-unregistered-direct-consumer',
    ];
    assert.equal(boundaryMutations.filter((mutation) => story3VerifierMutationAccepted(repositoryRoot, mutation)).length, 0);
    console.log('registry.dependency_boundary: PASS forbiddenImportsAccepted=0');
    assert.equal(story3VerifierMutationAccepted(repositoryRoot, 'story3-query-path-leak'), false);
    console.log('query.path_leakage: PASS exposedPaths=0');
    await runStory3DependencyFixture(join(scratch, 'dependency-lifecycle-gate'));

    const changedEnvironment = redactEnvironment({ ...process.env, RUNTIME_SAFE: 'changed-safe-value' }, {
      allowlist: runArgs.environmentAllowlist,
      excludedVariableNames: runArgs.excludedEnvironmentVariables,
    });
    const changedToolchainValue = { compilerVersion: 'other-compiler', runtimeVersion: process.version };
    const changedToolchain = { ...changedToolchainValue, toolchainDigest: canonicalDigest(changedToolchainValue) };
    const outputMutated = signRuntimeEvidenceReceipt({
      ...unsignedRuntimeReceipt(receipt), stdoutDigest: 'a'.repeat(64),
    }, signer);
    const artifactPath = join(root, 'build', 'runtime-artifact.mjs');
    const artifactBytes = readFileSync(artifactPath);
    const freshnessResults = [
      verifyRuntimeEvidenceCurrent(receipt, { ...expected, headHash: 'f'.repeat(40) }),
      verifyRuntimeEvidenceCurrent(receipt, { ...expected, sourceMaterialHash: '1'.repeat(64) }),
      verifyRuntimeEvidenceCurrent(receipt, { ...expected, buildPolicyDigest: '2'.repeat(64) }),
      verifyRuntimeEvidenceCurrent(receipt, { ...expected, buildCommand: { ...expected.buildCommand, args: ['--changed-build'] } }),
      verifyRuntimeEvidenceCurrent(receipt, { ...expected, executionCommand: { ...expected.executionCommand, args: ['--changed-execution'] } }),
      verifyRuntimeEvidenceCurrent(receipt, { ...expected, environment: changedEnvironment }),
      verifyRuntimeEvidenceCurrent(receipt, { ...expected, toolchain: changedToolchain }),
      verifyRuntimeEvidenceCurrent(outputMutated, expected),
    ];
    writeFileSync(artifactPath, 'mutated-after-receipt\n');
    freshnessResults.push(verifyRuntimeEvidenceCurrent(receipt, expected));
    writeFileSync(artifactPath, artifactBytes);
    const freshnessReasons = freshnessResults.map((result) => result.refusal);
    assert.deepEqual(freshnessReasons, [
      'source_stale', 'material_stale', 'build_policy_stale', 'build_command_stale',
      'execution_command_stale', 'environment_stale', 'toolchain_stale', 'output_tampered', 'artifact_stale',
    ]);
    assert.equal(freshnessResults.some((result) => result.valid), false);
    console.log('runtime.freshness_matrix: PASS acceptedStale=0');

    const persistedText = `${JSON.stringify(runJson)}\n${readTreeText(join(root, '.proof-or-stop', 'evidence'))}\n${readTreeText(store.storyDirPath(storyId))}`;
    assert.equal(persistedText.includes(signingEnv.RUNTIME_SECRET_TOKEN), false);
    console.log('runtime.environment_privacy: PASS leakedValues=0');

    const rowsBeforeRefusal = store.readFindingLedger<JsonValue>(storyId).records.length;
    for (const status of ['unknown', 'revoked', 'expired'] as const) {
      assert.equal(verifyRuntimeEvidenceCurrent(receipt, { ...expected, trust: { ...trust, keyStatus: status } }).valid, false);
    }
    const unsupportedAlgorithm = signRuntimeEvidenceReceipt({ ...unsignedRuntimeReceipt(receipt), algorithm: 'rsa' }, signer);
    assert.equal(verifyRuntimeEvidenceCurrent(unsupportedAlgorithm, expected).refusal, 'unsupported_algorithm');
    assert.equal(verifyRuntimeEvidenceCurrent(receipt, {
      ...expected, trust: { ...trust, trustRootDigest: '3'.repeat(64) },
    }).refusal, 'unsupported_trust_root');
    assert.throws(() => createRuntimeEvidenceBlobStore(root, 'nfs-multi-host'), /unsupported_storage/);
    const blobEscapeRoot = join(scratch, 'blob-escape-project');
    const blobEscapeOutside = join(scratch, 'blob-escape-outside');
    mkdirSync(join(blobEscapeRoot, '.proof-or-stop', 'evidence'), { recursive: true });
    mkdirSync(blobEscapeOutside, { recursive: true });
    symlinkSync(blobEscapeOutside, join(blobEscapeRoot, '.proof-or-stop', 'evidence', 'runtime-blobs'));
    const escapeBytes = Buffer.from('must-not-escape-runtime-blob-root\n');
    const escapeDigest = createHash('sha256').update(escapeBytes).digest('hex');
    assert.throws(() => writeRuntimeEvidenceBlob(blobEscapeRoot, {
      blobId: `runtime-${escapeDigest}`,
      contentDigest: escapeDigest,
      contentType: 'stdout',
      redactionPolicyDigest: canonicalDigest({ policy: 'blob-escape-smoke' }),
    }, escapeBytes), /unsupported_storage/);
    assert.equal(existsSync(join(blobEscapeOutside, 'sha256', `${escapeDigest}.blob`)), false);
    console.log('runtime.blob_store_symlink: PASS outsideWrites=0');
    const swapRoot = join(scratch, 'blob-swap-project');
    const swapOutside = join(scratch, 'blob-swap-outside');
    mkdirSync(swapRoot, { recursive: true });
    mkdirSync(swapOutside, { recursive: true });
    const swapBytes = Buffer.from('deterministic-symlink-swap\n');
    const swapDigest = createHash('sha256').update(swapBytes).digest('hex');
    const swapDir = join(swapRoot, '.proof-or-stop', 'evidence', 'runtime-blobs', 'sha256');
    const displacedDir = `${swapDir}.displaced`;
    assert.throws(() => writeRuntimeEvidenceBlob(swapRoot, {
      blobId: `runtime-${swapDigest}`,
      contentDigest: swapDigest,
      contentType: 'stdout',
      redactionPolicyDigest: canonicalDigest({ policy: 'blob-swap-smoke' }),
    }, swapBytes, RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY, {
      beforePublish: () => {
        renameSync(swapDir, displacedDir);
        symlinkSync(swapOutside, swapDir);
      },
    }), /unsupported_storage/);
    assert.equal(existsSync(join(swapOutside, `${swapDigest}.blob`)), false);
    console.log('runtime.blob_store_symlink_swap: PASS deterministicInterleaving=reject outsideWrites=0');
    const lateSwapRoot = join(scratch, 'blob-late-swap-project');
    const lateSwapOutside = join(scratch, 'blob-late-swap-outside');
    mkdirSync(lateSwapRoot, { recursive: true });
    mkdirSync(lateSwapOutside, { recursive: true });
    const lateSwapBytes = Buffer.from('deterministic-late-symlink-swap\n');
    const lateSwapDigest = createHash('sha256').update(lateSwapBytes).digest('hex');
    const lateSwapDir = join(lateSwapRoot, '.proof-or-stop', 'evidence', 'runtime-blobs', 'sha256');
    const lateSwapDisplacedDir = `${lateSwapDir}.displaced`;
    let lateOutsideWrites = 0;
    assert.throws(() => writeRuntimeEvidenceBlob(lateSwapRoot, {
      blobId: `runtime-${lateSwapDigest}`,
      contentDigest: lateSwapDigest,
      contentType: 'stdout',
      redactionPolicyDigest: canonicalDigest({ policy: 'blob-late-swap-smoke' }),
    }, lateSwapBytes, RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY, {
      beforeOpen: () => {
        renameSync(lateSwapDir, lateSwapDisplacedDir);
        symlinkSync(lateSwapOutside, lateSwapDir);
      },
      beforePublish: () => {
        lateOutsideWrites = readdirSync(lateSwapOutside).length;
      },
    }), /unsupported_storage/);
    assert.equal(lateOutsideWrites, 0, 'late directory swap must not create even a temporary outside blob');
    assert.equal(readdirSync(lateSwapOutside).length, 0);
    console.log('runtime.blob_store_late_symlink_swap: PASS afterFinalCheck=true outsideWrites=0');
    const buildBusy = runRuntimeCli(repositoryRoot, root, 'finding_runtime_evidence_run', {
      ...runArgs, idempotencyKey: 'runtime-build-busy', buildInProgress: true,
    }, signingEnv);
    assert.notEqual(buildBusy.status, 0);
    assert.match(`${buildBusy.stdout}\n${buildBusy.stderr}`, /build_in_progress/);
    assert.equal(store.readFindingLedger<JsonValue>(storyId).records.length, rowsBeforeRefusal);
    const canonicalBuildLockFixture = `
      import { spawnSync } from 'node:child_process';
      import { pathToFileURL } from 'node:url';
      const { withBuildLock } = await import(pathToFileURL(process.argv[1]).href);
      const cli = process.argv[2];
      const root = process.argv[3];
      const base = JSON.parse(Buffer.from(process.argv[4], 'base64').toString('utf8'));
      const results = [];
      await withBuildLock(root, async () => {
        for (const variant of ['omitted', 'false']) {
          const args = { ...base, idempotencyKey: 'runtime-real-build-lock-' + variant };
          if (variant === 'false') args.buildInProgress = false;
          const result = spawnSync(process.execPath, [cli, 'finding_runtime_evidence_run', JSON.stringify(args)], {
            cwd: root, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          });
          results.push({ status: result.status, output: (result.stdout || '') + '\\n' + (result.stderr || '') });
        }
      });
      process.stdout.write(JSON.stringify(results));
    `;
    const canonicalBuildLock = spawnSync(process.execPath, [
      '--input-type=module', '-e', canonicalBuildLockFixture,
      join(repositoryRoot, 'scripts', 'build-lock.mjs'),
      join(repositoryRoot, 'packages', 'main', 'dist', 'cli.js'),
      realpathSync(root),
      Buffer.from(JSON.stringify(runArgs)).toString('base64'),
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, ...RUNTIME_CLI_TEST_SESSION_ENV, ...signingEnv },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(canonicalBuildLock.status, 0, `${canonicalBuildLock.stderr}\n${canonicalBuildLock.stdout}`);
    const lockResults = JSON.parse(canonicalBuildLock.stdout) as Array<{ status: number; output: string }>;
    assert.equal(lockResults.length, 2);
    assert.equal(
      lockResults.every((result) => result.status !== 0 && /build[\s_-]*(?:is[\s_-]*)?in[\s_-]*progress/i.test(result.output)),
      true,
      JSON.stringify(lockResults),
    );
    assert.equal(store.readFindingLedger<JsonValue>(storyId).records.length, rowsBeforeRefusal);
    console.log('runtime.canonical_build_lock: PASS callerFalse=reject callerOmitted=reject zeroWrites=true');
    const interleavingHandlers = createFindingLedgerHandlers({ store, root, scanRoot: root });
    let successorBuildAcquired = false;
    const interleavingResult = interleavingHandlers.finding_runtime_evidence_run({
      ...runArgs,
      idempotencyKey: 'runtime-build-lock-successor-interleaving',
      afterCanonicalBuildLockForTest: () => {
        const target = join(tmpdir(), `proof-or-stop-build-lock-${createHash('sha256').update(String(root)).digest('hex')}`);
        const probe = spawnSync(process.execPath, ['-e', String.raw`
          const lockfile = require(process.argv[1]);
          try {
            const release = lockfile.lockSync(process.argv[2], { stale: 30000, update: 10000, retries: 0 });
            release();
            process.exit(0);
          } catch { process.exit(75); }
        `, require.resolve('proper-lockfile'), target]);
        successorBuildAcquired = probe.status === 0;
        assert.equal(probe.status, 75, 'a successor build must not enter after runtime admission');
      },
    });
    assert.equal(interleavingResult.persisted, true);
    assert.equal(successorBuildAcquired, false);
    console.log('runtime.canonical_build_lock_interleaving: PASS successorStartedAfterAdmission=true successorAcquired=false receiptCommitted=true');
    console.log('runtime.trust_storage_boundary: PASS emittedInvalidReceipts=0');

    const beforeReplay = store.readFindingLedger<JsonValue>(storyId);
    const originalRecordBytes = canonicalJson(beforeReplay.records.find((record) => record.recordId === runtimeRecordId));
    const cliReplay = runRuntimeCli(repositoryRoot, root, 'finding_runtime_evidence_run', runArgs, signingEnv);
    assert.equal(cliReplay.status, 0, `runtime replay failed: ${cliReplay.stderr}\n${cliReplay.stdout}`);
    assert.equal(cliReplay.json?.replayed, true);
    assert.equal(cliReplay.json?.runtimeRecordId, runtimeRecordId);
    assert.equal(cliReplay.json?.ledgerReceiptId, ledgerReceiptId);
    const afterReplay = store.readFindingLedger<JsonValue>(storyId);
    assert.equal(afterReplay.records.length, beforeReplay.records.length);
    assert.equal(afterReplay.receipts.length, beforeReplay.receipts.length);
    assert.equal(canonicalJson(afterReplay.records.find((record) => record.recordId === runtimeRecordId)), originalRecordBytes);
    const runtimeLedgerReceipt = afterReplay.receipts.find((receipt) => receipt.recordIds.includes(runtimeRecordId));
    assert.equal(runtimeLedgerReceipt?.operation, FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT.appendOperation);
    assert.ok(
      afterReplay.records.some((record) => record.recordId === runtimeRecordId
        && Array.isArray((record.payload as { artifacts?: Array<Record<string, unknown>> }).artifacts)
        && (record.payload as { artifacts: Array<Record<string, unknown>> }).artifacts.every((artifact) => typeof artifact[FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT.artifactRealpathBinding] === 'string')),
      'runtime receipt artifacts must carry the adapter-contract realpath binding',
    );
    console.log('runtime.append_runtime_receipt_replay: PASS newRows=0 sameRecordId=true sameReceiptId=true bytesUnchanged=true adapterContract=true');
    assert.doesNotMatch(
      `${cliRun.stdout}\n${cliRun.stderr}\n${cliReplay.stdout}\n${cliReplay.stderr}`,
      /session identity degraded: derived-ppid|is owned by Proof-or-Stop session/,
    );
    console.log('runtime.validation_executor_session_stability: PASS adapterIdentity=stable ambientSessionRequired=false');

    const receiptMutations: RuntimeEvidenceReceipt[] = [];
    const directMutation = (field: keyof RuntimeEvidenceReceipt, value: unknown): void => {
      const copy = structuredClone(receipt) as unknown as Record<string, unknown>;
      copy[field] = value;
      receiptMutations.push(copy as unknown as RuntimeEvidenceReceipt);
    };
    directMutation('storyId', 'B-SUBSTITUTE');
    directMutation('receiptHash', '4'.repeat(64));
    directMutation('signature', 'invalid-signature');
    directMutation('stdout', { ...receipt.stdout, contentDigest: '5'.repeat(64) });
    directMutation('artifacts', [{ ...receipt.artifacts[0], digest: '6'.repeat(64) }]);
    const tamperedBlobStore = {
      put: () => undefined,
      get: (ref: RuntimeEvidenceReceipt['stdout']) => ref.blobId === receipt.stdout.blobId
        ? Buffer.from('tampered stdout')
        : fileBlobStore.get(ref),
    };
    const missingBlobStore = { put: () => undefined, get: () => undefined };
    const tamperResults = [
      ...receiptMutations.map((candidate) => verifyRuntimeEvidenceCurrent(candidate, expected)),
      verifyRuntimeEvidenceCurrent(receipt, { ...expected, blobStore: tamperedBlobStore }),
      verifyRuntimeEvidenceCurrent(receipt, { ...expected, blobStore: missingBlobStore }),
    ];
    assert.equal(tamperResults.filter((result) => result.valid).length, 0);
    console.log('runtime.tamper_matrix: PASS acceptedMutations=0');

    const outside = join(scratch, 'outside-runtime-artifact.mjs');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, join(root, 'build', 'escape.mjs'));
    symlinkSync('runtime-artifact.mjs', join(root, 'build', 'runtime-alias.mjs'));
    const realpathErrors: string[] = [];
    for (const paths of [['build/escape.mjs'], ['../outside-runtime-artifact.mjs'], ['build/runtime-artifact.mjs', 'build/runtime-alias.mjs']]) {
      try {
        executeRuntimeEvidence({
          storyId, headHash: expected.headHash, sourceMaterialHash: expected.sourceMaterialHash,
          buildPolicyDigest: expected.buildPolicyDigest, buildCommand: expected.buildCommand,
          executionCommand: expected.executionCommand, environment, toolchain: receipt.toolchain,
          producer: 'realpath-smoke', root, artifactInputs: paths.map((path) => ({ path, sourceHead: expected.headHash })),
          blobStore: new MemoryRuntimeEvidenceBlobStore(), run: () => ({ stdout: '', stderr: '', exitCode: 0 }),
        }, signer);
        assert.fail(`realpath mutation unexpectedly accepted: ${paths.join(',')}`);
      } catch (error) {
        assert.ok(error instanceof RuntimeEvidenceRefusal);
        assert.equal(error.code, 'realpath_policy_violation');
        realpathErrors.push(error.message);
      }
    }
    assert.equal(realpathErrors.some((message) => message.includes(root) || message.includes(outside)), false);
    console.log('runtime.realpath_policy: PASS escapes=0 pathsExposed=0');

    const toctouPath = join(root, 'build', 'toctou.mjs');
    const toctouBytes = Buffer.from('toctou-original\n');
    writeFileSync(toctouPath, toctouBytes);
    let receiptsIssued = 0;
    const countingStore = {
      put: () => { receiptsIssued += 1; },
      get: () => undefined,
    };
    assert.throws(() => executeRuntimeEvidence({
      storyId, headHash: expected.headHash, sourceMaterialHash: expected.sourceMaterialHash,
      buildPolicyDigest: expected.buildPolicyDigest, buildCommand: expected.buildCommand,
      executionCommand: expected.executionCommand, environment, toolchain: receipt.toolchain,
      producer: 'toctou-smoke', root, artifactInputs: [{ path: 'build/toctou.mjs', sourceHead: expected.headHash }],
      blobStore: countingStore,
      run: () => {
        writeFileSync(toctouPath, 'temporary-mutated-bytes\n');
        writeFileSync(toctouPath, toctouBytes);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }, signer), (error: unknown) => error instanceof RuntimeEvidenceRefusal && error.code === 'artifact_mutated_during_execution');
    assert.throws(() => executeRuntimeEvidence({
      storyId, headHash: expected.headHash, sourceMaterialHash: expected.sourceMaterialHash,
      buildPolicyDigest: expected.buildPolicyDigest, buildCommand: expected.buildCommand,
      executionCommand: expected.executionCommand, environment, toolchain: receipt.toolchain,
      producer: 'post-mutation-smoke', root, artifactInputs: [{ path: 'build/toctou.mjs', sourceHead: expected.headHash }],
      blobStore: countingStore, run: () => ({ stdout: '', stderr: '', exitCode: 0 }),
      postRunStabilityBarrier: () => { writeFileSync(toctouPath, 'post-run-mutation\n'); },
    }, signer), (error: unknown) => error instanceof RuntimeEvidenceRefusal && error.code === 'artifact_mutated_after_execution');
    assert.equal(receiptsIssued, 0);
    console.log('runtime.toctou_mutation: PASS receiptsIssued=0');

    const crashStoryId = 'B-RUNTIME-CRASH';
    store.writeStory(crashStoryId, runtimeStory(crashStoryId));
    const ctx: HandlerContext = { store, root, scanRoot: root };
    const handlers = createFindingLedgerHandlers(ctx);
    const crashArgs = {
      ...runArgs,
      storyId: crashStoryId,
      idempotencyKey: 'runtime-crash-retry',
      commitOptions: { beforeRename: () => { throw new Error('injected runtime receipt crash'); } },
    };
    assert.throws(() => handlers.finding_runtime_evidence_run(crashArgs), /injected runtime receipt crash/);
    const afterCrash = store.readFindingLedger<JsonValue>(crashStoryId);
    assert.equal(afterCrash.records.length, 0);
    assert.equal(afterCrash.receipts.length, 0);
    const recovered = handlers.finding_runtime_evidence_run({ ...crashArgs, commitOptions: undefined });
    const recoveredReplay = handlers.finding_runtime_evidence_run({ ...crashArgs, commitOptions: undefined });
    const recoveredLedger = store.readFindingLedger<JsonValue>(crashStoryId);
    assert.equal(recoveredLedger.records.filter((record) => record.recordType === 'runtime_evidence_receipt').length, 1);
    assert.equal(recoveredLedger.records.filter((record) => record.recordType === 'finding_ledger_receipt').length, 0);
    assert.equal(recoveredLedger.receipts.length, 1);
    assert.equal(recovered.runtimeRecordId, recoveredReplay.runtimeRecordId);
    assert.equal(recovered.ledgerReceiptId, recoveredReplay.ledgerReceiptId);
    console.log('runtime.append_runtime_receipt_crash: PASS rows=1 halfVisible=0 duplicates=0 recoveredSameIds=true');
    runFindingProjectionRegression(root);
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

if (process.argv[2] === '--ledger-worker') {
  appendUnderLock(JSON.parse(process.argv[3] ?? '{}') as WorkerSpec);
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'finding-ledger-smoke-'));
  try {
    const concurrentFile = join(scratch, 'concurrent', 'finding-ledger.json');
    const concurrentLock = join(scratch, 'locks', 'normal-findings.lock');
    const workerCount = 25;
    await runWorkers(Array.from({ length: workerCount }, (_, worker) => ({
      ledgerFile: concurrentFile,
      lockDir: concurrentLock,
      prefix: `finding-${worker}`,
      count: 4,
      recordType: 'finding',
      payloadBase: { storyId: 'B-SMOKE', status: 'open' },
    })));
    const concurrent = readLedger(concurrentFile);
    assert.equal(concurrent.records.length, 100);
    assert.equal(new Set(concurrent.records.map((record) => record.recordId)).size, 100);
    assert.ok(concurrent.records.every((record) => !/^lr_\d+$/.test(record.recordId)));
    console.log('ledger.concurrent_unique_appends: PASS rows=100 uniqueRecordIds=100');

    const originalIds = new Map(concurrent.receipts.map((receipt) => [
      receipt.idempotencyKey,
      `${receipt.recordIds.join(',')}:${receipt.receiptId}`,
    ]));
    const replayLock = acquireMkdirLock(concurrentLock, { label: 'finding ledger replay', requireHolderToken: true });
    try {
      const fence = captureMkdirLockFence(concurrentLock);
      for (const record of concurrent.records) {
        const replay = appendLedgerTransaction(
          concurrentFile,
          request(fence.writerFenceToken, record.idempotencyKey, record.recordType, record.payload),
          fence,
        );
        assert.equal(replay.action, 'replay');
        assert.equal(
          `${replay.records.map((item) => item.recordId).join(',')}:${replay.receipt.receiptId}`,
          originalIds.get(record.idempotencyKey),
        );
      }
    } finally {
      replayLock.release();
    }
    assert.equal(readLedger(concurrentFile).records.length, 100);
    console.log('ledger.idempotent_replay: PASS replays=100 newRows=0 sameIds=true');

    const durableFile = join(scratch, 'durable', 'finding-ledger.json');
    const durableLockDir = join(scratch, 'locks', 'durable.lock');
    const durableLock = acquireMkdirLock(durableLockDir, { label: 'durable ledger commit', requireHolderToken: true });
    const trace: DurableCommitTrace = { fsyncFile: false, atomicRename: false, fsyncDirectory: false };
    try {
      const fence = captureMkdirLockFence(durableLockDir);
      appendLedgerTransaction(
        durableFile,
        request(fence.writerFenceToken, 'durable:1', 'finding', { id: 'B-SMOKE:F-DURABLE' }),
        fence,
        { trace },
      );
    } finally {
      durableLock.release();
    }
    const durable = readLedger(durableFile);
    assert.equal(durable.ledgerSchemaEpoch, FINDING_LEDGER_SCHEMA_EPOCH);
    assert.equal(durable.minimumWriterCapability, FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY);
    assert.deepEqual(trace, { fsyncFile: true, atomicRename: true, fsyncDirectory: true });

    // Exercise the Store choke point and its crash-safe projection: a ledger
    // commit is readable even when the compatibility findings.json mirror was
    // never written (the exact crash window used by finding_add).
    const storeRoot = join(scratch, 'store-integration');
    const store = new StoryStore(storeRoot);
    const storeStoryId = 'B-SMOKE';
    const storeLockDir = store.storyFilePath(storeStoryId, 'findings.lock');
    const storeLock = acquireMkdirLock(storeLockDir, {
      label: 'Store ledger integration', requireHolderToken: true,
    });
    try {
      const fence = captureMkdirLockFence(storeLockDir);
      const finding: Finding = {
        id: 'B-SMOKE:F-001',
        desc: 'committed before compatibility mirror',
        severity: 'high',
        category: 'adversarial',
        status: 'open',
      };
      store.appendFindingLedgerTransaction(storeStoryId, {
        operation: 'append_finding',
        idempotencyKey: 'store-projection:1',
        records: [{ recordType: 'finding', payload: finding }],
        ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH,
        writerCapability: FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
        writerSessionId: 'store-smoke',
        writerFenceToken: fence.writerFenceToken,
        storageCapability: FINDING_LEDGER_LOCAL_FS_CAPABILITY,
      }, fence);
    } finally {
      storeLock.release();
    }
    assert.equal(existsSync(store.storyFilePath(storeStoryId, 'findings.json')), false);
    assert.match(store.readFindings(storeStoryId).findings[0]?.recordId ?? '', /^lr_/);
    console.log('ledger.durable_commit: PASS fsyncFile=true atomicRename=true fsyncDirectory=true');

    const signerPair = generateEd25519KeyPair();
    const proposalPair = generateEd25519KeyPair();
    const ledgerSigner: LedgerSigner = {
      privateKey: signerPair.privateKey,
      publicKey: signerPair.publicKey,
      keyId: 'ledger-key-001',
      trustRootDigest: 'ledger-trust-root-001',
      keyFreshnessPolicyDigest: 'ledger-key-freshness-v1',
    };
    const ledgerTrust: LedgerReceiptTrust = {
      publicKey: signerPair.publicKey,
      keyId: ledgerSigner.keyId,
      algorithm: 'ed25519',
      trustRootDigest: ledgerSigner.trustRootDigest,
      keyFreshnessPolicyDigest: ledgerSigner.keyFreshnessPolicyDigest,
    };
    const integrityStore = new StoryStore(join(scratch, 'chk003-store'));
    const integrityStoryId = 'B-CAS';
    const integrityLockDir = integrityStore.storyFilePath(integrityStoryId, 'findings.lock');
    const integrityLock = acquireMkdirLock(integrityLockDir, {
      label: 'CHK-003 exact CAS', requireHolderToken: true,
    });
    try {
      const fence = captureMkdirLockFence(integrityLockDir);
      const baseOptions = (idempotencyKey: string): Omit<LedgerAppendOptions<JsonValue>, 'operation' | 'records'> => ({
        storyId: integrityStoryId,
        store: integrityStore,
        idempotencyKey,
        writerSessionId: 'chk003-smoke-session',
        writerLeaseId: 'chk003-smoke-lease',
        writerFenceToken: fence.writerFenceToken,
        fence,
        signer: ledgerSigner,
      });

      const seedReceipt = appendFindingLedger({
        ...baseOptions('chk003:seed'),
        operation: 'append_finding',
        records: [{ recordType: 'finding', payload: { id: 'B-CAS:F-001', status: 'open' } }],
      });
      const seedLedger = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const seedRecord = seedLedger.records[0]!;
      const predicateDigest = canonicalHash({ decision: 'caller-approved', recordId: seedRecord.recordId });
      const seedHeadHash = exactLedgerRecordHash(seedRecord);
      const casBinding = {
        recordType: seedRecord.recordType,
        expectedRecordId: seedRecord.recordId,
        expectedRecordHash: exactLedgerRecordHash(seedRecord),
        observedChainHeadId: seedRecord.recordId,
        observedChainHeadHash: seedHeadHash,
        predicateDigest,
      };
      const casOptions: LedgerAppendOptions<JsonValue> = {
        ...baseOptions('chk003:exact-cas'),
        operation: 'append_candidate_route',
        records: [{ recordType: 'candidate_route', payload: { findingId: 'B-CAS:F-001', advisoryOnly: true } }],
        casBindings: [casBinding],
        expectedPriorLedgerDigest: seedLedger.committedLedgerDigest,
        verifyPredicate: (snapshot) => {
          assert.equal(snapshot.referencedRecords.length, 1);
          assert.equal(snapshot.referencedRecords[0]?.canonicalBytes, canonicalJson(seedRecord));
          assert.equal(snapshot.currentChainHeadId, seedRecord.recordId);
          assert.equal(snapshot.currentChainHeadHash, seedHeadHash);
          return { accepted: true, predicateDigest };
        },
      };
      const casReceipt = appendFindingLedger(casOptions);
      const afterCas = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(afterCas.records.length, 2);
      assert.equal(verifyFindingLedgerReceipt(seedReceipt, ledgerTrust), true);
      assert.equal(verifyFindingLedgerReceipt(casReceipt, ledgerTrust), true);
      const acceptedReceiptKeys = [
        'schemaVersion', 'ledgerSchemaEpoch', 'minimumWriterCapability', 'receiptId', 'storyId',
        'idempotencyKey', 'exactRequestDigest', 'operation', 'recordIds', 'casBindings', 'priorLedgerDigest',
        'committedLedgerDigest', 'replayed', 'committedAt', 'writerSessionId', 'writerLeaseId',
        'writerFenceToken', 'keyId', 'algorithm', 'trustRootDigest', 'keyFreshnessPolicyDigest',
        'receiptHash', 'signature',
      ].sort();
      assert.deepEqual(Object.keys(casReceipt).sort(), acceptedReceiptKeys);
      console.log('ledger.receipt_contract: PASS signedFields=complete');
      console.log('ledger.exact_record_cas: PASS committed=true');

      const replay = appendFindingLedger(casOptions);
      const afterReplay = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(replay.receiptId, casReceipt.receiptId);
      assert.deepEqual(replay.recordIds, casReceipt.recordIds);
      assert.equal(replay.signature, casReceipt.signature);
      assert.equal(afterReplay.records.length, afterCas.records.length);
      assert.equal(afterReplay.receipts.length, afterCas.receipts.length);
      assert.equal(afterReplay.records.filter((record) => record.recordType === 'finding_ledger_receipt').length, 0);
      console.log('ledger.receipt_replay: PASS newRows=0 sameIds=true recursiveReceipts=0');

      const relabelIdempotencyKey = 'chk003:idempotency-digest-relabel';
      const relabelV1Options: LedgerAppendOptions<JsonValue> = {
        ...baseOptions(relabelIdempotencyKey),
        operation: 'append_candidate',
        records: [{ recordType: 'candidate', payload: { candidateId: 'digest-relabel', version: 1 } }],
      };
      appendFindingLedger(relabelV1Options);
      const relabelLedgerPath = integrityStore.findingLedgerPath(integrityStoryId);
      const relabelOriginalLedger = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const relabelV2Options: LedgerAppendOptions<JsonValue> = {
        ...relabelV1Options,
        records: [{ recordType: 'candidate', payload: { candidateId: 'digest-relabel', version: 2 } }],
      };
      const digestFor = (options: LedgerAppendOptions<JsonValue>): string => canonicalHash({
        storyId: options.storyId,
        operation: options.operation,
        idempotencyKey: options.idempotencyKey,
        records: options.records,
        casBindings: options.casBindings ?? [],
        ...(options.expectedPriorLedgerDigest !== undefined
          ? { expectedPriorLedgerDigest: options.expectedPriorLedgerDigest }
          : {}),
      });
      const relabeledLedger = structuredClone(relabelOriginalLedger) as typeof relabelOriginalLedger & {
        receipts: Array<Record<string, unknown>>;
      };
      const relabeledCarrier = relabeledLedger.receipts.find((receipt) => (
        receipt.idempotencyKey === relabelIdempotencyKey
      ))!;
      (relabeledCarrier as unknown as Record<string, unknown>).exactRequestDigest = digestFor(relabelV2Options);
      writeFileSync(relabelLedgerPath, `${JSON.stringify(relabeledLedger, null, 2)}\n`);
      let relabeledReplayAccepted = false;
      try {
        appendFindingLedger(relabelV2Options);
        relabeledReplayAccepted = true;
      } catch (error) {
        assert.match(String(error), /IDEMPOTENCY_CONFLICT/);
      }
      const relabeledPersisted = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const relabeledPayload = relabeledPersisted.records.find((record) => (
        record.idempotencyKey === relabelIdempotencyKey
      ))?.payload as Record<string, JsonValue> | undefined;
      writeFileSync(relabelLedgerPath, `${JSON.stringify(relabelOriginalLedger, null, 2)}\n`);
      if (relabeledReplayAccepted) {
        console.log(`ledger.idempotency_digest_relabel_refused: RED replayV2=accepted persistedVersion=${String(relabeledPayload?.version)}`);
      }
      assert.equal(
        relabeledReplayAccepted,
        false,
        'changing only unsigned exactRequestDigest must not relabel a v2 request as a v1 replay',
      );
      assert.equal(relabeledPayload?.version, 1, 'replay refusal must preserve the original v1 payload');
      let relabelRefusals = relabeledReplayAccepted ? 0 : 1;
      const expectReplayBindingRefusal = (
        candidate: typeof relabelOriginalLedger,
        options: LedgerAppendOptions<JsonValue>,
      ): void => {
        writeFileSync(relabelLedgerPath, `${JSON.stringify(candidate, null, 2)}\n`);
        assert.throws(() => appendFindingLedger(options), /IDEMPOTENCY_CONFLICT/);
        relabelRefusals += 1;
        writeFileSync(relabelLedgerPath, `${JSON.stringify(relabelOriginalLedger, null, 2)}\n`);
      };
      const semanticRelabels: LedgerAppendOptions<JsonValue>[] = [
        { ...relabelV1Options, operation: 'append_deferral' },
        { ...relabelV1Options, records: [{ recordType: 'candidate_route', payload: { candidateId: 'digest-relabel', version: 1 } }] },
        {
          ...relabelV1Options,
          casBindings: [{
            recordType: 'finding', expectedRecordId: seedReceipt.recordIds[0]!,
            expectedRecordHash: exactLedgerRecordHash(seedRecord),
            observedChainHeadId: seedRecord.recordId,
            observedChainHeadHash: exactLedgerRecordHash(seedRecord),
            predicateDigest: 'relabel-cas-predicate',
          }],
        },
        { ...relabelV1Options, expectedPriorLedgerDigest: '0'.repeat(64) },
      ];
      for (const options of semanticRelabels) {
        const candidate = structuredClone(relabelOriginalLedger) as typeof relabelOriginalLedger & {
          receipts: Array<Record<string, unknown>>;
        };
        const carrier = candidate.receipts.find((receipt) => receipt.idempotencyKey === relabelIdempotencyKey)!;
        (carrier as unknown as Record<string, unknown>).exactRequestDigest = digestFor(options);
        expectReplayBindingRefusal(candidate, options);
      }

      for (const mutateCarrier of [
        (carrier: Record<string, unknown>) => { carrier.idempotencyKey = 'chk003:idempotency-carrier-relabel'; },
        (carrier: Record<string, unknown>) => { carrier.operation = 'append_deferral'; },
        (carrier: Record<string, unknown>) => { carrier.recordIds = [...seedReceipt.recordIds]; },
        (carrier: Record<string, unknown>) => { carrier.priorLedgerDigest = '0'.repeat(64); },
        (carrier: Record<string, unknown>) => { carrier.requestDigest = '0'.repeat(64); },
      ]) {
        const candidate = structuredClone(relabelOriginalLedger) as typeof relabelOriginalLedger & {
          receipts: Array<Record<string, unknown>>;
        };
        const carrier = candidate.receipts.find((receipt) => receipt.idempotencyKey === relabelIdempotencyKey)!;
        mutateCarrier(carrier as unknown as Record<string, unknown>);
        const candidateKey = String((carrier as unknown as Record<string, unknown>).idempotencyKey);
        expectReplayBindingRefusal(candidate, { ...relabelV1Options, idempotencyKey: candidateKey });
      }

      const legacyCandidate = structuredClone(relabelOriginalLedger) as typeof relabelOriginalLedger & {
        receipts: Array<Record<string, unknown>>;
      };
      const legacyCarrier = legacyCandidate.receipts.find((receipt) => receipt.idempotencyKey === relabelIdempotencyKey)!;
      const signedOriginal = (legacyCarrier as unknown as Record<string, unknown>).findingLedgerReceipt as ReturnType<typeof signFindingLedgerReceipt>;
      const {
        exactRequestDigest: _legacyExactRequestDigest,
        receiptHash: _legacyReceiptHash,
        signature: _legacySignature,
        ...legacyUnsigned
      } = signedOriginal;
      (legacyCarrier as unknown as Record<string, unknown>).findingLedgerReceipt = signFindingLedgerReceipt(
        legacyUnsigned,
        ledgerSigner,
      );
      expectReplayBindingRefusal(legacyCandidate, relabelV1Options);
      assert.equal(relabelRefusals, 11);
      console.log('ledger.idempotency_digest_relabel_refused: PASS replayV2=refused persistedVersion=1 signedBinding=true semanticRelabels=4 carrierRelabels=5 legacyReplay=refused');

      const staleBaseCount = integrityStore.readFindingLedger<JsonValue>(integrityStoryId).records.length;
      const staleAttempts: Array<LedgerAppendOptions<JsonValue>> = [
        {
          ...baseOptions('chk003:stale-id'), operation: 'append_candidate_route',
          records: [{ recordType: 'candidate_route', payload: { rejected: 'record-id' } }],
          casBindings: [{ ...casBinding, expectedRecordId: 'missing-record' }],
          expectedPriorLedgerDigest: afterReplay.committedLedgerDigest,
          verifyPredicate: () => ({ accepted: true, predicateDigest }),
        },
        {
          ...baseOptions('chk003:stale-hash'), operation: 'append_candidate_route',
          records: [{ recordType: 'candidate_route', payload: { rejected: 'record-hash' } }],
          casBindings: [{ ...casBinding, expectedRecordHash: '0'.repeat(64) }],
          expectedPriorLedgerDigest: afterReplay.committedLedgerDigest,
          verifyPredicate: () => ({ accepted: true, predicateDigest }),
        },
        {
          ...baseOptions('chk003:stale-head'), operation: 'append_candidate_route',
          records: [{ recordType: 'candidate_route', payload: { rejected: 'chain-head' } }],
          casBindings: [{ ...casBinding }],
          expectedPriorLedgerDigest: afterReplay.committedLedgerDigest,
          verifyPredicate: () => ({ accepted: true, predicateDigest }),
        },
        {
          ...baseOptions('chk003:stale-predicate'), operation: 'append_candidate_route',
          records: [{ recordType: 'candidate_route', payload: { rejected: 'predicate' } }],
          casBindings: [{
            ...casBinding,
            observedChainHeadId: afterReplay.records.at(-1)!.recordId,
            observedChainHeadHash: exactLedgerRecordHash(afterReplay.records.at(-1)!),
          }],
          expectedPriorLedgerDigest: afterReplay.committedLedgerDigest,
          verifyPredicate: () => ({ accepted: true, predicateDigest: 'different-predicate' }),
        },
        {
          ...baseOptions('chk003:stale-ledger'), operation: 'append_candidate_route',
          records: [{ recordType: 'candidate_route', payload: { rejected: 'prior-ledger' } }],
          expectedPriorLedgerDigest: '0'.repeat(64),
        },
      ];
      for (const attempt of staleAttempts) {
        assert.throws(() => appendFindingLedger(attempt), /CAS_CONFLICT/);
      }
      assert.equal(integrityStore.readFindingLedger(integrityStoryId).records.length, staleBaseCount);
      console.log('ledger.stale_cas: PASS semanticWrites=0');

      const proposal = signedApplicableProposal(proposalPair.privateKey, proposalPair.publicKey, 'assessment-authority-digest');
      const proposalOptions = {
        ...baseOptions('chk003:proposal'),
        proposal,
        proposalPublicKey: proposalPair.publicKey,
        expectedAuthorityDigest: 'assessment-authority-digest',
        now: new Date('2030-01-01T00:30:00.000Z'),
      };
      const proposalReceipt = appendAssessmentProposal(proposalOptions);
      const proposalLedger = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const proposalRecord = proposalLedger.records.find((record) => record.recordType === 'assessment_proposal')!;
      const proposalReceiptRows = proposalLedger.receipts.filter((receipt) => (
        receipt as typeof receipt & { findingLedgerReceipt?: unknown }
      ).findingLedgerReceipt !== undefined);
      assert.equal(proposalLedger.records.filter((record) => record.recordType === 'assessment_proposal').length, 1);
      assert.equal(proposalReceiptRows.filter((receipt) => receipt.receiptId === proposalReceipt.receiptId).length, 1);
      assert.equal(proposalLedger.records.filter((record) => record.recordType.includes('receipt')).length, 0);
      console.log('ledger.assessment_proposal_atomic: PASS proposalRows=1 receiptRows=1 recursiveReceipts=0');

      const validProposal = verifyAssessmentProposal(proposal, {
        publicKey: proposalPair.publicKey,
        expectedAuthorityDigest: 'assessment-authority-digest',
        now: new Date('2030-01-01T00:30:00.000Z'),
        expectedFindingHash: 'finding-hash-001',
        expectedHeadHash: 'head-001',
        expectedMaterialHash: 'material-001',
        expectedStoryFilesHash: 'story-files-001',
        receipt: proposalReceipt,
        receiptTrust: ledgerTrust,
        proposalRecord,
        requireReceipt: true,
        receiptIsCurrent: true,
        finalAssessment: {
          ...proposal,
          assessmentId: 'assessment-001',
          assessmentProposalDigest: proposal.proposalDigest,
          proposalReceipt: {
            receiptId: proposalReceipt.receiptId,
            receiptHash: proposalReceipt.receiptHash,
            operation: 'append_assessment_proposal',
          },
          assessmentHash: 'assessment-hash-001',
          signature: 'final-signature-placeholder',
        },
      });
      assert.equal(validProposal.valid, true);

      const proposalReplayBefore = canonicalJson(proposalRecord);
      const proposalReplay = appendAssessmentProposal(proposalOptions);
      const proposalLedgerAfterReplay = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(proposalReplay.receiptId, proposalReceipt.receiptId);
      assert.deepEqual(proposalReplay.recordIds, proposalReceipt.recordIds);
      assert.equal(proposalLedgerAfterReplay.records.length, proposalLedger.records.length);
      assert.equal(canonicalJson(proposalLedgerAfterReplay.records.find((record) => record.recordId === proposalRecord.recordId)), proposalReplayBefore);
      console.log('ledger.assessment_proposal_replay: PASS newRows=0 sameIds=true bytesUnchanged=true');

      const attacker = generateEd25519KeyPair();
      const wrongSignature = { ...proposal, proposalSignature: 'invalid-signature' };
      const expiredWithoutCallerNow = signedApplicableProposal(
        proposalPair.privateKey,
        proposalPair.publicKey,
        'assessment-authority-digest',
        {
          proposalId: 'proposal-expired-2000',
          issuedAt: '2000-01-01T00:00:00.000Z',
          expiresAt: '2000-01-01T02:00:00.000Z',
        },
      );
      const alteredExactUnion = signAssessmentProposal({
        ...proposalUnsignedForSmoke(proposal),
        owner: 'meta',
      }, proposalPair.privateKey);
      const rejected = [
        verifyAssessmentProposal(proposal, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'wrong-authority',
        }),
        verifyAssessmentProposal(wrongSignature, {
          publicKey: attacker.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(alteredExactUnion, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(proposal, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest', requireReceipt: true,
        }),
        verifyAssessmentProposal(proposal, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
          now: new Date('2030-01-01T03:00:00.000Z'),
        }),
        verifyAssessmentProposal(expiredWithoutCallerNow, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(proposal, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
          receipt: proposalReceipt, receiptTrust: ledgerTrust, proposalRecord,
          finalAssessment: {
            ...proposal,
            findingHash: 'altered-final-finding-hash',
            assessmentProposalDigest: proposal.proposalDigest,
          },
        }),
      ];
      assert.equal(rejected.every((result) => !result.valid), true);
      assert.equal(integrityStore.readFindingLedger(integrityStoryId).records.length, proposalLedgerAfterReplay.records.length);
      assert.equal(rejected[5]?.rejection, 'proposal_expired');
      console.log('ledger.assessment_proposal_rejections: PASS wrongAuthority=reject wrongSignature=reject exactUnion=reject missingReceipt=reject staleExpired=reject proposalFinalDivergence=reject semanticWrites=0 omittedNowExpired=reject');
      const resign = (overrides: Record<string, unknown>) => signAssessmentProposal({
        ...proposalUnsignedForSmoke(proposal),
        ...overrides,
      }, proposalPair.privateKey);
      const findingRef = proposal.findingRef as Record<string, unknown>;
      const signerMetadata = proposal.proposalSigner as Record<string, unknown>;
      const witness = proposal.currentWitness as Record<string, unknown>;
      const dependencyBundle = proposal.dependencyBundle as Record<string, unknown>;
      const structuralRejections = [
        verifyAssessmentProposal(resign({ findingRef: {
          storyId: findingRef.storyId, findingId: findingRef.findingId,
        } }), {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(resign({ currentWitness: { ...witness, receiptIds: [] } }), {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(resign({ proposalSigner: { ...signerMetadata, keyId: 'caller-selected-key' } }), {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(resign({ dependencyBundle: { ...dependencyBundle, digest: 'wrong-digest' } }), {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(proposal, {
          publicKey: proposalPair.publicKey,
          expectedAuthorityDigest: 'assessment-authority-digest',
          receipt: proposalReceipt,
          receiptTrust: ledgerTrust,
          proposalRecord,
        }),
      ];
      assert.equal(structuralRejections.every((result) => !result.valid), true);
      console.log('ledger.assessment_proposal_structural_chain: PASS findingRecordId=required witness=nonempty signer=truthful dependencyDigest=exact receiptCurrent=required semanticWrites=0');

      const standaloneReceipt = appendFindingLedger({
        ...baseOptions('chk003:standalone-receipt'),
        operation: 'append_route_receipt',
        records: [{
          recordType: 'route_receipt',
          payload: { receiptId: 'route-receipt-standalone', profile: 'candidate_route', gateAuthority: false },
          uniqueBindingKey: 'route-receipt:standalone',
        }],
      });
      const beforeStandaloneConflict = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const standaloneRecord = beforeStandaloneConflict.records.find((record) => record.recordId === standaloneReceipt.recordIds[0])!;
      const standaloneBytes = canonicalJson(standaloneRecord);
      const standaloneHead = beforeStandaloneConflict.records.at(-1)!;
      assert.throws(() => appendFindingLedger({
        ...baseOptions('chk003:standalone-route-conflict'),
        operation: 'append_candidate_route',
        records: [{ recordType: 'candidate_route', payload: { id: 'must-not-exist' } }],
        expectedPriorLedgerDigest: beforeStandaloneConflict.committedLedgerDigest,
        casBindings: [{
          recordType: standaloneRecord.recordType,
          expectedRecordId: standaloneRecord.recordId,
          expectedRecordHash: '0'.repeat(64),
          observedChainHeadId: standaloneHead.recordId,
          observedChainHeadHash: exactLedgerRecordHash(standaloneHead),
          predicateDigest: 'standalone-route-predicate',
        }],
        verifyPredicate: () => ({ accepted: true, predicateDigest: 'standalone-route-predicate' }),
      }), /CAS_CONFLICT/);
      const afterStandaloneConflict = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(canonicalJson(afterStandaloneConflict.records.find((record) => record.recordId === standaloneRecord.recordId)), standaloneBytes);
      assert.equal(afterStandaloneConflict.records.some((record) => (record.payload as Record<string, JsonValue>).id === 'must-not-exist'), false);
      console.log('ledger.standalone_receipt_conflict: PASS receiptPreserved=true routeWrites=0');

      const baselineBundle = appendFindingLedger({
        ...baseOptions('chk003:baseline-bundle'),
        operation: 'append_progress_baseline_set',
        records: [
          { recordType: 'route_receipt', payload: { receiptId: 'finding-route-bundle', profile: 'finding_route', gateAuthority: false } },
          ...['target_source_change', 'target_test_result', 'target_delivery_state', 'target_status_transition'].map((kind) => ({
            recordType: 'progress_baseline',
            payload: { baselineSetId: 'baseline-set-001', kind, gateAuthority: false } as JsonValue,
          })),
        ],
      });
      assert.equal(baselineBundle.recordIds.length, 5);
      const beforeBundleCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const baselineRecords = baselineBundle.recordIds.map((recordId) => (
        beforeBundleCrash.records.find((record) => record.recordId === recordId)!
      ));
      const baselineHead = beforeBundleCrash.records.at(-1)!;
      const baselinePredicateDigest = canonicalHash({
        profile: 'exact-four-progress-baselines-v1',
        recordIds: baselineBundle.recordIds,
      });
      const baselineBindings = baselineRecords.map((record) => ({
        recordType: record.recordType,
        expectedRecordId: record.recordId,
        expectedRecordHash: exactLedgerRecordHash(record),
        observedChainHeadId: baselineHead.recordId,
        observedChainHeadHash: exactLedgerRecordHash(baselineHead),
        predicateDigest: baselinePredicateDigest,
      }));
      const verifyBaselineBundle = (snapshot: Parameters<NonNullable<LedgerAppendOptions<JsonValue>['verifyPredicate']>>[0]) => {
        const kinds = snapshot.referencedRecords
          .filter(({ record }) => record.recordType === 'progress_baseline')
          .map(({ record }) => String((record.payload as Record<string, JsonValue>).kind))
          .sort();
        const expectedKinds = [
          'target_delivery_state', 'target_source_change', 'target_status_transition', 'target_test_result',
        ];
        const routeCount = snapshot.referencedRecords.filter(({ record }) => record.recordType === 'route_receipt').length;
        return {
          accepted: routeCount === 1 && canonicalJson(kinds) === canonicalJson(expectedKinds),
          predicateDigest: baselinePredicateDigest,
        };
      };
      const deferralAttempt = (
        idempotencyKey: string,
        casBindings = baselineBindings,
        verifyPredicate: LedgerAppendOptions<JsonValue>['verifyPredicate'] = verifyBaselineBundle,
        commitOptions?: LedgerAppendOptions<JsonValue>['commitOptions'],
      ) => appendFindingLedger({
        ...baseOptions(idempotencyKey),
        operation: 'apply_manifest',
        records: [
          { recordType: 'deferral', payload: { deferralId: idempotencyKey } },
          { recordType: 'manifest', payload: { manifestId: `${idempotencyKey}:manifest`, deferralId: idempotencyKey } },
        ],
        expectedPriorLedgerDigest: beforeBundleCrash.committedLedgerDigest,
        casBindings,
        verifyPredicate,
        commitOptions,
      });
      const wrongId = baselineBindings.map((binding, index) => index === 1
        ? { ...binding, expectedRecordId: 'missing-baseline-record' }
        : binding);
      const wrongHash = baselineBindings.map((binding, index) => index === 2
        ? { ...binding, expectedRecordHash: '0'.repeat(64) }
        : binding);
      const changedBaseline = { ...baselineRecords[3]!, payload: { baselineSetId: 'baseline-set-001', kind: 'changed-bytes' } };
      const changedBytes = baselineBindings.map((binding, index) => index === 3
        ? { ...binding, expectedRecordHash: exactLedgerRecordHash(changedBaseline) }
        : binding);
      const negativeAttempts = [
        () => deferralAttempt('chk003:deferral-wrong-id', wrongId),
        () => deferralAttempt('chk003:deferral-wrong-hash', wrongHash),
        () => deferralAttempt('chk003:deferral-missing-kind', baselineBindings.slice(0, -1)),
        () => deferralAttempt('chk003:deferral-baseline-bytes-changed', changedBytes),
        () => deferralAttempt('chk003:deferral-caller-refusal', baselineBindings, () => ({
          accepted: false, predicateDigest: baselinePredicateDigest,
        })),
      ];
      for (const attempt of negativeAttempts) assert.throws(attempt, /CAS_CONFLICT/);
      assert.equal(integrityStore.readFindingLedger<JsonValue>(integrityStoryId).records.length, beforeBundleCrash.records.length);
      assert.throws(() => deferralAttempt(
        'chk003:deferral-bundle-crash',
        baselineBindings,
        verifyBaselineBundle,
        { beforeRename: () => { throw new Error('injected bundle crash'); } },
      ), /injected bundle crash/);
      const afterBundleCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(afterBundleCrash.records.length, beforeBundleCrash.records.length);
      assert.equal(afterBundleCrash.records.some((record) => canonicalJson(record.payload).includes('deferral-crash')), false);
      const appliedDeferral = deferralAttempt('chk003:deferral-bundle-applied');
      assert.equal(appliedDeferral.recordIds.length, 2);
      const appliedReplay = deferralAttempt('chk003:deferral-bundle-applied');
      assert.deepEqual(appliedReplay.recordIds, appliedDeferral.recordIds);
      console.log('ledger.baseline_bundle_refusal: PASS wrongId=reject wrongHash=reject missingKind=reject bytesChanged=reject callerRefusal=reject zeroWrites=true');
      console.log('ledger.atomic_bundle: PASS halfBundles=0 kinds=4 crashRetry=true');

      const requiredRecord = {
        schemaVersion: 1, mandatoryRepairId: 'mandatory-repair-required-001',
        findingRef: { storyId: integrityStoryId, findingId: 'B-CAS:F-001' },
        state: 'required', classificationHash: 'classification-required-hash',
      };
      const requiredManifest = {
        schemaVersion: 1, manifestId: 'mandatory-manifest-required-001',
        mandatoryRepairId: requiredRecord.mandatoryRepairId,
      };
      const requiredOptions = {
        ...baseOptions('chk003:mandatory-required'),
        record: requiredRecord,
        manifest: requiredManifest,
      };
      const requiredReceipt = classifyMandatoryRepair(requiredOptions);
      const afterRequired = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const requiredBytes = requiredReceipt.recordIds.map((recordId) => canonicalJson(afterRequired.records.find((record) => record.recordId === recordId)));
      const requiredReplay = classifyMandatoryRepair(requiredOptions);
      assert.deepEqual(requiredReplay.recordIds, requiredReceipt.recordIds);
      assert.equal(requiredReplay.receiptId, requiredReceipt.receiptId);

      const closedRecord = {
        schemaVersion: 1, mandatoryRepairId: 'mandatory-repair-closure-001',
        supersedesMandatoryRepairId: requiredRecord.mandatoryRepairId,
        state: 'closure_proven', classificationHash: 'classification-closure-hash',
        closure: {
          redOrReproductionEvidenceRefs: ['red:1'], rootCauseEvidenceRefs: ['root:1'],
          fixEvidenceRefs: ['fix:1'], greenEvidenceRefs: ['green:1'], closureEvidenceRefs: ['close:1'],
        },
      };
      const closeReceipt = closeMandatoryRepair({
        ...baseOptions('chk003:mandatory-closure'),
        record: closedRecord,
        manifest: {
          schemaVersion: 1, manifestId: 'mandatory-manifest-closure-001',
          mandatoryRepairId: closedRecord.mandatoryRepairId,
          supersedesMandatoryRepairId: requiredRecord.mandatoryRepairId,
        },
      });
      assert.equal(closeReceipt.recordIds.length, 2);
      const beforeMandatoryCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.throws(() => classifyMandatoryRepair({
        ...baseOptions('chk003:mandatory-crash'),
        record: { ...requiredRecord, mandatoryRepairId: 'mandatory-repair-crash' },
        manifest: { manifestId: 'mandatory-manifest-crash', mandatoryRepairId: 'mandatory-repair-crash' },
        commitOptions: { beforeRename: () => { throw new Error('injected mandatory crash'); } },
      }), /injected mandatory crash/);
      const afterMandatoryCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(afterMandatoryCrash.records.length, beforeMandatoryCrash.records.length);
      assert.deepEqual(requiredReceipt.recordIds.map((recordId) => canonicalJson(afterMandatoryCrash.records.find((record) => record.recordId === recordId))), requiredBytes);
      assert.equal(new Set([...requiredReceipt.recordIds, ...closeReceipt.recordIds]).size, 4);
      console.log('ledger.mandatory_repair_records: PASS appendOnly=true idempotent=true halfVisible=0');

      const expiryRecord = {
        schemaVersion: 1, policyVersion: 'v1', policyDigest: 'expiry-policy-digest-001',
        effectiveAt: '2030-01-01T00:00:00.000Z', signedByAuthority: 'command_policy_authority',
      };
      const expiryOptions = {
        ...baseOptions('chk003:expiry-policy'),
        record: expiryRecord,
        manifest: { schemaVersion: 1, manifestId: 'expiry-manifest-001', policyDigest: expiryRecord.policyDigest },
      };
      const expiryReceipt = appendDeferralExpiryPolicy(expiryOptions);
      const expiryReplay = appendDeferralExpiryPolicy(expiryOptions);
      assert.equal(expiryReplay.receiptId, expiryReceipt.receiptId);
      assert.deepEqual(expiryReplay.recordIds, expiryReceipt.recordIds);
      const beforeExpiryCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.throws(() => appendDeferralExpiryPolicy({
        ...baseOptions('chk003:expiry-policy-crash'),
        record: { ...expiryRecord, policyDigest: 'expiry-policy-digest-crash' },
        manifest: { manifestId: 'expiry-manifest-crash', policyDigest: 'expiry-policy-digest-crash' },
        commitOptions: { beforeRename: () => { throw new Error('injected expiry crash'); } },
      }), /injected expiry crash/);
      assert.equal(integrityStore.readFindingLedger(integrityStoryId).records.length, beforeExpiryCrash.records.length);
      console.log('ledger.expiry_policy_records: PASS appendOnly=true idempotent=true halfVisible=0');

      const mutatedReceipts: Array<typeof casReceipt> = [];
      const mutate = (field: string, value: unknown): void => {
        const copy = structuredClone(casReceipt) as unknown as Record<string, unknown>;
        copy[field] = value;
        mutatedReceipts.push(copy as unknown as typeof casReceipt);
      };
      mutate('schemaVersion', 2);
      mutate('ledgerSchemaEpoch', 2);
      mutate('minimumWriterCapability', 'other-writer');
      mutate('receiptId', 'other-receipt');
      mutate('storyId', 'B-OTHER');
      mutate('idempotencyKey', 'other-idempotency');
      mutate('exactRequestDigest', '0'.repeat(64));
      mutate('operation', 'append_deferral');
      mutate('recordIds', [...casReceipt.recordIds, 'extra-record']);
      mutate('casBindings', [{ ...casReceipt.casBindings[0]!, predicateDigest: 'other-predicate' }]);
      mutate('priorLedgerDigest', '1'.repeat(64));
      mutate('committedLedgerDigest', '2'.repeat(64));
      mutate('replayed', true);
      mutate('committedAt', '2031-01-01T00:00:00.000Z');
      mutate('writerSessionId', 'other-session');
      mutate('writerLeaseId', 'other-lease');
      mutate('writerFenceToken', 'other-fence');
      mutate('keyId', 'other-key');
      mutate('algorithm', 'other-algorithm');
      mutate('trustRootDigest', 'other-trust-root');
      mutate('keyFreshnessPolicyDigest', 'other-freshness');
      mutate('receiptHash', '3'.repeat(64));
      mutate('signature', 'invalid-signature');
      const reorderedIds = structuredClone(baselineBundle);
      reorderedIds.recordIds = [...reorderedIds.recordIds].reverse();
      mutatedReceipts.push(reorderedIds);
      const extraField = structuredClone(casReceipt) as unknown as Record<string, unknown>;
      extraField.unaccepted = true;
      mutatedReceipts.push(extraField as unknown as typeof casReceipt);
      assert.equal(mutatedReceipts.filter((candidate) => verifyFindingLedgerReceipt(candidate, ledgerTrust)).length, 0);
      console.log('ledger.receipt_mutation_matrix: PASS acceptedMutations=0');

      const applySeed = appendFindingLedger({
        ...baseOptions('chk003:apply-seed'), operation: 'append_route_receipt',
        records: [{ recordType: 'route_receipt', payload: { receiptId: 'apply-seed', status: 'current' } }],
      });
      const beforeApply = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const applyRecord = beforeApply.records.find((record) => record.recordId === applySeed.recordIds[0])!;
      const applyHead = beforeApply.records.at(-1)!;
      const applyPredicate = 'apply-current-receipt';
      const applyBinding = {
        recordType: applyRecord.recordType,
        expectedRecordId: applyRecord.recordId,
        expectedRecordHash: exactLedgerRecordHash(applyRecord),
        observedChainHeadId: applyHead.recordId,
        observedChainHeadHash: exactLedgerRecordHash(applyHead),
        predicateDigest: applyPredicate,
      };
      appendFindingLedger({
        ...baseOptions('chk003:apply-wins'), operation: 'apply_manifest',
        records: [
          { recordType: 'deferral', payload: { deferralId: 'serialized-apply' } },
          { recordType: 'manifest', payload: { manifestId: 'serialized-apply-manifest', deferralId: 'serialized-apply' } },
        ],
        expectedPriorLedgerDigest: beforeApply.committedLedgerDigest,
        casBindings: [applyBinding],
        verifyPredicate: () => ({ accepted: true, predicateDigest: applyPredicate }),
      });
      assert.throws(() => appendFindingLedger({
        ...baseOptions('chk003:late-revoke'), operation: 'append_supersession',
        records: [{ recordType: 'supersession', payload: { supersedes: 'apply-seed' } }],
        expectedPriorLedgerDigest: beforeApply.committedLedgerDigest,
        casBindings: [applyBinding],
        verifyPredicate: () => ({ accepted: true, predicateDigest: applyPredicate }),
      }), /CAS_CONFLICT/);

      const revokeSeed = appendFindingLedger({
        ...baseOptions('chk003:revoke-seed'), operation: 'append_route_receipt',
        records: [{ recordType: 'route_receipt', payload: { receiptId: 'revoke-seed', status: 'current' } }],
      });
      const beforeRevoke = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const revokeRecord = beforeRevoke.records.find((record) => record.recordId === revokeSeed.recordIds[0])!;
      const revokeBinding = {
        recordType: revokeRecord.recordType,
        expectedRecordId: revokeRecord.recordId,
        expectedRecordHash: exactLedgerRecordHash(revokeRecord),
        observedChainHeadId: revokeRecord.recordId,
        observedChainHeadHash: exactLedgerRecordHash(revokeRecord),
        predicateDigest: 'revoke-current-receipt',
      };
      appendFindingLedger({
        ...baseOptions('chk003:revoke-wins'), operation: 'append_supersession',
        records: [{ recordType: 'supersession', payload: { supersedes: 'revoke-seed' } }],
        expectedPriorLedgerDigest: beforeRevoke.committedLedgerDigest,
        casBindings: [revokeBinding],
        verifyPredicate: () => ({ accepted: true, predicateDigest: 'revoke-current-receipt' }),
      });
      assert.throws(() => appendFindingLedger({
        ...baseOptions('chk003:late-apply'), operation: 'apply_manifest',
        records: [{ recordType: 'deferral', payload: { deferralId: 'non-latest-must-not-commit' } }],
        expectedPriorLedgerDigest: beforeRevoke.committedLedgerDigest,
        casBindings: [revokeBinding],
        verifyPredicate: () => ({ accepted: true, predicateDigest: 'revoke-current-receipt' }),
      }), /CAS_CONFLICT/);
      assert.equal(integrityStore.readFindingLedger<JsonValue>(integrityStoryId).records.some((record) => canonicalJson(record.payload).includes('non-latest-must-not-commit')), false);
      console.log('ledger.revoke_apply_serialization: PASS nonLatestCommits=0');

      const beforeCallbackCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const callbackRecord = beforeCallbackCrash.records.at(-1)!;
      const callbackPredicate = 'opaque-caller-predicate';
      assert.throws(() => appendFindingLedger({
        ...baseOptions('chk003:callback-crash'), operation: 'append_candidate',
        records: [{ recordType: 'opaque_future_record', payload: { uninterpreted: ['route', 'assessment', 'gate'] } }],
        expectedPriorLedgerDigest: beforeCallbackCrash.committedLedgerDigest,
        casBindings: [{
          recordType: callbackRecord.recordType,
          expectedRecordId: callbackRecord.recordId,
          expectedRecordHash: exactLedgerRecordHash(callbackRecord),
          observedChainHeadId: callbackRecord.recordId,
          observedChainHeadHash: exactLedgerRecordHash(callbackRecord),
          predicateDigest: callbackPredicate,
        }],
        verifyPredicate: () => { throw new Error('schema-neutral callback crash'); },
      }), /schema-neutral callback crash/);
      assert.equal(integrityStore.readFindingLedger(integrityStoryId).records.length, beforeCallbackCrash.records.length);
      console.log('ledger.callback_crash_boundary: PASS semanticWrites=0 schemaNeutral=true');
    } finally {
      integrityLock.release();
    }

    const mixedFile = join(scratch, 'mixed', 'finding-ledger.json');
    const mixedLock = join(scratch, 'locks', 'mixed.lock');
    const mixedTypes = [
      'finding',
      'candidate_route',
      'assessment',
      'mandatory_repair',
      'expiry_policy',
      'deferral',
      'route',
      'baseline_set',
      'material_drift_reattestation',
      'manifest',
    ];
    await runWorkers(mixedTypes.map((recordType, index) => ({
      ledgerFile: mixedFile,
      lockDir: mixedLock,
      prefix: `mixed-${index}`,
      count: 2,
      recordType,
      payloadBase: { ref: 'root' },
    })));
    const mixed = readLedger(mixedFile);
    assert.equal(mixed.records.length, mixedTypes.length * 2);
    assert.equal(mixed.records.filter((record) => (record.payload as Record<string, JsonValue>).ref !== 'root').length, 0);
    console.log('ledger.mixed_transactions: PASS lost=0 brokenRefs=0');

    const legacyFile = join(scratch, 'legacy', 'finding-ledger.json');
    const legacyLockDir = join(scratch, 'locks', 'legacy.lock');
    const legacyFindingPath = join(scratch, 'legacy', 'findings.json');
    mkdirSync(join(scratch, 'legacy'), { recursive: true });
    const legacyBytes = '{\n  "findings": [{"id":"B-OLD:F-001","desc":"legacy bytes"}]\n}\n';
    writeFileSync(legacyFindingPath, legacyBytes, 'utf8');
    await runWorkers(Array.from({ length: 12 }, (_, index) => ({
      ledgerFile: legacyFile,
      lockDir: legacyLockDir,
      prefix: `legacy-${index}`,
      count: 1,
      recordType: 'legacy_identity_binding',
      payloadBase: { storyId: 'B-OLD', findingId: 'B-OLD:F-001', findingHash: 'abc123' },
      uniqueBindingKey: 'legacy:B-OLD:B-OLD:F-001',
    })));
    const legacy = readLedger(legacyFile);
    assert.equal(legacy.records.length, 1);
    assert.equal(new Set(legacy.receipts.flatMap((receipt) => receipt.recordIds)).size, 1);
    const legacyConflictLock = acquireMkdirLock(legacyLockDir, {
      label: 'legacy binding conflict', requireHolderToken: true,
    });
    try {
      const fence = captureMkdirLockFence(legacyLockDir);
      assert.throws(() => appendLedgerTransaction(
        legacyFile,
        request(
          fence.writerFenceToken,
          'legacy-conflicting-hash',
          'legacy_identity_binding',
          { storyId: 'B-OLD', findingId: 'B-OLD:F-001', findingHash: 'changed' },
          'legacy:B-OLD:B-OLD:F-001',
        ),
        fence,
      ), /IMMUTABLE_BINDING_CONFLICT|already bound/);
    } finally {
      legacyConflictLock.release();
    }
    assert.equal(readLedger(legacyFile).records.length, 1);
    assert.equal(readFileSync(legacyFindingPath, 'utf8'), legacyBytes);
    console.log('ledger.legacy_binding: PASS singleRecord=true rewrite=false');
    console.log('green.legacy_migration: PASS legacyRewrites=0');

    const refusalFile = join(scratch, 'refusal', 'finding-ledger.json');
    const refusalLockDir = join(scratch, 'locks', 'refusal.lock');
    const refusalLock = acquireMkdirLock(refusalLockDir, { label: 'capability refusal', requireHolderToken: true });
    try {
      const fence = captureMkdirLockFence(refusalLockDir);
      const base = request(fence.writerFenceToken, 'refusal', 'finding', { id: 'refused' });
      const attempts: AppendRequest<JsonValue>[] = [
        { ...base, storageCapability: 'nfs-multi-host' },
        { ...base, ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH + 1 },
        { ...base, writerCapability: 'legacy-writer-v0' },
      ];
      for (const attempt of attempts) {
        assert.throws(() => appendLedgerTransaction(refusalFile, attempt, fence), LedgerRefusal);
      }
    } finally {
      refusalLock.release();
    }
    assert.equal(existsSync(refusalFile), false);
    console.log('ledger.capability_boundary: PASS writes=0');

    const crashFile = join(scratch, 'crash', 'finding-ledger.json');
    const crashLockDir = join(scratch, 'locks', 'crash.lock');
    const crashLock = acquireMkdirLock(crashLockDir, { label: 'crash boundary', requireHolderToken: true });
    try {
      const fence = captureMkdirLockFence(crashLockDir);
      assert.throws(() => appendLedgerTransaction(
        crashFile,
        request(fence.writerFenceToken, 'crash:1', 'finding', { id: 'half' }),
        fence,
        { beforeRename: () => { throw new Error('injected crash before rename'); } },
      ), /injected crash/);
    } finally {
      crashLock.release();
    }
    assert.equal(recoverLedger(crashFile).records.length, 0);
    console.log('ledger.crash_recovery: PASS halfVisible=0');

    const staleFile = join(scratch, 'stale', 'finding-ledger.json');
    const staleLockDir = join(scratch, 'locks', 'stale.lock');
    const staleHolder = acquireMkdirLock(staleLockDir, {
      label: 'stale holder', requireHolderToken: true, staleMs: 5, deadlineMs: 50,
    });
    const staleFence = captureMkdirLockFence(staleLockDir);
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(staleLockDir, oldTime, oldTime);
    const successor = acquireMkdirLock(staleLockDir, {
      label: 'successor holder', requireHolderToken: true, staleMs: 5, deadlineMs: 1_000,
    });
    try {
      assert.throws(() => appendLedgerTransaction(
        staleFile,
        request(staleFence.writerFenceToken, 'stale:1', 'finding', { id: 'stale' }),
        staleFence,
      ), /STALE_FENCE|ownership changed/);
      assert.equal(existsSync(staleFile), false);
      const successorFence = captureMkdirLockFence(staleLockDir);
      appendLedgerTransaction(
        staleFile,
        request(successorFence.writerFenceToken, 'successor:1', 'finding', { id: 'current' }),
        successorFence,
      );
      staleHolder.release();
      assert.equal(successor.isCurrent?.(), true);
    } finally {
      successor.release();
    }
    assert.equal(readLedger(staleFile).records.length, 1);
    console.log('ledger.stale_fence: PASS staleWrites=0');

    const interleavingFile = join(scratch, 'stale-interleaving', 'finding-ledger.json');
    const interleavingLockDir = join(scratch, 'locks', 'stale-interleaving.lock');
    const oldWriter = acquireMkdirLock(interleavingLockDir, {
      label: 'old writer interleaving', requireHolderToken: true,
    });
    const oldFence = captureMkdirLockFence(interleavingLockDir);
    let successorIssuedBeforePublication = false;
    let successorWriter: ReturnType<typeof acquireMkdirLock> | undefined;
    assert.throws(() => appendLedgerTransaction(
      interleavingFile,
      request(oldFence.writerFenceToken, 'interleaving:old', 'finding', { id: 'must-not-commit' }),
      oldFence,
      {
        beforeRename: () => {
          oldWriter.release();
          successorWriter = acquireMkdirLock(interleavingLockDir, {
            label: 'successor writer interleaving', requireHolderToken: true,
          });
          successorIssuedBeforePublication = true;
        },
      },
    ), /STALE_FENCE|ownership changed/);
    assert.equal(successorIssuedBeforePublication, true);
    assert.equal(existsSync(interleavingFile), false);
    try {
      const successorFence = captureMkdirLockFence(interleavingLockDir);
      appendLedgerTransaction(
        interleavingFile,
        request(successorFence.writerFenceToken, 'interleaving:successor', 'finding', { id: 'successor-only' }),
        successorFence,
      );
    } finally {
      successorWriter?.release();
    }
    const interleavingLedger = readLedger(interleavingFile);
    assert.deepEqual(interleavingLedger.records.map((record) => (
      record.payload as Record<string, JsonValue>
    ).id), ['successor-only']);
    console.log('ledger.stale_fence_interleaving: PASS successorIssuedBeforePublication=true staleWriterCommitted=false');

    const normalCompatibilityLock = join(scratch, 'story', 'B-SMOKE', 'findings.lock');
    const normal = acquireMkdirLock(normalCompatibilityLock, {
      label: 'normal Finding compatibility', requireHolderToken: true,
    });
    try {
      const fence = captureMkdirLockFence(normalCompatibilityLock);
      appendLedgerTransaction(
        join(scratch, 'story', 'B-SMOKE', 'finding-ledger.json'),
        request(fence.writerFenceToken, 'lock-normal', 'finding', { id: 'normal' }),
        fence,
      );
    } finally {
      normal.release();
    }
    const main = acquireMainWriteLock(scratch, { label: 'B-META ledger compatibility', onContention: 'wait' });
    try {
      const canonicalMainLock = mainWriteLockPath(scratch);
      assert.equal(main.lockDir, canonicalMainLock);
      const fence = captureMkdirLockFence(canonicalMainLock);
      appendLedgerTransaction(
        join(scratch, 'story', 'B-META-framework-audit', 'finding-ledger.json'),
        request(fence.writerFenceToken, 'lock-meta', 'finding', { id: 'meta' }),
        fence,
      );
    } finally {
      main.release();
    }
    console.log('ledger.lock_compatibility: PASS deadlocks=0');
    await runRuntimeEvidenceMatrix(scratch);
    runRollbackKillSwitchMatrix(scratch);
    await runCombinedConcurrencyMatrix(scratch);
    runFailClosedBoundaryMatrix(scratch);

    const repositoryRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']);
    runRealBfe8fLifecycleMigrationRegression(repositoryRoot, scratch);
    runBuildLockFifoRegression(repositoryRoot, scratch);
    assertRedGreenRelation(repositoryRoot);
    assertVersionSync(repositoryRoot);
    assertCleanPackInstall(repositoryRoot);
    runAggregateTamperMatrix(repositoryRoot);
    runDependencyScorecardBoundary(repositoryRoot);

    // Each aggregate verdict is emitted only after its detailed assertions and
    // mutation/refusal fixtures above have completed without an exception.
    console.log('Finding ledger integrity: PASS');
    console.log('Runtime evidence integrity: PASS');
    console.log('green.story3_matrix: PASS');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
