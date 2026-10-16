#!/usr/bin/env node
/**
 * Lab lean (bench-staging/oldpos/lean-pipeline.md; structural-cost-analysis.md §7 items 2-5; run93-96-analysis.md §7 fix 3;
 * run106-analysis.md §5): unit level, real git repositories where a check needs one, made-up toy code (a `strs` package and
 * a made-up `eval` package); no benchmark-task material. The lifecycle shapes are harness NLN, NLN-OFF, NLN-E and NLN-DF in
 * tasks/e2e-review-to-done-smoke.ts.
 *
 *   L. The umbrella switch `pipeline.lean` (EXPERIMENTAL, default off): `on` implies the sub-switches of items 1-4
 *      (implementation.grouping=story, review.laneMerge=on, review.deltaRounds=confirm, review.criticOnCleanRound=skip,
 *      plan.reviewMerge=on, plan.disputeConfirm=on) for every key the config leaves absent; an explicit sub-switch wins;
 *      the evidence records the umbrella and every implied value; malformed = off where consumed.
 *   D. DEV, one implementer run per Story (implementation.grouping=story): every open item joins the one run (no shared
 *      file needed), the run's brief carries each member item as its own section (context, userSees, files, pinned
 *      verification, exact output) and the commit rule, and a member counts as implemented only by a commit naming it.
 *   R. Later review rounds (review.deltaRounds=confirm): ONE confirmation session over the repair delta for every lane's
 *      concern (no lane re-reviews the whole Story, even the one that raised the finding); a finding the session reports
 *      outside the delta (no cited location inside the delta scope) escalates: the next round is a full round
 *      (PREVIOUS_ESCALATION); the prompt states the rule; a dimension the previous merged FINDINGS verdict left
 *      uncovered runs in full (R4).
 *   F. Defect-family linking by evidence (remediation.familyEvidence, default on): an earlier-round finding is linked when a
 *      cited line was last changed by its repair commit, when both cite the same function, or when the cited spans
 *      overlap; unrelated findings (other function, no overlap) are not; the mechanism-level brief fires at the family's
 *      second round even without a `[regression-of]` tag; a same-round duplicate's repro rides on its canonical's repair.
 *
 * Usage: node packages/main/dist/tasks/lean-pipeline-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Fn = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
/** A module export that may not exist yet (RED: the check fails, the smoke still runs). */
async function load(path: string, name: string): Promise<Fn> {
  let module: Record<string, unknown> = {};
  try { module = await import(path) as Record<string, unknown>; } catch { module = {}; }
  const fn = module[name];
  assert.ok(fn !== undefined, `${path} exports ${name}`);
  return fn as Fn;
}
const dirs: string[] = [];
function projectWith(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lean-config-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify(config));
  return dir;
}
function repoWith(files: Record<string, string>): { repo: string; git: (...args: string[]) => string; commit: (message: string) => string; put: (rel: string, text: string) => void } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'lean-repo-')));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const put = (rel: string, text: string) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
  const commit = (message: string) => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  commit('base');
  return { repo, git, commit, put };
}

// ---------------------------------------------------------------------------
// L. Umbrella

const LEAN_IMPLIED = {
  'implementation.grouping': 'story',
  'review.laneMerge': 'on',
  'review.deltaRounds': 'confirm',
  'review.criticOnCleanRound': 'skip',
  'plan.reviewMerge': 'on',
  'plan.disputeConfirm': 'on',
} as const;

