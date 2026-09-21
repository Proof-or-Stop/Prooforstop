import { assertStory3VerifierPositiveControl } from './process-mutation-proof.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';

import { emptyLedger, type JsonValue } from '../../core/finding-ledger.js';
import { buildLockTarget, distImportLockTarget } from '../../../../../scripts/build-lock-target.mjs';
import { canonicalDigest, generateEd25519KeyPair, verifyCanonical } from '../../core/authority-signing.js';
import { bindLegacyFindingLedgerReceipts, canonicalHash, canonicalJson, createFindingLedgerHandlers, findingLedgerSignerFromWorkspace, findingLedgerTrustFromWorkspace, queryFindingLedger, RUNTIME_EVIDENCE_BUILD_POLICY_DIGEST, RUNTIME_EVIDENCE_PRIVATE_KEY_ENV, RUNTIME_EVIDENCE_PUBLIC_KEY_ENV, runtimeEvidenceSignerFromWorkspace, setRuntimeEvidenceKeyStatusForTest, signFindingLedgerReceipt, verifyFindingLedgerQueryRow, verifyFindingLedgerReceipt, verifyRuntimeReceiptCarrier } from '../../handlers/finding-ledger.js';
import { MemoryRuntimeEvidenceBlobStore, RuntimeEvidenceRefusal, executeRuntimeEvidence, redactEnvironment, signRuntimeEvidenceReceipt, verifyRuntimeEvidenceCurrent, verifyRuntimeEvidenceReceiptBlobs, verifyRuntimeEvidenceReceiptSignature, type RuntimeEvidenceReceipt, type RuntimeReceiptSigner, type RuntimeReceiptTrust } from '../../core/runtime-evidence-receipt.js';
import {
  RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
  createRuntimeEvidenceBlobStore,
  writeRuntimeEvidenceBlob,
} from '../../core/evidence/artifact-store.js';
import {
  acquireMkdirLock,
  captureMkdirLockFence,
} from '../../core/mkdir-lock.js';

import { StoryStore } from '../../core/store.js';

import { createFindingHandlers } from '../../handlers/finding.js';

import { FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT } from '../../core/finding-runtime-evidence.js';
import type { HandlerContext } from '../../handlers/context.js';

import { currentGitHead, currentMaterialHash } from '../../core/evidence-freshness.js';
import {
  PROCESS_FACT_STORY3_PERSISTENCE_ONLY_RECORD_POLICIES,
  PROCESS_FACT_STORY3_FINDING_LIFECYCLE_POLICY,
  PROCESS_FACT_STORY3_FINDING_PROJECTION_POLICY,
  PROCESS_FACT_STORY3_RUNTIME_RECEIPT_POLICY,
  getProcessFactRegistryEntry,
} from '../../core/process-fact-registry.js';
import { isCommandAllowed } from '../../core/config.js';

import { git, runtimeStory, request, runRuntimeCli, RUNTIME_CLI_TEST_SESSION_ENV, require } from './support.js';
import { unsignedRuntimeReceipt, readTreeText } from './distribution.js';
import { hasProtectedPathSurface, story3VerifierMutationAccepted, runStory3DependencyFixture } from './authority.js';
import { runFindingProjectionRegression } from './projection.js';

