import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { buildValidationPinUniverse, parseLegacyValidationCommandString, resolveValidationCommandPin } from '../../core/validation-command-identity.js';




import { configuredValidationCommands } from '../../handlers/verifier.js';





import { FULL_SUITE_ENTRIES, entriesFromSerialReference, parseSerialReference } from '../full-suite-runner.js';


import { describeRedGreenViolations, evaluateRedGreenCommitOrder, parseRedGreenSubject } from '../../core/red-green-commit-guard.js';







import { beginSection, testCase, gitOutput, declaredChecklistItems, NO_RED_REASON, temporaryRoots, writeFixtureFile, fixtureGit, readRedGreenCommits, redGreenFixtureRepo, redGreenFixtureCommit, priorRedIds, evaluateBranchRedGreen, QUALIFIED_RED_SUBJECT_GREP, planCliTool, schemaFieldIsConstrained, ZOD_BYPASS_COVERAGE, planCliRoot, planCli, PLAN_CLI_STORY_ID, DONEWHEN_COVERAGE, passedCases, DEFAULT_STDOUT_BOUND_CASE_NAME, DEFAULT_STDOUT_BOUND_CHARS, MARKER, capturedStdoutChars, verboseOnlyChars } from "./support.js";
export function runAcceptanceGuards(): void {


// ---------------------------------------------------------------------------
// CHK-006 — cross-cutting acceptance guards. These do not test one item; they
// hold the Story's PROCESS and COVERAGE claims to a mechanical standard, so a
// later change cannot quietly retire one of them.
//
//  (39) RED-BEFORE-GREEN ORDERING — for every checklist item this suite declares
//       a section for, a failing-fixture commit must PRECEDE the implementing
//       commit in git history. The item list is DERIVED from the suite's own
//       section headers, so adding a seventh item without its RED commit fails
//       here instead of passing vacuously on a hardcoded count.
//  (40) ZOD-BYPASS REJECTION — every new handler field carrying a zod
//       min/max/enum constraint is DISCOVERED by probing the catalog schema, and
//       each discovered field must be refused at the handler entry AND at every
//       consuming core entry when the schema is bypassed entirely. A new
//       constrained field with no bypass coverage fails closed.
//  (41) DONEWHEN COVERAGE — every DoneWhen line of CHK-001..CHK-005 is mapped to
//       the fixture case(s) that prove it, and each cited case must have actually
//       run and passed in this process.
// ---------------------------------------------------------------------------

beginSection('CHK-006 cross-cutting acceptance guards', { perCase: true });


testCase('a RED fixture commit precedes the implementing commit for every item this suite declares', () => {
  const repoRoot = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(repoRoot, 'this guard needs real git history; a missing repository is a failure, not a skip');

  const items = declaredChecklistItems(repoRoot);
  assert.ok(items.length > 0, 'the item list must be derived from the suite sections, and it must not be empty');

  // Prefer the Story branch range; once merged the same commits are reachable from
  // history, so fall back to a subject-filtered whole-history scan rather than
  // passing vacuously on an empty range.
  const rangeSubjects = (gitOutput(['log', '--format=%s', 'main..HEAD']) ?? '').split('\n').filter(Boolean);
  // A later story's branch legitimately reuses CHK-nnn ids for ITS items, so
  // the range is used only while it carries a GREEN for every item declared here.
  const rangeCoversDeclared = items.every((item) => rangeSubjects.some((subject) => subject.startsWith(`GREEN(${item}):`)));
  const subjects = rangeCoversDeclared
    ? rangeSubjects
    : (gitOutput(['log', '-E', '--format=%s', '--grep=^(RED|GREEN)\\(CHK-[0-9]{3}\\):']) ?? '').split('\n').filter(Boolean);
  assert.ok(subjects.length > 0, 'no RED/GREEN commit subjects were readable; the ordering claim cannot be proven');

  // git log is newest first; read oldest first so "precedes" means what it says.
  const chronological = [...subjects].reverse();
  for (const item of items) {
    const firstRed = chronological.findIndex((subject) => subject.startsWith(`RED(${item}):`));
    const firstGreen = chronological.findIndex((subject) => subject.startsWith(`GREEN(${item}):`));
    assert.notEqual(firstGreen, -1, `${item} has no GREEN commit; the suite declares a section for it`);
    assert.notEqual(firstRed, -1, `${item} has no RED commit; a failing fixture must exist before the implementation`);
    assert.ok(
      firstRed < firstGreen,
      `${item}: the RED fixture commit must PRECEDE the implementing commit (red@${firstRed}, green@${firstGreen}); squashing them is what this guard forbids`,
    );
  }
});


testCase('guard fixtures: GREEN without RED, squashed pair, bare marker fail; reasoned marker passes', () => {
  // (a) a GREEN(F-nnn) with no RED anywhere before it.
  const bare = evaluateRedGreenCommitOrder([
    { subject: 'RED(CHK-001): a fixture fails', body: '' },
    { subject: 'GREEN(CHK-001): the fix', body: '' },
    { subject: 'GREEN(F-004): reword a gloss', body: '' },
  ]);
  assert.equal(bare.ok, false, 'a GREEN(F-nnn) with no preceding RED must fail');
  assert.deepEqual(bare.violatingIds, ['F-004']);
  assert.match(describeRedGreenViolations(bare), /F-004/);

  // (b) the RED squashed into the GREEN: only the GREEN subject survives and the
  //     old RED subject is just a body line, which must NOT count as a RED.
  const squashed = evaluateRedGreenCommitOrder([
    { subject: 'GREEN(F-007): the fix', body: 'RED(F-007): the fixture fails before the fix\n\nsquashed\n' },
  ]);
  assert.equal(squashed.ok, false, 'a body line that looks like a RED subject is not a RED commit');
  assert.deepEqual(squashed.violatingIds, ['F-007']);

  // (c) the marker without a reason, and with a reason that is too short.
  const bareMarker = evaluateRedGreenCommitOrder([
    { subject: 'GREEN(F-011): fix a stale comment', body: 'No-RED:\n' },
  ]);
  assert.equal(bareMarker.ok, false, 'No-RED without a reason must fail');
  assert.deepEqual(bareMarker.violatingIds, ['F-011']);
  const shortMarker = evaluateRedGreenCommitOrder([
    { subject: 'GREEN(F-011): fix a stale comment', body: 'No-RED: comment only\n' },
  ]);
  assert.equal(shortMarker.ok, false, 'a No-RED reason shorter than 30 characters must fail');
  assert.deepEqual(shortMarker.violatingIds, ['F-011']);

  // (d) the marker with a real reason, on a GREEN that has no RED.
  const reasoned = evaluateRedGreenCommitOrder([
    { subject: 'GREEN(F-011): fix a stale comment', body: `Reword the comment.\n\nNo-RED: ${NO_RED_REASON}\n` },
  ]);
  assert.equal(reasoned.ok, true, `a reasoned No-RED marker must pass: ${describeRedGreenViolations(reasoned)}`);
  assert.deepEqual(reasoned.violatingIds, []);

  // A RED earlier in history but not adjacent still satisfies a later GREEN.
  const distant = evaluateRedGreenCommitOrder([
    { subject: 'RED(F-009): the fixture fails', body: '' },
    { subject: 'RED(CHK-002): another fixture', body: '' },
    { subject: 'GREEN(CHK-002): another fix', body: '' },
    { subject: 'GREEN(F-009): the fix', body: '' },
  ]);
  assert.equal(distant.ok, true, describeRedGreenViolations(distant));
  assert.equal(parseRedGreenSubject('chore: unrelated'), null, 'a non RED/GREEN subject is ignored');
});


testCase('a temp repository with RED(F-007) squashed into its GREEN fails naming F-007', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-red-green-squash-'));
  temporaryRoots.push(root);
  writeFixtureFile(root, 'README.md', '# red-green squash fixture\n');
  fixtureGit(root, ['init', '-q']);
  fixtureGit(root, ['checkout', '-q', '-B', 'main']);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'base']);
  fixtureGit(root, ['checkout', '-q', '-b', 'story/B-fixture']);
  writeFixtureFile(root, 'fixture.test.txt', 'expect: fails\n');
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'RED(F-007): the fixture fails before the fix']);
  writeFixtureFile(root, 'fix.txt', 'fixed\n');
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'GREEN(F-007): the fix']);

  // Before the squash the pair is ordered and the guard passes.
  const ordered = evaluateRedGreenCommitOrder(readRedGreenCommits(root, ['main..HEAD']));
  assert.equal(ordered.ok, true, `ordered RED then GREEN must pass: ${describeRedGreenViolations(ordered)}`);

  // Squash: one commit survives under the GREEN subject, the RED subject is a body line.
  fixtureGit(root, ['reset', '-q', '--soft', 'main']);
  fixtureGit(root, ['commit', '-q', '-m', 'GREEN(F-007): the fix', '-m', 'RED(F-007): the fixture fails before the fix\n\nsquashed']);
  const commits = readRedGreenCommits(root, ['main..HEAD']);
  assert.equal(commits.length, 1, 'the squash must leave exactly one commit on the story branch');
  const result = evaluateRedGreenCommitOrder(commits);
  assert.equal(result.ok, false, 'the squashed pair must fail the guard');
  assert.deepEqual(result.violatingIds, ['F-007']);
  assert.match(describeRedGreenViolations(result), /F-007/, 'the failure text must name the finding id');
});


