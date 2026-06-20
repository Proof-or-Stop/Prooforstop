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

// ── 1. constants ──────────────────────────────────────────────────────────────
check(
  "COMPLETENESS_CRITIC_DESC_TAG === '[completeness-critic]'",
  COMPLETENESS_CRITIC_DESC_TAG === '[completeness-critic]',
);
check(
  "CRITIC_PROVENANCE_RECOMMENDED_LANES deep-equals ['lattice-review-quality','lattice-review-behavior']",
  CRITIC_PROVENANCE_RECOMMENDED_LANES.length === 2
    && CRITIC_PROVENANCE_RECOMMENDED_LANES[0] === 'lattice-review-quality'
    && CRITIC_PROVENANCE_RECOMMENDED_LANES[1] === 'lattice-review-behavior',
);
check(
  'every recommended lane is in REVIEW_RUN_LANES',
  CRITIC_PROVENANCE_RECOMMENDED_LANES.every((lane) => (REVIEW_RUN_LANES as readonly string[]).includes(lane)),
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
const base = toFindingAddArgs(majorFinding, { reviewRunId: 'RR-1', agent: 'lattice-review-quality', category: 'missing' });
const critic = toCriticFindingAddArgs(majorFinding, { reviewRunId: 'RR-1', agent: 'lattice-review-quality', category: 'missing' });

check("critic.desc === '[completeness-critic] ' + base.desc", critic.desc === '[completeness-critic] ' + base.desc);
check("critic.desc starts with '[completeness-critic] '", critic.desc.startsWith('[completeness-critic] '));
check("critic.severity === 'high' (mapped, NOT 'MAJOR')", critic.severity === 'high');
check('critic.severity is a ledger kind', LEDGER_KINDS.includes(critic.severity));
check('critic.severity is NOT an abstract severity', !ABSTRACT_SEVERITIES.includes(critic.severity as string));
check("critic.agent === 'lattice-review-quality' (a real lane, NOT 'completeness-critic')", critic.agent === 'lattice-review-quality');
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

const criticBlocker = toCriticFindingAddArgs(blockerFinding, { reviewRunId: 'RR-2', agent: 'lattice-review-quality', category: 'adversarial' });
check("BLOCKER -> critic.severity === 'critical'", criticBlocker.severity === 'critical');
check('BLOCKER critic.severity is a ledger kind', LEDGER_KINDS.includes(criticBlocker.severity));
check('BLOCKER critic.severity is NOT abstract', !ABSTRACT_SEVERITIES.includes(criticBlocker.severity as string));

const criticMinor = toCriticFindingAddArgs(minorFinding, { reviewRunId: 'RR-3', agent: 'lattice-review-quality', category: 'edge' });
check("MINOR -> critic.severity === 'medium'", criticMinor.severity === 'medium');
check('MINOR critic.severity is a ledger kind', LEDGER_KINDS.includes(criticMinor.severity));
check('MINOR critic.severity is NOT abstract', !ABSTRACT_SEVERITIES.includes(criticMinor.severity as string));

// ── 6. second recommended lane ───────────────────────────────────────────────
const criticBehavior = toCriticFindingAddArgs(majorFinding, { reviewRunId: 'RR-4', agent: 'lattice-review-behavior', category: 'missing' });
check("toCriticFindingAddArgs(agent='lattice-review-behavior').agent === 'lattice-review-behavior'", criticBehavior.agent === 'lattice-review-behavior');
check("criticBehavior.desc starts with '[completeness-critic] '", criticBehavior.desc.startsWith('[completeness-critic] '));

console.log('adversarial-review-critic smoke passed: ' + passed + ' assertions');
