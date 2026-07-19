# Language-Neutral Advanced Gates (v4 — post cross-host audit round 3)

Status: proposal / for audit only; no runtime change authorized by this document
Date: 2026-07-18 (v4)
Audit trail: RED → Spike → R1 → v2 → R2 → v3 → **R3 (codex: D2 APPROVE-WITH-CHANGES; agy: D2 APPROVE-WITH-CHANGES)**. v4 incorporates the R3 deltas below; the v3 architecture survived.

---

## 1. Problem (unchanged, twice-verified)
Material-code classification is TS-centric (review-assurance-floor.ts:518 whitelist; :506-511 proofbound-layout prefixes); identical bug work in py/rs/go silently escapes RED requirements and under-classifies review floors. S1+S2 are joint routing rules (not a single choke point); the degradation is total for external projects.

## 2. Design (v3)

### Change A — `resolveMaterialCodePolicy(projectRoot)` + snapshot threading (CX2-10, AG2-3)
One config-resolved policy service. **Threading is now mechanically specified** (the v2 gap both hosts flagged):
- The policy AND the `main...HEAD` diff classification are resolved ONCE at the transition boundary (machine/transition-orchestrator level, which has projectRoot);
- an immutable **classification snapshot** (`{policyDigest, files:[{path, materialCode, reason}]}`) is passed INTO the pure evaluators: `ProofStoryDiagnosticInput` gains a `materialClassification` field (proofstory.ts:112), repro classification gains a snapshot parameter (fixing the dropped-projectRoot call at repro-evidence-binding-gate.ts:83), and the floor keeps its existing projectRoot path.
- Pure functions stay pure; no config reads inside evaluators.
- **Snapshot currency (CX3-8 + AG3-5)**: the snapshot embeds the HEAD + materialHash it was computed at; every gate consuming it re-checks those hashes at decision time and re-resolves on drift (long validations, concurrent commits). ALL THREE consumers receive the same hash-bound snapshot object — none re-derives its own classification.

### Change B — Precedence chain v3 (reordered + hardened)
First hit wins:
1. **Immutable runtime/build-config names** (CX2-9 + AG2-6 — both hosts broke v2's ordering): the JS set (package.json, lockfiles, tsconfig*, lattice.config.json) **plus the cross-ecosystem manifest set (CX2-8)**: `go.mod go.sum Cargo.toml Cargo.lock pyproject.toml setup.py setup.cfg requirements*.txt Pipfile* poetry.lock pom.xml build.gradle* settings.gradle* gradle.properties Gemfile* composer.json*` → material, **cannot be excluded or removed by any config key**. Enforcement is two-layer (CX3-9 + AG3-6): (a) config-resolve rejects exclusions naming a manifest; (b) a filesystem-aware transition preflight walks the ACTUAL tree and rejects any exclusion path (directory-level included, e.g. `backend/` hiding `backend/go.mod`) that covers a real manifest file. Pattern entries (`requirements*.txt`) use the same glob semantics as the resolver contract.
2. Story-metadata exclusion via the **resolved `storyDir`** (AG2-8), not a hardcoded `.lattice` — reuse `isMaterialExcludedPath`'s existing config awareness.
3. `excludePaths` (project config; e.g. `experiments/`) → non-material.
4. Markdown/docs → non-material.
5. `removeExtensions` (subtracts from defaults before inclusion).
6. Path prefixes (config `paths`, generic defaults) → material only for files with a resolved code extension; extensionless files under `scripts/`/`bin/` are material only if they carry a shebang or executable bit — plain text names (`README`, `LICENSE`, `INSTALL`, `COPYING`, `NOTICE`) excluded (AG2-7). For DELETED or RENAMED extensionless files the shebang/exec-bit is read from the git blob of the OLD tree (CX3-10) — never from the worktree, where the file no longer exists.
7. Resolved extension set (defaults ∪ add − remove) → material.
8. Default → non-material.

### Change C — Config resolver contract (CX2-12)
The `materialCode` block gets a strict schema at load: extension entries normalized (leading dot, lowercase), path entries segment-aware (`src/` matches `src/x.py`, never `src-old/x.py`), malformed entries fail CLOSED with a diagnostic (never silently ignored — today loadConfig swallows parse errors, config.ts:580-590), deterministic dedupe. Resolver ships with its own smoke matrix.

### Change D — Degradation diagnostics, correct producer (CX2-11, AG2-4)
`unsupported_file_type` originates in `parseUnifiedDiff`/`buildScopeDiffPack` (scope-diff-pack.ts:265-315) — v3 assigns diagnostic production there (normalized `semantic_analysis_unavailable: <ext>` entries in the diff-pack result), and the **no-scope-contract path** (scope-contract.ts:459-466 returns before building a pack) gets the same diagnostics from the validation orchestration path, so legacy/no-contract stories still surface degradation. Mutating callers write the (deduped, union-typed) process event; concept-analysis (validate-concept.ts:383) returns its own diagnostic for non-TS/py files it skips.

## 3. Verification
- Three-consumer RED: py/rs/go story flips to required through floor + repro + ProofStory, driven by ONE snapshot.
- Immutability matrix: excludePaths/removeExtensions attempts against every manifest name → config-resolve rejection.
- Ecosystem manifests: `go.mod` at repo root classifies material with no path prefix and no code extension.
- Precedence pairs: pptx-under-src, README-under-scripts, shebang-script-under-bin, custom-storyDir metadata file, `src-old/` prefix non-match.
- Repo regression at execution time: delta = exactly the experiments/ exclusion set; all manifest/lock/config files provably still material.
- No-contract story with material `.go` file → exactly one degradation event.

## 4. Resolved decisions (cumulative)
Edge formats in defaults; experiments/ excluded (true 2506-file delta re-confirmed); runtime/build manifests immutable at level 1; ordering binding: lands before or with the repro-first enforce flip; no new language parsers (non-goal).