testCase('prior-RED acceptance is story-qualified: GREEN(B-xxxx:id) with a prior RED(B-xxxx:id) passes; bare ids and other stories fail', () => {
  // The helper stays pure: the caller hands it the STORY-QUALIFIED ids that have a RED
  // subject in the branch point's history. Ids restart at CHK-001 / F-001 in every
  // story, so a bare id in the prior set would let an unrelated merged story's RED
  // satisfy this branch's GREEN (B-dc2e F-008): only an equal qualified id counts.
  const evaluate = evaluateRedGreenCommitOrder;
  const qualifiedPrior = new Set(['B-dc2e:CHK-001']);
  const inRange = [{ subject: 'GREEN(B-dc2e:CHK-001): the fix on the story branch', body: '' }];
  assert.equal(evaluate(inRange).ok, false, 'the range alone genuinely lacks the RED, so without the prior set it still fails');
  // (b) qualified GREEN with the SAME story's qualified RED before the range: accepted.
  const satisfied = evaluate(inRange, { priorRedIds: qualifiedPrior });
  assert.equal(satisfied.ok, true, `a GREEN whose qualified id has a RED before the branch point must pass: ${describeRedGreenViolations(satisfied)}`);
  assert.deepEqual(satisfied.violatingIds, []);
  assert.deepEqual(satisfied.priorRedAccepted, [{ index: 0, id: 'B-dc2e:CHK-001' }], 'the result names the GREEN satisfied by a RED before the range');
  assert.match(describeRedGreenViolations(satisfied), /1 satisfied by a RED before the range/);
  // (a) an UNQUALIFIED GREEN(CHK-001) is never satisfied by an unrelated bare RED(CHK-001) in the prior set.
  const bareCollision = evaluate([{ subject: 'GREEN(CHK-001): fabricated, never observed a failing CHK-001 fixture', body: '' }], { priorRedIds: new Set(['CHK-001']) });
  assert.equal(bareCollision.ok, false, 'a bare GREEN(CHK-001) must not be satisfied by any bare RED(CHK-001) before the range: ids restart per story');
  assert.deepEqual(bareCollision.violatingIds, ['CHK-001']);
  assert.deepEqual(bareCollision.priorRedAccepted, []);
  // (c) a qualified GREEN is not satisfied by ANOTHER story's qualified RED with the same item number.
  const otherStory = evaluate(inRange, { priorRedIds: new Set(['B-0ther:CHK-001', 'B-1234:CHK-001']) });
  assert.equal(otherStory.ok, false, 'GREEN(B-dc2e:CHK-001) must not be satisfied by RED(B-1234:CHK-001) from another story');
  assert.deepEqual(otherStory.violatingIds, ['B-dc2e:CHK-001']);
  // A bare GREEN is not rescued by a qualified RED of the same number either.
  const bareGreen = evaluate([{ subject: 'GREEN(CHK-001): bare', body: '' }], { priorRedIds: qualifiedPrior });
  assert.equal(bareGreen.ok, false, 'a bare GREEN(CHK-001) cannot borrow RED(B-dc2e:CHK-001) from the prior set');
  // An id with no RED anywhere is still a violation, prior set or not.
  const other = evaluate([{ subject: 'GREEN(B-dc2e:CHK-002): no RED anywhere', body: '' }], { priorRedIds: qualifiedPrior });
  assert.equal(other.ok, false, 'a GREEN whose id is not in the prior set and has no RED in range must still fail');
  assert.deepEqual(other.violatingIds, ['B-dc2e:CHK-002']);
  // The No-RED marker rule is unchanged: a bare marker fails even when a prior set is supplied.
  const bareMarker = evaluate([{ subject: 'GREEN(F-011): fix a stale comment', body: 'No-RED:\n' }], { priorRedIds: qualifiedPrior });
  assert.equal(bareMarker.ok, false, 'No-RED without a reason must still fail');
  assert.deepEqual(bareMarker.violatingIds, ['F-011']);
});


