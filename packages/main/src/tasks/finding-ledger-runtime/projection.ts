import type { FindingLedgerReceipt } from '../../core/types.js';
import assert from 'node:assert/strict';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { join, resolve } from 'node:path';

import { type JsonValue } from '../../core/finding-ledger.js';

import { generateEd25519KeyPair } from '../../core/authority-signing.js';
import { appendFindingLedger, bindLegacyFindingLedgerReceipts, canonicalHash, canonicalJson, findingLedgerSignerFromWorkspace, findingLedgerTrustFromWorkspace, queryFindingLedger, signFindingLedgerReceipt, verifyFindingLedgerQueryRow, verifyFindingLedgerReceipt, type LedgerSigner } from '../../handlers/finding-ledger.js';

import {
  acquireMkdirLock,
  captureMkdirLockFence,
} from '../../core/mkdir-lock.js';

import { StoryStore } from '../../core/store.js';
import { createMainRegistry } from '../../registry.js';
import { createFindingHandlers } from '../../handlers/finding.js';

import { createFindingRuntimeEvidenceHandlers, FINDING_RUNTIME_EVIDENCE_COMMANDS } from '../../handlers/finding-runtime-evidence.js';
import { FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT } from '../../core/finding-runtime-evidence.js';
import type { HandlerContext } from '../../handlers/context.js';
import type { Finding } from '../../core/types.js';

import { REVIEW_RETENTION_PROTOCOL_METADATA_PATHS } from '../../core/lifecycle-registry.js';

import { runtimeStory, git } from './support.js';

export let sparseProjectionRegressionCompleted = false;

export function runFindingProjectionRegression(root: string): void {
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
  process.env.PROOF_OR_STOP_AGENT = 'main'; // Lifecycle storage fixture uses the current owning actor.
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
  assert.throws(() => store.readFindings(legacyCrashStoryId), /FINDING_LEDGER_AUTHORITY_INVALID/,
    'an unsigned mirror relabel must not acquire signed lifecycle authority');
  assert.equal(JSON.parse(readFileSync(legacyMirrorPath, 'utf8')).findings[0].status, 'open');
  originalWriteFindings(legacyCrashStoryId, { findings: [legacyOpenFinding] });
  console.log('finding.lifecycle_legacy_kill_window: PASS durableTransition=1 mirrorWrite=omitted projected=resolved unsignedMirror=open untrustedProjection=refused');
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
  process.env.PROOF_OR_STOP_AGENT = 'main'; // Lifecycle storage fixture uses the current owning actor.
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
  process.env.PROOF_OR_STOP_AGENT = 'main'; // Lifecycle storage fixture uses the current owning actor.
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

export function runRealBfe8fLifecycleMigrationRegression(repositoryRoot: string, scratch: string): void {
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
  const currentTrust = findingLedgerTrustFromWorkspace(corpusRoot);
  const signedCarriers = before.receipts.filter((carrier) => Boolean(
    (carrier as typeof carrier & { findingLedgerReceipt?: FindingLedgerReceipt }).findingLedgerReceipt,
  ));
  const entirelyForeign = signedCarriers.length > 0 && signedCarriers.every((carrier) => {
    const receipt = (carrier as typeof carrier & { findingLedgerReceipt: FindingLedgerReceipt }).findingLedgerReceipt;
    return typeof receipt.keyId === 'string' && receipt.keyId !== currentTrust.keyId;
  });
  if (entirelyForeign) {
    // Git carries historical payloads, not another host's signing authority.
    // Exercise the actual foreign corpus without re-signing it for this host.
    const originalCarriers = canonicalJson(before.receipts);
    assert.throws(() => corpusStore.readFindings(storyId), /FINDING_LEDGER_AUTHORITY_INVALID/,
      'foreign historical Finding signatures must not become local authority');
    try { migrate(); } catch (error) {
      if ((error as { code?: string }).code === 'IMMUTABLE_BINDING_CONFLICT') {
        assert.match((error as Error).message, /^immutable binding legacy-receipt-binding:[0-9a-f]{64} is already bound to different bytes$/);
      } else {
        assert.match((error as Error).message, /IDEMPOTENCY_CONFLICT/,
          'foreign migration may refuse an existing differently signed exact transaction');
      }
    }
    assert.throws(() => corpusStore.readFindings(storyId), /FINDING_LEDGER_AUTHORITY_INVALID/,
      'legacy migration must not authorize foreign historical Findings');
    const afterForeign = corpusStore.readFindingLedger<JsonValue>(storyId);
    assert.equal(canonicalJson(afterForeign.receipts.filter(receipt =>
      before.receipts.some(original => original.receiptId === receipt.receiptId))), originalCarriers,
      'foreign corpus migration must preserve original carrier bytes');
    console.log('finding.lifecycle_real_bfe8f_foreign_trust: PASS historical=16 foreignAuthority=refused immutableCarriers=true positiveMigration=requires-original-trusted-signer');
    return;
  }
  assert.equal(
    historicalFindingIds.every((findingId) => (
      corpusStore.readFindings(storyId).findings.find((finding) => finding.id === findingId)?.status === 'open'
    )),
    true,
    'pre-upgrade B-fe8f corpus did not reproduce the terminal projection loss',
  );
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
