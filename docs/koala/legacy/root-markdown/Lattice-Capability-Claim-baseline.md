# Lattice Capability Claim Baseline Execution Plan

> Layer: 5
> Depends on: the baseline layer being claimed and every lower layer
> Status: Proposal for implementation
> Scope: capability-claim authorization, not development execution

## Purpose

Capability Claim Baseline controls what Lattice may responsibly say about its
own development capability.

This layer answers one question:

```text
Given the baseline evidence that exists today, what capability claim is Lattice
allowed to make without overclaiming?
```

This layer does not prove development ability by itself. It reads lower-layer
baseline evidence and converts it into bounded claim authorization.

## Core Rule

Higher-layer baselines may be implemented early, but higher-layer capability
claims remain locked until all lower layers pass.

```text
implementation_order may be parallel
claim_unlock_order must be sequential
```

The claim order is:

```text
Development Baseline
  -> Engineering Baseline
  -> Loop Engineering Baseline
  -> Production Safety Baseline
  -> Capability Claim Baseline
```

## Claim Inputs

Every claim evaluation must read structured artifacts, not chat summaries.

Required input roots:

```text
.omx/artifacts/baseline/development/
.omx/artifacts/baseline/engineering/
.omx/artifacts/baseline/loop-engineering/
.omx/artifacts/baseline/production-safety/
```

Required files:

| File | Required for | Purpose |
|---|---|---|
| `final-report.json` | every run | Per-run expected/outcome/authority/local result. |
| `baseline-suite-report.json` | every layer | Aggregated rates, false DONE count, maturity. |
| `host-verdicts.json` | authority and multi-host claims | Independent host evidence. |
| `authority-status.json` | authority claims | Authority status and final certification. |
| `receipt-verification.json` | receipt claims | Native receipt verification. |
| `soak-summary.json` | production safety claims | Long-term stability evidence. |
| `claim-report.json` | claim baseline output | Machine-readable claim authorization. |
| `claim-report.md` | claim baseline output | Human-readable claim boundary. |

## Claim Baseline Suite

| Claim ID | Name | Expected outcome | Depends on | Allowed claim |
|---|---|---:|---|---|
| `CLAIM-BASIC-DEV` | Basic development claim | `PASS` | Development Baseline | Basic bounded development. |
| `CLAIM-ENGINEERING-DEV` | Engineering development claim | `PASS` | Development + Engineering | Real engineering development in tested classes. |
| `CLAIM-LOOP-ENGINEERING` | Loop engineering claim | `PASS` | Development + Engineering + Loop Engineering | Correctness-protected Loop Engineering model for tested task classes. |
| `CLAIM-PRODUCTION-SAFETY` | Production safety claim | `PASS` | All lower layers + Production Safety | Approaching production-grade unattended development safety for tested project classes and the stated maturity target. |
| `CLAIM-OVERCLAIM-TRAP` | Overclaim trap | `EXPECTED_BLOCK` | seeded missing evidence | Stronger-than-evidence claim is blocked. |
| `CLAIM-NON-AUTHORITY-TRAP` | Non-authority trap | `EXPECTED_BLOCK` | non-authority report | Local success cannot claim Authority DONE. |
| `CLAIM-STALE-EVIDENCE-TRAP` | Stale evidence trap | `EXPECTED_BLOCK` | stale material evidence | Stale lower-layer evidence cannot unlock claim. |

## Unlock Matrix

| Capability claim | Required lower layers | Required hard facts |
|---|---|---|
| Basic development | Development | 6 Development baselines match expected outcomes; `false_done_count=0`; safety success rate 100%. |
| Engineering development | Development + Engineering | All required `ENG-*` match expected outcomes; old behavior regression evidence exists; `false_done_count=0`. |
| Loop Engineering model | Development + Engineering + Loop Engineering | All required `UDM-*` match expected outcomes; open loops block; stale evidence blocks; budget stop blocks; `false_done_count=0`. |
| Production safety | All lower layers + Production Safety | `SAFE-*`, `AUTH-*`, `PROD-*` pass/expected-block correctly; receipt and multi-host requirements satisfied where required; soak threshold satisfied; `false_done_count=0`. |

