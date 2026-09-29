#!/usr/bin/env node
/**
 * Lab critic-self-canonical: run 4 (2026-09-29) lost the whole Story because a
 * topology critic wrote verified_family with canonicalFinding pointing at the
 * row's own finding. The prompt calls canonicalFinding optional and the
 * inventory consumer accepts it, but the envelope validator rejected the
 * receipt as malformed with no reason. A self reference is redundant, not
 * contradictory; a reference to another finding must still be rejected.
 */
import assert from 'node:assert/strict';
import { classifyManagedReviewFinalEnvelope } from '../core/host-run.js';
import { isManagedInventoryCritic, MANAGED_INVENTORY_CRITIC_LANE } from '../core/managed-inventory-critic.js';

const run4Envelope = "{\n  \"schemaVersion\": \"lattice.managed_review_final_proposal.v1\",\n  \"storyId\": \"B-8ad8\",\n  \"providerAgent\": \"proof-or-stop-review-topology-critic\",\n  \"lane\": \"proof-or-stop-review-topology-critic\",\n  \"reviewRunId\": \"B-8ad8:RR-004\",\n  \"conclusion\": \"pass\",\n  \"note\": \"Inventory completeness review passed on the signed B-8ad8:RI-001 wave 1 pack. All three required lanes have signatureValid=true terminal/read evidence, and the single aggregate finding B-8ad8:F-001 is independently reproduced as the explicit-null-step sentinel family in evaluator/evaluator.go and remains open and blocking. Focused ast/parser/evaluator slice tests pass, and a disposable REPL run confirmed that [1, 2, 3][0:3:null] returns [1, 2, 3] while a = [1, 2, 3]; a[0:3:null] = [9, 8, 7] writes all three indexes. No additional missed read path or new finding family was found on this cutoff; controller-fetched acceptance_rollout reports are missing with blocking=false.\",\n  \"readManifest\": {\n    \"filesReadFully\": [\"ast/ast.go\", \"parser/parser.go\"],\n    \"filesTriagedByName\": [\"evaluator/evaluator.go\", \"evaluator/evaluator_test.go\", \"parser/parser_test.go\", \"docs/src/docs/types/array.md\", \"docs/src/docs/types/string.md\", \"docs/src/docs/syntax/assignments.md\", \"docs/src/docs/syntax/operators.md\", \"examples/unicode.abs\"],\n    \"scanEscalationReason\": \"Managed review was blocked on missing candidate-spec route; use deterministic local routing because the changed file set and acceptance intents are already fully inventoried in the enforced scope contract.\",\n    \"candidateSpecSetDigest\": \"a4747e1c2e9bac49adc1e8e51656cde9ace22f0f69f74afec4c14341dc793a8b\",\n    \"corpusDigest\": \"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945\"\n  },\n  \"readLog\": {\n    \"filesReadFully\": [\"ast/ast.go\", \"parser/parser.go\"],\n    \"filesTriagedByName\": [\"evaluator/evaluator.go\", \"evaluator/evaluator_test.go\", \"parser/parser_test.go\", \"docs/src/docs/types/array.md\", \"docs/src/docs/types/string.md\", \"docs/src/docs/syntax/assignments.md\", \"docs/src/docs/syntax/operators.md\", \"examples/unicode.abs\"],\n    \"summary\": {\n      \"readCount\": 2,\n      \"tokenCount\": null\n    },\n    \"digest\": \"923d78f814c02b7f608a6be8050fe0b6f0040d019c0e695577cb62cbcdcd6018\"\n  },\n  \"inventoryCritic\": {\n    \"epochId\": \"B-8ad8:RI-001\",\n    \"wave\": 1,\n    \"findingDispositions\": [\n      {\n        \"finding\": {\"findingId\": \"B-8ad8:F-001\"},\n        \"disposition\": \"verified_family\",\n        \"familyKey\": \"evaluator.explicit_null_step_sentinel\",\n        \"canonicalFinding\": {\"findingId\": \"B-8ad8:F-001\"},\n        \"reason\": \"Independently reproduced the explicit-null-step behavior and confirmed B-8ad8:F-001 remains a single verified root-cause family on this cutoff.\"\n      }\n    ]\n  }\n}";

const verdict = classifyManagedReviewFinalEnvelope(run4Envelope);
assert.equal(verdict.kind, 'valid', `run-4 critic envelope rejected: ${JSON.stringify(verdict)}`);

const lane = MANAGED_INVENTORY_CRITIC_LANE;
const row = (extra: Record<string, unknown>) => ({ epochId: 'B-x:RI-001', wave: 1, findingDispositions: [{
  finding: { findingId: 'B-x:F-001' }, disposition: 'verified_family', familyKey: 'fam', reason: 'independently reproduced', ...extra }] });
assert.equal(isManagedInventoryCritic(row({}), lane, lane, 0), true, 'plain verified_family stays valid');
assert.equal(isManagedInventoryCritic(row({ canonicalFinding: { findingId: 'B-x:F-001' } }), lane, lane, 0), true,
  'self-referencing canonicalFinding on verified_family is redundant and must be accepted');
assert.equal(isManagedInventoryCritic(row({ canonicalFinding: { findingId: 'B-x:F-002' } }), lane, lane, 0), false,
  'verified_family pointing at another finding is contradictory and must stay rejected');

console.log('critic-self-canonical-smoke: PASS');
