/**
 * Smoke: adversarial-review S2 verifier + finding_add ledger mapping (B-2806).
 *
 * Hermetic — no FS/git/store. Proves the §4.2 ledger map (BLOCKER→critical,
 * MAJOR→high, MINOR→medium), the §4.2 composeDesc form (em dash " — "), the
 * pure toFindingAddArgs shaper with NO abstract-severity leak, the injected
 * `runSkeptic` seam called exactly M times, refute-by-default strictness
 * (isReal===true only), and threshold-confirm (NOT majority). All expectations
 * are pinned to EXPLICIT literals declared IN THIS SMOKE, so a contract drift
 * fails hermetically.
 *
 * Run: node packages/main/dist/tasks/adversarial-review-verifier-smoke.js
 */

import {
  SEVERITY_TO_FINDING_KIND,
  composeDesc,
  toFindingAddArgs,
  verifyFinding,
  verifyFindings,
  confirmedFindings,
  DEFAULT_SKEPTICS,
  DEFAULT_CONFIRM_THRESHOLD,
  type FindingAddSeverity,
} from '../core/adversarial-review-verifier.js';
import { FINDING_SEVERITIES, type Finding, type Verdict } from '../core/adversarial-review.js';

let passed = 0;
const check = (name: string, cond: boolean): void => {
  if (!cond) {
    console.error('FAIL: ' + name);
    process.exit(1);
  }
  passed++;
};

// Explicit expected ground truth — declared independently of the module.
const LEDGER_KINDS: FindingAddSeverity[] = ['critical', 'high', 'medium', 'low'];
const ABSTRACT_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'];

const blockerFinding: Finding = {
  severity: 'BLOCKER',
  title: 'Unchecked write',
  file: 'b.ts',
  line: 7,
  issue: 'data loss on crash',
  fix: 'fsync before ack',
};
const majorFinding: Finding = {
  severity: 'MAJOR',
  title: 'Off-by-one',
  file: 'a.ts',
  line: 12,
  issue: 'loop skips last element',
  fix: 'use <=',
};
const minorFinding: Finding = {
  severity: 'MINOR',
  title: 'Typo in log',
  file: 'c.ts',
  line: 3,
  issue: 'reads "recieve"',
  fix: 'spell "receive"',
};

// ── 1. ledger map ─────────────────────────────────────────────────────────────
check('SEVERITY_TO_FINDING_KIND.BLOCKER === critical', SEVERITY_TO_FINDING_KIND.BLOCKER === 'critical');
check('SEVERITY_TO_FINDING_KIND.MAJOR === high', SEVERITY_TO_FINDING_KIND.MAJOR === 'high');
check('SEVERITY_TO_FINDING_KIND.MINOR === medium', SEVERITY_TO_FINDING_KIND.MINOR === 'medium');
check(
  'every ledger map value is one of {critical,high,medium,low}',
  Object.values(SEVERITY_TO_FINDING_KIND).every((v) => LEDGER_KINDS.includes(v)),
);
check(
  'ledger map has EXACTLY the 3 abstract-severity keys (no extra key)',
  Object.keys(SEVERITY_TO_FINDING_KIND).sort().join(',') === 'BLOCKER,MAJOR,MINOR',
);
// CHK-001:edge:1 — keys are pinned to the S0 FINDING_SEVERITIES tuple, not just a hardcoded string.
check(
  'ledger map keys === FINDING_SEVERITIES (S0 tuple)',
  Object.keys(SEVERITY_TO_FINDING_KIND).sort().join(',') === [...FINDING_SEVERITIES].sort().join(','),
);
// CHK-001:adversarial:0 — indexing with a non-severity key yields undefined (no phantom mapping).
check(
  'ledger map invalid key NOPE -> undefined',
  (SEVERITY_TO_FINDING_KIND as Record<string, unknown>)['NOPE'] === undefined,
);
// CHK-001:adversarial:1 — the shared map is frozen (immutable at runtime).
check('ledger map is Object.frozen', Object.isFrozen(SEVERITY_TO_FINDING_KIND) === true);

