# B-1715 Plan

## Strategy

Implement a separate runtime/environment fact registry and wire it into existing doctor output. Do not add a new env_check command in this story. The registry is a hard-coded source of truth for runtime drift facts, while doctor remains the user-visible entrypoint.

## CHK-001

**Owner**: koala-implementer

Create packages/main/src/core/runtime-fact-registry.ts with typed runtime fact definitions. Include IDs for cli-entrypoint, global-core-realpath, project-local-bin, node-version, package-version, validate-source, and external-reference-policy. Each fact must declare severity, scope, checker/output key, and a rationale.

Verification:
- inspect registry fields and required IDs
- contract fails if a required runtime fact is removed
- process-fact registry remains separate

## CHK-002

**Owner**: koala-implementer

Create packages/main/src/core/runtime-environment-checks.ts and integrate it into doctor. The checker should report actual/expected/status for CLI entrypoint, global core realpath, current core realpath, project-local bin, Node version, and package version. Orchestrate self-check can be stricter; external projects should receive warnings and repair hints.

Verification:
- koala doctor --format=json exposes a runtime section
- local-bin shadowing in a temporary project returns warning, not lifecycle gate failure
- simulated global-core mismatch is not silent

## CHK-003

**Owner**: koala-implementer

Extend runtime checks to include validation source and external reference policy. Validation source must distinguish configured commands, fallback discovery, and missing validator. External references must be reported as reference-only or health-check-required; do not claim connectivity unless a real health command exists.

Verification:
- doctor text/json both show validate-source fact
- no-validator project returns missing/warning with repair hint
- external URL/host:port reference scan never emits fake connectivity pass

## CHK-004

**Owner**: koala-implementer

Add scripts/verify-runtime-fact-contract.mjs and package scripts. The contract must assert required runtime fact IDs, checker output keys, doctor JSON runtime section, and doctor text Runtime scan section. It should produce clear failure messages such as missing runtime fact and missing runtime output key.

Verification:
- npm run test:runtime-fact-contract prints Runtime fact contract verified
- adversarial source mutations in the verifier fixture fail with explicit messages
- package scripts expose the contract command

## Rollback

If runtime checker integration causes doctor instability, keep the registry and contract but downgrade doctor runtime rendering to JSON-only until text rendering is fixed. Do not change process-fact registry semantics as a workaround.
