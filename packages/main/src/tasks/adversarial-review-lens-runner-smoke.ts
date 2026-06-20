/**
 * Smoke: adversarial-review S1 lens runner (B-97ab).
 *
 * Hermetic — no FS/git/store. Proves the §4.2 lens→lane mapping, the INDEPENDENT
 * per-lens plan, the injected `runLens` seam, and the non-de-duplicating
 * aggregator, with a FAKE runLens. Every assertion is pinned to EXPLICIT expected
 * literals declared IN THIS SMOKE (not self-referenced to the module's own
 * consts), so a drift of the mapping / plan shape / aggregation away from the spec
 * fails here.
 *
 * Run: node packages/main/dist/tasks/adversarial-review-lens-runner-smoke.js
 */

import {
  LENS_TO_LANE,
  buildLensRunPlan,
  runLenses,
  collectRawFindings,
  type LensRunRequest,
} from '../core/adversarial-review-lens-runner.js';
import { CANONICAL_LENS_SET, type Finding } from '../core/adversarial-review.js';
import { REVIEW_RUN_LANES } from '../core/review-run.js';

let passed = 0;
const check = (name: string, cond: boolean): void => {
  if (!cond) {
    console.error('FAIL: ' + name);
    process.exit(1);
  }
  passed++;
};

// Explicit expected ground truth — declared independently of the module so a
// contract drift fails hermetically.
const EXPECTED_LENS_TO_LANE: Record<string, string> = {
  'concept/scope': 'lattice-review-concept',
  'code-quality': 'lattice-review-quality',
  'behavior/correctness': 'lattice-review-behavior',
  'test-coverage': 'lattice-review-test-coverage',
  'crash-safety/edge': 'lattice-review-behavior',
  'docs-consistency': 'lattice-review-docs',
};
const EXPECTED_LENS_IDS_IN_ORDER = [
  'concept/scope',
  'code-quality',
  'behavior/correctness',
  'test-coverage',
  'crash-safety/edge',
  'docs-consistency',
];

const planted = (title: string): Finding => ({
  severity: 'MAJOR',
  title,
  file: 'packages/main/src/core/x.ts',
  line: 1,
  issue: 'planted by fake runLens',
  fix: 'n/a',
});

// ── 1. mapping is a real-lane subset + the 6 specific expected pairs ──────────
const lanes = REVIEW_RUN_LANES as readonly string[];
for (const v of Object.values(LENS_TO_LANE)) {
  check('LENS_TO_LANE value "' + v + '" is a real review_run lane', lanes.includes(v));
}
for (const [lensId, expectedLane] of Object.entries(EXPECTED_LENS_TO_LANE)) {
  check(
    'LENS_TO_LANE[' + lensId + '] === ' + expectedLane,
    LENS_TO_LANE[lensId as keyof typeof LENS_TO_LANE] === expectedLane,
  );
}
// behavior/correctness and crash-safety/edge intentionally share a lane.
check(
  'behavior/correctness and crash-safety/edge map to the SAME lane',
  LENS_TO_LANE['behavior/correctness'] === LENS_TO_LANE['crash-safety/edge'] &&
    LENS_TO_LANE['behavior/correctness'] === 'lattice-review-behavior',
);

// ── 2. plan shape over the default CANONICAL_LENS_SET ─────────────────────────
const plan = buildLensRunPlan('DIFF');
check('buildLensRunPlan(DIFF) yields 6 requests', plan.length === 6);
for (let i = 0; i < EXPECTED_LENS_IDS_IN_ORDER.length; i++) {
  const req = plan[i];
  const expectedId = EXPECTED_LENS_IDS_IN_ORDER[i];
  check('request[' + i + '].lensId === ' + expectedId, req.lensId === expectedId);
  check(
    'request[' + i + '].lane === LENS_TO_LANE[' + expectedId + ']',
    req.lane === EXPECTED_LENS_TO_LANE[expectedId],
  );
  check('request[' + i + '].change === DIFF', req.change === 'DIFF');
  check(
    'request[' + i + '] has EXACTLY keys {change,lane,lensId}',
    Object.keys(req).sort().join(',') === 'change,lane,lensId',
  );
}

// ── 3. subset plan ───────────────────────────────────────────────────────────
const subsetPlan = buildLensRunPlan(
  'D',
  CANONICAL_LENS_SET.filter((l) => l.id === 'code-quality' || l.id === 'docs-consistency'),
);
check('subset plan yields exactly 2 requests', subsetPlan.length === 2);
check('subset[0].lensId === code-quality', subsetPlan[0].lensId === 'code-quality');
check('subset[0].lane === lattice-review-quality', subsetPlan[0].lane === 'lattice-review-quality');
check('subset[1].lensId === docs-consistency', subsetPlan[1].lensId === 'docs-consistency');
check('subset[1].lane === lattice-review-docs', subsetPlan[1].lane === 'lattice-review-docs');

// ── 4. runLenses + injected seam + independence ──────────────────────────────
const seen1: LensRunRequest[] = [];
const codeQualityFinding = planted('code-quality only');
const fake1 = (req: LensRunRequest): Finding[] => {
  seen1.push(req);
  return req.lensId === 'code-quality' ? [codeQualityFinding] : [];
};
const results1 = runLenses('DIFF', CANONICAL_LENS_SET, fake1);
check('runLenses yields 6 results', results1.length === 6);
const cqResult = results1.find((r) => r.lensId === 'code-quality')!;
check('code-quality result has exactly 1 finding', cqResult.findings.length === 1);
check('code-quality result finding === planted', cqResult.findings[0] === codeQualityFinding);
check(
  'all non-code-quality results have [] findings',
  results1.filter((r) => r.lensId !== 'code-quality').every((r) => r.findings.length === 0),
);
check(
  'every request the fake saw had ONLY {change,lane,lensId} keys (independence)',
  seen1.length === 6 &&
    seen1.every((req) => Object.keys(req).sort().join(',') === 'change,lane,lensId'),
);

// ── 5. two behavior-mapped lenses stay distinct ──────────────────────────────
const behaviorFinding = planted('behavior/correctness defect');
const crashFinding = planted('crash-safety/edge defect');
const fake2 = (req: LensRunRequest): Finding[] => {
  if (req.lensId === 'behavior/correctness') return [behaviorFinding];
  if (req.lensId === 'crash-safety/edge') return [crashFinding];
  return [];
};
const results2 = runLenses('DIFF', CANONICAL_LENS_SET, fake2);
const behaviorResult = results2.find((r) => r.lensId === 'behavior/correctness')!;
const crashResult = results2.find((r) => r.lensId === 'crash-safety/edge')!;
check('behavior result lane === lattice-review-behavior', behaviorResult.lane === 'lattice-review-behavior');
check('crash result lane === lattice-review-behavior', crashResult.lane === 'lattice-review-behavior');
check('behavior result carries its OWN finding', behaviorResult.findings.length === 1 && behaviorResult.findings[0] === behaviorFinding);
check('crash result carries its OWN finding', crashResult.findings.length === 1 && crashResult.findings[0] === crashFinding);
check('the two behavior-mapped findings are NOT mis-attributed', behaviorResult.findings[0] !== crashResult.findings[0]);

// ── 6. collectRawFindings flattens with no de-dup ────────────────────────────
const collected = collectRawFindings(results2);
check('collectRawFindings flattens to exactly 2 findings', collected.length === 2);
check('collectRawFindings preserves the behavior finding', collected.includes(behaviorFinding));
check('collectRawFindings preserves the crash finding', collected.includes(crashFinding));

console.log('adversarial-review-lens-runner smoke passed: ' + passed + ' assertions');
