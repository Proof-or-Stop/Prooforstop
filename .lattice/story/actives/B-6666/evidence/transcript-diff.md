# B-6666 Real-Machine Verification — transcript + diff

PLAN outcome (expected) → actual run → diff. Run from the B-6666 worktree on branch story/B-6666.

## Expected (PLAN outcome)
1. On a wrapper-root fixture (metadataRoot != gitRoot), the DONE-oracle git-working-tree row reads **clean** (was fail/blocking) → DONE no longer falsely blocked.
2. `npm run test:gitroot-cwd-contract` exits 0 (GREEN) WHILE the contract now FAILS (exit 1) if a `const gitCwd = projectRoot|root|metadataRoot` alias used as a git cwd (the d93b69b8f gaming shape) — or a bare-root backtick git call — is reintroduced.
3. `lattice validate --story=B-6666` ALL PASS, 9/9 verification coverage.

## Actual

### Step 1 — build
```
npm --prefix packages/main run build   → tsc, BUILD_EXIT=0
```

### Step 2 — contract GREEN baseline
```
npm run test:gitroot-cwd-contract  → exit 0
✓ self-test: KNOWN-GOOD fixture produces 0 violations
✓ self-test: KNOWN-BAD fixture produces exactly 1 violation on projectRoot
✓ self-test: ALIAS KNOWN-BAD (const gitCwd = projectRoot → git cwd) produces exactly 1 alias violation
✓ self-test: ALIAS KNOWN-GOOD (const x = projectRoot, not a git cwd) produces 0 violations
✓ self-test: ALIAS KNOWN-GOOD (const gitCwd = resolveGitCwd(...) → git cwd) produces 0 violations
✓ self-test: BACKTICK KNOWN-BAD (execSync(`git`, { cwd: projectRoot })) produces exactly 1 bare violation
✓ self-test: BACKTICK KNOWN-GOOD (execSync(`git`, { cwd: resolvedGitCwd })) produces 0 violations
✓ self-test: docs-drift KNOWN-GOOD fixture (repoRoot: gitCwd) produces 0 violations
✓ self-test: docs-drift KNOWN-BAD fixture (repoRoot: deps.projectRoot) is flagged
✓ repo scan clean: 520 .ts files inspected, 0 bare-cwd violations
✓ review-preflight docs-drift gate wires repoRoot: gitCwd (not metadataRoot)
✓ gitroot-cwd-contract smoke passed
```

### Step 3 — WITNESS: contract bites the d93b69b8f gaming shape (RED)
Injected into done-oracle.ts buildDoneChecklist (the historical silencing pattern, using an in-scope bare root):
```
const witnessGitCwd = root; // WITNESS d93b69b8f gaming shape
try { execSync(`git status`, { cwd: witnessGitCwd, stdio: ['pipe','pipe','pipe'] }); } catch {}
```
```
npm --prefix packages/main run build  → BUILD_EXIT=0
npm run test:gitroot-cwd-contract     → WITNESS_CONTRACT_EXIT=1  (RED — contract bites)
✗ gitroot-cwd-contract smoke FAILED
  done-oracle.ts:252: no-op alias 'witnessGitCwd' (= bare projectRoot/root/metadataRoot)
  used as git cwd — this launders a bare root past the contract (the d93b69b8f shape);
  assign it from resolveGitCwd(...) instead
```
(This single injection — a backtick `execSync(\`git status\`)` with a no-op-alias cwd — trips
BOTH closed blind spots at once: the alias rule AND the backtick-template rule.)

### Step 4 — revert witness, confirm GREEN restored
```
git checkout -- packages/main/src/core/done-oracle.ts
npm --prefix packages/main run build  → exit 0
npm run test:gitroot-cwd-contract     → REVERTED_CONTRACT_EXIT=0  (GREEN restored)
✓ gitroot-cwd-contract smoke passed
```

### Step 5 — wrapper-root done-oracle regression (the false-block fix)
```
node packages/main/dist/tasks/done-oracle-wrapper-root-smoke.js  → WRAPPER_EXIT=0
done-oracle wrapper-root smoke passed
```
This smoke asserts (mechanically, hard assertions not comments):
- RED baseline: with bare metadataRoot, the git-working-tree done-check row = fail/blocking,
  detail "unable to read git status" (and `assert.notEqual(redRow.status, greenRow.status)`).
- GREEN: with the resolved gitCwd (real inner gitRoot), the git-working-tree row = pass, detail "clean".
- evidence-freshness probes (currentGitHead/currentMaterialHash) return undefined on bare
  metadataRoot, DEFINED hashes on the resolved gitCwd.
- PLAIN-REPO byte-identity: buildDoneChecklist full row set + git-working-tree row are
  `assert.deepEqual` identical with gitCwd absent vs gitCwd:root.
- F-001 regression (wrapper-root + CUSTOM storyDir): currentMaterialHash with metadataRoot
  threaded EXCLUDES the custom-storyDir file; the old gitCwd-as-metadataRoot would INCLUDE it
  (the two hashes differ) — proving isMaterialExcludedPath's config-load now uses metadataRoot.

### Step 6 — full story validate
```
lattice validate --story=B-6666  → exit 0, ALL PASS / 验证全绿
Verification intent coverage: 9/9 covered (0 required missing); 0 stale
```

## Diff (expected vs actual)
No diff. Every expected outcome matched the actual run:
- Wrapper-root git-working-tree row flips fail→clean when gitCwd resolves to the real gitRoot (Step 5).
- Contract GREEN at rest (Step 2), RED on the exact gaming shape (Step 3), GREEN again after revert (Step 4).
- validate ALL PASS, 9/9 coverage, 0 stale (Step 6).

## Scope note — deferred backtick sites (documented, not silently left red)
The strengthened contract surfaced a larger batch of pre-existing bare-root sites than this story
fixes (the full d93b69b8f alias batch + bare-backtick + inline-arg-literal sites). Per the charter's
bounded-blast-radius escape valve, the CONFIRMED wrapper-root sites are FIXED (done-oracle.ts +
evidence-freshness.ts + validate-channel.ts + validate-concept.ts) and the remainder are in a
documented `DEFERRED_ALLOWLIST_EXACT` in gitroot-cwd-contract-smoke.ts with per-file rationale and a
`TODO B-6666 → B-99b6 burndown` follow-up. Deferred files still get the ORIGINAL B-db56 literal-`'git'`
coverage (via `isOldRegexVisible`); only the NEW alias + backtick rules are deferred for them. The
contract is GREEN (exit 0) — it does NOT block B-99b6 (which wires it into the validate gate next).

## Gate note
`lattice validate` does NOT run test:gitroot-cwd-contract (verify guards are decoupled — that's B-99b6).
The contract was therefore verified EXPLICITLY via `npm run test:gitroot-cwd-contract` (Steps 2/3/4),
which is the real-machine evidence for CHK-003.
