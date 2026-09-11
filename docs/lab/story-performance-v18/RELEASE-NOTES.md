# v0.3.316 - Performance fixes, before-and-after comparisons, and audit evidence

This version integrates Pan Qi's latest main commit `c382fe083573f8d7c88c8378380d77435977a1ae` with the accumulated performance Lab repairs. Package and CLI versions are updated together to 0.3.316 to distinguish this integration from Pan Qi's 0.3.315. Pan Qi's focused verification scope, requirement-source classification, and baseline-aware acceptance rules are preserved.

The following 24 rows translate the historical comparison table without changing its measurements or limitations. These are bounded historical experiments, not a new benchmark of the combined release. Results from different workloads must not be added. Fewer command launches do not by themselves prove lower total latency.

## What this integration improves

### 1. Keep verification proportional to the accepted work

Pan Qi's PLAN changes distinguish focused Story acceptance from repository-wide health checks. Previously, an author could turn an unrelated baseline failure into a mandatory whole-repository acceptance condition, extending repair and verification work beyond the requested change. The merged rules reject self-authored repository-wide mandatory success, require a baseline reference for a no-new-regressions comparison, and require a source reference for an explicit external absolute-pass requirement. Explicit focused scope remains focused; legacy full-suite inference is deliberately narrow.

The handoff prompt and checklist mutation handler now both require scope, expectation, and requirement-source classification for the verification-intent role. Those fields, together with baseline and requirement references, participate in routine validation identity. Changing acceptance semantics therefore invalidates incompatible reuse instead of silently accepting an older result. This improves scope control; no new end-to-end speed percentage is claimed for this merge.

### 2. Reduce repeated preparation and avoid uneconomic reuse

The retained Lab changes remove equivalent repeated Git queries and share tree observations only within a bounded observation context. Input and policy checks remain live, and publication still rejects drift. Measured cost hints choose actual execution when reuse overhead exceeds the expected benefit; hints do not authorize a PASS. The table retains both positive and negative measurements rather than claiming every cache is faster.

### 3. Reduce unnecessary serialization while protecting shared writes

Validation retains worktree protection for the whole operation and acquires shared-resource protection for the affected stages. Safe work in independent worktrees can overlap; conflicting writers remain exclusive. Incorrect declarations for nine shared writers were withdrawn. Cancellation and deadline refusal prevent child launch, and scheduler wait diagnostics are retained. The measured benefit applies to the controlled mixed workloads in the table, not the complete final inventory.

### 4. Stop avoidable closeout reruns without weakening evidence

Missing review or scope prerequisites are rejected before expensive commands start. Supported publication recovery retries publication rather than the test. Owned-write rollback preserves unrelated staging and external changes; busy errors propagate. Identity, consumption ownership, and implementation fingerprints remain required for recovery. Original PLAN evidence is retained. These are bounded recovery guarantees, not arbitrary-fault transaction semantics.

### 5. Preserve truthful results and consistent review requirements

Selector, dispatch, inventory, and quorum consumers agree on eligible reviewer lanes while unresolved findings retain the full required roster. An exit-zero JSON result that is not a semantic PASS remains a failure through coverage decoration. Certification begin and cancel reject a tampered implementation before accessing the store. Freshness fixtures now obtain the real lease, mechanical receipt, PLAN, scope, and explicit test-admission prerequisites needed to exercise their intended behavior.

### 6. Reconcile the new implementation fingerprint

Pan Qi's additional checklist metadata checks legitimately change the compiled checklist implementation. The previous executable pin rejects that change, as designed. The integration must update only the reviewed canonical digest after independent inspection, then demonstrate that legitimate operation succeeds while tampering still fails. The rejection and final controls are retained in the current evidence package.

## All 24 historical before-and-after comparisons

