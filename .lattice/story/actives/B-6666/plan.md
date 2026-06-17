# Plan: B-6666 Close the gitRoot defect class (done-oracle + evidence-freshness + un-game the contract)

Approach A (chosen): resolve gitCwd ONCE at the boundary, thread down, fall back to root for
plain repos (byte-identical), then strengthen the contract to catch BOTH blind spots (alias +
backtick) and fix every confirmed bare-root site it newly flags. Log any oversized backtick
remainder as a documented scoped follow-up — never leave the contract red.

Key facts the implementers must hold:
- resolveGitCwd: `packages/main/src/core/story-signed-workspace-resolution.ts:195`
  `resolveGitCwd({store, storyId, metadataRoot, projectRoot, cwd?, config?}) -> string`
  Returns authoritativeCwd (wrapper-root aware) or falls back to projectRoot; never throws.
- The DONE-oracle path is: `transition-orchestrator.ts:363 runDonePreMergeGate(storyId,store,ctx.root,actor)`
  -> `done-effects.ts:567 runDonePreMergeGate(..., root, ...)` -> `done-effects.ts:575 runDoneOracleGate(..., root, ...)`
  -> `phase-gates.ts:539 runDoneOracleGate(..., root, ...)` -> `phase-gates.ts:545 buildDoneChecklist(storyId,store,root)`
  -> `done-oracle.ts:210 buildDoneChecklist(...,root,...)` -> `done-oracle.ts:324 readGitStatusLines(root)` (THE false-block).
- `transition-orchestrator.ts:271` ALREADY resolves `doneGitCwd = resolveGitCwd({...metadataRoot:ctx.root,projectRoot:ctx.root})`
  and uses it for `checkMainDivergence(:290)` + `autoSyncMain(:293)`. Reuse that SAME value at :363 — do NOT re-resolve.
- The contract baseline: `npm run test:gitroot-cwd-contract` currently exits 0 over a LIVE defect (gamed/silenced).

DEV discipline (Debugging Contract): one site at a time; after each fix re-run
`npm run test:gitroot-cwd-contract` and `npm --prefix packages/main run build`; never batch unrelated fixes.

---

## CHK-001: Thread resolved gitCwd into the DONE-oracle git-status path (fix the wrapper-root DONE false-block)

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/transition-orchestrator.ts (pass doneGitCwd at the runDonePreMergeGate call ~:363, instead of bare ctx.root)
- Modify: packages/main/src/handlers/done-effects.ts (runDonePreMergeGate / runDoneOracleGate signatures + forwarding ~:567/:575 — thread the resolved gitCwd through; keep `root` for metadata/store reads, add a distinct gitCwd param for git calls)
- Modify: packages/main/src/handlers/phase-gates.ts (runDoneOracleGate ~:539 — forward gitCwd to buildDoneChecklist)
- Modify: packages/main/src/core/done-oracle.ts (buildDoneChecklist ~:210 — accept resolved gitCwd; thread into readGitStatusLines:324, and the inline `execSync('git diff main...HEAD', cwd:root)`:461, plus gitRefExists/gitRefContainsMain/checkMainDivergence calls reachable from the gate; fall back to root when gitCwd absent)
- Test: a new wrapper-root regression smoke under packages/main/src/tasks/ (red->green for the git-working-tree row)

**Design constraints**:
- Resolve ONCE. The single resolution point is transition-orchestrator.ts:271 (`doneGitCwd`). Thread that exact value down. Do NOT call resolveGitCwd again inside done-effects/phase-gates/done-oracle.
- Keep `root` (metadataRoot) for everything that reads story metadata / config / audit writer; ONLY the git invocation cwd changes to the resolved gitCwd.
- Add a `gitCwd` parameter (default = root) so plain repos and any non-DONE caller stay byte-identical: `buildDoneChecklist(storyId, store, root, options)` where options carries `gitCwd` (or add an explicit param threaded from runDoneOracleGate). When gitCwd is undefined, behavior is identical to today.
- The internal helpers readGitStatusLines/gitRefExists/gitRefContainsMain/checkMainDivergence currently take a single `projectRoot` used as `const gitCwd = projectRoot`. Change them to take the resolved gitCwd directly (rename the param to gitCwd, drop the no-op alias) — this is also what makes the strengthened CHK-003 contract pass for these sites.