await check('L1 pipeline.lean=on implies the sub-switches of items 1-4; the evidence records the umbrella and each implied value', async () => {
  const resolve = await load('../core/ab-variants.js', 'resolveAbVariants');
  const evidence = await load('../core/ab-variants.js', 'abVariantEvidence');
  const implies = await load('../core/ab-variants.js', 'LEAN_PIPELINE_IMPLIES');
  assert.deepEqual({ ...implies }, LEAN_IMPLIED, 'the implied set');
  const lean = resolve({ pipeline: { lean: 'on' } });
  assert.equal(lean.pipelineLean, 'on');
  assert.equal(lean.implementationGrouping, 'story');
  assert.equal(lean.laneMerge, 'on');
  assert.equal(lean.deltaRounds, 'confirm');
  assert.equal(lean.criticOnCleanRound, 'skip');
  assert.equal(lean.reviewMerge, 'on');
  assert.equal(lean.disputeConfirm, 'on');
  assert.deepEqual(evidence(lean)?.flags, { 'pipeline.lean': 'on', ...LEAN_IMPLIED });
  const off = resolve({});
  assert.equal(off.pipelineLean, 'off', 'default off');
  assert.equal(off.implementationGrouping, 'per-item');
  assert.equal(off.deltaRounds, 'off');
  assert.equal(evidence(off), undefined, 'production records nothing');
});

await check('L2 an explicit sub-switch wins over the umbrella (also a production value); each sub-switch works alone', async () => {
  const resolve = await load('../core/ab-variants.js', 'resolveAbVariants');
  const split = resolve({ pipeline: { lean: 'on' }, review: { laneMerge: 'split' } });
  assert.equal(split.laneMerge, 'split');
  assert.equal(split.deltaRounds, 'confirm', 'the other implied values stay');
  assert.equal(resolve({ pipeline: { lean: 'on' }, implementation: { grouping: 'per-item' } }).implementationGrouping, 'per-item', 'an explicit production value opts out of one item');
  assert.equal(resolve({ implementation: { grouping: 'story' } }).implementationGrouping, 'story');
  assert.equal(resolve({ review: { deltaRounds: 'confirm' } }).deltaRounds, 'confirm');
  assert.equal(resolve({ implementation: { grouping: 'story' } }).pipelineLean, 'off');
});

await check('L3 malformed: resolveAbVariants refuses; where consumed the umbrella is off; the readers see the implied values', async () => {
  const resolve = await load('../core/ab-variants.js', 'resolveAbVariants');
  assert.throws(() => resolve({ pipeline: { lean: 'yes' } }), /invalid_ab_variant_config: pipeline\.lean/);
  assert.throws(() => resolve({ implementation: { grouping: 'all' } }), /invalid_ab_variant_config: implementation\.grouping/);
  assert.throws(() => resolve({ review: { deltaRounds: 'maybe' } }), /invalid_ab_variant_config: review\.deltaRounds/);
  const leanOn = await load('../core/ab-variants.js', 'pipelineLeanOn');
  const laneMergeMode = await load('../core/ab-variants.js', 'laneMergeMode');
  const reviewMergeOn = await load('../core/ab-variants.js', 'reviewMergeOn');
  const disputeConfirmOn = await load('../core/ab-variants.js', 'disputeConfirmOn');
  const deltaRoundsMode = await load('../core/ab-variants.js', 'deltaRoundsMode');
  assert.equal(leanOn({ pipeline: { lean: 'yes' } }), false);
  assert.equal(laneMergeMode({ pipeline: { lean: 'yes' } }), 'off', 'a malformed umbrella implies nothing');
  assert.equal(leanOn({ pipeline: { lean: 'on' } }), true);
  assert.equal(laneMergeMode({ pipeline: { lean: 'on' } }), 'on');
  assert.equal(reviewMergeOn({ pipeline: { lean: 'on' } }), true);
  assert.equal(disputeConfirmOn({ pipeline: { lean: 'on' } }), true);
  assert.equal(deltaRoundsMode({ pipeline: { lean: 'on' } }), 'confirm');
  assert.equal(deltaRoundsMode({ review: { deltaRounds: 'on' } }), 'on');
  assert.equal(deltaRoundsMode({ review: { deltaRounds: 'maybe' } }), 'off');
  const grouping = await load('../core/ab-dispatch-grouping.js', 'implementationGroupingStory');
  assert.equal(grouping(projectWith({ pipeline: { lean: 'on' } })), true, 'the DEV reader sees the implied story grouping');
  assert.equal(grouping(projectWith({})), false);
});

