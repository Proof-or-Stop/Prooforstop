## B-63ba Plan

Milestone 2 adds parameterized fault injection as an offline recovery-runner research-harness capability. It must not alter lifecycle gates, evidence hashing, delivery checks, or the fixed pre-registered B1-B15 default protocol.

## CHK-001

Define a small parameterized profile contract for scenario selection. The default profile remains the current `[null, ...B1-B15]` behavior. Add explicit profile modes only for exploratory runs, with validation that rejects unknown scenarios and invalid weights instead of silently shrinking the matrix.

Verification will use the recovery-runner selfcheck to prove default counts are unchanged, seeded weighted expansion is deterministic, and invalid profiles fail closed.

## CHK-002

Wire the contract into the run-driver CLI behind explicit flags. The enumerate-only path should show profile metadata when a profile is supplied, while no-profile invocations keep existing output/count behavior. Do not touch canonical record assembly, denominator computation, adjudication, or the driver loop.

Verification will run enumerate-only CLI commands with and without profile flags and assert no live engine is required.

## CHK-003

Extend `run-driver-selfcheck.mjs` with focused assertions for default compatibility, deterministic seeded expansion, and invalid CLI inputs. The selfcheck remains fully offline and no-LLM.

Verification will run `node experiments/recovery-runner/run-driver-selfcheck.mjs` and targeted CLI negative controls.

## CHK-004

Document the feature as exploratory and offline. Update README/decision docs so users understand that fixed B1-B15 remains the pre-registered default, parameterized profiles are for robustness exploration, and this feature is not fountain-code recovery, lifecycle gate evidence, or a production-readiness claim.

Verification will grep the docs for profile usage and the explicit non-goals.
