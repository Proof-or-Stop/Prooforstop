# Dynamic Finding evidence closure — Lab work log

## Scope and baseline

Authorized scope: complete the reported applicability evidence, qualification,
renewal-progress and validation-integration gaps, and repair the three named
baseline tests. The Lab starts at main `b715dd7b30f90add3c19dbc939a4f8cffd4b45b7`
(0.3.314). Existing B-e6d9 lifecycle state is preserved.

## Root-cause and acceptance inventory

| ID | Root cause | Required proof |
|---|---|---|
| DFEC-01 | A configuration string selects enforce without qualification evidence | Missing, forged, stale and incomplete qualification must refuse promotion; complete evidence must admit it |
| DFEC-02 | Descriptive counts are presented as safety measurements without independently adjudicated denominators | Full plan metric inventory, explicit unknown denominators, signed source queries, threshold/window refusal and nonzero mutations |
| DFEC-03/04/05 | Signed caller labels substitute for current scope, reproduction and protected-surface evidence | Verified proposal/receipts, explicit evidence-dependent verdict, and denial of unsupported deferral/non-blocking claims |
| DFEC-06 | Early status filtering erases confirmed repair and deferral-lineage obligations | Status-only changes stay blocked until verified closure or the exact allowed release path |
| DFEC-07 | Evidence gate fixture lacks the prerequisites needed to reach its intended Finding assertion | Correct fixture proves the existing verified/suspected/disproven matrix through the real gate |
| DFEC-08 | Reviewer-batch fixture still asserts short identifiers | Assert canonical lane identity while preserving launch and read-only checks |
| DFEC-09 | A reviewed document changed without updating its exact pinned fixture | Explain the exact historical content change, rebind the reviewed bytes and retain tamper-negative controls |
| DFEC-10 | Renewal counts/time are checked without consuming typed target progress | Bind exact prior deferral, baseline, current route and target-signed semantic progress; reject no-op, replay, wrong subject and races |
| DFEC-11 | Validation selection does not consume Finding repair obligations | Add required verification inputs from current assessed Findings; stale/missing evidence expands verification safely; deferred Findings cannot remove scope or mandatory tests |

## Measurement boundary

The earlier 58.33% result was arithmetic over a predefined 12/5 operation model.
It is not an observed time or workflow improvement. Test fixtures must not be
presented as real 20-Story/200-case/30-day rollout qualification. Operational
enforcement remains refused until actual required qualification exists.

## Execution record

The official Lab RED used
`node packages/main/tests/red/red-dynamic-finding-evidence-closure.mjs` at
`3265a211da`. Its nine assertions failed against the original implementation.
The same nine assertions now pass in the working tree. This is a targeted
RED-to-GREEN observation, not yet the final committed Lab GREEN receipt.

Executed intermediate results (not final release qualification):

| Command | Observed result |
| --- | --- |
| `node packages/main/tests/red/red-dynamic-finding-evidence-closure.mjs` | `DYNAMIC_FINDING_EVIDENCE_CLOSURE PASS`, 9/9 |
| `node packages/main/dist/tasks/dynamic-finding-evidence-closure-smoke.js` | `DYNAMIC_FINDING_EVIDENCE_CONTRACT PASS 86` |
| `node packages/main/dist/tasks/dynamic-finding-runtime-integration-smoke.js` | `DYNAMIC_FINDING_RUNTIME_INTEGRATION PASS 17` after the runtime-closure and host-isolation follow-up |
| `node packages/main/tests/red/red-dynamic-finding-audit-closure.mjs` | `DYNAMIC_FINDING_AUDIT_CLOSURE PASS 6 passed 0 failed`; the same six failed before the audit repairs |
| `node packages/main/dist/tasks/dynamic-finding-applicability-smoke.js` | `DYNAMIC_FINDING_GREEN PASS 50` |
| `node packages/main/dist/tasks/finding-identity-lineage-smoke.js --section=routes` | `FINDING_IDENTITY_ROUTES PASS 58 passing 0 failed cases` |
| `node packages/main/dist/tasks/story-aware-validation-smoke.js` | `story-aware-validation smoke passed` |
| `node packages/main/dist/tasks/review-convergence-smoke.js` | PASS |
| `node scripts/verify-runtime-fact-contract.mjs` | Runtime fact contract verified; execution assertion reuse contract PASS |
| `node scripts/verify-process-fact-contract.mjs --quiet` | `Process-fact contract verification passed`; includes guard-removal mutations |
| `npm --prefix packages/main run test:dynamic-finding-evidence-closure` | Exit 0 at the safety checkpoint; ran the 86-case calculator/witness suite, then-15-case actual-runtime suite, original 9 cases and audit 6 cases. Follow-up full replay is recorded below. |

