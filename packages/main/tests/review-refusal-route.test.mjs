/**
 * Old-PoS run 29 R2 (run28-29-analysis.md §3.4): the REVIEW verdict refused
 * review_evidence_invalid with no launchable lane, and its message embedded
 * `Next: proof-or-stop review_round_prepare`. reviewNext matched that text as a
 * hint and handed it to the owner (`agent` step) although next had just found
 * nothing to prepare: the owner ran it twice (no-op), read help pages, and
 * cancelled/began the epoch by hand (20 turns, ~3.5M). Contract:
 *   - a hinted command next already determined to be a no-op
 *     (review_round_prepare with no launchable lane) is never returned; the
 *     framework's own recovery (stop-loss / critic) runs instead;
 *   - a hinted command next can run itself (a framework command with no
 *     placeholder) is a framework step that next --run executes;
 *   - only a hint with values the agent must author stays an agent step.
 */
import assert from 'node:assert/strict';
import * as driver from '../dist/handlers/next-driver.js';

const route = driver.reviewRefusalRoute;
assert.equal(typeof route, 'function', 'RUN29_REVIEW_REFUSAL_ROUTE_RED: next-driver exports reviewRefusalRoute');

const run29 = 'finding B-9c3a:F-004 failed shared managed-review live binding: managed_review_live_head_lineage_invalid ... (unauthenticated commit 410319195dbd "record B-9c3a review epoch metadata": review epoch commit rewrites earlier findings.json findings; Next: proof-or-stop review_round_prepare --storyId=B-9c3a)';
assert.deepEqual(route({ code: 'review_evidence_invalid', message: run29, launchableLanes: 0 }), { kind: 'framework_recovery' },
  'run 29: a no-op review_round_prepare hint is never delegated; the framework recovery runs');
assert.deepEqual(route({ code: 'review_evidence_invalid', message: 'evidence stale (no command named)', launchableLanes: 0 }), { kind: 'framework_recovery' },
  'no hint: the framework recovery runs');
assert.deepEqual(route({ code: 'open_review_loop', message: 'loop; Next: proof-or-stop review_round_prepare --storyId=B-1', launchableLanes: 0 }), { kind: 'framework_recovery' },
  'open_review_loop never follows a hint');
const cancel = route({ code: 'review_evidence_invalid', message: 'epoch stale; Next: proof-or-stop review_inventory_cancel --storyId=B-1 --reason="stale epoch"', launchableLanes: 0 });
assert.equal(cancel.kind, 'framework', `a framework command next runs itself is a framework step: ${JSON.stringify(cancel)}`);
assert.match(cancel.hint, /^proof-or-stop review_inventory_cancel /);
const authored = route({ code: 'review_evidence_invalid', message: 'Next: proof-or-stop finding_resolve --storyId=B-1 --findingId=B-1:F-001 --resolution="<what fixed it>"', launchableLanes: 0 });
assert.equal(authored.kind, 'agent', `a hint with values the agent authors stays an agent step: ${JSON.stringify(authored)}`);
console.log('REVIEW_REFUSAL_ROUTE_GREEN');
