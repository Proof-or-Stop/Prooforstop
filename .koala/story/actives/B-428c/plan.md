# B-428c Execution Plan

## Objective

Implement and execute the formal Layer 3 Loop Engineering unlock path. The work may unlock only `loopEngineeringClaim`; it must keep Production Safety and global Capability Claim locked.

## Non-Goals

- Do not add new baselines beyond the documented 10 UDM baselines.
- Do not turn host review artifacts into Authority receipts.
- Do not consume stale Layer 1 or Layer 2 proof.
- Do not use `.omx` as a Lattice proof root.

## CHK-001

Add a bounded `loop-engineering` branch to the existing formal claim evaluator. Reuse the Layer 2 rebuild/fail-closed shape where equivalent, but keep target dispatch explicit so existing Engineering behavior remains unchanged.

Verification:
- Valid loop proof unlocks only `loopEngineeringClaim`.
- Valid engineering proof still follows the existing Layer 2 path.
- Missing/stale lower proof keeps loop locked.

## CHK-002

Extend formal baseline report validation only as needed for the documented UDM evidence contract. UDM formal reports must reject missing required refs, local-only proof, false DONE, and production/full-authority overclaim.

Verification:
- 10 valid UDM reports aggregate into a PASS suite.
- EXPECTED_BLOCK baselines require gate/stop evidence.
- Malformed reports are rejected fail-closed.

## CHK-003

After implementation is committed, freeze the final target HEAD/materialHash and generate fresh Development, Engineering, and Loop Engineering formal proof under `.lattice/artifacts/baseline/layer3-loop-engineering-unlock`.

Verification:
- Lower-layer proof in the selected root matches the final target.
- Layer 3 does not consume the older Layer 2 root when stale.
- No `.omx` proof root is used.

## CHK-004

Capture independent Claude CLI and Codex CLI review artifacts as non-authority host evidence. They may support host-neutral review but cannot satisfy production Authority fields.

Verification:
- Both host artifacts bind to current head/material hash.
- Single-host, duplicate-host, or stale-host proof blocks.
- Production/global claims remain locked.

## CHK-005

Run build, targeted smoke/fail-closed tests, story validation, and lifecycle review/test gates. Record verification evidence against the current HEAD/materialHash before marking work done.

Verification:
- Build and targeted smoke pass.
- Formal claim evaluator returns Layer 3 unlocked only after all proof is fresh.
- REVIEW/TEST/DONE gates pass without stale evidence.
