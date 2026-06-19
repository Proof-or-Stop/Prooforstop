# B-4033 — User-value acceptance (transcript + diff)

**Deliverable:** the static overlap engine of the parallel-decomposition gate — new
`packages/main/src/core/parallel-decomposition-overlap.ts` (`computeWriteSet`,
`globsOverlap`, `validateWriteSetGrammar`, `classifyBroadness`) + a smoke test. "Running
it" = tsc compiles and the smoke's assertions all pass.

## Rhythm: expected → actual → diff

### Expected
A conservative, sound two-tier overlap engine (spec §4.2): tier-1 literal intersection
(zero false positives), tier-2 shared-directory-prefix (may over-flag, never under-flags),
NARROW/BROAD classification, a write-set grammar validator, robust path canonicalization.

### Actual
- `npm --prefix packages/main run build` (tsc) → PASS; `node …/parallel-decomposition-overlap-smoke.js` → **44 assertions pass**, exits 0.
- `lattice validate` → PASS (tsc + authority smokes).
- Genuine cross-provider dual-host review over **6 rounds**: host 1 = Claude (`lattice-review-concept/quality/test-coverage`), host 2 = Codex (`codex exec review`).

### Diff (expected vs actual) — 10 findings, all resolved
**Codex (host 2) caught 6 real correctness bugs that all 3 Claude lanes missed:**
1. P1 — children-glob shared-prefix collisions under-flagged (`src/*` vs `src/csv/*`).
2. P1 — empty-dir wildcards (`/*`,`/**`) accepted; broadness mis-classified.
3. P2 — single-segment root literal (`docs` vs `docs/*`) under-flagged.
4. P2 — redundant path segments (`src/./a.ts`, `src//a.ts`) not canonicalized → missed collisions.
5. P1 — repeated leading `./` (`././*`, `././src/**`) not stripped.
6. P1 — terminal `..` (`src/..`) not rejected (scope-contract.ts:48 misses the terminal case).
**Claude lanes:** computeWriteSet wrongly unioned `allowedTest` (→ modify∪create only); smoke coverage gaps; a stale comment.
Resolution: `entriesOverlap` simplified to literal-exact + conservative `e.dir` nesting; `normalizeEntry` rewritten to a segment-filter (drops all `''`/`.` segments); validator rejects bare/mid-path/empty-dir wildcards + `..`. After fixes: expected == actual. Contract re-export wiring is deferred to **Story 5** by design (Story 1 must not edit the frozen contract).

## Assurance
Review escalation: **full-3x2 (3 rounds × 2 hosts)** — genuine Claude + Codex cross-provider
hosts, both PASS on the final material. NOT degraded.
