# B-0784 Execution Plan

## CHK-001 — Canonicalize scope contract paths at write and compare boundaries

Introduce one versioned repo-root-relative path identity at the contract write boundary. Resolve configured source-root-relative inputs exactly once, retain original input for diagnostics, normalize separators and dot segments, and reject absolute, traversal, ambiguous-base, and symlink escape cases. Persist a path schema/version and read legacy artifacts without in-place rewrite. Add an independent rollout flag with shadow/enforce/rollback behavior. Update the shared classifier and prewrite/overlap consumers only through the canonical helper. Verify repo-relative, source-relative, Windows, dot, exact/glob/subtree, traversal, symlink and legacy-version cases.

## CHK-002 — Use parser-backed enclosing declarations for semantic anchors

Replace nearest regex anchor inference with TypeScript compiler AST traversal over the changed line. Choose the nearest enclosing function, method, constructor, class, interface, type, namespace/module, or intended top-level variable declaration; control flow and local variables cannot displace the enclosing declaration. Preserve explicit file fallback and protected-anchor fail-closed rules. Persist anchorParserVersion in the diff/evidence envelope and make version drift stale. Ship behind an AST-only rollout flag independent from path canonicalization. Verify nested declarations, methods/classes, control flow, local const, overloads, true deletions, protected anchors, malformed input, and rollback.

## CHK-003 — Classify official shared B-META gap metadata safely

Define a narrow shared-metadata classifier for B-META-framework-audit findings written by official gap_log. Classification requires a canonical writer event/receipt bound to the current content digest and expected audit container; path alone never qualifies. Consume the classifier in scope and done_prepare clean-tree decisions. Missing, stale, mismatched, forged, direct-edited, unknown B-META paths and arbitrary .lattice files remain unsafe. Preserve the separation between provenance classification and gate evidence. Verify official write, dedupe/update, content mutation, event removal/corruption, direct edit and unknown metadata.

## CHK-004 — Prove migration diagnostics and adversarial scope behavior

Create a bounded matrix spanning all four independent path/AST rollout combinations, legacy/current path and anchor artifact versions, parser drift, official/forged metadata, protected anchors and genuine out-of-scope writes. Diagnostics must expose original input, canonical path, chosen declaration, path/anchor parser versions and the deciding rule. Update the process-fact registry contract for any gate-consumed version/provenance fields. Run focused build/smokes and process-fact verification before review; run routine validate only in TEST and DONE-required through done_prepare. No corpus scan or unrelated runtime change.
