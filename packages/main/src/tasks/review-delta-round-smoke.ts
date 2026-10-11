#!/usr/bin/env node
/**
 * EXPERIMENTAL A/B review.deltaRounds (core/review-delta-round.ts): a REVIEW
 * round N >= 2 that follows a remediation re-reviews only the repair (the new
 * PoS's ADR-039 / ADR-043 / ADR-054, ported as ideas). Unit level, real git
 * repositories, a minimal store stand-in. Generic toy code only (a `strs`
 * package); no benchmark-task material. The end-to-end arms (each reaching
 * DONE through `next`) live in tasks/e2e-review-to-done-smoke.ts (ND-DR,
 * ND-DRL, ND-DRG, ND-DRV).
 *
 *   P. Plan / roster: with the switch on, the lane that raised a (non-duplicate,
 *      non-rejected) finding in the previous round re-reviews in full and every
 *      other active lane is replaced by ONE confirmation lane (the first
 *      replaced lane in roster order); off / malformed = no delta round.
 *   F. Fallbacks to a full round: repair diff > 50% of the Story diff's changed
 *      lines, a repaired file outside the previous material, a recorded
 *      confirmation gap of this round, every lane raised findings, no consumed
 *      remediation receipt of the previous round.
 *   S. Scope: the repair hunks, their enclosing definitions and the callers /
 *      callees in the same files. A defect seeded INSIDE the repair diff lies in
 *      the confirmation scope; a defect OUTSIDE it (already present on the
 *      previous candidate, missed by round 1) is not: the documented detection
 *      limit of a delta round (only the full lanes re-read the whole Story).
 *   C. Confirmation contract: the prompt block lists the replaced lanes'
 *      concerns, the scope, the resolved findings to re-verify and the open
 *      findings; a note that leaves an item unchecked, names a [gap], or omits
 *      the re-run of a resolved finding is not a pass (ADR-054).
 *
 * Usage: node packages/main/dist/tasks/review-delta-round-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Fn = (...args: unknown[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
// Loaded at run time so this smoke compiles (and fails) before the module exists.
async function deltaModule(): Promise<Record<string, unknown>> {
  try { return await import(new URL('../core/review-delta-round.js', import.meta.url).href) as Record<string, unknown>; }
  catch (error) { throw new Error(`core/review-delta-round.js is missing: ${error instanceof Error ? error.message : String(error)}`); }
}
const api = async (name: string): Promise<Fn> => {
  const fn = (await deltaModule())[name];
  assert.equal(typeof fn, 'function', `${name} is exported by core/review-delta-round.ts`);
  return fn as Fn;
};

const dirs: string[] = [];
const ROUND1 = '2026-10-11T10:00:00.000Z';
const ROUND2 = '2026-10-11T11:00:00.000Z';
const STORY = 'B-dr01';
const LANES = ['concept', 'quality', 'test-coverage', 'docs'].map(name => `proof-or-stop-review-${name}`);

const STRS_V1 = [
  'package strs', '', 'import "strings"', '',
  '// Upper returns the upper-case form of s.',
  'func Upper(s string) string { return strings.ToUpper(s) }', '',
  'func reverseRunes(r []rune) {',
  '\tfor i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {',
  '\t\tr[i], r[j] = r[j], r[i]',
  '\t}',
  '}', '',
  '// Reverse returns s reversed by rune.',
  'func Reverse(s string) string {',
  '\tr := []rune(s)',
  '\treverseRunes(r)',
  '\treturn string(r)',
  '}', '',
  '// Shout returns s upper-cased with an exclamation mark.',
  'func Shout(s string) string { return Upper(s) + "?" }', '',
  '// Palindrome reports whether s reads the same reversed.',
  'func Palindrome(s string) bool { return Reverse(s) == s }', '',
].join('\n');
/** The repair: an empty-string guard in Reverse; `seedInside` also seeds a defect inside the repair hunk. */
const strsRepaired = (seedInside: boolean): string => STRS_V1.replace('\tr := []rune(s)\n',
  `\tif s == "" {\n\t\treturn ""\n\t}\n\tr := []rune(s)${seedInside ? '[1:]' : ''}\n`);