await check('L4 remediation.familyEvidence is on by default; off is the recorded rollback; malformed keeps the default', async () => {
  const resolve = await load('../core/ab-variants.js', 'resolveAbVariants');
  const evidence = await load('../core/ab-variants.js', 'abVariantEvidence');
  const on = await load('../core/ab-variants.js', 'familyEvidenceOn');
  assert.equal(resolve({}).familyEvidence, 'on');
  assert.equal(on({}), true);
  assert.deepEqual(evidence(resolve({ remediation: { familyEvidence: 'off' } }))?.flags, { 'remediation.familyEvidence': 'off' });
  assert.equal(on({ remediation: { familyEvidence: 'off' } }), false);
  assert.equal(on({ remediation: { familyEvidence: 'loud' } }), true, 'malformed = the default');
});

// ---------------------------------------------------------------------------
// D. One implementer run per Story

const pinnedRow = (id: string, desc: string, test: string) => ({ id, desc, type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
  verification: { command: `go test -v ./strs -run ^${test}$`, selector: `--- PASS: ${test}` } });
const ITEMS = [
  { id: 'CHK-001', title: 'Upper returns the upper-case form', status: 'in_progress', context: 'Upper returns its input unchanged.', userSees: 'Upper("ab") is "AB".',
    files: { modify: ['strs/strs.go'], create: [], test: ['strs/strs_test.go'] }, verificationIntent: { happy: [pinnedRow('CHK-001:happy:0', 'Upper("ab") -> "AB"', 'TestUpper')], edge: [], adversarial: [] } },
  { id: 'CHK-002', title: 'Reverse reverses by rune', status: 'in_progress', context: 'Reverse does not exist.', userSees: 'Reverse("héllo") prints `olléh`.',
    files: { modify: ['strs/rev.go'], create: [], test: ['strs/rev_test.go'] }, verificationIntent: { happy: [pinnedRow('CHK-002:happy:0', 'Reverse("héllo") -> "olléh"', 'TestReverse')], edge: [], adversarial: [] } },
  { id: 'CHK-003', title: 'Shout appends a bang', status: 'pending', context: 'Shout is new.', userSees: 'Shout("a") is "A!".',
    files: { modify: ['strs/shout.go'], create: [], test: ['strs/shout_test.go'] }, verificationIntent: { happy: [pinnedRow('CHK-003:happy:0', 'Shout("a") -> "A!"', 'TestShout')], edge: [], adversarial: [] } },
];

await check('D1 every open item joins the one Story run, also without a shared declared file (files grouping would not)', async () => {
  const group = await load('../core/ab-dispatch-grouping.js', 'storyItemGroup');
  const files = await load('../core/ab-dispatch-grouping.js', 'sharedFileItemGroup');
  assert.deepEqual(group(ITEMS[1], ITEMS).map((item: { id: string }) => item.id), ['CHK-002', 'CHK-001', 'CHK-003'], 'the primary first, then the others in order');
  assert.deepEqual(files(ITEMS[1], ITEMS).map((item: { id: string }) => item.id), ['CHK-002'], 'no shared file: the files grouping keeps one item');
  assert.deepEqual(group(ITEMS[0], [ITEMS[0]]).map((item: { id: string }) => item.id), ['CHK-001'], 'one open item: no group');
});

