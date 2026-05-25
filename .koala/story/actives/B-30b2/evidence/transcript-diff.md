# B-30b2 TEST transcript diff

## Expected

- A story that was auto-elevated by riskSignal can dismiss the false-positive category and have the high-risk gate cost removed when no active riskSignals remain.
- A user-set `high` or `critical` priority story is never downgraded by dismissing a riskSignal.
- If multiple riskSignal categories are active, dismissing only one keeps the story high-risk.
- `story_create` and `story_review` expose honest mention-vs-modify guidance only when a riskSignal exists.

## Actual transcript

- `npm --prefix packages/main run build` passed.
- `node scripts/verify-risk-elevation-rollback.mjs all` passed:
  - `ok happy`
  - `ok edge-high`
  - `ok edge-critical`
  - `ok multi`
  - `ok adversarial`
  - `ok guide-hit`
  - `ok guide-miss`
  - `ok guide-honest`
  - `ok all`
- `koala validate --story=B-30b2` passed:
  - project fallback validation ran `npm test` and passed.
  - verification intent coverage was `8/8 covered`.
  - no required intent was missing or stale.
- REVIEW second round passed after resolving `B-30b2:F-001`.

## Difference

No user-visible gap remains. The actual transcript matches the PLAN outcome: false-positive riskSignal dismissal is now a real escape path for auto-elevated stories, explicit high/critical priorities stay protected, partial dismiss remains high-risk, and the CLI/docs guidance matches the implemented behavior.