| Issue | Before | After | Evidence and applicability |
|---|---|---|---|
| Quorum empty selection, synchronous timeout, and cleanup hotspot | Zero checks reported success; timeout could be missed; 515 scans | Empty selection rejected; timeout recognized; 4 scans | V4. 16.719 to 11.572 minutes compares serial and parallel execution of the same candidate, not old and new code |
| Shared execution, directory inputs, and concurrent accounting | Directory EISDIR prevented reuse; the same receipt was counted as multiple executions | Complete directory binding; eligible consumers reduced from 3 launches to 1; actual executor distinguished | V10 input-tree: long task 5.204 to 3.573 seconds; short task 0.674 to 1.935 seconds, slower |
| Incorrect resource declarations | Nine shared-writing commands lost protection and overlapped | Unsafe declarations withdrawn; nine controls showed no writer overlap; independent resources remained concurrent | merge285; safety repair |
| Phased protection across worktrees | Safe stages serialized; 4.894 seconds | Safe stages overlapped while shared writers remained exclusive; 4.527 seconds | V6; three controlled mixed-list trials, not full-inventory throughput |
| Stage exceptions, lock order, and local concurrency | Publication could follow an exception; reversed lock acquisition; independent-command concurrency 1 | Exceptions prevent publication; reversed lock order rejected; independent concurrency 3 | V6; real negative and positive controls |
| Validation ran despite failed closeout prerequisites | 2 commands launched; 3.698 seconds | 0 commands launched; 0.673 seconds | V7; three trials with an artificial one-second test workload |
| Transient publication failure repeated tests | 2 test executions; 7.030 seconds | Publication retried within the same call; 1 execution; 3.644 seconds | V5; limited to declared supported failures |
| Contract, original PLAN, and acceptance ordering | Missing contract still permitted execution; later changes invalidated evidence | Missing or corrupt contract causes 0 launches; original PLAN retained; drift rejected | V4/V5/V7; not a complete automatic artifact-production scheduler |
| External writes, controlled rollback, and swallowed busy errors | Closeout risked overwriting external changes; busy errors were swallowed | Checkpoint refusal; rollback of owned writes only; busy errors propagated | Early experiments and V10 metadata; not OS-level multi-file atomicity |
| Recovery after interrupted certification consumption | Interruption after consumption prevented recovery; nested locks timed out | Recovery verifies identity and consumption ownership without consuming twice | V10 admission; includes cross-process SIGKILL and tampering controls |
| Index recovery overwrote external staging | Failure unconditionally restored the baseline | Only owned entries restored; foreign or unreadable state preserved; SHA256 controls passed | V10 index; comparison/write race window remains |
| Self-generated receipt pollution and doctor undercount | Real tests succeeded but could not publish; 1,122 files reported as 0 | One execution successfully published; 1,122 files reported accurately; scan failure explicitly unknown | V10 runtime; bounded migration does not broaden deletion scope |
| Failure exit codes and terminal events | Structured failure returned exit 0 and terminal pass | Refusal returns exit 1 and terminal fail; success retains exit 0 | V10 validation-exit; missing prerequisites still cause 0 launches |
| Legacy freshness lease, mechanical receipt, and PLAN fixtures | recover_evidence and related assertions failed | Real fixture prerequisites supplied; V16 full smoke passed in 38.13 seconds | Fixture repair, not a performance benefit |
| Signing identity bound to the wrong repository | Data written in A, signing key selected in B | Producers and consumers bind A; incorrect root, key, and tampering rejected | V11; independent processes and concurrent isolation |
| Repeated framework preparation | Repeated path handling, status queries, Git shell calls, and snapshot serialization | Equivalent repeated work removed; live input and pre-publication checks retained | V8 three-phase total 5.399 to 3.653 seconds; warm reuse 1.906 to 1.260 seconds remained expensive |
| Duplicate merge-base query per Story-input check | 2 queries | 1 query; identical hashes across five Git states | V11; no reuse across observations |
| Short tasks selected expensive reuse | Three consumers took 2.553 seconds | Negative economics selects actual execution; 1.656 seconds | V12; long task 3.775 to 3.954 seconds, no universal speedup |
| Repeated learning in a new process | Two processes took 1.924 seconds; second process used 4 probes | Non-authoritative cost hint; two processes took 1.535 seconds; 2 probes | V13; initial learning cost remains |
| Duplicate resource stage and launch after cancellation | 2 stage entries; 20 commands took 1.931 seconds; 1 launch after cancellation | 1 stage entry; 1.632 seconds; 0 launches after cancellation | V14; controlled command workload |
| Resource-wait diagnostics discarded | Wait time calculated and then discarded | Results preserve schedulerWaitMs | V14; scheduling-conflict wait only, not all lock waiting |
| Repeated dispatch before remediation | 4 extra reviewer runs; 16.675 seconds | Remediation entry uses 0 extra runs; 3.276 seconds | V7 compares workflows within the same version, not a new code repair |
| Selector, dispatch, inventory, and quorum roster disagreement | Selector required 2 lanes while other consumers required 3; open findings could permit narrowing | Closed findings permit consistent 2-lane selection; unresolved findings retain 3; missing PASS still blocks | V15 same-command time 2.892 to 3.559 seconds; correctness improvement, not speedup |
| Repeated Git-tree reads and mixed HEAD across four consumers | Tree reads [2,2,2,2]; old HEAD paired with a new Story hash | Reads [1,1,1,1]; one object per observation; next observation detects change | V16: 20 commands 3.778 to 3.658 seconds; four phases 2.506 to 2.507 seconds, effectively flat |

## Repairs verified during the previous integration