**Verify**:
- `npm --prefix packages/main run build` clean (tsc exit 0)
- New wrapper-root regression smoke: build a metadataRoot != gitRoot fixture, drive buildDoneChecklist, assert git-working-tree row status flips fail->pass (clean) when gitCwd resolves to the real gitRoot; assert it was fail with bare metadataRoot (red baseline captured in the same test).
- Plain-repo path: assert buildDoneChecklist output is byte-identical when gitCwd is absent / equals root.
- `lattice validate --story=B-6666` PASS

**DoneWhen**:
- On a wrapper-root fixture the git-working-tree done-check row reads clean (not fail/blocking).
- doneGitCwd is resolved once and threaded; no second resolveGitCwd call inside the gate chain.
- Plain repo behavior byte-identical (root fallback proven by test).
- All done-oracle git calls reachable from the DONE gate use the threaded gitCwd, not a bare-root alias.

## CHK-002: Thread resolved gitCwd into evidence-freshness git probes

**Owner**: lattice-implementer
**DependsOn**: CHK-001 (shares done-oracle threading; CHK-001 lands the buildDoneChecklist gitCwd plumbing CHK-002 reuses for the :280 checkEvidenceFreshness call)
**Files**:
- Modify: packages/main/src/core/evidence-freshness.ts (the 4 bare-root probes currentGitHead:50, changedFilesBetween:67, changedFilesBetweenRenameAware:89, currentMaterialHash:116, and checkEvidenceFreshnessForGit:143 + checkEvidenceFreshness wrapper:178 — accept/forward the resolved gitCwd; remove the no-op `const gitCwd = projectRoot` alias + the confessional comment at :51-54)
- Modify: packages/main/src/core/done-oracle.ts (the checkEvidenceFreshness(store,storyId,root):280 call — pass the same resolved gitCwd threaded in CHK-001)
- Modify: packages/main/src/handlers/phase-gates.ts (runAuthorityReceiptTransitionGate ~:349/:350/:458 — resolve gitCwd at this caller boundary via resolveGitCwd and pass to currentGitHead/currentMaterialHash; this is the confirmed authority-receipt TEST/DONE wrapper-root site)

**Design constraints**:
- Two legitimate threading styles per the charter: "resolve at caller boundary OR accept a gitCwd param". Prefer: give the evidence-freshness probe functions a resolved gitCwd parameter (default = root / projectRoot for byte-identity); resolve at the caller boundaries that today pass bare root.
- The DONE-path caller (done-oracle.ts:280) must use the SAME resolved gitCwd as the git-status row — no split-brain between the two done-oracle git reads.
- The authority-receipt caller (phase-gates.ts runAuthorityReceiptTransitionGate) resolves gitCwd at its boundary (it has store+storyId+ctx.root) and passes it down.
- Scope guard: checklist.ts / verifier.ts / lattice-dispatch.ts callers are NOT in the confirmed wrapper-root DONE/authority blast radius for THIS story. If touching them is needed for the strengthened contract to go green (CHK-003 may flag them), thread gitCwd there too; otherwise leave them and rely on the byte-identical default param + the CHK-003 deferred-site log. Do NOT expand into unrelated handlers without a contract flag forcing it.
- Fall back to root/projectRoot when gitCwd absent (plain repos byte-identical).

**Verify**:
- `npm --prefix packages/main run build` clean
- Wrapper-root: currentGitHead/currentMaterialHash return defined hashes against the real gitRoot (extend the CHK-001 regression or add an evidence-freshness wrapper-root assertion).
- Plain repo: probe outputs byte-identical before/after.
- `lattice validate --story=B-6666` PASS

