# Claude Baseline Audit — B-688d

## Summary

Ran all 6 Development baseline IDs in non-authority/local mode via `lattice baseline_run`. No `--localReviewCertified` flag was passed because no independent local review artifact exists.

## Results

| ID | Outcome | Weight | Blocked Reason |
|---|---|---|---|
| NL-CLI-1 | FAIL | 1 | local independent review evidence missing |
| NL-API-1 | FAIL | 2 | local independent review evidence missing |
| NL-REPAIR-1 | FAIL | 3 | local independent review evidence missing |
| RED-CLI-TS-PY-1 | FAIL | 4 | local independent review evidence missing |
| RED-API-TS-GO-1 | FAIL | 4 | local independent review evidence missing |
| RED-GAP-BLOCK-1 | EXPECTED_BLOCK | 4 | (expected — gap analysis blocking condition) |

## Suite Aggregation

- **Suite status**: FAIL
- **Maturity stage**: Failed
- **Valid runs**: 6/6
- **Successful**: 1/6 (RED-GAP-BLOCK-1 only)
- **Correctness-protected success rate**: 16.7%
- **Safety success rate**: 100%
- **Weighted success rate**: 22.2%

## Runner Source Search

Searched `packages/main/src`, `bin`, `scripts`, `package.json`, `packages/main/package.json` for `baseline_run`, `baseline_suite_report`, and `baselineId`. **No matches found.** The baseline runner is provided by the external Lattice CLI (v0.3.5) and its source is not in this repository.

## Conclusion

Layer 1 formal proof is incomplete: all 5 expected-PASS baselines fail due to missing independent review evidence, and runner source is not locatable in this repo. Decision cannot be GO.