testCase('a temp repository with RED(B-dc2e:CHK-001) on main before the branch point accepts the branch GREEN(B-dc2e:CHK-001); a bare RED(CHK-001) there rescues nothing', () => {
  const root = redGreenFixtureRepo('proof-or-stop-red-green-prior-');
  // main carries the story's OWN qualified RED and an unrelated merged story's bare RED(CHK-001).
  redGreenFixtureCommit(root, 'fixture.test.txt', 'RED(B-dc2e:CHK-001): the fixture fails, committed on main');
  redGreenFixtureCommit(root, 'unrelated.test.txt', 'RED(CHK-001): an unrelated merged story fixture fails');
  redGreenFixtureCommit(root, 'unrelated-other.test.txt', 'RED(B-1234:CHK-002): another story fixture fails');
  fixtureGit(root, ['checkout', '-q', '-b', 'story/B-dc2e']);
  redGreenFixtureCommit(root, 'fix.txt', 'GREEN(B-dc2e:CHK-001): the fix on the story branch');

  const rangeOnly = readRedGreenCommits(root, ['main..HEAD']);
  assert.deepEqual(rangeOnly.map((commit) => commit.subject), ['GREEN(B-dc2e:CHK-001): the fix on the story branch'], 'main..HEAD excludes the RED that sits on main');
  assert.deepEqual([...priorRedIds(root)].sort(), ['B-1234:CHK-002', 'B-dc2e:CHK-001'], 'the prior set carries only STORY-QUALIFIED RED ids; the bare RED(CHK-001) is not collected');
  const accepted = evaluateBranchRedGreen(root);
  assert.equal(accepted.ok, true, `the branch GREEN must be satisfied by the same story's RED before the branch point: ${describeRedGreenViolations(accepted)}`);
  assert.deepEqual(accepted.priorRedAccepted, [{ index: 0, id: 'B-dc2e:CHK-001' }]);

  // (a) a bare GREEN(CHK-001) on the branch is NOT satisfied by main's bare RED(CHK-001).
  redGreenFixtureCommit(root, 'bare.txt', 'GREEN(CHK-001): fabricated, never observed a failing CHK-001 fixture');
  const bare = evaluateBranchRedGreen(root);
  assert.equal(bare.ok, false, 'a bare GREEN(CHK-001) must fail even though an unrelated bare RED(CHK-001) is reachable from the merge-base');
  assert.deepEqual(bare.violatingIds, ['CHK-001']);
  // (c) a qualified GREEN is not satisfied by another story's RED of the same number.
  redGreenFixtureCommit(root, 'other-story.txt', 'GREEN(B-dc2e:CHK-002): borrows RED(B-1234:CHK-002)');
  const otherStory = evaluateBranchRedGreen(root);
  assert.equal(otherStory.ok, false, 'GREEN(B-dc2e:CHK-002) must not be satisfied by RED(B-1234:CHK-002)');
  assert.deepEqual(otherStory.violatingIds, ['CHK-001', 'B-dc2e:CHK-002']);
  // Control: a branch GREEN with no RED anywhere in history still fails, naming itself.
  redGreenFixtureCommit(root, 'other.txt', 'GREEN(B-dc2e:CHK-003): no RED anywhere');
  const control = evaluateBranchRedGreen(root);
  assert.equal(control.ok, false, 'a GREEN with no RED anywhere must still fail');
  assert.deepEqual(control.violatingIds, ['CHK-001', 'B-dc2e:CHK-002', 'B-dc2e:CHK-003']);
});