// ── 2. composeDesc (exact literal incl. the em dash " — ") ────────────────────
const descFinding: Finding = {
  severity: 'MAJOR',
  title: 'Null deref',
  file: 'd.ts',
  line: 42,
  issue: 'x can be undefined',
  fix: 'guard x',
};
check(
  'composeDesc exact literal with em dash',
  composeDesc(descFinding) === 'Null deref — x can be undefined Fix: guard x (line 42)',
);
// CHK-002:edge:0 — special chars (quotes, &, <tag>, em dash, %, backslash-n, backticks) pass through verbatim.
const specialFinding: Finding = {
  severity: 'MINOR',
  title: 'A "quoted" & <tag>',
  file: 'x.ts',
  line: 9,
  issue: 'has — dash, % and \\n',
  fix: 'do `that`',
};
check(
  'composeDesc special chars pass through verbatim',
  composeDesc(specialFinding) === 'A "quoted" & <tag> — has — dash, % and \\n Fix: do `that` (line 9)',
);
// CHK-002:edge:2 — line=0 boundary is still cited, not dropped as falsy.
const line0Finding: Finding = {
  severity: 'MAJOR',
  title: 'Zeroth line',
  file: 'z.ts',
  line: 0,
  issue: 'header missing',
  fix: 'add header',
};
check('composeDesc line=0 still cited (ends with "(line 0)")', composeDesc(line0Finding).endsWith('(line 0)'));

// ── 3. toFindingAddArgs — shape + no-abstract-leak ───────────────────────────
const majorArgs = toFindingAddArgs(majorFinding, {
  reviewRunId: 'RR-1',
  agent: 'proof-or-stop-review-behavior',
  category: 'edge',
});
check('toFindingAddArgs(MAJOR).severity === high', majorArgs.severity === 'high');
check('toFindingAddArgs(MAJOR).desc === composeDesc(f)', majorArgs.desc === composeDesc(majorFinding));
check('toFindingAddArgs(MAJOR).files === [file]', majorArgs.files.length === 1 && majorArgs.files[0] === 'a.ts');
check('toFindingAddArgs(MAJOR).category === edge', majorArgs.category === 'edge');
check('toFindingAddArgs(MAJOR).reviewRunId === RR-1', majorArgs.reviewRunId === 'RR-1');
check('toFindingAddArgs(MAJOR).agent === proof-or-stop-review-behavior', majorArgs.agent === 'proof-or-stop-review-behavior');
check(
  'toFindingAddArgs(MAJOR) has EXACTLY keys {severity,desc,files,category,reviewRunId,agent}',
  Object.keys(majorArgs).sort().join(',') === 'agent,category,desc,files,reviewRunId,severity',
);
// no-abstract-leak for MAJOR
check('MAJOR args.severity is a ledger kind', LEDGER_KINDS.includes(majorArgs.severity));
check('MAJOR args.severity is NOT an abstract severity', !ABSTRACT_SEVERITIES.includes(majorArgs.severity as string));

// no-abstract-leak for BLOCKER -> critical
const blockerArgs = toFindingAddArgs(blockerFinding, {
  reviewRunId: 'RR-2',
  agent: 'proof-or-stop-review-concept',
  category: 'adversarial',
});
check('toFindingAddArgs(BLOCKER).severity === critical', blockerArgs.severity === 'critical');
check('BLOCKER args.severity is a ledger kind', LEDGER_KINDS.includes(blockerArgs.severity));
check('BLOCKER args.severity is NOT an abstract severity', !ABSTRACT_SEVERITIES.includes(blockerArgs.severity as string));

