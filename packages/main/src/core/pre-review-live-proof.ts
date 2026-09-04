import type { PreReviewCaseRecordV1, PreReviewExecutableProofV1, PreReviewExecutableProvenanceV1, ProofStoryContractData, TopologySourceRefV1 } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const RUNNER_PATH = 'scripts/run-proofstory-pre-review-live-proof.mjs';
const TARGET_PATH = 'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js';
const BUILD_COMMAND = 'npm --prefix packages/main run build';

export const REGISTERED_PRE_REVIEW_SCENARIO_SEMANTICS = new Map<string, {
  sourceRef: string;
  target: string;
  mutationKind: string;
}>([
  ['A-POS-1', { sourceRef: 'intent:CHK-001:happy:role-guidance', target: 'role-guidance:codex-claude-mirrors', mutationKind: 'prompt-contract' }],
  ['A-POS-2', { sourceRef: 'intent:CHK-002:happy:real-cohort-receipt', target: 'rollout:verified-cohort-receipt', mutationKind: 'rollout-receipt-verification' }],
  ['A-POS-3', { sourceRef: 'intent:CHK-003:happy:bounded-thresholds', target: 'rollout:bounded-threshold-matrix', mutationKind: 'threshold-contract' }],
  ['A-POS-4', { sourceRef: 'intent:CHK-005:happy:canonical-wave4-status', target: 'docs:canonical-wave4-status', mutationKind: 'docs-contract' }],
  ['A-POS-6', { sourceRef: 'intent:CHK-006:happy:sibling-package-graph', target: 'package-identity:sibling-package-graph', mutationKind: 'package-identity-migration' }],
  ['A-POS-7', { sourceRef: 'intent:CHK-007:happy:removed-bin-alias', target: 'bin-alias:canonical-only', mutationKind: 'npm-bin-migration' }],
  ['A-MUT-2', { sourceRef: 'intent:CHK-002:edge:false-block-controls', target: 'rollout:false-block-controls', mutationKind: 'docs-legacy-single-outcome-controls' }],
  ['A-MUT-6', { sourceRef: 'intent:CHK-001:adversarial:prompt-authority', target: 'role-guidance:authority-boundary', mutationKind: 'prompt-contract-mutations' }],
  ['A-MUT-18', { sourceRef: 'intent:CHK-006:edge:global-lab-entrypoint', target: 'package-identity:global-lab-entrypoint', mutationKind: 'package-identity-entrypoint' }],
  ['A-MUT-19', { sourceRef: 'intent:CHK-006:adversarial:mixed-package-graph', target: 'package-identity:mixed-graph', mutationKind: 'package-identity-mixed-graph' }],
  ['A-MUT-20', { sourceRef: 'intent:CHK-007:edge:canonical-help', target: 'bin-alias:canonical-help', mutationKind: 'canonical-help-boundary' }],
  ['A-MUT-21', { sourceRef: 'intent:CHK-007:adversarial:reintroduced-bin-alias', target: 'bin-alias:removed-alias', mutationKind: 'npm-bin-reintroduction' }],
]);

export interface PreReviewCanonicalCaseBindingV1 {
  canonicalCaseId: string;
  target: string;
  mutationKind: string;
  operation: string;
}

/**
 * B-5a15: a record is judged against the registered canonical semantics only when it IS
 * one of those canonical cases.
 *
 * The binding tables below are keyed by story-agnostic refs (`intent:CHK-001:happy:0`)
 * while their VALUES describe specific canonical scenario bodies — role-guidance mirrors,
 * package-identity migration, bin-alias residue. Every story numbers its checklist the
 * same way, so applied to ANY record the table silently asserts one story's meaning over
 * another story's identically-named assertion. For B-5a15 that hijacked 15 of its 51
 * acceptance assertions (its own `CHK-001:happy:0` is a 58-intent pinned evidence batch,
 * nothing to do with role guidance) and left the other 36 with no binding at all — which
 * preReviewCaseRequiresSemanticBinding then demanded, making them unsatisfiable by
 * construction.
 *
 * Keying on the RECORD ID keeps F-339's guarantee exactly where it bites: the canonical
 * cases (A-POS-n / A-MUT-n / A-TRANSCRIPT-n) that the live-proof runner actually executes
 * still must match their registered triple, so none of them can borrow another's record.
 * A story-specific assertion ID (`A-CHK-001-happy-0`) names no canonical case, so it is
 * judged on its own executed observation plus the unchanged structural contract: unique
 * IDs, no extra IDs, exact kind, and exact sourceRef.
 */
