# Plan: B-75f0 Burn down the B-6666 gitroot-cwd DEFERRED_ALLOWLIST

Charter: thread a git-cwd resolver into the ~16 real wrapper-root sites (incl. 3
hard failures), rename 3 lexical false-positives, split the deferred allowlist
into a permanent benign-bootstrap set + an EMPTY pending set. Plain-repo behavior
MUST stay byte-identical (fall back to root when no gitRoot resolves). Systematic:
ONE site at a time; after each, `npm --prefix packages/main run build` then
`node packages/main/dist/tasks/gitroot-cwd-contract-smoke.js` MUST stay GREEN, and
remove that site from `DEFERRED_ALLOWLIST_EXACT` as it is fixed.

Resolver API (packages/main/src/core/story-signed-workspace-resolution.ts):
- `resolveGitCwd({store,storyId,metadataRoot,projectRoot,cwd?,config?}): string`
  — EXPORTED; returns authoritativeCwd, falls back to `projectRoot`. Needs a REAL
  store + storyId in scope at the caller.
- `resolveProjectGitRoot(metadataRoot, configuredGitRoot): string | null` —
  currently PRIVATE; must be EXPORTED (CHK-003 pre-step). Id-independent; returns
  null when unresolved → caller MUST `?? root`.
- doctor.ts `resolveDoctorGitCwd(root): string` — already exists, id-independent.

GLOBAL GUARDRAIL (applies to every CHK): a site is removed from the allowlist
ONLY after the resolver is genuinely threaded. NEVER re-allowlist a still-bare
site to get the contract green. Where the call site lacks store/storyId, thread
the resolver from the CALLER where store+storyId live, or use the id-independent
`resolveProjectGitRoot` — NEVER fabricate a storyId.

---

## CHK-001: Fix the 3 HARD-FAILURE wrapper-root sites + a wrapper-root regression each

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/lattice-dispatch.ts (listedGitWorktreeRoots ~:1185, assertRegisteredDispatchWorktreeRoot ~:1251 — thread resolveGitCwd from the CALLER that holds store + record.storyId; the helpers only take `root`, so resolve at the caller and pass the resolved cwd in)
- Modify: packages/main/src/handlers/checklist.ts (evidenceHashes / verification_evidence_refresh ~:188 `const gitCwd = root` — thread resolveGitCwd; storyId is available in the handler caller, pass store+storyId down)
- Modify: packages/main/src/handlers/doctor.ts (tryWorktreeRemove ~:687, removeStaleWorktreeAdminDirs ~:733, deleteTerminalStoryBranch — pass `resolveDoctorGitCwd(root)` as the git cwd; one-liners since the helper already exists)
- Test: a wrapper-root regression for EACH of the 3 (metadataRoot != gitRoot), in packages/main/src/tests or packages/main/tests (use the existing wrapper-root fixture pattern from docs-drift-wrapper-root-smoke / B-2856 if present)

**Verify**:
- `npm --prefix packages/main run build` clean
- `node packages/main/dist/tasks/gitroot-cwd-contract-smoke.js` exits 0 after each site is fixed AND removed from DEFERRED_ALLOWLIST_EXACT
- Each wrapper-root regression: red BEFORE the fix (proves the bug), green AFTER (proves the resolved cwd == gitRoot, not metadataRoot)
- Plain-repo path: assert the resolved cwd == root when projectRoot==gitRoot (byte-identical)

**DoneWhen**:
- lattice-dispatch, checklist evidence-refresh, doctor --repair all run git from the resolved gitRoot on wrapper-root (no throw, no wrong-dir git)
- 3 wrapper-root regressions exist and pass (each proven red→green)
- The 3 files removed from DEFERRED_ALLOWLIST_EXACT; contract green
- Plain-repo byte-identity preserved (explicit root fallback at each site)

---

## CHK-002: Thread resolveGitCwd into the graceful-degradation real sites

**Owner**: lattice-implementer
**DependsOn**: none (disjoint files from CHK-001; can run in parallel)
**Files**:
- Modify: packages/main/src/handlers/verifier.ts (currentHead ~:326 — caller decorateStoryVerification has storyId; thread store+storyId+metadataRoot)
- Modify: packages/main/src/core/lattice-handoff.ts (resolveCommitSha ~:877)
- Modify: packages/main/src/core/codex-adapter-checks.ts (readGitHead ~:136)
- Modify: packages/main/src/core/touchpoints-fallback.ts (detectMdTouchpointsFromGit ~:15)
- Modify: packages/main/src/core/validation-executor.ts (readGitStatus ~:53)
- Modify: packages/main/src/handlers/recover-evidence.ts (readGitStatusLines ~:59)
- Modify: packages/main/src/handlers/init-check.ts (init_check_repair audit block ~:289)
- Test: wrapper-root coverage for the threading where cheap (at minimum verifier headSha + touchpoints routing, which have a storyId)

