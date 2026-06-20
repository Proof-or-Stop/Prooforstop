# B-0607 Plan

## Outcome

Create docs/requirements/decisions/truth-first-host-handoff-stale-doc-guard-execution-plan.md. The document must be concrete enough that a later implementation story can wire host handoff preflight, stale-plan detection, and dev-memory consumption without re-litigating the problem. It must remain explicit that this story does not implement runtime code, does not rerun signature_backfill, and does not claim Authority or production completion.

## CHK-001

Document the verified stale-doc misclassification failure mode. The section must cite the specific observed pattern: a host can read a plan-only document and infer unfinished work even when current facts prove completion. It must include the Experience Layer example: the plan document is marked future/plan-only, the effectiveness record states the outcome is built/live, commit 2750aadef records the backfill, and the current data contains 656 signatureTagSource=backfill findings. It must also separate completed backfill work from still-deferred causal/RCT claims, so the plan does not overclaim.

## CHK-002

Define the Truth-First Host Handoff contract. The contract must name the evidence priority order: live Lattice state, story phase and summary, accepted outcome records, current code/data evidence, fresh validation, gap analysis, learning validity, and dev-memory preflight outrank old plan prose. It must define the host response rule: if a host only has a plan-only or stale document, it may say the document appears stale and must verify current facts, but it must not tell the user the work is missing or ask for redo. It must preserve dev-memory and learning signals as advisory context, not gate or Authority evidence.

## CHK-003

Specify the follow-up implementation stories and gates. The execution plan must break implementation into small stories: document supersession metadata, host handoff/preflight fact pack, dev-memory preflight injection for Codex/Claude/Antigravity, stale-plan detection and warning, and verification/negative tests. Each story must list inputs, outputs, acceptance commands, and at least one adversarial case. The key adversarial case is an old plan-only document saying future work while DONE summary/data evidence proves completion; the host must not produce a redo instruction.

## Verification

This story is document-only. Verification will use docs checks: grep for the required sections, grep for the concrete facts and commands, inspect the source navigation if updated, run scope_contract_check, and run story validation. No runtime implementation or data regeneration is expected in this story.
