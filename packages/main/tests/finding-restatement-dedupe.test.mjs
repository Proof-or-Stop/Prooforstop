/**
 * Old-PoS run 29 R2/REM2 (run28-29-analysis.md §3.4): the critic raised F-004
 * (aliasing defect); a second lane wave, launched after F-004 existed,
 * re-reported it as F-005 ("B-9c3a:F-004 remains present ..."), F-006 and
 * F-007. F-004 and F-005 carry different family keys from two epochs, so the
 * grouped repair treated them as two findings: "one commit per finding" made
 * the worker add a second test in a new out-of-scope file.
 *
 * Contract (dedupe before grouping): an open finding reported by a review run
 * that STARTED AFTER an earlier, not dismissed finding of the Story was
 * recorded, and that names that finding's id or restates its claim (shared
 * file + findingClaimRestates), is a duplicate of it (findingDuplicateOf), so
 * groupedFindingRepairIds leaves it out and it closes through the duplicate
 * coverage run of its own case. Findings of runs that started before the
 * earlier finding existed (independent first observations) are never merged.
 */
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StoryStore} from '../dist/core/store.js';
import {findingDuplicateOf} from '../dist/core/duplicate-finding-coverage.js';

const root = mkdtempSync(join(tmpdir(), 'finding-restatement-dedupe-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({storyDir: '.proof-or-stop/story/actives', storyPrefix: 'B'}));
  const storyId = 'B-9c3a';
  const store = new StoryStore(root);
  mkdirSync(store.storyDirPath(storyId), {recursive: true});
  const round = '2026-10-08T21:43:32.623Z';
  const run = (id, lane, startedAt, purpose) => ({reviewRunId: `${storyId}:${id}`, storyId, lane, reviewRound: round, startedAt, materialHash: 'm', ...(purpose ? {reviewPurpose: purpose} : {})});
  writeFileSync(store.storyFilePath(storyId, 'review-runs.json'), JSON.stringify({runs: [
    run('RR-005', 'proof-or-stop-review-concept', '2026-10-08T21:43:40.000Z'),
    run('RR-008', 'proof-or-stop-review-topology-critic', '2026-10-08T21:50:54.000Z', 'inventory-completeness'),
    run('RR-009', 'proof-or-stop-review-concept', '2026-10-08T21:54:42.000Z'),
    run('RR-010', 'proof-or-stop-review-quality', '2026-10-08T21:54:42.000Z'),
    run('RR-011', 'proof-or-stop-review-test-coverage', '2026-10-08T21:54:42.000Z'),
  ]}));
  const f = (id, runId, agent, createdAt, desc, files, status = 'open') => ({id: `${storyId}:${id}`, desc, severity: 'medium', category: 'edge', status, evidenceState: 'verified',
    agent, createdAt, reviewRound: round, reviewRunId: `${storyId}:${runId}`, files});
  const F004 = 'Array range assignment with an assigned array aliases the target and reads it while mutating. For `a=[1,2,3,4,5]; a[::-1]=a`, selected target indexes are 4,3,2,1,0 and the RHS value before assignment is [1,2,3,4,5], so assignment should produce [5,4,3,2,1]. Focused execution of the current checkout produced [1,2,3,2,1] because `evalArrayRangeAssignment` writes into `arrayObject.Elements` while reading `value.Elements[i]` from the same array.';
  const F005 = 'B-9c3a:F-004 remains present. At evaluator/evaluator.go:527-534, evalArrayRangeAssignment treats an array RHS as value and writes arrayObject.Elements[idx] = value.Elements[i] while value.Elements may share backing storage with the target array. Repro: `a=[1,2,3,4,5]; a[::-1]=a; echo(str(a))` printed [1, 2, 3, 2, 1].';
  const F006 = 'evaluator/evaluator.go:527-534: evalArrayRangeAssignment reads value.Elements[i] while writing arrayObject.Elements[idx]; when the assigned array aliases the target, for example a=[1,2,3,4,5]; a[::-1]=a, the RHS is observed before assignment as [1,2,3,4,5] and the selected target indexes are 4,3,2,1,0, so the expected result is [5,4,3,2,1]. Focused execution in this checkout produced [1,2,3,2,1]. Snapshot or copy the RHS elements before mutating the target.';
  const OTHER = 'evalArrayRangeAssignment accepts a null start on the assignment path and panics on the unchecked *object.Number assertion.';
  writeFileSync(store.storyFilePath(storyId, 'findings.json'), JSON.stringify({findings: [
    // First-wave lane finding about other code, recorded BEFORE F-004 by a run that started before it: never merged.
    f('F-003', 'RR-005', 'proof-or-stop-review-concept', '2026-10-08T21:48:00.000Z', OTHER, ['evaluator/evaluator.go']),
    f('F-004', 'RR-008', 'proof-or-stop-review-topology-critic', '2026-10-08T21:54:11.847Z', F004, ['evaluator/evaluator.go']),
    f('F-005', 'RR-009', 'proof-or-stop-review-concept', '2026-10-08T21:59:26.626Z', F005, ['evaluator/evaluator.go']),
    f('F-006', 'RR-010', 'proof-or-stop-review-quality', '2026-10-08T21:57:53.261Z', F006, ['evaluator/evaluator.go']),
  ]}));
  const dup = id => findingDuplicateOf(store, storyId, `${storyId}:${id}`);
  assert.equal(dup('F-005')?.canonicalFindingId, `${storyId}:F-004`, `RUN29_CROSS_EPOCH_RESTATEMENT_RED: F-005 names F-004 and its run started after F-004: ${JSON.stringify(dup('F-005'))}`);
  assert.equal(dup('F-006')?.canonicalFindingId, `${storyId}:F-004`, `RUN29_CROSS_EPOCH_RESTATEMENT_RED: F-006 restates F-004's claim from a later run: ${JSON.stringify(dup('F-006'))}`);
  assert.equal(dup('F-004'), null, 'the earliest observation is the canonical finding');
  assert.equal(dup('F-003'), null, 'a finding recorded before the canonical existed is never merged');
  console.log('FINDING_RESTATEMENT_DEDUPE_GREEN');
} finally {
  rmSync(root, {recursive: true, force: true});
}
