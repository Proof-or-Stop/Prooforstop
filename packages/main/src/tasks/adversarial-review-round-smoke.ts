/**
 * Smoke: adversarial-review S4 escalation-flow round (B-1127).
 *
 * Hermetic — no FS/git/store/CLI. Proves the S4 capstone composes S1+S2+S3 into
 * the ONE frozen 5-phase canonical round (REVIEW_MODE_PHASES order); that the
 * completeness critic always sees the VERIFIED (confirmed) lens set, never the
 * raw set; the converge/reopen + loop-until-dry + maxRounds bound semantics; the
 * no-abstract-leak ledger-op derivation (lens under a real lane, critic
 * desc-tagged, severity a ledger kind not BLOCKER/MAJOR/MINOR, a PASS per
 * PARTICIPATING/ran lane on a clean converge, hard error on a missing run id);
 * and the §4.1 full-3x2 host-verdict payload shape. All expectations
 * are pinned to EXPLICIT literals declared IN THIS SMOKE, against FAKE seams.
 *
 * Run: node packages/main/dist/tasks/adversarial-review-round-smoke.js
 */

import {
  runAdversarialRound,
  deriveRoundLedgerOps,
  runReopenLoop,
  buildHostVerdictPayloads,
  type RoundSeams,
  type AdversarialRoundResult,
} from '../core/adversarial-review-round.js';
import {
  REVIEW_MODE_PHASES,
  type Finding,
  type Verdict,
  type CompletenessCriticInput,
  CANONICAL_LENS_SET,
} from '../core/adversarial-review.js';

let passed = 0;
const check = (name: string, cond: boolean): void => {
  if (!cond) {
    console.error('FAIL: ' + name);
    process.exit(1);
  }
  passed++;
};

// Explicit expected ground truth — declared independently of the modules.
const LEDGER_KINDS = ['critical', 'high', 'medium', 'low'];
const ABSTRACT_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'];

// Verdict factories.
const CONFIRM: Verdict = { isReal: true, agreedSeverity: 'MAJOR', reasoning: 'confirmed against code' };
const REFUTE: Verdict = { isReal: false, agreedSeverity: 'NOT_A_DEFECT', reasoning: 'no defect in code' };

// ── 1. REVIEW_MODE_PHASES order (frozen) ──────────────────────────────────────
const EXPECTED_PHASES = ['lenses', 'verify-lens-findings', 'critic', 'verify-critic-findings', 'converge-or-reopen'];
check(
  "REVIEW_MODE_PHASES deep-equals ['lenses','verify-lens-findings','critic','verify-critic-findings','converge-or-reopen']",
  REVIEW_MODE_PHASES.length === EXPECTED_PHASES.length
    && REVIEW_MODE_PHASES.every((p, i) => p === EXPECTED_PHASES[i]),
);

// ── 2. clean round → converged ────────────────────────────────────────────────
const cleanSeams: RoundSeams = {
  runLens: () => [],
  runSkeptic: () => REFUTE,
  runCritic: () => [],
};
const cleanRound = runAdversarialRound('CHG-clean', cleanSeams);
check('clean round: converged === true', cleanRound.converged === true);
check('clean round: reopen === false', cleanRound.reopen === false);
check('clean round: confirmedFindings.length === 0', cleanRound.confirmedFindings.length === 0);
check('clean round: criticFindings.length === 0', cleanRound.criticFindings.length === 0);
check('clean round: confirmedByLane.length === 0', cleanRound.confirmedByLane.length === 0);

// ── 3. critic input is the VERIFIED set (post lens verification) ──────────────
// Plant a finding on TWO lenses, but the skeptic confirms only the concept/scope
// one; assert the critic saw EXACTLY the 1 confirmed lens finding, proving it ran
// on the verified set, not the raw (2-finding) set.
const conceptFinding: Finding = { severity: 'MAJOR', title: 'scope drift', file: 'concept.ts', line: 3, issue: 'out of scope', fix: 'remove' };
const qualityFinding: Finding = { severity: 'MINOR', title: 'style', file: 'quality.ts', line: 7, issue: 'naming', fix: 'rename' };

