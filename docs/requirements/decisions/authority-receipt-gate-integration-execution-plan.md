# Authority Receipt Gate Integration Execution Plan

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

> Status: execution plan for the remaining validation and rollout slice.
> Parent: [Authority Receipt Gate End-to-End Plan](authority-session-receipt-gate-execution.md).
> Related:
> [Proofbound Authority Receipt Contract](lattice-authority-receipt-contract.md),
> [Proofbound CLI Authority Client and Receipt Ref](lattice-cli-authority-client-receipt-ref.md),
> [Lifecycle Gate Receipt Consumption](lifecycle-gate-receipt-consumption.md),
> [Authority Receipt Cross-Repo Live Smoke](authority-receipt-cross-repo-live-smoke.md).

## Purpose

The first slice established the primitives:

- Proofbound Authority Server signs `gate_decision` receipts with subject binding.
- Proofbound CLI can verify Ed25519 receipts with Python-compatible hex keys and
  signatures.
- Proofbound CLI has a pure receipt-ref eligibility and consumption predicate.
- `authority-receipt-refs.json` is registered as an L4 process fact artifact.

This plan now tracks the remaining slice: prove the deployed staging path and
rollout policy around the existing receipt verification, receipt-ref writing,
and lifecycle gate consumption baseline without changing local workflow
semantics for stories that do not require Authority-backed evidence.

## Principles

1. Do not optimize for optimization's sake.
2. Do not add arbitrary abstractions or product surfaces.
3. Fix only correctness gaps required for the signed receipt chain.
4. Keep host-neutral logic: Claude CLI, Codex CLI, local runners, and future
   hosts are evidence producers; only Proofbound Authority Server can mint a
   production `gate_decision` receipt.
5. Fail closed only when Authority-backed evidence is explicitly required.
   Otherwise degrade to local-only or shadow diagnostics.

## Non-Goals

- No multi-tenant API-key administration in this slice.
- No UI dashboard.
- No rewrite of the lifecycle state machine.
- No promotion of local diagnostic receipts, transport `accepted=true`, or
  host transcripts into production authority.
- No full revocation service. This slice only needs enough key/freshness
  structure to avoid accepting stale or untrusted receipts.

## Required Outcome

A story/project configured to require Authority-backed TEST or DONE must advance
only when the local gate consumes a fresh, verified, production-classified
`gate_decision` receipt ref that matches the current story, phase, head hash,
material hash, state version, evidence digests, and run bindings.

Local stories without that requirement must continue to work under existing
local gates.

## Current Baseline and Correctness Gaps

Server proof bundle support is current baseline, not remaining work:
`GET /v1/receipts/{receipt_id}/proof` returns `AuthorityReceiptProof` with the
receipt, `inputPayload`, `decisionPayload`, `decisionDigestPayload`, and server
key metadata needed by a remote verifier.

Proofbound CLI and local gate primitives are also current baseline:

- `authority_receipt_verify` / `lattice authority receipt verify` verifies proof
  bundles and writes production `gate_decision` refs only after production
  classification.
- `AuthorityClient.fetchGateReceiptProof()` fetches server-relative proof paths.
- `authority-receipt-refs.json` has store APIs and an L4 process fact registry
  entry.
- TEST/DONE validation and transition gates can read and consume verified refs
  in Authority shadow/enforce mode.
- Receipt consumption is idempotent for the same story, phase, head hash,
  material hash, and decision digest.

The remaining gaps are:

1. Cross-repo live smoke must prove the current Server + CLI + gate baseline
   against the deployed staging service with positive and negative controls.
2. Actor key binding, runner heartbeat, and runner/session enforcement need an
   explicit rollout policy before unattended strong evidence treats them as hard
   requirements. Current staging enforces production Authority/key posture, but
   does not advertise those actor/runner lifecycle checks as active top-level
   enforcement flags.
3. Key trust and rotation policy need operator-facing configuration guidance so
   production classification does not depend on an implicit local default.
4. Freshness policy needs rollout guidance for clock skew and offline
   revocation/supersession checks before it becomes a production hard gate.

## Execution Waves

### Wave 1: Server Receipt Proof Bundle

Owner: Proofbound Authority Server.

Status: baseline complete on staging as of 2026-06-10.

Goal: make a receipt independently verifiable by a remote client.

Files likely involved:

