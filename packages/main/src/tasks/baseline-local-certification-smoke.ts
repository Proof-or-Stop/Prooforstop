#!/usr/bin/env node
/**
 * Non-authority baseline local certification smoke.
 *
 * Proves the baseline terminal contract from ProofOrStop-baseline.md:
 * local independent review evidence is required; localReviewCertified=true only
 * when that evidence exists; Authority server contact stays false; and a
 * non-authority run cannot report any Authority DONE flag.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildNonAuthorityBaselineFinalReport,
  buildNonAuthorityBaselineLocalReviewStatus,
  NON_AUTHORITY_FORBIDDEN_DONE_FIELDS,
} from '../core/baseline-contracts.js';
import {
  submitVerdict,
  summarizeVerdicts,
  type VerdictSummary,
} from '../core/verdicts.js';

const PASS_LINE =
  '✓ baseline local certification smoke passed: non-authority local review evidence required, zero Authority contact, false-DONE negatives pinned';

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-baseline-local-cert-'));

try {
  // A passing non-authority baseline needs independent local review evidence.
  submitVerdict(root, {
    mode: 'local',
    storyId: 'B-base',
    runId: 'run-local',
    hostId: 'codex-host',
    provider: 'codex',
    sessionId: 'session-a',
    decision: 'pass',
    materialDigest: 'mat-local',
  });
  submitVerdict(root, {
    mode: 'local',
    storyId: 'B-base',
    runId: 'run-local',
    hostId: 'gemini-host',
    provider: 'gemini',
    sessionId: 'session-b',
    decision: 'pass',
    materialDigest: 'mat-local',
  });

  const summary = summarizeVerdicts(root, 'local', 'B-base', 'run-local', 2);
  assert.equal(summary.status, 'pass');
  assert.equal(summary.localReviewCertified, true);
  assert.equal(summary.authorityServerContact, false);
  assert.equal(summary.receiptVerified, false);
  assert.equal(summary.authorityDone, false);
  assert.equal(summary.multiHostVerified, false);
  assert.equal(summary.fullAuthorityDone, false);
  assert.equal(summary.localReviewEvidenceRefs.length, 2, 'two independent local verdict refs are the certification evidence');

  const localStatus = buildNonAuthorityBaselineLocalReviewStatus(summary);
  assert.equal(localStatus.status, 'pass');
  assert.equal(localStatus.localReviewCertified, true);
  assert.equal(localStatus.authorityServerContact, false);
  assert.equal(localStatus.evidenceRefs.length, 2);
  assert.equal(localStatus.authorityDone, false);
  assert.equal(localStatus.receiptVerified, false);
  assert.equal(localStatus.multiHostVerified, false);
  assert.equal(localStatus.fullAuthorityDone, false);

  const report = buildNonAuthorityBaselineFinalReport({
    baselineId: 'NL-CLI-1',
    track: 'natural-language',
    expectedOutcome: 'PASS',
    localReviewStatus: localStatus,
  });
  assert.equal(report.outcome, 'PASS');
  assert.equal(report.authority.mode, 'non-authority');
  assert.equal(report.authority.authorityDone, false);
  assert.equal(report.authority.receiptVerified, false);
  assert.equal(report.authority.multiHostVerified, false);
  assert.equal(report.authority.fullAuthorityDone, false);
  assert.equal(report.authority.status, 'not-applicable');
  assert(report.local, 'non-authority baseline final report must include local status');
  assert.equal(report.local.localReviewCertified, true);
  assert.equal(report.local.authorityServerContact, false);
  assert.equal(report.artifacts.authorityStatus, null);
  assert.equal(report.artifacts.localReviewStatus, 'local-review-status.json');

  // No evidence means no local certification, even if the run itself exists.
  const noEvidenceSummary = summarizeVerdicts(root, 'local', 'B-empty', 'run-empty', 2);
  const noEvidenceStatus = buildNonAuthorityBaselineLocalReviewStatus(noEvidenceSummary);
  assert.equal(noEvidenceStatus.status, 'blocked');
  assert.equal(noEvidenceStatus.localReviewCertified, false);
  assert.match(noEvidenceStatus.blockedReason ?? '', /local_review_evidence_missing|insufficient_independent_hosts/);
  const noEvidenceReport = buildNonAuthorityBaselineFinalReport({
    baselineId: 'NL-CLI-1',
    track: 'natural-language',
    expectedOutcome: 'PASS',
    localReviewStatus: noEvidenceStatus,
  });
  assert.equal(noEvidenceReport.outcome, 'FAIL', 'a PASS-expected non-authority baseline without local evidence fails');

  // A single host is evidence, but not independent local review.
  submitVerdict(root, {
    mode: 'local',
    storyId: 'B-solo',
    runId: 'run-solo',
    hostId: 'codex-host',
    provider: 'codex',
    sessionId: 'session-solo',
    decision: 'pass',
    materialDigest: 'mat-solo',
  });
  const soloStatus = buildNonAuthorityBaselineLocalReviewStatus(
    summarizeVerdicts(root, 'local', 'B-solo', 'run-solo', 2),
  );
  assert.equal(soloStatus.status, 'blocked');
  assert.equal(soloStatus.localReviewCertified, false);
  assert.match(soloStatus.blockedReason ?? '', /local_review_evidence_missing|insufficient_independent_hosts/);

  const downgradedHostFloor = summarizeVerdicts(root, 'local', 'B-solo', 'run-solo', 1);
  assert.equal(downgradedHostFloor.requiredHosts, 2, 'requiredHosts cannot be downgraded below the two-host final-check floor');
  assert.equal(downgradedHostFloor.status, 'blocked');
  assert.equal(downgradedHostFloor.localReviewCertified, false);
  assert.match(downgradedHostFloor.blockedReason ?? '', /requires 2 passing independent host verdicts/);

  // Negative false-DONE proof: each forbidden Authority field is forged true on
  // an otherwise passing local summary. The baseline projector must fail closed
  // and still report every Authority field false in both status and final report.
  for (const field of NON_AUTHORITY_FORBIDDEN_DONE_FIELDS) {
    const forged = {
      ...summary,
      [field]: true,
    } as unknown as VerdictSummary;
    const forgedStatus = buildNonAuthorityBaselineLocalReviewStatus(forged);
    assert.equal(forgedStatus.status, 'blocked', `${field}=true must block non-authority certification`);
    assert.equal(forgedStatus.localReviewCertified, false);
    assert.deepEqual(forgedStatus.falseDoneFields, [field]);
    assert.match(forgedStatus.blockedReason ?? '', new RegExp(field));
    assert.equal(forgedStatus[field], false, `${field} must be forced false on the emitted local-review status`);

    const forgedReport = buildNonAuthorityBaselineFinalReport({
      baselineId: 'NL-CLI-1',
      track: 'natural-language',
      expectedOutcome: 'PASS',
      localReviewStatus: forgedStatus,
    });
    assert.equal(forgedReport.outcome, 'FAIL');
    assert.equal(forgedReport.authority[field], false, `${field} must be forced false on the emitted final report`);
    assert(forgedReport.failure?.details?.some(detail => detail.includes(field)), `failure details must name ${field}`);
  }

  // Zero Authority contact is part of the local proof. A forged contact bit blocks
  // certification and the emitted baseline status still reports false.
  const forgedContact = {
    ...summary,
    authorityServerContact: true,
  } as unknown as VerdictSummary;
  const contactStatus = buildNonAuthorityBaselineLocalReviewStatus(forgedContact);
  assert.equal(contactStatus.status, 'blocked');
  assert.equal(contactStatus.localReviewCertified, false);
  assert.equal(contactStatus.authorityServerContact, false);
  assert.equal(contactStatus.blockedReason, 'non_authority_authority_server_contact');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(PASS_LINE);
