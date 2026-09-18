# Changelog

## Lab host-activity-log-during-validation - v0.3.420 - 2026-09-18

# Lab host-activity-log-during-validation

## Problem
The Claude Code PostToolUse hook (`.claude/hooks/log-tools.cjs`, copied into every project by
`proof-or-stop init`) appended one line per tool call into the repository
(`docs/story/activity.jsonl`) even while that same worktree was running a validation. Validation
fixtures that guard the worktree against mutation observed the host's own bookkeeping: on
2026-09-17 a quorum smoke run with 73/73 cases passing was reported FAIL for exactly this reason.

## Behavior change
A line is written ONLY while the hook holds the product's own workspace validation capacity
ticket, so a validation can never overlap the write.

- The destination is resolved first and every decision is made about it rather than about the
  path that produced it. A symlinked log is refused outright (the hook never follows one), and so
  is anything that is not a plain file.
- The append itself goes through a verified descriptor: opened without following a final symlink,
  required to be a regular file with a single link (a hard link would change another repository's
  file), with the parent directory's identity captured before the open and re-checked after it,
  the descriptor confirmed to be exactly the file the path names, and the parent canonicalized
  again so an ancestor replaced by a link during admission cannot redirect the write.
- Queue holder records are opened non-blocking and no-follow and must be bounded regular files, so
  a FIFO named holder.json cannot hang the hook while it holds its own ticket.
- The destination's OWNER is established before anything is created and again before the write:
  the canonical parent must still belong to the worktree whose ticket is held (or to no repository
  at all when none is held). Containment alone is not ownership - a nested repository inside the
  same tree has its own capacity - and a destination that becomes part of a repository after
  discovery is refused rather than written without that repository's ticket.
- The repository that owns the resolved destination decides: outside every repository the line is
  appended directly; inside one it is written under that worktree's capacity ticket, published
  with the product's own protocol (announce, number, publish, admit).
- Whenever capacity cannot be held - a validation is running or arriving, a capacity record is
  unreadable, discovery is uncertain, or the destination escapes its worktree - the line is
  DROPPED. The activity log is advisory host bookkeeping (a `session_brief` freshness hint), so
  losing lines during a validation is acceptable; delaying or disturbing a validation is not.
- Git lookups ignore inherited repository-selection variables (GIT_DIR, GIT_WORK_TREE and the
  rest), and only git's "(or any of the parent directories)" wording proves a non-repository.

No durable queue is used. An earlier candidate deferred the lines into a spool and replayed them
after the validation; sixteen consecutive independent audits each found real defects in that
machinery (concurrency, symlinks, cross-filesystem migration, crash recovery, canonicalization),
because a crash-safe ordered queue is a far larger problem than the one this Lab exists to solve.
On the operator's decision that deferral was withdrawn in favor of dropping the lines. The audit
records for those rounds remain under `.git/lab-maintenance/host-activity-log-during-validation-audits/`.

## Verification
RED/GREEN: `node scripts/verify-host-activity-log-during-validation.mjs` (the real hook script,
disposable repositories and a disposable HOME).

