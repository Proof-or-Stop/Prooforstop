# B-5e28 Real-Machine Transcript Diff

Story: B-5e28 — Enable default-on DONE learning settlement with live proof
Date: 2026-07-03
Workspace: `/Users/jek/Documents/Work/proofbound/.worktrees/B-5e28`

## Expected

- Unset `PLAYBOOK_DONE_SETTLEMENT_ENABLED` enables post-DONE learning settlement by default.
- Explicit opt-out values such as `false` disable post-DONE learning settlement.
- Settlement remains learning-only: `authority=non_authoritative` and `gateEvidence=false`.
- DONE success alone does not create a helped playbook outcome.

## Actual Transcript

```text
$ node packages/main/dist/tasks/playbook-promotion-worker-smoke.js
check: CHK-001: aggregate/evaluator recommend_activate, hold, reject, archive, demote, mark_non_deducible - PASS
check: CHK-002: sweep dry-run writes nothing, apply is flag-gated/idempotent and never activates candidates - PASS
check: CHK-003: non-deducible registry guards playbook_propose with audited override - PASS
check: CHK-004: post-DONE settlement is non-blocking, idempotent, learning-only, and no helped outcome - PASS
check: CHK-005: status shows pending learning, latest decisions, non-deducible sources, health, flags, not runtime guidance - PASS
check: CHK-001/metadata: validation is own-property fail-closed and learning artifacts are material-hash excluded - PASS
smoke passed: TOTAL 6 | PASS 6 | FAIL 0
```

```text
$ node packages/main/dist/cli.js playbook_promotion_status --json | jq '.featureFlags.PLAYBOOK_DONE_SETTLEMENT_ENABLED, .authority, .gateEvidence'
{
  "raw": "",
  "enabled": true,
  "defaultPolicy": "default-on",
  "explicitOptOut": false
}
"non_authoritative"
false
```

```text
$ PLAYBOOK_DONE_SETTLEMENT_ENABLED=false node packages/main/dist/cli.js playbook_promotion_status --json | jq '.featureFlags.PLAYBOOK_DONE_SETTLEMENT_ENABLED'
{
  "raw": "false",
  "enabled": false,
  "defaultPolicy": "default-on",
  "explicitOptOut": true
}
```

```text
$ lattice validate --story=B-5e28 --json
Project validation commands passed.
verificationCoverage: total=9 required=9 covered=9 missingRequired=0
```

## Diff Notes

- Expected default-on settlement status matched actual output.
- Expected explicit opt-out behavior matched actual output.
- Expected non-authoritative, non-gate posture matched actual output.
- Expected no helped outcome from DONE success alone is covered by the promotion worker smoke.
- No user-visible mismatch was observed.