testCase('merge-base movement: a RED on main after the branch point satisfies the branch GREEN only after git merge main, and only when story-qualified', () => {
  // (d) `git merge main` is required before DONE, and it MOVES merge-base(main, HEAD).
  // A RED that lands on main after the branch point is invisible before the merge and
  // must not rescue a GREEN; after the merge it counts only for the same story.
  const root = redGreenFixtureRepo('proof-or-stop-red-green-merge-base-');
  fixtureGit(root, ['checkout', '-q', '-b', 'story/B-dc2e']);
  redGreenFixtureCommit(root, 'fix-1.txt', 'GREEN(B-dc2e:CHK-001): the fix, RED still only on main');
  redGreenFixtureCommit(root, 'fix-2.txt', 'GREEN(B-dc2e:F-001): the fix, another story RED on main');
  redGreenFixtureCommit(root, 'fix-3.txt', 'GREEN(CHK-002): bare fix, bare RED on main');
  fixtureGit(root, ['checkout', '-q', 'main']);
  redGreenFixtureCommit(root, 'main-red-1.txt', 'RED(B-dc2e:CHK-001): the fixture fails, landed on main after the branch point');
  redGreenFixtureCommit(root, 'main-red-2.txt', 'RED(B-1234:F-001): another story fixture fails');
  redGreenFixtureCommit(root, 'main-red-3.txt', 'RED(CHK-002): a bare fixture fails');
  fixtureGit(root, ['checkout', '-q', 'story/B-dc2e']);

  assert.deepEqual([...priorRedIds(root)], [], 'before the merge none of main\'s new REDs is reachable from the merge-base');
  const before = evaluateBranchRedGreen(root);
  assert.equal(before.ok, false, 'before git merge main every branch GREEN lacks its RED');
  assert.deepEqual(before.violatingIds, ['B-dc2e:CHK-001', 'B-dc2e:F-001', 'CHK-002']);

  fixtureGit(root, ['merge', '-q', '--no-edit', '--no-ff', 'main']);
  assert.deepEqual([...priorRedIds(root)].sort(), ['B-1234:F-001', 'B-dc2e:CHK-001'], 'after the merge only the qualified REDs are collected; the bare RED(CHK-002) is not');
  const after = evaluateBranchRedGreen(root);
  assert.equal(after.ok, false, 'after the merge only the same-story qualified GREEN is satisfied');
  assert.deepEqual(after.priorRedAccepted, [{ index: 0, id: 'B-dc2e:CHK-001' }], 'GREEN(B-dc2e:CHK-001) is satisfied by the same story\'s RED that the merge made reachable');
  assert.deepEqual(after.violatingIds, ['B-dc2e:F-001', 'CHK-002'], 'another story\'s RED(B-1234:F-001) and the bare RED(CHK-002) rescue nothing');
});


