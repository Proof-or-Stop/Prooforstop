# Plan: B-956f language-neutral material-code classification

Per docs/requirements/decisions/language-neutral-gates-execution-plan.md (v4, double cross-host APPROVE-WITH-CHANGES). RED baseline: tmp/w1-red/red-language-degradation.cjs fails 9/11 (all non-TS sources and cross-ecosystem manifests classify non-material); target: 11/11 pass.

## CHK-001 Config-resolved material-code policy service threaded via a hash-bound snapshot

Problem: classifyReviewAssuranceFloorPath (review-assurance-floor.ts:518) whitelists only the TS/JS extension family and :506-511 hardcodes proofbound-layout prefixes; collectMaterialCodeFiles (repro-evidence-binding-gate.ts:83) calls it WITHOUT projectRoot so project config can never reach repro classification; the ProofStory trigger predicate (proofstory.ts:626,698) never calls the classifier at all. Identical bug work in .py/.rs/.go/.java/.cpp silently escapes repro-first RED and floor classification.

Approach: add packages/main/src/core/material-code-policy.ts exposing resolveMaterialCodePolicy(projectRoot) (strict config resolve, see CHK-002) and buildMaterialClassificationSnapshot(projectRoot, policy) — an immutable snapshot embedding the HEAD + materialHash it was computed at plus the per-file classification of the main...HEAD diff. Thread the snapshot into the three consumers: review-assurance floor keeps its projectRoot path but delegates per-file classification to the snapshot policy; collectMaterialCodeFiles gains a required snapshot parameter (fixing the dropped-projectRoot call — the old config-blind signature is removed so no caller can regress); ProofStoryDiagnosticInput gains a materialClassification field consumed by the trigger predicate. Pure evaluators stay pure: no config reads inside evaluators; consumers re-check the snapshot's embedded hashes at decision time and re-resolve on drift.

Acceptance: rebuild dist, run the RED harness — the .py/.rs/.go/.java/.cpp source assertions and the manifest assertions flip to pass (11/11, exit 0). The new smoke asserts all three consumers observe the SAME snapshot object within one evaluation and that a stale-hash snapshot is re-resolved, and that invoking repro classification without a snapshot is impossible (signature) or fails closed.

## CHK-002 Eight-step precedence chain with non-excludable cross-ecosystem manifests and strict resolver

Problem: the flat whitelist cannot express language-neutral policy; a naive config-driven exclude could hide backend/go.mod and re-open the hole; loadConfig today swallows parse errors (config.ts:580-590) so malformed config silently degrades to TS-only.

Approach: replace the flat whitelist with the plan's 8-step precedence chain evaluated first-hit-wins: (1) level-1 IMMUTABLE runtime/build-config basenames (existing JS set + go.mod/Cargo.toml/pyproject.toml/pom.xml/gradle family) that NO config key can exclude — enforced twice: config-resolve rejects excludePaths entries naming them AND a filesystem-aware transition preflight rejects directory entries that cover a real manifest in the tree; (2) storyDir-aware metadata exclusion (no hardcoded .lattice); (3) config excludePaths (segment-aware: src/ never matches src-old/); (4) docs/binary formats non-material; (5) removeExtensions; (6) code-extension-gated path prefixes with the shebang/exec-bit rule for extensionless scripts (CX3-10: read from the OLD tree blob for deleted/renamed files); (7) resolved code-extension set (normalized: leading dot, lowercase); (8) default non-material (whitelist direction preserved). Strict resolver in material-code-policy.ts: malformed materialCode entries fail CLOSED with diagnostics naming the offending key; ships with a malformed-shape smoke matrix. This repo's lattice.config.json gains the agreed experiments/ exclusion (execution-time regression check: the classification delta vs baseline is exactly the experiments/ set).

Acceptance: smoke asserts go.mod/Cargo.toml/pyproject.toml/pom.xml at repo root classify material with no prefix/extension help; precedence pairs hold (src/design.pptx non-material; README under scripts/ non-material while an extensionless shebang script under bin/ is material; src-old/x.py does not match src/); an excludePaths entry naming go.mod or a backend/ entry covering a real backend/go.mod is rejected at both enforcement layers; malformed config fails closed with the named key.

## CHK-003 Degradation diagnostics produced by buildScopeDiffPack for unsupported languages

Problem: non-TS/JS files silently receive no semantic analysis with no signal; the no-scope-contract early return (scope-contract.ts:459-466) bypasses diagnostics entirely, so a pure-.go story sees nothing.

Approach: buildScopeDiffPack (scope-diff-pack.ts:265-315) returns normalized `semantic_analysis_unavailable: <ext>` diagnostic entries (deduped one per extension; TS/JS produce none — semantic anchors stay TS/JS-only, no new parsers), including on the no-scope-contract path. Production/emission stay separated: the pack builder is pure and read-only gate checks emit nothing; only the mutating validation caller writes the deduped union-typed process event.

Acceptance: smoke asserts a no-contract story with one material .go file yields exactly one deduped semantic_analysis_unavailable process event during validate; same-extension files dedupe; TS/JS emit none; repeated read-only checks emit no events.

## CHK-004 validate-concept skip diagnostic for non-TS/py files stays distinct and language-neutral

Problem: concept-analysis (validate-concept.ts:383) emits its OWN separate diagnostic for files it skips — spec Change D's second, distinct degradation mechanism — and it must stay correct and non-conflicting once the classifier goes language-neutral (more non-TS files become material and reach concept analysis).

Approach: keep the validate-concept skip diagnostic as its own channel: it names the skipped non-TS/py files, is not conflated with (nor suppressed by) the buildScopeDiffPack semantic_analysis_unavailable events, and neither channel double-reports a file as both analyzed and skipped. Adjust only what language-neutral classification changes (the set of files reaching concept analysis), not the diagnostic's semantics.

Acceptance: smoke asserts a .go/.rs-only story emits the concept skip diagnostic naming those files; a mixed .ts+.go diff analyzes TS and lists only non-TS in the skip diagnostic with no leakage; suppressing one channel does not suppress the other.
