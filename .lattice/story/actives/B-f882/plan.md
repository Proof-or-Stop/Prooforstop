# Plan: B-f882 Thread resolved gitCwd into the docs-drift REVIEW preflight gate (wrapper-root false-block)

Root cause: in `packages/main/src/handlers/review-preflight.ts`, `runReviewCliGates` resolves
`const gitCwd = resolveGitCwd({...})` (~:287) and threads it into the channel (~:298),
concept (~:313), and english (~:464) git-invoking gates, but the docs-drift gate call
`runDocsDriftGate(mdContents, deps.registryNames, { repoRoot: deps.projectRoot, managedAssetDefs })`
(~:423-426) passes `deps.projectRoot` (metadataRoot) instead of `gitCwd`. On wrapper-root layouts
(metadataRoot != gitRoot) `runDocsDriftGate` -> `checkPathDrift` -> `scanPathDrift`
(core/audit-scan.ts) runs `fs.existsSync(join(repoRoot,p))` and `git grep ... {cwd: repoRoot}`
from the non-git metadataRoot, so an existing CLAUDE.md path reference is falsely reported missing
-> docs-drift FAIL -> false-block REVIEW->TEST. Exact B-0740 defect class.

## CHK-001: Pass the resolved gitCwd as docs-drift repoRoot in review-preflight.ts (not deps.projectRoot)

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/review-preflight.ts (only the docs-drift `runDocsDriftGate` call, ~:423-426)

**Verify**:
- `npx tsc --noEmit -p packages/main` exit 0
- `git diff` shows ONLY the single `repoRoot:` argument changed from `deps.projectRoot` to `gitCwd` (plus a one-line comment update if useful) — no other lines, no english-gate storyDir change, no managedAssetDefs change
- Existing `node packages/main/dist/tasks/docs-drift-path-drift-smoke.js` still passes (plain-repo / DI behavior unchanged)

**DoneWhen**:
- The `runDocsDriftGate` call passes `repoRoot: gitCwd` (the value resolved at ~:287)
- `managedAssetDefs` resolution (~:404, `listManagedAssetDefinitions(... deps.projectRoot ...)`) is UNCHANGED
- The english-artifacts gate `storyDir` wiring (~:463) is UNCHANGED (deferred finding #3)
- Plain-repo behavior is byte-identical (projectRoot == gitCwd makes the change a no-op)

## CHK-002: Add a wrapper-root (metadataRoot != gitRoot) regression for the docs-drift preflight gate

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/src/tasks/docs-drift-wrapper-root-smoke.ts (new self-contained `*-smoke.ts` node script, mirroring docs-drift-path-drift-smoke.ts structure: `assert` throws -> exit 1, `console.log('... passed')` on success)
- Modify: packages/main/package.json (add `test:docs-drift-wrapper-root` script -> `node dist/tasks/docs-drift-wrapper-root-smoke.js`)
- Modify: package.json (wire the new smoke into the root `test` script so root `npm test` / `lattice validate` runs it)
- Optional: packages/main/smoke-manifest.json (only if a tag/timeout entry is needed; auto-discovery covers `test:all`)

**Verify**:
- Build then `node packages/main/dist/tasks/docs-drift-wrapper-root-smoke.js` exits 0 (green) on the fixed tree
- RED proof: temporarily revert the CHK-001 fix (repoRoot back to deps.projectRoot), rebuild, run the smoke -> it exits non-zero / asserts FAIL; then restore the fix and confirm green again. Capture both outputs.
- `lattice validate --story=B-f882` run output contains the new smoke name (proves it is in the battery the user runs)

**DoneWhen**:
- The fixture constructs a real git repo in a subdir (gitRoot) with metadataRoot = the non-git PARENT directory, and a CLAUDE.md that references a file path existing ONLY under gitRoot
- The regression drives the docs-drift preflight path-drift code path (ideally through `runReviewCliGates` with a store/story whose `resolveGitCwd` resolves to the subdir, OR a faithful per-root scan) and asserts the existing-under-gitRoot path is NOT reported missing
- It is mechanically RED against the pre-fix wiring and GREEN after (demonstrated, not just asserted)
- DI/fixtures only — no dependence on the host machine's directory layout
- Wired so root `npm test` runs it

## CHK-003: Strengthen the gitCwd guard so an un-threaded review-preflight git-gate is caught

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/tasks/gitroot-cwd-contract-smoke.ts (add a focused review-preflight-specific assertion), OR
- Create: a focused new `*-smoke.ts` check + wire it into the battery (same wiring approach as CHK-002)
- If a new file: Modify packages/main/package.json + package.json to wire it in

**Verify**:
- The guard runs green on the fixed tree (`node packages/main/dist/tasks/<guard>-smoke.js` exit 0)
- RED proof: with a review-preflight git-invoking gate wired to `deps.projectRoot` instead of `gitCwd` (temporary revert of CHK-001), the guard exits non-zero
- The guard is in the validate battery the user runs (appears in `lattice validate --story=B-f882` output)
- A `coverage` comment/section documents what it does and does NOT cover

**DoneWhen**:
- The existing BARE_CWD_REGEX (`/\bcwd:\s*(projectRoot|root|metadataRoot)\s*[,}]/`) gap is addressed: a review-preflight gate that forwards metadataRoot under a param name (e.g. `repoRoot: deps.projectRoot`) to a git-invoking gate is mechanically caught
- The guard is review-preflight-specific (acceptable per checklist: a full general lexical rewrite is NOT required) and tightly scoped to avoid false positives on legitimate non-git `deps.projectRoot` uses
- Coverage is documented in the smoke (what it catches, what it intentionally does not)
- A self-test (positive + negative case) demonstrates the guard fires correctly
