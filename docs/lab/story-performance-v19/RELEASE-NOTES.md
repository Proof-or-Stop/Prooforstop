# v0.3.317 - Main integration of the audited performance Lab

## Delivery correction

The previous v0.3.316 tag published the Lab commit without integrating it into main. This release corrects that delivery gap: the candidate starts from main `6632322aec1bda45307df35490a5a2cd53dfd748`, merges the published Lab `565e494d049e2f37ce002a3f820aaed32a1c1685`, validates in an isolated managed Lab, and uses managed finish to update local main. Remote main reachability is a prerequisite for publishing the v0.3.317 tag and release. This document does not claim publication until those operations have been verified.

## Integration and optimization scope

- Retain latest-main owner identity continuity across worktrees, including its shared Git-directory identity and new owner-lease regression coverage.
- Integrate the previously audited performance work: reuse attribution and economic controls, shared preparation within protected contexts, staged resource protection, closeout prerequisite rejection and bounded recovery, review roster consistency, and quorum scanning improvements.
- Restore the reviewed checklist executable binding so a valid inventory consumer is accepted while removal of the incoming classification guard is rejected. The same real production boundary fails on the current-main baseline and passes after integration.
- Preserve all 24 historical before-and-after comparisons below, including slowdowns, flat results, scope limitations and original evidence. These are historical measurements, not new whole-Story benchmarks.
- Keep the complete English release log in the versioned CHANGELOG and include the independent audit and Lab integration/cleanup inventory.

## Historical before-and-after comparisons (24 categories)

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

## Current integration verification

The first integration run retained 13 PASS results and two failures involving the owner smoke. The failure was ENOBUFS: repository-wide doctor JSON measured 5,496,927 bytes, exceeding spawnSync's default pipe capture. A standalone doctor exited 0. The test now captures stdout/stderr in disposable files, retains the zero-exit and identity/redaction assertions, and additionally requires complete parseable JSON. The repaired owner smoke passed. No production owner behavior or doctor error handling was weakened.

The managed main-baseline RED is an independent production defect: the valid inventory consumer is rejected by a stale checklist executable pin. Integration restores the previously audited pin; mutation of the classification guard remains rejected. No complete Story latency or universal cache speedup is claimed. Targeted post-merge checks cover incoming owner continuity and the identity boundaries touched by this merge; the unchanged full 73-case quorum is not rerun solely to regenerate historical performance claims.

## Other Lab integration and cleanup gaps

The separate LAB-INTEGRATION-AUDIT.md inventories existing Labs. A matching historical GREEN is not latest-main acceptance. Unmerged branches and dirty experiments are preserved; their unrelated functionality is not included merely because this release is called an integration. Clean Lab heads already reachable from main are removed after their local provenance and non-reproducible ignored artifacts are preserved privately. No formal Story DONE or fabricated maintenance-record transition is asserted.

## Current verification results

These are validation durations, not new performance benchmarks. The original failed runs remain recorded separately.

| Command | Exit | Seconds |
|---|---:|---:|
| `node packages/main/tests/certification-mutator-identity.mjs` | 0 | 1.835 |
| `node packages/main/tests/validation-tree-delegate-binding.mjs` | 0 | 0.793 |
| `node packages/main/dist/tasks/testintent-handoff-smoke.js` | 0 | 0.467 |
| `node packages/main/dist/tasks/story-review-ergonomics-smoke.js` | 0 | 3.130 |
| `node packages/main/dist/tasks/verification-intent-alias-smoke.js` | 0 | 0.363 |
| `node packages/main/dist/tasks/verification-freshness-smoke.js` | 0 | 40.516 |
| `node packages/main/dist/tasks/validation-evidence-reuse-smoke.js` | 0 | 109.138 |
| `node scripts/verify-runtime-fact-contract.mjs` | 0 | 9.844 |
| `node scripts/verify-process-fact-contract.mjs` | 0 | 10.626 |
| `node scripts/verify-proof-or-stop-prompt-baseline.mjs` | 0 | 9.673 |
| `node scripts/verify-performance-main-integration.mjs` | 0 | 38.208 |
| `node packages/main/tests/checklist-pin-integration.mjs` | 0 | 1.327 |
| `node packages/main/dist/tasks/story-owner-lease-smoke.js` | 0 | 24.907 |
| `node packages/main/tests/validation-reuse-economics.mjs` | 0 | 13.302 |
| `node packages/main/tests/validate-resource-claims.test.mjs` | 0 | 2.920 |

Independent final Claude CLI review is pending. Publication must wait for its disposition and managed post-merge verification.
