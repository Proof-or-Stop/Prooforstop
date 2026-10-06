#!/usr/bin/env node
/**
 * Detection A/B control arm (efc375c, 40 rounds): in D2-r3 and D9-r1 the
 * inventory critic re-raised the lanes' findings as its own new findings and
 * its import was refused with REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE
 * (D2-r3: lane F-001..F-003 had no row, the critic dispositioned only its own
 * restatements F-004..F-006 with familyKey = the lane id; D9-r1: the critic
 * dispositioned the lane findings and left its verbatim copies F-004..F-006
 * without a row). `next` then proposed the same import forever.
 *
 * The fixtures below are the byte-exact findings (findings.json) and sealed
 * inventoryCritic blocks (evidence-proposal.json) of those two replays
 * (bench host ~/Downloads/old_pos_bench/ab/results/control/{D2-r3,D9-r1}).
 *
 * Contract:
 *  (a) the provider contract (protocol prompt + JSON schema descriptions) says
 *      what the importer requires: one row for every aggregate finding and for
 *      every own finding, and own findings only for defects no aggregate
 *      finding already reports;
 *  (c) a critic finding that provably restates an earlier finding of the wave
 *      (shared file + same claim) is completed as a duplicate of it instead of
 *      refusing the critic; a genuinely new or ambiguous critic finding is
 *      never reconciled away.
 * (b), next never re-proposing a refused critic import, is covered end to end
 * by e2e-review-to-done-smoke NC3.
 */
import assert from 'node:assert/strict';
import { managedInventoryCriticJsonSchema, MANAGED_INVENTORY_CRITIC_PROTOCOL,
  reconcileRestatedCriticFindings, type CriticResolvedDisposition } from '../core/managed-inventory-critic.js';
import { managedReviewFinalProposalJsonSchema } from '../core/host-run.js';

type Fixture = {
  findings: ReadonlyArray<{ id: string; agent: string; reviewRunId: string; files: readonly string[]; desc: string; proposalFindingIndex?: number }>;
  criticRunId: string;
  inventoryCritic: { epochId: string; wave: number; findingDispositions: ReadonlyArray<{ finding: { findingId?: string; proposalFindingIndex?: number };
    disposition: string; familyKey?: string; canonicalFinding?: { findingId?: string; proposalFindingIndex?: number }; reason: string }> };
};