testCase('priorRedIds on this real repository does not throw and matches an independent bounded git query', () => {
  const base = (gitOutput(['merge-base', 'main', 'HEAD']) ?? '').trim();
  assert.ok(base, 'this case needs a real merge-base between main and HEAD');
  const independent = execFileSync(
    'git',
    ['log', '--format=%s', '-E', `--grep=${QUALIFIED_RED_SUBJECT_GREP}`, base],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 },
  ).split('\n').map((line) => parseRedGreenSubject(line.trim())).filter((parsed) => parsed?.phase === 'RED').map((parsed) => parsed!.id);
  let collected: ReadonlySet<string> | null = null;
  assert.doesNotThrow(() => { collected = priorRedIds(null); }, 'priorRedIds must not throw on the real repository');
  assert.deepEqual([...collected!].sort(), [...new Set(independent)].sort(), 'the prior set must equal the qualified RED ids reachable from the merge-base, never a silently empty set');
});


testCase('priorRedIds reads a merge-base history whose matching subjects exceed 1 MB (the default execFileSync maxBuffer)', () => {
  const root = redGreenFixtureRepo('proof-or-stop-red-green-big-history-');
  const padding = 'x'.repeat(100_000);
  const expected: string[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const id = `B-f0f7:F-${String(index).padStart(3, '0')}`;
    expected.push(id);
    writeFixtureFile(root, `fixture-${index}.txt`, `${id}\n`);
    writeFixtureFile(root, 'message.txt', `RED(${id}): ${padding}\n`);
    fixtureGit(root, ['add', 'fixture-' + index + '.txt']);
    fixtureGit(root, ['commit', '-q', '-F', 'message.txt']);
  }
  for (let index = 1; index <= 4; index += 1) {
    writeFixtureFile(root, `noise-${index}.txt`, `${index}\n`);
    writeFixtureFile(root, 'message.txt', `chore: unrelated ${padding}\n`);
    fixtureGit(root, ['add', 'noise-' + index + '.txt']);
    fixtureGit(root, ['commit', '-q', '-F', 'message.txt']);
  }
  fixtureGit(root, ['checkout', '-q', '-b', 'story/B-f0f7']);
  redGreenFixtureCommit(root, 'fix.txt', 'GREEN(B-f0f7:F-001): the fix on the story branch');
  const matching = execFileSync(
    'git',
    ['log', '--format=%s', '-E', `--grep=${QUALIFIED_RED_SUBJECT_GREP}`, 'main'],
    { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 },
  );
  assert.ok(matching.length > 1024 * 1024, `the matching subjects alone must exceed 1 MB to exercise the buffer (got ${matching.length} bytes)`);
  assert.deepEqual([...priorRedIds(root)].sort(), expected.sort(), 'every qualified RED below the merge-base must be collected despite the > 1 MB subject volume');
  const accepted = evaluateBranchRedGreen(root);
  assert.equal(accepted.ok, true, `the branch GREEN must be satisfied through the large history: ${describeRedGreenViolations(accepted)}`);
});


