import type { PreReviewCaseRecordV1, PreReviewExecutableProofV1, ProofStoryContractData } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const RUNNER_PATH = 'scripts/run-proofstory-pre-review-live-proof.mjs';
const TARGET_PATH = 'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js';
const BUILD_COMMAND = 'npm --prefix packages/main run build';

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
  return {
    schemaVersion: 'proofstory.pre_review_executable_proof.v1',
    storyId: input.storyId,
    producer: 'registered-verification-command',
    verifier: 'pre-review-check-command-runner',
    commandDigests: [preReviewCaseAggregateDigest(input.storyId, input.caseRecords)],
    caseRecordsEncoding: 'gzip-base64',
    caseRecords: encodePreReviewCaseRecords(input.caseRecords),
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