await check('D2 the Story-run brief carries each member item as its own section with its pins, exact output and the commit-naming rule', async () => {
  const render = await load('../core/lean-story-run.js', 'renderStoryRunSection');
  const text = (render({ storyId: 'B-ln01', primaryId: 'CHK-001', items: ITEMS, extrasFor: (id: string) => id === 'CHK-003' ? ['[extra] counterpart lines of CHK-003'] : [] }) as string[]).join('\n');
  assert.match(text, /--- BEGIN STORY RUN/, 'a delimited block');
  for (const item of ITEMS.slice(1)) {
    assert.match(text, new RegExp(`### ${item.id}: ${item.title}`), `${item.id} has its own section`);
    assert.match(text, new RegExp(item.verificationIntent.happy[0]!.verification.command.replace(/[$^]/g, '.')), `${item.id}'s pinned command`);
    assert.match(text, new RegExp(item.verificationIntent.happy[0]!.verification.selector), `${item.id}'s pinned test name`);
    assert.match(text, new RegExp(`Files: modify ${item.files.modify[0]}`), `${item.id}'s files`);
  }
  assert.match(text, /olléh/, 'the exact output literal of CHK-002 is copied verbatim');
  assert.match(text, /\[extra\] counterpart lines of CHK-003/, 'caller extras land in their member section');
  assert.match(text, /B-ln01 CHK-002/, 'the commit message rule names the member id');
  assert.match(text, /framework marks each other item done/i, 'who marks the members done');
  assert.doesNotMatch(text, /### CHK-001:/, 'the bound item is the base prompt above, not repeated');
});

await check('D3 a member counts as implemented only by a commit whose message names it', async () => {
  const names = await load('../core/ab-dispatch-grouping.js', 'commitMessageNamesItem');
  assert.equal(names('B-ln01 CHK-002: Reverse reverses by rune', 'CHK-002'), true);
  assert.equal(names('B-ln01 CHK-001 CHK-002 CHK-003: implement strs', 'CHK-003'), true);
  assert.equal(names('B-ln01 CHK-0021: other', 'CHK-002'), false, 'not a longer id');
  assert.equal(names('B-ln01 CHK-001: Upper', 'CHK-002'), false);
});

// ---------------------------------------------------------------------------
// R. Confirmation rounds

const STORY = 'B-ln02';
const ROUND1 = '2026-10-16T10:00:00.000Z';
const ROUND2 = '2026-10-16T11:00:00.000Z';
const LANES = ['concept', 'quality', 'test-coverage', 'docs'].map(name => `proof-or-stop-review-${name}`);
const STRS = ['package strs', '', 'import "strings"', '', '// Upper returns the upper-case form of s.', 'func Upper(s string) string { return strings.ToUpper(s) }', '',
  '// Reverse returns s reversed by rune.', 'func Reverse(s string) string {', '\tr := []rune(s)', '\tfor i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {', '\t\tr[i], r[j] = r[j], r[i]', '\t}', '\treturn string(r)', '}', '',
  '// Shout returns s upper-cased with a bang.', 'func Shout(s string) string { return Upper(s) + "!" }', ''].join('\n');
const STRS_TEST = ['package strs', '', 'import "testing"', '', 'func TestReverse(t *testing.T) {', '\tif Reverse("ab") != "ba" {', '\t\tt.Fatal("reverse")', '\t}', '}', ''].join('\n');
const REPAIR_TEST = '\nfunc TestReverseEmpty(t *testing.T) {\n\tif Reverse("") != "" {\n\t\tt.Fatal("empty")\n\t}\n}\n';

function deltaFixture(events: Array<Record<string, unknown>> = []): { repo: string; store: Record<string, Fn> } {
  const { repo, git, commit, put } = repoWith({ 'README.md': '# toy\n' });
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', `story/${STORY}`);
  put('strs/strs.go', STRS);
  put('strs/strs_test.go', STRS_TEST);
  const fromHead = commit(`${STORY} CHK-001: strs`);
  put('strs/strs_test.go', STRS_TEST + REPAIR_TEST);
  commit(`${STORY} F-001: resolve finding`);
  const runs = LANES.map((lane, index) => ({ reviewRunId: `${STORY}:RR-00${index + 1}`, storyId: STORY, lane, reviewRound: ROUND1, headHash: fromHead, materialHash: 'm1', startedAt: `2026-10-16T10:0${index}:00.000Z` }));
  const findings = [{ id: `${STORY}:F-001`, desc: 'Reverse("") must return "" (untested empty input).', severity: 'medium', category: 'edge', status: 'resolved', evidenceState: 'verified',
    agent: 'proof-or-stop-review-concept', reviewRound: ROUND1, reviewRunId: `${STORY}:RR-001`, resolvedAt: '2026-10-16T10:40:00.000Z', resolutionType: 'fixed', files: ['strs/strs_test.go'] }];
  const receipts = [{ receiptId: 'RCPT-1', epochId: 'EP-1', storyId: STORY, reviewRound: ROUND1, authority: 'review-remediation-only', cutoff: { headHash: fromHead, materialHash: 'm1' },
    requiredLanes: LANES, issuedAt: '2026-10-16T10:20:00.000Z', consumedAt: '2026-10-16T10:30:00.000Z' }];
  const store: Record<string, Fn> = {
    readStory: () => ({ id: STORY, phase: 'REVIEW', currentReviewRound: ROUND2, integrationTarget: { parentCommitAtCreation: base } }),
    readReviewRuns: () => ({ runs }),
    readFindings: () => ({ findings }),
    readReviewInventoryEpochs: () => ({ epochs: [{ epochId: 'EP-1', reviewRound: ROUND1, receiptId: 'RCPT-1', consumedAt: '2026-10-16T10:30:00.000Z', requiredLanes: LANES }], receipts, criticReceipts: [] }),
    readProcessEvents: () => events,
  };
  return { repo, store };
}

async function deltaPlan(config: Record<string, unknown>, events: Array<Record<string, unknown>> = []): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const compute = await load('../core/review-delta-round.js', 'computeDeltaRoundPlan');
  const f = deltaFixture(events);
  return compute({ store: f.store, projectRoot: projectWith(config), gitCwd: f.repo, storyId: STORY, activeLanes: LANES });
}

