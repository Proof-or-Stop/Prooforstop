# Plan — B-0b76: reproducible §5/§6 evidence-gate ablation figure generator

## CHK-001 — Figure generator make-fig-gate-ablation.mjs
**File:** `experiments/recovery-runner/make-fig-gate-ablation.mjs` (create).
Read every `powered/*.jsonl` EXCLUDING `*.voids.jsonl`; dedup keep-first by the exact key
`arm|taskId|scenarioId|repeat` (scenarioId null → "null"); per arm ∈ {A1,A2,A2prime,A3,A4}
compute `{n, amplified (adjudicatedOutcome==='amplified'), rate, per1000, meanTokens, gate}`
where gate ∈ {none (A1/A2/A2prime), review only (A3), gated (A4)}. Emit a standalone SVG
(white-paper palette; bar length = per-1000 amplification, color = gate intensity) + a tidy
CSV `arm,n,amplified,rate_pct,per_1000,mean_tokens,gate`. Print per-arm summary lines + the
A2prime−A4 point risk-difference + the A3/A4 and A2prime/A4 token ratios + `wrote … (dedup
total N records)`. Args: `[poweredDir] [outPrefix]` (default to the repo powered dir + a
scratch out prefix). NO new deps; the adapter only COUNTS the adjudicatedOutcome already in
each record (it does not re-classify) and does NOT compute the bootstrap CI.
Done when: on the real `powered/` it prints A4 2/1920, A2prime 31/1920, A3 14/1920, A2 18/1920,
A1 13/1560 (dedup total 9240) and writes the .svg + .csv.

## CHK-002 — Offline selfcheck + wire into run-selfchecks
**Files:** `experiments/recovery-runner/make-fig-gate-ablation-selfcheck.mjs` (create),
`experiments/recovery-runner/run-selfchecks.mjs` (add to the SELFCHECKS array).
Refactor the generator so its aggregation is importable (export a pure
`aggregate(records)`), OR have the selfcheck drive it over a temp dir. The selfcheck feeds
synthetic in-memory records (incl. DUPLICATE same-key records that must collapse, a
voids-like record that must be ignored, and a known mix of amplified/recovered per arm) and
asserts: per-arm `n`/`amplified`/`rate`/`per1000` rounding are exactly as expected; duplicates
are deduped keep-first; voids are excluded; an SVG string + CSV are produced; an empty arm does
not crash. It prints a final line `make-fig-gate-ablation selfcheck: N assertions passed` (so
the aggregator regex picks it up) and exits non-zero on any failure. Add
`'make-fig-gate-ablation-selfcheck.mjs'` to `run-selfchecks.mjs`'s SELFCHECKS array (7 → 8).
Fully offline; no live LLM; no dependency on the large campaign data.
Done when: `node make-fig-gate-ablation-selfcheck.mjs` passes offline and
`node run-selfchecks.mjs` reports `all 8 recovery-runner selfchecks passed`.

## CHK-003 — README note for the generator
**File:** `experiments/recovery-runner/README.md`.
Add a short section documenting `make-fig-gate-ablation.mjs`: input `powered/*.jsonl` (deduped)
→ `fig-gate-ablation.svg` + `fig-gate-ablation.csv`; note it realizes the committed-generator
norm for the paper's §5/§6 figure and that paper insertion / the bootstrap CI are out of scope
(analyze.mjs). Update the selfcheck count where the README states it (7 → 8).
Done when: README documents the generator and the selfcheck count reads 8.

## Verification
- `node experiments/recovery-runner/make-fig-gate-ablation.mjs` (real powered/ → matches analyze counts)
- `node experiments/recovery-runner/make-fig-gate-ablation-selfcheck.mjs` (offline synthetic)
- `node experiments/recovery-runner/run-selfchecks.mjs` (8/8)
