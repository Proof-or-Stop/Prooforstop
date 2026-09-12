# Static scanner AST reuse Lab

This Lab removes duplicate syntax parsing, not invocation analysis. The scanner still reads each source, hashes raw bytes and evaluates every configured argv, traversal, exception, dependency and evidence boundary. It retains one current text/AST entry per source path for the lifetime of the process. Changed text replaces the entry. There is no cross-process cache or cache of authorization results.

## Same-command RED/GREEN

Pinned command: `node scripts/verify-static-ast-reuse.mjs`.

RED commit `7957bbc731` observed reference368 and candidate368 AST calls for234 unique inputs and failed `STATIC_AST_REPEATED_IDENTICAL_INPUT`. The repair reduces candidate calls to234. The reference arm disables only the new cache lookup through a diagnostic module loader; both arms run the actual current scanner against the same current checkout. Both complete JSON reports must be byte-identical. Old code contains no lookup, so the RED reference is the unmodified scanner. The driver refuses if the reference has no duplicate workload.

The exploratory post-fix run measured1809.436ms reference and1609.160ms candidate. These are one shared-host pair, not a statistical speed guarantee. The deterministic claim is134 fewer AST builds (36.4%) with full-report parity. All original per-invocation analysis remains, so parsing once does not imply scanning once. No saved wall time is promised for an entire Story.

## Controls and limits

`node scripts/verify-static-ast-reuse-boundaries.mjs` executes the actual extracted parser helper and checks same-content reuse, changed-content and different-path misses, replacement rather than revision accumulation, malformed-source diagnostics and recovery. It is a source unit test; the pinned command provides the real whole-scanner report comparison. The existing `node scripts/verify-validation-static-edge-boundaries.mjs` remains the separate broader regression. Missing files still fail before the parser helper at the unchanged exists/read boundary.

The cache retains ASTs until process exit; its bound is the set of scanned paths, not a newly claimed fixed memory ceiling. This trades retained AST memory for fewer parses. No generic mutable AST consumer is promised safe: this reuse applies to the current scanner, whose analysis stores invocation-specific state in separate maps/sets. No scanner exception is broadened or source digest rewritten.

Runtime facts register the cache boundary and retain source/test inventory checks. The dedicated new regressions are Lab commands, not claimed as newly scheduled canonical full-suite entries. No full repository PASS or formal Story DONE is asserted. Integration is a later explicit user action; this worktree is retained for review.