const TESTS_V1 = ['package strs', '', 'import "testing"', '', 'func TestReverse(t *testing.T) {', '\tif Reverse("ab") != "ba" {', '\t\tt.Fatal("reverse")', '\t}', '}', ''].join('\n');
const REPAIR_TEST = '\nfunc TestReverseEmpty(t *testing.T) {\n\tif Reverse("") != "" {\n\t\tt.Fatal("empty")\n\t}\n}\n';
const DOC = '# strs\n\n`Reverse` reverses by rune; `Shout` appends "!".\n';

interface Fixture {
  repo: string; base: string; fromHead: string; head: string;
  store: Record<string, Fn>;
  state: { findings: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; receipts: Array<Record<string, unknown>>; runs: Array<Record<string, unknown>> };
}

function fixture(opts: { repair?: 'test' | 'seed-inside' | 'large' | 'new-file'; raisedBy?: string[]; receipt?: boolean; duplicateOfRaised?: boolean } = {}): Fixture {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'delta-round-')));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (message: string) => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  const put = (rel: string, text: string) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
  git('init', '-q', '-b', 'main');
  put('README.md', '# toy\n');
  const base = commit('base');
  git('checkout', '-q', '-b', `story/${STORY}`);
  put('strs/strs.go', STRS_V1);
  put('strs/strs_test.go', TESTS_V1);
  put('docs/strs.md', DOC);
  const fromHead = commit(`${STORY} CHK-001: strs`);
  const repair = opts.repair ?? 'test';
  if (repair === 'large') {
    put('strs/strs_test.go', TESTS_V1 + REPAIR_TEST + Array.from({ length: 40 }, (_, i) => `// regression note ${i}`).join('\n') + '\n');
  } else if (repair === 'new-file') {
    put('strs/extra_test.go', `package strs\n${REPAIR_TEST}`);
  } else {
    put('strs/strs_test.go', TESTS_V1 + REPAIR_TEST);
    put('strs/strs.go', strsRepaired(repair === 'seed-inside'));
  }
  const head = commit(`${STORY} F-001: resolve finding`);
  const raisedBy = opts.raisedBy ?? ['proof-or-stop-review-test-coverage'];
  const runs = [
    ...LANES.map((lane, index) => ({ reviewRunId: `${STORY}:RR-00${index + 1}`, storyId: STORY, lane, reviewRound: ROUND1, headHash: fromHead, materialHash: 'm1', startedAt: `2026-10-11T10:0${index}:00.000Z` })),
    { reviewRunId: `${STORY}:RR-005`, storyId: STORY, lane: 'proof-or-stop-review-topology-critic', reviewPurpose: 'inventory-completeness', reviewRound: ROUND1, headHash: fromHead, materialHash: 'm1', startedAt: '2026-10-11T10:09:00.000Z' },
  ];
  const findings: Array<Record<string, unknown>> = raisedBy.map((lane, index) => ({
    id: `${STORY}:F-00${index + 1}`, desc: 'Reverse("") must return "" (untested empty input).', severity: 'medium', category: 'edge',
    status: 'resolved', evidenceState: 'verified', agent: lane, reviewRound: ROUND1, reviewRunId: runs.find(row => row.lane === lane)?.reviewRunId,
    resolvedAt: '2026-10-11T10:40:00.000Z', resolvedReason: 'commit adds TestReverseEmpty', resolutionType: 'fixed', files: ['strs/strs.go'],
  }));
  if (opts.duplicateOfRaised) {
    // A quality-lane copy the critic marked a duplicate: the quality lane did not raise a (non-duplicate) finding.
    findings.push({ id: `${STORY}:F-009`, desc: 'Reverse("") may index r[-1].', severity: 'medium', category: 'edge', status: 'resolved', evidenceState: 'verified',
      agent: 'proof-or-stop-review-quality', reviewRound: ROUND1, reviewRunId: `${STORY}:RR-002`, resolvedAt: '2026-10-11T10:41:00.000Z', resolutionType: 'duplicate' });
  }
  const receipts = opts.receipt === false ? [] : [{ receiptId: 'RCPT-1', epochId: 'EP-1', storyId: STORY, reviewRound: ROUND1, authority: 'review-remediation-only',
    cutoff: { headHash: fromHead, materialHash: 'm1' }, requiredLanes: LANES, issuedAt: '2026-10-11T10:20:00.000Z', consumedAt: '2026-10-11T10:30:00.000Z' }];
  const state = { findings, events: [] as Array<Record<string, unknown>>, receipts, runs: runs as Array<Record<string, unknown>> };
  const store: Record<string, Fn> = {
    readStory: () => ({ id: STORY, phase: 'REVIEW', currentReviewRound: ROUND2, integrationTarget: { parentCommitAtCreation: base } }),
    readReviewRuns: () => ({ runs: state.runs }),
    readFindings: () => ({ findings: state.findings }),
    readReviewInventoryEpochs: () => ({ epochs: [{ epochId: 'EP-1', reviewRound: ROUND1, receiptId: 'RCPT-1', consumedAt: '2026-10-11T10:30:00.000Z', requiredLanes: LANES }],
      receipts: state.receipts, criticReceipts: opts.duplicateOfRaised ? [{ epochId: 'EP-1', wave: 1, findingDispositions: [{ findingId: `${STORY}:F-009`, disposition: 'duplicate', canonicalFindingId: `${STORY}:F-001`, reason: 'same defect' }] }] : [] }),
    readProcessEvents: () => state.events,
  };
  return { repo, base, fromHead, head, store, state };
}

