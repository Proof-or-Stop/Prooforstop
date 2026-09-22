# Changelog

## Lab benchmark-reviewer-parallel-barrier - v0.3.450 - 2026-09-22

- Make `reviewer_batch` return an explicit child-id barrier so every launchable REVIEW lane starts before the controller waits once on the complete nonempty ID set.
- Handle the zero-lane case with an explicit no-wait policy while keeping lane selection, gate readiness, signed evidence, and the read-only authority boundary unchanged.
- Align JSON lifecycle hints, CLI help, process facts, and agent guidance; refresh the reviewed U18 dependency digest for the expanded regression.
- Focused RED/GREEN, U18 static-edge verification, command-catalog checks, prompt contracts, and independent Grok audit all pass.

Maintenance provenance: codex/lab-benchmark-reviewer-parallel-barrier, repair 214f20557b5c8f2a94678d5d31c48612c285d1dd.
Verification command (replayed before integration and on main): `["node","packages/main/dist/tasks/reviewer-batch-smoke.js"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab inventory-critic-head-parity - v0.3.449 - 2026-09-22

- Preserve required-lane ReviewRuns, Findings, and passes in the inventory critic evidence pack when only Git HEAD changed through Story metadata commits.
- Align the critic projection with inventory-wave materialHash and storyFilesHash admission while retaining signed per-run headHash for inspection.
- Add a focused RED/GREEN regression and process-fact/static-edge contract coverage.
- Focused projection and static AST parity pass. The broader process-fact verifier still hits the same pre-existing managed supersession fixture failure reproduced unchanged on main.

Maintenance provenance: codex/lab-inventory-critic-head-parity, repair 1b44d8ebe2b931331da857c176ea1fdfbb324232.
Verification command (replayed before integration and on main): `["node","packages/main/dist/tasks/inventory-critic-live-metadata-projection-smoke.js"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab managed-worker-claim-pressure - v0.3.448 - 2026-09-22

Problem: Four concurrent managed reviewers can cold-start slowly enough that the production five-second worker claim window expires. PoS then records `worker_claim_timeout` while the worker PID is still alive, correctly marks the terminal `replacementSafe=false`, and leaves REVIEW without a safe automatic retry path.

Fix: Register a 30-second worker claim budget in `MANAGED_SUPERVISOR_RUNTIME_POLICY` and make managed submission consume that policy. Explicit test timeouts remain unchanged, so the existing never-claims and terminal-fence controls stay strict.

Verification: The focused Lab fixture failed on the old default after a healthy six-second delayed claim and passes on the repair with `MANAGED_WORKER_CLAIM_PRESSURE_GREEN`. Static AST reuse verification passes with refreshed exact source digests. The runtime-fact verifier reaches the new assertions; its remaining failures are reproducible on clean main or caused by the isolated worktree dependency layout. Grok independently audited the exact committed candidate and returned pass with no findings; its conclusion was checked against the source and focused run.

Measured effect: The healthy claim allowance increases from 5 seconds to 30 seconds under cold-start pressure. Normal reviewers that claim earlier return immediately; only genuinely unclaimed workers can extend the submit wait to the existing 30-second status bound.

Maintenance provenance: codex/lab-managed-worker-claim-pressure, repair f0475da17386caaa8bd025b3c66636c47ba00979.
Verification command (replayed before integration and on main): `["node","packages/main/dist/tasks/managed-worker-claim-pressure-smoke.js"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab managed-critic-projection-admission - v0.3.447 - 2026-09-22

- Route managed inventory critic material checks through the current Story's signed controller-projection admission.
- Preserve fail-closed rejection for wrong-Story receipts, byte-different projections, and ordinary untracked material.
- Add a focused real linked-worktree projection fixture and bind the handler call path in the process-fact verifier.
- Refresh the reviewed U18 static-edge evidence after the verifier and handler changes.

Maintenance provenance: codex/lab-managed-critic-projection-admission, repair 062cfe20f46a815381b77b3d287594a80dfc2a45.
Verification command (replayed before integration and on main): `["node","scripts/verify-managed-critic-projection-admission.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-review-convergence - v0.3.446 - 2026-09-22

- Authenticate managed inventory critic imports against the sealed model and reasoning-effort binding.
- Seed a new review inventory from already-terminal required lanes on the exact current round and material cutoff, avoiding forced duplicate reviews.
- Admit only signed, byte-identical current-Story controller projections during REVIEW remediation cleanliness checks.
- Add regression coverage and refresh the reviewed U18 static-edge evidence ledger.

Maintenance provenance: codex/lab-benchmark-review-convergence, repair 3270fa6c8438d8da315d354d190e98ca82272322.
Verification command (replayed before integration and on main): `["node","scripts/verify-managed-inventory-critic-import.mjs","--case=pass"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab managed-review-routing-preflight - v0.3.445 - 2026-09-21

- Refuse formal managed-review provider launches when candidate routing still requires an unresolved full-scan escalation, and return the exact owner recovery command before any provider cost is incurred.
- Strengthen the final-proposal protocol to require standard JSON serialization and explicitly reject non-JSON backslash-apostrophe escapes while retaining fail-closed terminal validation.
- Add executable regression coverage for unresolved and resolved candidate routing, plus process-fact registry and U18 static-edge bindings.
- Verified with Lab RED/GREEN, the managed-review candidate preflight test, package build, U18 static validation, diff checks, and independent Grok review. The unrelated managed-review supersession fixture baseline remains outside this repair.

Maintenance provenance: codex/lab-managed-review-routing-preflight, repair ae4bd8db4205ff8fc0ebaf81b924764a413391ac.
Verification command (replayed before integration and on main): `["node","packages/main/tests/managed-review-candidate-preflight.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab consumer-residue-preflight - v0.3.444 - 2026-09-21

- Scope the `proof-or-stop-residue` REVIEW preflight to repositories that explicitly enable `reviewPreflight.proofOrStopResidue`; consumer repositories now report the PoS-only maintenance gate as skipped.
- Keep the Proof-or-Stop source repository opted in, and fail closed for malformed policy shapes, invalid JSON, a missing maintenance script, timeouts, or non-zero detector results.
- Extend the wrapper-root preflight smoke to cover consumer skip, explicit opt-in, script pass/fail, malformed objects, and malformed project JSON.
- Verified the focused RED/GREEN replay, package build, process-fact wiring, and an independent Grok audit; the unrelated managed-review supersession baseline failure remains outside this repair.

Maintenance provenance: codex/lab-consumer-residue-preflight, repair 2252b35771429418f88b8700d005b6994b33fb4a.
Verification command (replayed before integration and on main): `["node","packages/main/dist/tasks/docs-drift-wrapper-root-smoke.js"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab tracked-controller-projection-remediation - v0.3.443 - 2026-09-21

- Allow a signed, byte-identical controller runtime projection to remain valid after the controller or Story branch adopts the projected assets into Git.
- Preserve Story branch binding, regular-file and symlink safety, byte equality, signed common and Story receipts, plus ordinary dirty and scope enforcement for candidate-side changes.
- Keep controller config projection receipts trusted after controller-side Git adoption so scope enforcement and reviewer admission agree.
- Verified with the external linked-worktree Go pre-review smoke, tracked-controller bootstrap safety regression, package build, and independent Grok review; the broader process-fact verifier remains blocked by its unrelated managed-review supersession fixture provider failure.

Maintenance provenance: codex/lab-tracked-controller-projection-remediation, repair a2ea80bec66fbddd7bbc0d77642f43e49a2139ab.
Verification command (replayed before integration and on main): `["node","scripts/verify-external-worktree-go-pre-review.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab managed-finding-repair-dispatch - v0.3.442 - 2026-09-21

- Add a DEV managed-dispatch path for `proof-or-stop-finding-repair` with one canonical open Finding target.
- Seal Story, role, Finding ID, and provider output into the managed run binding and terminal receipt for controller verification.
- Reject missing, mixed, unknown, closed, wrong-phase, and cross-Finding repair targets before they can authorize resolution.
- Cover the repair path with Lab RED/GREEN regression evidence and preserve the existing managed implementer contract.

Maintenance provenance: codex/lab-managed-finding-repair-dispatch, repair 96504c2388f23a2a1c40cb2f92fa82263ee07e04.
Verification command (replayed before integration and on main): `["node","packages/main/tests/managed-finding-repair-dispatch.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab managed-review-projection-dirty-admission - v0.3.441 - 2026-09-21

# Managed review controller projection dirty admission

- Problem: managed inventory-critic receipt import treated exact controller-projected config and Codex hook files as candidate material drift, even though signed Story-bound projection receipts and byte identity already admitted the same files as framework control artifacts. This deadlocked REVIEW in externally provisioned Story worktrees.
- Fix: `readMaterialDirtyFiles` accepts an opt-in Story id and excludes only `??` untracked controller projections that pass the existing signed receipt, exact branch, regular-file, untracked, and byte-identity checks. Only managed inventory-critic import enables this option; all other evidence freshness callers retain strict behavior.
- Regression protection: the benchmark framework hardening smoke covers the exact four-file projection set, wrong Story, unrelated dirt, byte tamper, missing receipt, hook tamper, and forced index tracking of both config and hook projections. The process-fact contract pins the new producer and consumer plus the explicit untracked-only gate.
- Verification: `npm --prefix packages/main run build` and `npm run test:benchmark-framework-hardening` passed on candidate `8bd8bd8f4445b351dd528967e7a635b6d4f7f60d`. A different-vendor Grok Lab audit passed after one concrete finding was independently checked and converted into defense-in-depth status gating and staged-file tests.
- Performance: no production timing change was targeted; the added work is bounded to the small dirty path set during managed inventory-critic import.

Maintenance provenance: codex/lab-managed-review-projection-dirty-admission, repair e9f6947ed11550fe22e6b86fe26f2ad49f2e2c10.
Verification command (replayed before integration and on main): `["npm","run","test:benchmark-framework-hardening"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab managed-scope-owner-annotation-seal - v0.3.440 - 2026-09-21

- Keep managed scope reviewer evidence valid when the Story owner resolves an open question after a current managed reviewer run.
- Seal a version-prefixed canonical reviewer projection while storing owner resolution text, timestamps, and citations in a separate overlay.
- Preserve old byte-sealed receipts only while the scope file remains byte-exact and unannotated; owner resolution under an old receipt requires a fresh managed review.
- Add RED/GREEN coverage for legal owner annotation, exact legacy handling, digest-grammar separation, Story review continuity, and reviewer-field tamper rejection.
- Verified with the managed scope E2E, managed delivery regressions, package build, U18 static closure, and an independent Grok audit.

Maintenance provenance: codex/lab-managed-scope-owner-annotation-seal, repair 30049af80c2cf1eba86225a1c1357591886f96f7.
Verification command (replayed before integration and on main): `["node","packages/main/tests/managed-scope-reviewer-dispatch-e2e.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab worker-authority-integration-target - v0.3.439 - 2026-09-21

- Resolve normal-channel commit attribution from the Story's frozen integration target instead of assuming a `main` branch.
- Require an explicit or resolved integration branch on every path and report unresolved baselines separately from invalid implementation-worker evidence.
- Add master-only and unresolved-baseline regressions to both the focused Lab command and the default flow smoke.
- Refresh the reviewed static-edge source bindings and verify the static exception closure after the test changes.
- Verified package build, focused Lab RED/GREEN and U18 static edges; broader suites retain unrelated pre-existing fixture failures.

Maintenance provenance: codex/lab-worker-authority-integration-target, repair f5641505a8cfbf35bd0480f531454668544b8cd6.
Verification command (replayed before integration and on main): `["node","packages/main/dist/tasks/flow-stability-smoke.js","--worker-authority-master"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab integrated-validation-review-and-release-reconciliation - v0.3.438 - 2026-09-21

- Integrate the complete local validation, provider-quota, verdict-stickiness, review-rework and audit-snapshot repair line with Pan Qi's managed implementation, finding-repair, review-launch and verifier-identity line; both pre-merge heads remain ancestors of this release.
- Correct twelve unpublished local commits from the unintended Harmony identity to `Harmonynet <26995688+Harmonynet@users.noreply.github.com>` without changing their trees, messages, dates or merge topology; retain Pan Qi's independent authorship unchanged.
- Preserve sticky failure verdicts, identity-bound evidence reuse, one shared provider-call quota, bounded review inventory and audit snapshot inputs, cross-wave finding identity, and precise verifier drift diagnostics.
- Restore executable managed review recovery, item-bound implementer completion, native finding-repair launch contracts, signed receipts, owner-lease enforcement, retry safety, rollback safety and fail-closed completion behavior.
- Reconcile the combined prompt baselines, process/runtime registries, canonical UTF-8 static evidence and all package/version surfaces at `0.3.438`; detailed evidence remains in the linked Lab records below.

## Lab audit-snapshot-input-budget - v0.3.437 - 2026-09-21

- Separate complete local audit snapshot input (64 MiB) from the unchanged 8 MiB provider output limit; preserve snapshot references, exact digests and independent-vendor approval.
- Reject oversized aggregate inputs, oversized individual sources, binary data and invalid UTF-8; retain snapshot tamper refusal and the compact initial prompt.
- Verify the coupled-budget RED and repaired GREEN, existing audit contract and prompt controls, and static dependency evidence. See `docs/lab-maintenance.md` for the bounded transport contract.

Maintenance provenance: codex/lab-audit-snapshot-input-budget, repair e6936f7e6bbdbd31de79e613fb565c4b912a05a4.
Verification command (replayed before integration and on main): `["node","scripts/verify-lab-audit-input-budget.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab review-rework - v0.3.436 - 2026-09-21

- Restore incremental review inventory reads for large Git outputs using the registered transport limit; preserve full-roster refusal and precise diagnostics when inventory or dirty-state reads fail.
- Bind cross-wave duplicate Findings to signed canonical observations in the same frozen review epoch, retaining original open Findings and all evidence, quorum and independent-review requirements.
- Bound dependency analysis by source count, bytes and a cooperative deadline, reuse per-call module resolution, and show bounded CLI path samples with separate observation and problem-family counts.
- Verify real RED-to-GREEN inventory and duplicate controls, native selector-to-consumer behavior, negative controls and registered contracts; document existing repository-wide failures separately. See [maintenance details and execution evidence](docs/review-rework-maintenance.md). This repair does not claim measured reductions in live Story review rounds.

Maintenance provenance: codex/lab-review-rework, repair 81bc1610c3bca5f2b89023b0c9e3b43f39009819.
Verification command (replayed before integration and on main): `["node","scripts/verify-review-rework.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab validation-verdict-stickiness - v0.3.435 - 2026-09-21

- Fail is sticky: an executed validation failure recorded on an identity (command set, committed material, story files, compiled artifacts) makes any PASS on that identical identity a flipped verdict. Routine reuse (`verdict-flip-unattested`), evidence admission and the DONE-side consumer (`verdict_flip_unattested`) and both publications, executed and reused (`verdict_flip_refused`), refuse it. Changing the material or the build releases it; there is no override.
- Failing `validation_terminal` events record a `failureKind` derived from the executor's command outcomes: infrastructure only when infrastructure is all that failed, `coverage_incomplete` when the required commands passed and only required coverage was missing, a verdict otherwise. Infrastructure and coverage-only failures, reused terminals and terminals from before the artifact binding do not stick.
- Every recorded run carries its full identity: a Story run whose routine identity cannot be built is refused before launch (`validation_identity_unavailable`), the material and story files are identified before launch so a later lookup failure cannot drop an executed verdict, a failure is bound as completely as a PASS, and the terminal records the identity its publication validated. Only a confirmed absence is an empty history; anything unreadable or malformed fails closed.
- `done_prepare` again trusts the reused terminal the verifier appends (its allowlist had not followed the 0.3.427 artifact binding); the fields are typed and bound, and the reuse path now writes them.
- `scripts/report-validation-verdict-flips.mjs` (read-only) measures re-executions and flips; the recorded history (928 terminals, 97 Stories) shows 26 identities where a failure was followed by an executed pass and 44 by a reused pass. Two registered commands cover the rule: `scripts/verify-validation-verdict-stickiness.mjs` (96 checks) and `scripts/verify-validation-verdict-stickiness-cli.mjs` (end to end through the built CLI on fixture projects). How a validate file's printed output becomes a verdict is unchanged and out of scope. Audit history, comparison against main and limitations: [the Lab record](docs/lab/validation-verdict-stickiness.md).

Maintenance provenance: codex/lab-validation-verdict-stickiness, repair f9753d83694c8fc331d7b48984ee3ba9da7e4737.
Verification command (replayed before integration and on main): `["node","scripts/verify-validation-verdict-stickiness.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab shared-call-quota-rg - v0.3.434 - 2026-09-20

- Enforce one explicit cumulative provider invocation quota across host runs, managed workers, plans, repairs, standalone reviews, bounded adapters and custom audits.
- Preserve submitted quotas across worker environment loss, record armed retry allowances, and retain structured refusal results with final accounting; reference-mode prompts use their full byte size and parent-only quota context stays out of worker payloads.
- Reproduce five quota bypasses with RED/GREEN: an allowance of two now stops routes previously reaching three or four calls; preserve positive and adversarial regression coverage.
- Document invocation-count boundaries and separate existing repository-health failures from quota acceptance; see [the Lab evidence and verification guide](docs/lab/shared-provider-call-quota.md).

Maintenance provenance: codex/lab-shared-call-quota-rg, repair 9b2205ce30c2e0b4df853dd3d0775576937ad361.
Verification command (replayed before integration and on main): `["node","scripts/verify-shared-provider-quota.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab validation-manifest-encoding-20260920 - v0.3.433 - 2026-09-20

- Restore the static evidence manifest's canonical ASCII JSON encoding required by the existing Lab version transaction, preserving every parsed value and evidence obligation.
- Reproduce the real transaction rejection on main's prior encoding and verify a real patch-version transaction succeeds on a disposable copy after normalization.
- Keep the encoding repair separate so the remaining validation audit can fit the existing bounded independent-audit input contract.
- Local Lab maintenance only; original validation closeout evidence remains separately recorded.

Maintenance provenance: codex/lab-validation-manifest-encoding-20260920, repair 2a745af390121080d5a7a7164d25f2e12cd1c6a0.
Verification command (replayed before integration and on main): `["node","/Users/jek/Documents/GitHub/Prooforstop/.git/lab-evidence-archives/validation-audit-20260918/remaining-performance-20260918/finish/original-closeout/verify-manifest-encoding.mjs"]`.
## Lab verifier-identity-drift-diagnostic - v0.3.437 - 2026-09-21

- Report verifier receipt staleness with the exact changed execution component, distinguishing environment, toolchain, and dependency-input drift.
- Keep strict freshness unchanged: behavior-affecting environment or toolchain changes still require a real rerun, while a missing dependency manifest only limits reuse.
- Add a focused F057 entry point and regression assertions covering both environment and toolchain drift diagnostics.
- Verified with the Lab RED/GREEN replay and the package build; the corrected benchmark invocation must preserve `CONTEXT=abs` across evidence and lifecycle checks.

Maintenance provenance: codex/lab-verifier-identity-drift-diagnostic, repair d2ce4a97630b43a3b6badd05212f15a7624b6086.
Verification command (replayed before integration and on main): `["node","packages/main/dist/tasks/verification-run-and-guard-smoke.js","--baa5f-live-identity-drift"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab review-managed-launch-guidance - v0.3.436 - 2026-09-20

- Keep REVIEW lanes outside `managedDispatch` and direct unsupported REVIEW calls to the signed `candidate_spec_route -> review_run_start -> managedReview` evidence flow.
- Add complete executable Grok and qualified Codex managed-review command choices to `reviewer_batch`, retaining only the ReviewRun id as a prior-step placeholder.
- Preserve the existing missing-`storyId` repair for allowlisted INIT, PLAN scope, and TEST delivery roles while prioritizing the REVIEW recovery error over irrelevant model qualification.
- Verify the reported DeepSeek REVIEW-lane call, public `review_run_start.agent` parsing, generated host arguments, INIT managed dispatch, and reviewer-batch integration; independent Grok audit passed after manual finding verification.

Maintenance provenance: codex/lab-review-managed-launch-guidance, repair ab73ae12637e0ae36a3679eee3b78037fe30cc0b.
Verification command (replayed before integration and on main): `["node","packages/main/tests/managed-init-reviewer-dispatch.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab finding-repair-launch-contract - v0.3.435 - 2026-09-20

- Require controllers to launch native repair tasks and obtain a nonempty task identity before waiting; missing workers leave findings open.
- Keep finding repair workers read-only for blocker state, return committed repair evidence to the Story owner, and allow the owner to resolve verified findings from DEV.
- Preserve the structured launch contract through real CLI JSON output for both individual and clustered repairs.
- Keep cluster commit markers inert until owner-gated validation consumes them; read-only finding inspection never writes resolution state.
- Verified with the registered RED/GREEN smoke, real CLI dispatch and finding resolution, cluster validation entrypoint coverage, command ownership checks, prompt baselines, and U18 static-edge checks. No performance optimization was part of this repair.

Maintenance provenance: codex/lab-finding-repair-launch-contract, repair 7940f7f25f732fc6d959fdfaf8dadfbe56630064.
Verification command (replayed before integration and on main): `["node","packages/main/dist/tasks/agent-dispatch-registry-smoke.js"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab managed-implementer-done-only-guidance - v0.3.434 - 2026-09-20

- Align the managed implementer prompt with its item-bound, done-only lifecycle capability.
- Keep accidental `in_progress` refusals non-consuming and return a recovery hint that directs the worker to continue and complete the exact item.
- Extend the managed dispatch regression to prove refusal, capability retention, exact completion, and run-bound evidence.
- Refresh the prompt-policy and static-edge baselines for the reviewed contract.
- Preserve canonical UTF-8 static evidence during Lab patch-version transactions so release preparation remains reachable.

Maintenance provenance: codex/lab-managed-implementer-done-only-guidance, repair a32c130a2e040ed4ace38407ae25120840a235c7.
Verification command (replayed before integration and on main): `["npm","run","test:managed-implementer-dispatch"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab managed-implementer-item-capability - v0.3.431 - 2026-09-20

Problem: A controller-owned managed implementer runs in a child logical session. Its exact checklist completion was rejected by the Story owner lease, so host_run reported managed_dispatch_output_missing even after implementation succeeded.

Fix: Add a narrow owner-lease admission for checklist_update status=done when the caller is the registered implementer and presents the exact live Story/item managed-dispatch capability. Share the schema-filtered completion payload check between the CLI gate and handler, revalidate before persistence, bind the subagent_result to the run, and consume the one-shot invocation only after the checklist/event write succeeds. The repair does not transfer the owner lease or authorize in-progress, metadata, other-item, phase, takeover, replay, or failed-result mutations.

Verification: npm run test:managed-implementer-dispatch passes with the original owner/child deadlock reproduction plus exact completion, schema-filtered json metadata, takeover metadata refusal, wrong item, spoofed actor outside the provider process group, replay, failed-result retry, and event-write rollback cases. U18_STATIC_PASS reports needsReview=0. npm run test:process-fact-contract -- --quiet passes, including certification recovery and managed delivery contracts. Independent Grok audit passed after the factual CLI schema path was proven directly.

Measured optimization: Not a performance change. The normal managed implementer can now finish its assigned item without human forceTakeover or a second owner session.

Maintenance provenance: codex/lab-managed-implementer-item-capability, repair 40d56bc64a04c7261c57a72120fde065081e816d.
Verification command (replayed before integration and on main): `["npm","run","test:managed-implementer-dispatch"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab integrated-validation-and-managed-implementation - v0.3.433 - 2026-09-20

- Integrate the complete local `0.3.429` through `0.3.432` repair history with Pan Qi's remote `0.3.429` and `0.3.430` managed-worker and managed-implementer history; both pre-merge heads remain ancestors of this release.
- Enforce provider budgets, shared invocation accounting, 260-second production validation limits, intent-bound evidence reuse, and current prompt-reference baselines with focused RED/GREEN verification.
- Require canonical implementation-worker authority and add managed checklist implementation dispatch whose signed completion remains bound across retries, transport loss, rollback, and unmanaged completion probes.
- Preserve fail-closed behavior for invalid evidence groups, stale prompt authority, missing implementation receipts, incomplete managed completion, duplicate execution, unknown usage, and unsafe mixed-Story refresh advice.
- Reconcile the combined validation registry, static-edge evidence, package metadata, and CLI version at `0.3.433`; detailed component evidence remains in [host-run budgets](docs/host-run-shared-budget.md), [intent fingerprinting](docs/requirements/decisions/verification-execution-receipt-fanout-and-input-scoped-freshness.md), and [managed host usage](docs/host-run-usage.md).

## Lab validation-prompt-baseline-split-20260920 - v0.3.432 - 2026-09-20

- Repair prompt validation that rejected current canonical role bodies because its approval hashes, role matrix, and measurement baseline were stale.
- Remove nine unused Story-reference allowances; retain four exact current references and require each to occur once during collection and verification. Missing, duplicate, altered, stale, and cross-role authority are rejected.
- Preserve the full 18-role approval checks, CLI-only Story policy, real prompt mutation controls, and current delivery-transcript read while refusing the retired product-reviewer read.
- Record target RED and replay the full prompt-baseline suite, actual u18 static verifier, and built CLI version check before integration and on main. See [the baseline](docs/requirements/baselines/proof-or-stop-prompt-baseline.json) for the current role contract.
- Split this bounded repair from the retained validation audit to fit the existing audit-input limit. The unrelated source-binding failure matches main 0f823c4475 exactly and remains owned by validation-audit-20260918; this is local Lab maintenance, not Story DONE.

Maintenance provenance: codex/lab-validation-prompt-baseline-split-20260920, repair 929f018e604c5c6455bceed6bcd3698a0a985dfa.
Verification command (replayed before integration and on main): `["node","/Users/jek/Documents/GitHub/Prooforstop/.git/lab-evidence-archives/validation-audit-20260918/remaining-performance-20260918/finish/original-closeout/prompt-baseline-split/verify-final.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab intent-fingerprint-reuse - v0.3.431 - 2026-09-20

- Derive per-execution, per-intent and aggregate fingerprints from each Story's actual verification intents, displaying original descriptions and item-scoped identities without fixed counts; invalid execution groups fail closed.
- Use authenticated receipt admission for executable planning, distinguish pending reuse publication from current evidence and print its signed refresh command, withhold unsafe bulk manual refresh advice in mixed Stories, and use one item-scoped evidence selector; preserve documentation attestations with informational command text and existing waivers.
- Preserve immutable signed reuse and strict fallback for incomplete dependencies, and explicitly label legacy refresh previews as metadata-only diagnostics. Historical ordinary-script evidence is not retroactively upgraded.
- Verify real producer/refresh fan-out, independent assertions, zero planner executions, dynamic membership and tampering through the existing test:all smoke discovery, with explicit 180-second smoke budget, a static import binding, mixed manual/reuse preservation, and invalid-to-rerun bucket assertions. Correct the planner smoke's obsolete local-assurance assertions and verify metadata-only apply plus item ownership before and after refresh. See docs/requirements/decisions/verification-execution-receipt-fanout-and-input-scoped-freshness.md for the exact suite command and static-binding checks.
- Baseline limitations remain: the process-fact retired-vocabulary fingerprint mismatch and the unchanged legacy refresh smoke's obsolete renderer/head-only assumptions. Focused comparison reproduces the refresh failure with the main handler; these unrelated checks remain unchanged. Focused RED/GREEN, suite and static checks are the repair evidence; repository-wide success is not claimed.

Maintenance provenance: codex/lab-intent-fingerprint-reuse, repair c1254c337654088f234403875b6f38dd861618a5.
Verification command (replayed before integration and on main): `["node","packages/main/tests/intent-fingerprint-reuse.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-real-entry-regression - v0.3.430 - 2026-09-20

- Enforce planned-provider attempt and remaining-time allowances before dispatch, preserving retries and post-transport spawn-error attempts.
- Add durable opt-in shared host-invocation budgets, repair ceilings and prompt byte limits; normalize malformed counters, release proven pre-runner refusals and preserve completed results with concrete settlement diagnostics.
- Preserve bounded provider-reported usage before transport exceptions, retain unavailable accounting honestly and keep the original error even when accounting fails.
- Register six behavioral regressions in npm test and routine validate with explicit resource policy; the pinned Lab replay additionally builds, typechecks, verifies suite registration, static bindings and usage smokes. See docs/host-run-shared-budget.md.
- Preserve the existing retired-vocabulary and snapshot-binding failures explicitly; source/parser/diagnostic bindings reject changed baseline evidence. Runtime checks after the known snapshot failure remain unexecuted. This is local maintenance evidence, not full repository success or Story DONE.

Maintenance provenance: codex/lab-benchmark-real-entry-regression, repair 0cc9b8819436598a984b436c75623bbdaaad840b.
Verification command (replayed before integration and on main): `["node","scripts/verify-benchmark-release.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab validation-production-budget-260-20260920 - v0.3.429 - 2026-09-20

- Set the three complete production validation commands for process-fact, RED-evidence target binding and RED-evidence envelopes to the explicitly authorized 260000 ms timeout, replacing 180000 ms.
- Preserve existing command arguments, assertion bodies, resources and unrelated budgets. Add a separately registered budget guard with explicit shared resource claims; refresh exact static configuration and package bindings without broadening exceptions.
- Record a real configuration RED and GREEN through the actual static verifier, requiring U18_STATIC_PASS before PRODUCTION_VALIDATION_260_GREEN, including release-time bindings. See [production budget evidence](docs/lab/validation-production-budget-260.md); this configuration repair makes no speedup or full-suite rerun claim.

Maintenance provenance: codex/lab-validation-production-budget-260-20260920, repair a0b5c2e418ebbeae8122b9e891cb548fe9142e2c.
Verification command (replayed before integration and on main): `["node","packages/main/tests/validation-production-budget-260.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab managed-implementer-dispatch - v0.3.430 - 2026-09-20

- Add controller-owned managed dispatch for one exact DEV checklist implementer target.
- Bind successful completion to the managed run, Story, item, consumed invocation, and signed terminal receipt.
- Refuse empty native wait targets and document the managed fallback for hosts without a child task identity.
- Roll back checklist completion when bound process-event persistence fails, preserving a safe replacement path.
- Cover successful delivery, no completion, in-progress-only, wrong-item, and event-write-failure cases.

Maintenance provenance: codex/lab-managed-implementer-dispatch, repair be0abcff6e3af7e6584cec65d72e4a43ec67ddab.
Verification command (replayed before integration and on main): `["npm","run","test:managed-implementer-dispatch"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab implementation-worker-authority - v0.3.429 - 2026-09-20

- Remove commit-author fallback as normal-channel implementation authority.
- Require canonical dispatch or successful subagent-result evidence for every non-exempt item.
- Block DEV to REVIEW before reviewers start when implementation-worker evidence is missing.
- Give agents exact canonical dispatch guidance and retain commit author only as audit attribution.
- Add focused RED/GREEN coverage for rejected unregistered workers and admitted registered results.

Maintenance provenance: codex/lab-implementation-worker-authority, repair dcb7f69c9d614014e23a22ff697736cd1963085d.
Verification command (replayed before integration and on main): `["node","scripts/verify-implementation-worker-authority.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-control-red-green - v0.3.428 - 2026-09-20

- Add an isolated benchmark controller experiment that ignores unchanged blocked progress, deduplicates executions, bounds context, and reserves shared and repair budgets before dispatch.
- Preserve unknown usage and reconcile synthetic receipts without double-counting cached input or reasoning output; these experiments do not activate desktop or production controls.
- Verify the RED/GREEN regression and fail-closed verifier entry with 21 checks, including 1,000 unchanged observations producing zero wakeup intents and fifty duplicate requests producing one local subprocess; a disposable mutation proves lost negative coverage is rejected.
- Record measurement scope and reproducible comparisons in scripts/lab/benchmark-controls/README.md; this release is local Lab maintenance, not benchmark product completion.

Maintenance provenance: codex/lab-benchmark-control-red-green, repair b0168e3bd76ceffb60c307f2ac61e08d053df1df.
Verification command (replayed before integration and on main): `["node","scripts/lab/benchmark-controls/verify-entry-contract.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab managed-worker-owner-lease - integrated in v0.3.428 - 2026-09-20

- Keep the durable Story owner lease bound to the submitting session when a detached `host_run_worker` starts and exits; the worker validates ownership without refreshing the lease with its short-lived PID.
- Retain the managed run's exclusive worker claim and prove that a foreign session cannot gain write authority by reusing a live run ID.
- Add a public CLI RED/GREEN regression and refresh the affected U-18 static-edge bindings; owner-command, managed-host-run, process-fact and static-edge checks pass.
- Record the exact committed candidate's independent Grok/xAI Lab audit in the authenticated Lab maintenance record; this entry does not assert formal Story DONE.

Maintenance provenance: codex/lab-managed-worker-owner-lease, repair 0cd268e1dc5e4191f81c17169076641d34857b23.
Verification command (replayed before integration and on main): `["node","scripts/verify-managed-worker-owner-lease.mjs"]`.

## Lab validation-build-artifact-binding - v0.3.427 - 2026-09-20

# Lab validation-build-artifact-binding — release notes

Opened 2026-09-17 from a RED reproduction: stale compiled artifacts (`packages/main/dist`, `packages/utils/dist`) were admitted as fresh validation evidence, so a validation command could execute old bytes and still sign a PASS for new source. Sixty-two independent Codex audits each found one more way to earn such a PASS; every finding was repaired in the Lab with a regression, and the sixty-third audit passed. The full per-audit record (findings, reproductions, repairs, GREEN/RED history) is in `NOTES.md` next to this file.

## What changed

- Artifact identity. Every validation command observes a content digest of the compiled artifacts immediately before launch and after it returns (path, kind, execute bits, directory search bits framed unambiguously; symbolic links, hard links, non-UTF-8 names and uninspectable roots refused). Receipts, reuse, dynamic aggregates and DONE-required evidence bind to the bytes that executed, the build-binding manifest inside each tree included; only the registered `packages/main` build may change them, it runs first and alone, and it is never served from the shared execution cache nor accepted as build proof when it was.
- OS-level write protection. Non-build commands run under a mechanism that denies writes to the artifact trees and their ancestors (`sandbox-exec` on macOS, `bwrap` on Linux with the mount chain extended to the filesystem root and a private `/proc`). Protection is self-tested with nonce witnesses and re-resolved after any build. Enforcement is never reported without a witnessed, denied probe.
- Wrapper trust and confidential environment transfer. Only a native, unreplaceable, identity-bound wrapper is trusted; interpreted wrappers are refused because an interpreter reads launch-chosen startup files before the wrapper's code runs. The wrapper process receives only an allowlisted environment; everything else reaches the command inside the sandbox through a private descriptor, never argv: on macOS (with System Integrity Protection verified enabled) a restricted `/usr/bin/perl` trampoline sets names and values as bytes and execs the explicitly named program, on Linux bwrap reads its `--setenv` triples with `--args FD`, and a launch whose child must inherit further descriptors (the reservation delegation transport, which bwrap cannot carry) is refused rather than run without them. Only an empty name, `=` in a name or a NUL byte refuses a transfer.
- Launch directory. One canonical launch directory is resolved before the first launch of a plan or run (and, for a directory inside the artifact trees, re-bound after the registered build recreates it), walked in filesystem order exactly as the kernel resolves it (`..` after a symbolic link, platform roots preserved, unresolvable tails kept as written), bound by filesystem identity (dev/ino), and re-verified before the shared cache is consulted and synchronously before the spawn. The executor, shared cache, routine identity, dynamic planner and its receipts, the DONE-required writer and the historical replay all read that one binding.
- Honest consumers. The verifier freezes each command's launch binding alongside the routine identity, runs its fallback plans where the identity binds them, never degrades a launch-directory drift refusal into a fallback, and signs evidence only when every executed command ran where the identity binds it. A printed PASS is not a PASS unless the executor reports success; a synchronously refused spawn or a refused protection launch is a bounded per-command failure, never an unprotected launch or an exception out of the plan; the historical replay plans and executes its selection in the workspace whose baseline earned the receipts and asserts positive reuse.
- Integrated reviewer fixes. Formal managed reviewers use qualified provider-specific defaults and reject unqualified selectors before launch; incremental review resolves the Story's frozen integration target instead of assuming a local `main` branch, while historical envelopes with an explicitly omitted base retain byte-exact replay.

## Verification

`scripts/verify-validation-build-artifact-binding.mjs` (589 checks at the final GREEN) plus the production, DONE-required, story-aware, reuse, merge-lineage and parallel-equivalence smokes, all green on the final candidate; the process-fact-contract smoke fails on main itself over a retired-vocabulary pin introduced by another Lab (recorded in `NOTES.md`, not touched here). Sixty-two independent audits (including four finish-gate audits) found and had repaired every earlier way to earn a false PASS; audit #63 passed with no findings on the candidate merged with main at 0.3.426.

Maintenance provenance: codex/lab-validation-build-artifact-binding, repair 52c9981b37270a2e6b0df61934c3b69367da05ed.
Verification command (replayed before integration and on main): `["node","scripts/verify-validation-build-artifact-binding.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab ws-types - v0.3.426 - 2026-09-19

- Add the missing root `@types/ws` development dependency and lockfile entry so root-only installs can typecheck the WebSocket bridge and proxy sources.
- Add `npm run test:root-ws-types` to verify an isolated root install, all main TypeScript sources, and static/dynamic WebSocket type checks with negative controls.
- Verify the repair through Lab RED/GREEN and main/utils builds; document the regression as an opt-in installation check that may require npm registry access in the [Lab maintenance guide](docs/lab-maintenance.md#root-install-dependency-regression).
- Refresh existing static-review dependency bindings for the changed root manifests; the static scanner passes with exception classifications, call bindings and evidence excerpts preserved.

Maintenance provenance: codex/lab-ws-types, repair cf6ce9fa73e8e463728baa59f1efa2fad92d659d.
Verification command (replayed before integration and on main): `["node","packages/main/tests/root-ws-types.test.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-monitor-change-filter - v0.3.425 - 2026-09-19

- Add a Lab-only semantic-state filter and reproducible comparison harness for redundant benchmark monitor wake decisions; live automation remains unchanged.
- Replay 110 fresh historical observations with 110 periodic dispatch intents versus one cold-start filtered intent, a 99.09% reduction; exclude one unrecoverable observation and reconcile historical response-token accounting.
- Preserve wake decisions for phase, revision, approval binding, execution identity, progress, completion and failure changes, with RED/GREEN coverage for unchanged states, invalid input, recovery and returning states.
- Report local decision overhead and historical usage separately from unknown live token savings. Detailed comparison and limitations: [experiment report](/Users/jek/Documents/Proof-or-Stop-Benchmark-Plan/monitor-change-filter-lab-20260919/report.md).

Maintenance provenance: codex/lab-benchmark-monitor-change-filter, repair 1b93dcfa9d13eaf568f6f448a3acdc07416f549b.
Verification command (replayed before integration and on main): `["node","scripts/lab/benchmark-monitor-change-filter/verify.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab validation-audit-entrypoints-20260919 - v0.3.424 - 2026-09-19

- Align dispatch help with registry-defined target cardinality so CLI guidance matches the enforced command contract.
- Keep story discard recovery rooted at the controller checkout when removing an invalid linked worktree.
- Refresh reviewed source fingerprints in the retired-authority guard while retaining its token and call restrictions.
- Preserve shared AST parser reuse and recognize multiline CLI preflight calls while retaining ordering checks; rebind exact dependencies without broadening static exceptions.
- Verify complete static/runtime contracts and three complete entrypoint suites in two rounds; retain RED/GREEN and independent audit records. See [source and dependency review](docs/audits/validation-entrypoint-pin-review-20260919.md). This is local Lab integration, not Story DONE.

Maintenance provenance: codex/lab-validation-audit-entrypoints-20260919, repair d3706199a0693d5d932c7d72c7196ab002559821.
Verification command (replayed before integration and on main): `["node","/Users/jek/Documents/GitHub/Prooforstop/.git/lab-evidence-archives/validation-audit-20260918/remaining-performance-20260918/finish/verify-entrypoints-and-bindings.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.
## Lab validation-queue-wait-outside-command-timeout - v0.3.423 - 2026-09-18

- Stop counting time spent waiting on the same-user machine validation queue toward a validation command's configured timeout: the wait is bounded by the 300 s queue deadline and the caller's outer deadline, and the command is armed with its whole timeout once admitted.
- Add `waitDeadlineAt` to the capacity lock options (also honored by delegated grant requests) so the admission wait has its own bound while `deadlineAt` keeps bounding the admitted work; an expired wait bound raises a typed capacity-wait error, and a caller's own deadline error is rethrown unchanged. Handshake, grant and grant-wait timers re-arm in segments, so reservations beyond Node's 2^31-1 ms timer ceiling no longer expire at once.
- Verification: `node scripts/verify-validation-queue-wait-outside-command-timeout.mjs` fails 4 expectations before the repair (a 2 s command queued 4 s was killed with 0 ms effective budget) and passes 12 checks after it, including delegated commands at the maximum timeout and beyond-ceiling wait bounds; the `queue-wait-cap` mode of the nested result contract now asserts the new contract.
- Details and measurements: [docs/lab/validation-queue-wait-outside-command-timeout.md](docs/lab/validation-queue-wait-outside-command-timeout.md).

Maintenance provenance: codex/lab-validation-queue-wait-outside-command-timeout, repair 46ea4f5eb7beb05a9a2bdcd52346a844d6547fbe.
Verification command (replayed before integration and on main): `["node","scripts/verify-validation-queue-wait-outside-command-timeout.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab host-activity-log-during-validation - v0.3.422 - 2026-09-18

- Stop the Claude host activity hook (`.claude/hooks/log-tools.cjs`) from appending into a worktree while that worktree validates: a line is written only while the hook holds the product's own workspace validation capacity ticket, and is dropped otherwise, fixing the 2026-09-17 quorum smoke run reported FAIL with 73/73 cases passing.
- Resolve the real destination first and refuse symlinked logs, hard links, FIFOs, destinations outside the ticket's worktree and uncertain Git discovery; directories are created per component from the filesystem root (including Windows drive and UNC roots) without following links. A residual rename race remains an accepted limitation because Node has no openat/mkdirat.
- Verification: `node scripts/verify-host-activity-log-during-validation.mjs` fails 29 expectations against main's hook and passes 83 checks after the repair, including interop with the real capacity allocator and failure on any hook timeout.
- Details, measured data and the audit history: [docs/lab/host-activity-log-during-validation.md](docs/lab/host-activity-log-during-validation.md).

Maintenance provenance: codex/lab-host-activity-log-during-validation, repair 77110791b350a3179b5acac9ed04dfca9acc9113.
Verification command (replayed before integration and on main): `["node","scripts/verify-host-activity-log-during-validation.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-review-digest-refresh - v0.3.421 - 2026-09-18

- Refresh exactly four existing review-run.ts dependency digests after audited upstream 0.3.420 changed that source file.
- Preserve every exception identity, source binding, command, resource policy, and verification requirement; no new exception is added.
- Existing static scanner reproduced four NEEDS_REVIEW results before the repair and passed with zero after it. See b0980-parallel-diagnostic-20260918/dependency-drift.json for the diagnosis.
- This bounded Lab repair restores the benchmark supporting static check; it is not formal Story DONE or benchmark runner delivery.

Maintenance provenance: codex/lab-benchmark-review-digest-refresh, repair 5f91abdf2a50baf43f7e68633af70c995f479931.
Verification command (replayed before integration and on main): `["node","scripts/verify-validation-static-edges.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab review-evidence-observation - v0.3.420 - 2026-09-18

- Share identical read-only Git probes across one synchronous collection of authenticated reviewer evidence, addressing the repeated reads found while executing B-e6d9 transition-authority acceptance.
- Retain signature, dispatch, scope and freshness checks. A later collection rereads Git; changed reviewed material is rejected and thrown reads release their observation.
- Record native multi-lane RED/GREEN with the unchanged test command. Measured hot Git probes decreased from 46 to 13 and the sampled collection wall time from 1.368 seconds to 0.406 seconds; these are individual fixture measurements, not a general throughput guarantee.
- Keep the original Story acceptance cases and time budgets unchanged. Lab evidence establishes only this bounded reader repair; the Story must independently complete its formal intents and lifecycle.

Maintenance provenance: codex/lab-review-evidence-observation, repair bf075642877763d974b2d3078eff911fbad78c04.
Verification command (replayed before integration and on main): `["node","scripts/verify-review-evidence-observation.mjs"]`.
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
