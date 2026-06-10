# B-92e2 Plan

## Shared Contract

Implement a thin local Baseline 2-5 runner/report surface in the repository source. The shared contract is intentionally small: layer id, baseline id, run id, material hash, expected outcome, observed outcome, blocked reasons, authority boundary, artifact paths, and suite aggregation.

Implementation may proceed in parallel, but capability proof and claim unlock remain sequential: Development -> Engineering -> Loop Engineering -> Production Safety -> Capability Claim.

The local CLI must never manufacture production authority. Local/shadow reports keep receiptVerified=false, productionDone=false, and fullAuthorityDone=false unless a future receipt-backed implementation provides verified authority artifacts.

## Parallel Workstreams

- Main/Codex coordinator owns shared schema, registry, CLI schemas, command policy, process fact registration, and integration.
- Codex side agents provide read-only architecture, file mapping, verification, and final review.
- Claude CLI provides independent second-host review artifacts.
- Code-writing workstreams may be split only by disjoint files; shared schema/gate files remain coordinator-owned.

## CHK-001

Create the shared local baseline core and CLI command wiring. Add `baseline_run`, `baseline_suite`, `baseline_suite_report`, and `capability_claim_evaluate` to local source so `node bin/lattice.js` exposes them after build. Update command policy and process fact metadata so the commands are visible to Lattice as bounded local report/evidence surfaces.

## CHK-002

Implement Engineering Baseline definitions and report generation for ENG-* scenarios. The first implementation is a deterministic local harness/report generator, not a claim that all engineering baselines have been proven on real projects. Development baseline evidence is an entry gate; missing lower-layer proof blocks higher claims.

## CHK-003

Implement Loop Engineering / UDM definitions with bounded loop policy artifacts. The runner must record stop/budget/evidence-gate behavior and classify missing prerequisites as EXPECTED_BLOCK or not_authorized rather than PASS.

## CHK-004

Implement Production Safety definitions and authority/soak lock behavior. SAFE/AUTH/PROD scenarios must fail closed without real receipt, multi-host authority, freshness, and soak evidence. Reports must preserve thin-client authority fields.

## CHK-005

Implement Capability Claim evaluator. It reads layer suite reports, determines highest authorized claim, blocks overclaim/non-authority/stale evidence, and writes claim-report JSON/Markdown when requested. It must not infer authority from code presence or local report generation.

## CHK-006

Add smoke coverage and documentation-level verification. Tests must build local dist, exercise local CLI commands, inspect report JSON, prove claim locks remain sequential, and prove local reports do not overclaim production authority.

## Done Boundary

DONE for this story means the local CLI can run and report Baseline 2-5 implementation readiness with fail-closed gates. It does not mean Engineering, Loop Engineering, Production Safety, or production-grade unattended development capability has been proven.
