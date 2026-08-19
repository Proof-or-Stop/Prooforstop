## Trigger Event
On 2026-07-01 the powered section 5/6 ablation completed (9,240 deduped cells) and the paper needs its headline figure; per the paper-data-must-ship-a-committed-generator norm, the figure requires a runnable generator rather than a one-off screenshot.

## Key Insights
The figure numbers must be derived deterministically from experiments/recovery-runner/powered/*.jsonl (dedup by arm|task|scenario|repeat, keep first), matching analyze.mjs. The generator emits a standalone SVG plus a tidy CSV so the exact per-arm amplification is auditable and re-buildable by anyone.

## Solution Tradeoffs
A small standalone Node generator (no new dependencies) reading the campaign JSONL and emitting SVG + CSV, plus an offline synthetic-data selfcheck wired into run-selfchecks. It does NOT edit the paper (main.tex is owned by another workstream) and does NOT recompute the cluster-bootstrap CI (that remains analyze.mjs's job).

## Conversational Texture
The operator asked to formally commit the figure generator into proofbound after the run finished, explicitly keeping figure insertion into the paper out of scope; correctness and reproducibility of the numbers matter more than styling.
