# B-a7b0 Real-machine verification: transcript + diff

Story: Extend the CLAUDE.md docs-drift gate to validate path and managed-asset claims, not just command names.

Rhythm: PLAN outcome (expected) -> run on real machine -> actual output -> diff.

## Expected (from understanding.outcome)

1. The docs-drift gate flags a non-existent path reference in CLAUDE.md as drift (path + line).
2. The gate flags a "do not create <X>" claim for a framework-GENERATED managed asset, naming the asset + the registry entry.
3. A clean CLAUDE.md (paths exist, no contradiction) still passes; the existing command-name scan is unchanged.
4. `lattice validate` runs a new docs-drift smoke green proving all of the above.
5. The real CLAUDE.md must NOT self-block this story's own REVIEW->TEST gate.

## Actual — run 1: the new smoke inside the validate battery

Command: `lattice validate --story=B-a7b0`
Actual (excerpt):
```
> lattice@0.3.5 test:docs-drift-smoke
> node packages/main/dist/tasks/docs-drift-path-drift-smoke.js
docs-drift path+asset smoke passed
...
✓ ALL PASS
Verification intent coverage: 9/9 covered (0 required missing)
```
The smoke (DI fixtures, never touches the real CLAUDE.md) asserts: (a) stale-path fixture -> status fail with the path in missingPaths; (b) managed-asset-contradiction fixture (generated kind, not allowlisted) -> status fail with the asset+kind in managedAssetContradictions; (c) clean fixture -> status pass, both new arrays empty; (d) command-name missing/stale/status byte-identical with-vs-without opts (assert.deepEqual).

Diff vs expected: MATCHES expected #1-#4. The smoke is confirmed chained into the root `npm test` that `lattice validate` runs (the `test:docs-drift-smoke` line appears in the battery output).

## Actual — run 2: docs-drift gate against the REAL CLAUDE.md (self-gating check)

Command (throwaway node snippet, not committed): `runDocsDriftGate(realClaudeMd, registryNames=MAIN_TOOLS names, { repoRoot, managedAssetDefs: listManagedAssetDefinitions(detectProfile, _, root, detectMode) })`
Actual:
```
status: pass
summary: CLAUDE.md command references aligned with registry (210 stale advisory)
missing (commands): []
missingPaths: []
managedAssetContradictions: []
registry size: 229   defs: 12 (profile=all, assetMode=global-thin)
```
Diff vs expected: MATCHES expected #5. The path check finds zero false-positive missing paths on the real doc (scanPathDrift noise controls + git-grep fallback). The managed-asset check finds zero contradictions because the real CLAUDE.md's `.Codex/hooks` / `.Codex/settings.json` prohibition is in `DOCS_DRIFT_MANAGED_ASSET_ALLOWLIST` with the inline reason "B-94ae will fix this CLAUDE.md wording". Without the allowlist the check correctly flags `.codex/hooks/lattice-scope-pretool.cjs (whole-file)` via the forbidden-ancestor-dir rule (verified by the implementer's throwaway run) — proving the P3 contradiction class IS detectable; the allowlist is what keeps this story from self-blocking until B-94ae lands.

## B-94ae coordination note

This story modifies the very gate that runs at its own REVIEW->TEST. The real CLAUDE.md still contains the false `.Codex/hooks` prohibition that B-94ae will fix. Rather than depend on B-94ae merging first, the managed-asset check ships with that exact claim allowlisted (with a documented B-94ae reason). When B-94ae fixes the wording, the allowlist entry becomes a harmless no-op (the claim disappears from the doc) and can be removed in a follow-up. No hard dependency on B-94ae; no self-block observed.

## Edge cases covered

- docs/story/ paths and uppercase-placeholder template paths are NOT flagged (existing scanPathDrift noise controls preserved).
- NON-generated managed-asset kinds (excluded-path / remove-extra) do NOT produce a contradiction; only generated kinds (managed-block/whole-file/claude-settings/codex-hooks/gitignore-runtime) do.
- The check is registry-driven (provider-injected managedAssetDefs), not a hardcoded path list — proven by flipping an injected def's kind flipping the outcome.
- F-001 fix: ALL_MANAGED_ASSET_KINDS is now a single canonical export with a compile-time exhaustiveness guard (a missing union member is a TYPE ERROR).
- F-002 fix: registry-resolution failure now emits a diagnostic into the gate details + stderr instead of being swallowed by an empty catch.

Conclusion: actual output matches expected for all five outcome points. No unresolved TODOs.
