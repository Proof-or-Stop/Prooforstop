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

const GROUP_ID = 'G01';
const REQUIRED_ROW_COUNT = 15;
const EVALUATED_AT = '2026-07-01T00:00:00.000Z';
const CURRENT_HEAD_HASH = 'g01-head-hash';
const CURRENT_MATERIAL_HASH = 'g01-material-hash';
const CURRENT_STORY_FILES_HASH = 'g01-story-files-hash';
const SMOKE_COMMAND = 'node packages/main/dist/tasks/parent-roadmap-large-ledger-g01-baseline-smoke.js';
const BASELINE_DOC = 'docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md';
const LOCAL_CLAIM_BOUNDARY = 'Local G01 synthetic ledger proof only; no external rollout readiness or separate-host quorum is asserted.';

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

assert.equal(milestoneMeanings.length, REQUIRED_ROW_COUNT, 'G01 milestone template must stay at exactly 15 rows');

function escapedPatternTerm(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const disallowedClaimTerms = [
  ['Authority'].join(''),
  ['full', 'Authority'].join(''),
  ['production'].join(''),
  ['independent', 'two-host', 'completion'].join(' '),
  ['two-host', 'completion'].join(' '),
];
const disallowedClaimPattern = new RegExp(disallowedClaimTerms.map(escapedPatternTerm).join('|'), 'i');

function rowId(index: number): string {
  return `${GROUP_ID}-M${String(index + 1).padStart(2, '0')}`;
}

function requiredRowIds(): string[] {
  return Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => rowId(index));
}

function buildG01Row(index: number): ParentRoadmapRow {
  const id = rowId(index);
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]}`,
    intentText: `${GROUP_ID} positive-control coverage for ${milestoneMeanings[index]}.`,
    status: 'closed-by-existing-evidence',
    childStoryId: 'B-b596',
    closureEvidence: [
      {
        kind: 'deterministic_smoke',
        ref: `B-b596:${id}:parent-roadmap-large-ledger-g01-baseline-smoke`,
        result: 'pass',
        command: SMOKE_COMMAND,
        artifactRef: `${BASELINE_DOC}#g01`,
        headHash: CURRENT_HEAD_HASH,
        materialHash: CURRENT_MATERIAL_HASH,
        storyFilesHash: CURRENT_STORY_FILES_HASH,
        stale: false,
        observedAt: EVALUATED_AT,
      },
    ],
    materialRefs: [
      BASELINE_DOC,
      'packages/main/src/tasks/parent-roadmap-large-ledger-g01-baseline-smoke.ts',
      'packages/main/src/core/parent-roadmap-totality.ts',
    ],
    updatedAt: EVALUATED_AT,
    headHash: CURRENT_HEAD_HASH,
    materialHash: CURRENT_MATERIAL_HASH,
    storyFilesHash: CURRENT_STORY_FILES_HASH,
    claimBoundary: LOCAL_CLAIM_BOUNDARY,
  };
}