// no-abstract-leak for MINOR -> medium
const minorArgs = toFindingAddArgs(minorFinding, {
  reviewRunId: 'RR-3',
  agent: 'proof-or-stop-review-docs',
  category: 'missing',
});
check('toFindingAddArgs(MINOR).severity === medium', minorArgs.severity === 'medium');
check('MINOR args.severity is a ledger kind', LEDGER_KINDS.includes(minorArgs.severity));
check('MINOR args.severity is NOT an abstract severity', !ABSTRACT_SEVERITIES.includes(minorArgs.severity as string));

// CHK-002:edge:1 — a file with spaces / path separators is preserved verbatim as a single-element array.
const spacedFileFinding: Finding = {
  severity: 'MAJOR',
  title: 'Spaced path',
  file: 'src/a b/c.ts',
  line: 5,
  issue: 'path has a space',
  fix: 'keep verbatim',
};
const spacedArgs = toFindingAddArgs(spacedFileFinding, {
  reviewRunId: 'R',
  agent: 'proof-or-stop-review-quality',
  category: 'happy',
});
check(
  'toFindingAddArgs file with spaces/separators preserved verbatim',
  spacedArgs.files.length === 1 && spacedArgs.files[0] === 'src/a b/c.ts',
);
// CHK-002:adversarial:1 — toFindingAddArgs synchronously returns a fresh, deterministic plain
// FindingAddArgs object (idempotent, distinct ref, exact shape, non-Promise); the stronger
// 'never calls finding_add' property is structurally guaranteed by the module having no I/O
// imports and is best spied at the S4 boundary.
const pureOpts = { reviewRunId: 'RR-pure', agent: 'proof-or-stop-review-behavior', category: 'happy' as const };
const pureResultA = toFindingAddArgs(majorFinding, pureOpts);
const pureResultB = toFindingAddArgs(majorFinding, pureOpts);
const pureResult: unknown = pureResultA;
check(
  'toFindingAddArgs returns a plain (non-Promise) object synchronously',
  typeof pureResult === 'object' && pureResult !== null && !(pureResult instanceof Promise),
);
check(
  'toFindingAddArgs is idempotent (two calls, same inputs -> deep-equal output)',
  JSON.stringify(pureResultA) === JSON.stringify(pureResultB),
);
check(
  'toFindingAddArgs builds a fresh object each call (distinct ref, no shared mutable state)',
  pureResultA !== pureResultB,
);
check(
  'toFindingAddArgs result has EXACTLY keys {agent,category,desc,files,reviewRunId,severity}',
  Object.keys(pureResultA).sort().join(',') === 'agent,category,desc,files,reviewRunId,severity',
);

// ── 4. defaults ───────────────────────────────────────────────────────────────
check('DEFAULT_SKEPTICS === 2', DEFAULT_SKEPTICS === 2);
check('DEFAULT_CONFIRM_THRESHOLD === 1', DEFAULT_CONFIRM_THRESHOLD === 1);

// ── 5. threshold-confirm (NOT majority) ──────────────────────────────────────
// Fake giving `confirmsOf` isReal=true out of M (the rest isReal=false).
const fakeFixed = (confirmsOf: number) => {
  let i = 0;
  return (_finding: Finding, _change: string): Verdict => {
    const isReal = i < confirmsOf;
    i++;
    return { isReal, agreedSeverity: isReal ? 'MAJOR' : 'NOT_A_DEFECT', reasoning: 'fake' };
  };
};

// M=2, 1 isReal=true + 1 isReal=false: T=1 confirmed, T=2 NOT confirmed.
const v1of2_t1 = verifyFinding(majorFinding, 'CHG', fakeFixed(1), { skeptics: 2, threshold: 1 });
check('1-of-2 @ T=1 confirmed === true', v1of2_t1.confirmed === true);
check('1-of-2 @ T=1 confirms === 1', v1of2_t1.confirms === 1);
check('1-of-2 @ T=1 verdicts.length === 2 (seam called exactly M times)', v1of2_t1.verdicts.length === 2);

