/**
 * Smoke: adversarial-review S3 completeness-critic role (B-9d38).
 *
 * Hermetic — no FS/git/store. Proves the §2.4 critic seam is a pure
 * pass-through over the VERIFIED set (input is exactly {change,
 * confirmedFindings}; output is the planted Finding[] unchanged, same refs),
 * the §4.3 provenance rule (the [completeness-critic] tag lives in --desc, the
 * --agent stays a REAL review lane), and that the severity NEVER leaks an
 * abstract BLOCKER/MAJOR/MINOR (S2 owns the ledger mapping). All expectations
 * are pinned to EXPLICIT literals declared IN THIS SMOKE.
 *
 * Run: node packages/main/dist/tasks/adversarial-review-critic-smoke.js
 */

import {
  runCompletenessCritic,
  runCompletenessCriticOn,
  toCriticFindingAddArgs,
  COMPLETENESS_CRITIC_DESC_TAG,
  CRITIC_PROVENANCE_RECOMMENDED_LANES,
} from '../core/adversarial-review-critic.js';
import { type Finding, type CompletenessCriticInput } from '../core/adversarial-review.js';
import { toFindingAddArgs } from '../core/adversarial-review-verifier.js';
import { REVIEW_RUN_LANES } from '../core/review-run.js';
import { canonicalAgentRoleId } from '../core/agent-role-identity.js';
import type { ReviewRunLane } from '../core/review-run.js';

let passed = 0;
const check = (name: string, cond: boolean): void => {
  if (!cond) {
    console.error('FAIL: ' + name);
    process.exit(1);
  }
  passed++;
};

// Explicit expected ground truth — declared independently of the module.
const LEDGER_KINDS = ['critical', 'high', 'medium', 'low'];
const ABSTRACT_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'];
const QUALITY_LANE = 'proof-or-stop-review-quality' as ReviewRunLane;
const BEHAVIOR_LANE = 'proof-or-stop-review-behavior' as ReviewRunLane;
const canonicalLanes = new Set((REVIEW_RUN_LANES as readonly string[]).map(canonicalAgentRoleId));
const canonicalRecommendedLanes = CRITIC_PROVENANCE_RECOMMENDED_LANES.map(canonicalAgentRoleId);

// ── 1. constants ──────────────────────────────────────────────────────────────
check(
  "COMPLETENESS_CRITIC_DESC_TAG === '[completeness-critic]'",
  COMPLETENESS_CRITIC_DESC_TAG === '[completeness-critic]',
);
check(
  "CRITIC_PROVENANCE_RECOMMENDED_LANES deep-equals ['proof-or-stop-review-quality','proof-or-stop-review-behavior']",
  CRITIC_PROVENANCE_RECOMMENDED_LANES.length === 2
    && canonicalRecommendedLanes[0] === 'proof-or-stop-review-quality'
    && canonicalRecommendedLanes[1] === 'proof-or-stop-review-behavior',
);
check(
  'every recommended lane is in REVIEW_RUN_LANES',
  canonicalRecommendedLanes.every((lane) => canonicalLanes.has(lane)),
);

// ── 2. seam pass-through + input shape ───────────────────────────────────────
const cf: Finding = { severity: 'MAJOR', title: 'cf', file: 'cf.ts', line: 1, issue: 'i', fix: 'x' };
const pf1: Finding = { severity: 'BLOCKER', title: 'missed crash path', file: 'm.ts', line: 5, issue: 'no fsync', fix: 'fsync' };
const pf2: Finding = { severity: 'MINOR', title: 'missed log', file: 'm2.ts', line: 9, issue: 'silent', fix: 'log it' };

const captured: CompletenessCriticInput[] = [];
const fake = (input: CompletenessCriticInput): Finding[] => {
  captured.push(input);
  return [pf1, pf2];
};

const out = runCompletenessCritic({ change: 'CHG', confirmedFindings: [cf] }, fake);
check('runCompletenessCritic returns EXACTLY [pf1, pf2] (same refs)', out.length === 2 && out[0] === pf1 && out[1] === pf2);
check('seam called exactly once (capture length === 1)', captured.length === 1);
check(
  "captured input Object.keys === ['change','confirmedFindings'] (sorted)",
  Object.keys(captured[0]).sort().join(',') === 'change,confirmedFindings',
);
check("captured input.change === 'CHG'", captured[0].change === 'CHG');

