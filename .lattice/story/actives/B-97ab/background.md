## Trigger Event

The adversarial-review build program (docs/adversarial-review-spec.md §5) landed S0 (B-53c5, merged 0.3.28) — the frozen contract (Finding/Verdict/lens-set/critic-IO/REVIEW_MODE_PHASES). S1 is the first of the three parallel impls (S1 lens-runner, S2 verifier, S3 critic) that build on S0; it implements the lens-running half of the canonical order (§4.2): run each lens on its lane, returning raw findings.

## Key Insight

The lens runner's power is INDEPENDENCE: each lens reviews one facet seeing only the diff + source, never the other lenses' outputs (shared context collapses the multi-lens surface back to one pass — §2.1). So S1's deterministic, testable core is the lens->lane mapping (§4.2), a run-plan builder that emits one isolated request per lens, and a runner that applies an INJECTED per-lens function (the actual review-agent call is harness/main-agent supplied — the methodology is harness-independent per §3.3, so S1 takes the lens executor as a seam) and aggregates per-lane raw Finding[]. The injected seam makes the whole runner hermetically testable with a fake. The ledger mapping (BLOCKER->critical, finding_add) and verification are deliberately NOT here — they are S2; S1 stops at raw Finding[].

## Tradeoff

Injected runLens seam vs S1 spawning agents itself: injecting the per-lens executor keeps S1 harness-independent (§3.3) and hermetically testable (fake runLens), at the cost of the caller wiring the real executor — we take it (the spec mandates harness independence; S4 wires the real loop). Importing the real lane list vs hardcoding six strings: cross-checking the mapping against review-run.ts REVIEW_RUN_LANES (at least in the smoke) pins it to reality so a lane rename is caught — we pin it.

## Conversation Texture

This is a parallel impl story of the adversarial-review capability the operator asked to build (B-impl). It imports the S0 contract unchanged (the contract-first guarantee) and must itself pass genuine Claude+Codex full-3x2 review. Disjoint from S2 (verifier) and S3 (critic) — different file, different functions.