await check('R1 confirm: ONE confirmation session for every lane concern; the lane that raised the finding is not re-run in full', async () => {
  const on = await deltaPlan({ review: { deltaRounds: 'on' } });
  assert.deepEqual(on.fullLanes, ['proof-or-stop-review-concept'], 'control: the on arm re-runs the raiser in full');
  const confirm = await deltaPlan({ review: { deltaRounds: 'confirm' } });
  assert.equal(confirm.eligible, true, `eligible (${confirm.reason}: ${confirm.detail})`);
  assert.deepEqual(confirm.fullLanes, [], 'no lane re-reviews the whole Story');
  assert.deepEqual(confirm.replacedLanes, LANES, 'every lane concern goes to the confirmation session');
  assert.equal(confirm.confirmationLane, 'proof-or-stop-review-concept');
  assert.deepEqual(confirm.selectedLanes, ['proof-or-stop-review-concept'], 'one session');
  assert.equal(confirm.mode, 'confirm');
  assert.deepEqual(confirm.abVariant?.flags, { 'review.deltaRounds': 'confirm' });
  const lean = await deltaPlan({ pipeline: { lean: 'on' } });
  assert.deepEqual(lean.selectedLanes, ['proof-or-stop-review-concept'], 'the umbrella gives the same plan');
});