const verifiedSeams_captured: CompletenessCriticInput[] = [];
const verifiedSeams: RoundSeams = {
  runLens: (req) => {
    if (req.lensId === 'concept/scope') return [conceptFinding];
    if (req.lensId === 'code-quality') return [qualityFinding];
    return [];
  },
  // Confirm only the concept finding; refute everything else (incl. quality).
  runSkeptic: (finding) => (finding === conceptFinding ? CONFIRM : REFUTE),
  runCritic: (input) => {
    verifiedSeams_captured.push(input);
    return [];
  },
};
const verifiedRound = runAdversarialRound('CHG-verified', verifiedSeams);
check('verified-set: critic invoked exactly once', verifiedSeams_captured.length === 1);
check('verified-set: lensFindings (raw) has 2 (both planted)', verifiedRound.lensFindings.length === 2);
check('verified-set: confirmedFindings has 1 (only concept confirmed)', verifiedRound.confirmedFindings.length === 1);
check('verified-set: critic.input.confirmedFindings.length === 1 (VERIFIED set, not raw 2)', verifiedSeams_captured[0].confirmedFindings.length === 1);
check('verified-set: critic saw the confirmed concept finding (same ref)', verifiedSeams_captured[0].confirmedFindings[0] === conceptFinding);
check('verified-set: critic did NOT see the refuted quality finding', !verifiedSeams_captured[0].confirmedFindings.includes(qualityFinding));
check("verified-set: critic.input.change === 'CHG-verified'", verifiedSeams_captured[0].change === 'CHG-verified');
check('verified-set: confirmedByLane has 1 group (concept lane)', verifiedRound.confirmedByLane.length === 1);
check("verified-set: confirmedByLane[0].lane === 'lattice-review-concept'", verifiedRound.confirmedByLane[0].lane === 'lattice-review-concept');
check("verified-set: confirmedByLane[0].lensId === 'concept/scope'", verifiedRound.confirmedByLane[0].lensId === 'concept/scope');
// The round itself reopens (confirmed lens findings present).
check('verified-set: round reopens (confirmed lens findings)', verifiedRound.reopen === true && verifiedRound.converged === false);

// ── 4. critic confirms → reopen ───────────────────────────────────────────────
const missedFinding: Finding = { severity: 'BLOCKER', title: 'missed crash path', file: 'm.ts', line: 5, issue: 'no fsync', fix: 'fsync' };
const criticReopenSeams: RoundSeams = {
  runLens: () => [],
  // Skeptic confirms the critic finding (so it survives verify-critic-findings).
  runSkeptic: () => CONFIRM,
  runCritic: () => [missedFinding],
};
const criticReopenRound = runAdversarialRound('CHG-critic', criticReopenSeams);
check('critic-confirms: reopen === true', criticReopenRound.reopen === true);
check('critic-confirms: converged === false', criticReopenRound.converged === false);
check('critic-confirms: criticFindings.length === 1', criticReopenRound.criticFindings.length === 1);
check('critic-confirms: criticFindings[0] === missedFinding', criticReopenRound.criticFindings[0] === missedFinding);
check('critic-confirms: no confirmed LENS findings', criticReopenRound.confirmedFindings.length === 0);
check('critic-confirms: confirmedByLane empty (critic-only)', criticReopenRound.confirmedByLane.length === 0);

// ── 5. runReopenLoop B-086b trace (critic confirms r0, clean r1) ──────────────
let loopRoundIndex = 0;
const tracedSeams: RoundSeams = {
  runLens: () => [],
  runSkeptic: () => CONFIRM,
  // Round 0 the critic confirms a finding; round >=1 it returns [] (applyFix fixed it).
  runCritic: () => (loopRoundIndex === 0 ? [missedFinding] : []),
};
const traceResult = runReopenLoop(
  'CHG-init',
  tracedSeams,
  (change, _confirmed, roundIndex) => {
    // applyFix advances the round-index marker and mutates the change (= new material).
    loopRoundIndex = roundIndex + 1;
    return change + '+fix' + roundIndex;
  },
);
check('reopen-loop: rounds.length === 2', traceResult.rounds.length === 2);
check('reopen-loop: rounds[0].converged === false', traceResult.rounds[0].converged === false);
check('reopen-loop: rounds[1].converged === true', traceResult.rounds[1].converged === true);
check('reopen-loop: result.converged === true', traceResult.converged === true);
check("reopen-loop: result.finalChange !== 'CHG-init' (applyFix changed material)", traceResult.finalChange !== 'CHG-init');
check("reopen-loop: result.finalChange === 'CHG-init+fix0'", traceResult.finalChange === 'CHG-init+fix0');

