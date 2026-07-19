## Trigger Event

A RED harness (tmp/w1-red/red-language-degradation.cjs, probe rp-mrqybe17-8biryq) shows that an identical `type=bug` story flips repro-first `required=true` only when its files are `.ts`; the same story in `.py/.rs/.go/.java/.cpp` stays `required=false`. Confirmed across three cross-host audit rounds; the language-neutral design reached APPROVE-WITH-CHANGES from both codex and agy (plan v4).

## Key Insights

Material-code classification is TS-centric and is the shared choke point for two gates:
- `classifyReviewAssuranceFloorPath` (packages/main/src/core/review-assurance-floor.ts:518) whitelists only the TS/JS extension family; :506-511 hardcodes proofbound-layout material prefixes (`packages/main/src`, `scripts/`, `bin/`). Everything else — non-JS code AND cross-ecosystem build manifests (go.mod, Cargo.toml, pyproject.toml, pom.xml, gradle) — falls through to "non-code project material".
- `collectMaterialCodeFiles` (repro-evidence-binding-gate.ts:83) calls the classifier WITHOUT projectRoot, so project config cannot reach it; the ProofStory trigger predicate (proofstory.ts:626,698) is text/type-only and never calls the classifier at all.
- Consequence: for any non-TS project, repro-first RED never triggers and review assurance floors under-classify — silently.

## Solution Tradeoffs

Introduce one config-resolved `resolveMaterialCodePolicy(projectRoot)` service and thread an immutable, HEAD+materialHash-bound classification snapshot into all three consumers (floor keeps its projectRoot path; repro classification and the ProofStory diagnostic input gain the snapshot). Pure evaluators stay pure. Replace the flat whitelist with an 8-step precedence chain whose level-1 immutable set includes cross-ecosystem manifests that NO config key can exclude (two-layer enforcement: config-resolve rejection + filesystem-aware transition preflight). A strict config resolver normalizes extensions and does segment-aware path matching, failing closed on malformed input. Degradation diagnostics (`semantic_analysis_unavailable`) are produced by buildScopeDiffPack and emitted by the mutating caller. Whitelist direction is preserved: unknown/doc formats stay non-material forever. experiments/ is excluded in this repo's config (agreed 2506-file delta). No new language parsers; semantic anchors stay TS/JS-only.

## Conversational Texture

The maintainer wants Proof-or-Stop's advanced gates to protect ANY language, not just TypeScript, and specifically wants a py/rs/go bug story to be RED-required exactly like a .ts one — while doc/binary formats stay exempt and this repo's experiment scripts stay excluded. Success: the same bug story flips required=true across floor + repro + ProofStory driven by one snapshot, and go.mod at repo root classifies material.