- Certification begin and cancel now verify both registered implementation identity boundaries before touching the store. Tampered implementation RED became fail-before-access GREEN; restored bytes reach the normal path.
- An exit-zero JSON result that is not a semantic PASS remains a failure during coverage decoration.
- The scope-positive fixture uses a recognized integration path. Missing scope still prevents test launch.
- Reuse fixtures obtain an explicit new synthetic admission before another actual test execution. A changed environment with a consumed admission cannot reuse the old PASS or start another test.

The previous synchronized candidate passed full freshness, full reuse, runtime-contract, and process-contract checks. Their observed runtimes were 31.090, 79.285, 7.306, and 9.244 seconds respectively. These are check durations, not Story speedup measurements. Claude CLI independently executed three bounded checks and separately approved the completed evidence and disclosure. The Pan Qi merge is validated separately below; prior passes are not substituted for current integration results.

## Pan Qi integration and current validation

The synchronized CLI reports `Proof-or-Stop 0.3.316`. The official build and all ten targeted commands passed. These timings are verification durations, not before/after performance measurements.

| Current check | Exit code | Seconds |
|---|---:|---:|
| `node packages/main/tests/certification-mutator-identity.mjs` | 0 | 1.850 |
| `node packages/main/tests/validation-tree-delegate-binding.mjs` | 0 | 0.823 |
| `node packages/main/dist/tasks/testintent-handoff-smoke.js` | 0 | 0.501 |
| `node packages/main/dist/tasks/story-review-ergonomics-smoke.js` | 0 | 3.061 |
| `node packages/main/dist/tasks/verification-intent-alias-smoke.js` | 0 | 0.344 |
| `node packages/main/dist/tasks/verification-freshness-smoke.js` | 0 | 39.967 |
| `node packages/main/dist/tasks/validation-evidence-reuse-smoke.js` | 0 | 98.234 |
| `node scripts/verify-runtime-fact-contract.mjs` | 0 | 8.844 |
| `node scripts/verify-process-fact-contract.mjs` | 0 | 10.233 |
| `node scripts/verify-proof-or-stop-prompt-baseline.mjs` | 0 | 8.448 |

An additional direct boundary test removes the new scope/expectation/requirement-source guard from a copied runtime. The reviewed checklist pin rejects that mutation; restoring the guard passes. This proves that the digest update does not disable protection.

The final candidate preserves the original Lab table and source history. The known V16 reuse-smoke assertion was explicitly carried forward in the disclosure: its earlier integration fix was revalidated by the full current smoke, which exited 0. No full quorum rerun or whole-Story performance claim is substituted for these bounded checks.

Claude CLI final review: **APPROVE**, limited to this integration, pin update, translation, and disclosure. Claude independently ran the checklist-pin mutation control, PLAN-review ergonomics smoke, and English evidence-package verifier; all exited 0. The full freshness and reuse smoke results above are separately recorded executions, not claimed as independently rerun by Claude.

## Remaining limitations

| Area | What has not been established |
|---|---|
| Complete Story net latency | No equivalent-workload, complete-lifecycle before/after benchmark including the cost of new regressions |
| Long-term review convergence | Correct rosters and fixed-batch replay do not prove convergence for every historical multi-round Story |
| Complete dual-worktree throughput | No final full-command-inventory throughput, worst-case waiting, and conflict comparison |
| Short-command reuse economics | Avoiding an uneconomic path does not prove that reuse is faster for every short command |
| Complete closeout scheduling and arbitrary recovery | Guarantees cover declared, tested failures; not arbitrary external writes or OS-level multi-file atomicity |
| Historical reuse-smoke assertion | V16 failed before and after the repair because refusal returned exit 1 while the fixture expected exit 0. The previous Lab integration repaired the fixture and later semantic failure, then passed the full smoke. The complete downstream smoke must be rerun after this Pan Qi merge; the full current smoke passed as recorded in the integration results |
| Formal completion | Lab evidence is not formal Story DONE or signed product acceptance; no universal performance claim is made |

## Evidence

Original historical artifacts remain unchanged for provenance. This release log is an English translation, not a rewrite of historical measurements. The previous Lab release is superseded by this integrated version. Current verification logs, independent audit, translation checks, and archive checksums are supplied with the release.


## Downloadable release evidence

- `v0.3.316-current-evidence.zip`: detailed English log, all 24 comparisons, current verification output, independent audit, and the release verifier.
- `v0.3.316-historical-evidence.zip`: 1,960 unchanged historical reports and logs with per-file SHA-256 manifests. Raw records retain their original language for provenance.
- `v0.3.316-package-verification.json`: archive hashes and extraction, measurement-change, language, and tampering controls.

This release includes Pan Qi main commit `c382fe083573f8d7c88c8378380d77435977a1ae` as an ancestor. It supersedes v0.3.315-lab.1. No published tag was moved, no global installation was changed, and no formal Story completion is asserted.