// ── 6. maxRounds bound (never fixed) ──────────────────────────────────────────
const neverCleanSeams: RoundSeams = {
  runLens: () => [],
  runSkeptic: () => CONFIRM,
  runCritic: () => [missedFinding],
};
const boundResult = runReopenLoop(
  'CHG-stuck',
  neverCleanSeams,
  (change) => change, // applyFix never fixes
  { maxRounds: 3 },
);
check('maxRounds: rounds.length === 3', boundResult.rounds.length === 3);
check('maxRounds: result.converged === false', boundResult.converged === false);
check('maxRounds: every round reopened', boundResult.rounds.every((r) => r.reopen === true));

// ── 7. deriveRoundLedgerOps (reopening round: lens + critic ops, no pass) ─────
// Build a round with one confirmed lens finding (concept lane) + one confirmed
// critic finding via a confirming fake.
const lensFinding: Finding = { severity: 'MAJOR', title: 'off-by-one', file: 'a.ts', line: 12, issue: 'skips last', fix: 'use <=' };
const ledgerSeams: RoundSeams = {
  runLens: (req) => (req.lensId === 'concept/scope' ? [lensFinding] : []),
  runSkeptic: () => CONFIRM,
  runCritic: () => [missedFinding],
};
const ledgerRound = runAdversarialRound('CHG-ledger', ledgerSeams);
check('ledger-round: did NOT converge', ledgerRound.converged === false);
check('ledger-round: 1 confirmed lens finding', ledgerRound.confirmedFindings.length === 1);
check('ledger-round: 1 confirmed critic finding', ledgerRound.criticFindings.length === 1);

const ops = deriveRoundLedgerOps(ledgerRound, {
  reviewRunIdByLane: { 'lattice-review-concept': 'RR-L' },
  criticLane: 'lattice-review-quality',
  criticReviewRunId: 'RR-C',
});
const lensOps = ops.filter((o) => o.kind === 'finding_add' && o.source === 'lens');
const criticOps = ops.filter((o) => o.kind === 'finding_add' && o.source === 'critic');
const passOps = ops.filter((o) => o.kind === 'review_pass_set');

check('ledger-ops: exactly 1 lens finding_add op', lensOps.length === 1);
check('ledger-ops: exactly 1 critic finding_add op', criticOps.length === 1);
check('ledger-ops: NO review_pass_set ops (round did NOT converge)', passOps.length === 0);

// Lens op: real lane agent + ledger severity (not abstract).
const lensOp = lensOps[0];
check("ledger-ops: lens op.lane === 'lattice-review-concept'", lensOp.kind === 'finding_add' && lensOp.lane === 'lattice-review-concept');
if (lensOp.kind === 'finding_add') {
  check("ledger-ops: lens op.args.agent === 'lattice-review-concept' (real lane)", lensOp.args.agent === 'lattice-review-concept');
  check("ledger-ops: lens op.args.reviewRunId === 'RR-L'", lensOp.args.reviewRunId === 'RR-L');
  check("ledger-ops: lens op.args.severity === 'high' (MAJOR mapped)", lensOp.args.severity === 'high');
  check('ledger-ops: lens op.args.severity is a ledger kind', LEDGER_KINDS.includes(lensOp.args.severity));
  check('ledger-ops: lens op.args.severity is NOT abstract', !ABSTRACT_SEVERITIES.includes(lensOp.args.severity as string));
  check("ledger-ops: lens op.args.category === 'adversarial' (default)", lensOp.args.category === 'adversarial');
}