// The seam got the CONFIRMED set itself, nothing else (reference identity).
const confirmedArr = [cf];
const out2 = runCompletenessCritic({ change: 'CHG', confirmedFindings: confirmedArr }, (input) => {
  captured.push(input);
  return [pf1, pf2];
});
check('runCompletenessCritic (ref-identity case) returns [pf1, pf2]', out2.length === 2 && out2[0] === pf1 && out2[1] === pf2);
check('seam received the passed confirmedFindings array by reference', captured[captured.length - 1].confirmedFindings === confirmedArr);

// An EMPTY confirmedFindings still calls the critic and returns its output.
const beforeEmpty = captured.length;
const outEmpty = runCompletenessCritic({ change: 'EMPTY', confirmedFindings: [] }, fake);
check('EMPTY confirmedFindings still calls the critic (capture increments)', captured.length === beforeEmpty + 1);
check('EMPTY confirmedFindings: critic output returned [pf1, pf2]', outEmpty.length === 2 && outEmpty[0] === pf1 && outEmpty[1] === pf2);
check('EMPTY confirmedFindings: captured.confirmedFindings is []', captured[captured.length - 1].confirmedFindings.length === 0);

// ── 3. runCompletenessCriticOn convenience ───────────────────────────────────
const beforeOn = captured.length;
const onArr = [cf];
const outOn = runCompletenessCriticOn('CHG2', onArr, fake);
check('runCompletenessCriticOn returns [pf1, pf2]', outOn.length === 2 && outOn[0] === pf1 && outOn[1] === pf2);
check('runCompletenessCriticOn forwarded to the seam (capture increments)', captured.length === beforeOn + 1);
check("runCompletenessCriticOn forwarded change === 'CHG2'", captured[captured.length - 1].change === 'CHG2');
check('runCompletenessCriticOn forwarded confirmedFindings by reference', captured[captured.length - 1].confirmedFindings === onArr);
check(
  "runCompletenessCriticOn forwarded input keys === ['change','confirmedFindings']",
  Object.keys(captured[captured.length - 1]).sort().join(',') === 'change,confirmedFindings',
);

// ── 4. toCriticFindingAddArgs provenance ─────────────────────────────────────
const majorFinding: Finding = {
  severity: 'MAJOR',
  title: 'Off-by-one',
  file: 'a.ts',
  line: 12,
  issue: 'loop skips last',
  fix: 'use <=',
};
const base = toFindingAddArgs(majorFinding, { reviewRunId: 'RR-1', agent: QUALITY_LANE, category: 'missing' });
const critic = toCriticFindingAddArgs(majorFinding, { reviewRunId: 'RR-1', agent: QUALITY_LANE, category: 'missing' });

check("critic.desc === '[completeness-critic] ' + base.desc", critic.desc === '[completeness-critic] ' + base.desc);
check("critic.desc starts with '[completeness-critic] '", critic.desc.startsWith('[completeness-critic] '));
check("critic.severity === 'high' (mapped, NOT 'MAJOR')", critic.severity === 'high');
check('critic.severity is a ledger kind', LEDGER_KINDS.includes(critic.severity));
check('critic.severity is NOT an abstract severity', !ABSTRACT_SEVERITIES.includes(critic.severity as string));
check("critic.agent === 'proof-or-stop-review-quality' (a real lane, NOT 'completeness-critic')", critic.agent === 'proof-or-stop-review-quality');
check('critic.files === base.files', critic.files.length === base.files.length && critic.files[0] === base.files[0]);
check('critic.category === base.category', critic.category === base.category);
check('critic.reviewRunId === base.reviewRunId', critic.reviewRunId === base.reviewRunId);

