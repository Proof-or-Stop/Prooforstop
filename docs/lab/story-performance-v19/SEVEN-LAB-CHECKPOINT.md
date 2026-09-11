# Seven-Lab integration checkpoint

This is an incomplete integration checkpoint, not release approval.

Remote main: `6632322aec1bda45307df35490a5a2cd53dfd748`. Local main: `302fa481ef2bbb36bd20fcb405757b22bb044a71`. Candidate committed head at capture: `c2bab736f2f1f10954a7f42ee0d93a06d72955cf`; additional repairs are uncommitted.

Ancestry proves commit inclusion only. A non-ancestor can still have semantically equivalent repairs; integration tests must establish retained behavior.

| Lab | Latest source head at capture | In local main | In remote main | In candidate history |
|---|---|---|---|---|
| b03b7-validation-baseline-convergence | `3828191b2b05` | False | False | True |
| delivery-root-cause-20260911 | `1f23dabb3427` | False | False | True |
| dynamic-finding-evidence-closure | `42df0aa8e0e2` | False | False | False |
| dynamic-validation-tier-selection | `0decca4f8bfc` | False | False | True |
| lab-main-lock-scope-20260911 | `9299a7067c33` | False | False | True |
| repro-first-enforcement-0296 | `b0ab33dbdc1e` | False | False | True |
| validation-reuse-proof | `2ddf8dc2dd45` | False | False | True |

The candidate includes the earlier dynamic-finding head `a58cd309fdb319b68f2983acae124ba4dee764c4`. Its source branch subsequently advanced with new qualification/cohort RED cases and has active uncommitted fixes. The previous GREEN cannot certify that newer working tree. Preserve the source worktree and do not copy its in-flight changes.

## Targeted combined checks in this checkpoint

| Check | Before this checkpoint repair | Current measured outcome |
|---|---|---|
| Evidence-state gate | CLI-created review run used a stale disposable fixture context | Passed after binding the actual run to its fixture store |
| Validation-tier planner full smoke | Inventory digest still described the earlier command set | Passed with the explicitly added dynamic-finding suite included in the digest |
| Validation reuse proof | Missing no-context execution reason; then historical 136-command assertion | Passed, all 167 current configuration entries audited; policy, identity, failure and concurrent attribution controls passed |
| Reviewed identity inventories | Existing rows carried stale source-file hashes after integration | 54 source positives and 216 mutation refusals; 268 fixture positives and 1072 mutation refusals; 729 JSON nodes and tamper controls passed |
| Process-fact contract | Merged source contained an invalid quoted assertion | Passed after syntax repair |
| Reviewer batch | Native producer fixture lacked broker authentication | Native producer now succeeds; remaining quality PASS is rejected because incremental envelope eligibility no longer matches recomputation after main drift |

The reuse entrypoint controls executed the same 500 ms witness. Enabled: one execution, 6034.526334 ms total. Disabled: three executions, 5065.044083 ms total. This is a controlled functional proof and a negative short-task performance result, not a Story speedup.

## Remaining release blockers

- Reconcile reviewer-batch envelope eligibility expectations against the current safety contract without accepting stale PASS evidence.
- Complete the combined baseline aggregate: exact identity/context bindings, acceptance fixture dependency closure and registration derivation still require validation.
- Verify the latest dynamic-finding source changes once its active repair has a stable committed target; the old GREEN is insufficient.
- Freeze candidate, obtain final combined Claude CLI audit, record current managed GREEN and sync the newest main.
- Only then integrate main, verify the remote main commit, publish the matching tag/release, and remove verified integrated worktrees.

No main merge, remote push, tag or Release was performed by this checkpoint.
