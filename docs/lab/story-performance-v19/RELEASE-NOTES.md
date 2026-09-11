# v0.3.318 - Seven Lab integrations and 24 historical repair comparisons

## Release binding

The independently audited implementation is `d7f6669c6aa0e62ee58b3d9cf8d5c7ab96f472d6`. Both latest-main maintenance lines are included. The release pipeline adds synchronized version metadata and the final log, verifies local main, and checks remote main/tag equality before publishing. The exact published commit and cleanup outcome are recorded in the Release assets; the implementation-audit SHA is intentionally distinct from that later release commit.

## What is integrated

The candidate preserves the previous performance Lab commit 565e494d049e2f37ce002a3f820aaed32a1c1685, all seven selected Lab heads, and both newer main maintenance lines: owner continuity, external worktree/Go pre-review support, and Dynamic Finding evidence closure. The previous v0.3.316 tag did not deliver that performance commit through main; final publication must prove main contains the candidate before creating the tag.

| Lab | Integrated behavior | Verification scope |
| --- | --- | --- |
| b03b7-validation-baseline-convergence | Current compatibility fixtures and exact identity/loader obligations remain mechanically enforced | Claude independently replayed the whole nine-part aggregate: all nine parts PASS |
| delivery-root-cause-20260911 | Delivery review inventory and next-action consistency | Real inventory next-action integration passes |
| dynamic-finding-evidence-closure | Qualification prerequisites, evidence closure, protected repair obligations, historical witnesses, and partial diagnostics | Full Dynamic Finding package chain passes; this does not grant real operational qualification or activate enforce |
| dynamic-validation-tier-selection | Story-aware validation selection and conservative widening | Focused Lab test and full planner smoke pass with the actual updated command inventory |
| lab-main-lock-scope-20260911 | Bound main-lock occupancy for Lab operations | Lock-scope integration passes |
| repro-first-enforcement-0296 | Mechanically require applicable reproduction evidence before repair | Complete registered evidence-binding/DEV-gate chain passes |
| validation-reuse-proof | Attribute actual execution and safe consumer reuse independently | Real child executions, receipts, policy/identity negatives, concurrent attribution, and all 168 configured consumers pass |

## Repairs required by this integration

| Observed failure | Change | Result and limits |
| --- | --- | --- |
| Moving main invalidated a first-review envelope although its historical Story input had not changed | Sign the exact full-Story comparison commit and use it during replay; leave live freshness checks active | Original reviewer-batch expectations pass; bounded overflow, missing object, invalid ref, tamper, and real source-drift controls pass. Claude independently approved the bounded repair |
| Native review fixtures did not establish current broker-owned context | Produce the fixture through the current CLI instead of relaxing expected lane states | Original quality/scope and blocking-Finding expectations retained |
| Registration proof did not follow the six Dynamic Finding package leaves | Verify the exact package-script chain, preserve 10 mutation classes per leaf, and test semantic F031 mutants with their own mutated source digest | Actual guard passes; all 26 registration derivation rows pass. Accounted-for exclusions are not claimed to be executed tests |
| Nested registration mirror omitted the newly consumed package manifest | Copy the real package manifest into both positive and removal-mutant fixtures | Bootstrap reader control, removed-registration refusal, and full derivation pass |
| Old whole-file witnesses became stale while their exact negative contexts stayed unchanged | Rebind reviewed counts/contexts and paired loader fingerprints; add classification context mutation coverage | Source/emitted identity-site and identity-inventory groups pass; comprehensive identity self-test passes. No blanket file exemption was introduced |
| New main added one validation command | Account for that exact command and update the command-set digest | 168 validate plus DONE-required inventory entries audited; full tier planner passes |
| New Go-profile test lacked an installed Go executable | Supply a checksum-verified isolated official Go toolchain for the test | Same unmodified regression passes. This was an environment failure, not a claimed product RED; no toolchain identity check was disabled |

## Performance interpretation

The historical 24 rows below are retained verbatim. They are bounded historical experiments, not new end-to-end benchmarks. The current 500 ms reuse witness still demonstrates a cost inversion: one execution with reuse took 7.965 s versus three direct executions taking 6.074 s in this verification run. Other verification was active, so these timings are diagnostic observations, not isolated performance estimates. Fewer launches do not establish lower latency, and default policies were not weakened to manufacture a benefit.

Whole-Story net speed, long-term review convergence, complete dual-worktree throughput, and arbitrary recovery are not proved by this integration. The prior first-review audit also reproduced pre-existing full-suite ABA/guard-map fixture failures on an overlay without the repair. The separate global static-edge inventory has baseline obligations beyond these seven scoped Lab regressions. No claim of an entirely green repository or formal Story DONE is made.

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


## Evidence and reproduction

The seven-Lab selected commit inventory and raw before/after logs are in `docs/lab/story-performance-v19/evidence/seven-lab-integration/`. Historical evidence remains in the v18 and earlier v19 archives. The Go regression requires a resolvable `go` executable on PATH; the isolated test used the official go1.24.7 darwin-arm64 archive after SHA256 verification. Toolchain binaries and private backups are not included in release evidence.

Claude approved the frozen integration and independently executed all nine requested commands with exit 0. Managed GREEN also passed. Post-main validation, remote reachability, tag equality, and cleanup are release-publication checks recorded separately. Source worktrees with new or unmerged work are retained.

## Explicit behavior and validation boundaries

A strong `not_reproduced_under_current_witness` assessment may now release the transient high assessment-integrity floor. It does not release claimed-deferral lineage or an active mandatory-repair obligation. Adjacent missing/expired proof cases still block, and this integration does not activate enforce mode or claim operational qualification.

The baseline-convergence aggregate is deliberately invoked for this release and independently by Claude. Its registration exclusion does not mean ordinary `validate` executes that aggregate automatically. Its component checks retain their own registrations.

The core release version is synchronized across root/main manifests, their lockfiles, the CLI brand, and embedded core lock records in extension packages. Extension package versions remain independent by the existing version-bump contract; `packages/utils` remains 0.3.268 intentionally.
