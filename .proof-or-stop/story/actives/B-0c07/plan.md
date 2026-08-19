# Plan — B-0c07: real-arm + first powered batch (S2 of the B1-B15 program)

## Approach
Add `experiments/injection-probes/real-arm.mjs`: a real `claude -p` arm + a no-LLM stub arm + a deterministic `--self-check`, plus a small powered `--run` that reuses the merged B-a1b0 driver to produce the first genuine bare-arm catch-rate data.

## CHK-001 — real-arm.mjs (real arm + stub + --self-check)
- `makeRealArm({model})` -> `runArm(ws,{probe,arm})`: execFileSync('claude',['-p','--model',model,'--dangerously-skip-permissions','--output-format','json',PROMPT],{cwd:ws,timeout,maxBuffer}); parse usage -> costUsd/tokensSpent; BARE arm returns {actions, shipped:true, costUsd, tokensSpent}. Per-call try/catch -> {actions:['infra-fail'], shipped:false} on failure. NEUTRAL prompt (finalize the project; no mention of the injected fault).
- `makeStubArm()` -> deterministic {actions, shipped} with NO claude call (for the gate).
- `--self-check`: drive runInjectionArms (imported from ./run-injection-arms.mjs) with the STUB arm over the 6 probes; assert each record has {probe,arm,rep,outcome in OUTCOME} + numeric costUsd/tokensSpent (0 for stub) + that the catch-rate aggregation is correct. Exit 0, 0 spend.

## CHK-002 — small powered --run -> records + catch-rate
- `--run [--reps N]`: drive runInjectionArms with the REAL bare arm over the 6 probes × N (default 1); append each record to `powered-run-records.jsonl`; print per-probe outcome + the bare-arm catch-rate (caught/wrongTotal over the 5 wrong probes; genuine probe tracked separately) + total cost + any infra-fails. This is the first REAL data (small N, bare arm, exploratory — labeled as such).

## Rollback
Additive: new real-arm.mjs + records jsonl + CHANGELOG. Revert the commit; the merged driver is untouched.

## Out of scope (follow-up)
The non-bare arms (A2-prime/A4-C/A4b-B), full reps/powered N, the 9 future probes, the pre-reg amendment, the paper backfill.

## Verification
CHK-001's `--self-check` (stub arm, deterministic, 0 spend) is the DONE gate. CHK-002's real powered run is reported as a data artifact (records jsonl + printed catch-rate), honestly labeled small-N bare-arm.