function buildG01Ledger(generatedRows = REQUIRED_ROW_COUNT): ParentRoadmapLedger {
  const inventory = requiredRowIds();
  return {
    schemaVersion: PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: 'UDM-no-false-done-G01-positive-control',
    parentStoryId: 'UDM-no-false-done-baseline',
    originalIntentSnapshot: 'G01 positive control for the UDM no-false-DONE 10x15 baseline: all 15 G01 rows are represented, closed, fresh, and locally claim-bounded.',
    sourceRefs: [`${BASELINE_DOC}#g01`],
    requiredRowIds: inventory,
    rows: Array.from({ length: generatedRows }, (_, index) => buildG01Row(index)),
    createdByStoryId: 'B-b596',
    updatedByStoryIds: ['B-b596'],
    proofstoryContract: {
      acceptanceBindings: [
        { id: 'udm-no-false-done-g01-positive-control', milestoneIds: inventory },
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

function assertExactlyGeneratedRows(ledger: ParentRoadmapLedger, expected = REQUIRED_ROW_COUNT): void {
  assert.equal(
    ledger.rows.length,
    expected,
    `expected exactly ${expected} generated ${GROUP_ID} rows`,
  );
}

function assertNoElevatedClaims(label: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, disallowedClaimPattern, `${label} must not contain elevated completion claim terms`);
}

function assertClaimGuardPositiveControl(): void {
  const wouldBeOverclaim = [
    ['Authority'].join(''),
    ['full', 'Authority'].join(''),
    ['production'].join(''),
    ['independent', 'two-host', 'completion'].join(' '),
  ].join(' | ');
  assert.match(wouldBeOverclaim, disallowedClaimPattern, 'claim-boundary guard must catch elevated completion vocabulary');
}

function assertG01PositiveControl(): void {
  const ledger = buildG01Ledger();
  assertExactlyGeneratedRows(ledger);

  const rollup = evaluate(ledger);
  assert.equal(rollup.rowResults.length, REQUIRED_ROW_COUNT, 'rollup reports exactly 15 rows');
  assert.equal(closedRowCount(rollup), REQUIRED_ROW_COUNT, 'rollup reports exactly 15 closed rows');
  assert.deepEqual(rollup.openRows, [], 'G01 has zero open rows');
  assert.deepEqual(rollup.staleEvidenceRows, [], 'G01 has zero stale rows');
  assert.deepEqual(rollup.deferredRows, [], 'G01 has zero deferred rows');
  assert.deepEqual(rollup.invalidRows, [], 'G01 has zero invalid rows');
  assert.deepEqual(rollup.migrationRows, [], 'G01 has zero migration rows');
  assert.equal(rollup.summaryClass, 'full_roadmap_complete');
  assert.equal(rollup.claimType, 'full-roadmap-claim');
  assert.equal(rollup.allRowsClosed, true);

  for (const row of rollup.rowResults) {
    assert.equal(row.closed, true, `${row.rowId} is closed`);
    assert.equal(row.evidenceState, 'fresh', `${row.rowId} evidence is fresh`);
    assert.equal(row.claimBoundary, LOCAL_CLAIM_BOUNDARY, `${row.rowId} keeps the local claim boundary`);
  }

  const claim = evaluateParentRoadmapClaim({
    rollup,
    summaryText: rollup.allowedSummaryText,
    mode: 'enforce',
  });
  assert.equal(claim.allowed, true, 'full-roadmap wording is allowed for the G01 positive control');
  assert.equal(claim.blocking, false, 'G01 positive control claim is not blocking');

  assertClaimGuardPositiveControl();
  assertNoElevatedClaims('G01 ledger', ledger);
  assertNoElevatedClaims('G01 rollup', rollup);
  assertNoElevatedClaims('G01 claim decision', claim);
}

function assertGeneratedRowCountNegativeGuard(): void {
  const truncatedLedger = buildG01Ledger(REQUIRED_ROW_COUNT - 1);
  assert.throws(
    () => assertExactlyGeneratedRows(truncatedLedger),
    /expected exactly 15 generated G01 rows/,
    'local baseline invariant rejects fewer than 15 generated rows',
  );

  const rollup = evaluate(truncatedLedger);
  const missingRow = rowId(REQUIRED_ROW_COUNT - 1);
  assert.equal(truncatedLedger.rows.length, REQUIRED_ROW_COUNT - 1, 'negative control generated only 14 rows');
  assert.equal(rollup.rowResults.length, REQUIRED_ROW_COUNT, 'required inventory still expands to 15 evaluated rows');
  assert.notEqual(rollup.summaryClass, 'full_roadmap_complete', '14 generated rows cannot silently become full completion');
  assert.equal(rollup.allRowsClosed, false, '14 generated rows keep allRowsClosed false');
  assert.equal(closedRowCount(rollup), REQUIRED_ROW_COUNT - 1, 'only generated rows close');
  assert.ok(rollup.openRows.includes(missingRow), 'missing required row remains open');
  assert.ok(rollup.invalidRows.includes(missingRow), 'missing required row is invalid');
  assert.ok(
    rollup.rowResults.some((row) => row.rowId === missingRow && row.reasonCodes.includes('missing_required_row')),
    'missing row is reported by the evaluator as missing_required_row',
  );

  const claim = evaluateParentRoadmapClaim({
    rollup,
    summaryText: 'Full roadmap complete.',
    mode: 'enforce',
  });
  assert.equal(claim.allowed, false, 'full completion wording is blocked for 14 generated rows');
  assert.equal(claim.blocking, true, 'enforce mode blocks the truncated generated ledger');
}

assertG01PositiveControl();
assertGeneratedRowCountNegativeGuard();

console.log('parent-roadmap large-ledger G01 baseline smoke PASS');
