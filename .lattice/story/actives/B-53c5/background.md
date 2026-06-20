## Trigger Event

The adversarial multi-lens review capability spec (docs/adversarial-review-spec.md, merged commit ac8e644d2) §5 defines a 5-story contract-first build program; S0 is the SERIAL-first frozen contract that every later story imports. The operator asked to build the capability (B-impl) starting now.

## Key Insight

The entire methodology's design decisions are already frozen by the spec (§2/§3): the Finding/Verdict schemas, the canonical lens set, the threshold-confirm rule, the completeness-critic IO, and the one canonical round order. S0's job is to translate that frozen contract into a single TypeScript source-of-truth module + the review-mode interface, with NO behavior — exactly the contract-first shape the parallel-decomposition program (B-59c7 Story 0) proved: freeze the interface first so the parallel impls (S1 lens-runner, S2 verifier, S3 critic) build against a stable surface without re-design. The mode interface must encode the canonical order as a single declared sequence so S1-S4 cannot drift from §2.4/§3.2/§4.2.

## Tradeoff

Types-only contract module vs co-locating behavior: a behavior-free contract module that every story imports keeps the schemas the single source of truth and lets S1/S2/S3 build in parallel (disjoint files) — at the cost of an extra module. We take it (the program's whole point is contract-first parallelism). Encoding the canonical order as a declared constant/interface vs leaving it implicit: declaring it makes drift mechanically detectable (S4 wires to it) — we declare it.

## Conversation Texture

This is the first build story of the capability whose SPEC the operator just had built (B-0e7b) — and whose own review demonstrated the methodology by finding 9 buildability gaps. The build must itself go through the full Lattice workflow with genuine Claude+Codex full-3x2 review (the recurring program standard). S0 is types + interface only; behavior lives in S1-S4.