function projectWith(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'delta-round-config-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify(config));
  return dir;
}
const ON = () => projectWith({ review: { deltaRounds: 'on' } });

async function plan(f: Fixture, projectRoot: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const compute = await api('computeDeltaRoundPlan');
  return compute({ store: f.store, projectRoot, gitCwd: f.repo, storyId: STORY, activeLanes: LANES, ...extra });
}

await check('P1 switch on: the raising lane re-reviews in full, the other lanes are replaced by ONE confirmation lane', async () => {
  const f = fixture();
  const p = await plan(f, ON());
  assert.equal(p.eligible, true, `eligible (reason ${p.reason}: ${p.detail})`);
  assert.deepEqual(p.fullLanes, ['proof-or-stop-review-test-coverage']);
  assert.deepEqual(p.replacedLanes, ['proof-or-stop-review-concept', 'proof-or-stop-review-quality', 'proof-or-stop-review-docs']);
  assert.equal(p.confirmationLane, 'proof-or-stop-review-concept', 'the first replaced lane in roster order carries the confirmation');
  assert.deepEqual(p.selectedLanes, ['proof-or-stop-review-concept', 'proof-or-stop-review-test-coverage'], 'roster order kept');
  assert.equal(p.previousRound, ROUND1);
  assert.equal(p.fromHead, f.fromHead);
  assert.deepEqual(p.reverifyFindingIds, [`${STORY}:F-001`], 'the finding resolved in the remediation is re-verified');
  for (const item of ['concern:concept', 'concern:quality', 'concern:docs', 'file:strs/strs.go', 'file:strs/strs_test.go']) {
    assert.ok(p.checkItems.includes(item), `check item ${item} (got ${p.checkItems.join(', ')})`);
  }
  assert.ok(!p.checkItems.includes('concern:test-coverage'), 'the full lane checks its own concern');
  assert.match(String(p.planDigest), /^[0-9a-f]{64}$/);
  assert.deepEqual(p.abVariant?.flags, { 'review.deltaRounds': 'on' }, 'the arm is recorded');
  const again = await plan(f, ON());
  assert.equal(again.planDigest, p.planDigest, 'deterministic');
});