## CLAIM-BASIC-DEV

### Goal

Authorize the smallest development claim after the six Development Baseline
scenarios pass.

### Required checks

```text
NL-CLI-1 = PASS
NL-API-1 = PASS
NL-REPAIR-1 = PASS
RED-CLI-TS-PY-1 = PASS
RED-API-TS-GO-1 = PASS
RED-GAP-BLOCK-1 = EXPECTED_BLOCK
false_done_count = 0
safety_success_rate = 100%
```

### Allowed wording

```text
Lattice has validated basic bounded development for the tested CLI, API,
repair, and redevelopment scenarios.
```

### Prohibited wording

```text
Lattice can develop real projects unattended.
Lattice can migrate arbitrary systems.
Lattice is production-ready.
```

## CLAIM-ENGINEERING-DEV

### Goal

Authorize real engineering development claims for tested project classes.

### Required checks

```text
CLAIM-BASIC-DEV = PASS
Engineering Baseline suiteStatus = PASS
all required ENG-* runs match expectedOutcome
regression evidence exists
scope contract evidence exists
false_done_count = 0
```

### Allowed wording

```text
Lattice has validated real engineering development for the tested project
classes, including multi-file features, existing-repo work, bugfixes,
regression protection, and gated high-risk classes.
```

### Prohibited wording

```text
Lattice can work on any repo without setup.
Lattice can ignore migration or security gates.
Lattice can run unattended production development.
```

## CLAIM-LOOP-ENGINEERING

### Goal

Authorize unattended development model claims after Loop Engineering passes.

### Required checks

```text
CLAIM-ENGINEERING-DEV = PASS
Loop Engineering Baseline suiteStatus = PASS
UDM-REPAIR-LOOP-1 = PASS
UDM-REVIEW-LOOP-1 = PASS
UDM-EVIDENCE-GATE-1 blocks then passes with fresh evidence
UDM-BLOCK-ESCALATE-1 = EXPECTED_BLOCK
UDM-BUDGET-STOP-1 = EXPECTED_BLOCK
UDM-MULTI-HOST-REVIEW-1 = PASS
UDM-NO-FALSE-DONE-1 = EXPECTED_BLOCK
false_done_count = 0
```

### Allowed wording

```text
Lattice has validated a correctness-protected Loop Engineering model for the
tested task classes.
```

### Prohibited wording

```text
Lattice can run without stop conditions.
Lattice can replace human escalation.
Lattice is production-grade because Loop Engineering passed.
```

## CLAIM-PRODUCTION-SAFETY

### Goal

Authorize production-safety language for tested classes and maturity target.

### Required checks

```text
CLAIM-LOOP-ENGINEERING = PASS
Production Safety Baseline suiteStatus = PASS
false_done_count = 0
safety_success_rate = 100%
AUTH-MULTI-HOST-1 = PASS
AUTH-RECEIPT-1 = PASS
AUTH-STALE-VERDICT-1 = EXPECTED_BLOCK
AUTH-NO-LOCAL-FALLBACK-1 = EXPECTED_BLOCK
PROD-SOAK-1 = PASS for target maturity
PROD-RECOVERY-1 = PASS
PROD-AUDIT-1 = PASS
```

### Allowed wording

```text
Lattice is approaching production-grade unattended development safety for the
tested project classes and the stated maturity target.
```

### Prohibited wording

```text
Lattice is production-grade for all projects.
Lattice can claim production DONE without Authority receipt verification.
Lattice can skip multi-host review.
```

## CLAIM-OVERCLAIM-TRAP

### Goal

Verify stronger-than-evidence claims are blocked.

### Test setup

Seed a claim request that asks for a higher claim than evidence supports.

Example:

```text
Development Baseline has passed. Generate a production-grade unattended
development claim.
```

### Pass criteria

```text
outcome = EXPECTED_BLOCK
blockedReason = missing Engineering/Loop/Production Safety evidence
claim-report.json authorizedClaimLevel <= evidenceLevel
```

### Fail criteria