export function isCanonicalPreReviewCaseId(recordId: string): boolean {
  return /^A-(?:POS|MUT|TRANSCRIPT)-\d+$/.test(recordId);
}

/**
 * Active topologies may use story-specific assertion IDs, but the live proof
 * runner only executes the registered canonical cases.  This is the verifier-
 * owned semantic bridge between those two namespaces.  It is intentionally
 * finite: an unregistered active source reference cannot borrow a canonical
 * record merely by matching its kind.
 *
 * Only meaningful for PRE_REVIEW_ACTIVE_TOPOLOGY_BINDING_STORY_ID — see above.
 */
export const REGISTERED_PRE_REVIEW_ACTIVE_TOPOLOGY_BINDINGS = new Map<string, PreReviewCanonicalCaseBindingV1>([
  ['intent:CHK-001:happy:0', { canonicalCaseId: 'A-POS-1', target: 'role-guidance:codex-claude-mirrors', mutationKind: 'prompt-contract', operation: 'execute exact role guidance token and mirror contract over all Codex/Claude role pairs' }],
  ['intent:CHK-002:happy:0', { canonicalCaseId: 'A-POS-2', target: 'rollout:verified-cohort-receipt', mutationKind: 'rollout-receipt-verification', operation: 'load the frozen registered production cohort, issue a signed report, and verify the exact current receipt without respawning the cohort runner' }],
  ['intent:CHK-003:happy:0', { canonicalCaseId: 'A-POS-3', target: 'rollout:bounded-threshold-matrix', mutationKind: 'threshold-contract', operation: 'evaluate every canonical promotion threshold from the verifier-derived report metrics' }],
  ['intent:CHK-004:happy:0', { canonicalCaseId: 'A-POS-4', target: 'docs:canonical-wave4-status', mutationKind: 'docs-contract', operation: 'execute canonical Wave 4 status and exact live-proof inventory contract check' }],
  ['intent:CHK-005:happy:0', { canonicalCaseId: 'A-POS-5', target: 'rollout:focused-enforce-rollback', mutationKind: 'focused-rollout-control', operation: 'execute focused Wave 4 rollout smoke with enforce, rollback, and history-preservation controls' }],
  ['intent:CHK-006:happy:0', { canonicalCaseId: 'A-POS-6', target: 'package-identity:sibling-package-graph', mutationKind: 'package-identity-migration', operation: 'execute the sibling package identity migration test against current package metadata, lockfiles, and dependency graph' }],
  ['intent:CHK-007:happy:0', { canonicalCaseId: 'A-POS-7', target: 'bin-alias:canonical-only', mutationKind: 'npm-bin-migration', operation: 'execute the current residue and npm-bin verifier against the package metadata with only proof-or-stop published' }],
  ['intent:CHK-001:edge:0', { canonicalCaseId: 'A-MUT-9', target: 'mutation:observed-polarity', mutationKind: 'polarity-restore', operation: 'replace observed mutation outcome then rerun clean control' }],
  ['intent:CHK-002:edge:0', { canonicalCaseId: 'A-MUT-5', target: 'planned-actual:consumer-symbol', mutationKind: 'planned-actual', operation: 'remove declared current consumer symbol' }],
  ['intent:CHK-003:edge:0', { canonicalCaseId: 'A-MUT-12', target: 'cutoff:evidence-at-boundary', mutationKind: 'temporal-cutoff', operation: 'move evidence timestamp to the signed cutoff boundary' }],
  ['intent:CHK-004:edge:0', { canonicalCaseId: 'A-MUT-15', target: 'critic:enforce-reattestation', mutationKind: 'critic-reattestation', operation: 'enable enforce mode without a current independent critic receipt' }],
  ['intent:CHK-005:edge:0', { canonicalCaseId: 'A-MUT-13', target: 'config:warn-rollback', mutationKind: 'legacy-config-rollback', operation: 'rollback enforce configuration to warn without stale blocking state' }],
  ['intent:CHK-006:edge:0', { canonicalCaseId: 'A-MUT-18', target: 'package-identity:global-lab-entrypoint', mutationKind: 'package-identity-entrypoint', operation: 'execute the global lab entrypoint version check against the canonical sibling package names and versions' }],
  ['intent:CHK-007:edge:0', { canonicalCaseId: 'A-MUT-20', target: 'bin-alias:canonical-help', mutationKind: 'canonical-help-boundary', operation: 'execute the canonical CLI help path and verify it advertises proof-or-stop without a retired lattice invocation' }],
  ['intent:CHK-001:adversarial:0', { canonicalCaseId: 'A-MUT-6', target: 'role-guidance:authority-boundary', mutationKind: 'prompt-contract-mutations', operation: 'remove required command, degrade full-3x2 to 3x1, and promote prompt prose to authority; every mutant must fail' }],
  ['intent:CHK-002:adversarial:0', { canonicalCaseId: 'A-MUT-1', target: 'role-guidance:mirror-parity', mutationKind: 'codex-claude-mirror', operation: 'mutate one Claude role suffix while retaining the Codex role; exact mirror contract must fail' }],
  ['intent:CHK-003:adversarial:0', { canonicalCaseId: 'A-MUT-16', target: 'contract:process-fact-registry', mutationKind: 'process-fact-contract', operation: 'run the canonical process-fact contract verifier' }],
  ['intent:CHK-004:adversarial:0', { canonicalCaseId: 'A-MUT-4', target: 'authority:direct-store-replay', mutationKind: 'authority-replay', operation: 'direct StoryStore proof without causal receipt' }],
  ['intent:CHK-005:adversarial:0', { canonicalCaseId: 'A-MUT-11', target: 'bypass:direct-store', mutationKind: 'bypass-campaign', operation: 'direct-file and caller-authority bypass attempt' }],
  ['intent:CHK-006:adversarial:0', { canonicalCaseId: 'A-MUT-19', target: 'package-identity:mixed-graph', mutationKind: 'package-identity-mixed-graph', operation: 'mutate one sibling package name to the retired scope and require the package graph verifier to reject the mixed graph' }],
  ['intent:CHK-007:adversarial:0', { canonicalCaseId: 'A-MUT-21', target: 'bin-alias:removed-alias', mutationKind: 'npm-bin-reintroduction', operation: 'mutate package metadata to reintroduce the lattice bin alias and require the canonical-only verifier to reject it' }],
]);