const D2_r3: Fixture = {"findings": [{"id": "B-ba92:F-001", "agent": "proof-or-stop-review-test-coverage", "reviewRunId": "B-ba92:RR-003", "files": ["evaluator/evaluator.go", "evaluator/evaluator_test.go"], "desc": "evaluator/evaluator.go:1530 (change introduced by B-ba92 commit 075befd) normalizes any NULL range start to an omitted start before index dispatch, so an explicit non-numeric null start is silently accepted: `a = [1,2,3,4,5]; a[null:2]` returns [1, 2], `[1,2,3,4,5][null:2:1]` returns [1, 2], and `\"abcde\"[null:2]` returns ab, whereas base 050424f and the story request (\"A non-numeric `start` in array/string slices must keep the existing index-operator error format: `index operator not supported: <inspect> on ARRAY` / `on STRING`\") require the error `index operator not supported: null on ARRAY` / `index operator not supported: null on STRING`. The adversarial intents CHK-002:adversarial:2 and CHK-002:adversarial:4 are covered only by TestArraySliceIndexErrors and TestStringSliceIndexErrors, which exercise just a hash start `[{}:2]`, so the null non-numeric start is not covered and the suite passes despite the wrong result. Reconfirm with `a = [1,2,3,4,5]; a[null:2]` (expected: index operator not supported: null on ARRAY; actual: [1, 2]). Severity medium: unrequested base-to-head behavior change producing a wrong result on a promised non-numeric-start path, with no test coverage."}, {"id": "B-ba92:F-002", "agent": "proof-or-stop-review-docs", "reviewRunId": "B-ba92:RR-004", "files": ["docs/src/docs/types/array.md", "evaluator/evaluator.go"], "desc": "doc-code-drift: docs/src/docs/types/array.md line 43 documents `array[0:2] # [0, 1, 2]` and line 52 documents `array[:2] # [0, 1, 2]`, but the evaluator returns [0, 1] for both two-part array ranges (the range end is exclusive). The documented slices overstate the result by one element, so a user following the page gets a different result than the runtime produces."}, {"id": "B-ba92:F-003", "agent": "proof-or-stop-review-docs", "reviewRunId": "B-ba92:RR-004", "files": ["docs/src/docs/syntax/assignments.md", "docs/src/docs/types/array.md", "docs/src/docs/types/string.md", "evaluator/evaluator.go", "parser/parser.go"], "desc": "doc-code-drift: this Story adds a user-visible third slice component value[start:end:step] (with omitted start/end/step forms) and array/string range assignment, but the pages that document index ranges and index assignment keep only the two-part [start:end] form and single-index assignment; docs/src/docs/types/array.md, docs/src/docs/types/string.md and docs/src/docs/syntax/assignments.md were not updated to describe the new stepped syntax, its output/error behavior, or range assignment."}, {"id": "B-ba92:F-004", "agent": "proof-or-stop-review-topology-critic", "reviewRunId": "B-ba92:RR-005", "files": ["evaluator/evaluator.go", "evaluator/evaluator_test.go"], "desc": "base-to-head regression: commit 075befd's evalIndexExpression normalization (`if node.IsRange && index == NULL { index = &object.Number{Value: 0}; startOmitted = true }`) routes an explicit non-numeric null start through the numeric index dispatch. `a = [1,2,3,4,5]; a[null:2]` returns [1, 2], `a[null:2:1]` returns [1, 2], and `\"abcde\"[null:2]` returns ab, whereas base 050424f returns `index operator not supported: null on ARRAY` (same path requires `index operator not supported: null on STRING`). I reproduced both behaviors directly. The starved adversarial intents CHK-002:adversarial:2/:4 only exercise `[{}:2]`, so the null-start path is untested and the suite passes.", "proposalFindingIndex": 0}, {"id": "B-ba92:F-005", "agent": "proof-or-stop-review-topology-critic", "reviewRunId": "B-ba92:RR-005", "files": ["docs/src/docs/types/array.md", "evaluator/evaluator.go"], "desc": "doc-code drift: docs/src/docs/types/array.md line 43 documents `array[0:2] # [0, 1, 2]` and line 52 documents `array[:2] # [0, 1, 2]`, but the evaluator (both base and head) returns [0, 1] for two-part array ranges because the end is exclusive. A reader following the page gets a different result than the runtime produces.", "proposalFindingIndex": 1}, {"id": "B-ba92:F-006", "agent": "proof-or-stop-review-topology-critic", "reviewRunId": "B-ba92:RR-005", "files": ["docs/src/docs/syntax/assignments.md", "docs/src/docs/types/array.md", "docs/src/docs/types/string.md"], "desc": "doc-code drift: this story adds the user-visible three-part value[start:end:step] index syntax and array/string range assignment, but no documentation page describes them. docs/src/docs/types/array.md and docs/src/docs/types/string.md still show only `[start:end]`, and docs/src/docs/syntax/assignments.md still shows only single-index assignment; the stepped syntax, its error/step-0 behavior, and range assignment are undocumented. None of these three files were modified by the story (git diff base..HEAD is empty for them), and none is in the story's six-file modify scope.", "proposalFindingIndex": 2}], "criticRunId": "request-25d1e589e0f5c4f5d03da35b45415e0b1c8eed49acfa35b7e64d9962aa60a764", "inventoryCritic": {"epochId": "B-ba92:RI-001", "findingDispositions": [{"disposition": "verified_family", "familyKey": "B-ba92:F-001", "finding": {"proposalFindingIndex": 0}, "reason": "Independently reproduced the F-001 null non-numeric start regression in this checkout (head returns [1,2]/ab; base 050424f errors with 'index operator not supported: null on ARRAY'), so it is a real product defect and its own verified family. Severity medium is correct: unrequested base-to-head behavior change with wrong result on a promised non-numeric-start path and no covering test."}, {"disposition": "verified_family", "familyKey": "B-ba92:F-002", "finding": {"proposalFindingIndex": 1}, "reason": "Independently confirmed F-002: array[0:2] and array[:2] return [0, 1], not the [0, 1, 2] shown on docs/src/docs/types/array.md lines 43 and 52. It is a genuine doc-code defect and its own verified family; note it predates this story and was not touched by the diff, so it is a standing documentation error rather than a new regression. Severity medium is appropriate for doc drift that misleads users on a documented operator."}, {"disposition": "verified_family", "familyKey": "B-ba92:F-003", "finding": {"proposalFindingIndex": 2}, "reason": "Independently confirmed F-003: docs/types/array.md, docs/types/string.md and docs/syntax/assignments.md describe only two-part ranges and single-index assignment and contain no mention of the new stepped slice or range assignment; git diff base..HEAD is empty for all three. It is a real documentation gap and its own verified family. Caveat: those files are outside the story's allowed modify scope, so this is a documentation-ownership gap the scope workflow must resolve, not an implementation defect in the changed files."}], "wave": 1}};
const D9_r1: Fixture = {"findings": [{"id": "B-ba92:F-001", "agent": "proof-or-stop-review-concept", "reviewRunId": "B-ba92:RR-001", "files": ["evaluator/evaluator.go", "evaluator/evaluator_test.go"], "desc": "evaluator/evaluator.go:1611 (steppedSliceIndexes, negative-step branch) applies an explicit range end inclusively although CHK-002 specifies the end is exclusive; the code comment at line 1597 even reads 'the end bound is exclusive'. `to = clampToRange(endValue-1, -1, n-1)` combined with `for i := from; i > to` emits index endValue too. Reproduced with the built interpreter: [1,2,3,4,5,6,7,8,9][8:0:-2] returns [9,7,5,3,1] instead of the documented [9,7,5,3], and \"abcdefg\"[6:1:-1] returns \"gfedcb\" instead of \"gfedc\". Because the same selection feeds assignment, a[3:0:-1] = [40,30,20,10] silently writes index 0 (4 targets) and masks the required error `range assignment size mismatch: target=3 value=4`. Commit 041d5b8 changed evaluator/evaluator_test.go expectations (e.g. [8:0:-2] -> [9,7,5,3,1]) to encode this deviation, so the tests no longer match the accepted normalization."}, {"id": "B-ba92:F-002", "agent": "proof-or-stop-review-quality", "reviewRunId": "B-ba92:RR-002", "files": ["evaluator/evaluator.go", "evaluator/evaluator_test.go"], "desc": "evaluator/evaluator.go:1611 (steppedSliceIndexes, negative-step branch) computes to = clampToRange(endValue-1, -1, n-1), so an explicit negative-step end is treated as inclusive. This contradicts the CHK-002 normalization ('start is clamped to [0,n-1] and end to [-1,n-1]; indices are i = start, start+step, ... while i > end') and the branch's own comment ('the end bound is exclusive'). Observed on this HEAD: [1,2,3,4,5,6,7,8,9][8:2:-2] returns [9,7,5,3] (indexes 8,6,4,2) whereas the specified normalization selects 8,6,4 -> [9,7,5]; [1,2,3,4,5,6,7,8,9][8:1:-1] returns [9,8,7,6,5,4,3,2] instead of [9,8,7,6,5,4,3]; \"abcdefg\"[6:1:-1] returns 'gfedcb' instead of 'gfedc'. The changed tests assert the deviating bound (evaluator/evaluator_test.go [8:0:-2]->[9,7,5,3,1], [6:1:-1]->'gfedcb', a[3:0:-1]=[40,30,20,10]), so Read is wrong on a documented path and inconsistent with the positive-step branch, which keeps the end exclusive."}, {"id": "B-ba92:F-003", "agent": "proof-or-stop-review-test-coverage", "reviewRunId": "B-ba92:RR-003", "files": ["evaluator/evaluator.go", "evaluator/evaluator_test.go"], "desc": "evaluator/evaluator.go:1611 (loop at 1606-1614) makes the negative-step three-part slice end inclusive: after resolving endValue it sets the exclusive bound to endValue-1 and iterates while i > to, so an explicit end index is included. CHK-002 specifies the opposite: 'start is clamped to [0,n-1] and end to [-1,n-1]; indices are i = start, start+step, ... while i > end', i.e. an exclusive end. With the code as written, value[start:end:step] with step<0 and an explicit end selects one extra element: [1,2,3,4,5,6,7,8,9][8:0:-2] evaluates to [9,7,5,3,1] instead of [9,7,5,3]; \"abcdefg\"[6:0:-2] evaluates to \"geca\" instead of \"gec\"; and \"abcdefg\"[6:1:-1] evaluates to \"gfedcb\" instead of \"gfedc\". The omission-default case ([::-1] etc.) is unaffected. The same off-by-one propagates to range assignment (a[3:0:-1]=... selects 4 indexes instead of 3; s[4:1:-1]=... likewise), and the tests rewritten in commit 041d5b8 at evaluator_test.go:1649,1679,1680,1742,1821 assert those inclusive values, so a green suite currently locks in a result that contradicts the checklist's stated algorithm rather than catching it."}, {"id": "B-ba92:F-004", "agent": "proof-or-stop-review-topology-critic", "reviewRunId": "B-ba92:RR-005", "files": ["evaluator/evaluator.go", "evaluator/evaluator_test.go"], "desc": "evaluator/evaluator.go:1611 (steppedSliceIndexes, negative-step branch) applies an explicit range end inclusively although CHK-002 specifies the end is exclusive; the comment at line 1597 even reads 'the end bound is exclusive'. `to = clampToRange(endValue-1, -1, n-1)` combined with `for i := from; i > to` emits index endValue too. Reproduced with the built interpreter: [1,2,3,4,5,6,7,8,9][8:0:-2] returns [9,7,5,3,1] instead of the documented [9,7,5,3], and \"abcdefg\"[6:1:-1] returns \"gfedcb\" instead of \"gfedc\". Because the same selection feeds assignment, a[3:0:-1] = [40,30,20,10] silently writes index 0 (4 targets) and masks the required error `range assignment size mismatch: target=3 value=4`. Commit 041d5b8 changed evaluator/evaluator_test.go expectations to encode this deviation, so the tests no longer match the accepted normalization.", "proposalFindingIndex": 0}, {"id": "B-ba92:F-005", "agent": "proof-or-stop-review-topology-critic", "reviewRunId": "B-ba92:RR-005", "files": ["evaluator/evaluator.go", "evaluator/evaluator_test.go"], "desc": "evaluator/evaluator.go:1611 (steppedSliceIndexes, negative-step branch) computes to = clampToRange(endValue-1, -1, n-1), so an explicit negative-step end is treated as inclusive. This contradicts the CHK-002 normalization ('start is clamped to [0,n-1] and end to [-1,n-1]; indices are i = start, start+step, ... while i > end') and the branch's own comment ('the end bound is exclusive'). Observed on this HEAD: [1,2,3,4,5,6,7,8,9][8:2:-2] returns [9,7,5,3] whereas the specified normalization selects 8,6,4 -> [9,7,5]; and \"abcdefg\"[6:1:-1] returns 'gfedcb' instead of 'gfedc'. The changed tests assert the deviating bound, so the read is wrong on a documented path and inconsistent with the positive-step branch, which keeps the end exclusive.", "proposalFindingIndex": 1}, {"id": "B-ba92:F-006", "agent": "proof-or-stop-review-topology-critic", "reviewRunId": "B-ba92:RR-005", "files": ["evaluator/evaluator.go", "evaluator/evaluator_test.go"], "desc": "evaluator/evaluator.go:1611 (loop at 1606-1614) makes the negative-step three-part slice end inclusive: after resolving endValue it sets the exclusive bound to endValue-1 and iterates while i > to, so an explicit end index is included. CHK-002 specifies the opposite: 'start is clamped to [0,n-1] and end to [-1,n-1]; indices are i = start, start+step, ... while i > end', i.e. an exclusive end. With the code as written, value[start:end:step] with step<0 and an explicit end selects one extra element: [1,2,3,4,5,6,7,8,9][8:0:-2] evaluates to [9,7,5,3,1] instead of [9,7,5,3]; \"abcdefg\"[6:0:-2] evaluates to \"geca\" instead of \"gec\"; and \"abcdefg\"[6:1:-1] evaluates to \"gfedcb\" instead of \"gfedc\". The same off-by-one propagates to range assignment, and the tests rewritten in commit 041d5b8 assert those inclusive values, so a green suite locks in a result that contradicts the checklist's stated algorithm.", "proposalFindingIndex": 2}], "criticRunId": "request-25d1e589e0f5c4f5d03da35b45415e0b1c8eed49acfa35b7e64d9962aa60a764", "inventoryCritic": {"epochId": "B-ba92:RI-001", "findingDispositions": [{"disposition": "verified_family", "familyKey": "negative-step-explicit-end-inclusive", "finding": {"findingId": "B-ba92:F-001"}, "reason": "Independently reproduced on this HEAD: steppedSliceIndexes negative-step branch uses to=clampToRange(endValue-1,-1,n-1) with i>to, giving [9,7,5,3,1] for [8:0:-2] and gfedcb for \"abcdefg\"[6:1:-1], contradicting CHK-002's exclusive end normalization. Confirmed on a documented and tested path; high severity is appropriate and not overstated."}, {"canonicalFinding": {"findingId": "B-ba92:F-001"}, "disposition": "duplicate", "familyKey": "negative-step-explicit-end-inclusive", "finding": {"findingId": "B-ba92:F-002"}, "reason": "Same root cause as F-001 (negative-step explicit-end off-by-one in evaluator/evaluator.go steppedSliceIndexes); it cites the same function, same [8:0:-2] reproduction and the same contradictory tests, so it is a duplicate report, not an independent defect."}, {"canonicalFinding": {"findingId": "B-ba92:F-001"}, "disposition": "duplicate", "familyKey": "negative-step-explicit-end-inclusive", "finding": {"findingId": "B-ba92:F-003"}, "reason": "Same root cause as F-001 (negative-step explicit-end off-by-one in evaluator/evaluator.go steppedSliceIndexes); it names the same loop and the same range-assignment propagation, so it is a duplicate report. Its medium severity matches the rubric floor for a wrong result on a documented path."}], "wave": 1}};

