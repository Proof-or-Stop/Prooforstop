# Plan — B-cb13: Experience Layer effectiveness-proof development record (decision-doc)

Documentation-only. Land an in-repo development record via the decision_doc flow.

## CHK-001 — Author + land the decision-doc
- `decision_doc_proposal` with storyId=B-cb13, sourceDecision=manual, slug=lattice-experience-layer-effectiveness-record, title="Lattice Experience Layer -- Effectiveness-Proof Development Record", and structured fields:
  - decision: the per-project Experience Layer effectiveness-proof track is built + live (referential re-validation + the forward A/B apparatus + signature_backfill), with effectiveness reported observationally (learnable real-signature substrate proven) while the causal claim is deferred to the forward ON/OFF RCT.
  - context: Baseline A's rho=-0.55 was a degraded-signature lower bound; real signatures were needed; the live base had no signatures so the apparatus reported zeros.
  - scope: per-project Experience Layer on Orchestrate main; the six stories + the backfill apply.
  - nonGoals: cross-project aggregation; a causal proof (deferred); claiming the saturation-inflated rising curve; persisting degraded experience.
  - chosenApproach: the six components (B-a2e3/B-4eb6/B-5d48/B-06b3/B-c06a/B-17a9) + offline LLM backfill (evidence-first) + live signature_backfill apply (656 signatures, commit 2750aadef).
  - alternatives (>=2): degraded-signatures-only (Baseline A); cross-project aggregation; persist-without-evidence -- each with pros/cons.
  - operationalRules: how to run learning_scan / learning_validate / learning_effectiveness / signature_backfill; the honesty guards (report held-out recall not rho; recall-with-specificity; observational != causal).
  - verificationRequirements: the held-out temporal-split metric; the forward ON/OFF RCT to accrue; _hash invariance on backfill; drift re-validation.
  - risks: saturation confound; observational != causal; signature quality depends on LLM consistency; live-vs-offline differences.
- `decision_doc_preview` to render + get the proposal digest, then `decision_doc_save` (mode=create, confirm=true, expectedProposalDigest=<digest>) -> docs/requirements/decisions/lattice-experience-layer-effectiveness-record.md.

## CHK-002 — Verify facts + English-only + cross-refs
- Confirm the six story IDs exist; commit 2750aadef exists; live numbers reproduce on main (learning_scan ~320, learning_effectiveness recall ~0.659, learning_validate valid-rate ~0.971); the doc is ASCII/English-only (grep -P '[^\x00-\x7F]' returns nothing); the Work/lattice-Paper/ references name real files. docs reviewer checks doc-vs-code consistency.
