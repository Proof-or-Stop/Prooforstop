# Five-item Lab candidate: reproduction and evidence boundaries

The original candidate was based on cf21df09c273074d7aa3227a5f436c6f5badf47a.
The current source is its managed integration with main 0.3.285. The user authorized
local integration on 2026-09-09. Follow `experiments/five-item-integration/README.md`
and the native Lab maintenance guide. Historical source, full evidence, and audits
are preserved in `docs/evidence/five-item-lab-integration-20260909/historical-evidence.tar.gz`.
Do not relabel the historical measurements as this newer implementation.

Prepare dependencies and build **only in this Lab or a private reproduction
checkout**, before freezing a runtime for an experiment:

```sh
node scripts/ensure-dist.mjs
npm --prefix packages/lab run build
node packages/main/dist/cli.js --root . lab create --help
node packages/main/tests/validate-resource-claims.test.mjs
```

The explicit Lab package build and real help probe are required. A previous private
copy omitted its 19 JavaScript extension files and failed the complete CLI-surface
check. `freeze-runtime.py` in the evidence package now copies Lab dist too. Do not
rebuild a runtime while another experiment or auditor consumes it. A full validation
plan includes writers/builds: give it independent writable dist and a private Git
baseline-authority worktree. Never use main's writable build output or mutate the
real main checkout to satisfy a fixture's layout.

Focused correctness controls (run from this Lab):

```sh
node scripts/verify-hash-accuracy.mjs
node experiments/five-item-proof/last-closure.mjs
node experiments/five-item-proof/acceptance-revision.mjs
node experiments/five-item-proof/acceptance-checkpoint.mjs
node experiments/five-item-proof/checkpoint-audit-controls.mjs
node experiments/five-item-proof/checkpoint-owner-recovery.mjs
node experiments/five-item-proof/signature-key-controls.mjs
node experiments/five-item-proof/signature-batch-controls.mjs
node experiments/five-item-proof/publication-restart.mjs
node experiments/five-item-proof/evidence-implementation.mjs
node experiments/five-item-proof/complete-output-adversarial.mjs
node experiments/five-item-proof/output-retention-contract.mjs
node experiments/five-item-proof/exit-legacy-output.mjs
node experiments/five-item-proof/build-order.mjs
node experiments/five-item-proof/resource-audit-contract.mjs
node experiments/five-item-proof/capacity-config.mjs
node experiments/five-item-proof/shared-config.mjs
# The graph check builds its client, tests recovery, and runs the no-listener refusal control.
npm --prefix packages/graph run check
node packages/main/tests/red/red-B-e40f-lab-convergence.mjs
node scripts/verify-process-fact-contract.mjs
node scripts/verify-runtime-fact-contract.mjs
```

`CHECKPOINT_TEST_RUNTIME=/absolute/private/runtime` selects the frozen dist for the
checkpoint/signature controls. Keep outputs in new directories with
`FIVE_ITEM_PROOF_OUTPUT=/absolute/new/output`. These controls use private fixtures,
including deliberately damaged data; do not target real Story directories.

`checkpoint-owner-recovery.mjs` includes actual second-rename EIO injection,
byte-preserving quarantine, intact trusted anchor, a successful governed retry,
and empty/partial duplicate cleanup. Unknown or corrupt remnants are retained.
All history signatures, predecessor relationships, current-intent bindings and
trusted-key changes remain checked; batching is not a cross-call trusted cache.

To recheck the retained real Claude calibration without calling the model again:

```sh
python3 -O experiments/five-item-proof/review-roster-check.py /absolute/package/evidence/review-benchmark /absolute/new/roster.json
node experiments/five-item-proof/score-reviews-v2.mjs /absolute/package/evidence/review-benchmark
```

The scorer writes new `roster-verified-v2.json` and `scored-results-v2.json` alongside
the supplied evidence. It checks the actual owner, all 20 complete reviewer identity
objects and first-Bash CLI exit witnesses. Its original scoring oracle was post-hoc;
this retrospective fix does not convert the finite fixture into a preregistered
trial or prove universal defect recall. Earlier and current runtime identities
are separate recorded observations, not one migrated production roster.

Performance experiments in the external evidence package:

- `benchmark-identity.py` / `identity-timing/`: strict identity output, same fresh
  inventory; not general CLI or material-hash speed.
- Historical `quorum-paired-results.json` (superseded implementation): two alternating full73 serial/parallel pairs.
  `node packages/main/dist/tasks/quorum-submit-smoke.js --jobs=1` and `--jobs=4`
  described the old monolithic candidate. Current main uses its newer isolated
  modular coordinator with `--jobs=2`; its contracts are retained unchanged.
- `basis-paired-results.json`: full suite with `--probe-jobs=1` / `--probe-jobs=4`;
  all 58 real CLI refusal probes and existing handler/atomicity assertions remain.
- `root-command-repeat-complete.mjs`: the exact eligible root command, two actual
  routine handlers, two paired orders. Shared execution off/on is the intervention.
  The private admission fixture confers no Story authority. DONE build/full-suite
  have no exact overlap with this command and remain excluded from sharing.
- `full-complete-comparison.mjs`: actual `executeValidationPlan`, all134 commands,
  original timeouts and jobs4. Same repaired source, old resource declarations plus
  serial internal pools versus audited declarations plus two internal pools. This
  isolates scheduling activation, not all repairs or Story lead time.
- `long-51-minute-RED/` and `long-51-minute-GREEN/`: actual 3060-second child runs.
  The short `verify.mjs` clock-scaled fixture remains historical and is not a
  substitute for this real long-duration result.

The external scripts retain original absolute runtime paths for provenance. On
another host, generate new private runtime JSON/pinned CLI paths with the supplied
freeze helper and point scripts at new output directories. The old snapshots and
signed records are evidence to inspect, not credentials to import into a Story.

Do not select only successful trials. Earlier short-task sharing and arbitrary
same-scope decomposition were slower; the first full candidate had two preparation/
assertion failures, and one root-command trial timed out under co-load. The final
report preserves and classifies them separately. No stage percentages may be added,
and no 48% or universal Story-speed conclusion is supported.

POSIX process cleanup is tested for owned cooperating Node workers and descendants,
including real failure/SIGINT/SIGTERM in the historical implementation. That implementation
was superseded by the current main coordinator. Its historical audit retained an unreproduced PGID
reuse race and no internal post-signal deadline for a standalone never-close case;
these are not labeled fixed. Hostile process-group escape, an uninterruptible kernel
process, and destruction of all signing keys/trusted history are outside this local
trust model. The actual validation command retains its configured wallclock ceiling.