- Before (main's hook): 25 failing expectations - two lines and three entries created inside the
  validating worktree, plus every ticket, symlink and discovery expectation.
- After: 49 checks. A live validation, one arriving during the hook's choosing window, and an
  unreadable capacity holder each keep the hook out entirely (a full recursive snapshot of the
  worktree shows no new entry at all); logging resumes once the validation ends.
- Interoperability is exercised against the PRODUCT's own `withWorkspaceValidationCapacity` in a
  competing process, in both acquisition orders and in a linked worktree: with the allocator
  holding capacity the hook writes nothing, and with the hook's ticket published first the
  allocator is not admitted until that ticket is gone.
- Destination controls: a directory symlink, an existing log symlink, a dangling log symlink, a
  two-hop symlink chain and a cross-repository hard link all refuse to touch another validating
  repository; a log symlink pointing at a FIFO does not block; a directory outside any repository
  whose `docs` points into a validating repository is refused and written only once nothing is
  validating; replacing the log or its parent with a link into a validating repository WHILE the
  hook is admitted still writes nothing there, and a swap whose directories do not exist creates
  no entry at all; a redirect into a NESTED validating repository, and a non-repository
  destination that becomes part of a validating repository after discovery, both leave that
  repository untouched; a FIFO holder record neither blocks the hook nor leaves its ticket behind.
- Discovery controls: a Git failure with no diagnostic and one naming a path ("not a git
  repository: /work/.git") are both treated as uncertain; GIT_DIR/GIT_WORK_TREE pointing at
  another repository do not redirect the decision.
- Unchanged behavior: with no ticket, a dead holder, a ticket for another worktree, or a directory
  outside any repository, the line is written immediately.

## Measured data
The 2026-09-17 quorum smoke run that motivated this Lab passed 73/73 cases and was reported FAIL
solely because of these appends. With the repair the same operator activity produces no repository
write while that worktree validates (0 entries created in the recursive snapshot), and the sibling
Lab quorum-smoke-host-activity-temp-overlap keeps its guard fail-closed, so an append during a
validation would still be a mutation if a host without this repair produced one.

Maintenance provenance: codex/lab-host-activity-log-during-validation, repair 3d694570fa37d7e48cde57632201f922cda79865.
Verification command (replayed before integration and on main): `["node","scripts/verify-host-activity-log-during-validation.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-review-read-evidence-contract - v0.3.419 - 2026-09-18

- Clarify managed reviewer prompts and provider schema descriptions: ordinary reviewers and inventory critics must actually read at least one relevant permitted file in full and report matching nonempty read evidence. Do not fabricate reading records or infer full-corpus coverage from this minimum.
- Explain that a nonblank uncertaintyReason is required only for suspected Findings and must be omitted for verified Findings or an absent evidenceState.
- Preserve all existing parser, signature, scope, receipt and independent-review requirements. Focused RED/GREEN coverage checks both prompt delivery and accepted/rejected ordinary, critic and Finding envelopes. The complete static-edge scan passes after refreshing exactly three existing dependency digests; exception commands and permissions are unchanged.
- This bounded maintenance addresses B-0980 provider-output failures; it does not mark B-0980 DONE or claim the benchmark runner is delivered. Provider results and partial cost observations are retained in [the development evidence directory](/Users/jek/Documents/Proof-or-Stop-Benchmark-Plan/b0980-ri035-review-evidence).

Maintenance provenance: codex/lab-benchmark-review-read-evidence-contract, repair f4759f22c17f210cbdeb6de4ec08de3e36bb85f0.
Verification command (replayed before integration and on main): `["node","packages/main/dist/tasks/managed-review-prompt-cwd-isolation-smoke.js"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab inventory-guard-fixture - v0.3.418 - 2026-09-18

- Preserve a mechanical check of the real caller HEAD and working tree against the merge base with local main. Existing validation commands, argv, order, timeouts, budget limits, package scripts and runner sources remain protected. Bounded additive registrations and separately gated scope paths may change; new timeout overrides cannot shadow any original command or override.
- Keep the legacy verification slot bound to that real-caller check. Separate owned Git mutations test changes, removals, reordering, duplicates, collection shape, non-script package configuration and each 120/180/300-second timeout literal. Refusals must match the intended reason in working and committed states; restored baselines pass. Missing policy branches are explicitly seeded only in owned fixtures so controls cannot be vacuous.
- Register the actual-source regression in the existing native smoke. It proves legitimate additive registration and formatting-only changes pass, while caller timeout and appended-override shadowing fail before and after commit. The nested invocation uses the already built runtime and runs the mutation suite once; per-check reads are reused. Independent audit feedback has specific observed RED/GREEN coverage.
- Refresh only unchanged reviewed source bindings. Production validation policy and original smoke budgets are unchanged. This Lab is test maintenance, not formal B-e6d9 DONE; complete native smoke and Story lifecycle evidence remain separate requirements.

Maintenance provenance: codex/lab-inventory-guard-fixture, repair 8059632d3004637036c16f631ed6b7e1d08783bc.
Verification command (replayed before integration and on main): `["node","packages/main/tests/protected-inventory-fixture.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab causal-fixture-compat - v0.3.417 - 2026-09-18

- Restore causal receipt tests against current output-storage and bounded persistence-retry contracts without changing production authority.
- Use the real receipt store for oversized selector output and exhaust both index-write retries while proving one execution and immutable receipt recovery.
- Close the isolated acceptance fixture over registered snapshot inputs; retain complete-topology assertions and add a missing-source negative control.
- Lab RED reproduced all three original failures; GREEN replays the same three original cases with the additional negative assertions. This does not claim full causal-suite or Story DONE evidence.

Maintenance provenance: codex/lab-causal-fixture-compat, repair 99a20aa833cb2d9aaf2d45e35b3b6d43a4bf55cd.
Verification command (replayed before integration and on main): `["node","-e","const{execFileSync}=require('node:child_process');execFileSync(process.execPath,['scripts/ensure-dist.mjs'],{stdio:'inherit'});execFileSync(process.execPath,['--test','--test-name-pattern=oversized output probes|injected index-write failure|verifier-owned topology and pre-review','packages/main/tests/causal-evidence.test.mjs'],{stdio:'inherit'});"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab stale-hint-extraction - v0.3.416 - 2026-09-18

- Fix stale-evidence smoke extraction to retain the complete indented hint when stale-intent rows vary.
- Keep byte-exact cross-surface assertions and exercise one, three, and fifteen stale intents, surrounding output, and altered recovery commands.
- Lab RED reproduced truncation; GREEN replays the same built focused regression. Full native Story freshness replay remains a separate acceptance requirement.

Maintenance provenance: codex/lab-stale-hint-extraction, repair e7c80f9cc153fc5405a17e4f39a507a30040e824.
Verification command (replayed before integration and on main): `["node","-e","const{execFileSync}=require('node:child_process');execFileSync(process.execPath,['scripts/ensure-dist.mjs'],{stdio:'inherit'});execFileSync(process.execPath,['packages/main/dist/tasks/verification-freshness-smoke.js','--stale-hint-extraction-only'],{stdio:'inherit'});"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab review-run-id-guidance - v0.3.415 - 2026-09-18

Pending REVIEW guidance now explicitly tells the independent reviewer to bind its finding or pass to the run ID returned by review_run_start. Canonical dispatch, distinct child IDs, exact child waits, and reviewer ownership remain unchanged.

The regression executes the actual session handler against an isolated pending REVIEW Story and checks both the existing dispatch contract and the restored returned-ID placeholder. The original flow assertions are preserved. No signature gate or production review authority changes; this Lab does not complete Story B-e6d9.

Maintenance provenance: codex/lab-review-run-id-guidance, repair 8846628a6499974cdf5cf2ba537c59be702616f9.
Verification command (replayed before integration and on main): `["node","packages/main/tests/review-run-id-guidance.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab dirty-category-init - v0.3.414 - 2026-09-18

- Fix the existing circular initialization that prevents the flow validation entry from starting: dirty-worktree reaches its eager policy through evidence freshness and the validation executor before its category constant has initialized.
- Move the unchanged category tuple into an import-free data module. Preserve the original dirty-worktree export, all category types and blocking decisions, and both eager and per-evaluation exhaustive policy checks.
- Add a regression using two fresh Node import orders, exact policy/category coverage, and a deleted-category refusal control. Record target RED and GREEN against the current built implementation.
- This local Lab repairs module initialization only; it does not certify the complete flow suite or mark B-e6d9 DONE.

Maintenance provenance: codex/lab-dirty-category-init, repair aa636eafa0957bd64b9360176e25442f81a18b6b.
Verification command (replayed before integration and on main): `["node","packages/main/tests/dirty-category-module-init.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab validation-companion-compat - v0.3.413 - 2026-09-18

- Update the validation input companion to use the current complete-capture API and require one physical execution, exact diagnostic reason, unchanged original result, and no fabricated shared receipt when context is absent.
- Check the current bounded display contract: the truncation marker is included within the configured cap. Preserve oversize non-reuse, small-output reuse, signed-receipt diagnostic exclusion, and tamper refusal.
- Add one committed runner for all seven existing companion invocations with unchanged 120-second child limits and per-invocation timings. Current-main RED reproduced both stale expectations; GREEN passed all seven in 33.045 seconds including orchestration.
- This bounded Lab changes tests only. It makes no production gate changes or performance claim and does not mark B-e6d9 DONE.

Maintenance provenance: codex/lab-validation-companion-compat, repair 4f137a1cc48c8bb75f6b1ec6a86e48dd3d7969c0.
Verification command (replayed before integration and on main): `["node","packages/main/tests/validation-companion-compat.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab verification-enum-diagnostic - v0.3.412 - 2026-09-18

- Restore the received invalid verification type in CLI enum diagnostics, so an evidence kind such as `integration_test` produces an actionable error alongside the permitted verification types.
- Preserve the accepted canonical types and legacy blackbox aliases. Bound the displayed string to 64 characters and JSON-escape it; non-string inputs remain rejected.
- Add an actual CLI regression covering six evidence-kind mistakes, legal types, aliases, bounded escaped output, and refusal before Story metadata is created. The unchanged command recorded target RED in 13.134 seconds and GREEN in 15.377 seconds, including build preparation.
- This bounded repair addresses the unchanged validation-protocol assertion encountered during B-e6d9 acceptance. It does not claim Story DONE or a performance speedup; detailed execution records remain in the B-e6d9 timing ledger.

Maintenance provenance: codex/lab-verification-enum-diagnostic, repair 99cf3461fe78c7f728b4ec8a445df119359039ce.
Verification command (replayed before integration and on main): `["node","packages/main/tests/verification-intent-enum-diagnostic.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab dynamic-selection-cost - v0.3.411 - 2026-09-18

- Enable `validate.dynamic.mode=enforce-low-risk`. The production handler now executes the selected subset for eligible low-risk inputs; signed evidence admission, catalog risk floors, mandatory full-only policy and fail-closed full fallback remain unchanged. The user requested local integration after reviewing the measured limitations.
- Add a frozen, reproducible experiment: `node scripts/lab-dynamic-selection-cost.mjs`. The original identical-harness RED/GREEN pair was `8274105adeb70c71486d4718f1fc723597206b57` / `1b3cf3ad8778aefa371902deaba94dcff749f4b3`. After closing the independent audit findings, the strengthened harness was pinned again on observe-mode target RED at `8a59f46e27`; its GREEN and prepared release are separately recorded by the Lab tool under the unchanged acceptance contract. The historical A/B/B/A sample reduced actual launches from six to two (66.7%), while mean wall time increased from 3.964 to 5.528 seconds (39.5%). Finish separately replays and records the prepared candidate; no latency improvement is claimed.
- Preserve fault detection and evidence boundaries: both modes caught the same injected arithmetic defect; missing baseline, shared-risk inventory and unmapped source changes each triggered one full fallback. An unchanged signed PASS reused evidence without launching children in both modes. Missing signatures, altered encoded signatures and payload tampering with the original signature are refused, with authentic restoration accepted. Defect controls assert the actual selected subset and authority, preventing unnoticed full fallback from passing. Frozen acceptance, selector pinning, atomic remediation with one proof for two Findings, and shared receipt publication are covered by existing regression controls. Refresh only the 22 configuration dependency digests and two unchanged resource-policy excerpt digests affected by activation; the fixed command now also requires the static-edge verifier to pass. Main passed this verifier, activation initially invalidated those exact bindings, and the bounded refresh restores it without changing exception reasons or permissions. These bounded cases do not establish population error reduction or sequential-remediation speedup.
- Disclose experiment limits in `docs/lab/dynamic-selection-cost/CONTRACT.md`: synthetic workloads and fixture-only OS-home queue isolation use real selector/executor/signing/consumer paths but synthetic causal/PRE_CERT prerequisites, not a full Story lifecycle. The inspected real catalog had 240 commands, 117 non-local risk rows and 65 full-only rows, so its existing full-catalog risk floor still forces conservative full execution. Real-repository savings remain unproven. Mechanical workloads made no model-service calls; development token costs were unavailable, not zero.
- Preserve detailed evidence at `.git/lab-maintenance/dynamic-selection-cost-measurements/REPORT.md`, raw measurements in the same directory, and the signed local Lab record at `.git/lab-maintenance/dynamic-selection-cost.json`. Build, exact candidate replay, independent different-vendor audit and post-merge replay are required by finish. This local maintenance record does not claim formal Story DONE or independent product-release evidence. No remote push is requested.

Maintenance provenance: codex/lab-dynamic-selection-cost, repair 7c7dfc059f750b1e93e940449464065fbe6f096a.
Verification command (replayed before integration and on main): `["node","scripts/lab-dynamic-selection-cost.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab changelog-compact-history - v0.3.410 - 2026-09-18

- Compact legacy CHANGELOG entries, preserving newer releases and a Git link to the complete earlier history.
- Keep future entries to 3-5 final-change bullets; read only the current entry or relevant diff and link detailed records.
- Preserve frozen-history checks: accept only the exact compact baseline with byte-verified ancestor history, while allowing normal release prepends.
- Verification: compaction controls, static-edge validation and the process-fact contract passed. The unrelated identity scan retains its existing failures; see [verification details](docs/audits/changelog-compaction.md).

Maintenance provenance: codex/lab-changelog-compact-history, repair 62e3d3aaa5855e54f8a9cf254d25127cb9f1f150.
Verification command (replayed before integration and on main): `["node","scripts/verify-changelog-compaction.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-native-hash-verifier - v0.3.409 - 2026-09-17

Restore execution of the existing independent exact-digest hash oracle when its production TypeScript import graph contains non-erasable syntax. The verifier now installs a process-local TypeScript compilation hook while preserving its existing source resolver; production source and global loaders remain unchanged. Original 27 golden digest expectations, publication/tamper checks and invalidation checks are preserved. Focused assertions also retain failed Git observation identity, observation lifetime and retry behavior for incomplete commands. The existing static child exception keeps the same caller, child and invocation while its source excerpt/digest is refreshed for the changed verifier. Target RED was the observed unsupported TypeScript syntax failure; the same command must pass GREEN and the exact candidate must pass an independent vendor audit before integration. This is local maintenance, not Story DONE or a benchmark speedup claim.

Maintenance provenance: codex/lab-benchmark-native-hash-verifier, repair 9241984ed3b5dbc58e95a8ea740459f5a7695eac.
Verification command (replayed before integration and on main): `["node","scripts/verify-hash-accuracy.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-done-recovery-branch-snapshot - v0.3.408 - 2026-09-17

Restore partial-DONE recovery when the committed Story record exists only on its unmerged Story branch. The handler now resolves its integration target from the same committed branch snapshot used by discovery, with the existing local-store fallback. Recovery probes and merges use explicit local branch refs, and the checked-out branch is identified without tag-name ambiguity. Clean-worktree, merge-feasibility and local integration safeguards remain active.

The pinned artifact release suite covers branch-only legacy-main recovery, frozen non-main recovery, same-named tags, release ledgers, cleanup and runtime version/build behavior. The original failure was recorded as target RED before the repair. GREEN and independent vendor audit must be current before integration. An additional product-capability suite passed 25 checks, and recovery scanner behavior/process-budget controls passed 22 checks. Claude audit identified a detached-HEAD diagnostic regression; the candidate now preserves checkout guidance and adds a no-merge refusal test. The complete static-edge guard passed after retaining the existing runtime contract unchanged and limiting the repair to the handler, branch reader and focused tests. A separately attempted repository runtime-fact suite still reported STATIC_AST_PARSER_OBSERVER_SOURCE_DRIFT; this unrelated result is retained, not represented as a PASS. No formal Story DONE, benchmark speedup, complete token accounting or remote release is claimed.

Maintenance provenance: codex/lab-benchmark-done-recovery-branch-snapshot, repair fffff4c36d019f4b05062535b3bd21d88ed09285.
Verification command (replayed before integration and on main): `["node","packages/main/dist/tasks/artifact-release-ledger-smoke.js"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## v0.3.407 - 2026-09-17

- Allow a temporary parent directory that contains a sibling worktree; still reject a temporary parent inside a protected root.
- Keep the mutation guard strict: observed writes inside protected roots, including activity-log appends, remain mutations. The proposed log exemption was withdrawn.
- Verify the temp-parent repair with `node scripts/verify-quorum-smoke-host-activity-temp-overlap.mjs`; host-hook logging is handled separately.

## Earlier history

Earlier entries were removed from this file at the user's request on 2026-09-18.
The complete history through v0.3.407 remains in Git:

```sh
git show a8768173bc7488aa8fdc3ef45f1ed295cbd924c8:CHANGELOG.md
```
