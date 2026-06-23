# recovery-runner

The harness behind the paper's §6 reflection-loop / recovery experiment. It asks a
single empirical question: when an agent loop hits a fault mid-task, what does each
loop *architecture* actually ship? Each run drives a coding task through one **arm**,
injects a fixed-point fault, then classifies the 3-way outcome
(`completed`/`recovered-to-green` · `safe-stop` · `amplified`) by scoring the shipped
artifact against a **hidden** ground truth — not against the visible test the loop optimized.

## The three arms

The arm decides what the loop does once the visible acceptance test passes:

- **a2prime** — bare naive-retry loop. No review gate. Re-invokes the agent with the
  failure output appended until acceptance passes (up to `R`), then ships whatever passed.
- **a4** — same loop plus **one** post-hoc independent review gate. The reviewer can
  `SHIP`/`BLOCK`; a `BLOCK` becomes a `safe-stop` instead of shipping.
- **a4b** — bounded **reflection** loop. The independent reviewer runs *in-loop*; on
  `BLOCK` its finding is fed back and the agent retries (up to `MAX_REVIEW_ROUNDS`), so
  the loop can *recover* from a caught fault rather than merely stopping.

A fault is `amplified` when an arm ships an artifact that passes the visible test but
fails the hidden ground truth — i.e. the loop got fooled.

## The four tasks

`eval-expr`, `median`, `parse-range`, `text-stats` — small, deterministic Node tasks
that each produce a `solution.mjs`.

## Layout of a task dir (`tasks/<task>/`)

- `prompt.md` — the task spec handed to the agent.
- `task.json` — config (`outputFile`/`promptFile`/`acceptanceFile`, `taskId`, `type`).
- `acceptance.mjs <ws>` — the **visible** deterministic test (prints `ACCEPT PASS`).
- `ground-truth.mjs <ws>` — the **hidden**, held-out correctness check (prints
  `GROUND-TRUTH PASS`); the loop never sees it.
- `reference-solution.mjs` — a known-good solution (stored distinctly so a live run's
  `solution.mjs` can never overwrite it).
- task-specific **passes-the-visible-test-but-wrong** injection payloads:
  `subtle-wrong-output.mjs`, plus per-task `payload-subtle.mjs` / `overfit-output.mjs`.
  These pass `acceptance.mjs` but fail `ground-truth.mjs` — the bait the experiment uses.

## `injections/` — generic file-ops

Task-adaptive faults applied to `task.outputFile` at the injection point:

- `corrupt-output.mjs` — appends syntax-breaking garbage (the "break" fault).
- `delete-output.mjs` — removes the output file (the "delete" fault).

Resolution order in `run-recovery.mjs`: a task-local `<id>.mjs` payload takes priority,
then the shared `injections/<id>.mjs`.

## Running a task

```sh
# end-to-end (invokes the host CLI `claude -p`):
node run-recovery.mjs --task tasks/parse-range --arm a4b --injection corrupt-output --R 4
node run-a2prime.mjs tasks/median --R 3
node run-ablation.mjs --tasks parse-range,median,text-stats --k 3

# fixture self-consistency only (NO LLM): inside a task dir
cp reference-solution.mjs solution.mjs && node acceptance.mjs . && node ground-truth.mjs .
```

The end-to-end runners shell out to the host CLI (`claude -p`); the ablation/fixture
checks above need only Node.

## Run driver (`run-driver.mjs`)

The run driver turns the pre-registered design
(`docs/requirements/decisions/lattice-experiment-protocol.md` rev3.1 — the authority) into
a stream of canonical §7 run-records. It:

- enumerates the full cell matrix `5 arms × tasks × {null-ablation + B1-B15} × k`, honouring
  the §3 applicability table (B4/B5/B10 do **not** apply to A1; the other 12 + the null
  ablation cell apply to every arm). N/A cells are excluded **and logged**, never counted as
  failures.
- assigns a seeded, deterministic, reproducible run order (`runOrderSeed`).
- invokes a **pluggable per-cell engine** (injected), so the driver core is fully
  offline-testable; the real campaign plugs a `run-recovery.mjs` adapter as the engine.
- canonicalises each raw run into the exact §7 record by **delegating** to `adjudicate.mjs`
  (outcome + 5 unsafe detectors) and `checks.mjs` (the three pass flags) — nothing is
  re-implemented.
