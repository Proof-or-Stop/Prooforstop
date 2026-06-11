# B-428c Transcript Diff

## Expected

Layer 3 Loop Engineering proof should unlock only the Loop Engineering claim.
Production Safety and global Capability Claim must remain locked, with no
Authority receipt, productionDone, or fullAuthorityDone overclaim.

## Actual

Commands run on the local worktree:

```text
node packages/main/dist/cli.js capability_claim_formal_evaluate --target=loop-engineering --artifactsRoot=.lattice/artifacts/baseline/layer3-loop-engineering-unlock --format=json
```

Observed:

```text
authorized=true
outcome=PASS
authorizedClaimLevel=loop-engineering
layer2EngineeringClaim=UNLOCKED
loopEngineeringClaim=UNLOCKED
productionSafetyClaim=LOCKED
globalCapabilityClaim=LOCKED
receiptVerified=false
productionDone=false
fullAuthorityDone=false
blockedReasons=[]
```

```text
node packages/main/dist/cli.js capability_claim_formal_evaluate --target=production-safety --artifactsRoot=.lattice/artifacts/baseline/layer3-loop-engineering-unlock --format=json
```

Observed:

```text
authorized=false
outcome=EXPECTED_BLOCK
claimId=CLAIM-PRODUCTION-SAFETY
authorizedClaimLevel=loop-engineering
productionSafetyClaim=LOCKED
globalCapabilityClaim=LOCKED
```

```text
node packages/main/dist/cli.js capability_claim_formal_evaluate --target=capability-claim --artifactsRoot=.lattice/artifacts/baseline/layer3-loop-engineering-unlock --format=json
```

Observed:

```text
authorized=false
outcome=EXPECTED_BLOCK
claimId=CLAIM-GLOBAL-CAPABILITY
target=capability-claim
authorizedClaimLevel=loop-engineering
productionSafetyClaim=LOCKED
globalCapabilityClaim=LOCKED
```

`node packages/main/dist/cli.js validate --story=B-428c --json` also passed,
including 15/15 verification intent coverage.

## Diff

No user-visible capability mismatch. The story achieves the intended Layer 3
claim unlock and preserves the explicit boundary that Production Safety and
global Capability Claim are still locked.