- `src/lattice_authority/api/routes.py`
- `src/lattice_authority/schemas/receipt.py`
- `src/lattice_authority/schemas/authority.py`
- `src/lattice_authority/repositories/memory.py`
- `src/lattice_authority/repositories/sqlalchemy.py`
- `tests/test_api.py`

Implemented baseline:

1. `AuthorityReceiptProof` exists in OpenAPI.
2. `GET /v1/receipts/{receipt_id}/proof` exists.
3. For a `gate_decision` receipt, the proof bundle returns:
   - `receipt`;
   - associated `recordId`;
   - `inputPayload`;
   - `decisionPayload`;
   - `decisionDigestPayload`, exactly the canonical object used by the server
     to compute `receipt.decisionDigest`;
   - `requestedByActorId`;
   - server key metadata needed for classification, including `serverKeyId`,
     public key material, and production-inert/local-test flag.
4. Missing receipts reject with `receipt_not_found`.
5. Proof lookup for records that cannot be bound back to the receipt should
   continue to reject with
   a precise server error such as `receipt_proof_payload_missing`.
6. The endpoint is read-only and must not issue a new receipt.

Acceptance tests:

- `gate_decision` proof returns receipt plus input/decision digest material.
- CLI-style recomputation of `inputDigest` and `decisionDigest` matches the
  receipt.
- Missing receipt returns 404.
- A non-gate receipt can either return proof marked non-gate or reject as not
  gate-consumable, but it must not masquerade as `gate_decision`.
- Existing `GET /v1/receipts/{receipt_id}` remains backward-compatible.

### Wave 2: CLI Receipt Verification and Writer

Owner: Proofbound CLI.

Status: local baseline implemented; needs staging/live proof verification and
rollout hardening.

Goal: fetch Server proof, verify it, classify it, and write a structured
receipt-ref artifact.

Files likely involved:

- `packages/main/src/core/authority-client.ts`
- `packages/main/src/core/authority-runner-contracts.ts`
- `packages/main/src/core/authority-signing.ts`
- `packages/main/src/core/authority-gate-receipts.ts`
- `packages/main/src/core/store.ts`
- `packages/main/src/cli-engine.ts`
- `packages/main/src/registry.ts`
- `packages/main/src/core/command-policy.ts`
- `packages/main/src/core/process-fact-registry.ts`
- `packages/main/src/core/process-fact-levels.ts`
- task smoke under `packages/main/src/tasks/`

Implemented baseline:

1. Zod schemas for the server proof bundle exist in
   `core/authority-gate-receipt-verifier.ts`.
2. `AuthorityClient.fetchGateReceiptProof(proofPath)` fetches server-relative
   proof bundles.
3. The pure verifier module verifies and classifies proof bundles:
   - verifies receipt signature over the canonical unsigned receipt payload;
   - recomputes `inputDigest` from `inputPayload`;
   - recomputes `decisionDigest` from `decisionDigestPayload`;
   - rejects receipt kind or subject mismatch;
   - rejects non-pass decision verdict;
   - rejects story/phase/head/material mismatch;
   - rejects production-inert keys;
   - supports trusted key ids/digests from a key set, not only a single key;
   - applies `maxVerifiedAgeMs` plus `allowedClockSkewMs`;
   - returns machine-readable fail reasons.
4. `authority_receipt_verify` is exposed as:
   `lattice authority receipt verify`.
5. The command writes `authority-receipt-refs.json` only when classification is
   `production-gate-decision`.
6. Store methods exist for this artifact instead of direct ad hoc story JSON
   writes:
   - `readAuthorityReceiptRefs(storyId)`;
   - `writeAuthorityReceiptRefs(storyId, document)`.
7. Existing refs are preserved through structured upsert behavior.
8. Keep diagnostics for invalid/local-test/contract-only receipts, but do not
   let them become gate-consumable refs.

Acceptance tests:

- Valid proof writes a production `gate_decision` receipt ref.
- Hex public key and hex signature verify.
- Corrupt signature fails.
- Corrupt input payload fails digest check.
- Corrupt decision payload fails digest check.
- Local-test/default server key verifies cryptographically but classifies
  `server-receipt-local-test`, not `production-gate-decision`.
- Story mismatch, phase mismatch, head mismatch, and material mismatch fail.
- Missing Authority URL or missing trusted key fails without local workflow
  mutation.
- The writer is idempotent for the same receipt id.

### Wave 3: Idempotent Gate Consumption

Owner: Proofbound CLI lifecycle gates.

