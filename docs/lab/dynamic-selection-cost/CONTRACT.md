# Dynamic selection and repeated-cost Lab contract

Trigger: the 2026-09-18 request requires actual dynamic execution, not an
observe-mode explanation, and measured RED/GREEN evidence for repeated cost.

This is a bounded local rollout experiment on the existing runtime. It does not
redesign validation authority or mark any Story complete. The candidate changes
only this Lab's explicit selection mode; main requires separate integration.

## Frozen acceptance

1. Compare observe with the candidate configuration using the same six-command
   isolated workload through the production `validate` handler. Count physical
   launches independently of the returned selection plan. Alternate arm order
   (A/B then B/A), report both repetitions and baseline preparation separately.
2. The candidate must use `enforce-low-risk`, obtain enforce authority on the
   eligible workload, and reduce routine physical executions by at least 50%.
   Timing is measured, not a flaky pass threshold or a promised speedup.
3. Exact repeated validation must start zero new children and retain admissible
   signed evidence. An altered signature must be refused by the actual consumer.
4. Inject an affected arithmetic defect into each arm. Both must fail. The
   optimized arm must add zero false negatives in this bounded corpus.
5. Missing baseline, shared-risk catalog and unknown material must execute the
   canonical fallback once, without first executing a partial duplicate suite.
6. Preserve acceptance immutability and atomic repair through the existing
   production regressions for amendment gates, narrowing pins and remediation.
   Report their wall time and concrete assertions; do not invent an A/B effect.
7. Inspect the complete real repository inventory and record why it can or cannot
   narrow. A successful synthetic workload does not prove real-inventory rollout.
   Do not relabel high-risk tests or remove mandatory checks to manufacture a win.
8. Report input/output tokens only when measured. Mechanical workloads launch no
   model providers; their provider tokens are zero. This development conversation
   and human-review cost are unavailable, never silently counted as zero.

The workload performs real arithmetic assertions and a fixed PBKDF2 computation
per child to make execution cost visible. It is synthetic and local, not a sample
of historical Story deliveries. The exact contract and harness digests accompany
every result. No claim of population error reduction follows from this corpus.

Machine-queue storage uses a disposable OS-home namespace in the test processes,
following the existing machine-admission regression pattern. Queue algorithms
are unchanged. Causal preflight and PRE_CERT admission are fixture prerequisites;
the production selector, child executor, signing and evidence consumer run for
real. Measurements exclude competing maintenance queues, but share host CPU.
They do not benchmark production admission or complete Story lifecycle latency.

## Reproduction

Install independent dependencies with `npm ci --no-audit --no-fund` and
`npm ci --prefix packages/main --no-audit --no-fund`, then run
`node scripts/ensure-dist.mjs`. The pinned command is
`node scripts/lab-dynamic-selection-cost.mjs`. It writes raw measurements outside
the worktree under the Git common directory's `lab-maintenance` folder, preserving
the committed candidate. RED and GREEN must use the same command and contract.

No new mandatory lifecycle gate, provider call or review lane is introduced.
The experiment's own overhead is separately reported; rollout should depend on
real inventory savings and unchanged fault detection, not additional strictness.
