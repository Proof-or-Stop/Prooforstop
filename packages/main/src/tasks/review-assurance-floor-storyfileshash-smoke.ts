#!/usr/bin/env node

// B-6de6 CHK-004: fully OFFLINE smoke for the review-assurance floor's
// storyFilesHash secondary downgrade-accept. No git, no network, no claude -p:
// changedFiles, materialHash, storyFilesHash, and processEvents are injected
// directly via args so the evaluator never shells out.
//
// Mirrors review-escalation: whole-tree materialHash stays the PRIMARY key,
// storyFilesHash only forgives UNRELATED whole-tree drift (valid-with-advisory),
// never a real story-file change.

import assert from 'node:assert/strict';
import {
  REVIEW_ASSURANCE_FLOOR_HIGH_RISK_REQUIRED_ROUNDS,
  evaluateReviewAssuranceFloor,
  type EvaluateReviewAssuranceFloorArgs,
} from '../core/review-assurance-floor.js';
import type { ProcessEvent, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-review-assurance-floor-storyfileshash';
const PROJECT_ROOT = '/tmp/review-assurance-floor-storyfileshash-smoke-offline';

// Synthetic, deterministic hashes (never derived from git in this smoke).
const MATERIAL_X = 'material-x-original';
const MATERIAL_Y = 'material-y-drifted'; // unrelated whole-tree drift
const MATERIAL_W = 'material-w-prior'; // a genuinely stale prior material
const STORY_FILES_S = 'story-files-hash-S'; // story-owned files unchanged
const STORY_FILES_S2 = 'story-files-hash-S2'; // a REAL story-file change
const STORY_FILES_S_OLD = 'story-files-hash-S-old';

const MATERIAL_CODE_FILE = 'packages/main/src/index.ts';
const HIGH_RISK_FILE = 'packages/main/src/core/machine.ts';

function story(overrides: Partial<StoryInfo> = {}): StoryInfo {
  return {
    storyId: STORY_ID,
    name: STORY_ID,
    title: 'Review assurance floor storyFilesHash smoke',
    description: 'Offline smoke for storyFilesHash secondary downgrade-accept',
    type: 'feature',
    phase: 'TEST',
    priority: 'medium',
    createdAt: '2026-06-19T09:00:00.000Z',
    startedAt: null,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: '2026-06-19T09:30:00.000Z' }],
    ...overrides,
  };
}

function verdict(
  runId: string,
  host: string,
  materialDigest: string,
  storyFilesHash: string | undefined,
  overrides: Partial<ProcessEvent> = {},
): ProcessEvent {
  return {
    type: 'host_verdict',
    timestamp: '2026-06-19T11:00:00.000Z',
    verdictId: `${runId}-${host}`,
    runId,
    hostId: host,
    provider: 'local-smoke',
    sessionId: `${host}-session`,
    keyId: `${host}-key`,
    decision: 'pass',
    materialDigest,
    validationDigest: `validation-${runId}`,
    promptDigest: `prompt-${runId}`,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    ...overrides,
  };
}

function fallback(
  materialHash: string,
  storyFilesHash: string | undefined,
  overrides: Partial<ProcessEvent> = {},
): ProcessEvent {
  return {
    type: 'review_escalation_fallback',
    command: 'review_escalation_fallback_set',
    timestamp: '2026-06-19T11:30:00.000Z',
    fallbackId: `${STORY_ID}:REF-001`,
    eligibility: 'single-host-environment',
    reason: 'Operator approved degraded fallback because only one verifier host was available.',
    evidenceRefs: ['manual:smoke-single-host-only'],
    materialHash,
    assuranceLevel: 'degraded-single-host',
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    ...overrides,
  };
}

