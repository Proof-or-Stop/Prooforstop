import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FINDING_LEDGER_LOCAL_FS_CAPABILITY,
  FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
  FINDING_LEDGER_SCHEMA_EPOCH,
  LedgerRefusal,
  appendLedgerTransaction,
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
  canonicalHash,
  canonicalJson,
  classifyMandatoryRepair,
  closeMandatoryRepair,
  createFindingLedgerHandlers,
  exactLedgerRecordHash,
  RUNTIME_EVIDENCE_BUILD_POLICY_DIGEST,
  RUNTIME_EVIDENCE_PRIVATE_KEY_ENV,
  RUNTIME_EVIDENCE_PUBLIC_KEY_ENV,
  signAssessmentProposal,
  verifyAssessmentProposal,
  verifyFindingLedgerReceipt,
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
import type { HandlerContext } from '../handlers/context.js';
import type { Finding, StoryInfo } from '../core/types.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';

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
  authorityDigest: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const issuedAt = '2030-01-01T00:00:00.000Z';
  return signAssessmentProposal({
    schemaVersion: 1,
    proposalId: 'proposal-001',
    findingRef: { storyId: 'B-CAS', findingId: 'B-CAS:F-001' },
    findingHash: 'finding-hash-001',
    findingVersion: 'v1',
    evaluationScope: 'target_story',
    owner: 'current_story',
    issuedAt,
    expiresAt: '2030-01-01T02:00:00.000Z',
    freshnessPolicyVersion: 'v1',
    maxAgeSeconds: 7200,
    dependencyBundle: {
      digest: 'dependency-digest',
      sourceFinding: { storyId: 'B-CAS', findingId: 'B-CAS:F-001', hash: 'finding-hash-001', version: 'v1' },
      proofPolicyDigest: 'proof-policy',
      reviewerAuthorityPolicyDigest: 'reviewer-policy',
      ledgerSnapshotDigest: 'ledger-snapshot',
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
      actorId: 'assessment-authority', authorityDigest, keyId: 'proposal-key',
      algorithm: 'ed25519', trustRootDigest: 'proposal-trust-root',
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
  command: 'finding_runtime_evidence_run' | 'finding_runtime_evidence_verify',
  args: Record<string, unknown>,
  signingEnv: Record<string, string>,
): { status: number | null; stdout: string; stderr: string; json?: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'packages', 'main', 'dist', 'cli.js'), command, JSON.stringify(args)], {
    cwd: projectRoot,
    env: { ...process.env, ...signingEnv },
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

function runRuntimeEvidenceMatrix(scratch: string): void {
  const repositoryRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const root = join(scratch, 'runtime-project');
  const storyId = 'B-RUNTIME';
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures',
    storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }, null, 2));
  writeFileSync(join(root, 'source.txt'), 'runtime evidence source\n');
  git(root, ['init', '-q']);
  git(root, ['add', 'proof-or-stop.config.json', 'source.txt']);
  git(root, ['-c', 'user.name=runtime-smoke', '-c', 'user.email=runtime@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'runtime source']);
  const store = new StoryStore(root);
  store.writeStory(storyId, runtimeStory(storyId));

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
      keyPair.publicKey,
    ), true, 'runtime receipt Ed25519 signature is invalid');
    assert.equal(verifyRuntimeEvidenceReceiptSignature(receipt, keyPair.publicKey), true);
    console.log('runtime.content_addressed_receipt: PASS blobs=complete signature=valid');

    const signer: RuntimeReceiptSigner = {
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      keyId: receipt.keyId,
      trustRootDigest: receipt.trustRootDigest,
      keyFreshnessPolicyDigest: receipt.keyFreshnessPolicyDigest,
      algorithm: 'ed25519',
    };
    const trust: RuntimeReceiptTrust = {
      publicKey: keyPair.publicKey,
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
      publicKey: keyPair.publicKey,
      storageCapability: RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
    };
    const cliVerify = runRuntimeCli(repositoryRoot, root, 'finding_runtime_evidence_verify', verifyArgs, signingEnv);
    assert.equal(cliVerify.status, 0, `real runtime verify CLI failed: ${cliVerify.stderr}\n${cliVerify.stdout}`);
    assert.equal(cliVerify.json?.verified, true);
    console.log('runtime.real_cli_verify_adapter: PASS command=finding_runtime_evidence_verify verified=true');

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

    const persistedText = `${JSON.stringify(runJson)}\n${readTreeText(join(root, '.lattice', 'evidence'))}\n${readTreeText(store.storyDirPath(storyId))}`;
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
    const buildBusy = runRuntimeCli(repositoryRoot, root, 'finding_runtime_evidence_run', {
      ...runArgs, idempotencyKey: 'runtime-build-busy', buildInProgress: true,
    }, signingEnv);
    assert.notEqual(buildBusy.status, 0);
    assert.match(`${buildBusy.stdout}\n${buildBusy.stderr}`, /build_in_progress/);
    assert.equal(store.readFindingLedger<JsonValue>(storyId).records.length, rowsBeforeRefusal);
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
    console.log('runtime.append_runtime_receipt_replay: PASS newRows=0 sameRecordId=true sameReceiptId=true bytesUnchanged=true');

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
        'idempotencyKey', 'operation', 'recordIds', 'casBindings', 'priorLedgerDigest',
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

      const staleBaseCount = afterReplay.records.length;
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

      const proposal = signedApplicableProposal(proposalPair.privateKey, 'assessment-authority-digest');
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
      console.log('ledger.assessment_proposal_rejections: PASS wrongAuthority=reject wrongSignature=reject exactUnion=reject missingReceipt=reject staleExpired=reject proposalFinalDivergence=reject semanticWrites=0');

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
          ...['red', 'root_cause', 'fix', 'green'].map((kind) => ({
            recordType: 'progress_baseline',
            payload: { baselineSetId: 'baseline-set-001', kind, gateAuthority: false } as JsonValue,
          })),
        ],
      });
      assert.equal(baselineBundle.recordIds.length, 5);
      const beforeBundleCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.throws(() => appendFindingLedger({
        ...baseOptions('chk003:deferral-bundle-crash'),
        operation: 'apply_manifest',
        records: [
          { recordType: 'deferral', payload: { deferralId: 'deferral-crash' } },
          { recordType: 'manifest', payload: { manifestId: 'manifest-crash', deferralId: 'deferral-crash' } },
        ],
        commitOptions: { beforeRename: () => { throw new Error('injected bundle crash'); } },
      }), /injected bundle crash/);
      const afterBundleCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(afterBundleCrash.records.length, beforeBundleCrash.records.length);
      assert.equal(afterBundleCrash.records.some((record) => canonicalJson(record.payload).includes('deferral-crash')), false);
      console.log('ledger.atomic_bundle: PASS halfBundles=0');

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
    runRuntimeEvidenceMatrix(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
