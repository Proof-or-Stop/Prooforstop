# Layer 2 Fail-Closed Trap Summary

Generated: 2026-06-10T23:35:53.054Z
Command: `npm --prefix packages/main run test:lattice-baseline-smoke`
Result: pass

| Trap | Level | Expected non-PASS behavior |
|---|---|---|
| forged-suite-summary | claim-level | LOCKED/BLOCKED |
| missing-review-host | suite-level | BLOCKED |
| wrong-host-json | suite-level | BLOCKED |
| reused-review-artifact | suite-level | BLOCKED |
| missing-lifecycle-gate-ref | suite-level | BLOCKED |
| missing-receipt-evidence-digest | suite-level | BLOCKED |
| stale-material-hash | suite-and-claim-level | STALE/BLOCKED |
| local-only-diagnostic-artifacts | suite-and-claim-level | LOCKED/BLOCKED |

Authority changed: false
Receipt verified: false
Production DONE: false
Full Authority DONE: false
