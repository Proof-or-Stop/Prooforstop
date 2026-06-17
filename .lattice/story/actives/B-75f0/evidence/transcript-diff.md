# B-75f0 transcript-diff — real-machine TEST evidence

Story: Burn down the B-6666 gitroot-cwd DEFERRED_ALLOWLIST.
Worktree: /Users/jek/Documents/Work/Orchestrate/.worktrees/B-75f0 (branch story/B-75f0)
Captured at HEAD 367d2bc31 after `npm --prefix packages/main run build`.

Rhythm: PLAN outcome = EXPECTED → run on the real machine → ACTUAL output → diff.

---

## 1. The 3 HARD-FAILURE wrapper-root regressions (CHK-001) — red→green

EXPECTED (PLAN outcome): on a wrapper-root fixture (metadataRoot != gitRoot),
lattice-dispatch worktree create/remove, checklist verification_evidence_refresh,
and doctor --repair run git from the RESOLVED gitRoot and succeed; the SAME
operations FAIL (throw / return undefined) when run from the bare non-git
metadataRoot (the pre-fix "red" state); plain repos are byte-identical.

COMMAND: `node packages/main/dist/tasks/dispatch-checklist-doctor-wrapper-root-smoke.js`

ACTUAL:
```
✓ dispatch: resolveGitCwd → inner gitRoot; `git worktree list` succeeds there, throws from bare metadataRoot
✓ checklist: evidence freshness probes are undefined from bare metadataRoot, defined from resolved gitCwd
✓ doctor: resolveDoctorGitCwd → inner gitRoot; repair git commands run there, throw from bare metadataRoot
✓ plain-repo: dispatch/checklist/doctor resolvers all return project root verbatim (byte-identical fallback)

✓ dispatch-checklist-doctor wrapper-root smoke passed
EXIT=0
```

DIFF: matches EXPECTED exactly. Each of the 3 sites is proven RED (throws / undefined
from the bare metadataRoot — the original wrapper-root hard failure) and GREEN
(succeeds / defined from the resolved gitRoot — the fix). Plain-repo byte-identity
asserted in the same run. No deviation.

---

## 2. The graceful-degradation sites (CHK-002) — resolve from gitRoot, fallback preserved

EXPECTED: each graceful site resolves the real value from the gitRoot on a
wrapper-root fixture; the existing graceful fallback (undefined) is preserved on a
non-git dir; plain repos byte-identical.

COMMAND: `node packages/main/dist/tasks/graceful-sites-gitroot-cwd-wrapper-root-smoke.js`

ACTUAL:
```
✓ verifier headSha + init-check repair audit: resolveGitCwd → inner gitRoot; head defined there, undefined (preserved) from bare metadataRoot
✓ touchpoints: detectMdTouchpointsFromGit resolves the inner gitRoot and reports docs/guide.md; undefined (preserved) on a non-git dir
✓ plain-repo: verifier/init-check head + touchpoints all resolve to project root verbatim (byte-identical fallback)

✓ graceful-sites wrapper-root smoke passed
EXIT=0
```

DIFF: matches EXPECTED. Real values resolve from the gitRoot; the undefined graceful
fallback is explicitly preserved; plain-repo byte-identity holds.

---

## 3. The project-level scans (CHK-003) — id-independent resolveProjectGitCwd

EXPECTED: resolveProjectGitRoot/Cwd resolves the configured gitRoot subdir on a
wrapper-root fixture; returns projectRoot verbatim on a plain repo; falls back to
projectRoot verbatim when gitRoot is null.

COMMAND: `node packages/main/dist/tasks/project-gitroot-cwd-smoke.js`

ACTUAL:
```
✓ wrapper-root: resolveProjectGitRoot/Cwd → configured gitRoot subdir (≠ non-git metadataRoot), is a git repo
✓ plain-repo: resolveProjectGitCwd → projectRoot (byte-identical to old bare-projectRoot fallback)
✓ null gitRoot: resolveProjectGitRoot returns null → resolveProjectGitCwd falls back to projectRoot verbatim

✓ project-gitroot-cwd smoke passed (wrapper-root + plain-repo + null-gitRoot)
EXIT=0
```

