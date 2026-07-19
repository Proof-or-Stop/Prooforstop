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
  evaluateEvidenceEnvironmentGateProjection,
  evaluateEvidenceEnvironmentQuorum,
  listEvidenceEnvironmentDescriptors,
  normalizeEvidenceEnvironmentReceipt,
  projectDoneRequiredReceiptToEnvironment,
  projectQuantumReceiptToEnvironment,
  type EvidenceEnvironmentCommandSpec,
  type EvidenceEnvironmentInvocationRequest,
  type EvidenceEnvironmentProducerAttestation,
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

function receipt(attestation?: EvidenceEnvironmentProducerAttestation): EvidenceEnvironmentReceipt {
  return {
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
    ...(attestation ? { producerAttestation: attestation } : {}),
    isolation: { kind: 'process', identityVerified: true, network: 'policy-bound' },
  };
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
  const firstAttestation: EvidenceEnvironmentProducerAttestation = {
    producerId: 'codex-host',
    lineageId: 'lineage-codex',
    keyId: 'key-codex',
    sessionId: 'session-codex',
    verificationSource: 'verifier-owned-attestation-registry',
    signatureVerified: true,
    trustClass: 'local-runtime-owned',
  };
  const secondAttestation: EvidenceEnvironmentProducerAttestation = {
    producerId: 'claude-host',
    lineageId: 'lineage-claude',
    keyId: 'key-claude',
    sessionId: 'session-claude',
    verificationSource: 'verifier-owned-attestation-registry',
    signatureVerified: true,
    trustClass: 'local-runtime-owned',
  };
  const first = normalizeEvidenceEnvironmentReceipt(
    CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
    invocation,
    receipt(firstAttestation),
    new Date('2026-07-19T00:30:00.000Z'),
  );
  const second = normalizeEvidenceEnvironmentReceipt(
    CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
    invocation,
    receipt(secondAttestation),
    new Date('2026-07-19T00:30:00.000Z'),
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) throw new Error('host substitution fixtures should normalize');
  assert.equal(first.envelope.policyInputDigest, second.envelope.policyInputDigest, 'provider brand does not change policy input');

  const forged = normalizeEvidenceEnvironmentReceipt(
    CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
    invocation,
    receipt({ ...firstAttestation, signatureVerified: false }),
    new Date('2026-07-19T00:30:00.000Z'),
  );
  assert.equal(forged.ok, false, 'caller-declared producer identity cannot self-attest');
  if (forged.ok) throw new Error('forged producer unexpectedly normalized');
  assert.ok(forged.reasons.includes('producer_attestation_invalid'));

  const checks = {
    schemaVersion: 'lattice.done_required_evidence.v1',
    strictShapeValid: true,
    temporalAndMaterialBindingValid: true,
    subjectMatches: true,
    producerBoundaryTrusted: true,
    commandSpecDigestValid: true,
    hashTupleFresh: true,
  };
  const firstGate = evaluateEvidenceEnvironmentGateProjection({
    envelope: first.envelope,
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks,
  });
  const secondGate = evaluateEvidenceEnvironmentGateProjection({
    envelope: second.envelope,
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks,
  });
  assert.equal(firstGate.decision, 'advance', firstGate.reasons.join(', '));
  assert.equal(secondGate.decision, firstGate.decision);

  const weakened = evaluateEvidenceEnvironmentGateProjection({
    envelope: first.envelope,
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks,
    additionalPolicyRequirements: [false],
  });
  assert.equal(weakened.decision, 'stop', 'adapter cannot bypass baseline lifecycle requirements');

  assert.equal(evaluateEvidenceEnvironmentQuorum([first.envelope, second.envelope]).independent, true);
  const sameLineage = normalizeEvidenceEnvironmentReceipt(
    CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
    invocation,
    receipt({
      ...secondAttestation,
      lineageId: firstAttestation.lineageId,
      keyId: firstAttestation.keyId,
      sessionId: firstAttestation.sessionId,
    }),
    new Date('2026-07-19T00:30:00.000Z'),
  );
  assert.equal(sameLineage.ok, true);
  if (!sameLineage.ok) throw new Error('same-lineage fixture should normalize before quorum evaluation');
  const quorum = evaluateEvidenceEnvironmentQuorum([first.envelope, sameLineage.envelope]);
  assert.equal(quorum.independent, false);
  assert.ok(quorum.reasons.includes('same_producer_not_independent'));
  console.log('host substitution and distinct-producer quorum: PASS');
}

{
  const doneReceipt: DoneRequiredCommandReceipt = {
    label: 'build',
    command: 'npm',
    args: ['--prefix', 'packages/main', 'run', 'build'],
    commandSpec: {
      schema: 'lattice.command-spec.v1',
      digest: 'legacy-command-spec-digest',
      command: 'npm',
      args: ['--prefix', 'packages/main', 'run', 'build'],
      cwd: '/repo',
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
  };
  const projected = projectDoneRequiredReceiptToEnvironment(doneReceipt, {
    invocationId: 'done-invocation',
    subjectId: 'B-smoke',
    subjectDigest: 'subject:sha256:done',
    policyId: 'done-required',
    policyDigest: 'policy:sha256:done',
    requestedAt: '2026-07-19T00:00:00.000Z',
    freshnessDeadline: '2026-07-19T01:00:00.000Z',
    routineIdentity: {
      schema: 'lattice.routine-validation-identity',
      version: 1,
      digest: 'identity:sha256:done',
      source: { kind: 'configured', inputDigest: 'source:sha256:done', entrypointDigest: null },
      commands: [{
        label: 'build',
        command: 'npm',
        args: ['--prefix', 'packages/main', 'run', 'build'],
        cwd: '/repo',
        shell: false,
        timeoutMs: 60_000,
        optional: false,
        focus: [],
        effectiveEnvironmentDigest: 'env:sha256:done',
        executableDigest: 'exe:sha256:done',
      }],
      invocation: { full: null, focus: null, profile: 'done' },
      verificationPolicyDigest: 'policy:sha256:done',
      runtime: { platform: 'linux', arch: 'x64', node: 'v24' },
    },
  });
  assert.equal(projected.descriptor.mode, 'execute-local');
  assert.equal(projected.invocation.commandSpec?.policyAuthorized, true);
  assert.equal(
    normalizeEvidenceEnvironmentReceipt(
      projected.descriptor,
      projected.invocation,
      projected.receipt,
      new Date('2026-07-19T00:30:00.000Z'),
    ).ok,
    true,
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
    envelope: result.envelope,
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks: {},
  });
  assert.equal(gate.decision, 'stop', 'diagnostic-only Quantum receipt cannot gain lifecycle Gate force');
  console.log('quantum read-receipt-only projection: PASS');
}

console.log('evidence environment adapter smoke passed');
