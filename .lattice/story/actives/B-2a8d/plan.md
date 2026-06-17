# B-2a8d Execution Plan — remove Phase 4 / L4 cross-project from the Experience Layer plan

Documentation-only edit to docs/requirements/decisions/lattice-experience-layer-execution-plan.md.
Per-project-only becomes the documented design. Keep the Phase 1 "deterministic local
signature" concept; remove only the cross-project (L4 / Phase 4) framing. No source code.

## CHK-001 Remove the L4 Architecture bullet and the Phase 4 Roadmap bullet
Delete the "- L4 Cross-project aggregation (future). Two-layer signatures (localSignature ...
publicSignature ...)" Architecture bullet (~line 78-81) and the "- Phase 4 - cross-project.
org-local / anonymized cross-project aggregation (local/public two-layer signatures)" Roadmap
bullet (~line 248-249). Keep L1/L2/L3 and Phase 1a/1b/1.5/2/3.
Verification: grep finds no "L4 Cross-project", "Phase 4", or "publicSignature" in the doc;
L1/L2/L3 bullets and Phase 1a..3 roadmap items still present.

## CHK-002 Reword remaining cross-project references to per-project-only; fix the "levels" count
- Principle 5 "Local first, cross-project later; structured first, embedding later." -> state
  per-project-only / no cross-project learning by design, keeping the structured-first / embedding-
  later clause.
- Problem statement "and cross-project footprint" mention (~line 21) -> drop the cross-project
  clause (keep the rest of the data-source list).
- Not-to-do line "no cross-project aggregation in v1" (~line 267) -> per-project only, by design
  (not a future item).
- "The four semantic levels are unchanged from v1.0" (~line 66) -> "three semantic levels".
- Do NOT touch the L1 "aggregated by a deterministic local signature" sentence (~line 69).
Verification: doc states per-project-only by design; "three semantic levels"; the L1
local-signature sentence is byte-unchanged; no cross-project framing remains.

## Out of scope
Any TypeScript/source change; the built Phases 1a-3; removing the Phase 1 local-signature concept;
adding multi-repository sharing.