**DoneWhen**:
- evidence-freshness.ts probes route through a resolved gitCwd (no `const gitCwd = projectRoot` no-op alias remains; confessional comment removed).
- done-oracle.ts:280 and the authority-receipt caller pass the resolved gitCwd.
- Plain repo byte-identical (proven by test).

## CHK-003: Strengthen the gitroot-cwd contract to close the alias + backtick-template blind spots, and make it GREEN

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002 (the confirmed bare-root sites must already be fixed so the strengthened contract goes green; otherwise it would be red on the very sites this story fixes)
**Files**:
- Modify: packages/main/src/tasks/gitroot-cwd-contract-smoke.ts
  - (a) ALIAS RULE: detect a no-op `const <name> = projectRoot|root|metadataRoot` that is subsequently used as a git `cwd:` WITHOUT routing through resolveGitCwd (scope the detection to a git-call proximity window so legit non-git aliases do not false-positive). This catches the d93b69b8f silencing.
  - (b) BACKTICK RULE: extend GIT_CALL_REGEX (or add a parallel scan) to match backtick-template `execSync(`git ...`)` / `execFileSync`/`spawnSync` template forms, then apply the bare-cwd + alias checks to those windows too (~14 non-smoke sites measured at INIT; 4 confirmed bare-root).
  - Add KNOWN-GOOD + KNOWN-BAD self-test fixtures for BOTH new rules (pin them both ways), mirroring the existing self-test style in the smoke.
- Modify (if newly flagged & confirmed bare-root wrapper-root sites): packages/main/src/handlers/validate-channel.ts (x2 projectRoot), packages/main/src/handlers/test-runner-core.ts (x2 root), packages/main/src/handlers/validate-concept.ts — thread resolveGitCwd or document+allowlist with a scoped follow-up note.
- Modify (only if a new regression script is needed): package.json

**Design constraints**:
- The contract MUST end GREEN (`npm run test:gitroot-cwd-contract` exit 0). B-99b6 wires it into the gate next; a red contract blocks B-99b6.
- Bounded blast radius: FIX the confirmed wrapper-root bare-root sites (done-oracle + evidence-freshness from CHK-001/002, plus any of validate-channel/test-runner-core/validate-concept that are real bare-root AND fixable safely). For any oversized remainder, add to a DOCUMENTED in-file allowlist with a scoped follow-up comment (storyId + reason) so the contract stays green and the deferral is auditable — do NOT silently widen the regex to ignore them.
- The alias rule must be proximity-scoped (alias used as a git cwd within the same git-call window), so `const x = projectRoot` not used as a git cwd is NOT flagged (preMortem #3).
- Verify the new rules turn the contract RED if the exact d93b69b8f gaming shapes are reintroduced (self-test KNOWN-BAD asserts >=1 violation).

**Verify**:
- `npm --prefix packages/main run build` clean
- `npm run test:gitroot-cwd-contract` exit 0 with the strengthened rules + self-tests passing
- Manual red->green proof: temporarily reintroduce a `const gitCwd = projectRoot;` alias used as a git cwd in done-oracle.ts -> contract exits non-zero -> revert -> exit 0 (record transcript)
- `lattice validate --story=B-6666` PASS

**DoneWhen**:
- Contract detects (a) no-op alias used as git cwd without resolveGitCwd, and (b) backtick-template git calls with bare-root cwd; both pinned by KNOWN-GOOD/KNOWN-BAD self-tests.
- Every confirmed wrapper-root bare-root site is fixed (routes through resolveGitCwd); any deferred backtick site is in a documented allowlist with a scoped follow-up note.
- `npm run test:gitroot-cwd-contract` exits 0 (GREEN); reintroducing either gaming shape turns it RED.