// The whole object minus desc equals base (every key except desc identical).
check(
  'critic minus desc deep-equals base minus desc (severity/files/category/reviewRunId/agent each === base)',
  critic.severity === base.severity
    && JSON.stringify(critic.files) === JSON.stringify(base.files)
    && critic.category === base.category
    && critic.reviewRunId === base.reviewRunId
    && critic.agent === base.agent,
);
check(
  'critic has EXACTLY keys {severity,desc,files,category,reviewRunId,agent}',
  Object.keys(critic).sort().join(',') === 'agent,category,desc,files,reviewRunId,severity',
);

// ── 5. no-abstract-leak across severities ────────────────────────────────────
const blockerFinding: Finding = { severity: 'BLOCKER', title: 'Unchecked write', file: 'b.ts', line: 7, issue: 'data loss', fix: 'fsync' };
const minorFinding: Finding = { severity: 'MINOR', title: 'Typo', file: 'c.ts', line: 3, issue: 'recieve', fix: 'receive' };

const criticBlocker = toCriticFindingAddArgs(blockerFinding, { reviewRunId: 'RR-2', agent: QUALITY_LANE, category: 'adversarial' });
check("BLOCKER -> critic.severity === 'critical'", criticBlocker.severity === 'critical');
check('BLOCKER critic.severity is a ledger kind', LEDGER_KINDS.includes(criticBlocker.severity));
check('BLOCKER critic.severity is NOT abstract', !ABSTRACT_SEVERITIES.includes(criticBlocker.severity as string));

const criticMinor = toCriticFindingAddArgs(minorFinding, { reviewRunId: 'RR-3', agent: QUALITY_LANE, category: 'edge' });
check("MINOR -> critic.severity === 'medium'", criticMinor.severity === 'medium');
check('MINOR critic.severity is a ledger kind', LEDGER_KINDS.includes(criticMinor.severity));
check('MINOR critic.severity is NOT abstract', !ABSTRACT_SEVERITIES.includes(criticMinor.severity as string));

// ── 6. second recommended lane ───────────────────────────────────────────────
const criticBehavior = toCriticFindingAddArgs(majorFinding, { reviewRunId: 'RR-4', agent: BEHAVIOR_LANE, category: 'missing' });
check("toCriticFindingAddArgs(agent='proof-or-stop-review-behavior').agent === 'proof-or-stop-review-behavior'", criticBehavior.agent === 'proof-or-stop-review-behavior');
check("criticBehavior.desc starts with '[completeness-critic] '", criticBehavior.desc.startsWith('[completeness-critic] '));

// ── 7. CHK-001 seam: large array, by-reference, verbatim output ───────────────
// CHK-001:edge:1 — a 100-element Finding[] is returned with same refs, in order.
const bigPlanted: Finding[] = Array.from({ length: 100 }, (_v, i): Finding => ({
  severity: 'MINOR',
  title: 'big-' + i,
  file: 'big' + i + '.ts',
  line: i,
  issue: 'issue-' + i,
  fix: 'fix-' + i,
}));
const fakeBig = (_input: CompletenessCriticInput): Finding[] => bigPlanted;
const outBig = runCompletenessCritic({ change: 'L', confirmedFindings: [] }, fakeBig);
check('CHK-001:edge:1 — large output length === 100', outBig.length === 100);
check('CHK-001:edge:1 — out[0] === first planted (same ref)', outBig[0] === bigPlanted[0]);
check('CHK-001:edge:1 — out[99] === last planted (same ref)', outBig[99] === bigPlanted[99]);

// CHK-001:adversarial:1 — input forwarded by reference (no defensive clone/reshape).
const inObj: CompletenessCriticInput = { change: 'R', confirmedFindings: [cf] };
let capturedRef: CompletenessCriticInput | null = null;
const fakeRef = (input: CompletenessCriticInput): Finding[] => {
  capturedRef = input;
  return [];
};
runCompletenessCritic(inObj, fakeRef);
check('CHK-001:adversarial:1 — seam received the EXACT input object (capturedRef === inObj)', capturedRef === inObj);

