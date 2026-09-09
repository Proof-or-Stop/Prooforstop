#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
  EVIDENCE_ENVIRONMENT_CONTRACT_VERSION,
  EVIDENCE_ENVIRONMENT_RECEIPT_VERSION,
  QUANTUM_ENVIRONMENT_DESCRIPTOR,
  createEvidenceEnvironmentRegistry,
  digestEvidenceEnvironmentCommandSpec,
  digestEvidenceEnvironmentInvocation,
  digestEvidenceEnvironmentReceipt,
  evaluateEvidenceEnvironmentGateProjection,
  evaluateEvidenceEnvironmentQuorum,
  listEvidenceEnvironmentDescriptors,
  normalizeEvidenceEnvironmentReceipt,
  projectDoneRequiredReceiptToEnvironment,
  projectQuantumReceiptToEnvironment,
  type EvidenceEnvironmentCommandSpec,
  type EvidenceEnvironmentInvocationRequest,
  type EvidenceEnvironmentReceipt,
} from '../core/evidence/environment-contract.js';
import type { DoneRequiredCommandReceipt } from '../core/validation-types.js';
import {
  QUANTUM_VERIFIER_ADAPTER_OUTPUT_VERSION,
} from '../core/claim-admissibility/quantum.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const commandSpec: EvidenceEnvironmentCommandSpec = {
  commandId: 'configured:build',
  executable: 'npm',
  args: ['--prefix', 'packages/main', 'run', 'build'],
  cwd: '/repo',
  shell: false,
  processEnvironmentDigest: 'env:sha256:abc',
  executableDigest: 'exe:sha256:def',
  timeoutMs: 60_000,
  outputLimitBytes: 65_536,
  network: 'denied',
  secrets: 'none',
  policyAuthorized: true,
};

const unsignedInvocation: Omit<EvidenceEnvironmentInvocationRequest, 'invocationDigest'> = {
  contractVersion: EVIDENCE_ENVIRONMENT_CONTRACT_VERSION,
  invocationId: 'invocation-1',
  claimId: 'done-readiness',
  subject: { type: 'story', id: 'B-smoke', digest: 'subject:sha256:1' },
  environmentDescriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.id,
  adapterId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.adapterId,
  policyId: 'done-required-policy',
  policyDigest: 'policy:sha256:1',
  requestedAt: '2026-07-19T00:00:00.000Z',
  freshnessDeadline: '2026-07-19T01:00:00.000Z',
  inputDigest: 'input:sha256:1',
  commandSpec,
};
const invocation: EvidenceEnvironmentInvocationRequest = {
  ...unsignedInvocation,
  invocationDigest: digestEvidenceEnvironmentInvocation(unsignedInvocation),
};

function receipt(attestationRef?: string): EvidenceEnvironmentReceipt {
  const unsigned: Omit<EvidenceEnvironmentReceipt, 'receiptDigest'> = {
    receiptVersion: EVIDENCE_ENVIRONMENT_RECEIPT_VERSION,
    invocationId: invocation.invocationId,
    invocationDigest: invocation.invocationDigest,
    subjectDigest: invocation.subject.digest,
    environmentDescriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.id,
    adapterId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.adapterId,
    adapterVersion: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.adapterVersion,
    policyDigest: invocation.policyDigest,
    inputDigest: invocation.inputDigest,
    outputDigest: 'output:sha256:1',
    status: 'pass',
    observedAt: '2026-07-19T00:00:01.000Z',
    completedAt: '2026-07-19T00:00:02.000Z',
    commandSpecDigest: digestEvidenceEnvironmentCommandSpec(commandSpec),
    ...(attestationRef ? { producerAttestationRef: attestationRef } : {}),
    isolation: { kind: 'process', identityVerified: true, network: 'policy-bound' },
  };
  return { ...unsigned, receiptDigest: digestEvidenceEnvironmentReceipt(unsigned) };
}