The runtime integration fixture executes an actual build and failing command,
reads its signed current receipt, submits a reviewer-owned immutable proposal,
appends a final assessment, checks the shared gate and validation constraints,
rejects partial batches, and executes the same command after a committed repair.
The repair closes the latest mandatory classification through actual RED/GREEN
receipts. The route fixture independently exercises target-owned baseline,
typed progress, exact prior disposition, renewal count and the cumulative clock.
These disposable fixtures are not operational Stories or independent rollout
case measurements.

The baseline fixture repairs retain their intended assertions. The evidence
fixture now has acceptance prerequisites and native signed current reviewer
runs. The batch fixture now persists real Prompt Envelopes and binds its PASS
records to them, asserts canonical lane names and current local-assurance text,
and still proves read-only operation. The document pin changed only after
confirming the historical identity rename in `ef854edb5a`: the document changed
`lattice.config.json` to `proof-or-stop.config.json` (+6 bytes). The new exact
size is 80,453 bytes and SHA-256 is
`5e4fb133037ace63a100f89b8252cc3abdd6d6ef704eb23b29dee47476281a96`.
Its tamper-negative control remains active.

## Additional diagnostic outside the authorized repair set

`story-aware-validation-mutation-smoke` currently rejects the real fail-closed
error wording. It expects `/could not resolve a merge base|diff failed/`, while
the byte reader throws `Git references did not resolve to two immutable objects`.
Both that test file and `core/story-git-bytes.ts` have no diff from the Lab base
`b715dd7b30`; the same throw exists at that base. This is an unchanged test
expectation, not evidence that an invalid reference was accepted. No repair to
those files is included. This entry is a maintenance follow-up record, not a
signed deferral or an accepted owner/route receipt. The complete mutation suite
is therefore not claimed green.

The process-fact check exposed registration drift for the newly added query and
the deliberate REVIEW/TEST runtime-witness availability. The allowlists and
verification contract were repaired and the check now passes. This does not
waive the unrelated baseline above.

## Independent Claude CLI audit and bounded corrections

Claude CLI session `b00e28d7-8d76-481b-aa16-937cc0c41c4e` returned **NOT PASS**.
That audit was source-only: its test executions were denied by the launcher's
tool allowlist. It also observed concurrent implementation/test edits; it is
not a frozen-revision certification. Its five primary issues and dispositions:

| Issue | Evidence / correction | Current disposition |
| --- | --- | --- |
| Kill switch and observe/warn leaked new lifecycle authority | Diagnostic reads bypassed the kill switch; lifecycle transition and validation consumers used shadow decisions. The shared projection now respects the kill switch even for diagnostics; only effective qualified enforce can constrain either consumer. Shadow validation inputs are rejected by the selector. | Six-case audit RED/GREEN and runtime integration verify compatibility isolation. |
| New tests absent from validation inventory | The npm script existed but the configured command list omitted it. The suite is now registered with a bounded timeout and Git shared-resource claim. | Audit RED/GREEN verifies authoritative registration. |
| Qualification statistics were self-reported | Independent PASS and runtime receipts proved attribution, not that the reported fractions were query-derived. Such rates now retain `measurementAuthority=reported_statistics_non_qualifying`; only public-query-derived measurements enter the scorecard. The actual identity and ledger public queries are captured. | Unsafe promotion is refused. **Full metric-source collectors remain incomplete**, not solved by renaming the statistics. |
| Story-owned drift was misclassified | Material comparison ran before Story-files comparison, returning `re_attestation_required` for Story-owned change. Story-files drift now returns `stale` first. | Audit RED/GREEN passes. |
| Repair closure did not converge over metadata commits | The closure bound the exact HEAD, so committing its metadata could reopen it. The closure now binds material, Story files, acceptance, scope and the exact selected runtime receipts, not metadata-only HEAD movement. | Actual RED/GREEN closure survives a subsequent metadata-only commit in the runtime test. |