const TRANSCRIPT_BINDING: PreReviewCanonicalCaseBindingV1 = {
  canonicalCaseId: 'A-TRANSCRIPT-1',
  target: 'events:producer-consumer',
  mutationKind: 'event-log-relation',
  operation: 'actual producer invocation precedes canonical lifecycle consumer',
};

export const REGISTERED_PRE_REVIEW_ACTIVE_TRANSCRIPT_BINDINGS = new Map<string, PreReviewCanonicalCaseBindingV1>(
  ['happy', 'edge', 'adversarial'].flatMap(lane =>
    Array.from({ length: 7 }, (_, index) => [`intent:CHK-${String(index + 1).padStart(3, '0')}:${lane}:0`, TRANSCRIPT_BINDING] as const)),
);

export function preReviewCaseSemanticBindingForSourceRef(
  sourceRef: string,
  kind?: PreReviewCaseRecordV1[1],
  recordId?: string,
): PreReviewCanonicalCaseBindingV1 | null {
  // A record whose ID is not a canonical case is a story-specific assertion these
  // canonical semantics do not describe; answering would bind it to another story's
  // meaning. Omitting recordId keeps the historical behaviour for direct lookups.
  if (recordId !== undefined && !isCanonicalPreReviewCaseId(recordId)) return null;
  return kind === 'transcript'
    ? REGISTERED_PRE_REVIEW_ACTIVE_TRANSCRIPT_BINDINGS.get(sourceRef) ?? null
    : REGISTERED_PRE_REVIEW_ACTIVE_TOPOLOGY_BINDINGS.get(sourceRef) ?? null;
}

/**
 * B-5a88 F-339 introduced this to stop an active assertion BORROWING a canonical record
 * by kind/index: if a sourceRef names a canonical case we have registered semantics for,
 * the executed record must match that registered triple exactly.
 *
 * B-5a15: the requirement is scoped to refs that actually HAVE a registered binding.
 * REGISTERED_PRE_REVIEW_ACTIVE_TOPOLOGY_BINDINGS registers only index :0 of each
 * CHK-nnn happy/edge/adversarial lane, but a story may declare several assertions per
 * lane (B-5a15 declares 51, of which 36 are unregistered). Demanding a registered
 * binding for a ref that has none is unsatisfiable by construction — it rejects a
 * record no matter what the verifier observed.
 *
 * This does NOT reopen the borrowing hole F-339 closed. Where a binding exists it is
 * still enforced exactly, and records for unregistered refs must still be produced by
 * real per-assertion execution (see executeActiveScenarioWitnesses, which forges a
 * per-assertion signature and runs the real verifier for each one) and still pass every
 * other contract check: unique IDs, no extra IDs, exact kind, and exact sourceRef.
 */