function hostAvailabilityProbe(
  materialHash: string,
  storyFilesHash: string | undefined,
  availableHosts: string[],
  overrides: Partial<ProcessEvent> = {},
): ProcessEvent {
  const available = new Set(availableHosts);
  const hosts = ['codex', 'claude', 'agy'].map(host => ({
    host,
    command: host,
    ...(available.has(host) ? { executablePath: `/fake/bin/${host}` } : {}),
    versionOk: available.has(host),
    available: available.has(host),
    ...(available.has(host) ? { versionOutput: `${host} 1.0.0` } : { error: 'executable not found in PATH' }),
  }));
  return {
    type: 'review_host_availability_probe',
    command: 'review_host_availability_probe',
    timestamp: '2026-06-19T11:20:00.000Z',
    probeId: `${STORY_ID}:RHP-001`,
    checkedAt: '2026-06-19T11:20:00.000Z',
    materialHash,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    hosts,
    availableHostCount: availableHosts.length,
    unavailableHostCount: 3 - availableHosts.length,
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
    ...overrides,
  };
}

// Single-host (3x1) rounds at a given materialDigest + storyFilesHash.
function singleHostRounds(materialDigest: string, storyFilesHash: string): ProcessEvent[] {
  return [
    verdict('round-1', 'codex-a', materialDigest, storyFilesHash),
    verdict('round-2', 'codex-b', materialDigest, storyFilesHash),
    verdict('round-3', 'codex-c', materialDigest, storyFilesHash),
  ];
}

