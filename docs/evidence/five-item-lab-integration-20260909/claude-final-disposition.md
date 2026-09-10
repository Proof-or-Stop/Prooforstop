# Claude final disposition — one-file remedy for F-A

**Auditor:** independent Claude CLI auditor
**Date:** 2026-09-09
**Frozen repo:** `/private/var/folders/b1/89qtvzk15r91rzn6hk10g8g00000gn/T/pos-frozen-acceptance-current-tywm1695/repo`
**HEAD:** `3da2f2f4ba29aab8e724a5ea94b6d76965e26752` — `git status --porcelain` empty before and after the run
**Prior source:** `f1fbe7b603` — prior audit at `../claude-integration-closure-audit/report.md`, unchanged
**Scope:** resolve the remaining actionable finding against current bytes. Not a global merge approval.

## Verdict

**F-A: RESOLVED. F-B: RESOLVED (via implementer log bound by SHA256, not re-executed here).**

The remedy is exactly the second remedy my F-A explicitly allowed, and the parallelism intent survives it in the bytes, not just in prose.

## 1. The diff is the allowed remedy and nothing else

`git diff f1fbe7b603..HEAD` — one file, one hunk, 5 insertions / 2 deletions, `packages/main/tests/red/red-B-e40f-lab-convergence.mjs`. The `assert.deepEqual` pin on `configRow.resources` now expects both claims:

```js
[
  { class: 'git-common-dir', key: '.', access: 'shared' },
  { class: 'fixed-path', key: '.proof-or-stop/runtime/validate-plan-barrier', access: 'exclusive' },
]
```

and the message becomes `quorum keeps internal shard parallelism while isolating its protected-root observation from other validation writers`.

`git diff 1300d7ad HEAD` on this same file is also 5 insertions / 2 deletions — so the total deliberate divergence from private main is exactly this hunk. No other drift from main was carried in under cover of the fix.

Everything my F-A said must not be weakened is byte-unchanged, confirmed by the diff being confined to that single hunk and by direct inspection:

| Element | Line | State |
|---|---|---|
| `--jobs=2` invocation of `quorum-submit-smoke.js` | 165 | unchanged |
| 73 registrations, 73 unique case IDs | 86–87 | unchanged |
| inventory mutation detector (`missing manifest case qsm-073`) | 95–96 | unchanged |
| partition mutation detector | 111 | unchanged |
| worker parallel-capability / final `B_E40F_LAB_GREEN` assertion | 218 | unchanged |

## 2. The design conflict is resolved rather than papered over

My F-A recorded a real tension: the old message (`remains missing or exclusive`) read as requiring shared-only claims for bounded parallelism, which cannot coexist with a global exclusive barrier. The new message resolves it at the correct level of abstraction — the exclusive claim is on **`.proof-or-stop/runtime/validate-plan-barrier`**, an outer root-observation barrier against *other validation writers*, while the quorum row's **internal** shard parallelism is unaffected and still runs `--jobs=2` across 4 partitions. The distinction is stated explicitly in the assertion message, satisfying my requirement that the amendment record why the `--jobs=2` intent survives.

That intent is not merely asserted, it is measured: the run reports `partitions=4 jobs=2 gain=49.9% residue=0`. (This is the guard's own internal figure and is **not** offered as a new repo-level speedup proof.)

## 3. Execution at current bytes

`node packages/main/tests/red/red-B-e40f-lab-convergence.mjs`, unmodified, in the frozen repo:

```
B_E40F_LAB_GREEN cases=73 selector=fail-closed partitions=4 fixture=isolated-reuse jobs=2 gain=49.9% residue=0
```

**exit 0**, stderr empty, working tree clean afterwards. This was the sole causal target of both F-A and F-B.

## 4. F-B — dependent closure, evidence provenance stated plainly

F-B was blocking-but-dependent: both RED rows (`NEWCOMER_MIRROR_IS_FAITHFUL`, `EVERY_TARGET_VERDICT_IS_ATTRIBUTABLE`) were mirror artefacts of F-A, with no independent defect in the derivation.

Per instruction I did **not** re-run full26. The implementer's derivation in this same frozen source has completed:

- log `../final-registration-derivation-green.log`, 12455 bytes
- `sha256 = bd643a97cb097c2231e2c8f456eb15eced968f649968222ea4e03cc77f5d577b`
- final line 58: **`0 RED / 26 GREEN of 26 rows (143198ms in child processes)`**
- both former RED rows are GREEN; `NEWCOMER_MIRROR_IS_FAITHFUL` lists all 12 pre-plant targets at exit 0, including `red-B-e40f-lab-convergence.mjs`; `EVERY_TARGET_VERDICT_IS_ATTRIBUTABLE` reports "targets that failed WITHOUT naming the newcomer: none"

This is consistent with my own independent execution of the sole causal target above, but the 26/26 result is the implementer's execution bound by hash, not mine. F-B is resolved on that basis.

## 5. Retained, reused, and out of scope

- **F-C** (closing prose of `red-b49d4` misattributing mirror artefacts) and **F-D** (`reviewer-scan-budget-guard-smoke` implicit default timeout, 300000ms vs peers' 180000ms): **retained as informational**. Neither repaired nor re-raised; neither is a blocker.
- **Reused unchanged from the prior audit** (source byte-unchanged, contracts untouched by this diff, not re-run): F2 / read-only closure, resource co-scheduling plus mutation detectors, audit supersession, capacity config, and the three sanitized-host fixture checks — all passed there and those exact bounds carry.
- **Out of this repair:** the failed identity-cutover baseline. There is **no** single current141 all-green run and **no** new speedup proof. This disposition asserts neither.

## 6. Bounds of this verdict

Confined to: (a) whether the `f1fbe7b603..HEAD` one-file change is the allowed F-A remedy with parallelism intent intact, and (b) whether F-A and its dependent F-B are thereby closed. Both are answered yes. This is **not** global merge approval, and it does not speak to the identity-cutover baseline or to any whole-suite green claim.

## Scope discipline

No source, lifecycle, main, commit, key, push, or agent touched. No full141, full73, or all25 run. No reassurance suites. Exactly one guard executed, unmodified. Writes confined to this artifact directory.

## Evidence index

| File | Contents | sha256 |
|---|---|---|
| `evidence/red-B-e40f-lab-convergence.stdout.txt` | single GREEN line | `77bd157cda7477323ac546a77a202b316aa5dbe15470d1bd89e1af335bcb178b` |
| `evidence/red-B-e40f-lab-convergence.stderr.txt` | empty | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `evidence/red-B-e40f-lab-convergence.exit` | `0` | — |
| `evidence/red-B-e40f-source.sha256` | guard source at HEAD | `f9acbaebd17a9c730b40d499b1948c9c69b475fb938523a4ff0764bcc7d8063b` |
| `evidence/full26-derivation-log.sha256` / `.bytes` / `.tail.txt` | implementer full26 log binding | `bd643a97cb097c2231e2c8f456eb15eced968f649968222ea4e03cc77f5d577b` |
