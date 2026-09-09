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

This is the execution and provenance layer. The amendment application layer must
also derive the canonical prompt, verify the original acceptance remains current,
block completion while an amendment is pending, and apply an approved additive
delta exactly once. This receipt by itself authorizes no acceptance mutation.

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
recovering that application. These are core controller operations; CLI and
completion-gate integration are separate from this journal layer.