await check('P2 switch off / malformed: no delta round (production full roster)', async () => {
  const f = fixture();
  assert.equal((await plan(f, projectWith({}))).eligible, false);
  assert.equal((await plan(f, projectWith({}))).reason, 'DELTA_ROUNDS_OFF');
  assert.equal((await plan(f, projectWith({ review: { deltaRounds: 'yes' } }))).reason, 'DELTA_ROUNDS_OFF', 'malformed = off');
  const { resolveAbVariants, abVariantEvidence, deltaRoundsOn } = await import(new URL('../core/ab-variants.js', import.meta.url).href) as Record<string, Fn>;
  assert.equal(resolveAbVariants({}).deltaRounds, 'off');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ review: { deltaRounds: 'on' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.deltaRounds': 'on' } });
  assert.throws(() => resolveAbVariants({ review: { deltaRounds: 'maybe' } }), /invalid_ab_variant_config: review\.deltaRounds/);
  assert.equal(typeof deltaRoundsOn, 'function');
  assert.equal(deltaRoundsOn({ review: { deltaRounds: 'maybe' } }), false, 'malformed keeps production (off) where it is consumed');
  assert.equal(deltaRoundsOn({ review: { deltaRounds: 'on' } }), true);
});

await check('P3 a duplicate (critic) or dismissed finding does not keep its lane full; forced lanes stay full', async () => {
  const p = await plan(fixture({ duplicateOfRaised: true }), ON());
  assert.deepEqual(p.fullLanes, ['proof-or-stop-review-test-coverage'], 'the quality copy is a duplicate');
  const forced = await plan(fixture(), ON(), { forcedLanes: ['proof-or-stop-review-docs'] });
  assert.deepEqual(forced.fullLanes, ['proof-or-stop-review-test-coverage', 'proof-or-stop-review-docs']);
  assert.deepEqual(forced.replacedLanes, ['proof-or-stop-review-concept', 'proof-or-stop-review-quality']);
});

await check('F1 large repair (> 50% of the Story diff lines) falls back to a full round', async () => {
  const p = await plan(fixture({ repair: 'large' }), ON());
  assert.equal(p.eligible, false);
  assert.equal(p.reason, 'REPAIR_DIFF_LARGE', p.detail);
  assert.match(p.detail, /\d+ changed line\(s\).*\d+ .*50%/);
});

await check('F2 a repaired file outside the previous material falls back to a full round', async () => {
  const p = await plan(fixture({ repair: 'new-file' }), ON());
  assert.equal(p.reason, 'REPAIR_TOUCHES_NEW_FILES', p.detail);
  assert.match(p.detail, /strs\/extra_test\.go/);
});

await check('F3 a recorded confirmation gap of this round falls back to a full round; a gap of another round does not', async () => {
  const f = fixture();
  const { DELTA_ROUND_GAP_EVENT } = await deltaModule() as { DELTA_ROUND_GAP_EVENT: string };
  assert.equal(DELTA_ROUND_GAP_EVENT, 'delta_round_confirmation_gap');
  f.state.events.push({ type: DELTA_ROUND_GAP_EVENT, reviewRound: ROUND1, timestamp: ROUND1 });
  assert.equal((await plan(f, ON())).eligible, true, 'another round');
  f.state.events.push({ type: DELTA_ROUND_GAP_EVENT, reviewRound: ROUND2, timestamp: ROUND2 });
  const p = await plan(f, ON());
  assert.equal(p.reason, 'CONFIRMATION_GAP');
});

await check('F4 every lane raised findings / no remediation receipt / first round: full round', async () => {
  assert.equal((await plan(fixture({ raisedBy: LANES }), ON())).reason, 'NO_REPLACEABLE_LANE');
  assert.equal((await plan(fixture({ receipt: false }), ON())).reason, 'NO_REMEDIATION');
  const first = fixture();
  first.state.runs = first.state.runs.map(row => ({ ...row, reviewRound: ROUND2 }));
  assert.equal((await plan(first, ON())).reason, 'NO_PREVIOUS_ROUND');
  const invalid = await plan(fixture(), ON(), { verifyReceipt: () => false });
  assert.equal(invalid.reason, 'RECEIPT_INVALID');
});

await check('S1 scope: repair hunks + enclosing definition + same-file callers and callees; a seed INSIDE the repair diff is in scope, one OUTSIDE it is not (documented limit)', async () => {
  const f = fixture({ repair: 'seed-inside' });
  const scopeOf = await api('deltaRoundScope');
  const scope = scopeOf(f.repo, f.repo, f.fromHead, f.head) as Array<{ path: string; regions: Array<{ kind: string; name?: string; startLine: number; endLine: number }> }>;
  const strs = scope.find(row => row.path === 'strs/strs.go');
  assert.ok(strs, `strs.go in scope: ${JSON.stringify(scope.map(row => row.path))}`);
  const names = (kind: string) => strs!.regions.filter(row => row.kind === kind).map(row => row.name);
  assert.ok(strs!.regions.some(row => row.kind === 'hunk'), 'the hunk itself');
  assert.deepEqual(names('enclosing'), ['Reverse']);
  assert.ok(names('callee').includes('reverseRunes'), `callee reverseRunes (got ${JSON.stringify(strs!.regions)})`);
  assert.ok(names('caller').includes('Palindrome'), 'caller Palindrome');
  for (const outside of ['Upper', 'Shout']) assert.ok(!strs!.regions.some(row => row.name === outside), `${outside} is outside the delta scope`);
  const headLines = strsRepaired(true).split('\n');
  const seedInside = headLines.findIndex(line => line.includes('[]rune(s)[1:]')) + 1;
  const seedOutside = headLines.findIndex(line => line.includes('+ "?"')) + 1;
  const covered = (line: number) => strs!.regions.some(row => row.startLine <= line && line <= row.endLine);
  assert.ok(covered(seedInside), `seed inside the repair diff (line ${seedInside}) is in the confirmation scope`);
  assert.ok(!covered(seedOutside), `seed outside the repair diff (line ${seedOutside}, present since round 1) is NOT in the confirmation scope: only the full lanes re-read it`);
  const tests = scope.find(row => row.path === 'strs/strs_test.go');
  assert.ok(tests?.regions.some(row => row.kind === 'enclosing' && row.name === 'TestReverseEmpty'), 'the added test is in scope');
});

await check('C1 confirmation prompt block: concerns of the replaced lanes, the scope, resolved findings to re-run, the note contract', async () => {
  const f = fixture();
  const p = await plan(f, ON());
  const render = await api('renderDeltaConfirmationBlock');
  const text = (render(p, STORY) as string[]).join('\n');
  assert.match(text, /--- BEGIN DELTA ROUND CONFIRMATION/);
  assert.match(text, /concern:quality/);
  assert.match(text, /concern:docs/);
  assert.match(text, /file:strs\/strs\.go/);
  assert.match(text, /enclosing func Reverse|Reverse \(enclosing/);
  assert.match(text, /F-001/);
  assert.match(text, /\[checked\] <item>/);
  assert.match(text, /\[reverified\] <finding id> :: <exact command> :: <exact output line/);
  assert.match(text, /\[gap\]/);
  assert.match(text, /NOT a pass/);
  assert.match(text, /test-coverage/, 'names the lane that re-reviews in full');
});

await check('C2 note check: missing item, [gap], missing re-run, unread file are each not a pass; full coverage is', async () => {
  const f = fixture();
  const p = await plan(f, ON());
  const bindingOf = await api('deltaRoundBinding');
  const binding = bindingOf(p, 'confirmation');
  assert.equal(binding.role, 'confirmation');
  const checkNote = await api('checkDeltaConfirmationNote');
  const readManifest = { filesReadFully: ['strs/strs.go', 'strs/strs_test.go'], filesTriagedByName: [] };
  const full = [
    ...binding.checkItems.map((item: string) => `[checked] ${item} :: read the hunk and its callers`),
    '[reverified] F-001 :: go test -v ./strs -run TestReverseEmpty :: --- PASS: TestReverseEmpty',
  ].join('\n');
  const ok = checkNote({ binding, storyId: STORY, note: `Delta confirmation.\n${full}`, readManifest });
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(ok.gaps, []);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.reverify, [{ findingId: `${STORY}:F-001`, command: 'go test -v ./strs -run TestReverseEmpty', selector: '--- PASS: TestReverseEmpty' }]);
  const missing = checkNote({ binding, storyId: STORY, note: full.replace(/\[checked\] concern:docs[^\n]*\n/, ''), readManifest });
  assert.deepEqual(missing.missing, ['concern:docs']);
  const gap = checkNote({ binding, storyId: STORY, note: `${full}\n[gap] concern:docs :: did not open the docs`, readManifest });
  assert.deepEqual(gap.gaps, ['concern:docs :: did not open the docs']);
  const noRerun = checkNote({ binding, storyId: STORY, note: full.replace(/\[reverified\][^\n]*/, ''), readManifest });
  assert.ok(noRerun.problems.some((row: string) => /F-001.*no \[reverified\]/.test(row)), JSON.stringify(noRerun.problems));
  const generic = checkNote({ binding, storyId: STORY, note: full.replace('--- PASS: TestReverseEmpty', 'ok'), readManifest });
  assert.ok(generic.problems.some((row: string) => /generic/.test(row)), JSON.stringify(generic.problems));
  const unread = checkNote({ binding, storyId: STORY, note: full, readManifest: { filesReadFully: ['strs/strs.go'], filesTriagedByName: [] } });
  assert.ok(unread.problems.some((row: string) => /strs\/strs_test\.go.*read manifest/.test(row)), JSON.stringify(unread.problems));
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.log(`review-delta-round-smoke: FAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('review-delta-round-smoke: PASS');
