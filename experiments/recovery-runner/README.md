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

## Data lives elsewhere

The `.jsonl` run-records, charts, and analysis are **experiment data**, not code, and
live in the companion paper repo (**Proofbound-AI/paper**) — they are intentionally not
tracked here. This directory holds only the harness code and fixtures.