const CRITIC = 'proof-or-stop-review-topology-critic';

/** The importer's resolution step (handlers/review-inventory.ts importManagedInventoryCritic). */
function resolved(fixture: Fixture): { own: Fixture['findings'][number][]; other: Fixture['findings'][number][]; rows: CriticResolvedDisposition[] } {
  const own = fixture.findings.filter(f => f.agent === CRITIC);
  const other = fixture.findings.filter(f => f.agent !== CRITIC);
  const id = (ref: { findingId?: string; proposalFindingIndex?: number }): string => ref.findingId
    ?? own.find(f => f.proposalFindingIndex === ref.proposalFindingIndex)!.id;
  const rows = fixture.inventoryCritic.findingDispositions.map(row => ({ findingId: id(row.finding),
    disposition: row.disposition as CriticResolvedDisposition['disposition'], reason: row.reason,
    ...(row.familyKey ? { familyKey: row.familyKey } : {}),
    ...(row.canonicalFinding && row.disposition !== 'verified_family' ? { canonicalFindingId: id(row.canonicalFinding) } : {}) }));
  return { own, other, rows };
}

/** The evaluator's completeness/validity rules (core/review-inventory-epoch.ts evaluateReviewInventoryWave). */
function verdict(ids: readonly string[], rows: readonly CriticResolvedDisposition[]): { unresolved: string[]; invalid: string[] } {
  const by = new Map(rows.map(row => [row.findingId, row]));
  const invalid = rows.filter(row => {
    if (rows.filter(r => r.findingId === row.findingId).length !== 1 || !ids.includes(row.findingId) || row.reason.trim().length < 10) return true;
    if (row.disposition === 'verified_family') return !row.familyKey;
    if (row.disposition === 'duplicate') {
      const canonical = row.canonicalFindingId ? by.get(row.canonicalFindingId) : undefined;
      return !row.familyKey || canonical?.disposition !== 'verified_family' || canonical.familyKey !== row.familyKey;
    }
    return row.familyKey !== undefined || row.canonicalFindingId !== undefined;
  }).map(row => row.findingId);
  return { unresolved: ids.filter(id => !by.has(id)).sort(), invalid };
}

