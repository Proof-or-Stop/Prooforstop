# B-36fd Plan: Author the corrected experience-layer ablation causal-validation execution plan (rev 2)

## Goal
Restore the deleted rev-1 draft as a corrected rev-2 decision doc at docs/requirements/decisions/experience-layer-ablation-causal-validation-execution-plan.md, integrating exactly the 12 adjudicated findings of the 2026-07-02 two-round adversarial review. Docs-only; milestones M0-M9 remain future stories.

## CHK-001 Author the corrected execution plan document with all 12 verified corrections

### Steps
1. Author the rev-2 document from the session-preserved rev-1 text + the 12 adjudicated corrections. Structure: 18 sections mirroring rev-1 (problem, claim boundary, hypotheses, arms, populations, metrics, sample size, study geometry, leakage controls, scoring, analysis, artifacts/isolation, milestones, verification matrix, no-overclaim, paper integration, execution order, definition of done) + a revision-provenance header.
2. Apply the corrections at their designated sections:
   - S2/S15/S16: circularity disclosure + held-out contrast requirement (finding: answer-key circularity).
   - S3/S6: co-primary H1a composite + H1b recurrence on the fault-bearing stratum; deterministic reviewer-free primary (findings: endpoint alignment, deterministic scoring).
   - S4: two arms only; control = compute-and-log instrumented shadow; no allocated Shadow C (finding: shadow-arm redundancy).
   - S5.1: Group 1 in-store traps vs Group 2 held-out negative-control traps; clean tasks separated (findings: circularity, powering stratum).
   - S5.2/M8: extend the existing resolveHintMode + learning_effectiveness substrate; no second live assignment system (finding: live-RCT reuse).
   - S7: per-population parameter table (seeded 0.5-0.8 baseline / 0.25-0.35 MDE -> ~29-58 per arm; live 0.30/0.10 -> ~294), fault-stratum-only powering, pilot-validated baseline before N freeze (finding: 6x mis-sizing).
   - S8: full-factorial matched-pairs geometry with McNemar + committed run-order seed; randomization only for live (finding: incoherent 5-factor blocking).
   - S9: per-trap in-tree answer-source stripping + M6 fixture-leakage audit (finding: leakage).
   - S10: deterministic score schema (pairId, trapGroup, storeRoot, retrievalViolationCount; arm control|treatment only).
   - S11: risk difference sole decision criterion; RR descriptive with Haldane-Anscombe zero-denominator guard; BH-FDR across H2-H5 (findings: RR guard, multiplicity).
   - S12: .lattice/experiments/experience-ablation/<experimentId>/ root; mandatory mkdtemp store isolation (worktrees canonicalize back via resolveLearningRoot); frozen memory-pack snapshot (findings: naming, pollution, non-stationarity).
   - S13: Reuses column naming hint-mode.ts / experience-hint-surface.ts / recovery-runner / adjudicate.mjs / checks.mjs / analyze.mjs / packages-lab (finding: reuse-over-rebuild).
   - S17: shared-resource scheduling note; s5/s6 powered run completed 2026-06-29, no gating dependency (finding: sequencing).
3. Final consistency pass: CJK grep (must be zero), referenced-path existence check, corrections-to-findings trace check, markdown structure check.
4. Commit the single file on the story branch before REVIEW (commit-before-review rule).

### Verification
Per CHK-001 verificationIntent: happy (file complete + 12 corrections present at designated sections + component facts match source), edge (zero CJK; no dangling paths), adversarial (no un-adjudicated design deltas; no-overclaim rule intact and strengthened by the circularity disclosure).

## Non-goals
No implementation of M0-M9; no changes to any code, gate, schema, or other doc; no restoration of the rev-1 text as a separate file.
