# Dynamic Finding final contract evidence — 0.3.316 Lab

Date: 2026-09-11. This is bounded Lab maintenance evidence, not formal Story
DONE, product rollout qualification, a release, or main integration.

## Scope and provenance

The user authorized three targeted follow-ups and requested measured before/after
data: historical `pre_existing_unaffected` acceptance, executed prerequisite
provenance, and reused performance-cohort accounting. No general re-attestation
allowlist expansion, scheduling subsystem, unrelated fixes, or Story state writes
were performed in this change.

The existing `codex/lab-dynamic-finding-evidence-closure` worktree was synchronized
using the official Lab command. Its current integration baseline includes local
main 0.3.316 at `6632322aec` and subsequent Story metadata at `302fa481ef`.
Tests were committed first at `f67be664bd`. The official RED was recorded on the
synced test-only commit `42df0aa8e0e240cf4a7a6cddb19c3d036d94c6ae`.
The minimal repair is `63b563d625`.

## Measured comparison

| Subject | Before repair: executed result | After repair: same contract plus negative controls | Interpretation |
| --- | --- | --- | --- |
| Historical native acceptance | 6 checks passed; actual historical/head executions, target consent and signed assessment worked | The same 6 checks passed | Acceptance coverage added; no historical implementation bug was reproduced or claimed fixed |
| Ancestor SHA with no capability receipt | Official qualification write succeeded; the expected rejection assertion failed | Write refuses, and source ledger digest remains unchanged | Repaired a real provenance gap, not a missing fixture |
| Valid executed prerequisite | Not covered by the new baseline negative test | A real assertion execution, pinned selector and independent native PASS produce a signed record; historical query retains its exact receipt | Positive admission remains possible |
| Reused completed cohort | Two Finding case references produced convergence denominator **2** | Two references produce denominator **1** | One observed cohort cannot be counted twice |
| Timing and sample accounting | Baseline stopped at the denominator assertion; these values were not measured in that run | Repeated cohort contributes **3,600 seconds once**, **0 independent Finding cases**, **0 Finding-bearing Stories**, **0 observed Finding days** | Do not infer unmeasured historical values or turn cohort timing into Finding population |
| Pinned three-case command | **1 passed, 2 failed**, exit **1** | **3 passed, 0 failed**, exit **0** | Same executable and argv; GREEN additionally contains positive/adversarial assertions |

These are controlled fixture observations, not a measured reduction in real
Story completion time. Test duration and counts do not prove operational savings.

## Root causes and minimal repairs

### 1. Historical acceptance: missing integrated coverage

Earlier pair tests checked receipt ordering and historical execution but did not
prove the complete target-consent path in one native integration fixture. The new
test executes the ancestor and head in real disposable worktrees, freezes one
evaluation context for both commands, and obtains real target-owner consent.
The witness reads each actual Git HEAD and the controlled defect at each revision.

The six assertions cover repeated-head rejection, missing target consent,
substituted target receipt with zero source-ledger delta, successful signed
non-applicable assessment releasing the high-severity **shadow** floor,
idempotent replay, and refusal to reuse proof after material drift. They do not
claim enforce activation or bypass the separate operational qualification gate.

### 2. Prerequisite ancestry was mistaken for execution proof

The old qualification adapter checked an allowlisted name and
`git merge-base --is-ancestor <SHA> main`, then produced `passed: true`.
That proves repository ancestry, not that the named capability test passed.

The official writer now requires a distinct, trusted, successful current runtime
receipt at that exact merged SHA. Its command and exact
`FINDING_PREREQUISITE <name> <SHA>` selector must be registered in reviewed intent.
The independent case PASS binds the executed report containing those receipt
references. The assertion's meaning still requires independent source review;
a printed marker alone is not semantic proof.

Signed records preserve the receipt hash and execution-command digest. Historical
queries recheck carrier, key trust, output and subject bindings; admission also
rechecks current prerequisites. The qualification policy digest changed so older
weak-policy records cannot silently qualify under the stronger rules.

