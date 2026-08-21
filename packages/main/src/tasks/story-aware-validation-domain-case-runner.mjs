#!/usr/bin/env node

/*
 * DYN-5 repository runner.  The case registry points here instead of a
 * print-only command so every isolated shard reaches the same core signing and
 * assurance code used by the review/quorum smoke domains.
 */
import { signReviewPass } from '../../dist/core/finding-verify.js';
import { evaluateReviewAssuranceFloor } from '../../dist/core/review-assurance-floor.js';

const [domain, caseId] = process.argv.slice(2);
if (!domain || !caseId) throw new Error('domain and caseId are required');

if (domain === 'review-pass') {
  const signature = signReviewPass(
    'B-dynamic-validation-domain',
    caseId,
    'lattice-review-concept',
    `DYN-5 isolated review-pass scenario ${caseId}`,
    '2026-08-18T00:00:00.000Z',
    'dyn5-domain-round',
  );
  if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error('review-pass core signature was not produced');
} else if (domain === 'quorum') {
  const report = evaluateReviewAssuranceFloor({
    projectRoot: process.cwd(),
    gitCwd: process.cwd(),
    storyId: 'B-dynamic-validation-domain',
    changedFiles: [],
    touchpoints: ['packages/main/src/handlers/quorum-submit.ts'],
  });
  if (!report || report.schemaVersion !== 'lattice.review_assurance_floor.v1') {
    throw new Error('quorum assurance-floor core report was not produced');
  }
} else {
  throw new Error(`unsupported DYN-5 domain: ${domain}`);
}

process.stdout.write(`PROOF_OR_STOP_DOMAIN_CASE:${caseId}\n`);