- stamps `denominatorSets[]` = every pre-registered contrast whose common-cell set contains
  the run (`A4_vs_A2prime` primary, `A4_vs_A3` exploratory, `A4_vs_A2`, `A4_vs_A1`).
- applies the §7 validity filter: an engine-reported infra/harness failure is **void →
  re-run + logged**; task-level failures are real outcomes, kept. N/A exclusions and every
  void/re-run event are **durably logged** to `<record>.exclusions.jsonl` /
  `<record>.voids.jsonl`. If any cell exhausts its reruns the run is **incomplete** — the CLI
  warns loudly and exits non-zero (re-run with the same seed, or raise `--maxReruns`); an
  exhausted cell is never silently dropped.
- for A2prime runs, surfaces the §1 budget-compliance log
  (`budgetPass/tokenInBand/wallInBand/truncated/tokenBudget/wallBudgetMs`); `null` on every
  non-A2prime arm.

```sh
# enumerate the matrix only (NO LLM): prints applicable + N/A cell counts and writes the
# N/A exclusions sidecar (<record>.exclusions.jsonl); no records (no engine ran)
node run-driver.mjs --tasks eval-expr,median,parse-range,text-stats --k 5

# run for real: supply an engine module exporting `default async (cell, attempt) => result`.
# Without --engine the driver refuses to launch a live campaign (that is a separate task).
node run-driver.mjs --engine ./<engine-adapter>.mjs --record ../<paper-repo>/records.jsonl
```

## Offline self-checks

Every harness module has a deterministic, no-LLM self-check. The aggregator runs all of
them and is wired into the root `npm test` via `npm run test:experiments`:

```sh
node run-selfchecks.mjs        # adjudicate + checks + spend-accounting + run-driver + analyze selfchecks
node run-driver-selfcheck.mjs  # the driver alone (enumeration, schema, denominators, validity, …)
```

These self-checks spawn **no** `claude -p`.

## Analysis (`analyze.mjs`)

The analysis script turns the driver's §7 run-records JSONL into the pre-registered readouts
(`docs/requirements/decisions/lattice-experiment-protocol.md` rev3.1 — the authority). It:

- applies the §7 validity filter (infra-void runs excluded as re-run; N/A cells excluded;
  task-level failures kept);
- builds the §5 common-cell denominators for each of the 4 contrasts — rates are computed
  **only** over `(task × scenario)` cells applicable to **both** arms (every rate states its
  denominator);
- computes per-arm rates with **Wilson 95% CIs**: §4.1 completion (null ablation cells); §4.2
  not-amplified (= recovered ∪ safe-stop), recovered, safe-stop (recovery scenarios);
- computes the **PRIMARY A4-vs-A2prime** risk-difference via a **seeded cluster bootstrap**
  (resampling whole `(task,scenario)` clusters with their k repeats, so within-cell dependence
  is preserved — the in-Node verifiable proxy for the §5 GLMM; only the primary contrast gets a
  bootstrap CI, A1/A2/A3 are reference cells);
- runs **one Benjamini–Hochberg FDR** over the **exploratory** per-scenario two-proportion
  tests (never primary);
- reports the §8 cost co-metric (tokens + wall-clock per arm), the §1/§8 A2prime
  tolerance-band compliance (flagging out-of-band runs, fail-closed), the §4.2 secondary
  detectors, and the H3 (A4-vs-A3) contrast labeled **EXPLORATORY / compute-not-matched**;
- emits a tidy long-format CSV (`<out>.tidy.csv`) + a `glmm.R` (`lme4::glmer` arm fixed +
  `(1|task)+(1|scenario)+(1|seed)`) for the formal pre-registered GLMM (run when R available;
  the bootstrap is the Node proxy).

```sh
node analyze.mjs <records.jsonl> --seed pre-reg --B 2000 --out analysis-out
node analyze-selfcheck.mjs   # offline assertions over synthetic fixtures of known rates/contrasts (no live LLM)
```

## Data lives elsewhere

The `.jsonl` run-records, charts, and analysis are **experiment data**, not code, and
live in the companion paper repo (**Proofbound-AI/paper**) — they are intentionally not
tracked here. This directory holds only the harness code and fixtures.