{
  const registry = createEvidenceEnvironmentRegistry();
  assert.equal(registry.validate().ok, true, 'default environment descriptor registry validates');
  assert.equal(listEvidenceEnvironmentDescriptors().length, 2, 'code-runtime and Quantum descriptors are registered');
  assert.equal(CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.completionEligible, false);
  assert.equal(QUANTUM_ENVIRONMENT_DESCRIPTOR.mode, 'read-receipt-only');
  assert.equal(QUANTUM_ENVIRONMENT_DESCRIPTOR.roles.includes('executor'), false);

  const duplicate = createEvidenceEnvironmentRegistry([
    CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
    CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
  ]).validate();
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.reasons.includes('duplicate_environment_descriptor'));
  const malformed = createEvidenceEnvironmentRegistry([
    { ...CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR, roles: 'executor' } as any,
  ]).validate();
  assert.equal(malformed.ok, false, 'malformed descriptor arrays fail closed without throwing');
  assert.ok(malformed.reasons.includes('missing_required_field'));
  console.log('default environment descriptor registry: PASS');
}

const normalized = normalizeEvidenceEnvironmentReceipt(
  CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
  invocation,
  receipt(),
  new Date('2026-07-19T00:30:00.000Z'),
);
assert.equal(normalized.ok, true);
if (!normalized.ok) throw new Error('base receipt unexpectedly blocked');

{
  const reorderedInvocation = {
    ...clone(invocation),
    subject: {
      digest: invocation.subject.digest,
      id: invocation.subject.id,
      type: invocation.subject.type,
    },
  };
  const repeated = normalizeEvidenceEnvironmentReceipt(
    CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
    reorderedInvocation,
    clone(receipt()),
    new Date('2026-07-19T00:30:00.000Z'),
  );
  assert.equal(repeated.ok, true);
  if (!repeated.ok) throw new Error('reordered receipt unexpectedly blocked');
  assert.equal(repeated.envelope.semanticDigest, normalized.envelope.semanticDigest);
  assert.equal(repeated.envelope.policyInputDigest, normalized.envelope.policyInputDigest);
  assert.equal(normalized.envelope.boundary.completionEligible, false);
  console.log('deterministic normalized envelope: PASS');
}

function expectBlock(
  label: string,
  mutatedInvocation: EvidenceEnvironmentInvocationRequest,
  mutatedReceipt: EvidenceEnvironmentReceipt,
  reason: string,
  now = new Date('2026-07-19T00:30:00.000Z'),
): void {
  const result = normalizeEvidenceEnvironmentReceipt(
    CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
    mutatedInvocation,
    mutatedReceipt,
    now,
  );
  assert.equal(result.ok, false, `${label} should fail closed`);
  if (result.ok) throw new Error(`${label} unexpectedly normalized`);
  assert.ok(result.reasons.includes(reason as never), `${label}: expected ${reason}, got ${result.reasons.join(', ')}`);
}

{
  const changedSubject = clone(receipt()) as any;
  changedSubject.subjectDigest = 'forged';
  expectBlock('subject mismatch', invocation, changedSubject, 'subject_mismatch');

  const changedInvocation = clone(receipt()) as any;
  changedInvocation.invocationId = 'replayed';
  expectBlock('invocation replay', invocation, changedInvocation, 'invocation_mismatch');

  const changedAdapter = clone(receipt()) as any;
  changedAdapter.adapterVersion = 'unknown';
  expectBlock('adapter replacement', invocation, changedAdapter, 'adapter_mismatch');

  const changedCommand = clone(receipt()) as any;
  changedCommand.commandSpecDigest = 'forged';
  expectBlock('command substitution', invocation, changedCommand, 'command_spec_mismatch');

  const unsafe = clone(receipt()) as any;
  unsafe.isolation.identityVerified = false;
  assert.equal(unsafe.isolation.identityVerified, false);
  expectBlock('unsafe isolation', invocation, unsafe, 'unsafe_isolation');

  const completionClaim = { ...clone(receipt()), done: true } as unknown as EvidenceEnvironmentReceipt;
  expectBlock('direct completion field', invocation, completionClaim, 'unexpected_field');

  const shellInvocation = clone(invocation) as any;
  shellInvocation.commandSpec = { ...commandSpec, shell: true } as unknown as EvidenceEnvironmentCommandSpec;
  expectBlock('shell substitution', shellInvocation, receipt(), 'command_spec_mismatch');

  const arbitraryInvocation = clone(invocation) as any;
  arbitraryInvocation.commandSpec = { ...commandSpec, policyAuthorized: false };
  expectBlock('arbitrary command', arbitraryInvocation, receipt(), 'command_spec_mismatch');

  expectBlock('stale receipt', invocation, receipt(), 'stale_receipt', new Date('2026-07-19T02:00:00.000Z'));
  console.log('identity, authority, execution, and freshness tamper cases: PASS');
}