const v1of2_t2 = verifyFinding(majorFinding, 'CHG', fakeFixed(1), { skeptics: 2, threshold: 2 });
check('1-of-2 @ T=2 confirmed === false (NOT majority/threshold not met)', v1of2_t2.confirmed === false);
check('1-of-2 @ T=2 confirms === 1', v1of2_t2.confirms === 1);

// M=2, 0 isReal=true: dropped under any T>=1.
const v0of2_t1 = verifyFinding(majorFinding, 'CHG', fakeFixed(0), { skeptics: 2, threshold: 1 });
check('0-of-2 @ T=1 confirmed === false (DROPPED)', v0of2_t1.confirmed === false);
check('0-of-2 @ T=1 confirms === 0', v0of2_t1.confirms === 0);
const v0of2_t2 = verifyFinding(majorFinding, 'CHG', fakeFixed(0), { skeptics: 2, threshold: 2 });
check('0-of-2 @ T=2 confirmed === false (DROPPED)', v0of2_t2.confirmed === false);

// M=2, 2 isReal=true: confirmed under T=2.
const v2of2_t2 = verifyFinding(majorFinding, 'CHG', fakeFixed(2), { skeptics: 2, threshold: 2 });
check('2-of-2 @ T=2 confirmed === true', v2of2_t2.confirmed === true);
check('2-of-2 @ T=2 confirms === 2', v2of2_t2.confirms === 2);

// Default (no opts) uses M=2, T=1: a 1-of-2 fake -> confirmed.
const vDefault = verifyFinding(majorFinding, 'CHG', fakeFixed(1));
check('default (M=2,T=1) 1-of-2 confirmed === true', vDefault.confirmed === true);
check('default verdicts.length === DEFAULT_SKEPTICS (2)', vDefault.verdicts.length === DEFAULT_SKEPTICS);
check('default confirms === 1', vDefault.confirms === 1);

// A fake that returns a fixed SEQUENCE of isReal values across successive calls.
const fakeSeq = (seq: boolean[]) => {
  let i = 0;
  return (_finding: Finding, _change: string): Verdict => {
    const isReal = seq[i] === true;
    i++;
    return { isReal, agreedSeverity: isReal ? 'MAJOR' : 'NOT_A_DEFECT', reasoning: 'fake-seq' };
  };
};

// CHK-003:edge:1 — M=1, T=1, single confirm.
const vM1T1 = verifyFinding(majorFinding, 'CHG', fakeFixed(1), { skeptics: 1, threshold: 1 });
check('M=1,T=1 verdicts.length === 1', vM1T1.verdicts.length === 1);
check('M=1,T=1 confirms === 1', vM1T1.confirms === 1);
check('M=1,T=1 confirmed === true', vM1T1.confirmed === true);

// CHK-003:edge:2 — M=3, T=2, sequence [true,false,true] -> 2 confirms -> confirmed.
const vSeqTFT = verifyFinding(majorFinding, 'CHG', fakeSeq([true, false, true]), { skeptics: 3, threshold: 2 });
check('M=3,T=2 [true,false,true] verdicts.length === 3', vSeqTFT.verdicts.length === 3);
check('M=3,T=2 [true,false,true] confirms === 2', vSeqTFT.confirms === 2);
check('M=3,T=2 [true,false,true] confirmed === true', vSeqTFT.confirmed === true);
// and the [true,false,false] variant -> 1 confirm -> NOT confirmed at T=2.
const vSeqTFF = verifyFinding(majorFinding, 'CHG', fakeSeq([true, false, false]), { skeptics: 3, threshold: 2 });
check('M=3,T=2 [true,false,false] confirms === 1', vSeqTFF.confirms === 1);
check('M=3,T=2 [true,false,false] confirmed === false', vSeqTFF.confirmed === false);