Tests cover absent proof, successful proof, duplicate names, self-reported proof,
wrong capability selector, real failed execution, substituted hash, the official
signed write/query path, and revoked runtime trust. The exact-current rule is
deliberately conservative: an old passing receipt is not automatically reusable
after another HEAD or material/environment change. This patch does not generalize
metadata-only evidence reuse for qualification.

### 3. Performance observations inherited Finding case identity

The collector assigned performance rows the current Finding case ID, while the
calculator deduplicated only metric plus case ID. Different Findings could reuse
the same completed before/after cohort. Elapsed-time aggregation also summed the
same cohort once per signed case.

The server-derived rows now bind baseline/candidate Story identities and query
digests; latency rows also bind the real attempt ID. The calculator counts each
candidate cohort/attempt once. Changed values, snapshots or baseline references
for that same source refuse qualification instead of selecting a favorable row.
Timing totals are similarly deduplicated. Performance rows remain performance
observations and never enlarge independent Finding case/Story/window counts.
Distinct latency attempts still count separately.

## Verification log

Commands ran from the independent Lab worktree, with no disabled hooks:

```sh
npm run lab:worktree -- sync dynamic-finding-evidence-closure
npm --prefix packages/main run build
npm run lab:worktree -- red dynamic-finding-evidence-closure --expect 'DYNAMIC_FINDING_FINAL_CONTRACTS FAIL' -- node packages/main/tests/red/red-dynamic-finding-final-contracts.mjs
npm --prefix packages/main run test:dynamic-finding-evidence-closure
node scripts/verify-process-fact-contract.mjs
node scripts/verify-runtime-fact-contract.mjs
npm run lab:worktree -- green dynamic-finding-evidence-closure
```

- Build: exit 0.
- Official RED: exit 1, no signal, 26,266 ms; the two assertion failures above.
- Existing Dynamic Finding closure regression: 170 reported checks passed.
  The registered command now also runs the three new contract cases, all passing.
  The new cases reuse some integration setup/assertions; these totals are not
  additive unique coverage.
- Process-fact and runtime-fact contract verifiers: exit 0.
- Official GREEN at repair commit: exit 0, `3 passed 0 failed`.
- One intermediate expanded test failed only because its expected error regex
  omitted the actual typed `revoked_signing_key` refusal. The test was corrected
  to require that exact refusal; production trust checks were not weakened.

Official RED/GREEN output and HMAC-bound local provenance are retained under the
Git common directory's `lab-maintenance/`; inspect via
`npm run lab:worktree -- status dynamic-finding-evidence-closure`.

## Independent Claude CLI acceptance

Initial audit session: `80f6c2d7-582d-4a36-896f-da1eed839671`. The CLI executed
the pinned three-case command (3/3, exit 0) and calculator contract (87/87,
exit 0). Its raw returned report is preserved in
`dynamic-finding-final-contracts-claude-initial.json`.

The audit identified F1, a real current-patch diagnostic regression: summing a
missing optional cohort threw before constructing the corpus, erasing otherwise
available metric denominators. This is in scope and requires a new RED/GREEN
before final acceptance. The original missing-timing promotion refusal must
remain; other diagnostic rows must survive.

F2 observes that identical performance references are now idempotently deduped,
not generic duplicate errors. This is intentional and covered by denominator
and conflicting-reference assertions; no extra change is warranted. F3 observes
that the prerequisite receipt is bound **transitively** by the signed PASS over
the exact report receipt/hash and the report's prerequisite receipt references.
That is the implemented contract, not a separate direct reviewer signature on
each prerequisite receipt. No signing-layer expansion is needed. These comments
are recorded here rather than converted into unrelated repair scope.

One attempted `git -C ... diff --stat` tool form was denied; the audit subsequently
reported allowed diff inspection. The two required test executions succeeded;
the denied read is not represented as test failure or executed evidence.

## Remaining boundaries

Real operational samples and the 30-day qualification window remain absent.
`enforce` was not enabled. The general unrelated-code re-attestation question
remains outside the narrow supported dependency policy. No formal Story was
marked DONE or discarded. Main integration, its required version procedure,
cleanup and remote publishing are separate actions and were not performed here.