for (const [name, fixture, refusedIds, pairs] of [
  ['D2-r3', D2_r3, ['B-ba92:F-001', 'B-ba92:F-002', 'B-ba92:F-003'], [['B-ba92:F-004', 'B-ba92:F-001'], ['B-ba92:F-005', 'B-ba92:F-002'], ['B-ba92:F-006', 'B-ba92:F-003']]],
  ['D9-r1', D9_r1, ['B-ba92:F-004', 'B-ba92:F-005', 'B-ba92:F-006'], [['B-ba92:F-004', 'B-ba92:F-001'], ['B-ba92:F-005', 'B-ba92:F-002'], ['B-ba92:F-006', 'B-ba92:F-003']]],
] as const) {
  const { own, other, rows } = resolved(fixture);
  const ids = fixture.findings.map(f => f.id);
  // The production refusal, reproduced from the exact sealed block.
  assert.deepEqual(verdict(ids, rows).unresolved, [...refusedIds], `${name}: fixture no longer reproduces the production refusal`);
  const out = reconcileRestatedCriticFindings({ ownFindings: own, otherFindings: other, dispositions: rows });
  const after = verdict(ids, out.dispositions);
  assert.deepEqual(after, { unresolved: [], invalid: [] }, `${name}: restated lane findings must complete the critic, got ${JSON.stringify(after)}`);
  assert.deepEqual(out.restated.map(row => [row.ownFindingId, row.restatedFindingId]), pairs.map(pair => [...pair]), `${name}: each restatement pairs with its lane finding`);
  for (const [ownId, laneId] of pairs) {
    const row = out.dispositions.find(r => r.findingId === ownId)!;
    assert.equal(row.disposition, 'duplicate', `${name}: ${ownId} (the critic's restatement of ${laneId}) is recorded as a duplicate, not dropped`);
    const laneRow = out.dispositions.find(r => r.findingId === laneId)!;
    assert.equal(row.familyKey, laneRow.familyKey, `${name}: ${ownId} joins ${laneId}'s family`);
  }
  // The critic's own reasoning is kept for the lane finding it was written for.
  for (const row of rows) assert.ok(out.dispositions.some(r => r.findingId === row.findingId), `${name}: critic row ${row.findingId} kept`);
}

