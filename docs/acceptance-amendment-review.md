# Independent acceptance amendment review

DEV amendments use `acceptance_amendment_reviewer` and the dedicated
`proof-or-stop-acceptance-intent-reviewer` lane. They cannot mint a Story REVIEW
pass. The shared host supervisor runs the reviewer in an isolated, read-only
scratch bound to the submitted HEAD and material hash.

A reviewer returns exactly one final JSON object with schema
`proofbound.acceptance_amendment_review_final.v1`, the exact run ID, Story ID,
amendment ID and digest, original acceptance digest, submitter session ID,
`decision` (`approve` or `reject`), a substantive `rationale`, and nonempty
`readRefs`. Codex uses its final assistant event or standalone final JSON;
Claude uses successful structured output. Later ordinary Codex prose invalidates
an earlier candidate. Duplicate, partial, malformed or mismatched results fail.
An honest rejection is a completed review, and must never be treated as approval.

Only the supervising worker holds the ephemeral signing key. After actual child
exit, verified cleanup and unchanged scratch checks, it seals the proposal,
root, prompt, spec, binding projection, result and cleanup. The provider receives
no private key. The amendment journal must pin the public key returned at submit
time in its signed review attempt before consuming the verdict. A key embedded
in a submitted verdict is never sufficient. The consumer checks the exact
subject against that pinned key, including after runtime retention GC; replacing
a verdict and recomputing unsigned host receipt digests cannot forge approval.

The amendment controller derives the reviewer prompt, verifies that original
acceptance remains current, and applies only the approved additive delta. A
reviewer execution receipt by itself authorizes no acceptance mutation.

Verification: `node scripts/verify-acceptance-review-receipt.mjs` uses actual
child processes for both provider envelope formats, failed and duplicate output,
subject mismatch, normal cleanup, archive retention, and digest-consistent
signature forgery. It is local Lab evidence, not an external-provider benchmark.

The signed amendment journal records the original checklist, scope contract and
ProofStory contract, the additive delta, and the exact derived result. Each entry
and the complete entry collection are signed with the repository's trusted Git
common-directory key. Deleting, reordering or replacing entries invalidates the
journal. Review key creation calls the journal synchronously before launching a
worker; a failed launch retains its attempt and key.

`PROPOSED` and `REVIEWING` leave acceptance unchanged. Application requires the
independent `approve` verdict, unchanged original acceptance, and current clean
reviewed source. It writes a signed `APPLYING` marker before the checklist, scope
and ProofStory writes. A crash leaves completion blocked. Recovery accepts only
the original or exact derived value of each artifact, never unknown concurrent
edits, and rechecks reviewed source before and after writes. Only complete exact
readback becomes `APPROVED`. Exact approved retries do not rewrite history.

An unsuccessful review attempt is never silently replaced. Inspect its exact
run with `host_run_status`; cancel the amendment with a reason and propose a new
ID after terminal failure, rejection or pre-application source drift. Cancellation
retains history and cannot discard an `APPLYING` or `APPROVED` entry. If source
changes during interrupted application, restore the reviewed source before
recovering that application. These recovery rules also apply to the public CLI commands below.


## Public DEV workflow

1. `acceptance_amendment_propose` accepts `storyId`, a stable `amendmentId`, and
   `delta` containing `addItems`, `appendIntents`, `scopeDelta` and `topologyDelta`.
   Scope delta arrays are `modify`, `create` and `test`. New requirements need
   mandatory verification intents, explicit file relationships and complete
   producer/consumer/assertion/mutation topology. Original intents stay frozen.
2. `acceptance_amendment_review` accepts the same identifiers and `host` (`codex`
   or `claude`). It launches one independent reviewer and returns the managed run
   ID. Inspect that run with `host_run_status`; an exact retry reuses the attempt.
3. `acceptance_amendment_approve` accepts only the two identifiers. Despite its
   name, the owner cannot supply an approval: it consumes the independently
   signed approving verdict and applies the exact reviewed amendment. A rejection
   does not grant application authority.
4. Execute the new verification through `verification_evidence_add` or
   `verification_evidence_batch_add`, then mark the amended checklist item done.
   Refresh structural acceptance-basis evidence through its existing verifier
   when the approved scope or topology change makes that evidence stale.

`acceptance_amendment_show` verifies and reads history in every phase.
`acceptance_amendment_cancel` requires the identifiers and a reason. All four
mutating commands require DEV and the current owner; new requirements discovered
in REVIEW must return to DEV. Caller-selected verdicts, keys, signatures and
submitter identities are not accepted.

Pending, interrupted or invalid journals block checklist completion,
DEV-to-REVIEW, REVIEW-to-TEST, DONE and its shared preflight, certification-window
admission, and story-aware validation. A done item cannot have both zero intent
and zero evidence. Direct DEV checklist additions, new checklist file scope,
contract path growth and topology rewriting cannot bypass the amendment. An
out-of-scope acknowledgement cannot replace independent approval. Existing
literal scope may be narrowed by an existing literal prefix. Glob entries may
only be retained exactly: a matching literal can authorize a directory subtree
that the old glob excluded. Existing protection cannot be removed.

Verification: `node scripts/verify-acceptance-amendment-gates.mjs` records actual
sum assertions for 35 existing intents, legally adds and verifies the missing
36th intent, and reaches 36/36 coverage without waivers or changes to the first
five checklist items' original intent/evidence history. This is a structural
reproduction of the documented missing-intent problem, not a claim that the
original B-cdf6 product workload was replayed. It also exercises public handlers,
all completion consumers, malformed caller authority fields, direct scope and
glob/acknowledgement bypasses, and proposal, approval and cancellation retries
while a different review is active. Exact retries do not commit that review’s
uncommitted key pin or change its reviewed HEAD.

`node scripts/verify-acceptance-amendment-historical.mjs` also reads the real
B-cdf6 source through the CLI, proves CHK-006 is blocked, derives an additive
proposal and verifies that the historical source and preceding items are unchanged.
The retained snapshot now contains 37 intents, rather than the report's earlier
35; the proposed total is 38. This read-only check does not mint reviewer or
product evidence. The original normal-runtime compatibility promise was
superseded by `docs/requirements/decisions/proof-or-stop-identity-cutover.md`;
restoring that retired behavior is not part of the acceptance mechanism repair.
