# Plan: B-e256 Keep the global Proof-or-Stop executable working across dist rebuilds and worktrees

Evidence pack (gitignored, copied into this worktree): `.proof-or-stop/evidence/red-proofs/2026-09-02-framework-defects/` — `red-global-cli-exec-bit.mjs`, `run4-global-cli.txt` (RED), `run4-global-cli-GREEN.txt` + `green-4-promote-dist.patch` (GREEN candidate). Repro probe `rp-mtk46lj8-90q9av`, review `rr-mtk4acx4-oqze5c`. Decision: `promote-restores-bits`.

## CHK-001: Restore the executable bit on package.json bin targets when dist is promoted

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Modify: scripts/promote-dist.mjs, scripts/build-main-with-binding.mjs (comment/header only if needed), scripts/build-utils-with-binding.mjs (only if it needs a different packageRoot)
- Test: packages/main/tests/red/red-global-cli-exec-bit.mjs (run from the evidence pack until CHK-002 commits it)

Apply the proven candidate: in `scripts/promote-dist.mjs` add and export `restoreBinExecutableBits(tree, dist = tree)` (reads `<dirname(dist)>/package.json`, resolves each declared `bin` beneath the real promoted tree, rejects non-regular/final-symlink targets and intermediate-symlink escapes, restores POSIX executable bits with `mode | 0o111`, preserves the byte-identical Node entrypoint used by npm command shims on Windows, swallows ENOENT per target, returns the restored list, and returns `[]` when package.json is missing/unparseable or has no `bin`). `promoteDist` must run this validation and restoration against the staging tree before evicting the current dist, so a failed restoration leaves the working dist in place. Only `node:` built-ins (the module's fresh-checkout footprint rule). Keep the crash-safety comments; add a short comment citing this story and the RED symptom.

**Verify**:
- `npm --prefix packages/main run build` then the red regression prints `contract: global-cli-bin-target-restored`; on POSIX, `ls -la packages/main/dist/cli.js` also shows executable bits, while Windows validates the byte-identical Node entrypoint used by the npm command shim
- `RED_REPO_ROOT=$PWD node .proof-or-stop/evidence/red-proofs/2026-09-02-framework-defects/red-global-cli-exec-bit.mjs` exits 0 with the GREEN line
- A second `npm --prefix packages/main run build` skips (content-bound binding still verifies)
- `node packages/main/tests/red/red-1734-content-binding.mjs` still passes

**DoneWhen**:
- Both builds route through promoteDist and leave bin targets executable; absent bin target / missing bin field are no-ops (add these two cases to the red test in CHK-002)

## CHK-002: Commit red-global-cli-exec-bit.mjs as a registered red test that is GREEN after the fix

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/tests/red/red-global-cli-exec-bit.mjs
- Modify: proof-or-stop.config.json
- Test: packages/main/tests/red/red-global-cli-exec-bit.mjs

Copy the script from the evidence pack; extend it with hermetic cases that import `restoreBinExecutableBits` from `scripts/promote-dist.mjs`: (a) on POSIX, a temp package with a 0644 bin target becomes executable and content stays unchanged; on Windows, the byte-identical Node entrypoint remains compatible with the npm command shim; (b) a temp package with no bin field / absent target returns `[]` without throwing. Register in `proof-or-stop.config.json` like the sibling red entries (`node`, `timeoutMs: 180000`, git-common-dir shared).

**Verify**:
- `node packages/main/tests/red/red-global-cli-exec-bit.mjs` exits 0 from the worktree
- `RED_REPO_ROOT=<unfixed-main-checkout> node packages/main/tests/red/red-global-cli-exec-bit.mjs` exits 1 against the preserved unfixed baseline — manual transcript
- `proof-or-stop validation_plan` lists the entry

**DoneWhen**:
- Script committed, registered, GREEN in worktree, RED against unfixed main

## CHK-003: Make doctor verify the global executable realpath and mode with an exact repoint remediation

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/runtime-environment-checks.ts, packages/main/src/handlers/doctor.ts (only if the row is not already rendered from runRuntimeEnvironmentChecks), packages/main/tests/global-core-realpath.test.mjs
- Test: packages/main/tests/global-core-realpath.test.mjs

Extend `checkGlobalCoreRealpath` (B-fa65) so its result also carries `binTarget`, `binMode` and `executable` for the resolved package's `package.json.bin` target, and warn when the realpath resolves into a `.worktrees/` checkout of this repository. Remediation must be executable by the host shell: POSIX renders quoted `cd --`, `chmod +x`, and `ls -ld` commands; Windows renders cmd.exe-valid `cd /d`, double-quoted paths, `dir /a`, and npm-shim guidance without treating POSIX mode bits as authority. Stay informational when no global install is found, emit the stable `contract: global-core-realpath-pass` marker for a resolved pass, and keep every existing classification and test case passing.

**Verify**:
- `node packages/main/tests/global-core-realpath.test.mjs` passes with the new non-executable and worktree-realpath cases
- `proof-or-stop doctor` prints the global-core row (realpath, version, observed mode) and `contract: global-core-realpath-pass` on any supported host when the global core resolves correctly
- `proof-or-stop validate --lint` green

**DoneWhen**:
- Doctor row present with facts + remediation; no host mutation performed by doctor