// CHK-003:adversarial:2 — §2.3 invariant: zero concrete confirmations can never confirm;
// requested T<1 is clamped to 1. all-false @ threshold:0 yields confirms===0 AND confirmed===false (DROPPED).
const vT0 = verifyFinding(majorFinding, 'CHG', fakeFixed(0), { skeptics: 2, threshold: 0 });
check('T=0 all-false confirms === 0', vT0.confirms === 0);
check('T=0 all-false confirmed === false (DROPPED — threshold floored to 1)', vT0.confirmed === false);
// §2.3 invariant — a confirms=0 finding is DROPPED regardless of the requested threshold (T=0 AND T=1).
const vT1zero = verifyFinding(majorFinding, 'CHG', fakeFixed(0), { skeptics: 2, threshold: 1 });
check('T=1 all-false confirms === 0', vT1zero.confirms === 0);
check('T=1 all-false confirmed === false (DROPPED)', vT1zero.confirmed === false);
// and a 1-of-2 fake @ threshold:0 -> confirmed === true (confirms=1 >= floored-1).
const v1of2_t0 = verifyFinding(majorFinding, 'CHG', fakeFixed(1), { skeptics: 2, threshold: 0 });
check('1-of-2 @ T=0 confirms === 1', v1of2_t0.confirms === 1);
check('1-of-2 @ T=0 confirmed === true (confirms=1 >= floored-1)', v1of2_t0.confirmed === true);

// ── 6. refute-by-default strictness ──────────────────────────────────────────
// A Verdict with isReal=false but a non-NOT_A_DEFECT agreedSeverity must NOT count.
const fakeFalseButSevere = (_finding: Finding, _change: string): Verdict => ({
  isReal: false,
  agreedSeverity: 'MAJOR',
  reasoning: 'severity set but isReal false — must not confirm',
});
const vStrict = verifyFinding(majorFinding, 'CHG', fakeFalseButSevere, { skeptics: 2, threshold: 1 });
check('isReal=false w/ agreedSeverity=MAJOR is NOT counted (confirms === 0)', vStrict.confirms === 0);
check('isReal=false w/ agreedSeverity=MAJOR -> confirmed === false', vStrict.confirmed === false);

// ── 7. verifyFindings + confirmedFindings ────────────────────────────────────
const f1: Finding = { severity: 'MAJOR', title: 'f1', file: 'f1.ts', line: 1, issue: 'i1', fix: 'x1' };
const f2: Finding = { severity: 'MAJOR', title: 'f2', file: 'f2.ts', line: 2, issue: 'i2', fix: 'x2' };
const f3: Finding = { severity: 'MAJOR', title: 'f3', file: 'f3.ts', line: 3, issue: 'i3', fix: 'x3' };
// Confirms ONLY the 2nd finding (by reference identity).
const fakeOnlySecond = (finding: Finding, _change: string): Verdict => ({
  isReal: finding === f2,
  agreedSeverity: finding === f2 ? 'MAJOR' : 'NOT_A_DEFECT',
  reasoning: 'confirm only f2',
});
const verifiedList = verifyFindings([f1, f2, f3], 'CHG', fakeOnlySecond, { skeptics: 2, threshold: 1 });
check('verifyFindings returns 3 VerifiedFinding', verifiedList.length === 3);
check('each VerifiedFinding has verdicts.length === M (2)', verifiedList.every((v) => v.verdicts.length === 2));
check('verifyFindings preserves finding refs in order', verifiedList[0].finding === f1 && verifiedList[1].finding === f2 && verifiedList[2].finding === f3);
const confirmed = confirmedFindings(verifiedList);
check('confirmedFindings returns exactly 1 finding', confirmed.length === 1);
check('confirmedFindings returns exactly [f2]', confirmed[0] === f2);
// CHK-003:edge:3 — empty input projects to an empty list (length 0).
check('confirmedFindings([]) deep-equals [] (length 0)', confirmedFindings([]).length === 0);

console.log('adversarial-review-verifier smoke passed: ' + passed + ' assertions');
