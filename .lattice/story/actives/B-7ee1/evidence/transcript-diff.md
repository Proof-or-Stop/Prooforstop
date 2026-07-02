# B-7ee1 User-Value Transcript Diff

## Expected

Evidence-activated advisory playbook promotion should be usable as a real Proofbound CLI capability, not a default-off placeholder:

- `playbook_auto_promotion_apply --apply` is a current writer for evidence-qualified advisory candidates.
- Promotion remains non-authoritative and `gateEvidence=false`.
- Story DONE / DONE settlement cannot create helped activation evidence.
- Duplicate outcome `idempotencyKey` rows cannot inflate activation evidence.
- Runtime consumption still keeps candidates inert until evidence-qualified activation.

## Actual Transcript

```text
$ node packages/main/dist/tasks/playbook-evidence-activation-smoke.js
check: M2 observe prefers dev-memory, reports blockers, and does not mutate stores - PASS
check: M2 finding-signal seeds require support and valid anchors before proposal - PASS
check: M3/M4/M8 default dry-run writer surfaces do not mutate learning stores - PASS
check: M3 observeDigest drift fails closed without proposal writes - PASS
check: M3/M4 batch apply stages proposals then approves candidates only - PASS
check: M4 batch approval rejects duplicate canonicalSourceKey proposal rows - PASS
check: M4 batch approval rejects proposals whose canonical source is already represented - PASS
check: M5 non_promotable blocks future seed promotion while preserving non_deducible storage - PASS
check: M5 DONE-style neutral settlement does not infer helped outcome - PASS
check: M8 DONE-settlement helped rows cannot drive evidence activation - PASS
check: M6 runtime verification consumes active playbooks and keeps candidates inert - PASS
check: M8 evidence activation fails closed without evidence and activates qualified candidates - PASS
check: M7 CLI status/readiness and read-only command surfaces execute through dist CLI - PASS
check: command policy, fact levels, and phase allowlist classify new commands - PASS
playbook-seed-promotion-loop smoke: 14/14 checks passed
```

```text
$ node packages/main/dist/cli.js playbook_promotion_status --json
seedPromotionReadiness.v2.activationImplemented = true
seedPromotionReadiness.v2.posture = evidence-activated/apply-eligible-candidates
seedPromotionReadiness.v2.activationPolicyDigest = 68b1757e05e32e5b7f3abe2ef02454baf0b0d0d3afc4280d9bd924e5a40f608e
authority = non_authoritative
gateEvidence = false
```

```text
$ node packages/main/dist/cli.js playbook_auto_promotion_apply --help
lattice playbook_auto_promotion_apply — Evidence-activated advisory promotion; dry-run explains eligibility and --apply activates only qualifying candidates
--apply    Activate only evidence-qualified advisory candidates; writes active status plus append-only activation audit rows.
```

## Expected vs Actual Diff

- Expected a real evidence-activated apply path; actual CLI help and status expose it as implemented and apply-capable.
- Expected non-authoritative learning boundary; actual status reports `authority=non_authoritative` and `gateEvidence=false`.
- Expected DONE settlement and duplicate outcome retries not to activate candidates; actual smoke covers both fail-closed cases and passes.
- Expected candidates to remain inert unless activated; actual smoke verifies runtime consumption keeps candidates inert and activates only qualified candidates.

## Acceptance Verdict

Accepted. The observed behavior matches B-7ee1 user-value expectations on the current post-main-merge worktree.

## Limitations

This story implements evidence-activated advisory playbook activation, not production/Authority/DONE gate evidence and not a timer-driven background worker.

## Pitfalls

Do not treat playbook learning as proof or DONE evidence. Activation requires explicit non-DONE exposure/outcome evidence, current digest, applied recommend_activate decision, clean source lineage, reviewed policy, and append-only audit provenance.
