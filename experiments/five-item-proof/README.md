# Five-item Lab followthrough: current reproduction guide

Base main: `cf21df09c273074d7aa3227a5f436c6f5badf47a` / 0.3.284. This is a retained local Lab candidate for user inspection: no Story, release, push or main integration. Local repair commits and native Lab RED/GREEN records are engineering provenance; they are not formal Story DONE or release approval.

Install dependencies and build only in this Lab or a new private reproduction checkout. The repository full CLI-surface check also requires packages/lab/dist; ensure-dist currently prepares only main and utils, so explicitly build the Lab package before verification. Never share writable dist with main or another worktree. Node 26 is the measured runtime. Do not rebuild while other verification processes consume this checkout's dist. Do not run Lab finish or publish commands.

```sh
node scripts/ensure-dist.mjs
npm --prefix packages/lab run build
node scripts/verify-hash-accuracy.mjs
node experiments/five-item-proof/last-closure.mjs
node experiments/five-item-proof/acceptance-revision.mjs
node experiments/five-item-proof/acceptance-checkpoint.mjs
node experiments/five-item-proof/publication-restart.mjs
node experiments/five-item-proof/evidence-implementation.mjs
node experiments/five-item-proof/complete-output-adversarial.mjs
node experiments/five-item-proof/output-retention-contract.mjs
node experiments/five-item-proof/exit-legacy-output.mjs
node experiments/five-item-proof/capacity-config.mjs
node experiments/five-item-proof/shared-config.mjs
node scripts/verify-process-fact-contract.mjs
node scripts/verify-runtime-fact-contract.mjs
FIVE_ITEM_PROOF_OUTPUT=/tmp/five-item-current node experiments/five-item-proof/verify.mjs
FIVE_ITEM_PAIRS=1 FIVE_ITEM_PROOF_OUTPUT=/tmp/five-item-real-suite node experiments/five-item-proof/real-suite-consumers.mjs
```

Use fresh output directories. verify.mjs exercises a real batch handler and a real 2.1-second child while scaling the parent clock and heartbeat interval by 1000; it is not a 51-minute OS stress test. The real-suite comparison can take several minutes. It invokes two actual handlers in separate processes with persistent receipts, but synthetic isolated fixture admission grants no Story authority. One heavy regression suite is intentionally present in both fixture consumers. The real root DONE policy does not contain that same heavy command: this is a conditional reuse experiment, not evidence of duplicate full-suite work in the root inventory. Benchmark RED means the baseline policy, which may pass while repeating work; native functional RED requires an actual failing target assertion.

| Item | Current Lab implementation and evidence | Boundary |
|---|---|---|
| Hash / execution identity | Existing independent 27-case hash oracle; bootstrap-helper, dependency and Node/entrypoint pins; automatic loaded implementation binding for shared and checklist receipts; changed bytes refuse stale results. | Every unrelated currently running owner/reviewer is not migrated by this Lab. Scanner and local trust root are not a hostile-host sandbox. Hash correctness does not itself imply faster hashing. |
| Bounded review | Existing production first-wave remediation authority and final-certification rejection controls; independent Claude wave observations are preserved in the external experiment package. | Core rule was already on main. A repeated unchanged review wave has measurable cost, but this does not prove whole-Story lead time or unchanged defect recall for every omitted wave. |
| Shared execution | Observe-compatible explicit sharing; root candidate enables exactly the measured eligible heavy routine command (1/134); DONE 0/2 deliberately retains build/full-suite exclusions. Complete redacted selector objects, 1 MiB bound, safe legacy refusal, retry joining and same-selector fallback correctness retain evidence truth. | Root actual inventories do not duplicate this heavy suite. Short workloads can be slower; no broad percentage is inferred. Above-bound or legacy-store single-selector fallback is non-reusable. |
| Lease / publication / acceptance | Same-owner heartbeat and fencing in real single/batch handlers; same bytes/receipt write retries; new-process publication recovery without another test child; signed DEV acceptance append and PLAN revision; durable trusted-Git checkpoints detect lost canonical history and support owner recovery. | Permanent failure with no durable receipt cannot guarantee recovery. A local administrator deleting both canonical history and trusted checkpoint storage defeats this local trust model. Scope changes still require scope authority. |
| Resources / decomposition | All 134 routine and both DONE commands declare resources. Eleven routine local writer barriers and both DONE barriers remain. Historical audit is 21 reviewed / 15 effectively shared / 6 superseded. Exact normalized claims deduplicate 195 to 17. Graph verifier uses owned ephemeral servers and readiness instead of fixed waits. | Four-suite cross-worktree tests measure actual shared capacity. Full 134-command resource comparison and raw failures are in the external package. Generic decomposition was slower in the earlier equal-scope automated sample and is not offered as a speed improvement. |

The original prototype acceptance.mjs and small arithmetic consumers/decomposition experiments remain historical controls. They are superseded for current acceptance claims by real handler, signed revision, checkpoint and publication tests. Do not describe prototypes as production authority.

Graph controls:

```sh
node experiments/five-item-proof/graph-ephemeral.mjs
node experiments/five-item-proof/graph-missing-control.mjs
GRAPH_VERIFY_PORT=0 node packages/graph/scripts/verify-serves.mjs
node packages/graph/scripts/verify-json-no-listener.mjs
GRAPH_VERIFY_PORT=0 node packages/graph/scripts/verify-missing-assets-fail.mjs
```

Each graph verifier owns and terminates only its private server process group. The missing-assets recovery verifier temporarily manipulates this Lab's graph asset and restores it; do not run another build or graph consumer concurrently. The separate failure-before-listen negative control is part of the Lab experiments, not silently added to graph npm check.

The external followthrough package contains native RED/GREEN logs, source-bound timing pairs, original Claude request-changes findings and later focused verification, full inventory results, replay scripts, patch/bundle and checksums. Earlier reports are historical; use the latest report and explicit source bindings. Never add stage percentages or claim overall 48% / all-Story closure from these experiments.
