# B-8195 Execution Plan

## Objective
Make the mandatory TEST validate converge in one invocation when a fresh PASS is reusable and the only intervening change is causally proven canonical lifecycle metadata. Preserve every existing fail-closed boundary for untrusted dirt.

## CHK-001 — Persist an exact RED for TEST-transition fresh-PASS reuse
Build a fixture around the real local CLI boundary. Establish a fresh PASS, enter the production-equivalent TEST transition without a manual cleanup commit, then invoke validate once. The desired assertions are PASS, disposition=reused, commandExecutions=0 and a clean canonical metadata set; current code must fail on canonical-pass-persistence-failed. Keep a project-command counter outside the fixture repository and add a negative control proving pre-existing human/external process-event dirt remains rejected.

## CHK-002 — Make trusted lifecycle metadata and reused PASS persist atomically
Reuse the existing generated-metadata baseline, append-only process-event binding, exact path manifest, immutable isolated-index commit and rollback/CAS primitives. Admit only a delta whose invocation, story, entry HEAD, canonical path and content digest are bound to the immediately preceding authorized flow. Do not infer trust from the process-events path, event type, prose or metadata-only status. Persist the admitted delta, reused test evidence and closeout receipt as one exact transaction.

## CHK-003 — Verify one-shot convergence and fail-closed security boundaries
Turn the RED green and assert a second unchanged invocation is idempotent. Retain or add cases for human_confirmation, direct edits, forged/replayed event-shaped data, malformed receipt, aliases, unrelated source/config dirt, concurrent HEAD/content changes, commit-hook mutation, writer failure and rollback restoration. Run build, validation-evidence-reuse smoke, done-prepare auto-closeout smoke, process-fact contract and git diff check. Run the root suite only at final DONE-required validation.

## Rollback
Revert the narrow transaction admission/writer change and its tests. No artifact migration is required. Existing behavior then returns to fail-closed infra_failure; it must never fall back to generic metadata-only acceptance.

## Completion Evidence
A live TEST transition followed by one validate prints Validation PASS reused, disposition=reused and commandExecutions=0, exits successfully and leaves the tree clean. Separate adversarial transcripts prove untrusted dirty state still fails closed.
