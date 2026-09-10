import type { HostRunResult } from './host-run.js';

export const ACCEPTANCE_REVIEW_FINAL_SCHEMA = 'proof-or-stop.acceptance_amendment_review_final.v1';
export const ACCEPTANCE_REVIEW_PROFILE = 'acceptance_amendment_reviewer';
export const ACCEPTANCE_REVIEW_LANE = 'proof-or-stop-acceptance-intent-reviewer';
export interface AcceptanceReviewBinding {
  amendmentId: string;
  amendmentDigest: string;
  baseDigest: string;
  submitterSessionId: string;
}
export interface AcceptanceReviewFinal extends AcceptanceReviewBinding {
  schemaVersion: typeof ACCEPTANCE_REVIEW_FINAL_SCHEMA;
  runId: string;
  storyId: string;
  decision: 'approve' | 'reject';
  rationale: string;
  readRefs: string[];
}

export function assertAcceptanceReviewBinding(value: AcceptanceReviewBinding | null | undefined): asserts value is AcceptanceReviewBinding {
  if (!value || !value.amendmentId?.trim() || !value.submitterSessionId?.trim()
    || !/^[a-f0-9]{64}$/.test(value.amendmentDigest) || !/^[a-f0-9]{64}$/.test(value.baseDigest)
    || Object.keys(value).some(key => !['amendmentId', 'amendmentDigest', 'baseDigest', 'submitterSessionId'].includes(key))) {
    throw new Error('acceptance amendment review: invalid subject binding');
  }
}

/** Provider prose, duplicate results, partial captures and un-reaped children cannot approve. */
export function parseAcceptanceReviewFinal(result: HostRunResult, expected: AcceptanceReviewBinding & { runId: string; storyId: string }): AcceptanceReviewFinal {
  if (!result.spawned || result.blocked || result.exitCode !== 0 || result.timedOut
    || result.closeObserved !== true || !result.processIdentity || !result.replacementSafe
    || !result.processCleanup?.reaped || result.processCleanup.residualProcessGroup || result.residualProcessGroup
    || result.finalAssistantResultCount !== 1 || result.finalAssistantResultTruncated || !result.finalAssistantResult) {
    throw new Error('acceptance amendment review: exact final result and normal child cleanup required');
  }
  const proposal = JSON.parse(result.finalAssistantResult) as AcceptanceReviewFinal;
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)
    || proposal.schemaVersion !== ACCEPTANCE_REVIEW_FINAL_SCHEMA
    || Object.keys(expected).some(key => proposal[key as keyof AcceptanceReviewFinal] !== expected[key as keyof typeof expected])
    || Object.keys(proposal).some(key => !['schemaVersion', 'runId', 'storyId', 'amendmentId', 'amendmentDigest', 'baseDigest', 'submitterSessionId', 'decision', 'rationale', 'readRefs'].includes(key))
    || !['approve', 'reject'].includes(proposal.decision) || typeof proposal.rationale !== 'string' || proposal.rationale.trim().length < 20
    || !Array.isArray(proposal.readRefs) || proposal.readRefs.length === 0
    || proposal.readRefs.some(ref => typeof ref !== 'string' || !ref.trim())) {
    throw new Error('acceptance amendment review: final proposal subject or verdict invalid');
  }
  return proposal;
}

/** Public transport schema only. Worker checks all exact values against its sealed spec. */
export function acceptanceReviewJsonSchema(): Record<string, unknown> {
  const properties = {
    schemaVersion: { type: 'string', enum: [ACCEPTANCE_REVIEW_FINAL_SCHEMA] },
    ...Object.fromEntries(['runId', 'storyId', 'amendmentId', 'amendmentDigest', 'baseDigest', 'submitterSessionId', 'rationale'].map(key => [key, { type: 'string' }])),
    decision: { type: 'string', enum: ['approve', 'reject'] },
    readRefs: { type: 'array', items: { type: 'string' } },
  };
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}