// Critic op: real lane agent + desc-tagged + ledger severity.
const criticOp = criticOps[0];
if (criticOp.kind === 'finding_add') {
  check("ledger-ops: critic op.args.agent === 'lattice-review-quality' (real lane)", criticOp.args.agent === 'lattice-review-quality');
  check("ledger-ops: critic op.args.reviewRunId === 'RR-C'", criticOp.args.reviewRunId === 'RR-C');
  check("ledger-ops: critic op.args.desc starts with '[completeness-critic] '", criticOp.args.desc.startsWith('[completeness-critic] '));
  check("ledger-ops: critic op.args.severity === 'critical' (BLOCKER mapped)", criticOp.args.severity === 'critical');
  check('ledger-ops: critic op.args.severity is NOT abstract', !ABSTRACT_SEVERITIES.includes(criticOp.args.severity as string));
  check("ledger-ops: critic op.args.category === 'missing' (default)", criticOp.args.category === 'missing');
}

// ── 8. deriveRoundLedgerOps on a CLEAN converged round → a PASS per ran lane ──
// A clean converged round over CANONICAL_LENS_SET runs 5 UNIQUE lanes (two lenses
// share lattice-review-behavior). The spec (§4.1/§5) requires a review_pass_set
// for EVERY participating lane, NOT just lanes that surfaced a confirmed finding.
const cleanLedgerRound = runAdversarialRound('CHG-clean2', cleanSeams);
check('clean-ledger: round converged', cleanLedgerRound.converged === true);

const EXPECTED_RAN_LANES = [
  'lattice-review-concept',
  'lattice-review-quality',
  'lattice-review-behavior',
  'lattice-review-test-coverage',
  'lattice-review-docs',
];
check(
  'clean-ledger: ranLanes deep-equals [concept,quality,behavior,test-coverage,docs] (first-seen, deduped)',
  cleanLedgerRound.ranLanes.length === EXPECTED_RAN_LANES.length
    && cleanLedgerRound.ranLanes.every((l, i) => l === EXPECTED_RAN_LANES[i]),
);

const cleanRunIdByLane = {
  'lattice-review-concept': 'RR-c',
  'lattice-review-quality': 'RR-q',
  'lattice-review-behavior': 'RR-b',
  'lattice-review-test-coverage': 'RR-t',
  'lattice-review-docs': 'RR-d',
} as const;
const EXPECTED_PASS_RUN_IDS = ['RR-c', 'RR-q', 'RR-b', 'RR-t', 'RR-d'];

const cleanOps = deriveRoundLedgerOps(cleanLedgerRound, {
  reviewRunIdByLane: { ...cleanRunIdByLane },
  criticLane: 'lattice-review-docs',
  criticReviewRunId: 'RR-d',
});
const cleanPassOps = cleanOps.filter((o) => o.kind === 'review_pass_set');
check('clean-ledger: zero finding_add ops', cleanOps.filter((o) => o.kind === 'finding_add').length === 0);
check('clean-ledger: exactly 5 review_pass_set ops (one per ran lane)', cleanPassOps.length === 5);
check('clean-ledger: 5 ops total (all pass ops)', cleanOps.length === 5);
check(
  'clean-ledger: pass ops cover the ran lanes in order',
  cleanPassOps.every((o, i) => o.kind === 'review_pass_set' && o.lane === EXPECTED_RAN_LANES[i]),
);
check(
  'clean-ledger: each pass op carries its lane reviewRunId',
  cleanPassOps.every((o, i) => o.kind === 'review_pass_set' && o.reviewRunId === EXPECTED_PASS_RUN_IDS[i]),
);

// A converged round MISSING a ran lane's reviewRunId → hard error.
let missingRanThrew = false;
try {
  deriveRoundLedgerOps(cleanLedgerRound, {
    // omit lattice-review-docs run id
    reviewRunIdByLane: {
      'lattice-review-concept': 'RR-c',
      'lattice-review-quality': 'RR-q',
      'lattice-review-behavior': 'RR-b',
      'lattice-review-test-coverage': 'RR-t',
    },
    criticLane: 'lattice-review-docs',
    criticReviewRunId: 'RR-d',
  });
} catch {
  missingRanThrew = true;
}
check('clean-ledger: converged round missing a ran-lane run id throws', missingRanThrew === true);

