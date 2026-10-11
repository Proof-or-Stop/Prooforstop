#!/usr/bin/env node

/**
 * Pure regression for the managed-review-only prompt renderer. No provider,
 * host_run, process, or filesystem fixture is involved.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildManagedReviewerPrompt,
  resolveManagedReviewerBasePrompt,
  type ManagedReviewCanonicalReportStatus,
} from '../core/managed-review-evidence.js';
import {
  classifyManagedReviewFinalEnvelope,
  managedReviewFinalProposalJsonSchema,
} from '../core/host-run.js';
import { isManagedInventoryCriticEnvelopeValid } from '../core/managed-inventory-critic.js';
import type { ReviewRun } from '../core/types.js';

const PRIMARY_WORKTREE = '/Users/qipan/work/repo/Prooforstop/.worktrees/B-137a';
const BASE_PROMPT = [
  'Review the submitted implementation and report any evidence-backed finding.',
  '',
  `Working directory (subagent must cd here): ${PRIMARY_WORKTREE}`,
  'Inspect files relative to that directory.',
  'Always read the canonical reports before submitting your conclusion.',
].join('\n');

const REVIEW_RUN = {
  reviewRunId: 'B-137a:managed-prompt-cwd',
  storyId: 'B-137a',
  agent: 'lattice-review-quality',
  lane: 'lattice-review-quality',
  reviewRound: '2026-08-24T00:00:00.000Z',
  startedAt: '2026-08-24T00:00:00.000Z',
  headHash: 'abc123',
  materialHash: 'sha256:material',
  storyFilesHash: 'sha256:story-files',
  promptHash: 'unused-for-assembled-prompt',
  assembledPrompt: BASE_PROMPT,
} satisfies ReviewRun;

const CANONICAL_REPORT_STATUSES: ManagedReviewCanonicalReportStatus[] = [
  {
    command: 'acceptance_topology_check', availability: 'available', status: 'pass', blocking: false,
    codes: ['AT_TOPOLOGY_CURRENT'],
  },
  {
    command: 'pre_review_check_read', availability: 'available', status: 'fail', blocking: true,
    codes: ['PRE_REVIEW_PROOF_MISSING'],
  },
  {
    command: 'acceptance_rollout_report_read', availability: 'unavailable', status: 'unavailable', blocking: null,
    // Deliberately path-shaped input: the renderer must not expose it.
    codes: [PRIMARY_WORKTREE, 'controller_evaluation_unavailable'],
  },
  {
    command: 'acceptance_rollout_check', availability: 'available', status: 'missing', blocking: false,
    codes: ['AR_REPORT_MISSING'],
  },
];
const FULL_SCAN_REASON = 'candidate corpus ambiguity requires a complete decisions scan';

function main(): void {
  assert.equal(
    resolveManagedReviewerBasePrompt(PRIMARY_WORKTREE, REVIEW_RUN),
    BASE_PROMPT,
    'the signed ReviewRun source remains the exact audit prompt',
  );

  const providerPrompt = buildManagedReviewerPrompt(PRIMARY_WORKTREE, REVIEW_RUN, CANONICAL_REPORT_STATUSES, {
    scanEscalationReason: FULL_SCAN_REASON,
  });
  assert.match(
    providerPrompt,
    /Execution boundary: remain in the host-configured isolated scratch cwd for this managed provider run\./,
    'managed provider prompt explicitly requires the isolated scratch cwd',
  );
  const schemaMatch = providerPrompt.match(
    /--- BEGIN MANAGED REVIEW FINAL PROPOSAL JSON SCHEMA ---\n([^\n]+)\n--- END MANAGED REVIEW FINAL PROPOSAL JSON SCHEMA ---/,
  );
  assert.ok(schemaMatch, 'managed provider prompt embeds the shared final proposal shape schema');
  const finalProposalSchema = JSON.parse(schemaMatch[1]!) as {
    required: string[];
    properties: Record<string, { required?: string[]; properties?: Record<string, { required?: string[] }> }>;
  };
  assert.deepEqual(finalProposalSchema.properties.readManifest.required, [
    'filesReadFully', 'filesTriagedByName', 'scanEscalationReason', 'candidateSpecSetDigest', 'corpusDigest',
  ], 'prompt schema states every required readManifest field');
  assert.deepEqual(finalProposalSchema.properties.readLog.required, [
    'filesReadFully', 'filesTriagedByName', 'summary', 'digest',
  ], 'prompt schema states every required readLog field');
  assert.deepEqual(finalProposalSchema.properties.readLog.properties?.summary.required, [
    'readCount', 'tokenCount',
  ], 'prompt schema states every required readLog.summary field');
  assert.equal((finalProposalSchema.properties.readManifest.properties?.candidateSpecSetDigest as { pattern?: string }).pattern,
    '^(?:sha256:)?[a-f0-9]{64}$', 'prompt schema matches the terminal routing-digest grammar');
  assert.equal((finalProposalSchema.properties.readLog.properties?.digest as { pattern?: string }).pattern,
    '^[a-f0-9]{64}$', 'prompt schema matches the stricter terminal read-log digest grammar');
  const fullyRead = ['packages/main/src/example.ts'];
  const validProposal = {
    schemaVersion: 'lattice.managed_review_final_proposal.v1',
    storyId: REVIEW_RUN.storyId,
    providerAgent: REVIEW_RUN.lane,
    lane: REVIEW_RUN.lane,
    reviewRunId: REVIEW_RUN.reviewRunId,
    conclusion: 'pass',
    note: 'The bounded review found no blocking issue.',
    readManifest: {
      filesReadFully: fullyRead,
      filesTriagedByName: [],
      scanEscalationReason: null,
      candidateSpecSetDigest: 'a'.repeat(64),
      corpusDigest: 'b'.repeat(64),
    },
    readLog: {
      filesReadFully: fullyRead,
      filesTriagedByName: [],
      summary: { readCount: 1, tokenCount: null },
      digest: 'c'.repeat(64),
    },
  };
  assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify(validProposal)).kind, 'valid',
    'the minimum shape described by the embedded prompt schema passes the terminal validator');
  assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
    ...validProposal,
    readManifest: {
      ...validProposal.readManifest,
      candidateSpecSetDigest: `sha256:${'a'.repeat(64)}`,
      corpusDigest: `sha256:${'b'.repeat(64)}`,
    },
  })).kind, 'valid', 'the provider schema and terminal validator both accept explicit sha256 routing digests');
  assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
    ...validProposal,
    readLog: { ...validProposal.readLog, digest: `sha256:${'c'.repeat(64)}` },
  })).kind, 'malformed', 'readLog digest remains canonical raw hex at the provider and terminal boundaries');
  assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
    ...validProposal,
    readLog: { ...validProposal.readLog, filesReadPartially: [] },
  })).kind, 'malformed', 'terminal validator rejects nested fields excluded by the shared provider schema');
  assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
    ...validProposal,
    readDiagnostics: [{
      code: 'read_manifest_missing_full_read',
      severity: 'finding',
      message: 'The required file was not read.',
      extraAuthority: true,
    }],
  })).kind, 'malformed', 'terminal validator rejects diagnostic fields excluded by the shared provider schema');
  const criticLane = 'proof-or-stop-review-topology-critic';
  const criticSchema = managedReviewFinalProposalJsonSchema({
    storyId: REVIEW_RUN.storyId,
    reviewRunId: REVIEW_RUN.reviewRunId,
    lane: criticLane,
    agentType: criticLane,
  }) as { required: string[] };
  assert.ok(criticSchema.required.includes('inventoryCritic'),
    'topology critic provider schema requires the receipt-producing inventory block');
  assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
    ...validProposal,
    providerAgent: criticLane,
    lane: criticLane,
  })).kind, 'malformed', 'topology critic terminal validation refuses a proposal without inventoryCritic');
  assert.equal(isManagedInventoryCriticEnvelopeValid(undefined, criticLane, criticLane, 0), false,
    'legacy compatibility ingress also refuses a topology critic proposal without inventoryCritic');
  assert.equal(isManagedInventoryCriticEnvelopeValid(undefined, validProposal.lane, validProposal.providerAgent, 0), true,
    'ordinary managed reviewer compatibility proposals remain valid without inventoryCritic');
  const validCriticProposal = {
    ...validProposal,
    providerAgent: criticLane,
    lane: criticLane,
    inventoryCritic: { epochId: 'B-137a:RI-001', wave: 1, findingDispositions: [] },
  };
  for (const proposal of [validProposal, validCriticProposal]) {
    assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify(proposal)).kind, 'valid',
      'ordinary and inventory reviewers can submit truthful nonempty read evidence');
    assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
      ...proposal,
      readManifest: { ...proposal.readManifest, filesReadFully: [], filesTriagedByName: fullyRead },
      readLog: { ...proposal.readLog, filesReadFully: [], filesTriagedByName: fullyRead,
        summary: { readCount: 0, tokenCount: null } },
    })).kind, 'malformed', 'triage-only evidence cannot substitute for an actual full read');
  }
  const finding = { desc: 'Current must-intent execution evidence is stale.', severity: 'high', category: 'missing' };
  for (const [findingFields, expected] of [
    [{ evidenceState: 'verified' }, 'valid'],
    [{ evidenceState: 'verified', uncertaintyReason: 'Unexecuted witness.' }, 'malformed'],
    [{ evidenceState: 'suspected', uncertaintyReason: 'The witness could not be executed.' }, 'valid'],
    [{ evidenceState: 'suspected' }, 'malformed'],
    [{ evidenceState: 'suspected', uncertaintyReason: ' ' }, 'malformed'],
    [{}, 'valid'],
    [{ uncertaintyReason: 'No suspected state.' }, 'malformed'],
  ] as const) {
    assert.equal(classifyManagedReviewFinalEnvelope(JSON.stringify({
      ...validProposal, conclusion: 'findings', findings: [{ ...finding, ...findingFields }],
    })).kind, expected, 'the existing evidence-state/uncertainty contract is unchanged');
  }
  for (const schema of [finalProposalSchema, managedReviewFinalProposalJsonSchema({
    storyId: REVIEW_RUN.storyId, reviewRunId: REVIEW_RUN.reviewRunId, lane: criticLane, agentType: criticLane,
  }) as typeof finalProposalSchema]) {
    for (const field of ['readManifest', 'readLog']) {
      assert.match(JSON.stringify(schema.properties[field]?.properties?.filesReadFully), /at least one.*fully read/i,
        'MANAGED_REVIEW_NONEMPTY_READ_GUIDANCE_MISSING');
    }
    assert.match(JSON.stringify(schema.properties.findings), /uncertaintyReason.*only.*suspected/i,
      'MANAGED_REVIEW_UNCERTAINTY_GUIDANCE_MISSING');
  }
  assert.match(providerPrompt, /at least one[^\n]*in-scope file[^\n]*in full/i,
    'managed protocol requires a real bounded full read before submitting');
  assert.match(providerPrompt, /Do not invent full reads/,
    'managed protocol must not encourage fabrication to satisfy its minimum');
  assert.match(providerPrompt, /uncertaintyReason[^\n]*suspected[^\n]*omit[^\n]*verified/i,
    'managed protocol explains the same finding-field dependency as the terminal parser');
  assert.match(
    providerPrompt,
    /do not cd to, run commands from, or write to that canonical path\./,
    'managed provider prompt explicitly rejects canonical audit-worktree execution',
  );
  assert.doesNotMatch(
    providerPrompt,
    new RegExp(`Working directory \\(subagent must cd here\\): ${PRIMARY_WORKTREE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'managed provider prompt removes the exact primary-worktree cwd directive',
  );
  assert.doesNotMatch(
    providerPrompt,
    new RegExp(PRIMARY_WORKTREE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'managed provider prompt does not expose the actual canonical primary-worktree path',
  );
  for (const status of CANONICAL_REPORT_STATUSES) {
    assert.match(
      providerPrompt,
      new RegExp(`${status.command}: availability=${status.availability}; status=${status.status};`),
      `provider receives the controller-fetched ${status.command} status rather than invoking it from scratch`,
    );
  }
  assert.match(
    providerPrompt,
    /This managed-only execution-boundary instruction overrides any earlier generic reviewer request to read these reports directly\. Consume these entries directly\. Do NOT invoke acceptance_topology_check, pre_review_check_read, acceptance_rollout_report_read, or acceptance_rollout_check from this scratch worktree\./,
    'provider is instructed to consume the controller report projection instead of retrying canonical readers from scratch',
  );
  assert.ok(
    providerPrompt.indexOf('Always read the canonical reports before submitting your conclusion.')
      < providerPrompt.indexOf('This managed-only execution-boundary instruction overrides any earlier generic reviewer request'),
    'the managed-only controller snapshot follows and overrides the signed base prompt’s generic report-reader instruction',
  );
  assert.doesNotMatch(
    providerPrompt,
    new RegExp(`\\bcd\\s+${PRIMARY_WORKTREE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'no primary-worktree cd command leaks into the managed prompt',
  );
  assert.match(providerPrompt, /Inspect files relative to that directory\./,
    'non-cwd signed reviewer instructions remain available to the managed provider');
  assert.match(
    providerPrompt,
    new RegExp(`readManifest\\.scanEscalationReason MUST copy this exact JSON string byte-for-byte: ${JSON.stringify(FULL_SCAN_REASON).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'full-scan managed prompt gives the provider the exact artifact reason it must copy into the final manifest',
  );
  assert.match(providerPrompt, /Do not paraphrase, trim, normalize, or replace this reason/,
    'managed prompt makes full-scan reason copying a receipt-admission requirement');
  assert.equal(
    resolveManagedReviewerBasePrompt(PRIMARY_WORKTREE, REVIEW_RUN),
    BASE_PROMPT,
    'rendering controller status does not mutate the signed ReviewRun prompt',
  );

  // The controller projection is deliberately managed-review-only. Keep the
  // generic story CLI cwd guard intact rather than allowing scratch providers
  // to call canonical report readers directly.
  const cwdGateSource = readFileSync(new URL('../../src/handlers/context.ts', import.meta.url), 'utf8');
  assert.match(cwdGateSource, /assertPathInsideWorktree\(storyId, cwd, resolution\.authoritativeCwd\)/,
    'generic story command cwd gate remains present for canonical readers');
  assert.match(cwdGateSource, /Expected cwd: \$\{normalizedExpected\}/,
    'generic story command cwd refusal still identifies the required authoritative worktree');
  const hostRunSource = readFileSync(new URL('../../src/handlers/host-run.ts', import.meta.url), 'utf8');
  assert.match(hostRunSource, /evaluateAcceptanceTopologyForContext\(ctx, storyId\)/,
    'controller evaluates acceptance topology before the managed provider launch');
  assert.match(hostRunSource, /evaluatePreReviewCheckForContext\(ctx, storyId\)/,
    'controller evaluates pre-review status before the managed provider launch');
  assert.match(hostRunSource, /evaluateAcceptanceRolloutForContext\(ctx, storyId\)/,
    'controller evaluates both rollout report and policy projections before launch');
  assert.match(hostRunSource, /buildManagedReviewerPrompt\(promptRoot, reviewRun, canonicalReportStatuses, fullScanBinding(?:, deltaRound)?\)/,
    'the controller-derived statuses and sealed candidate full-scan binding reach the managed-only prompt renderer');
  console.log('managed-review-prompt-cwd-isolation-smoke PASS');
}

main();
