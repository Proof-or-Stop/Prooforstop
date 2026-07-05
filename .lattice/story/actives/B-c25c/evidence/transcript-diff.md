# B-c25c Real-Machine Transcript Diff

## Expected

Running the M2 provider execution checker should show that the Cell 03 launch
guardrail is recorded, exact Cell 03 budget approval is absent, provider calls
are disabled, Cell 06 remains blocked, and no provider outcome data exists.

## Actual Transcript

Command:

```bash
node experiments/multi-model-ablation/m2-provider-execution-check.mjs
```

Observed output:

```text
M2 provider execution checker passed: 696 assertions; 48 negative controls rejected
M2-provider authorization metadata: Done
Cell 03 launch guardrail: recorded
Exact Cell 03 budget approval: absent; provider calls disabled
Provider spend in B-11be: USD 0.00
Provider cells run in B-11be: none
nextPermittedFormalStep=cell-03-calibration
cell-06-a2prime-blocked
Cell 06 A2prime: blocked
Provider execution remains disabled; no provider calls made; no outcome records present
```

## Diff Notes

- Expected Cell 03 guardrail recorded: observed.
- Expected exact budget approval absent: observed.
- Expected provider calls disabled: observed.
- Expected Cell 06 blocked: observed.
- Expected no provider outcome data: observed.
- No discrepancy between expected and actual behavior.