export async function runRuntimeEvidenceMatrix(scratch: string): Promise<void> {
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
    // Legacy storage is not authority until this explicit signed snapshot binding.
    bindLegacyFindingLedgerReceipts({ storyId: legacyStoryId, store, writerSessionId: 'legacy-migration-smoke', writerLeaseId: 'legacy-migration-smoke',
      writerFenceToken: fence.writerFenceToken, fence, signer: findingLedgerSignerFromWorkspace(root) });
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
    assert.deepEqual({
      recordType: PROCESS_FACT_STORY3_FINDING_PROJECTION_POLICY.recordType,
      level: PROCESS_FACT_STORY3_FINDING_PROJECTION_POLICY.level,
      gateEvidence: PROCESS_FACT_STORY3_FINDING_PROJECTION_POLICY.gateEvidence,
      lifecycleAuthority: PROCESS_FACT_STORY3_FINDING_PROJECTION_POLICY.lifecycleAuthority,
    }, {
      recordType: 'finding_projection',
      level: 'L4',
      gateEvidence: true,
      lifecycleAuthority: 'current-finding-projection',
    });
    console.log('registry.story3_fact_contract: PASS');

    const phases = ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'];
    assert.equal(phases.every((phase) => isCommandAllowed('finding_ledger_query', phase)), true);
    assert.equal(isCommandAllowed('finding_runtime_evidence_run', 'DEV'), true);
    assert.equal(isCommandAllowed('finding_runtime_evidence_verify', 'DEV'), true);
    assert.equal(phases.filter((phase) => !['DEV', 'REVIEW', 'TEST'].includes(phase)).some((phase) => isCommandAllowed('finding_runtime_evidence_run', phase) || isCommandAllowed('finding_runtime_evidence_verify', phase)), false);
    for (const phase of ['REVIEW', 'TEST'] as const) {
      assert.equal(isCommandAllowed('finding_runtime_evidence_run', phase), true);
      assert.equal(isCommandAllowed('finding_runtime_evidence_verify', phase), true);
    }
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

    assertStory3VerifierPositiveControl(repositoryRoot);
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
    // B-bcae F-033 separation control for the SAME predicate. bin/bootstrap-runner.js coordinates its
    // initial dist import through withDistImportLock, a different target from the canonical build mutex
    // above. An ordinary concurrent CLI startup is not a build, so it must NOT make this command refuse
    // with build_in_progress. Contrast with runtime.canonical_build_lock, where a real withBuildLock
    // holder is still rejected: same command, same predicate, opposite verdicts.
    const distImportReaderFixture = `
      import { spawnSync } from 'node:child_process';
      import { pathToFileURL } from 'node:url';
      const { withDistImportLock } = await import(pathToFileURL(process.argv[1]).href);
      const cli = process.argv[2];
      const root = process.argv[3];
      const args = JSON.parse(Buffer.from(process.argv[4], 'base64').toString('utf8'));
      let result;
      await withDistImportLock(root, async () => {
        result = spawnSync(process.execPath, [cli, 'finding_runtime_evidence_run', JSON.stringify(args)], {
          cwd: root, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
      });
      process.stdout.write(JSON.stringify({ status: result.status, output: (result.stdout || '') + '\\n' + (result.stderr || '') }));
    `;
    const distImportReader = spawnSync(process.execPath, [
      '--input-type=module', '-e', distImportReaderFixture,
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
    assert.equal(distImportReader.status, 0, `${distImportReader.stderr}\n${distImportReader.stdout}`);
    const readerResult = JSON.parse(distImportReader.stdout) as { status: number; output: string };
    assert.equal(readerResult.status, 0, readerResult.output);
    assert.equal(/build[\s_-]*(?:is[\s_-]*)?in[\s_-]*progress/i.test(readerResult.output), false, readerResult.output);
    assert.match(readerResult.output, /"replayed"\s*:\s*true/);
    assert.equal(store.readFindingLedger<JsonValue>(storyId).records.length, rowsBeforeRefusal);
    console.log('runtime.dist_import_reader_is_not_a_build: PASS liveReader=admit refusals=0 zeroWrites=true');
    // buildLockTarget / distImportLockTarget are the PRODUCTION derivations, imported statically at
    // the top of this file (B-bcae F-014/F-023, F-046/F-056). Transcribing `proof-or-stop-build-lock-`
    // / `proof-or-stop-dist-import-lock-` and the sha256 here would let a change to the production
    // prefix or hashing turn both assertions below into claims about paths nothing ever created —
    // green for every case while checking nothing.
    const canonicalBuildTarget = buildLockTarget(String(root));
    const readerAdmissionTarget = distImportLockTarget(String(root));
    // The whole point of the pair is that they are two targets. A collapsed derivation would make the
    // reader probe below contend with the mutex its own parent holds, which is exactly B-bcae F-033.
    assert.notEqual(
      canonicalBuildTarget,
      readerAdmissionTarget,
      'reader admission must derive a target distinct from the canonical build mutex',
    );
    const interleavingHandlers = createFindingLedgerHandlers({ store, root, scanRoot: root });
    let successorBuildAcquired = false;
    let nestedReaderAdmitted = false;
    const interleavingResult = interleavingHandlers.finding_runtime_evidence_run({
      ...runArgs,
      idempotencyKey: 'runtime-build-lock-successor-interleaving',
      afterCanonicalBuildLockForTest: () => {
        // Three OUTCOMES, not two: a blanket `catch { exit 75 }` cannot tell "somebody holds this" from
        // "that path does not exist" or any other error, so the negative leg would stay green through a
        // drifted derivation. ELOCKED is the only failure that means HELD; anything else exits 70 and
        // prints why. `realpath:false` matches how production takes reader admission (B-bcae F-060) and
        // is what lets the probe observe a target no one materialises as a file.
        const acquireProbe = String.raw`
          const lockfile = require(process.argv[1]);
          try {
            const release = lockfile.lockSync(process.argv[2], {
              stale: 30000, update: 10000, retries: 0, realpath: false,
            });
            release();
            process.exit(0);
          } catch (error) {
            if (error && error.code === 'ELOCKED') process.exit(75);
            process.stderr.write(String((error && error.stack) || error));
            process.exit(70);
          }
        `;
        const probeFor = (target: string) => spawnSync(
          process.execPath, ['-e', acquireProbe, require.resolve('proper-lockfile'), target], { encoding: 'utf8' },
        );
        // NEGATIVE leg: the broker really holds this target right now, so acquisition must be REFUSED,
        // and refused specifically with ELOCKED.
        const probe = probeFor(canonicalBuildTarget);
        successorBuildAcquired = probe.status === 0;
        assert.equal(
          probe.status, 75,
          `a successor build must not enter after runtime admission (expected ELOCKED on ${canonicalBuildTarget}): ${probe.stderr}`,
        );
        // POSITIVE leg, B-bcae F-033 leg 2. This critical section holds ONLY the canonical build mutex,
        // and the caller-supplied build/execution commands really run inside it. Those commands may route
        // through bin/proof-or-stop.js, whose bootstrap coordinates its dist import on the SEPARATE
        // reader-admission target — so a nested CLI must be admitted immediately here. If reader
        // admission shared this mutex, this probe would take the ELOCKED branch above instead. Nothing
        // creates this target: the probe locks the production-derived path as production would find it,
        // rather than a file the test made for itself.
        const nested = probeFor(readerAdmissionTarget);
        nestedReaderAdmitted = nested.status === 0;
        assert.equal(
          nested.status, 0,
          `a nested reader must be admitted inside a canonical build critical section (on ${readerAdmissionTarget}): ${nested.stderr}`,
        );
      },
    });
    assert.equal(interleavingResult.persisted, true);
    assert.equal(successorBuildAcquired, false);
    assert.equal(nestedReaderAdmitted, true);
    console.log(
      'runtime.canonical_build_lock_interleaving: PASS successorStartedAfterAdmission=true '
      + 'successorAcquired=false successorRefusal=ELOCKED nestedReaderAdmitted=true '
      + 'targetsDerivedFrom=scripts/build-lock-target.mjs targetsDistinct=true receiptCommitted=true',
    );
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
