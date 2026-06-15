# Plan: B-a749 Scope validate --lint to changed packages

Approach (decision: scoped-skip-additive): thread an optional `changedFiles: string[]` /
change-scope through `checkLint` -> `runTsc`. When a non-empty scope is provided, map each
tsconfig to its package subtree; tsconfigs whose subtree contains no changed file are
"out of scope". An out-of-scope tsconfig whose package lacks `node_modules` is reported
skipped-with-warning (out of scope, deps absent) instead of hard-failing on TS2307.
In-scope tsconfigs keep the existing ENOENT(skip) vs non-zero-exit(fail) semantics.
When NO scope is provided (plain `--lint`, no story), behavior is unchanged: full recursive tsc.

## CHK-001: Add an optional change-scope filter to validate --lint

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/validate-lint.ts
- Modify: packages/main/src/handlers/verifier.ts (thread args.story -> changedFiles when --lint --story)
- Modify: packages/main/src/handlers/review-preflight.ts (second checkLint call site; thread the
  story's resolved changedFiles into checkLint so the REVIEW->TEST preflight lint gate also scopes)
- Test: packages/main/src/tasks/validate-lint-change-scope-smoke.ts (CHK-003)

**Verify**:
- `node packages/main/dist/tasks/validate-lint-change-scope-smoke.js` prints all-pass
- happy: backend-only changedFiles set -> only backend tsconfig required, frontend scoped out
- edge: no changedFiles -> full recursive tsc unchanged (every tsconfig run)
- edge: diff reader throws -> fall back to full recursive tsc (never skip-all)
- adversarial: changed file under no tsconfig subtree -> treated in-scope (fail-closed)

**DoneWhen**:
- `checkLint`/`runTsc` accept optional `changedFiles?: string[]` (additive, backward compatible)
- A `changedFilesVsMain` injectable reader (mirrors validate-concept.ts `defaultGitDiffReader`,
  using `git diff --name-only main...HEAD`) resolves the scope; on failure returns undefined => full recursive
- Each tsconfig mapped to its directory subtree; a changed file is in-scope for a tsconfig
  if it lives under that tsconfig's directory. Ambiguous/no-match changed files => in-scope (fail-closed)
- `TSCONFIG_IGNORE_DIRS` constant untouched; change-scope is a DI/scope input, not a blacklist option
- verifier.ts `--lint` task passes resolved changedFiles when `args.story` present; plain `--lint` passes none
- review-preflight.ts (the REVIEW->TEST preflight path) resolves the story's changedFiles via its existing
  `gitDiffReader`/`storyId`/`run` deps and passes them into `checkLint`, so the story's own gate also scopes;
  when scope cannot be resolved it falls back to full recursive tsc (no skip-all)

## CHK-002: Skip-with-warning for out-of-scope packages missing node_modules

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/validate-lint.ts
- Test: packages/main/src/tasks/validate-lint-change-scope-smoke.ts (CHK-003)

**Verify**:
- `node packages/main/dist/tasks/validate-lint-change-scope-smoke.js` prints all-pass
- happy: out-of-scope tsconfig + package node_modules absent -> skipped-with-warning, NOT fail
- edge: in-scope tsconfig with real injected tsc error -> still kind:fail (gate bites)
- adversarial: out-of-scope tsconfig WITH node_modules present -> still type-checked (not skipped)

**DoneWhen**:
- For an out-of-scope tsconfig: if its package directory has no `node_modules`, classify as
  skipped-with-warning; the detail line reads `[lint] skipped: <tsconfig> (out of scope, deps absent)`
- Out-of-scope + deps present => still run tsc (defense-in-depth, B-5a28 spirit)
- In-scope tsconfigs are NEVER deps-absent-skipped; they keep
  ENOENT/npx-not-found(skip) vs non-zero-exit(fail) semantics
- Skipped-with-warning does not flip overall lint status to fail (skip != fail)
- A `node_modules`-presence probe is injectable (FileExists) so the smoke test needs no real fs install

## CHK-003: Add regression tests for lint change-scoping

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Create: packages/main/src/tasks/validate-lint-change-scope-smoke.ts
- Modify: packages/main/package.json (register test:validate-lint-change-scope-smoke)
- Modify: package.json (root: register the same test:* so it runs in the repo test surface)

**Verify**:
- `node packages/main/dist/tasks/validate-lint-change-scope-smoke.js` exits 0, prints all assertions pass
- Uses the existing `CommandRunner` DI seam + injected diff reader + injected FileExists; never spawns real tsc

**DoneWhen**:
- (a) backend-only change scopes out the frontend tsconfig (frontend reported skipped, backend run)
- (b) an in-scope frontend change still type-checks AND still fails on a real injected tsc error
- (c) no-change-scope mode keeps full recursive tsc (every tsconfig invoked via CommandRunner)
- (d) diff-reader-throws fallback runs full recursive tsc (never skip-all)
- Smoke test follows the worktree-node-modules-smoke.ts template (node:assert, tmp fixtures,
  pure-function calls), no real tsc, deterministic, sub-second