The initial-deferral batch now re-derives target baseline/progress proof inside
the transaction predicate as well as checking the source assessment. Runtime
witnesses must also satisfy the exact reviewed selector. Readers recheck signed
ledger carriers rather than accepting a serialized `evidenceVerification` flag.

## Explicit remaining product work — not closed by this Lab checkpoint

1. Complete the §11 public-query collectors for every safety, mutation,
   performance and qualification-window row. The pure 22-row calculator is
   tested, but public operational aggregation is not complete. Empty or
   unsupported source evidence stays `observed=null` and refuses enforce.
   A reviewed command emitting 22 perfect rates cannot qualify the repository.
2. Finish the gate-consumed unrelated-material re-attestation release contract.
   Recording a signed correction is not equivalent to proving a complete,
   unaffected runtime/process-policy/route/canonical dependency closure.
3. Connect L4 expiry/lineage triggers to the existing exactly-once historical
   candidate-recall command. Current floor/reassessment behavior is not proof
   that an automatic recall was appended.
4. Complete exact historical base/head execution pairing for non-regression
   applicability proof. Current command, pin, receipt and affected-path checks
   must not be described as autonomous semantic determination of all impact.

These are explicit engineering gaps, separate from the unavoidable need for a
real 20-Story / 200-case / 30-day operational qualification cohort. The Lab has
not completed the entire execution plan, enabled enforce, changed Story
B-e6d9's phase, or established measured time savings. No main integration,
version increase or remote publication has occurred. The Lab remains open.

## Follow-up audit and runtime closure regression

Commit `c67db15efc7bf34063266a5bb358dd146768cf92` has an official local Lab
GREEN receipt for the original nine-case command. This is a maintenance
checkpoint, not whole-plan completion.

Claude CLI session `48a9f5f0-9b81-4034-9164-f2e8cfdf8c9c` executed the tests.
It reproduced a real fixture portability failure under `Claude -> Codex`
process ancestry: runtime integration exited 1, and the original suite reached
8/9 because the evidence-state fixture encountered the same mixed-provider
refusal. It independently passed the 86-case and 6-case suites, confirmed the
rollout/freshness/statistics safety corrections, and did not grant a plan PASS.

Only the two affected disposable fixtures now use a test-only OS-isolated
worker. The worker is reparented before executing the fixture; it creates its
own temporary repository and broker keys. No production host observer,
provider-ancestry veto, signing policy or hook is changed or mocked. The parent
captures output and exit status, applies a 120-second deadline, and terminates
only its own worker group on failure. This demonstrates fixture behavior, not
permission for real mixed-provider direct reviewer evidence.

The closure regression now uses a real Story branch and a committed metadata
file, not an empty commit. That metadata commit preserves closure. A subsequent
compiled-artifact corruption reproduced another target failure: the reader
still returned `complete_repair_closure` although the artifact no longer matched
GREEN. The repaired reader re-verifies runtime artifact, environment, toolchain,
policy, blobs and current key status. Metadata reuse is permitted only on a
clean, material-identical Git descendant; it never re-labels the old execution
as a new execution. GREEN verifies artifact corruption and key revocation both
reopen the obligation. The runtime integration now passes 17 checks.
