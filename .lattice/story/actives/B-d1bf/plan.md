# B-d1bf Execution Plan

## Story Boundary

B-d1bf delivers Quantum M3 only: a local, read-only gate-policy layer and
`quantum_claim_check` diagnostic command over the existing Quantum M0-M2
claim-admissibility evaluator.

In scope:

- pure Quantum gate-policy helpers that classify claim checks into `advance`,
  `repair`, `degrade`, `escalate`, or `stop`;
- a read-only `quantum_claim_check` command with JSON and text output;
- deterministic focused smoke coverage for complete, weak/degraded, stale,
  missing, mismatched, and overclaiming evidence;
- Quantum-specific documentation status updates from M0-M2 to M0-M3.

Out of scope:

- global Story machine or lifecycle transition mutation;
- M4 benchmark harness, A1-A4 metrics, B1-B15 failure injection matrix, or
  confidence intervals;
- M5 report/governance renderer or downstream governance workflow;
- quantum theory validation, quantum hardware or lab validation, solver
  improvement, production readiness, or Authority completion.

## CHK-001: Gate Policy Model

Implement pure helpers in
`packages/main/src/core/claim-admissibility/quantum.ts` that consume
`QuantumClaimCheckResult` and return deterministic policy guidance.

Expected behavior:

- complete bound Q5 evidence returns `decision: "advance"` with local
  claim-admissibility only;
- weak but scoped evidence returns `decision: "degrade"` rather than a false
  hard pass;
- stale, missing, mismatched, unbound, production, Authority, hardware, and
  theory overclaims never return `advance`.

Verification:

- extend `packages/main/src/tasks/quantum-claim-admissibility-smoke.ts` with
  pass/degrade/stop assertions;
- record `verificationEvidence` for `CHK-001:happy:0`,
  `CHK-001:edge:0`, and `CHK-001:adversarial:0`.

## CHK-002: Read-Only CLI Command

Add `quantum_claim_check` as a read-only diagnostic command.

Touchpoints:

- `packages/main/src/handlers/quantum-claim-admissibility.ts`;
- `packages/main/src/cli/command-catalog.ts`;
- `packages/main/src/core/command-policy.ts`;
- `packages/main/src/core/config.ts`;
- `packages/main/src/core/process-fact-levels.ts`;
- `packages/main/src/registry.ts`.

Expected behavior:

- `lattice quantum_claim_check --case=complete --json` prints
  `decision: "advance"`, `authorityDone: false`, and `productionDone: false`;
- weak demo cases print `decision: "degrade"`;
- overclaiming demo cases print `decision: "stop"`;
- the command writes no lifecycle evidence and advances no story phase.

Verification:

- focused smoke exercises complete, weak, and overclaim cases;
- command policy marks the command as read-only and all-phase;
- record `verificationEvidence` for `CHK-002:happy:0`,
  `CHK-002:edge:0`, and `CHK-002:adversarial:0`.

## CHK-003: Focused Smoke Coverage

Extend the existing Quantum smoke rather than adding a benchmark harness.

Required smoke lines:

- `quantum M3 gate policy passed`;
- command-path checks for complete, weak/degraded, missing/stale, and
  overclaiming cases;
- explicit assertions that M4/M5, production, Authority, hardware, and theory
  readiness are not emitted.

Verification:

- run `npm --prefix packages/main run test:quantum-claim-admissibility`;
- use the same focused smoke command as real-machine transcript evidence.

## CHK-004: Documentation Status

Update Quantum-specific docs to say M0-M3 are implemented and M4-M5 remain
pending.

Important reviewer note:

- This status applies to the Quantum execution plan runtime status only.
- Do not claim the generic claim-admissibility framework M4 gate-policy adapter
  milestone is complete.
- Do not claim benchmark/reporting, production, Authority, hardware, theory, or
  global lifecycle integration.

Verification:

- smoke or docs check asserts the exact runtime status string;
- docs review verifies the generic framework milestone status is not overclaimed.

## CHK-005 and CHK-006

`plan_skeleton --write` generated CHK-005 and CHK-006 as broad umbrella rows
after the user-confirmed checklist already existed. PLAN phase forbids removing
checklist items after INIT_CHECK, so these rows remain in the story for gate
review.

They do not expand scope. They are satisfied by the same implementation and
verification evidence that satisfies CHK-001 through CHK-004.

## Execution Order

1. Implement pure policy helpers.
2. Add `quantum_claim_check` handler and command wiring.
3. Extend focused Quantum smoke.
4. Update Quantum-specific docs without claiming generic framework M4.
5. Build and run focused smoke.
6. Record verification evidence for every required intent.
7. Move through REVIEW, TEST, delivery-check, `done_prepare`, and DONE.
