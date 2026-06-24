# Plan: B-d243 — Signed storyFilesHash drift-advisory for the delivery-check DONE gate

> Verified-spike re-application. The core fix was proven red→green against the
> real freshness/done-oracle code before this story; reference diff at
> `/tmp/friction1-cfresh-fix/core-fix.diff` and the red/green spike notes at
> `/tmp/friction1-cfresh-fix/redgreen-spike-test.ts`. Locked design: downgrade
> only Gate C (signed delivery-check); Gate A (frozen-ref integrity) and Gate B
> (done-required suite) stay strict.

## CHK-001: Fold a signed storyFilesHash into the delivery-check signature

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/types.ts (DeliveryCheckData.storyFilesHash?: string + signature doc-comment)
- Modify: packages/main/src/core/delivery-check-hash.ts (signDeliveryCheck + recomputeDeliveryCheckHash storyFilesHash param)
- Modify: packages/main/src/handlers/delivery-check.ts (compute currentStoryFilesHash; sign+persist in delivery_check_set; thread data.storyFilesHash through the delivery_waiver_add verify + re-sign)

**Verify**:
- `npm --prefix packages/main run build` clean
- A legacy delivery-check with no storyFilesHash recomputes byte-identically (covered by CHK-004 legacy case)

**DoneWhen**:
- signDeliveryCheck appends storyFilesHash to the payload only when present (legacy byte-identical)
- delivery_check_set persists a signed storyFilesHash; delivery_waiver_add preserves it on re-sign

## CHK-002: Add the drift-advisory downgrade branch to evaluateDeliveryCheckFreshness

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/delivery-check-hash.ts (DeliveryCheckFreshnessCode += 'delivery_check_drift_advisory'; result gains advisory?/currentStoryFilesHash?; downgrade branch)

**Verify**:
- `node packages/main/dist/tasks/delivery-check-freshness-smoke.js` prints PASS (after CHK-004 re-fixture)

**DoneWhen**:
- materialHash mismatch + a SIGNED storyFilesHash that equals currentStoryFilesHash → ok:true, code delivery_check_drift_advisory, mandatory advisory, stored hash NOT rebound
- missing storyFilesHash OR storyFilesHash mismatch → strict stale_delivery_check (unchanged)

## CHK-003: Surface the advisory loudly on the DONE delivery-check row

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**:
- Modify: packages/main/src/core/done-oracle.ts (delivery-check row: drift_advisory passes with the advisory appended to detail; tampered/stale still fail)

**Verify**:
- `node packages/main/dist/tasks/delivery-check-freshness-smoke.js` asserts the DONE row status=pass AND detail contains the advisory text (never swallowed)

**DoneWhen**:
- A drift_advisory delivery-check yields a passing DONE row whose detail includes the literal advisory wording
- tampered → fail and stale → fail rows are unchanged

## CHK-004: Re-fixture the delivery-check-freshness smoke to a story-branch topology and add the drift cases

**Owner**: lattice-implementer
**DependsOn**: CHK-002, CHK-003
**Files**:
- Modify: packages/main/src/tasks/delivery-check-freshness-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/delivery-check-freshness-smoke.js` prints PASS (exit 0)
- `npm test` (root) green — no other smoke regresses

**DoneWhen**:
- Fixture puts HEAD ahead of main so currentStoryFilesHash is non-empty
- Cases: non-story whole-tree drift → advisory pass (row detail asserts the advisory text); story-owned change → stale reject; forged storyFilesHash → tampered (_hash breaks); legacy delivery-check missing storyFilesHash → strict stale

## CHK-005: Amend the spec + process-fact rationale and add the Gate-A keep-strict note

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: docs/requirements/decisions/story-files-hash-material-drift.md (## DONE Sub-Gate Bindings amendment: C adopt-with-signed-guard, B kept strict, A excluded frozen-ref)
- Modify: packages/main/src/core/process-fact-levels.ts + packages/main/src/core/process-fact-registry.ts (delivery_check_set rationale: signed storyFilesHash + drift-advisory)
- Modify: packages/main/src/core/done-oracle.ts (keep-strict code comment at checkCompletedEvidenceSnapshotFreshness)

**Verify**:
- `node scripts/verify-process-fact-contract.mjs` exits 0
- `npm --prefix packages/main run build` clean

**DoneWhen**:
- Spec records the three DONE sub-gate bindings with rationale (esp. the signed-gate guard for C and the frozen-ref exclusion for A)
- process-fact rationale for delivery_check_set states the signed storyFilesHash + drift-advisory semantics; contract verifier green
- done-oracle Gate-A function carries a comment that storyFilesHash is intentionally not applied (frozen-ref integrity check)
