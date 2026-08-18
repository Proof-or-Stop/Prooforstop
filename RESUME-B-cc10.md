# B-cc10 — blocked on one human command

Phase: **DEV**, 8/8 items done. Blocked by the convergence breaker (`gate-repeat 2>=2`).

## Verified state (this session, read-only)

| Check | Result |
|---|---|
| `lifecycle_check --target=REVIEW` | **0 blockers**; DEV→REVIEW is clear |
| checklist | 8/8 done |
| verification evidence | present or waived |
| tsc / residue / 3 migration witnesses | all PASS |
| main-sync | behind main by 2 commits (advisory only) |

Two corrections to earlier notes in this file:

1. **The breaker is still armed.** `convergence-breaker.json` is absent, but that file is stored
   state, not the live verdict — `story_advance` still refuses. Do not read a missing file as
   "unfrozen".
2. **`done_prepare` is the wrong tool here.** It is TEST-only and blocks at preflight with
   "story B-cc10 is in DEV". The real next transition is DEV→REVIEW.

The lease was force-taken from a dead same-worktree session (`sess-c6bba4b3dfe060d4`,
14m stale heartbeat) after confirming no live owner. The only live process was
`story_advance` on **B-dc83** — a different story. `--forceTakeover` does **not** bypass the
breaker; it gates takeover-carrying commands too.

## To unblock

Run as **two separate commands** in an interactive terminal. A `cd … && node …` chain strips the
TTY and the ack is refused (`isInteractiveAckAllowed`, `core/convergence-breaker.ts`, requires
`stdin.isTTY === true`). Do **not** add `--takeover` / `--forceTakeover`.

```
cd /Users/qipan/work/repo/Prooforstop/.worktrees/B-cc10
```

```
node bin/proof-or-stop.js story_resume --storyId=B-cc10 --ack --reason="8/8 items done with mechanical receipts; lifecycle_check --target=REVIEW reports 0 blockers; eight hardcoded-path defects found and fixed during the freeze; scope gate at shadow with recorded reason"
```

If it still refuses, check `env | grep -iE '^CI=|AUTOPILOT|NON_INTERACTIVE'` — any truthy value
refuses the ack regardless of TTY.

## After unfreezing

```
node bin/proof-or-stop.js story_advance '{"storyId":"B-cc10","phase":"REVIEW"}'
```

Then REVIEW (reviewer roster + CLI preflight gates) → TEST → `done_prepare` (valid from TEST) → DONE.

## Eight hardcoded-path defects fixed during the freeze

Class: constants that hardcoded `.lattice/` instead of deriving from the resolver, so they kept
pointing at the pre-migration directory.

`managed-assets.ts` MANIFEST_REL_PATH; `finding-verify.ts` gap-log artifact + provenance ledger;
`artifact-release.ts` + `capability-release.ts` ledger paths; `lifecycle-registry.ts`
DEFAULT_STORY_DIR_PREFIXES (canonical was missing entirely); `playbook-runtime-baseline.ts`
fixture storyDir; `brand-path-resolver-smoke.ts` flip regex (my own guard, pinned to one spelling).

**One deliberately NOT changed:** `lifecycle-registry.ts:904`, inside a list named `legacyPrefixes`
whose purpose is recognizing the pre-migration layout. Rewriting it would delete read-both
behaviour. Seven occurrences, six defects, one correct — a blind sweep breaks the seventh.

## Deferred (not silently dropped)

- **gap-log provenance chain**: `gap_log` now fails `invalid_binding_shape` because the signed
  append-only chain's last entry records the old `artifactPath`. Deferred rather than rewrite
  signed history. B-META F-036 was never written — the earlier claim that it was is retracted.
- **scope gate at `mode=shadow`** with a recorded reason: `scope_contract_set` silently drops the
  deleted side of a rename (`canonicalizeScopePath` cannot canonicalize a deleted path).
- **`verify-entrypoints.mjs`** environmentally blocked: global shim `/Users/qipan/bin/lattice`
  hardcodes the main checkout and must be repointed to `bin/proof-or-stop.js` before CHK-006 merges.