export function preReviewCaseRequiresSemanticBinding(
  sourceRef: string,
  kind?: PreReviewCaseRecordV1[1],
  recordId?: string,
): boolean {
  if (!/^intent:CHK-\d{3}:(happy|edge|adversarial):\d+$/.test(sourceRef)
    && !sourceRef.startsWith('acceptance-binding:')) return false;
  return preReviewCaseSemanticBindingForSourceRef(sourceRef, kind, recordId) !== null;
}

export function preReviewCaseSemanticMatches(
  record: PreReviewCaseRecordV1,
  expectedSourceRef = record[9],
  requireRegisteredBinding = false,
): boolean {
  const activeBinding = preReviewCaseSemanticBindingForSourceRef(expectedSourceRef, record[1], record[0]);
  if (activeBinding) {
    return record[2] === activeBinding.target
      && record[3] === activeBinding.mutationKind
      && record[4] === activeBinding.operation;
  }
  if (requireRegisteredBinding) {
    // B-45a0: the registered binding table exists to police BORROWING -- cloning
    // an executed canonical record onto a different assertion ID (see
    // adaptCanonicalScenarioRecordsToActiveTopology, which passes strict=true
    // only on that path and strict=false for an exact record). A row that was
    // executed under its own ID against its own sourceRef borrows nothing, so
    // requiring it to name a canonical case would reject real evidence.
    //
    // An active topology larger than the canonical catalog (B-45a0 declares 14
    // checklist items -> 90 assertions; the table registers 21 across 7) runs
    // every assertion for real instead of projecting from a canonical case.
    // Those rows are exact by construction: expectedSourceRef === record[9].
    // The borrow path always retargets, so it still fails closed here.
    if (expectedSourceRef !== record[9]) return false;
  }
  const expected = REGISTERED_PRE_REVIEW_SCENARIO_SEMANTICS.get(record[0]);
  return !expected
    || !record[9].startsWith('intent:CHK-')
    || (record[9] === expected.sourceRef
      && record[2] === expected.target
      && record[3] === expected.mutationKind);
}

function digest(value: unknown): string {
  return `sha256:${digestCanonicalJson(value)}`;
}

export function canonicalPreReviewAssertionSourceRef(sourceRef: TopologySourceRefV1): string {
  return sourceRef.refKind === 'existing'
    ? sourceRef.canonicalSourceRef
    : `planned:${sourceRef.plannedPathDeclarationRef}:${sourceRef.endpointRef}`;
}

export function preReviewExecutableProvenanceIsCurrent(
  root: string,
  provenance: Partial<PreReviewExecutableProvenanceV1> | null | undefined,
): boolean {
  if (!provenance
    || typeof provenance.runnerPath !== 'string'
    || typeof provenance.runnerDigest !== 'string'
    || typeof provenance.targetPath !== 'string'
    || typeof provenance.targetDigest !== 'string'
    || typeof provenance.buildCommand !== 'string') return false;
  const runnerPath = join(root, provenance.runnerPath);
  const targetPath = join(root, provenance.targetPath);
  return provenance.runnerPath === RUNNER_PATH
    && provenance.targetPath === TARGET_PATH
    && provenance.buildCommand === BUILD_COMMAND
    && existsSync(runnerPath)
    && existsSync(targetPath)
    && provenance.runnerDigest === digest(readFileSync(runnerPath))
    && provenance.targetDigest === digest(readFileSync(targetPath));
}

export function assemblePreReviewCaseRecords(
  contract: ProofStoryContractData,
  records: readonly PreReviewCaseRecordV1[],
): PreReviewCaseRecordV1[] {
  const expected = contract.acceptanceBindings.flatMap(binding => {
    const topology = binding.verificationTopology;
    if (!topology) return [];
    return [
      ...topology.positiveAssertionRefs.map(assertion => ({ assertion, kind: 'positive' as const })),
      ...topology.mutationCaseRefs.map(assertion => ({ assertion, kind: 'mutation' as const })),
      ...topology.transcriptAssertionRefs.map(assertion => ({ assertion, kind: 'transcript' as const })),
    ];
  });
  const expectedIds = expected.map(row => row.assertion.id);
  if (new Set(expectedIds).size !== expectedIds.length) throw new Error('pre-review topology contains duplicate assertion IDs');
  const recordIds = records.map(record => record[0]);
  if (new Set(recordIds).size !== recordIds.length) throw new Error('pre-review executed records contain duplicate assertion IDs');
  const expectedIdSet = new Set(expectedIds);
  const extras = recordIds.filter(id => !expectedIdSet.has(id));
  if (extras.length > 0) throw new Error(`pre-review executed records contain extra assertion IDs: ${extras.join(', ')}`);
  const byId = new Map(records.map(record => [record[0], record]));
  return expected.map(({ assertion, kind }) => {
    const record = byId.get(assertion.id);
    if (!record) throw new Error(`pre-review executed record missing assertion ID: ${assertion.id}`);
    if (record[1] !== kind) throw new Error(`pre-review executed record kind mismatch for ${assertion.id}`);
    if (record[9] !== canonicalPreReviewAssertionSourceRef(assertion.sourceRef)) {
      throw new Error(`pre-review executed record sourceRef mismatch for ${assertion.id}`);
    }
    if (!preReviewCaseSemanticMatches(
      record,
      record[9],
      preReviewCaseRequiresSemanticBinding(record[9], record[1], record[0]),
    )) {
      throw new Error(`pre-review executed record semantic contract mismatch for ${assertion.id}`);
    }
    return record;
  });
}

