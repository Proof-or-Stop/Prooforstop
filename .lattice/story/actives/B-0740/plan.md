# Plan: B-0740 Thread resolved gitRoot into doctor --repair and lint change-scoping (combination-review stacking gaps)

Chosen decision: **A-thread-and-rebase** — consume the already-resolved gitCwd at the two lagging
call sites; rebase gitRoot-relative diff paths to projectRoot-relative so the single projectRoot
relativity base in `computeOutOfScopeTsconfigs` is preserved. Do NOT enlarge blast radius into
already-stabilized B-1637/B-2856 code.

## CHK-001: Thread resolved gitRoot into doctor --repair (repairStoryMetadataAllowlist)

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: `packages/main/src/handlers/doctor.ts`
  - `repairStoryMetadataAllowlist(root)` (def ~line 942): add a second param `gitCwd: string = root`
    (mirror the 3 scan fns `scanTrackedRuntimeArtifacts` / `scanOrphanWorktrees` /
    `scanStoryMetadataProtection`, which all use `gitCwd: string = root`). Use `gitCwd` in the
    `git rev-parse --show-toplevel` at ~line 945 (`cwd: gitCwd`). Coalesce internally: `cwd: gitCwd ?? root`
    is unnecessary because the default already covers it, but DO keep the default `= root`.
  - Call site at ~line 166: change `repairStoryMetadataAllowlist(root)` →
    `repairStoryMetadataAllowlist(root, gitProbeCwd)` (the `gitProbeCwd` already resolved at line 63 via
    `resolveDoctorGitCwd(root)`).
- Test: `packages/main/tests/doctor-repair-gitcwd.test.ts` (new) — DI-style. Do NOT spawn real git in
  the wrapper-root assertion; drive `repairStoryMetadataAllowlist` (or the doctor handler) against a
  fixture where the metadataRoot differs from the gitRoot. Reuse the existing doctor test harness
  patterns in `packages/main/tests/` if one already exercises `repairStoryMetadataAllowlist` or the
  metadata-protection scan — extend it rather than duplicating fixtures.

**Verify**:
- `lattice validate` green (logic + integration).
- `npm --prefix packages/main run build` then run the freshly-built CLI:
  `node packages/main/dist/cli.js doctor --repair --format=json` in a wrapper-root fixture →
  story-metadata-protection block shows the allowlist installed (`wrote:true` first run), and a second
  run is a no-op (`wrote:false`, no leading `fatal: not a git repository`).
- Plain-repo `doctor --repair` output unchanged (byte-identical wrote-then-noop).

**DoneWhen**:
- `repairStoryMetadataAllowlist` accepts `gitCwd` defaulting to `root` and uses it for the git probe.
- Line ~166 call site passes `gitProbeCwd`.
- New wrapper-root regression test asserts the allowlist IS installed on a wrapper-root fixture
  (the prior `wrote:false` failure is gone).
- Plain-repo test asserts wrote-then-noop is unchanged.

## CHK-002: Thread resolved gitCwd into lint change-scope (resolveChangedFiles)

**Owner**: lattice-implementer
**DependsOn**: none  (independent file set from CHK-001; doctor.ts vs verifier/review-preflight/validate-lint — may run in parallel)
**Files**:
- Modify: `packages/main/src/handlers/validate-lint.ts`
  - `ChangedFilesReader` type (~line 145): add `gitCwd?: string` to the args object.
  - `defaultChangedFilesReader` (~line 147): run `git diff --name-only` with `cwd: gitCwd ?? projectRoot`.
  - `resolveChangedFiles(deps)` (~line 172): add `gitCwd?: string` to `deps`. Pass it into the reader.
    **CRITICAL — rebase for base consistency**: when `gitCwd` is set AND differs from `projectRoot`,
    the reader emits gitRoot-relative paths but `computeOutOfScopeTsconfigs` uses `projectRoot`-relative
    tsconfig dirs. Rebase each raw diff path to projectRoot-relative via
    `relative(projectRoot, join(gitCwd, rawPath))` (then normalize). When `gitCwd` is unset or equals
    `projectRoot`, the rebase is identity → byte-identical output. Do the rebase AFTER the throw
    boundary so a throwing reader still yields `undefined` (full tsc) and a genuinely empty diff still
    yields `[]` — never convert a throw into `[]`.
- Modify: `packages/main/src/handlers/verifier.ts`
  - Call site ~line 630: `resolveChangedFiles({ projectRoot })` → `resolveChangedFiles({ projectRoot, gitCwd })`
    (the `gitCwd` already resolved at line 604).
- Modify: `packages/main/src/handlers/review-preflight.ts`
  - Call site ~line 334: add `gitCwd` (resolved at line 262) to the `resolveChangedFiles({...})` args.
- Test: `packages/main/tests/validate-lint-changescope-gitcwd.test.ts` (new) OR extend the existing
  `packages/main/tests/validate-lint*.test.ts`. Use the injectable `changedFilesReader` stub — do NOT
  spawn real git. Cases:
  1. wrapper-root: stub reader returns gitRoot-relative paths; assert resolveChangedFiles rebases to
     projectRoot-relative AND computeOutOfScopeTsconfigs marks the right out-of-scope set.
  2. plain repo (gitCwd==projectRoot OR omitted): assert output byte-identical to today (identity rebase).
  3. throwing reader → `undefined` (full tsc, never skip-all).
  4. empty-diff reader → `[]` (valid empty scope) — the throw/empty distinction survives the rebase.

**Verify**:
- `lattice validate` green.
- `npm --prefix packages/main run build`; the new logic tests run under `lattice validate`.
- Optionally drive `node packages/main/dist/cli.js validate --lint --story=B-0740 --json` on a
  wrapper-root fixture to confirm out-of-scope tsconfigs are skipped rather than full-tsc fallback.

**DoneWhen**:
- `resolveChangedFiles` + `defaultChangedFilesReader` accept `gitCwd`, default safely to `projectRoot`.
- Both call sites (verifier.ts:630, review-preflight.ts:334) pass the already-resolved `gitCwd`.
- Rebase keeps git-diff base and tsconfig-relativity base consistent (single projectRoot base).
- Tests cover wrapper-root rebase, plain-repo identity, throwing→undefined, empty→[].
