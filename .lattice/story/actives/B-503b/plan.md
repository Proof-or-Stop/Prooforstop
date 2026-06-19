# Review Assurance Floor Execution Plan

## CHK-001

Goal: create `docs/requirements/decisions/review-assurance-floor-execution-plan.md` as a durable execution plan, not runtime implementation.

Steps:

1. Create a `decision_doc_proposal` sourced from `decision.json` with slug `review-assurance-floor-execution-plan`.
2. Review the proposal digest and save it through `decision_doc_save` so the target path is materialized by Lattice CLI.
3. Ensure the document defines four policy buckets: docs-only typo/annotation, ordinary code change, code change with failure/bug/rework signal, and high-risk lifecycle/gate/Authority/process-fact change.
4. Preserve host-neutral boundaries: local host verdict evidence is local Non-authority evidence; Authority completion requires verified Authority Server `gate_decision` receipts.

Acceptance:

- The document states ordinary code changes cannot reach DONE with zero review.
- The document states bug, validation failure, reviewer finding, or rework signals escalate to 3 rounds x 1 local host unless stronger policy requires 3x2.
- The document does not claim 3x1 is two-host independent review or Authority completion.

## CHK-002

Goal: audit the written document using the requested three local single-host rounds before closure.

Steps:

1. Round 1: check whether the policy solves the real correctness issue without arbitrary optimization.
2. Round 2: check consistency with existing review escalation and DONE gate documents.
3. Round 3: check Authority boundary wording and ensure local Non-authority evidence is separated from receipt-backed Authority Server proof.
4. Record each round as verification evidence against CHK-002 and only revise the document for real correctness issues found during those rounds.

Acceptance:

- Three audit rounds are recorded as local single-host, not two-host.
- Each round explicitly applies: do not optimize for optimization, do not optimize arbitrarily, only fix real correctness issues, and follow consistency of logic.
- Any Authority-related wording remains non-overclaiming: no `authorityDone`, `fullAuthorityDone`, or `productionDone` claim is made from local audit evidence.