testCase('priorRedIds raises when the git call fails instead of returning an empty set', () => {
  // A repository with no `main` branch: merge-base fails. Silence here would turn
  // every GREEN into a false green_without_red (or, with the old whole-history read,
  // hide a buffer overflow); the smoke must fail loudly naming git.
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-red-green-git-failure-'));
  temporaryRoots.push(root);
  writeFixtureFile(root, 'README.md', '# no main branch\n');
  fixtureGit(root, ['init', '-q']);
  fixtureGit(root, ['checkout', '-q', '-B', 'trunk']);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'base']);
  assert.throws(() => priorRedIds(root), /git/, 'a failing git call must raise, never degrade to an empty prior set');
  const notARepo = mkdtempSync(join(tmpdir(), 'proof-or-stop-red-green-not-a-repo-'));
  temporaryRoots.push(notARepo);
  assert.throws(() => priorRedIds(notARepo), /git/, 'a directory that is not a repository must raise as well');
});


testCase('main..HEAD passes the RED-before-GREEN helper', () => {
  const range = readRedGreenCommits(null, ['main..HEAD']);
  // Once merged the range is empty; fall back to the subject-filtered whole
  // history rather than passing vacuously.
  const usingRange = range.some((commit) => parseRedGreenSubject(commit.subject) !== null);
  const commits = usingRange
    ? range
    : readRedGreenCommits(null, ['-E', '--grep=^(RED|GREEN)\\(']);
  assert.ok(commits.length > 0, 'no RED/GREEN commits were readable; the ordering claim cannot be proven');
  const result = usingRange ? evaluateBranchRedGreen(null) : evaluateRedGreenCommitOrder(commits);
  assert.equal(result.ok, true, describeRedGreenViolations(result));
  console.log('[PASS] RED-before-GREEN guard: every GREEN(CHK-nnn) and GREEN(F-nnn) subject on main..HEAD has a preceding RED or a no-RED marker with a reason');
});


testCase('every zod-constrained validation_plan field is still rejected when the schema is bypassed', () => {
  const tool = planCliTool();
  const constrained = Object.entries(tool.schema as Record<string, z.ZodType>)
    .filter(([, field]) => schemaFieldIsConstrained(field))
    .map(([key]) => key)
    .sort();

  // Non-vacuity: the discovery probe must find the fields we know carry constraints.
  for (const expected of ['storyId', 'tier']) {
    assert.ok(constrained.includes(expected), `${expected} carries a zod constraint and must be discovered by probing`);
  }

  for (const key of constrained) {
    const cover = ZOD_BYPASS_COVERAGE[key];
    assert.ok(
      cover,
      `validation_plan.${key} carries a zod constraint with no schema-bypass coverage; ` +
      'the Handler encoding convention requires a runtime re-check at the handler entry AND at every consuming core entry',
    );
    cover();
  }

  // Coverage entries may not outlive their field either.
  for (const key of Object.keys(ZOD_BYPASS_COVERAGE)) {
    assert.ok(constrained.includes(key), `stale bypass coverage for a field that no longer carries a constraint: ${key}`);
  }
});