// Never reconcile away a genuinely new critic finding.
{
  const { other, rows } = resolved(D9_r1);
  const laneRows = rows.filter(row => other.some(f => f.id === row.findingId));
  const novel = { id: 'B-ba92:F-004', desc: D2_r3.findings[1]!.desc, files: ['evaluator/evaluator.go', 'docs/src/docs/types/array.md'] };
  const out = reconcileRestatedCriticFindings({ ownFindings: [novel], otherFindings: other, dispositions: laneRows });
  assert.deepEqual(out.restated, [], 'a new claim sharing a file with a lane finding is not a restatement');
  assert.deepEqual(verdict([...other.map(f => f.id), novel.id], out.dispositions).unresolved, ['B-ba92:F-004'], 'the new finding stays unresolved (import refuses it)');
  const sameText = { id: 'B-ba92:F-004', desc: D9_r1.findings[0]!.desc, files: ['docs/other.md'] };
  assert.deepEqual(reconcileRestatedCriticFindings({ ownFindings: [sameText], otherFindings: other, dispositions: laneRows }).restated, [],
    'the same words about a different file are not provably the same finding');
  // Two lane findings equally similar and no critic link: ambiguous, not reconciled.
  const twin = { ...D9_r1.findings[0]!, id: 'B-ba92:F-009' };
  assert.deepEqual(reconcileRestatedCriticFindings({ ownFindings: [{ ...D9_r1.findings[3]!, id: 'B-ba92:F-010' }], otherFindings: [...other, twin],
    dispositions: [...laneRows, { ...laneRows[1]!, findingId: twin.id }] }).restated, [], 'an ambiguous restatement is not reconciled');
}

// (a) The provider contract names what the importer requires.
const protocol = MANAGED_INVENTORY_CRITIC_PROTOCOL.join('\n');
assert.match(protocol, /exactly one row for every aggregate finding/i, 'protocol: one row per aggregate finding');
assert.match(protocol, /every entry of your own findings array/i, 'protocol: one row per own finding');
assert.match(protocol, /never copy, restate or re-raise an aggregate finding/i, 'protocol: own findings are only new defects');
assert.match(protocol, /REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE/, 'protocol: names the refusal a missing row causes');
const dispositionsSchema = (managedInventoryCriticJsonSchema.properties.findingDispositions as { description?: string }).description ?? '';
assert.match(dispositionsSchema, /every aggregate finding/i, 'schema: findingDispositions states the coverage rule');
const criticSchema = managedReviewFinalProposalJsonSchema({ storyId: 'B-ba92', agentType: CRITIC, lane: CRITIC, reviewRunId: 'B-ba92:RR-005' }) as
  { properties: { findings: { description?: string } } };
assert.match(criticSchema.properties.findings.description ?? '', /no aggregate finding .*already reports/i, 'schema: critic findings are only new defects');

console.log('critic-restated-lane-findings-smoke: PASS');
