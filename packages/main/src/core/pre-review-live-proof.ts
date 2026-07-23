import type {
  ChecklistData,
  MilestoneLedgerData,
  PreReviewExecutableProofV1,
  ProofStoryContractData,
} from './types.js';
import { digestCanonicalJson } from './digest.js';
import { buildAcceptanceMatrixReport } from './acceptance-topology.js';
import { StoryStore } from './store.js';

function digest(value: unknown): string {
  return `sha256:${digestCanonicalJson(value)}`;
}

export function preReviewCaseAggregateDigest(storyId: string, caseRecords: readonly unknown[]): string {
  return digest({
    schemaVersion: 'proofstory.pre_review_case_aggregate.v1',
    storyId,
    caseRecords,
  });
}

function bindingDiagnosticCodes(
  storyId: string,
  checklist: ChecklistData,
  contract: ProofStoryContractData,
  ledger: MilestoneLedgerData | null,
  bindingId: string,
): string[] {
  return buildAcceptanceMatrixReport({ storyId, checklist, contract, ledger }).rows
    .find(row => row.acceptanceBindingRef === `acceptance-binding:${bindingId}`)?.diagnosticCodes ?? ['AT_UNKNOWN_REF'];
}

export function buildPreReviewLiveProof(input: {
  storyId: string;
  checklist: ChecklistData;
  contract: ProofStoryContractData;
  ledger: MilestoneLedgerData | null;
}): PreReviewExecutableProofV1 {
  if (input.contract.storyId !== input.storyId) throw new Error('pre-review live proof story/contract mismatch');
  const bindingProofs: PreReviewExecutableProofV1['bindingProofs'] = [];
  const caseRecords: unknown[] = [];
  for (const binding of input.contract.acceptanceBindings.filter(candidate => candidate.verificationTopology)) {
    const topology = binding.verificationTopology!;
    const baselineCodes = bindingDiagnosticCodes(input.storyId, input.checklist, input.contract, input.ledger, binding.id);
    if (baselineCodes.length > 0) throw new Error(`pre-review live proof baseline is structurally invalid for ${binding.id}: ${baselineCodes.join(',')}`);
    const positiveAssertionIds = topology.positiveAssertionRefs.map(assertion => {
      caseRecords.push({ kind: 'positive', bindingId: binding.id, assertion, observedCodes: baselineCodes });
      return assertion.id;
    });
    const mutationProofs = topology.mutationCaseRefs.map(assertion => {
      const mutated = structuredClone(input.contract);
      const mutatedBinding = mutated.acceptanceBindings.find(candidate => candidate.id === binding.id)!;
      const mutatedAssertion = mutatedBinding.verificationTopology!.mutationCaseRefs.find(candidate => candidate.id === assertion.id)!;
      mutatedAssertion.sourceRef = { refKind: 'existing', canonicalSourceRef: `unknown:mutation:${binding.id}:${assertion.id}` };
      const observedCodes = bindingDiagnosticCodes(input.storyId, input.checklist, mutated, input.ledger, binding.id);
      const observedCode = observedCodes.includes('AT_UNKNOWN_REF') ? 'AT_UNKNOWN_REF' : observedCodes[0] ?? 'NO_DIAGNOSTIC';
      const restoredCodes = bindingDiagnosticCodes(input.storyId, input.checklist, input.contract, input.ledger, binding.id);
      const controlRestored = restoredCodes.length === 0;
      caseRecords.push({ kind: 'mutation', bindingId: binding.id, assertion, mutatedSourceRef: mutatedAssertion.sourceRef, observedCodes, restoredCodes, controlRestored });
      return { mutationId: assertion.id, expectedCode: 'AT_UNKNOWN_REF', observedCode, controlRestored };
    });
    const producerOrder = new Map(topology.producerRefs.map((producer, index) => [producer.id, index * 2]));
    const consumerOrder = new Map(topology.consumerRefs.map((consumer, index) => [consumer.id, topology.producerRefs.length * 2 + index * 2 + 1]));
    const transcriptProofs = topology.transcriptAssertionRefs.map(assertion => {
      const producerSequence = Math.min(...assertion.producerRefs.map(ref => producerOrder.get(ref) ?? Number.MAX_SAFE_INTEGER));
      const consumerSequence = Math.min(...assertion.consumerRefs.map(ref => consumerOrder.get(ref) ?? Number.MIN_SAFE_INTEGER));
      const proof = { transcriptId: assertion.id, producerRefs: [...assertion.producerRefs], consumerRefs: [...assertion.consumerRefs], producerSequence, consumerSequence };
      caseRecords.push({ kind: 'transcript', bindingId: binding.id, assertion, proof });
      return proof;
    });
    bindingProofs.push({ bindingId: binding.id, positiveAssertionIds, mutationProofs, transcriptProofs });
  }
  if (bindingProofs.length === 0 || caseRecords.length === 0) throw new Error('pre-review live proof has no executable cases');
  return {
    schemaVersion: 'proofstory.pre_review_executable_proof.v1',
    storyId: input.storyId,
    producer: 'registered-verification-command',
    verifier: 'pre-review-check-command-runner',
    commandDigests: [preReviewCaseAggregateDigest(input.storyId, caseRecords)],
    bindingProofs,
  };
}

export function buildActiveStoryPreReviewLiveProof(root: string, storyId: string): PreReviewExecutableProofV1 {
  const store = new StoryStore(root);
  const contract = store.readProofStoryContract(storyId);
  if (!contract) throw new Error(`pre-review live proof contract missing for ${storyId}`);
  return buildPreReviewLiveProof({
    storyId,
    checklist: store.readChecklist(storyId),
    contract,
    ledger: store.readMilestoneLedger(storyId),
  });
}