{
  const first = normalizeEvidenceEnvironmentReceipt(
    CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
    invocation,
    receipt(),
    new Date('2026-07-19T00:30:00.000Z'),
  );
  const second = normalizeEvidenceEnvironmentReceipt(
    CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
    invocation,
    receipt(),
    new Date('2026-07-19T00:30:00.000Z'),
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) throw new Error('host substitution fixtures should normalize');
  assert.equal(first.envelope.policyInputDigest, second.envelope.policyInputDigest, 'provider brand does not change policy input');

  const forged = normalizeEvidenceEnvironmentReceipt(
    CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
    invocation,
    receipt('attestation:caller-invented'),
    new Date('2026-07-19T00:30:00.000Z'),
  );
  assert.equal(forged.ok, false, 'caller-declared producer identity cannot self-attest');
  if (forged.ok) throw new Error('forged producer unexpectedly normalized');
  assert.ok(forged.reasons.includes('producer_attestation_invalid'));

  const checks = {
    schemaVersion: 'proof-or-stop.done_required_evidence.v1',
    strictShapeValid: true,
    temporalAndMaterialBindingValid: true,
    subjectMatches: true,
    producerBoundaryTrusted: true,
    commandSpecDigestValid: true,
    hashTupleFresh: true,
  };
  const firstGate = evaluateEvidenceEnvironmentGateProjection({
    descriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.id,
    invocation,
    receipt: receipt(),
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks,
    now: new Date('2026-07-19T00:30:00.000Z'),
  });
  const secondGate = evaluateEvidenceEnvironmentGateProjection({
    descriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.id,
    invocation,
    receipt: receipt(),
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks,
    now: new Date('2026-07-19T00:30:00.000Z'),
  });
  assert.equal(firstGate.decision, 'advance', firstGate.reasons.join(', '));
  assert.equal(secondGate.decision, firstGate.decision);

  const weakened = evaluateEvidenceEnvironmentGateProjection({
    descriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.id,
    invocation,
    receipt: receipt(),
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks,
    additionalPolicyRequirements: [false],
    now: new Date('2026-07-19T00:30:00.000Z'),
  });
  assert.equal(weakened.decision, 'stop', 'adapter cannot bypass baseline lifecycle requirements');

  const unknownDescriptorGate = evaluateEvidenceEnvironmentGateProjection({
    descriptorId: 'unregistered.evil',
    invocation,
    receipt: receipt(),
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks,
    now: new Date('2026-07-19T00:30:00.000Z'),
  });
  assert.equal(unknownDescriptorGate.decision, 'stop');
  assert.ok(unknownDescriptorGate.reasons.includes('unknown_environment_descriptor'));

  const forgedInvocation = clone(invocation) as any;
  forgedInvocation.subject.digest = 'forged-subject';
  const forgedInvocationGate = evaluateEvidenceEnvironmentGateProjection({
    descriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.id,
    invocation: forgedInvocation,
    receipt: receipt(),
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks,
    now: new Date('2026-07-19T00:30:00.000Z'),
  });
  assert.equal(forgedInvocationGate.decision, 'stop');
  assert.ok(forgedInvocationGate.reasons.includes('invocation_mismatch'));

  const forgedReceipt = clone(receipt()) as any;
  forgedReceipt.outputDigest = 'forged-output';
  const forgedReceiptGate = evaluateEvidenceEnvironmentGateProjection({
    descriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.id,
    invocation,
    receipt: forgedReceipt,
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks,
    now: new Date('2026-07-19T00:30:00.000Z'),
  });
  assert.equal(forgedReceiptGate.decision, 'stop');
  assert.ok(forgedReceiptGate.reasons.includes('digest_mismatch'));

  const expiredGate = evaluateEvidenceEnvironmentGateProjection({
    descriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.id,
    invocation,
    receipt: receipt(),
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks,
    now: new Date('2026-07-19T02:00:00.000Z'),
  });
  assert.equal(expiredGate.decision, 'stop');
  assert.ok(expiredGate.reasons.includes('stale_receipt'));

  const statusReasons = {
    fail: 'receipt_failed',
    error: 'checker_error',
    timeout: 'receipt_timeout',
    cancelled: 'receipt_cancelled',
    unavailable: 'receipt_unavailable',
  } as const;
  for (const [status, expectedReason] of Object.entries(statusReasons)) {
    const changed = clone(receipt()) as any;
    changed.status = status;
    delete changed.receiptDigest;
    changed.receiptDigest = digestEvidenceEnvironmentReceipt(changed);
    const statusGate = evaluateEvidenceEnvironmentGateProjection({
      descriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.id,
      invocation,
      receipt: changed,
      artifactKind: 'done-required-evidence',
      consumer: 'DONE_REQUIRED',
      claim: 'done-readiness',
      checks,
      now: new Date('2026-07-19T00:30:00.000Z'),
    });
    assert.equal(statusGate.decision, 'stop', `${status} must stop`);
    assert.ok(statusGate.reasons.includes(expectedReason), `${status} -> ${statusGate.reasons.join(', ')}`);
  }

  const quorumItem = (attestationRef: string) => ({
    descriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.id,
    invocation,
    receipt: receipt(attestationRef),
  });
  const injectedResolverQuorum = evaluateEvidenceEnvironmentQuorum({
    items: [quorumItem('attestation:codex'), quorumItem('attestation:claude')],
    now: new Date('2026-07-19T00:30:00.000Z'),
    // An extra callback-shaped property cannot become a trust root.
    attestationResolver: {
      resolve: (ref: string) => ({
        producerId: 'same-producer',
        lineageId: `caller-lineage:${ref}`,
        keyId: `caller-key:${ref}`,
        sessionId: `caller-session:${ref}`,
      }),
    },
  } as any);
  assert.equal(injectedResolverQuorum.independent, false);
  assert.ok(injectedResolverQuorum.reasons.includes('distinct_host_quorum_unsupported'));

  // Until a pinned registry exists, even allegedly distinct producer/lineage/key/
  // session tuples are not accepted. A repeated principal reference is also
  // explicitly classified as same-producer, covering producerId independence.
  const quorum = evaluateEvidenceEnvironmentQuorum({
    items: [quorumItem('attestation:same-producer'), quorumItem('attestation:same-producer')],
    now: new Date('2026-07-19T00:30:00.000Z'),
  });
  assert.equal(quorum.independent, false);
  assert.ok(quorum.reasons.includes('same_producer_not_independent'));
  assert.equal(evaluateEvidenceEnvironmentQuorum({
    items: [],
  }).independent, false);
  assert.ok(evaluateEvidenceEnvironmentQuorum({
    items: [quorumItem('attestation:single')],
    now: new Date('2026-07-19T00:30:00.000Z'),
  }).reasons.includes('quorum_cardinality_missing'));
  const unverifiedQuorum = evaluateEvidenceEnvironmentQuorum({
    items: [quorumItem('attestation:missing-1'), quorumItem('attestation:missing-2')],
    now: new Date('2026-07-19T00:30:00.000Z'),
  });
  assert.equal(unverifiedQuorum.independent, false);
  assert.ok(unverifiedQuorum.reasons.includes('producer_attestation_invalid'));
  console.log('host substitution semantics and fail-closed unsupported distinct-host quorum: PASS');
}

