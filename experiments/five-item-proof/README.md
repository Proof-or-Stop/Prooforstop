# Five-item isolated proof experiment

This is a retained Lab candidate for user verification. Base: `cf21df09c273074d7aa3227a5f436c6f5badf47a` (main 0.3.284). No Story was created, no version was bumped, and no Lab finish or integration is authorized by this artifact.

The experiment distinguishes a failing target assertion from a controlled baseline that succeeds but repeats work. `RED` in a benchmark means the baseline policy, not necessarily a failed functional test. The aggregate Lab target has real failing assertions on the recorded earlier commits.

## Reproduce in this Lab

Use Node 26 and installed repository dependencies. Run from the retained worktree; all scenario repositories are temporary fixtures. Preserve the base main commit if importing the incremental Git bundle. Do not run `finish`, version, release, push or cleanup commands.

```sh
node scripts/ensure-dist.mjs
FIVE_ITEM_PROOF_OUTPUT=/tmp/five-item-review node experiments/five-item-proof/verify.mjs
FIVE_ITEM_PROOF_OUTPUT=/tmp/five-item-identity node experiments/five-item-proof/identity.mjs
FIVE_ITEM_PROOF_OUTPUT=/tmp/five-item-consumers node experiments/five-item-proof/consumers.mjs
FIVE_ITEM_PAIRS=1 FIVE_ITEM_NEGATIVE=dirty-source FIVE_ITEM_PROOF_OUTPUT=/tmp/five-item-dirty-source node experiments/five-item-proof/consumers.mjs
FIVE_ITEM_PAIRS=1 FIVE_ITEM_NEGATIVE=dirty-metadata FIVE_ITEM_PROOF_OUTPUT=/tmp/five-item-dirty-metadata node experiments/five-item-proof/consumers.mjs
FIVE_ITEM_PROOF_OUTPUT=/tmp/five-item-delivery node experiments/five-item-proof/delivery.mjs
FIVE_ITEM_PROOF_OUTPUT=/tmp/five-item-acceptance node experiments/five-item-proof/acceptance.mjs
```

Use new output directories for each run. `verify.mjs` intentionally tests the actual batch handler across an accelerated lease threshold. Its child command performs real work for 2.1 seconds; only the parent's Date and the heartbeat interval are scaled by 1000. This does not emulate all behavior of a 51-minute OS process. No failed RED attempt has a successful completion time, so it cannot support a percentage speedup.

## Scope and evidence interpretation

1. **Hash and implementation identity:** the existing independent 27-case oracle already passes on base main. Candidate CLI transport pins bind the actual entrypoint, runtime code, package templates, declared dependency bytes or absence, and Node/options. Pins are opt-in. Required missing/mismatched pins fail before dispatch. Runtime-copy mutation tests keep main and Lab runtime intact. This is not evidence that every existing host, role or receipt carries a pin. It is not a hostile-host sandbox or a speed optimization. Different entrypoints can legitimately have different pins even when versions match.
2. **Bounded review:** the existing production inventory regression verifies a complete signed first wave can authorize remediation, while certification, critic completeness, freshness and replay controls remain enforced. This mechanism was already on main. Review execution uses automated fixture terminals, not live independent LLM reviewers. Human/LLM review duration and whole-Story lead time remain unmeasured. Do not hard-code four roles; the tested production roster has three lanes and two hosts.
3. **Actual execution sharing:** two separate processes invoke production routine and DONE handlers, persist actual causal receipts, and run the same six arithmetic cases. Fixture admission is synthetic test setup, never real Story authority. Five alternating pairs compare reuse disabled and explicit `exact-inputs`, with two acceptance consumers in both cases. A real launch log verifies 4 versus 2 child executions. The candidate fixes DONE admission metadata dirtying the workspace and a raw-index preflight snapshot taken before Git refreshed its stat cache. DONE commits only its canonical admission delta using the existing immutable transaction. This opt-in path requires a clean workspace before admission. The root 134-command observe policy, build-proof exclusions, and production activation were not changed; this result does not prove that the full repository workload benefits yet.
4. **Lease/publication/amendment:** production single and batch evidence handlers now maintain an existing same-owner lease through execution and publication. Existing missing/released/generation fencing and receipt recovery tests are retained. `acceptance.mjs` is explicitly a pure append-only contract prototype using an owner boolean, not a signed authority. The real frozen-DEV handler refusal is reproduced; original acceptance is retained and new required coverage blocks in the prototype. No production amendment, independent dispatch, scope revision, or signed audit channel is claimed.
5. **Capacity/decomposition:** capacity uses real child test commands in two actual temporary Git worktrees and the production coordinator. Conflicting resources remain serialized. Equal-scope decomposition must integrate byte-identical code and pass all 7,442 acceptance cases, counting setup, extra tests and integration. This automated replay cannot measure LLM implementation/review time. A slower split is a valid negative result, not a GREEN speedup.

Timings are local shared-host observations, not an isolated CPU benchmark or a general 48% claim. For successful paired runs use median wall time and show raw pairs. Do not add stage percentages. Functional acceptance, defect controls, launch counts, and total delivered scope are separate from time.

## Self-review and remaining work

The earlier first-commit RED covers missing pin enforcement and expired batch publication. The second recorded RED adds the actual-consumer target; fixture branch and output-reporter corrections are documented in the report. Diagnostic fixture failures are not product repair evidence. Same command text across Git commits does not imply identical harness bytes; review the bundled patch.

Targeted self-checks include the hash oracle, production performance mechanisms, actual evidence receipt smoke, DONE validation smoke, validation reuse/immutable metadata regression, inventory regression, process/runtime fact contracts, runtime-copy identity mutations, dirty-input controls, and all paired workload assertions. These are Lab engineering evidence, not Story DONE or release approval. Existing final metadata publication behavior and actual concurrent host rollout require further integration review; no all-host or month-wide latency closure is asserted.