Status: local TEST/DONE baseline implemented; REVIEW policy and production
rollout need explicit decision before hard enforcement.

Goal: make receipt consumption a real gate input without duplicate events.

Files likely involved:

- `packages/main/src/core/authority-gate-receipts.ts`
- `packages/main/src/handlers/phase-gates.ts`
- `packages/main/src/core/machine.ts`
- `packages/main/src/handlers/verifier.ts`
- `packages/main/src/core/workflow-policy.ts`
- `packages/main/src/core/config.ts`
- `packages/main/src/core/store.ts`
- `packages/main/src/core/process-fact-registry.ts`
- `scripts/verify-process-fact-contract.mjs`

Implemented baseline:

1. Consumption is idempotent:
   - if the same receipt already has a matching consumption event, return the
     existing event and fact;
   - do not append duplicates on retry or crash recovery.
   - current baseline deduplicates by story id, target phase, head hash,
     material hash, and decision digest rather than a separate
     `consumerDecisionId`.
2. Authority gate policy configuration defaults to local/off behavior and
   supports shadow/enforce behavior:
   - no config means existing local gates remain authoritative locally;
   - `mode=shadow` reports eligible/missing receipts but does not block;
   - `mode=enforce` blocks TEST/DONE when the required receipt is absent or
     invalid.
3. Gate adapters:
   - build current gate context from story id, target phase, current head hash,
     material hash, policy profile, and Authority mode;
   - read `authority-receipt-refs.json`;
   - call `eligibleAuthorityGateReceiptDocument`;
   - call idempotent consumption;
   - persist the updated artifact only after a successful consume;
   - return precise fail reasons for gate output.

Remaining rollout work:

1. Decide whether REVIEW must consume a separate Authority review gate receipt
   or remain optional unless project policy requires it.
2. Document and configure explicit project/story Authority gate policy:
   - no config means existing local gates remain authoritative locally;
   - `mode=shadow` reports eligible/missing receipts but does not block;
   - `mode=enforce` blocks REVIEW/TEST/DONE when the required receipt is absent
     or invalid.
3. Bind current server `stateVersion` and revocation/supersession checks when
   live policy requires them.
4. Decide whether production rollout needs an explicit stable
   `consumerDecisionId` field, or whether the current composite-key
   consumption identity remains the canonical contract.
5. Keep TEST/DONE positive and negative controls current for
   `lattice validate` and transition preflight.
6. For production DONE rollout:
   - re-check head/material immediately before DONE;
   - prefer a distinct DONE receipt unless policy explicitly allows a TEST
     receipt to cover DONE.
7. File absence means "no Authority evidence":
   - enforce mode fails closed;
   - shadow/local mode reports diagnostic only.

Acceptance tests:

- No receipt ref produces `strongEvidenceConsumed=false`.
- Enforce TEST blocks without a valid receipt.
- Shadow TEST reports missing/invalid receipt without blocking local validation.
- Valid TEST receipt is consumed and gate output names the receipt id.
- Re-running the same gate does not duplicate consumption events.
- Changing material hash after verification makes the receipt stale.
- DONE refuses a TEST receipt unless policy allows cross-phase coverage.
- Caller input cannot set `strongEvidenceConsumed` directly.

### Wave 4: Status and Operator Feedback

Owner: Proofbound CLI.

Goal: make output truthful and actionable.

Files likely involved:

- `packages/main/src/handlers/session.ts`
- `packages/main/src/handlers/story-authority-resolve.ts`
- `packages/main/src/core/observability-snapshot.ts`
- `packages/main/src/core/lattice-autopilot.ts`
- `packages/main/src/handlers/lattice-autopilot.ts`

Required behavior:

1. Status output must separately show:
   - Authority URL configured;
   - server policy reachable;
   - trusted server key configured;
   - latest receipt ref present;
   - latest receipt verified;
   - latest receipt eligible for current gate;
   - latest receipt consumed by current gate.
2. Keep `receiptVerified=false`, `authorityChanged=false`, and
   `productionDone=false` on local/diagnostic host paths unless the gate has
   consumed a production receipt.
3. Autopilot/dispatch surfaces may point to the required receipt command, but
   must not consume receipts themselves unless explicitly wired through the same
   lifecycle gate adapter.

Acceptance tests:

- Readiness without receipt does not display as authority completion.
- Verified but unconsumed receipt is shown as verified, not consumed.
- Consumed receipt output names receipt id and target phase.
- Local diagnostic receipts remain diagnostic-only.