await check('R2 escalation: a confirmation finding with no cited location inside the delta scope is outside; one inside is not', async () => {
  const escalations = await load('../core/review-delta-round.js', 'deltaEscalations');
  const plan = await deltaPlan({ review: { deltaRounds: 'confirm' } });
  const scope = plan.scope as Array<{ path: string; regions: Array<{ startLine: number; endLine: number }> }>;
  assert.ok(scope.some(file => file.path === 'strs/strs_test.go'), `the delta scope names the repaired test file (${JSON.stringify(scope.map(file => file.path))})`);
  const region = scope.find(file => file.path === 'strs/strs_test.go')!.regions[0]!;
  const out = escalations(scope, [
    { desc: `TestReverseEmpty asserts nothing about the rune count (strs/strs_test.go:${region.startLine}).`, files: ['strs/strs_test.go'] },
    { desc: 'Shout appends "!" to an empty string too (strs/strs.go:17): Shout("") must be "".', files: ['strs/strs.go'] },
    { desc: 'An empty string is reported without any location.', files: [] },
    { desc: 'Reverse of a long string is untested.', files: ['strs/strs_test.go'] },
  ]) as Array<{ index: number; reason: string }>;
  assert.deepEqual(out.map(row => row.index), [1, 2], `the out-of-delta and the unplaceable finding escalate (${JSON.stringify(out)})`);
  assert.match(out[0]!.reason, /strs\/strs\.go:17/, 'the reason names the outside location');
});

await check('R3 a recorded escalation of the previous round makes this round a full round (PREVIOUS_ESCALATION); the prompt states the rule', async () => {
  const event = await load('../core/review-delta-round.js', 'DELTA_ROUND_ESCALATION_EVENT');
  const prev = '2026-10-16T09:00:00.000Z';
  // The escalation of the round BEFORE ROUND1 does not matter; one of ROUND1 (the previous round) does.
  const quiet = await deltaPlan({ review: { deltaRounds: 'confirm' } }, [{ type: event, reviewRound: prev }]);
  assert.equal(quiet.eligible, true, `an older escalation is history (${quiet.reason})`);
  const escalated = await deltaPlan({ review: { deltaRounds: 'confirm' } }, [{ type: event, reviewRound: ROUND1 }]);
  assert.equal(escalated.eligible, false);
  assert.equal(escalated.reason, 'PREVIOUS_ESCALATION');
  const render = await load('../core/review-delta-round.js', 'renderDeltaConfirmationBlock');
  const block = (render(quiet, STORY) as string[]).join('\n');
  assert.match(block, /No lane re-reviews the whole Story/);
  assert.match(block, /outside the delta scope[^\n]*next round is a full review/i, 'the escalation rule is stated');
  assert.match(block, /review\.deltaRounds=confirm/);
});

await check('R4 confirm + lane merge: a dimension the previous merged FINDINGS verdict left uncovered runs in full (it was never reviewed)', async () => {
  const lanes = await deltaPlan({ review: { deltaRounds: 'confirm' } }, [{ type: 'review_lane_merge_coverage', reviewRound: ROUND1, conclusion: 'findings', missingLanes: ['proof-or-stop-review-quality'] }]);
  assert.equal(lanes.eligible, true, `${lanes.reason}`);
  assert.deepEqual(lanes.fullLanes, ['proof-or-stop-review-quality'], 'the uncovered dimension reviews the whole Story');
  assert.deepEqual(lanes.selectedLanes, ['proof-or-stop-review-concept', 'proof-or-stop-review-quality'], 'plus the one confirmation session');
  const pass = await deltaPlan({ review: { deltaRounds: 'confirm' } }, [{ type: 'review_lane_merge_coverage', reviewRound: ROUND1, conclusion: 'pass', missingLanes: ['proof-or-stop-review-quality'] }]);
  assert.deepEqual(pass.fullLanes, [], 'a PASS gap was relaunched in its own round already');
});

// ---------------------------------------------------------------------------
// F. Defect families by evidence

const EVAL_V1 = [
  'package eval', '',
  'func assignIndex(target, value Object) Object {', // 3
  '\tobj := resolve(target)',
  '\tif obj == nil {',
  '\t\treturn NULL',
  '\t}',
  '\tidx := index(target)',
  '\tobj.set(idx, value)',
  '\treturn value', // 10
  '}', '',
  'func sliceRange(obj Object, lo, hi int) Object {', // 13
  '\tif lo < 0 {',
  '\t\tlo = 0',
  '\t}',
  '\treturn obj.slice(lo, hi)',
  '}', '',
].join('\n');