DIFF: matches EXPECTED. The id-independent resolver surveys the real gitRoot;
plain-repo + null-gitRoot fallbacks are byte-identical.

---

## 4. gitroot-cwd-contract green + allowlist split (CHK-004)

EXPECTED: the contract exits 0 with the 9 detection self-tests intact (a
re-introduced bare-root alias/backtick still fails the contract), the repo scan is
clean, DEFERRED_ALLOWLIST_EXACT is EMPTY, and BENIGN_BOOTSTRAP_ALLOWLIST holds the
12 permanent self-bootstrap/no-story-context entries.

COMMAND: `node packages/main/dist/tasks/gitroot-cwd-contract-smoke.js`

ACTUAL:
```
✓ self-test: KNOWN-GOOD fixture produces 0 violations
✓ self-test: KNOWN-BAD fixture produces exactly 1 violation on projectRoot
✓ self-test: ALIAS KNOWN-BAD (const gitCwd = projectRoot → git cwd) produces exactly 1 alias violation
✓ self-test: ALIAS KNOWN-GOOD (const x = projectRoot, not a git cwd) produces 0 violations
✓ self-test: ALIAS KNOWN-GOOD (const gitCwd = resolveGitCwd(...) → git cwd) produces 0 violations
✓ self-test: BACKTICK KNOWN-BAD (execSync(`git`, { cwd: projectRoot })) produces exactly 1 bare violation
✓ self-test: BACKTICK KNOWN-GOOD (execSync(`git`, { cwd: resolvedGitCwd })) produces 0 violations
✓ self-test: docs-drift KNOWN-GOOD fixture (repoRoot: gitCwd) produces 0 violations
✓ self-test: docs-drift KNOWN-BAD fixture (repoRoot: deps.projectRoot) is flagged
✓ repo scan clean: 523 .ts files inspected, 0 bare-cwd violations
✓ review-preflight docs-drift gate wires repoRoot: gitCwd (not metadataRoot)

✓ gitroot-cwd-contract smoke passed
EXIT=0
```

Allowlist state (from source):
```
const DEFERRED_ALLOWLIST_EXACT = new Set<string>([]);   // pending burndown set: EMPTY (B-75f0 closed it)
BENIGN_BOOTSTRAP_ALLOWLIST: 12 entries (permanent self-bootstrap/no-story-context, each with rationale)
```

DIFF: matches EXPECTED. The 9 detection self-tests pass (so a re-introduced bare-root
alias/backtick still fails the contract — detection NOT weakened by the split). The
pending set is verifiably empty; the benign set is 12. None of the 16 fixed/renamed
production files appear in any allowlist (verified by grep), so no real site was
silenced instead of fixed.

---

## 5. Full validate battery

`lattice validate --story=B-75f0` → PASS (exit 0); `npm test` battery (which includes
test:gitroot-cwd-contract + the 3 new wrapper-root smokes wired into the root chain)
ran green; verification intent coverage 12/12 (0 missing, 0 stale).

## Self-check (user value acceptance)
1. Can I imagine the operator's moment? Yes: on a wrapper-root project the operator
   runs `lattice dispatch` / `verification_evidence_refresh` / `lattice doctor --repair`
   and they WORK instead of crashing — the 3 hard failures are gone.
2. Real-machine run, not just a unit assertion? Yes — the smokes build real
   wrapper(metadataRoot)/repo(gitRoot) fixtures and run real `git` child processes.
3. Plain-repo regression risk? Covered — every smoke asserts byte-identity on a plain repo.
4. Did I silence instead of fix? No — DEFERRED set empty, no fixed file re-allowlisted,
   detection self-tests intact.
5. Anything deferred? No — all 4 checklist items fully delivered; pending burndown set EMPTY.
