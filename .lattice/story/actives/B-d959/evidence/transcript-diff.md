# User-Value Transcript Diff

## Expected User-Visible Result

The user should be able to open the 3x2 review escalation execution plan and see that full 3x2 remains the default, while a second-host credit/auth/runtime/rate-limit failure can use a clearly marked degraded 3-round x 1-host fallback when policy or explicit approval allows it.

Expected terminal/user-facing summary:

```text
The 3x2 review plan now keeps 3x2 as the default, but explicitly allows a marked 3-round x 1-host degraded fallback when no second host is usable because of credits, auth, runtime, outage, or rate limits.
```

## Actual Verification Transcript

Command:

```bash
lattice validate --story=B-d959 --json --forceTakeover
```

Observed result summary:

```text
status: pass
allPass: true
npm test: pass
verificationIntent coverage: 6/6 covered, 0 required missing
degraded-default-preserved: covered
fallback-reasons: covered
degraded-not-equivalent: covered
high-risk-limits: covered
no-silent-downgrade: covered
no-authority-overclaim: covered
```

## Product Diff

No user-value gap found. The document now states that degraded single-host review is explicit lower assurance, not full 3x2, and not Authority receipt completion. It also separates `unavailable-second-host` from `approved-single-host-local` so later implementation does not confuse user approval with proof that a second host was unavailable.

## Limitations

This story updates the execution plan only. Runtime implementation of degraded 3x1 gating remains a follow-up implementation story.