### Wave 5: Cross-Repo Live Smoke

Owner: release / integration.

Goal: prove the chain works across the deployed Authority Server, Runner, and
CLI.

Use [Authority Receipt Cross-Repo Live Smoke](authority-receipt-cross-repo-live-smoke.md).
This production-capable smoke must target the deployed staging Authority URL. A
locally started server can still be useful for contract regression, but it is not
the authority target for this smoke and must stay labeled non-production or
contract-only.

Minimum command sequence:

1. Use the deployed staging Proofbound Authority Server with a configured
   non-default key.
2. Discover policy and server key.
3. Register actor key and runner heartbeat.
4. Create or claim a story-scoped job.
5. Submit signed evidence.
6. Evaluate a TEST gate on the server.
7. Fetch and verify receipt proof through `lattice authority receipt verify`.
8. Write `authority-receipt-refs.json`.
9. Run the local TEST gate and consume the receipt.
10. Run negative controls:
    - missing ref;
    - corrupt signature;
    - story mismatch;
    - phase mismatch;
    - stale material hash;
    - local-test server key;
    - evidence receipt without gate decision receipt;
    - transport accepted without receipt verification.

Pass criteria:

- Positive path reaches `strongEvidenceConsumed=true`.
- Negative controls fail closed when Authority is required.
- Output and artifacts name the consumed receipt id.

## Parallel Development Plan

These tracks can run in parallel:

- Host A: Server proof bundle regression checks, key policy checks, and deployed
  staging policy checks.
- Host B: CLI verifier/writer and gate consumption regression checks against
  real proof bundles or fixtures that match the implemented proof bundle.
- Main/Codex coordinator: keep docs, schemas, and process fact registry aligned.

These tracks must respect these dependencies:

- Cross-repo live smoke must wait for the deployed Server proof endpoint plus
  CLI verifier.
- DONE enforcement must wait for TEST enforcement to pass positive and negative
  controls.

Recommended two-host split:

| Track | Host | Scope | Must prove before handoff |
| --- | --- | --- | --- |
| Server proof baseline | Claude CLI or Codex host A | Server route/schema/repository/tests plus staging policy | proof recomputes receipt digests and uses production-capable key metadata |
| CLI verifier/writer | Codex host B | client/schema/verifier/store/command/tests | valid proof writes production ref; invalid proof does not |
| Gate integration | Main Codex after A+B | phase gates, validate, config, process facts | enforce blocks invalid/missing; shadow preserves local |
| Live smoke | Main plus optional reviewer | real cross-repo run | positive and negative controls pass |

## Verification Matrix

Server:

```bash
uv run pytest tests/test_api.py tests/test_job_verdicts.py
uv run pytest
```

CLI:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:authority-runner-contracts
npm --prefix packages/main run test:authority-receipt-classification
npm --prefix packages/main run test:authority-gate-receipts
npm --prefix packages/main run test:authority-receipt-proof
npm --prefix packages/main run test:authority-gate-consumption
```

Process fact contract:

```bash
npm run test:process-fact-contract
```

If unrelated existing drift still fails this contract, record it separately and
verify that new Authority receipt entries are not in the failure list. Do not
fix unrelated drift inside this slice unless it blocks the receipt gate work.

Cross-repo:

```bash
npm run test:authority-cross-repo-live-smoke
```

The live smoke should run against the deployed Server and current CLI paths.

## Stop Conditions

Stop and re-plan if any of these happen:

- The Server proof endpoint regresses and no longer returns enough payload
  material to recompute both receipt digests.
- CLI verification regresses to trusting local cache instead of server proof plus
  pinned key material.
- Gate integration makes existing local-only stories fail by default.
- A host transcript, dispatch receipt, or transport `accepted=true` path starts
  setting `receiptVerified=true`, `strongEvidenceConsumed=true`, or
  `productionDone=true`.
- Consumption idempotency regresses.

## Definition of Done

This slice is done when:

1. Deployed Server proof endpoint remains available and tested.
2. CLI verifies proof and writes a production receipt ref only for valid
   production `gate_decision` receipts.
3. TEST gate can consume the ref in enforce mode and block invalid/missing refs.
4. Shadow/local mode preserves existing local workflow.
5. Consumption events are idempotent.
6. DONE gate either consumes its own DONE receipt or explicitly refuses TEST
   receipt reuse unless configured.
7. Cross-repo live smoke positive path and negative controls pass.
