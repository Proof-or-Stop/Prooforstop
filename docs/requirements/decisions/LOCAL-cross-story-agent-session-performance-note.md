# Cross-story agent session performance: root causes and prioritized optimization plan

Status: proposed; local analysis artifact, intentionally untracked

## Purpose

This owner-workspace note records operational improvements that need local
observation before they become tracked product policy.  It is deliberately not
part of a Story branch: implementation and lifecycle evidence remain in the
corresponding Story artifacts.

## Root causes

- A long validation run can be started before REVIEW evidence is complete,
  consuming capacity without proving that the candidate is admissible.
- A session can confuse a focused diagnostic with the final routine suite, then
  repeat work after source/test drift or metadata movement.
- Evidence refreshes with many pinned checks need an explicit bounded runtime
  budget; a liveness deadline is not evidence that a running verifier failed.

## Prioritized actions

1. Require an evidence-backed admission boundary before the final heavy suite.
2. Keep focused diagnostics short and separate from certification.
3. Bind final receipts to the reviewed source, test, verifier, and Story
   lineage; invalidate rather than silently reuse them after source/test drift.
4. Treat review inventory completion as prerequisite evidence, not as a claim
   that the implementation itself is certified.

## B-14ae PRE_CERT delivery

B-14ae makes the story-scoped routine `validate.commands` suite a PRE_CERT
operation.  A story-scoped routine REVIEW validation invocation is blocked
before child launch when it carries `--full` (even with `--focus`), or when it
has none of the `--focus`, `--channel`, `--concept`, or `--lint` carve-outs.
`--focus=fast` without `--full` remains the inexpensive producer of a fresh
signed receipt needed immediately before admission.  The subsequent
routine validation is performed once and TEST consumes that result rather than
launching another suite.  Any source/test drift invalidates the candidate and
returns it to REVIEW.

This is a correctness and capacity-control change.  No proposed savings of
3-8 hours are claimed here; elapsed-time benefit must be measured separately
from the signed lifecycle evidence.
