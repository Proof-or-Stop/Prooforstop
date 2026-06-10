# Baseline Suite Report

Suite: minimum-baseline-suite
Status: FAIL
Maturity: Failed
Generated: 2026-06-09T23:07:12.290Z

## Metrics

- Valid runs: 6/6
- Successful valid runs: 1/6
- Strict completion success rate: 0.00%
- Safety success rate: 100.00%
- Overall correctness-protected success rate: 16.67%
- Weighted success rate: 22.22%
- Wilson 95% lower bound: 3.01%
- False DONE count: 0

## Minimum Suite

Required: true
Satisfied: true
Present IDs: NL-API-1, NL-CLI-1, NL-REPAIR-1, RED-API-TS-GO-1, RED-CLI-TS-PY-1, RED-GAP-BLOCK-1
Missing IDs: none

## Maturity Blockers

- overall correctness-protected success rate is below 70%

## Blocking Failures

- NL-API-1/run-20260609-230656400: expected PASS, got FAIL; local independent review evidence is missing; blockedReason=local independent review evidence is missing
- NL-CLI-1/run-20260609-230655417: expected PASS, got FAIL; local independent review evidence is missing; blockedReason=local independent review evidence is missing
- NL-REPAIR-1/run-20260609-230656891: expected PASS, got FAIL; local independent review evidence is missing; blockedReason=local independent review evidence is missing
- RED-API-TS-GO-1/run-20260609-230703513: expected PASS, got FAIL; local independent review evidence is missing; blockedReason=local independent review evidence is missing
- RED-CLI-TS-PY-1/run-20260609-230702593: expected PASS, got FAIL; local independent review evidence is missing; blockedReason=local independent review evidence is missing

## Runs

| Baseline | Run | Expected | Outcome | Weight | Success | Notes |
|---|---|---|---|---:|---|---|
| NL-API-1 | run-20260609-230656400 | PASS | FAIL | 2 | false | local independent review evidence is missing |
| NL-CLI-1 | run-20260609-230655417 | PASS | FAIL | 1 | false | local independent review evidence is missing |
| NL-REPAIR-1 | run-20260609-230656891 | PASS | FAIL | 3 | false | local independent review evidence is missing |
| RED-API-TS-GO-1 | run-20260609-230703513 | PASS | FAIL | 4 | false | local independent review evidence is missing |
| RED-CLI-TS-PY-1 | run-20260609-230702593 | PASS | FAIL | 4 | false | local independent review evidence is missing |
| RED-GAP-BLOCK-1 | run-20260609-230704678 | EXPECTED_BLOCK | EXPECTED_BLOCK | 4 | true | - |

