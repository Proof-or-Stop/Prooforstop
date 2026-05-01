#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import {
  buildVerificationCoverage,
  getBlockingVerificationEvidenceIssues,
  renderVerificationCoverage,
} from '../core/verification.js';
import type { ChecklistData } from '../core/types.js';

const checklist: ChecklistData = {
  items: [{
    id: 'CHK-001',
    title: 'Exercise REVIEW gate behavior',
    context: 'The gate can only be verified after entering REVIEW.',
    status: 'done',
    startTime: null,
    endTime: null,
    verificationIntent: {
      happy: [{ desc: 'REVIEW gate can be exercised', type: 'cli', priority: 'must' }],
      edge: [],
      adversarial: [],
    },
    verificationEvidence: [{
      intentRef: 'CHK-001:happy:0',
      kind: 'waiver',
      waiverType: 'deferred_gate_evidence',
      note: 'Temporary gate-self-test evidence until REVIEW can run the gate.',
    }],
  }],
};

const devGateCoverage = buildVerificationCoverage(checklist);
assert.equal(devGateCoverage.entries[0]?.status, 'deferred');
assert.equal(devGateCoverage.missingRequired, 0, 'DEV->REVIEW gate should allow deferred gate evidence');
assert.deepEqual(getBlockingVerificationEvidenceIssues(checklist), []);

const validateCoverage = buildVerificationCoverage(checklist, undefined, undefined, {
  deferredGateEvidence: 'missing',
});
assert.equal(validateCoverage.entries[0]?.status, 'deferred');
assert.equal(validateCoverage.missingRequired, 1, 'validate/story TEST gate should require deferred evidence to be replaced');
assert.match(renderVerificationCoverage(validateCoverage), /deferred via waiver/);

const permanentWaiver: ChecklistData = {
  items: [{
    ...checklist.items[0],
    verificationEvidence: [{
      intentRef: 'CHK-001:happy:0',
      kind: 'waiver',
      waiverType: 'permanent',
      note: 'Permanent non-automatable verification waiver.',
    }],
  }],
};
const permanentCoverage = buildVerificationCoverage(permanentWaiver, undefined, undefined, {
  deferredGateEvidence: 'missing',
});
assert.equal(permanentCoverage.entries[0]?.status, 'waived');
assert.equal(permanentCoverage.missingRequired, 0);

console.log('✓ deferred gate evidence smoke passed');