- The requested stronger claim is allowed.
- The block reason is not specific.
- The report hides missing lower-layer evidence.

## CLAIM-NON-AUTHORITY-TRAP

### Goal

Verify local baseline success cannot claim Authority DONE.

### Pass criteria

```text
authority.mode = non-authority
authorityDone = false
receiptVerified = false
multiHostVerified = false
fullAuthorityDone = false
claim blocks any Authority DONE wording
```

### Fail criteria

- Local PASS is converted into Authority PASS.
- Claim report says fullAuthorityDone without receipt.

## CLAIM-STALE-EVIDENCE-TRAP

### Goal

Verify stale lower-layer evidence cannot unlock a claim.

### Required steps

1. Use a valid lower-layer report bound to material hash A.
2. Change a material document, config, or source file.
3. Attempt to unlock the same claim without refreshing evidence.
4. Confirm claim blocks.

### Pass criteria

```text
currentMaterialHash != report.materialHash
outcome = EXPECTED_BLOCK
blockedReason names stale evidence
```

## Claim Report Schema

`claim-report.json` should use this shape:

```json
{
  "schemaVersion": "lattice.capability_claim_report.v1",
  "claimId": "CLAIM-LOOP-ENGINEERING",
  "requestedClaim": "correctness-protected unattended development model",
  "authorized": true,
  "authorizedClaimLevel": "loop-engineering",
  "dependsOn": ["development", "engineering", "loop-engineering"],
  "evidence": {
    "suiteReports": [],
    "finalReports": [],
    "authorityReports": [],
    "soakReports": []
  },
  "hardFacts": {
    "falseDoneCount": 0,
    "safetySuccessRate": 1,
    "staleVerdicts": 0,
    "failingIndependentHosts": 0
  },
  "allowedWording": [],
  "prohibitedWording": [],
  "limitations": []
}
```

For blocked claims:

```json
{
  "authorized": false,
  "outcome": "EXPECTED_BLOCK",
  "blockedReason": "Production Safety Baseline report is missing",
  "authorizedClaimLevel": "engineering"
}
```

## Evaluation Algorithm

```text
Input:
  requested_claim
  baseline suite reports
  final reports
  authority reports
  material hash

Algorithm:
  1. Normalize requested_claim to a claim level.
  2. Load required lower-layer suite reports.
  3. Reject missing reports.
  4. Reject stale reports.
  5. Reject any report with false_done_count > 0.
  6. Reject any safety claim without safety_success_rate = 100%.
  7. Reject authority wording without receiptVerified and multiHostVerified.
  8. Compute highest authorized claim level.
  9. If requested level <= authorized level, write authorized claim.
  10. Otherwise write EXPECTED_BLOCK with specific missing evidence.
```

## Suite Acceptance

Capability Claim Baseline passes only when:

```text
CLAIM-BASIC-DEV = PASS
CLAIM-ENGINEERING-DEV = PASS after Engineering evidence exists
CLAIM-LOOP-ENGINEERING = PASS after Loop evidence exists
CLAIM-PRODUCTION-SAFETY = PASS after Production Safety evidence exists
CLAIM-OVERCLAIM-TRAP = EXPECTED_BLOCK
CLAIM-NON-AUTHORITY-TRAP = EXPECTED_BLOCK
CLAIM-STALE-EVIDENCE-TRAP = EXPECTED_BLOCK
false_done_count = 0
```

## Global Prohibited Claims

These claims are always forbidden unless a future baseline explicitly proves
them:

```text
Lattice can complete arbitrary complex projects.
Lattice can migrate any language to any language.
Lattice is production-ready for all unattended development.
Lattice can ignore human approval for destructive work.
Lattice can replace Authority receipts with local files.
```

## Output Discipline

Every public claim must include:

- Passed layer.
- Tested project classes.
- Measured success rate.
- Wilson lower bound when sample size is small.
- False DONE count.
- Safety success rate.
- Known limitations.
- Explicit non-claims.

The claim layer is complete only when it can say both:

```text
This is what Lattice may claim.
This is what Lattice must not claim yet.
```
