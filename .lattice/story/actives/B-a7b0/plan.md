# Plan: B-a7b0 Extend the CLAUDE.md docs-drift gate to validate path and managed-asset claims, not just command names

Chosen approach (decision A): extend `runDocsDriftGate` in `packages/main/src/handlers/validate-docs-drift.ts` with optional opts so it additionally runs (1) a path-reference drift check delegating to `scanPathDrift` from `core/audit-scan.ts` and (2) a managed-asset contradiction check cross-referencing `core/managed-assets.ts` `listManagedAssetDefinitions`. Both new checks respect an allowlist seam mirroring the existing `DOCS_DRIFT_ALLOWLIST`. The single consumer `runReviewCliGates` in `review-preflight.ts` is updated to pass `projectRoot` + a managed-asset provider. A new smoke (`dist/tasks/*-smoke.ts` + `test:*` script) is chained into the root `npm test` (the actual `lattice validate` battery) using dependency-injected fixtures.

CRITICAL self-gating constraint: this gate runs at THIS story's own REVIEW->TEST against the real CLAUDE.md. The real CLAUDE.md still forbids the Codex hooks dir (line ~77) until B-94ae merges. So the managed-asset check MUST allowlist that pending claim (and any real example paths scanPathDrift would flag) so the gate stays green against the real doc, while the smoke proves the contradiction is caught via a NON-allowlisted fixture.

## CHK-001: Add path-reference drift validation to the CLAUDE.md docs-drift gate (reuse core/audit-scan scanPathDrift)

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/validate-docs-drift.ts (add optional opts to runDocsDriftGate + a pure checkPathDrift wrapper that delegates to scanPathDrift; extend DocsDriftGateResult with a missingPaths field; keep command-name scan untouched)
- Modify: packages/main/src/handlers/review-preflight.ts (pass projectRoot/repoRoot into runDocsDriftGate so path scan can run; surface missing-path details in the gate summary)
- Read-only reference: packages/main/src/core/audit-scan.ts (scanPathDrift signature + noise controls)

**Verify**:
- New/extended logic test exercises checkPathDrift via DI (pathExists/grepLiteral injected): a fixture md with a non-existent path returns a fail with the path named; a fixture whose paths all exist returns pass.
- Adversarial: docs/story/ path + uppercase-XXX placeholder fixture is NOT flagged; allowlisted path is NOT flagged.
- `npx tsc --noEmit -p .` clean from packages/main.
- Running the REVIEW->TEST preflight against the REAL CLAUDE.md shows docs-drift does NOT newly fail on existing example paths (zero false-positives), allowlisting any legitimately-flagged real path with an explicit reason.

**DoneWhen**:
- runDocsDriftGate, when given a repoRoot, returns status fail for a missing referenced path and includes it in the result (e.g. missingPaths) with line/path detail.
- The existing command-name missing/stale behavior is byte-identical when no path drift exists.
- scanPathDrift is reused (imported), not re-implemented.
- An allowlist seam (mirroring DOCS_DRIFT_ALLOWLIST) suppresses intentional/deleted-by-design paths.

## CHK-002: Add a managed-asset contradiction check (the P3 class) against core/managed-assets.ts

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/validate-docs-drift.ts (add a pure checkManagedAssetContradiction(mdContent, managedDefs, allowlist) that flags a do-not-create / must-not-exist claim for a relPath whose registry definition is a GENERATED kind: managed-block | whole-file | claude-settings | codex-hooks | gitignore-runtime; extend result + runDocsDriftGate opts with a managed-asset provider; respect the allowlist seam)
- Modify: packages/main/src/handlers/review-preflight.ts (provide listManagedAssetDefinitions(detected profile/assetMode) as the registry source to the gate)
- Read-only reference: packages/main/src/core/managed-assets.ts (listManagedAssetDefinitions, ManagedAssetDefinition, ManagedAssetKind)

**Verify**:
- Logic test with an INJECTED managed-asset provider: a fixture forbidding a generated-kind relPath returns fail naming the asset + the registry entry; forbidding an excluded-path / remove-extra kind does NOT trigger; a fixture with no claims passes.
- Adversarial: a forbidden generated asset present in the allowlist seam is NOT flagged (covers the real CLAUDE.md pending Codex-hooks claim until B-94ae); check reads the injected registry, not a hardcoded path list.
- Run the REVIEW->TEST preflight against the real CLAUDE.md: the gate stays GREEN (the real Codex-hooks prohibition is allowlisted with reason `B-94ae will fix the wording`).
- `npx tsc --noEmit -p .` clean.

**DoneWhen**:
- The contradiction check cross-references the managed-asset registry (provider-injected), never hardcodes asset paths.
- Only GENERATED kinds produce a contradiction; NON-generated kinds (excluded-path/remove-extra) do not.
- The allowlist seam (same one as CHK-001) suppresses the known-pending claim so the real doc passes.
- Handler Encoding Convention honored: any constrained input the check consumes is re-validated at runtime, not only at the schema boundary.

## CHK-003: Add a regression smoke for the two new checks and wire it into the validate battery

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Create: packages/main/src/tasks/docs-drift-path-asset-smoke.ts (DI fixtures; asserts (a) stale-path fixture fails, (b) managed-asset-contradiction fixture fails, (c) clean fixture passes, (d) command-name behavior unchanged; node assert/strict; logs `docs-drift path+asset smoke passed`; exit 0 on success, non-zero on assert failure)
- Modify: packages/main/package.json (add `test:docs-drift-path-asset-smoke`: `node dist/tasks/docs-drift-path-asset-smoke.js` following the existing smoke pattern)
- Modify: package.json (root) (chain the new test:* into the `test` script so `lattice validate` = `npm test` actually runs it)

**Verify**:
- `cd packages/main && npm run build` then `node dist/tasks/docs-drift-path-asset-smoke.js` prints the passed line and exits 0.
- `npm test` from repo root runs the smoke (its output line appears) and is green.
- Temporarily break one assertion locally -> `npm test` fails -> revert (manual confirmation, not committed).
- Smoke does NOT read or write the real CLAUDE.md (grep the smoke source: no readFileSync of the real CLAUDE.md path).

**DoneWhen**:
- A single `node dist/tasks/docs-drift-path-asset-smoke.js` run proves all four behaviors with DI fixtures.
- The smoke is reachable from `lattice validate` (chained into root `npm test`), confirmed by observing its output during `npm test`.
- No real CLAUDE.md mutation; fixtures are in-memory / injected providers only.
