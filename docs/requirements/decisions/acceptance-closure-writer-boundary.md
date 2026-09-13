# Acceptance closure: writer boundary and missing checklist obligations

On 2026-09-13 the user explicitly requested Lab repair and RED/GREEN comparison of
B-3434 F-037 and the historical and recent acceptance omissions. This authorizes a
bounded local maintenance repair across the previously excluded StoryStore boundary.
The historical decision in validation-evidence-artifact-growth.md remains preserved,
including its reviewed digest and Finding IDs. Its decline describes that Story's
scope at that time; this new Lab supplies the previously absent writer protection.

StoryStore.writeTestEvidence now serializes once using the existing JSON format,
measures the exact UTF-8 string including the newline, and refuses more than 24 MiB
before creating a temporary file or replacing previous evidence. The 32 MiB reader
ceiling and 24 MiB writer ceiling derive from one dependency-free policy module.
Caller-side reduction remains best-effort. Its earlier size measurement is not an
identity guarantee for the published object. Other artifacts retain their own rules.

Once a checklist uses explicit verification, a non-withdrawn item with no intent
produces a required missing-coverage diagnostic. The diagnostic is not a stored
intent or evidence receipt. Existing all-empty legacy/express policy is unchanged.
This closes the partially bound checklist shape exemplified by B-cdf6 CHK-006;
it does not retrospectively invent its missing historical intent or receipt.

The committed regression runs the actual StoryStore in an isolated temporary root,
measures a 60 MiB post-measure mutation, exact-bound and one-byte-over inputs,
UTF-8 expansion, single serialization, atomic preservation, and partial checklist
coverage. The canonical process-fact verifier executes it, so it cannot disappear
solely because a new test was omitted from the full-suite inventory.

Lab evidence is local maintenance evidence, not Story DONE or release approval.

## Follow-up: avoid a late publication-only recovery loop

The follow-up Lab starts from local main 0.3.352. A successful size check over a
mutable record could still be followed by an oversized write or a different
commit digest. The final writer now exposes a side-effect-free preparation that
serializes and bounds the exact bytes once. Its opaque, immutable token is bound
to the originating StoryStore and Story ID. Executed and reused validation derive
transaction hashes from that token and publish its stored string without
re-reading the caller's object. No certification policy or phase transition is
relaxed. Generic filesystem/commit failures and actual material drift retain
existing refusal rules; this is not an automatic retry of the full suite.

The isolated lifecycle witness runs the real validate CLI, earns an initial PASS,
then exercises post-preparation mutation, explicit preparation refusal and an
unchanged retry. It checks real publication, non-PASS refusal, preserved prior
bytes, one project-command execution across the reuse cases, and unchanged phase/review-round state. The added fresh-execution refusal and newly admitted recovery bring the full witness to three project-command executions; an unchanged retry of the consumed window must be refused.
Synthetic admitted windows are test fixtures, not historical Story credentials.


Audit follow-up: missing acceptance and publication recovery

A mixed checklist follows the existing resolveVerificationIntentPolicy rule: any authored intent selects explicit-intent, even when the item-count channel is express. Only the all-empty express shape is express-exempt. The coverage diagnostic now names the existing recovery commands. INIT/PLAN authors through checklist_update; DEV uses acceptance_amendment_propose/review/approve followed by executed verification_evidence_add. REVIEW requires its inventory remediation receipt before guarded story_advance DEV; TEST also uses guarded DEV re-entry. This is an actual missing requirement, not a retryable publication fault, and can legitimately require rework. No automatic phase transition or historical Story recovery is performed.

The existing executable verify-acceptance-amendment-gates fixture now asserts that 35 actual receipts leave CHK-006 missing in a 36-entry report, then exercises the public signed amendment handlers and actual 36th receipt to clear the blocker. Its provider transport is an isolated synthetic fixture, not independent Story approval. The production recovery implementation is core/acceptance-amendment.ts and handlers/acceptance-amendment.ts, which support a completely absent verificationIntent.

Preparation tokens are single-use after successful publication; failed or wrong-store attempts do not spend them. The real CLI lifecycle test covers both reused-pass refusal and fresh-execution refusal, preserving old bytes. Reuse-publication refusal allows an unchanged valid retry. A genuinely oversized record after fresh heavy execution spends that window: unchanged heavy retry is correctly refused, and the fixture uses a new material identity and test-only admitted window for recovery. This does not claim real PRE_CERT re-admission or waive its independent prerequisites. The reducer and final writer now share isWithinValidationEvidenceWriteBound: exactly the cap is admitted and cap+1 is refused. Size classification still names the inclusive upper sizing tier; that diagnostic tier is distinct from write admission.

Second audit closure: explicit-policy membership now uses the same historical intent counter as workflow policy, so withdrawing the last bound item cannot hide remaining delivered bare items. Withdrawn items themselves remain excluded. Legacy evidence without intent is diagnosed with verification_intent_repair (schema backfill, not PASS), while genuinely new acceptance still uses the additive DEV workflow. The reducer convergence predicate and its smoke oracle now use the shared inclusive budget rule. Reviewed threshold rationale lives with the shared constants. Publication fixtures require the actual preparation APIs, assert the specific oversize error, and isolate temporary Git configuration from global signing/hooks. Historical RED transcripts retain their original code revision; current regression scripts add audit controls and are not claimed byte-identical to those historical scripts.