function familyFixture(): { repo: string; findings: Array<Record<string, unknown>>; head: string; r1Head: string } {
  const { repo, git, commit, put } = repoWith({ 'eval/eval.go': EVAL_V1 });
  const r1Head = git('rev-parse', 'HEAD');
  // F-001's repair caches the resolved target (lines 4-6 change).
  put('eval/eval.go', EVAL_V1.replace('\tobj := resolve(target)\n\tif obj == nil {\n\t\treturn NULL\n\t}', '\tobj := cachedResolve(target)\n\tif obj == nil {\n\t\tobj = resolve(target)\n\t}'));
  const repair = commit('B-ff01 F-001: resolve finding');
  const head = git('rev-parse', 'HEAD');
  const findings = [
    { id: 'B-ff01:F-001', desc: 'assignIndex evaluates the target twice (eval/eval.go:4): `a[f()] = 1` calls f twice.', severity: 'high', category: 'edge', status: 'resolved',
      evidenceState: 'verified', reviewRound: 'R1', files: ['eval/eval.go'], resolvedReason: `repair ${repair.slice(0, 12)} caches the target`, resolutionType: 'fixed' },
    // Round 2, untagged: cites a line the F-001 repair wrote.
    { id: 'B-ff01:F-004', desc: 'The cached target goes stale after a nested write (eval/eval.go:6): `a[0][1] = 2` writes the old row.', severity: 'high', category: 'edge', status: 'open',
      evidenceState: 'verified', reviewRound: 'R2', files: ['eval/eval.go'] },
    // Round 2, untagged, same function, a line the repair did not touch.
    { id: 'B-ff01:F-005', desc: 'assignIndex returns the value even when set fails (eval/eval.go:10).', severity: 'medium', category: 'edge', status: 'open',
      evidenceState: 'verified', reviewRound: 'R2', files: ['eval/eval.go'] },
    // Round 2, unrelated function, no overlap.
    { id: 'B-ff01:F-006', desc: 'sliceRange clamps a negative lo to 0 instead of counting from the end (eval/eval.go:15).', severity: 'medium', category: 'edge', status: 'open',
      evidenceState: 'verified', reviewRound: 'R2', files: ['eval/eval.go'] },
  ];
  return { repo, findings, head, r1Head };
}

await check('F1 links by evidence: a cited line the earlier repair wrote, the same function; an unrelated function is not linked', async () => {
  const links = await load('../core/regression-family-brief.js', 'familyLinks');
  const f = familyFixture();
  const headOf = (finding: { reviewRound?: string }) => finding.reviewRound === 'R1' ? f.r1Head : f.head;
  const of = (id: string) => (links({ findings: f.findings, storyId: 'B-ff01', finding: f.findings.find(row => row.id === id), gitCwd: f.repo, reviewHead: headOf }) as Array<{ findingId: string; via: string }>);
  const f4 = of('B-ff01:F-004');
  assert.deepEqual(f4.map(row => row.findingId), ['B-ff01:F-001'], `F-004 links to F-001 (${JSON.stringify(f4)})`);
  assert.ok(f4.some(row => row.via === 'repair-lines'), 'via the repair commit that last changed the cited line');
  const f5 = of('B-ff01:F-005');
  assert.deepEqual(f5.map(row => row.findingId), ['B-ff01:F-001'], `F-005 links to F-001 (${JSON.stringify(f5)})`);
  assert.ok(f5.some(row => row.via === 'function'), 'via the same enclosing function');
  assert.deepEqual(of('B-ff01:F-006'), [], 'another function, no overlap, no tag: not linked');
});