function evaluate(overrides: Partial<EvaluateReviewAssuranceFloorArgs>) {
  return evaluateReviewAssuranceFloor({
    projectRoot: PROJECT_ROOT,
    story: story(),
    changedFiles: [MATERIAL_CODE_FILE],
    processEvents: [],
    ...overrides,
  });
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// (a) Unrelated whole-tree drift: a fresh single-host round was submitted at
// materialHash=X with storyFilesHash=S; the whole-tree materialHash drifts to Y
// (e.g. an unrelated main merge) but storyFilesHash stays S => the round still
// counts valid, with a re-attestation advisory surfaced.
check('(a) unrelated whole-tree drift keeps rounds valid with advisory', () => {
  const report = evaluate({
    storyId: STORY_ID,
    processEvents: [verdict('round-1', 'codex-a', MATERIAL_X, STORY_FILES_S)],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S,
  });
  assert.equal(report.ok, true, 'floor must accept under unrelated drift');
  assert.ok(
    report.localRounds.validRounds.length >= 1,
    `expected >=1 valid round, got ${report.localRounds.validRounds.length}`,
  );
  assert.ok(report.advisories, 'report.advisories must be present');
  assert.match((report.advisories ?? []).join('\n'), /storyFilesHash matches/);
  // F-004: assert the FULL three-part host-verdict advisory pattern, not just a
  // substring, so the actual "materialDigest drift accepted because storyFilesHash
  // matches; re-attestation advisory required" wording cannot regress unnoticed.
  assert.match(
    (report.advisories ?? []).join('\n'),
    /materialDigest drift accepted.*storyFilesHash matches.*re-attestation/,
    'full three-part re-attestation advisory pattern must be present',
  );
});

// F-004 (CHK-003:happy:0) — dedicated full-pattern advisory assertion: the
// surfaced advisory must be the EXACT host-verdict re-attestation wording, not
// merely contain "storyFilesHash matches". Guards against the wording silently
// changing or being replaced by a weaker string.
check('(a2) full three-part re-attestation advisory pattern', () => {
  const report = evaluate({
    storyId: STORY_ID,
    processEvents: [verdict('round-1', 'codex-a', MATERIAL_X, STORY_FILES_S)],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S,
  });
  assert.ok(report.advisories && report.advisories.length > 0, 'advisories must be present');
  assert.match(
    (report.advisories ?? []).join('\n'),
    /materialDigest drift accepted.*storyFilesHash matches.*re-attestation/,
  );
});

// (b) Re-bind after drift: the same fresh storyFilesHash-matching verdict, PLUS
// an accumulated prior verdict that is stale by BOTH hashes (materialHash=W,
// storyFilesHash=S_old) sharing host/session/key identity within the same runId.
// The truly-stale verdict must be ignored (not downgraded), so it must NOT
// poison the round with a duplicate-identity reason.
check('(b) truly-stale prior verdict does not duplicate-poison the round', () => {
  const report = evaluate({
    storyId: STORY_ID,
    processEvents: [
      // fresh-by-storyFilesHash (drifted material, matching S) -> downgraded+accepted
      verdict('round-1', 'codex-a', MATERIAL_X, STORY_FILES_S),
      // stale by BOTH hashes, SAME identity (codex-a) in the SAME runId -> ignored
      verdict('round-1', 'codex-a', MATERIAL_W, STORY_FILES_S_OLD),
    ],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S,
  });
  assert.equal(report.ok, true, 'round must still be valid');
  assert.ok(report.localRounds.validRounds.length >= 1, 'expected the round to be valid');
  const allRoundReasons = [
    ...report.localRounds.validRounds.flatMap(r => r.reasons),
    ...report.localRounds.invalidRounds.flatMap(r => r.reasons),
  ].join('\n');
  assert.doesNotMatch(
    allRoundReasons,
    /duplicate host\/session\/key identity/,
    'truly-stale verdict must be ignored, not duplicate-poisoning',
  );
});

// F-003 (CHK-002:happy:1) — cross-runId re-bind: a truly-stale prior round
// (runId=round-old, materialHash=W, storyFilesHash=S_old) and a downgraded new
// round (runId=round-new, materialHash=X->Y, storyFilesHash=S) share host
// identity but live in DIFFERENT runIds. Only the new round counts; the truly-
// stale verdict is ignored, never poisoning the identity check.
check('(b2) cross-runId re-bind => only new round valid, old ignored', () => {
  const report = evaluate({
    storyId: STORY_ID,
    processEvents: [
      verdict('round-old', 'codex-a', MATERIAL_W, STORY_FILES_S_OLD), // truly stale
      verdict('round-new', 'codex-a', MATERIAL_X, STORY_FILES_S), // downgraded to current
    ],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S,
  });
  assert.equal(report.ok, true);
  assert.equal(report.localRounds.validRounds.length, 1, 'exactly one valid round (round-new)');
  assert.equal(report.localRounds.validRounds[0]?.runId, 'round-new', 'the valid round must be round-new');
  const allRoundReasons = [
    ...report.localRounds.validRounds.flatMap(r => r.reasons),
    ...report.localRounds.invalidRounds.flatMap(r => r.reasons),
  ].join('\n');
  assert.doesNotMatch(allRoundReasons, /duplicate host\/session\/key identity/);
  assert.ok(
    report.localRounds.ignoredVerdicts.some(v => v.runId === 'round-old'),
    'the truly-stale round-old verdict must appear in ignoredVerdicts',
  );
});

// (c) Inverse control: a REAL story-file change (current storyFilesHash=S2
// differs from the recorded S) must NOT be forgiven. The drifted-material round
// stales out: zero fresh rounds and ok=false, with no acceptance advisory.
check('(c) real story-file change stales the rounds (anti-gaming)', () => {
  const report = evaluate({
    storyId: STORY_ID,
    processEvents: [verdict('round-1', 'codex-a', MATERIAL_X, STORY_FILES_S)],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S2,
  });
  assert.equal(report.localRounds.validRounds.length, 0, 'no fresh rounds for a real story-file change');
  assert.equal(report.ok, false, 'floor must NOT accept a real story-file change');
  assert.doesNotMatch(
    (report.advisories ?? []).join('\n'),
    /storyFilesHash matches/,
    'no acceptance advisory for a real story-file change',
  );
});

// (d) Degraded single-host fallback under high-risk: a review_escalation_fallback
// recorded at materialHash=X with storyFilesHash=S. The fallback event carries
// event.materialHash (not materialDigest), so eventsWithStoryFilesHashDowngrade
// does NOT touch it; the floor's own fallback record must apply the same
// downgrade-accept.
const highRiskStory = () =>
  story({
    priority: 'high',
    riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
  });

check('(d) degraded fallback: storyFilesHash match => valid with advisory', () => {
  const probe = hostAvailabilityProbe(MATERIAL_Y, STORY_FILES_S, ['codex']);
  const report = evaluate({
    storyId: STORY_ID,
    story: highRiskStory(),
    changedFiles: [HIGH_RISK_FILE],
    // single-host rounds drifted in material but matching S (downgraded+accepted)
    // plus an explicit fallback recorded at X with S.
    processEvents: [
      ...singleHostRounds(MATERIAL_X, STORY_FILES_S),
      probe,
      fallback(MATERIAL_X, STORY_FILES_S, { hostAvailabilityProbeId: probe.probeId }),
    ],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S,
  });
  assert.equal(report.degradedFallback.requiredRounds, REVIEW_ASSURANCE_FLOOR_HIGH_RISK_REQUIRED_ROUNDS);
  const record = report.degradedFallback.record;
  assert.ok(record, 'fallback record must be present');
  assert.equal(record?.valid, true, 'fallback record must be valid under storyFilesHash match');
  assert.ok(
    !(record?.reasons ?? []).some(r => /materialHash is stale/.test(r)),
    'fallback must not report materialHash stale when storyFilesHash matches',
  );
  assert.ok(report.advisories, 'report.advisories must be present');
  assert.match((report.advisories ?? []).join('\n'), /storyFilesHash matches/);
  assert.equal(report.degradedFallback.ok, true, 'degraded fallback path must accept');
  assert.equal(report.ok, true, 'high-risk floor must accept via degraded fallback');
});

check('(d) degraded fallback: real story-file change => materialHash is stale', () => {
  const probe = hostAvailabilityProbe(MATERIAL_Y, STORY_FILES_S2, ['codex']);
  const report = evaluate({
    storyId: STORY_ID,
    story: highRiskStory(),
    changedFiles: [HIGH_RISK_FILE],
    processEvents: [
      ...singleHostRounds(MATERIAL_X, STORY_FILES_S),
      probe,
      fallback(MATERIAL_X, STORY_FILES_S, { hostAvailabilityProbeId: probe.probeId }),
    ],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S2,
  });
  const record = report.degradedFallback.record;
  assert.ok(record, 'fallback record must be present');
  assert.equal(record?.valid, false, 'fallback record must be invalid for a real story-file change');
  assert.ok(
    (record?.reasons ?? []).some(r => /materialHash is stale/.test(r)),
    'fallback must report materialHash is stale for a real story-file change',
  );
  assert.equal(report.degradedFallback.ok, false, 'degraded fallback must not accept');
  assert.equal(report.ok, false, 'high-risk floor must reject a real story-file change');
});

// Sanity baseline: no drift at all (materialHash=X, storyFilesHash=S) accepts
// with NO advisory, proving the advisory only fires on accepted drift.
check('baseline: no drift => valid, no re-attestation advisory', () => {
  const report = evaluate({
    storyId: STORY_ID,
    processEvents: [verdict('round-1', 'codex-a', MATERIAL_X, STORY_FILES_S)],
    materialHash: MATERIAL_X,
    storyFilesHash: STORY_FILES_S,
  });
  assert.equal(report.ok, true);
  assert.ok(report.localRounds.validRounds.length >= 1);
  assert.doesNotMatch((report.advisories ?? []).join('\n'), /storyFilesHash matches/);
});

// ---------------------------------------------------------------------------
// Fine-grained verificationIntent coverage (test-coverage lane audit).
// ---------------------------------------------------------------------------

// CHK-001:happy:1 — two verdicts in DIFFERENT runIds, both stale-material X +
// matching storyFilesHash S => both rounds downgraded and counted valid.
check('(1) two different-runId drifted rounds both downgraded valid', () => {
  const report = evaluate({
    storyId: STORY_ID,
    processEvents: [
      verdict('round-1', 'codex-a', MATERIAL_X, STORY_FILES_S),
      verdict('round-2', 'codex-b', MATERIAL_X, STORY_FILES_S),
    ],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S,
  });
  assert.equal(report.ok, true);
  assert.ok(
    report.localRounds.validRounds.length >= 2,
    `expected >=2 valid rounds, got ${report.localRounds.validRounds.length}`,
  );
});

// CHK-001:edge:0 — legacy verdict WITHOUT storyFilesHash + material stale =>
// never downgraded, stays ignored, found 0.
check('(2) legacy verdict (no storyFilesHash) is never downgraded', () => {
  const report = evaluate({
    storyId: STORY_ID,
    processEvents: [verdict('round-1', 'codex-a', MATERIAL_X, undefined)],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S,
  });
  assert.equal(report.localRounds.validRounds.length, 0);
  assert.equal(report.ok, false);
});

// CHK-001:edge:1 — current storyFilesHash null (arg omitted) + material drifted
// => effectiveEvents===rawEvents, no downgrade, stale, found 0, no crash.
check('(3) null current storyFilesHash => no downgrade, stale, no crash', () => {
  let report!: ReturnType<typeof evaluate>;
  assert.doesNotThrow(() => {
    report = evaluate({
      storyId: STORY_ID,
      processEvents: [verdict('round-1', 'codex-a', MATERIAL_X, STORY_FILES_S)],
      materialHash: MATERIAL_Y,
      // storyFilesHash intentionally omitted (undefined) -> resolves to null
    });
  });
  assert.equal(report.localRounds.validRounds.length, 0);
  assert.equal(report.ok, false);
});

// CHK-002:edge:0 — three eras, SAME identity, DIFFERENT runIds: truly-stale (W),
// downgraded (X->Y), current (Y). 2 valid rounds, truly-stale ignored, no
// duplicate-identity reason.
check('(4) three eras same identity diff runIds => 2 valid, no dup-identity', () => {
  const report = evaluate({
    storyId: STORY_ID,
    processEvents: [
      verdict('round-1', 'codex-a', MATERIAL_W, STORY_FILES_S_OLD), // truly stale
      verdict('round-2', 'codex-a', MATERIAL_X, STORY_FILES_S), // downgraded
      verdict('round-3', 'codex-a', MATERIAL_Y, STORY_FILES_S), // current
    ],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S,
  });
  assert.equal(report.localRounds.validRounds.length, 2);
  const allRoundReasons = [
    ...report.localRounds.validRounds.flatMap(r => r.reasons),
    ...report.localRounds.invalidRounds.flatMap(r => r.reasons),
  ].join('\n');
  assert.doesNotMatch(allRoundReasons, /duplicate host\/session\/key identity/);
});

// CHK-002:adversarial:0 — TWO truly-stale verdicts, SAME identity, SAME runId:
// both ignored before the identity check, no duplicate-identity-invalid round.
check('(5) two truly-stale dup-identity verdicts => ignored, no dup-identity', () => {
  const report = evaluate({
    storyId: STORY_ID,
    processEvents: [
      verdict('round-1', 'codex-a', MATERIAL_W, STORY_FILES_S_OLD),
      verdict('round-1', 'codex-a', MATERIAL_W, STORY_FILES_S_OLD),
    ],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S,
  });
  const allRoundReasons = [
    ...report.localRounds.validRounds.flatMap(r => r.reasons),
    ...report.localRounds.invalidRounds.flatMap(r => r.reasons),
  ].join('\n');
  assert.doesNotMatch(allRoundReasons, /duplicate host\/session\/key identity/);
  assert.equal(report.localRounds.validRounds.length, 0);
});

// CHK-003:edge:0 — multiple downgraded verdicts => one advisory per downgraded
// verdict (NOT deduplicated), so each is individually auditable.
check('(6) one advisory per downgraded verdict (not deduplicated)', () => {
  const report = evaluate({
    storyId: STORY_ID,
    processEvents: [
      verdict('round-1', 'codex-a', MATERIAL_X, STORY_FILES_S),
      verdict('round-2', 'codex-b', MATERIAL_X, STORY_FILES_S),
    ],
    materialHash: MATERIAL_Y,
    storyFilesHash: STORY_FILES_S,
  });
  const matching = (report.advisories ?? []).filter(a => /storyFilesHash matches/.test(a));
  assert.equal(matching.length, 2, `expected 2 per-verdict advisories, got ${matching.length}`);
});

console.log(`\nreview-assurance-floor storyFilesHash smoke passed (${passed} checks)`);