**Verify**:
- `npm --prefix packages/main run build` clean
- `node packages/main/dist/tasks/gitroot-cwd-contract-smoke.js` exits 0 after each site fixed + removed from allowlist
- Where storyId is in scope use resolveGitCwd; where it is NOT, use the id-independent resolveProjectGitRoot (CHK-003 export) with `?? root` fallback
- Preserve the EXISTING graceful fallback (undefined/null/[]/'unknown') when resolution fails

**DoneWhen**:
- Each graceful site resolves from gitRoot on wrapper-root and returns the real value
- Existing graceful degradation preserved when no gitRoot resolves
- 7 files removed from DEFERRED_ALLOWLIST_EXACT; contract green
- Plain-repo byte-identical

---

## CHK-003: Fix the project-level scans with an id-independent resolveProjectGitRoot

**Owner**: lattice-implementer
**DependsOn**: none (but CHK-003 PRE-STEP — export resolveProjectGitRoot — is shared infra; do it first within this item)
**Files**:
- Modify: packages/main/src/core/story-signed-workspace-resolution.ts (EXPORT resolveProjectGitRoot, or add a thin exported wrapper e.g. `resolveProjectGitCwd(metadataRoot, config, projectRoot): string` that returns `resolveProjectGitRoot(...) ?? projectRoot`)
- Modify: packages/main/src/tasks/gap-analyze.ts (readLinkedStoryWorktreeIds ~:172 — has projectRoot; load config via loadConfig(projectRoot))
- Modify: packages/main/src/handlers/story-query.ts (scanTerminalStoryResidues ~:1011 — config already loaded at ~:1001, pass config.gitRoot)
- Modify: packages/main/src/dashboard.ts (collectProject git worktree list ~:67 + git status ~:123 — add loadConfig(root))
- Test: wrapper-root coverage proving the project-level scan surveys gitRoot not metadataRoot (where cheap)

**Verify**:
- resolveProjectGitRoot (or wrapper) is exported and importable (tsc green)
- `node packages/main/dist/tasks/gitroot-cwd-contract-smoke.js` exits 0 after each scan threaded + removed from allowlist
- null/unresolved → `?? root` fallback (plain-repo byte-identical)

**DoneWhen**:
- gap-analyze, story-query, dashboard survey the real gitRoot on wrapper-root
- resolveProjectGitRoot exported; 3 files removed from DEFERRED_ALLOWLIST_EXACT
- contract green; plain-repo byte-identical

---

## CHK-004: Rename the 3 lexical false-positives + split DEFERRED_ALLOWLIST; contract green

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003 (the allowlist split requires the real sites already fixed + removed, so the pending set can be EMPTY)
**Files**:
- Modify: packages/main/src/handlers/done-effects.ts (~:74 — rename the param projectRoot->gitCwd; it already receives doneGitCwd, ZERO behavior change)
- Modify: packages/main/src/handlers/review-run.ts (~:62 — param already gets signedWorkspaceRoot/authoritativeCwd; rename projectRoot->gitCwd, ZERO behavior change)
- Modify: packages/main/src/core/review-run.ts (~:228 — same, rename projectRoot->gitCwd)
- Modify: packages/main/src/tasks/gitroot-cwd-contract-smoke.ts (split DEFERRED_ALLOWLIST_EXACT into BENIGN_BOOTSTRAP_ALLOWLIST — the ~14 truly-benign self-bootstrap/lab/rollout/test_auto/aux-diagnose entries, each keeping its rationale, PERMANENT — and an EMPTY pending/burndown set. Update isDeferredFromNewRules / isAllowlisted accordingly. If any graceful site is deferred as a documented sub-follow-up, it stays in a clearly-NAMED pending set with its B-id, NEVER silently in benign.)

**Note** (from INIT-002 advisory): CHK-004's "the CHK-003 pattern" in the checklist context is a cross-story reference to B-6666's param-rename pattern, NOT this story's CHK-003. The rename here is the same projectRoot->gitCwd alias-cleanup pattern; zero behavior change.

**Verify**:
- `npm --prefix packages/main run build` clean (tsc proves the renames are mechanical)
- `node packages/main/dist/tasks/gitroot-cwd-contract-smoke.js` exits 0
- The smoke's own self-tests still prove a re-introduced bare-root alias FAILS the contract (detection intact — not silenced)
- BENIGN_BOOTSTRAP_ALLOWLIST entries each carry a rationale; pending set is verifiably empty (or explicitly tracked)

**DoneWhen**:
- 3 params renamed projectRoot->gitCwd (lexically honest, zero behavior change)
- DEFERRED_ALLOWLIST_EXACT split: BENIGN_BOOTSTRAP (permanent, with rationale) + EMPTY pending
- contract exits 0; detection of re-introduced bare-root still fails (self-tests green)
