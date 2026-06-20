# Plan — B-0e7b: docs/adversarial-review-spec.md (adversarial multi-lens review capability spec)

Doc-only deliverable: a contract-first design spec. The 4 checklist items are the 4 spec sections. Write the doc in DEV; verification is docs-accuracy (sections present, claims correctly attributed, schemas concrete, MVP/future honest, build program buildable).

## CHK-001 — §1 Motivation + Empirical Evidence
Argue single-pass review misses INTEGRATION-level defects. Cite the concrete program evidence with story IDs + the EXACT filing component (verify against findings.json):
- S4 (B-fa7c): corrupt scope-contract.json crashing the wave projection — found by the quality + crashsafe DIMENSIONAL LENSES (not the critic); the critic found the test-coverage gap.
- S5 (B-086b): the parallel hard-gate bypass doors — express channel (F-003) and REVIEW/TEST rework-rollback (F-006) — found by the COMPLETENESS CRITIC across two rounds.
- B-b29e: read-only scope_contract_check over-registered as a gate producer (F-001) — found by the critic.
Framing: single-pass is not useless; it misses the integration gaps that independent lenses + a critic surface.

## CHK-002 — §2/§3 Methodology + data shapes
Define LENS (a facet review returning structured findings), FINDING {severity, file, line, issue, fix}, VERDICT {isReal, agreedSeverity, reasoning}. Specify the per-finding ADVERSARIAL VERIFICATION rule: M independent skeptics, default isReal=false (refute-by-default), a finding counts only on a majority/≥threshold confirm. Specify the COMPLETENESS-CRITIC contract: input (the surfaced+confirmed findings + the change), its job (what did the review MISS — a 5th door, an unverified claim, a modality not run), and reopen semantics. Specify the CONVERGENCE criterion: a round is clean when all lenses PASS, every surfaced finding is adversarially refuted-or-fixed, and the critic finds nothing new. Define this as a Lattice review MODE (composing lanes), NOT a dependency on the harness Workflow tool.

## CHK-003 — §4 Lattice integration contract + MVP/future
Compose the existing substrate: lattice-review-* lanes, review_run_start/review_pass_set/finding_add, the full-3x2 escalation (define inline: 3 rounds × 2 independent PASS hosts, claude-code + codex, via autopilot_review_submit). Define the capability as a review MODE / escalation TIER. State how a critic-reopened round binds to the escalation ledger (new round = new reviewRunId; materialHash freshness) and the convergence/quorum interaction. Give an explicit MVP-vs-future table: MVP = a documented reusable orchestration + the minimal lane/finding hooks; future = a first-class CLI review mode. Every future surface labeled not-yet-implemented.

## CHK-004 — §5 Implementation-program breakdown
Contract-first story breakdown (mirror parallel-decomposition §8): e.g. S0 frozen contract (lens/finding/verdict schemas + the mode interface) → S1 lens-runner → S2 adversarial-verifier → S3 completeness-critic lane → S4 escalation-flow integration. Each story: scope, dependencies, acceptance. Mark MVP vs optional/future. The schemas from §2/§3 are the frozen contract so the build proceeds without re-design.

## Verification
The doc has the 4 sections with the above content; claims verified against findings.json; lattice validate stays green (no code). userSees: opening docs/adversarial-review-spec.md, a complete spec a reader can build the capability from.
