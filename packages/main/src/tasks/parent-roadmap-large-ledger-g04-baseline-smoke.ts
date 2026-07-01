#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import {
  PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
  evaluateParentRoadmapClaim,
  evaluateParentRoadmapLedger,
  type ParentRoadmapLedger,
  type ParentRoadmapRow,
  type ParentRollupResult,
} from '../core/parent-roadmap-totality.js';

const GROUP_ID = 'G04';
const REQUIRED_ROW_COUNT = 15;
const EVALUATED_AT = '2026-07-01T00:00:00.000Z';
const CURRENT_HEAD_HASH = 'g04-head-hash';
const CURRENT_MATERIAL_HASH = 'g04-material-hash';
const CURRENT_STORY_FILES_HASH = 'g04-story-files-hash';
const STALE_HEAD_HASH = 'g04-stale-head-hash';
const STALE_MATERIAL_HASH = 'g04-stale-material-hash';
const STALE_STORY_FILES_HASH = 'g04-stale-story-files-hash';
const SMOKE_COMMAND = 'node packages/main/dist/tasks/parent-roadmap-large-ledger-g04-baseline-smoke.js';
const BASELINE_DOC = 'docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md';
const LOCAL_CLAIM_BOUNDARY = 'Local G04 stale-evidence proof only; current material binding must be refreshed before closure.';

const milestoneMeanings = [
  'Original intent snapshot preserved',
  'Milestone ledger complete',
  'Intent coverage check',
  'Scope shrinkage guard',
  'Child/story slicing boundary',
  'Acceptance contract binding',
  'Machine evidence present',
  'Evidence freshness',
  'Negative control',
  'Review assurance',
  'Delivery check',
  'Claim boundary',
  'DONE intent equivalence',
  'Rollup status',
  'Handoff summary',
] as const;

assert.equal(milestoneMeanings.length, REQUIRED_ROW_COUNT, 'G04 milestone template must stay at exactly 15 rows');

function rowId(index: number): string {
  return `${GROUP_ID}-M${String(index + 1).padStart(2, '0')}`;
}

function requiredRowIds(): string[] {
  return Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => rowId(index));
}

function buildG04Row(index: number): ParentRoadmapRow {
  const id = rowId(index);
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]} stale evidence`,
    intentText: `${GROUP_ID} stale-evidence negative control for ${milestoneMeanings[index]}.`,
    status: 'closed-by-existing-evidence',
    childStoryId: 'B-d278',
    closureEvidence: [
      {
        kind: 'deterministic_smoke',
        ref: `B-d278:${id}:parent-roadmap-large-ledger-g04-baseline-smoke`,
        result: 'pass',
        command: SMOKE_COMMAND,
        artifactRef: `${BASELINE_DOC}#g04`,
        headHash: STALE_HEAD_HASH,
        materialHash: STALE_MATERIAL_HASH,
        storyFilesHash: STALE_STORY_FILES_HASH,
        stale: false,
        observedAt: EVALUATED_AT,
      },
    ],
    materialRefs: [
      BASELINE_DOC,
      'packages/main/src/tasks/parent-roadmap-large-ledger-g04-baseline-smoke.ts',
      'packages/main/src/core/parent-roadmap-totality.ts',
    ],
    updatedAt: EVALUATED_AT,
    headHash: STALE_HEAD_HASH,
    materialHash: STALE_MATERIAL_HASH,
    storyFilesHash: STALE_STORY_FILES_HASH,
    claimBoundary: LOCAL_CLAIM_BOUNDARY,
  };
}

function buildG04Ledger(): ParentRoadmapLedger {
  const inventory = requiredRowIds();
  return {
    schemaVersion: PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: 'UDM-no-false-done-G04-stale-evidence-negative-control',
    parentStoryId: 'UDM-no-false-done-baseline',
    originalIntentSnapshot: 'G04 stale-evidence negative control: all 15 rows have closure evidence bound to stale head/material/story-file hashes.',
    sourceRefs: [`${BASELINE_DOC}#g04`],
    requiredRowIds: inventory,
    rows: Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => buildG04Row(index)),
    createdByStoryId: 'B-d278',
    updatedByStoryIds: ['B-d278'],
    proofstoryContract: {
      acceptanceBindings: [
        { id: 'udm-no-false-done-g04-stale-evidence-negative-control', milestoneIds: inventory },
      ],
    },
  };
}

function evaluate(ledger: ParentRoadmapLedger): ParentRollupResult {
  return evaluateParentRoadmapLedger(ledger, {
    evaluatedAt: EVALUATED_AT,
    currentHeadHash: CURRENT_HEAD_HASH,
    currentMaterialHash: CURRENT_MATERIAL_HASH,
    currentStoryFilesHash: CURRENT_STORY_FILES_HASH,
  });
}

function closedRowCount(rollup: ParentRollupResult): number {
  return rollup.rowResults.filter((row) => row.closed).length;
}

const ledger = buildG04Ledger();
const inventory = requiredRowIds();
assert.equal(ledger.requiredRowIds?.length, REQUIRED_ROW_COUNT, 'G04 required inventory has exactly 15 row ids');
assert.equal(ledger.rows.length, REQUIRED_ROW_COUNT, 'G04 generates exactly 15 ledger rows');

const rollup = evaluate(ledger);
assert.equal(rollup.rowResults.length, REQUIRED_ROW_COUNT, 'rollup reports exactly 15 required rows');
assert.equal(closedRowCount(rollup), 0, 'stale evidence closes zero rows');
assert.deepEqual(rollup.staleEvidenceRows, inventory, 'G04 has exactly 15 stale evidence rows');
assert.deepEqual(rollup.openRows, inventory, 'G04 keeps all stale rows open');
assert.deepEqual(rollup.deferredRows, [], 'G04 has zero deferred rows');
assert.deepEqual(rollup.invalidRows, [], 'G04 has zero invalid rows');
assert.deepEqual(rollup.migrationRows, [], 'G04 has zero migration rows');
assert.equal(rollup.summaryClass, 'stale_parent_rollup');
assert.equal(rollup.claimType, 'no-full-roadmap-claim');
assert.notEqual(rollup.summaryClass, 'full_roadmap_complete');
assert.notEqual(rollup.claimType, 'full-roadmap-claim');
assert.equal(rollup.allRowsClosed, false);

for (const row of rollup.rowResults) {
  assert.equal(row.closed, false, `${row.rowId} remains open`);
  assert.equal(row.evidenceState, 'stale', `${row.rowId} evidence is stale`);
  assert.ok(row.reasonCodes.includes('stale_closure_evidence'), `${row.rowId} reports stale_closure_evidence`);
}

const claim = evaluateParentRoadmapClaim({
  rollup,
  summaryText: 'Full roadmap complete.',
  mode: 'enforce',
});
assert.equal(claim.allowed, false, 'full completion wording is blocked for stale G04 evidence');
assert.equal(claim.blocking, true, 'enforce mode blocks stale G04 evidence');

console.log('parent-roadmap large-ledger G04 baseline smoke PASS');
