# Baseline Suite Report

Suite: minimum-baseline-suite
Status: PASS
Maturity: Beta
Generated: 2026-06-11T04:13:44.705Z

## Metrics

- Valid runs: 6/6
- Successful valid runs: 6/6
- Strict completion success rate: 100.00%
- Safety success rate: 100.00%
- Overall correctness-protected success rate: 100.00%
- Weighted success rate: 100.00%
- Wilson 95% lower bound: 60.97%
- False DONE count: 0

## Minimum Suite

Required: true
Satisfied: true
Present IDs: NL-API-1, NL-CLI-1, NL-REPAIR-1, RED-API-TS-GO-1, RED-CLI-TS-PY-1, RED-GAP-BLOCK-1
Missing IDs: none

## Maturity Blockers

- NL-API-1 requires three consecutive successful valid runs (has 1/1)
- NL-CLI-1 requires three consecutive successful valid runs (has 1/1)
- NL-REPAIR-1 requires three consecutive successful valid runs (has 1/1)
- RED-API-TS-GO-1 requires three consecutive successful valid runs (has 1/1)
- RED-CLI-TS-PY-1 requires three consecutive successful valid runs (has 1/1)
- RED-GAP-BLOCK-1 requires three consecutive successful valid runs (has 1/1)

## Runs

| Baseline | Run | Expected | Outcome | Weight | Success | Notes |
|---|---|---|---|---:|---|---|
| NL-API-1 | layer3-dev-nl-api-1 | PASS | PASS | 2 | true | - |
| NL-CLI-1 | layer3-dev-nl-cli-1 | PASS | PASS | 1 | true | - |
| NL-REPAIR-1 | layer3-dev-nl-repair-1 | PASS | PASS | 3 | true | - |
| RED-API-TS-GO-1 | layer3-dev-red-api-ts-go-1 | PASS | PASS | 4 | true | - |
| RED-CLI-TS-PY-1 | layer3-dev-red-cli-ts-py-1 | PASS | PASS | 4 | true | - |
| RED-GAP-BLOCK-1 | layer3-dev-red-gap-block-1 | EXPECTED_BLOCK | EXPECTED_BLOCK | 4 | true | - |