export function preReviewCaseAggregateDigest(storyId: string, caseRecords: readonly unknown[]): string {
  return digest({
    schemaVersion: 'proofstory.pre_review_case_aggregate.v1',
    storyId,
    caseRecords,
  });
}

export function encodePreReviewCaseRecords(caseRecords: readonly PreReviewCaseRecordV1[]): string {
  return gzipSync(Buffer.from(JSON.stringify(caseRecords)), { level: 9, mtime: 0 } as any).toString('base64');
}

export function decodePreReviewCaseRecords(value: string): PreReviewCaseRecordV1[] {
  const records = JSON.parse(gunzipSync(Buffer.from(value, 'base64')).toString('utf8')) as PreReviewCaseRecordV1[];
  const semanticMismatch = records.find(record => !preReviewCaseSemanticMatches(
    record,
    record[9],
    preReviewCaseRequiresSemanticBinding(record[9], record[1], record[0]),
  ));
  if (semanticMismatch) {
    throw new Error(`pre-review decoded record semantic contract mismatch for ${semanticMismatch[0]}`);
  }
  return records;
}

export function buildPreReviewProofFromExecutedCases(input: {
  root: string;
  storyId: string;
  contract: ProofStoryContractData;
  caseRecords: PreReviewCaseRecordV1[];
}): PreReviewExecutableProofV1 {
  if (input.contract.storyId !== input.storyId) throw new Error('executed pre-review proof story/contract mismatch');
  const caseRecords = assemblePreReviewCaseRecords(input.contract, input.caseRecords);
  const recordsById = new Map(caseRecords.map(record => [record[0], record]));
  const eventSequence = (record: PreReviewCaseRecordV1, eventName: string): number => {
    const sequence = record[8].find(event => event[0] === eventName)?.[1];
    if (typeof sequence !== 'number' || !Number.isInteger(sequence)) throw new Error(`pre-review executed record ${record[0]} is missing ${eventName} event`);
    return sequence;
  };
  const bindingProofs = input.contract.acceptanceBindings.flatMap(binding => {
    const topology = binding.verificationTopology;
    if (!topology) return [];
    return [{
      bindingId: binding.id,
      positiveAssertionIds: topology.positiveAssertionRefs.map(assertion => assertion.id),
      mutationProofs: topology.mutationCaseRefs.map(assertion => {
        const record = recordsById.get(assertion.id)!;
        return {
          mutationId: assertion.id,
          expectedCode: record[5],
          observedCode: record[6],
          controlRestored: record[7],
        };
      }),
      transcriptProofs: topology.transcriptAssertionRefs.map(assertion => {
        const record = recordsById.get(assertion.id)!;
        return {
          transcriptId: assertion.id,
          producerRefs: [...assertion.producerRefs],
          consumerRefs: [...assertion.consumerRefs],
          producerSequence: eventSequence(record, 'producer-evaluated'),
          consumerSequence: eventSequence(record, 'consumer-verified'),
        };
      }),
    }];
  });
  return {
    schemaVersion: 'proofstory.pre_review_executable_proof.v1',
    storyId: input.storyId,
    producer: 'registered-verification-command',
    verifier: 'pre-review-check-command-runner',
    commandDigests: [preReviewCaseAggregateDigest(input.storyId, caseRecords)],
    caseRecordsEncoding: 'gzip-base64',
    caseRecords: encodePreReviewCaseRecords(caseRecords),
    provenance: {
      runnerPath: RUNNER_PATH,
      runnerDigest: digest(readFileSync(join(input.root, RUNNER_PATH))),
      targetPath: TARGET_PATH,
      targetDigest: digest(readFileSync(join(input.root, TARGET_PATH))),
      buildCommand: BUILD_COMMAND,
    },
    bindingProofs,
  };
}
