# B-f882 Real-Machine Transcript — wrapper-root docs-drift preflight fix

Story: Thread resolved gitCwd into the docs-drift REVIEW preflight gate (wrapper-root false-block)
Fix commit: bc5865be (CHK-001) · regression e50c5384 (CHK-002) · guard 710f2175 (CHK-003) · review-fix 1d460ecb

## Expected (PLAN outcome)
On a wrapper-root layout (metadataRoot != gitRoot) the docs-drift REVIEW->TEST preflight gate
scopes its fs/git scanning to the resolved gitRoot, so an existing CLAUDE.md path reference is NOT
falsely reported missing and REVIEW->TEST is NOT false-blocked. On a plain repo behavior is
byte-identical. A wrapper-root regression and a strengthened guard run in the validate battery and
are provably RED against the pre-fix wiring.

## The fix (one argument)
`packages/main/src/handlers/review-preflight.ts` runReviewCliGates, docs-drift gate call (~:430):
```
-      repoRoot: deps.projectRoot,
+      repoRoot: gitCwd,
```
`gitCwd` is the value resolved once at ~:287 via `resolveGitCwd(...)` and already threaded into the
channel/concept/english git-invoking gates. `runDocsDriftGate -> checkPathDrift -> scanPathDrift`
(core/audit-scan.ts) runs `fs.existsSync(join(repoRoot,p))` and `git grep -F ... {cwd: repoRoot}`;
both are scoped by repoRoot. Passing metadataRoot there on wrapper-root layouts made existing paths
look absent -> false missing-path drift -> false REVIEW->TEST block (B-0740 defect class).

## STEP 1 — GREEN (fixed tree, repoRoot: gitCwd)

```
$ grep -n 'repoRoot:' packages/main/src/handlers/review-preflight.ts
430:      repoRoot: gitCwd,

$ node packages/main/dist/tasks/docs-drift-wrapper-root-smoke.js
docs-drift wrapper-root smoke passed                      # exit 0

$ node packages/main/dist/tasks/gitroot-cwd-contract-smoke.js
... 504 .ts files inspected, 0 bare-cwd violations
✓ review-preflight docs-drift gate wires repoRoot: gitCwd (not metadataRoot)
✓ gitroot-cwd-contract smoke passed                       # exit 0
```

## STEP 2 — RED (temporarily revert to repoRoot: deps.projectRoot, rebuild)

```
$ perl -0pi -e 's/repoRoot: gitCwd,/repoRoot: deps.projectRoot,/' packages/main/src/handlers/review-preflight.ts
430:      repoRoot: deps.projectRoot,
$ npm --prefix packages/main run build      # exit 0

$ node packages/main/dist/tasks/docs-drift-wrapper-root-smoke.js
AssertionError [ERR_ASSERTION]: PRIMARY: docs-drift gate must PASS on wrapper-root
  (got status=fail, details=["missing path: dev-notes/wrapper-doc.md", ...]).
  A FAIL here means repoRoot was scanned from the non-git metadataRoot (the pre-CHK-001 wiring).
  false !== true
                                                          # exit non-zero (RED)

$ node packages/main/dist/tasks/gitroot-cwd-contract-smoke.js
✗ gitroot-cwd-contract smoke FAILED (review-preflight docs-drift)
  .../review-preflight.ts: runDocsDriftGate(...) repoRoot is 'deps.projectRoot' — must be the
  resolved 'gitCwd' ... Forwarding deps.projectRoot/projectRoot/metadataRoot here makes
  scanPathDrift run git from the non-git metadataRoot on wrapper-root layouts -> false
  missing-path drift -> false REVIEW->TEST block (B-f882).
                                                          # exit non-zero (RED)
```

Both the CHK-002 regression and the CHK-003 guard fail with the fix reverted — proving the fix is
load-bearing and the regression genuinely distinguishes gitRoot vs metadataRoot.

## STEP 3 — RESTORE + re-verify GREEN

```
$ git checkout -- packages/main/src/handlers/review-preflight.ts
430:      repoRoot: gitCwd,
$ npm --prefix packages/main run build      # exit 0
$ node packages/main/dist/tasks/docs-drift-wrapper-root-smoke.js
docs-drift wrapper-root smoke passed                      # exit 0
$ node packages/main/dist/tasks/gitroot-cwd-contract-smoke.js
✓ gitroot-cwd-contract smoke passed                       # exit 0
```
`git status` after restore shows only `.lattice/story/` metadata modified — review-preflight.ts is
back at the committed `repoRoot: gitCwd` state; no source drift.

## REVIEW->TEST preflight (the gate this story modifies) — ran against the real repo

```
REVIEW->TEST preflight: running CLI gates (channel/concept/lint/docs-drift plus conditional codex-adapter)...
CLI gate preflight: all pass
DEV->TEST gate: running lattice validate --json...
ran: npm test
validate PASS, writing test-evidence.json
Story B-f882 advanced to TEST
```
The docs-drift preflight gate (now wired `repoRoot: gitCwd`) passed against the real Orchestrate
repo, and the npm test battery — including the new `test:docs-drift-wrapper-root` regression and the
now-chain-wired `test:gitroot-cwd-contract` guard — passed.

## Verification coverage
`lattice validate --story=B-f882` → Verification intent coverage: 9/9 covered (0 required missing),
ALL PASS. All 9 must-intents bound to head 1d460ecb.

## Outcome diff (expected vs actual)
No diff. Expected = actual: wrapper-root layouts no longer false-block REVIEW->TEST (docs-drift gate
scopes fs/git to gitRoot), plain-repo behavior unchanged (existing docs-drift-path-drift-smoke green),
regression + guard wired into the battery and proven RED against the pre-fix wiring.

## Scope confirmation
- english-artifacts gate storyDir wiring (deferred finding #3): UNTOUCHED.
- express-channel docstring (separate story #2): UNTOUCHED.
- managedAssetDefs / listManagedAssetDefinitions(deps.projectRoot) resolution: UNTOUCHED.
- Only changed: the single docs-drift repoRoot argument + comment, a new wrapper-root smoke, a guard
  extension to gitroot-cwd-contract-smoke.ts, and package.json test-chain wiring.
