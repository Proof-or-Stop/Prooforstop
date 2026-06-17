# B-d633 real-machine verification (user-perspective)

**User value**: the docs-drift managed-asset check can once again catch the exact
`.codex/hooks` "do not create" contradiction it was built for — the temporary bridge
allowlist that B-a7b0 added (and that B-94ae's merge made moot) no longer masks it.

## Expected (PLAN outcome)
- `DOCS_DRIFT_MANAGED_ASSET_ALLOWLIST` default is empty (only seam + comment remain).
- The gate run against the real current CLAUDE.md still passes (0 contradictions),
  because B-94ae already corrected the wording.
- A re-introduced `不要创建 .codex/hooks` prohibition is now FLAGGED (no longer silently allowed).
- The smoke still proves the seam (explicit injected allowlist suppresses) AND detection.
- Gate logic (checkManagedAssetContradiction / GENERATED_MANAGED_ASSET_KINDS / normalizeAssetPath) unchanged.

## Actual (run from the worktree)

Command: `npm --prefix packages/main run test:docs-drift-smoke`
```
docs-drift path+asset smoke passed
```
→ covers: seam-suppression via injected allowlist (pass) + NEW empty-default regression
  asserting the `.codex/hooks` contradiction is FLAGGED (status=fail, contradiction listed).

Command (node, real CLAUDE.md + empty default allowlist):
```
default allowlist size: 0
contradictions vs real CLAUDE.md w/ empty DEFAULT allowlist: []
✓ default allowlist is empty AND real doc passes (B-94ae already fixed the wording)
```

Command: `git diff main...HEAD --stat`
```
 packages/main/src/handlers/validate-docs-drift.ts      (allowlist emptied, seam+comment kept)
 packages/main/src/tasks/docs-drift-path-drift-smoke.ts (seam→injected allowlist + new regression)
```

Command: `lattice codex verify`
```
✓ Codex adapter checks passed (8/8 pass)
```

## Diff notes (expected vs actual)
- Expected == actual: default allowlist empty (size 0), real doc passes (0 contradictions),
  the masking is gone (empty default now flags `.codex/hooks` — proven by the new regression),
  seam still proven via injection, gate logic untouched, codex adapter green.

## 5-question self-check
1. PLAN outcome concrete? Yes — exact smoke output + empty-default verification captured.
2. Read user-perspective output? Yes — the gate behavior a maintainer would observe (now catches the lie).
3. Would the user consider it done? Yes — the gate's flagship detection is restored; no permanent mask.
4. Noise/duplicate engineering logs? No — 2-file data+test change.
5. Plain-language summary? "The docs-drift gate no longer permanently exempts the `.codex/hooks`
   'do not create' lie; that temporary bridge is gone now that the doc itself was fixed."