// ---------------------------------------------------------------------------
// (42) REAL REGISTRATION (load-bearing) — CHK-006's verification intent says the
//      registration is proven by the bidirectional membership check rather than
//      by inspection. `full-suite-runner-smoke` cannot prove that: it rebuilds
//      `fixtureScripts['test:serial-reference']` FROM `FULL_SUITE_ENTRIES`, so
//      the two authorities it compares are the same object and can never
//      disagree. It reported PASS while `test:validation-tier-planner` sat in the
//      real chain with no RESOURCE_POLICY row.
//
//      So this case reads the REAL root package.json chain and the REAL
//      RESOURCE_POLICY and asserts the relationship directly. Deleting the
//      `repoRead('test:validation-tier-planner')` row must fail HERE — that is
//      the exact scenario the existing smoke let through.
//
//      Scope: assert the real relationship. Repairing full-suite-runner-smoke's
//      synthetic-fixture blindness is a separately recorded item, not this one.
// ---------------------------------------------------------------------------
testCase('the REAL package.json chain and the REAL RESOURCE_POLICY both register test:validation-tier-planner', () => {
  const repoRoot = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(repoRoot, 'this guard reads the real repository inventory; a missing repository is a failure, not a skip');

  const scripts = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> }).scripts ?? {};

  // The prefix chain is a legitimately separate list whose members would otherwise
  // read as stalePolicy against the main chain, so compose the reference exactly the
  // way the runner does instead of naively unioning or ignoring it.
  const mainChain = scripts['test:serial-reference'];
  const prefixChain = scripts['test:serial-reference-prefix'];
  assert.ok(mainChain, 'root package.json must define test:serial-reference: it is the membership authority');
  const serialReference = [prefixChain, mainChain].filter(Boolean).join(' && ');

  // Authority 1: the real chain.
  const referenceMembers = parseSerialReference(serialReference);
  assert.ok(
    parseSerialReference(mainChain!).includes('test:validation-tier-planner'),
    'test:validation-tier-planner must be a member of the canonical test:serial-reference chain',
  );
  assert.equal(
    scripts['test:validation-tier-planner'],
    'node packages/main/dist/tasks/validation-tier-planner-smoke.js',
    'the chain member must resolve to a real npm script running this suite',
  );

  // Authority 2: the real RESOURCE_POLICY, read through the module that declares it.
  const policyNames = FULL_SUITE_ENTRIES.map((entry) => entry.name);
  assert.ok(
    policyNames.includes('test:validation-tier-planner'),
    'RESOURCE_POLICY is a SEPARATE mandatory mapping; a chain member with no policy row fails the whole suite closed',
  );

  // The bidirectional relationship, computed over the REAL pair rather than over a
  // fixture rebuilt from one of the two sides.
  const policyByName = new Set(policyNames);
  const unknownPolicy = referenceMembers.filter((name) => !policyByName.has(name));
  const missingScripts = referenceMembers.filter((name) => !scripts[name]);
  const stalePolicy = policyNames.filter((name) => !referenceMembers.includes(name));
  assert.deepEqual(unknownPolicy, [], `real chain members with no RESOURCE_POLICY row: ${unknownPolicy.join(', ')}`);
  assert.deepEqual(missingScripts, [], `real chain members with no npm script: ${missingScripts.join(', ')}`);
  assert.deepEqual(stalePolicy, [], `RESOURCE_POLICY rows absent from the real chain: ${stalePolicy.join(', ')}`);

  // End to end through the production reader, with the real policy as its default.
  const entries = entriesFromSerialReference(serialReference, scripts);
  assert.ok(
    entries.some((entry) => entry.name === 'test:validation-tier-planner'),
    'the production inventory reader must accept the real pair and yield this member',
  );
});