await check('F2 the mechanism-level brief fires at the family\'s second round without a [regression-of] tag; off keeps the tag-only rule', async () => {
  const brief = await load('../core/regression-family-brief.js', 'regressionFamilyBrief');
  const f = familyFixture();
  const headOf = (finding: { reviewRound?: string }) => finding.reviewRound === 'R1' ? f.r1Head : f.head;
  const finding = f.findings.find(row => row.id === 'B-ff01:F-004');
  const on = (brief({ findings: f.findings, storyId: 'B-ff01', finding, gitCwd: f.repo, reviewHead: headOf, familyEvidence: true }) as string[]).join('\n');
  assert.match(on, /Family-complete repair/, 'the family brief');
  assert.match(on, /F-001/, 'names the earlier finding');
  assert.match(on, /Mechanism-level repair \(framework\)/, 'the mechanism block at the second round of the family');
  assert.match(on, /\[mechanism\]/);
  const off = brief({ findings: f.findings, storyId: 'B-ff01', finding, gitCwd: f.repo, reviewHead: headOf, familyEvidence: false }) as string[];
  assert.deepEqual(off, [], 'rollback: an untagged finding gets no brief');
  const unrelated = brief({ findings: f.findings, storyId: 'B-ff01', finding: f.findings.find(row => row.id === 'B-ff01:F-006'), gitCwd: f.repo, reviewHead: headOf, familyEvidence: true }) as string[];
  assert.deepEqual(unrelated, [], 'an unlinked finding gets no brief');
});

await check('F3 the [mechanism] report line is required for an evidence-linked second-round finding', async () => {
  const record = await load('../core/regression-family-brief.js', 'recordChainMechanismRequirement');
  const f = familyFixture();
  const root = projectWith({});
  const headOf = (finding: { reviewRound?: string }) => finding.reviewRound === 'R1' ? f.r1Head : f.head;
  const finding = f.findings.find(row => row.id === 'B-ff01:F-004');
  assert.equal(record({ root, storyId: 'B-ff01', findings: f.findings, finding, requestText: null, gitCwd: f.repo, reviewHead: headOf, familyEvidence: true }), true);
  assert.equal(record({ root, storyId: 'B-ff01', findings: f.findings, finding, requestText: null, gitCwd: f.repo, reviewHead: headOf, familyEvidence: false }), false, 'rollback: tags only');
});

await check('F4 a same-round duplicate rides on its canonical\'s repair: its repro is listed for the canonical\'s regression test', async () => {
  const lines = await load('../core/regression-family-brief.js', 'sameRoundDuplicateLines');
  const canonical = { id: 'B-ff01:F-015', desc: 'Stale cached setter (eval/eval.go:6): `a[0] = 1; a[0] = 2` keeps 1.', reviewRound: 'R4', status: 'open' };
  const duplicate = { id: 'B-ff01:F-017', desc: 'Repro: `b = [1]; b[0] = 3; b[0] = 4` prints [3].', reviewRound: 'R4', status: 'open' };
  const older = { id: 'B-ff01:F-002', desc: 'Repro: `c[0] = 9` (old round).', reviewRound: 'R1', status: 'open' };
  const duplicateOf = (id: string) => (id === duplicate.id || id === older.id ? canonical.id : null);
  const text = (lines({ storyId: 'B-ff01', finding: canonical, findings: [canonical, duplicate, older], duplicateOf }) as string[]).join('\n');
  assert.match(text, /F-017/, 'the same-round duplicate');
  assert.match(text, /b = \[1\]; b\[0\] = 3; b\[0\] = 4/, 'its repro');
  assert.doesNotMatch(text, /F-002/, 'a duplicate of another round keeps its own path');
  assert.deepEqual(lines({ storyId: 'B-ff01', finding: duplicate, findings: [canonical, duplicate], duplicateOf }), [], 'nothing for the duplicate itself');
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.log(`\nlean-pipeline-smoke: ${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nlean-pipeline-smoke: all checks passed');
