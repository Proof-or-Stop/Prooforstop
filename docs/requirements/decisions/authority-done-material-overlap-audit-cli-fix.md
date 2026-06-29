# Authority DONE Material Overlap Audit CLI Fix

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

> Status: execution handoff for a Proofbound CLI correctness fix.
> Owner: Orchestrate / Proofbound CLI.
> Related:
> [Authority Receipt Gate Integration Execution Plan](authority-receipt-gate-integration-execution-plan.md),
> [Authority Receipt Cross-Repo Live Smoke](authority-receipt-cross-repo-live-smoke.md),
> [Proofbound CLI Authority Client and Receipt Ref](lattice-cli-authority-client-receipt-ref.md),
> [Lifecycle Gate Receipt Consumption](lifecycle-gate-receipt-consumption.md).

## Purpose

The deployed Authority DONE gate now enforces a material-overlap audit before
Authority completion. The current Proofbound CLI live smoke can reach TEST queued
job execution, but the full DONE live E2E fails during DONE preflight because
the CLI does not submit `materialOverlapAudit` in the signed gate decision
input.

This document defines the exact Server contract and the minimal CLI fix. The
goal is to fix the real DONE gate correctness gap only. Do not add arbitrary
endpoints, product surfaces, or broader optimization while implementing this
slice.

## Observed Failure

Environment:

- Server: `https://staging.hostneutral.net`
- CLI: Proofbound CLI `0.3.8`
- Smoke: `packages/main/dist/tasks/authority-live-python-e2e-smoke.js`

DONE preflight fails before queued job creation with:

```text
DONE enforce gate requires materialOverlapAudit before Authority completion.
```

Diagnostics:

```json
{
  "required": true,
  "present": false,
  "changedFiles": [],
  "actualFileOverlaps": [],
  "overlapCount": 0
}
```

The important signal is `present: false`. Empty arrays are acceptable for a
no-overlap smoke; the whole `materialOverlapAudit` object is missing from the
signed gate input.

## Server Contract

`materialOverlapAudit` is submitted to the Authority Server through the existing
gate evaluation endpoint:

```text
POST /v1/gates/evaluate
```

The request body is a signed `SignedDecisionInputEnvelope`. The audit belongs
inside the signed `decision` payload:

```json
{
  "actorId": "main-actor-id",
  "role": "main",
  "nonce": "unique-gate-nonce",
  "timestamp": "2026-06-19T00:00:00.000000+00:00",
  "decision": {
    "decisionId": "stable-decision-id",
    "projectId": "project-id",
    "storyId": "B-xxxx",
    "targetPhase": "done",
    "repo": {
      "headHash": "git-head",
      "materialHash": "material-hash",
      "dirty": false
    },
    "policyMode": "balanced",
    "authorityMode": "enforce",
    "evidenceHashes": [],
    "materialOverlapAudit": {
      "changedFiles": [],
      "actualFileOverlaps": []
    },
    "requestedByActorId": "main-actor-id",
    "requestedAt": "2026-06-19T00:00:00.000000+00:00"
  },
  "signature": "hex-ed25519-signature"
}
```

The envelope must be signed after `decision.materialOverlapAudit` is present.
The server binds the signed input into the gate decision receipt proof, so
adding the field after signing is invalid.

The minimal passing audit for a no-overlap smoke is:

```json
{
  "changedFiles": [],
  "actualFileOverlaps": []
}
```

DONE/enforce passes this audit condition only when:

- `decision.targetPhase` is `done`;
- `decision.authorityMode` is `enforce`;
- `decision.materialOverlapAudit` is present;
- `decision.materialOverlapAudit.actualFileOverlaps` is empty.

Non-empty `actualFileOverlaps` must fail closed.

## What Not To Implement

Do not create a new Server endpoint or CLI pseudo-contract for this field.

The following attempted submission paths are intentionally not the contract:

| Attempt | Result | Reason |
| --- | --- | --- |
| `POST /v1/checks` with `checkKind=materialOverlapAudit` | `422` | Server check kind enum only accepts `draft`, `init`, `scope`, and `delivery`. |
| `POST /v1/checks` with `checkKind=scope` and audit in payload | accepted but ignored by DONE | DONE gate does not read scope check payload for this audit. |
| `POST /v1/commands` with `command=scope_check_save` and audit args | accepted but ignored by DONE | Command payload does not populate the signed gate decision input. |
| `POST /v1/commands` with `material_overlap_audit`, `materialOverlapAudit`, or `parallel_wave` | unknown command | Server has no separate material-overlap command. |

The gate diagnostic `materialOverlapAudit.present` is derived from the signed
gate envelope, equivalent to:

```text
envelope.decision.material_overlap_audit is not null
```

## CLI Implementation Targets

Fix both the general Authority gate path and the live smoke path.

Likely files:

- `packages/main/src/core/authority-contracts.ts`
- `packages/main/src/core/planned-steps-executor.ts`
- `packages/main/src/core/authority-client.ts`
- `packages/main/src/tasks/authority-live-python-e2e-smoke.ts`
- generated `packages/main/dist/**` after build

Required changes:

1. Add a typed material-overlap audit contract:

```ts
export interface MaterialOverlapAuditContract {
  changedFiles: string[];
  actualFileOverlaps: string[];
}
```

2. Add optional `materialOverlapAudit?: MaterialOverlapAuditContract` to
   `GateEvaluateRequestContract` and its schema.

3. Add optional `materialOverlapAudit?: MaterialOverlapAuditContract` to
   `AuthorityGateInput` if the planned-steps gate path needs to carry this field
   from local execution state to the gate evaluator.

4. Ensure `buildGateEvaluateEnvelope(...)` includes:

```ts
materialOverlapAudit: request.materialOverlapAudit
```

inside `decision` for DONE/enforce gate requests. It must be included before
`signHexEnvelope(...)`.

5. Ensure `signedGateRequest(...)` in
   `packages/main/src/tasks/authority-live-python-e2e-smoke.ts` includes:

```ts
materialOverlapAudit: {
  changedFiles: [],
  actualFileOverlaps: [],
}
```

inside `decision` for the DONE preflight smoke.

6. Keep `actualFileOverlaps` fail-closed. The CLI must not silently drop overlaps
   to make DONE pass.

7. Do not infer production DONE from this audit alone. It only satisfies the
   Server material-overlap precondition. Receipt verification, receipt-ref write,
   and local gate consumption remain separate requirements.

## Data Source Policy

For the current live smoke, an explicit empty audit is acceptable because the
smoke is proving the Authority receipt chain and has no intended material file
overlap:

```json
{
  "changedFiles": [],
  "actualFileOverlaps": []
}
```

For real parallel development flows, `changedFiles` should come from the story
or job material change set, and `actualFileOverlaps` should come from the
existing material-overlap detector or equivalent process fact. The implementation
must not invent overlap results from prose, transcript text, or host identity.

This keeps the design host-neutral: Codex CLI, Claude CLI, and future hosts may
produce local evidence, but the Authority Server remains the component that
evaluates DONE and mints a production `gate_decision` receipt.

## Verification

The Proofbound CLI story should verify at least:

1. Unit/schema coverage: `GateEvaluateRequestContractSchema` accepts
   `materialOverlapAudit` with `changedFiles` and `actualFileOverlaps`.
2. Envelope coverage: `buildGateEvaluateEnvelope(...)` signs a DONE/enforce
   decision that contains `decision.materialOverlapAudit`.
3. Live smoke coverage: `authority-live-python-e2e-smoke` submits the audit in
   DONE preflight and no longer fails with `present=false`.
4. Negative coverage: non-empty `actualFileOverlaps` is not hidden or rewritten
   to `[]` by the CLI.
5. Receipt proof coverage: the proof fetched from
   `GET /v1/receipts/{receipt_id}/proof` contains `inputPayload.materialOverlapAudit`
   and the recomputed `inputDigest` still matches.

Expected positive live result:

```text
DONE preflight materialOverlapAudit: present=true overlapCount=0
Gate decision: PASS receiptId=<receipt-id> targetPhase=DONE
Receipt proof: PASS inputPayload.materialOverlapAudit present
```

## Story Checklist Suggestion

Use the normal Proofbound CLI story/worktree flow. Suggested checklist:

- Add material-overlap audit contract to gate request types and schemas.
- Include the audit in signed DONE/enforce gate envelopes before signing.
- Include the audit in the live Python E2E smoke DONE preflight.
- Add regression coverage for positive empty audit and negative non-empty
  overlap preservation.
- Rebuild CLI and run the targeted tests plus the staging live smoke.

## Acceptance Criteria

This fix is complete only when:

- the CLI sends `decision.materialOverlapAudit` to `/v1/gates/evaluate`;
- the field is inside the signed envelope;
- staging DONE preflight no longer reports `materialOverlapAudit.present=false`;
- non-empty `actualFileOverlaps` is preserved and fails closed;
- no new `/v1/checks` or `/v1/commands` material-overlap contract is introduced;
- the final live smoke continues to require verified `gate_decision` receipt
  proof and lifecycle gate consumption before claiming full Authority DONE.