// ---------------------------------------------------------------------------
// (43) REAL VALIDATE.COMMANDS REGISTRATION (B-a745 F-005, load-bearing) —
//      registration has a THIRD authority beyond the serial-reference chain and
//      RESOURCE_POLICY: `proof-or-stop.config.json` `validate.commands`, which is
//      the planner's command universe. This Story's own verification evidence
//      pins `node packages/main/dist/tasks/validation-tier-planner-smoke.js`, so
//      a suite absent from that universe makes every one of its pins resolve to
//      `pinned_command_missing` and `validation_plan` stop with `0 of 0` — which
//      is exactly what happened while cases (42) and full-suite-runner-smoke both
//      reported PASS. Neither of those two reads validate.commands at all.
//
//      So this case reads the REAL configured command set through the production
//      reader and drives both the REAL pin resolver and validation_plan renderer,
//      rather than inspecting JSON text. It also proves B-e256's global-CLI RED
//      command is visible by stable id/label in actual planner output.
// ---------------------------------------------------------------------------
testCase('the real validation_plan output exposes red-global-cli-exec-bit by stable id and label', () => {
  const repoRoot = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(repoRoot, 'this guard reads the real repository inventory; a missing repository is a failure, not a skip');

  // The exact string every verification-evidence pin recorded by this Story names.
  const pinnedCommand = 'node packages/main/dist/tasks/validation-tier-planner-smoke.js';
  const parsedPin = parseLegacyValidationCommandString(pinnedCommand);
  assert.ok(parsedPin, 'the recorded pin must parse under the one canonical legacy string rule');

  // Authority 3: the real configured command set, read through the production reader.
  const commands = configuredValidationCommands(repoRoot);
  const matches = commands.filter((entry) => entry.command === parsedPin!.command
    && entry.args.length === parsedPin!.args.length
    && entry.args.every((arg, index) => arg === parsedPin!.args[index]));
  assert.equal(
    matches.length,
    1,
    'proof-or-stop.config.json validate.commands is the planner command universe and a SEPARATE mandatory '
    + `registration; this suite must appear there exactly once, found ${matches.length}`,
  );

  // End to end through the real resolver: the recorded pin must actually bind.
  const universe = buildValidationPinUniverse({ projectRoot: repoRoot, commands });
  const resolution = resolveValidationCommandPin({ universe, evidence: { command: pinnedCommand } });
  assert.equal(
    resolution.status,
    'resolved',
    `the recorded pin must resolve against the real universe, got ${JSON.stringify(resolution)}`,
  );

  const redPinnedCommand = 'node packages/main/tests/red/red-global-cli-exec-bit.mjs';
  const redPin = parseLegacyValidationCommandString(redPinnedCommand);
  assert.ok(redPin, 'the B-e256 RED command must parse under the canonical pin rule');
  const redMatches = commands.filter((entry) => entry.command === redPin!.command
    && entry.args.length === redPin!.args.length
    && entry.args.every((arg, index) => arg === redPin!.args[index]));
  assert.equal(redMatches.length, 1, `the B-e256 RED command must appear exactly once in the real planner universe, found ${redMatches.length}`);
  assert.equal(redMatches[0].id, 'red-global-cli-exec-bit');
  assert.equal(redMatches[0].label, 'B-e256 global CLI rebuild and promotion regression');

  // Execute the production handler over the real configured command row. A
  // config-only membership assertion is insufficient: the operator-visible
  // planner rendering itself must preserve the stable identity.
  const { ctx } = planCliRoot({ commands: redMatches });
  const rendered = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'full', explain: true });
  assert.match(rendered, /^inclusion reasons by unit \(1\):$/m);
  assert.match(rendered, /^ {2}red-global-cli-exec-bit \[B-e256 global CLI rebuild and promotion regression\]$/m);
});


testCase('every DoneWhen of CHK-001..CHK-005 is covered by a fixture case that actually ran and passed', () => {
  const declaredItems = new Set(DONEWHEN_COVERAGE.map((entry) => entry.item));
  assert.deepEqual([...declaredItems].sort(), ['CHK-001', 'CHK-002', 'CHK-003', 'CHK-004', 'CHK-005']);

  const missing: string[] = [];
  for (const entry of DONEWHEN_COVERAGE) {
    for (const name of entry.cases) {
      if (!passedCases.has(name)) missing.push(`${entry.item} "${entry.doneWhen}" cites a case that did not run and pass: "${name}"`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});


testCase(DEFAULT_STDOUT_BOUND_CASE_NAME, () => {
  const summaryLine = (projected: number): string => `default stdout projection: ${projected} chars (bound ${DEFAULT_STDOUT_BOUND_CHARS})`;
  // Everything the default rendering has written so far, plus exactly the lines still to
  // come when every case passes: the summary line below, this case's ok line, the PASS line.
  const tail = `  ok  ${DEFAULT_STDOUT_BOUND_CASE_NAME}\n\n${MARKER}: PASS\n`;
  const base = capturedStdoutChars - verboseOnlyChars + tail.length;
  // The summary line is part of the output; its length depends only on the digit count of the projection.
  let projected = base + summaryLine(base).length + 1;
  projected = base + summaryLine(projected).length + 1;
  assert.ok(
    projected < DEFAULT_STDOUT_BOUND_CHARS,
    `default stdout is ${projected} chars, not under ${DEFAULT_STDOUT_BOUND_CHARS}: keep collapsed sections collapsed and CHK-006 case names short, `
    + 'or print new detail only under VALIDATION_TIER_PLANNER_VERBOSE=1',
  );
  console.log(summaryLine(projected));
});
}
