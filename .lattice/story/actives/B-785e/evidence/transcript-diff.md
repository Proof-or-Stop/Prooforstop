# B-785e Real-Machine Transcript Diff

Story: B-785e
Phase: TEST
Purpose: record the actual user-perspective verification transcript and compare it with the planned acceptance signal.

## Expected

- `lattice validate --json` should pass all configured project validation commands.
- `node experiments/multi-model-ablation/m2-provider-execution-check.mjs` should confirm that M2 provider execution remains disabled, contains no provider outcome records, and permits only the next formal cell 03 calibration step.
- `node experiments/multi-model-ablation/m2-launch-readiness-check.mjs` should continue to pass the provider-free launch readiness contract.

## Actual Transcript

Command:

```sh
lattice validate --json
```

Observed summary:

```text
[0.0s] running validate...
[0.0s] running 34 configured validate.command(s)
[132.8s] validate done
{"provider":"lattice-verifier-configured-commands","status":"pass","allPass":true,"summary":"Project validation commands passed",...}
```

Command:

```sh
node experiments/multi-model-ablation/m2-provider-execution-check.mjs
```

Observed output:

```text
M2 provider execution checker passed: 391 assertions; 27 negative controls rejected
nextPermittedFormalStep=cell-03-calibration
cell-06-a2prime-blocked
Provider execution remains disabled; no provider calls made; no outcome records present
```

Command:

```sh
node experiments/multi-model-ablation/m2-launch-readiness-check.mjs
```

Observed output:

```text
M2 launch readiness checker passed: 1105 assertions; 21 negative controls rejected
M2 provider-free launch readiness artifacts passed local checks
Negative controls rejected as expected
```

## Diff Notes

- Expected provider-free launch readiness: matched.
- Expected no provider execution/outcome records: matched.
- Expected cell 03 before cell 06 sequencing: matched.
- Expected full project validation pass: matched.
- No unexpected provider call, result row, outcome row, or active Phase 1 execution artifact was observed.
