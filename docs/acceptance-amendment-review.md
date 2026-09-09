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