// A round with a CONFIRMED lens finding whose lane has no run id → hard error.
const confirmedNoRunIdRound = runAdversarialRound('CHG-noid', ledgerSeams);
check('clean-ledger: precondition — confirmedNoRunIdRound has a confirmed lens finding', confirmedNoRunIdRound.confirmedFindings.length === 1);
let missingConfirmedThrew = false;
try {
  deriveRoundLedgerOps(confirmedNoRunIdRound, {
    reviewRunIdByLane: {}, // no run id for the confirmed concept lane
    criticLane: 'lattice-review-quality',
    criticReviewRunId: 'RR-C',
  });
} catch {
  missingConfirmedThrew = true;
}
check('clean-ledger: confirmed lens lane with no run id throws', missingConfirmedThrew === true);

// ── 9. buildHostVerdictPayloads (full-3x2 shape) ──────────────────────────────
const payloads = buildHostVerdictPayloads({
  storyId: 'B-1127',
  runId: 'RUN-1',
  materialDigest: 'MAT',
  validationDigest: 'VAL',
  hosts: [
    { hostId: 'claude-review-host', provider: 'anthropic', sessionId: 'claude-code-d1', keyId: 'claude-host-key', promptDigest: 'P-CLAUDE' },
    { hostId: 'codex-review-host', provider: 'openai', sessionId: 'codex-d1', keyId: 'codex-host-key', promptDigest: 'P-CODEX' },
  ],
});
check('payloads: 2 payloads', payloads.length === 2);
check('payloads: distinct hostId', payloads[0].hostId !== payloads[1].hostId);
check('payloads: distinct keyId', payloads[0].keyId !== payloads[1].keyId);
check('payloads: distinct sessionId', payloads[0].sessionId !== payloads[1].sessionId);
check('payloads: distinct promptDigest', payloads[0].promptDigest !== payloads[1].promptDigest);
check('payloads: both materialDigest === MAT', payloads[0].materialDigest === 'MAT' && payloads[1].materialDigest === 'MAT');
check('payloads: both validationDigest === VAL', payloads[0].validationDigest === 'VAL' && payloads[1].validationDigest === 'VAL');
check("payloads: both decision === 'pass' (default)", payloads[0].decision === 'pass' && payloads[1].decision === 'pass');
check("payloads: both storyId === 'B-1127'", payloads[0].storyId === 'B-1127' && payloads[1].storyId === 'B-1127');
check("payloads: both runId === 'RUN-1'", payloads[0].runId === 'RUN-1' && payloads[1].runId === 'RUN-1');
check("payloads: host[0] hostId === 'claude-review-host'", payloads[0].hostId === 'claude-review-host');
check("payloads: host[1] hostId === 'codex-review-host'", payloads[1].hostId === 'codex-review-host');

// Explicit decision override is honored.
const overridePayloads = buildHostVerdictPayloads({
  storyId: 'B-1127',
  runId: 'RUN-2',
  materialDigest: 'MAT',
  validationDigest: 'VAL',
  hosts: [{ hostId: 'h', provider: 'p', sessionId: 's', keyId: 'k', promptDigest: 'pd', decision: 'fail' }],
});
check("payloads: explicit decision 'fail' honored (not defaulted)", overridePayloads[0].decision === 'fail');

// ── 10. canonical lens set ran every lens (sanity: confirmedByLane lanes valid) ─
check('sanity: CANONICAL_LENS_SET has 6 lenses', CANONICAL_LENS_SET.length === 6);
// A round where every lens confirms a finding exercises all lanes; ensure the
// derived result type stays well-formed.
const allConfirmFinding: Finding = { severity: 'MAJOR', title: 't', file: 'f.ts', line: 1, issue: 'i', fix: 'x' };
const allSeams: RoundSeams = {
  runLens: () => [allConfirmFinding],
  runSkeptic: () => CONFIRM,
  runCritic: () => [],
};
const allRound: AdversarialRoundResult = runAdversarialRound('CHG-all', allSeams);
// 6 lenses but two map to the same lane (behavior); still 6 distinct lens results.
check('sanity: all-confirm round has 6 confirmedByLane groups', allRound.confirmedByLane.length === 6);
check('sanity: all-confirm round reopens', allRound.reopen === true);

console.log('adversarial-review-round smoke passed: ' + passed + ' assertions');