{
  const doneReceipt: DoneRequiredCommandReceipt = {
    label: 'build',
    command: 'npm',
    args: ['--prefix', 'packages/main', 'run', 'build'],
    commandSpec: {
      schema: 'proof-or-stop.command-spec.v2',
      digest: 'portable-command-spec-digest',
      command: 'npm',
      args: ['--prefix', 'packages/main', 'run', 'build'],
      cwd: '.',
      resolvedCwd: '/repo',
      shell: false,
      env: {},
      timeoutMs: 60_000,
    },
    cwd: '/repo',
    status: 'PASS',
    exitCode: 0,
    durationMs: 100,
    outputDigest: 'output:sha256:done',
    outputTail: 'build passed',
    startedAt: '2026-07-19T00:00:01.000Z',
    endedAt: '2026-07-19T00:00:02.000Z',
    effectiveEnvironmentDigest: 'env:sha256:done',
    executableDigest: 'exe:sha256:done',
  };
  const projected = projectDoneRequiredReceiptToEnvironment(doneReceipt, {
    invocationId: 'done-invocation',
    subjectId: 'B-smoke',
    subjectDigest: 'subject:sha256:done',
    policyId: 'done-required',
    policyDigest: 'policy:sha256:done',
    requestedAt: '2026-07-19T00:00:00.000Z',
    freshnessDeadline: '2026-07-19T01:00:00.000Z',
  });
  assert.equal(projected.descriptor.mode, 'execute-local');
  assert.equal(projected.invocation.commandSpec?.policyAuthorized, true);
  assert.equal(projected.invocation.commandSpec?.cwd, '.', 'v2 EEA identity must use the portable logical cwd');
  assert.equal(
    normalizeEvidenceEnvironmentReceipt(
      projected.descriptor,
      projected.invocation,
      projected.receipt,
      new Date('2026-07-19T00:30:00.000Z'),
    ).ok,
    true,
  );
  const otherRootProjected = projectDoneRequiredReceiptToEnvironment({
    ...doneReceipt,
    cwd: '/other-worktree',
    commandSpec: {
      ...doneReceipt.commandSpec!,
      resolvedCwd: '/other-worktree',
    },
  }, {
    invocationId: 'done-invocation',
    subjectId: 'B-smoke',
    subjectDigest: 'subject:sha256:done',
    policyId: 'done-required',
    policyDigest: 'policy:sha256:done',
    requestedAt: '2026-07-19T00:00:00.000Z',
    freshnessDeadline: '2026-07-19T01:00:00.000Z',
  });
  assert.equal(otherRootProjected.invocation.commandSpec?.cwd, '.');
  assert.equal(
    otherRootProjected.receipt.commandSpecDigest,
    projected.receipt.commandSpecDigest,
    'physical cwd provenance must not alter the portable EEA command identity',
  );
  assert.equal(
    otherRootProjected.invocation.invocationDigest,
    projected.invocation.invocationDigest,
    'equivalent v2 executions under different physical roots must share EEA invocation identity',
  );
  const logicalCwdTamper = projectDoneRequiredReceiptToEnvironment({
    ...doneReceipt,
    commandSpec: {
      ...doneReceipt.commandSpec!,
      cwd: 'packages/main',
    },
  }, {
    invocationId: 'done-invocation',
    subjectId: 'B-smoke',
    subjectDigest: 'subject:sha256:done',
    policyId: 'done-required',
    policyDigest: 'policy:sha256:done',
    requestedAt: '2026-07-19T00:00:00.000Z',
    freshnessDeadline: '2026-07-19T01:00:00.000Z',
  });
  assert.notEqual(
    logicalCwdTamper.receipt.commandSpecDigest,
    projected.receipt.commandSpecDigest,
    'logical cwd tampering must alter the EEA command identity',
  );
  assert.notEqual(
    logicalCwdTamper.invocation.invocationDigest,
    projected.invocation.invocationDigest,
    'logical cwd tampering must alter the EEA invocation identity',
  );
  const legacyProjected = projectDoneRequiredReceiptToEnvironment({
    ...doneReceipt,
    commandSpec: {
      schema: 'proof-or-stop.command-spec.v1',
      digest: 'legacy-command-spec-digest',
      command: 'npm',
      args: ['--prefix', 'packages/main', 'run', 'build'],
      cwd: '/repo',
      shell: false,
      env: {},
      timeoutMs: 60_000,
    },
  }, {
    invocationId: 'legacy-done-invocation',
    subjectId: 'B-smoke',
    subjectDigest: 'subject:sha256:done',
    policyId: 'done-required',
    policyDigest: 'policy:sha256:done',
    requestedAt: '2026-07-19T00:00:00.000Z',
    freshnessDeadline: '2026-07-19T01:00:00.000Z',
  });
  assert.equal(legacyProjected.invocation.commandSpec?.policyAuthorized, true);
  assert.equal(
    legacyProjected.invocation.commandSpec?.cwd,
    '/repo',
    'legacy v1 keeps its absolute digested cwd identity',
  );
  const otherLegacyRootProjected = projectDoneRequiredReceiptToEnvironment({
    ...doneReceipt,
    cwd: '/other-worktree',
    commandSpec: {
      schema: 'proof-or-stop.command-spec.v1',
      digest: 'other-legacy-command-spec-digest',
      command: 'npm',
      args: ['--prefix', 'packages/main', 'run', 'build'],
      cwd: '/other-worktree',
      shell: false,
      env: {},
      timeoutMs: 60_000,
    },
  }, {
    invocationId: 'legacy-done-invocation',
    subjectId: 'B-smoke',
    subjectDigest: 'subject:sha256:done',
    policyId: 'done-required',
    policyDigest: 'policy:sha256:done',
    requestedAt: '2026-07-19T00:00:00.000Z',
    freshnessDeadline: '2026-07-19T01:00:00.000Z',
  });
  assert.notEqual(
    otherLegacyRootProjected.invocation.invocationDigest,
    legacyProjected.invocation.invocationDigest,
    'legacy v1 absolute cwd remains intentionally non-portable',
  );
  assert.throws(
    () => projectDoneRequiredReceiptToEnvironment({
      ...doneReceipt,
      commandSpec: {
        ...doneReceipt.commandSpec!,
        schema: 'proof-or-stop.command-spec.v3' as never,
      },
    }, {
      invocationId: 'unsupported-command-spec',
      subjectId: 'B-smoke',
      subjectDigest: 'subject:sha256:done',
      policyId: 'done-required',
      policyDigest: 'policy:sha256:done',
      requestedAt: '2026-07-19T00:00:00.000Z',
      freshnessDeadline: '2026-07-19T01:00:00.000Z',
    }),
    /unsupported DONE-required CommandSpec schema proofOrStop\.command-spec\.v3/,
  );
  assert.throws(
    () => projectDoneRequiredReceiptToEnvironment({
      ...doneReceipt,
      commandSpec: undefined,
    }, {
      invocationId: 'missing-command-spec',
      subjectId: 'B-smoke',
      subjectDigest: 'subject:sha256:done',
      policyId: 'done-required',
      policyDigest: 'policy:sha256:done',
      requestedAt: '2026-07-19T00:00:00.000Z',
      freshnessDeadline: '2026-07-19T01:00:00.000Z',
    }),
    /current proofOrStop\.command-spec\.v2; legacy proofOrStop\.command-spec\.v1 accepted/,
  );
  console.log('code-runtime execute-local receipt projection: PASS');
}