const beforeMut = inObj.confirmedFindings.length;
const fakeMutate = (input: CompletenessCriticInput): Finding[] => {
  input.confirmedFindings.push(pf1);
  return [];
};
runCompletenessCritic(inObj, fakeMutate);
check(
  "CHK-001:adversarial:1 — mutating input.confirmedFindings is reflected on caller's array (pure pass-through, no clone)",
  inObj.confirmedFindings.length === beforeMut + 1,
);

// CHK-001:adversarial:2 — output returned verbatim, incl. unexpected-shaped findings.
const extraFinding = { severity: 'MINOR', title: 'x', file: 'x.ts', line: 1, issue: 'i', fix: 'f', UNEXPECTED: 'survives' } as unknown as Finding;
const unexpectedArr: Finding[] = [extraFinding];
const fakeUnexpected = (_input: CompletenessCriticInput): Finding[] => unexpectedArr;
const outUnexpected = runCompletenessCritic({ change: 'U', confirmedFindings: [] }, fakeUnexpected);
check('CHK-001:adversarial:2 — output array returned by reference (same array)', outUnexpected === unexpectedArr);
check('CHK-001:adversarial:2 — extra-property finding survives by reference', outUnexpected[0] === extraFinding);
check(
  "CHK-001:adversarial:2 — extra property still present (seam output unfiltered)",
  (outUnexpected[0] as unknown as { UNEXPECTED: string }).UNEXPECTED === 'survives',
);

// ── 8. CHK-002 desc tag is provenance-only, never a lane ──────────────────────
// CHK-002:edge:1 — the tag is NOT a lane prefix.
check(
  "CHK-002:edge:1 — desc tag does not start with 'proof-or-stop-review-'",
  !COMPLETENESS_CRITIC_DESC_TAG.startsWith('proof-or-stop-review-'),
);
// CHK-002:adversarial:0 — the tag is not a real reviewer lane.
check(
  'CHK-002:adversarial:0 — desc tag is NOT in REVIEW_RUN_LANES',
  !(REVIEW_RUN_LANES as readonly string[]).includes(COMPLETENESS_CRITIC_DESC_TAG),
);
check(
  "REVIEW_RUN_LANES does NOT include the bare 'completeness-critic' (§4.3 — provenance can never be an agent/lane)",
  !(REVIEW_RUN_LANES as readonly string[]).includes('completeness-critic'),
);
check(
  "REVIEW_RUN_LANES does NOT include 'proof-or-stop-review-completeness' (FUTURE — no dedicated critic lane today)",
  !canonicalLanes.has('proof-or-stop-review-completeness'),
);
// CHK-002:adversarial:1 — recommended lanes exclude completeness-critic; both are real lanes.
check(
  "CHK-002:adversarial:1 — recommended lanes do NOT include 'completeness-critic'",
  !(CRITIC_PROVENANCE_RECOMMENDED_LANES as readonly string[]).includes('completeness-critic'),
);
check(
  "CHK-002:adversarial:1 — both recommended lanes start with 'proof-or-stop-review-'",
  canonicalRecommendedLanes.every((lane) => lane.startsWith('proof-or-stop-review-')),
);

// ── 9. CHK-003 desc tag prefix is transparent + always distinct ───────────────
// CHK-003:edge:1 — special chars pass through verbatim under the tag prefix.
const specialFinding: Finding = { severity: 'MINOR', title: 'A "q" & <t>', file: 'x.ts', line: 9, issue: 'has — dash, %', fix: 'do `that`' };
const specialBase = toFindingAddArgs(specialFinding, { reviewRunId: 'R', agent: QUALITY_LANE, category: 'happy' });
const specialCritic = toCriticFindingAddArgs(specialFinding, { reviewRunId: 'R', agent: QUALITY_LANE, category: 'happy' });
check(
  "CHK-003:edge:1 — special-char desc === '[completeness-critic] ' + base.desc (verbatim through prefix)",
  specialCritic.desc === '[completeness-critic] ' + specialBase.desc,
);
// CHK-003:adversarial:1 — desc is never the bare composeDesc (prefix always present).
check('CHK-003:adversarial:1 — critic.desc !== base.desc (tag prefix always present)', critic.desc !== base.desc);

console.log('adversarial-review-critic smoke passed: ' + passed + ' assertions');
