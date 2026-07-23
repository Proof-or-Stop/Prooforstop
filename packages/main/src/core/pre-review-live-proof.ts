import type { PreReviewCaseRecordV1, PreReviewExecutableProofV1, PreReviewExecutableProvenanceV1, ProofStoryContractData, TopologySourceRefV1 } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const RUNNER_PATH = 'scripts/run-proofstory-pre-review-live-proof.mjs';
const TARGET_PATH = 'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js';
const BUILD_COMMAND = 'npm --prefix packages/main run build';

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
  return JSON.parse(gunzipSync(Buffer.from(value, 'base64')).toString('utf8')) as PreReviewCaseRecordV1[];
}

export function buildPreReviewProofFromExecutedCases(input: {
  root: string;
  storyId: string;
  contract: ProofStoryContractData;
  caseRecords: PreReviewCaseRecordV1[];
}): PreReviewExecutableProofV1 {
  if (input.contract.storyId !== input.storyId) throw new Error('executed pre-review proof story/contract mismatch');
  const caseRecords = assemblePreReviewCaseRecords(input.contract, input.caseRecords);
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
    bindingProofs: [],
  };
}