{
  const quantum = projectQuantumReceiptToEnvironment({
    output: {
      adapterId: 'quantum.normalization',
      outputVersion: QUANTUM_VERIFIER_ADAPTER_OUTPUT_VERSION,
      evidenceKind: 'normalization',
      status: 'pass',
      exitCode: 0,
      identity: {
        codeHash: 'code:sha256:1',
        solverConfigHash: 'solver:sha256:1',
        environmentHash: 'environment:sha256:1',
        initialStateHash: 'state:sha256:1',
        tolerancePolicyHash: 'tolerance:sha256:1',
        verifierScriptHash: 'script:sha256:1',
        outputDigest: 'output:sha256:quantum',
      },
      verifierScriptHash: 'script:sha256:1',
      outputDigest: 'output:sha256:quantum',
      observedAt: '2026-07-19T00:00:01.000Z',
    },
    activeIdentity: {
      codeHash: 'code:sha256:1',
      solverConfigHash: 'solver:sha256:1',
      environmentHash: 'environment:sha256:1',
      initialStateHash: 'state:sha256:1',
      tolerancePolicyHash: 'tolerance:sha256:1',
      verifierScriptHash: 'script:sha256:1',
      outputDigest: 'output:sha256:quantum',
    },
    claimId: 'Q6',
    invocationId: 'quantum-invocation',
    subjectId: 'quantum-run-1',
    subjectDigest: 'subject:sha256:quantum',
    policyId: 'quantum-local',
    policyDigest: 'policy:sha256:quantum',
    requestedAt: '2026-07-19T00:00:00.000Z',
    freshnessDeadline: '2026-07-19T01:00:00.000Z',
    completedAt: '2026-07-19T00:00:01.000Z',
  });
  assert.equal(quantum.descriptor.mode, 'read-receipt-only');
  assert.equal(quantum.invocation.commandSpec, undefined);
  const result = normalizeEvidenceEnvironmentReceipt(
    quantum.descriptor,
    quantum.invocation,
    quantum.receipt,
    new Date('2026-07-19T00:30:00.000Z'),
  );
  assert.equal(result.ok, true, result.ok ? '' : result.reasons.join(', '));
  if (!result.ok) throw new Error('normalized Quantum receipt unexpectedly blocked');
  const injectedInvocation = clone(quantum.invocation) as any;
  injectedInvocation.commandSpec = commandSpec;
  delete injectedInvocation.invocationDigest;
  injectedInvocation.invocationDigest = digestEvidenceEnvironmentInvocation(injectedInvocation);
  const injectedReceipt = clone(quantum.receipt) as any;
  injectedReceipt.invocationDigest = injectedInvocation.invocationDigest;
  const injected = normalizeEvidenceEnvironmentReceipt(
    quantum.descriptor,
    injectedInvocation,
    injectedReceipt,
    new Date('2026-07-19T00:30:00.000Z'),
  );
  assert.equal(injected.ok, false, 'receipt-only adapter must reject command injection');
  if (injected.ok) throw new Error('receipt-only command injection unexpectedly normalized');
  assert.ok(injected.reasons.includes('forbidden_execution'));
  const gate = evaluateEvidenceEnvironmentGateProjection({
    descriptorId: quantum.descriptor.id,
    invocation: quantum.invocation,
    receipt: quantum.receipt,
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks: {},
    now: new Date('2026-07-19T00:30:00.000Z'),
  });
  assert.equal(gate.decision, 'stop', 'diagnostic-only Quantum receipt cannot gain lifecycle Gate force');
  console.log('quantum read-receipt-only projection: PASS');
}

console.log('evidence environment adapter smoke passed');
