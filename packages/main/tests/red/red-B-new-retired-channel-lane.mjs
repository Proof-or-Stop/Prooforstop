#!/usr/bin/env node
/**
 * RED (repro-first) for the retired "channel" reviewer-lane staleness in
 * field-regression-cli-smoke.ts.
 *
 * Root cause (confirmed by source read): `proof-or-stop-review-channel` is deliberately and
 * structurally retired in core/prompt-role-contract-registry.ts (status: 'retired',
 * defaultDispatch: false, enforced by an assertion at registry-build time). Two functions
 * in field-regression-cli-smoke.ts still reference it as if it were an active, forceable
 * reviewer lane:
 *   - assertReviewerListForceReviewerLaneContract asserts `reviewer_list --forceReviewer`
 *     including "channel" reports it as forced=true ("retired compatibility lane should
 *     remain forceable while review_run_start supports it") -- but review_run_start no
 *     longer supports it in any capacity, so reviewer_list now rejects it outright, matching
 *     production code's own deliberate tightening.
 *   - assertPassOnlyFindingConvertsToReviewPassCliSurface calls
 *     `review_run_start` with agent: 'proof-or-stop-review-channel' as one of five distinct
 *     reviewer lanes exercised to prove finding_add's pass-wording detection generalizes --
 *     review_run_start now refuses it: "agent \"proof-or-stop-review-channel\" is retired or not
 *     eligible to create REVIEW evidence".
 *
 * Before the fix: field-regression-cli-smoke.js exits non-zero, throwing inside
 * assertReviewerListForceReviewerLaneContract with the reviewer_list rejection message,
 * before ever reaching assertPassOnlyFindingConvertsToReviewPassCliSurface's separate
 * channel-lane defect.
 * After the fix (assertReviewerListForceReviewerLaneContract updated to expect "channel"
 * rejected like the already-tested "proof-or-stop-review-delivery" case, and
 * assertPassOnlyFindingConvertsToReviewPassCliSurface's channel lane replaced with the
 * currently-supported, not-yet-exercised-in-this-test "proof-or-stop-review-test-coverage" lane):
 * both signatures disappear.
 *
 * Uses spawnSync with a real file descriptor (not a pipe) for stderr capture -- see
 * red-B-74b9-chk001-acceptance-basis.mjs for why execFileSync's pipe-based capture is
 * unreliable for large synchronous crash dumps on macOS.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-B-new-retired-channel-lane.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && !existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')) || existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');

const target = join(repoRoot, 'packages/main/dist/tasks/field-regression-cli-smoke.js');
const captureDir = mkdtempSync(join(tmpdir(), 'red-retired-channel-'));
const stderrPath = join(captureDir, 'stderr.txt');

try {
  const fd = openSync(stderrPath, 'w');
  const result = spawnSync(process.execPath, [target], { cwd: repoRoot, stdio: ['ignore', 'ignore', fd] });
  closeSync(fd);

  const stderr = readFileSync(stderrPath, 'utf8');

  assert.notEqual(result.status, 0, 'RED: field-regression-cli-smoke.js is expected to fail (still references the retired channel lane)');
  assert.match(stderr, /forceReviewer "channel" is not supported by review_run_start/, 'RED: expected reviewer_list to reject the retired channel lane');
  assert.match(stderr, /assertReviewerListForceReviewerLaneContract/, 'RED: expected the crash to originate from assertReviewerListForceReviewerLaneContract (the stale "channel"-forceable assertion)');

  console.log('RED red-B-new-retired-channel-lane: confirmed pre-fix defect (fixture still expects the deliberately-retired "channel" reviewer lane to be forceable)');
} finally {
  rmSync(captureDir, { recursive: true, force: true });
}
