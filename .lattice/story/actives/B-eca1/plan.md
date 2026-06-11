# B-eca1 Execution Plan

Scope: implement the Lattice CLI side of Authority receipt verification and lifecycle gate consumption. This story starts after the Server proof endpoint contract exists, but the CLI implementation must remain host-neutral: it verifies canonical JSON digests and Ed25519 receipt signatures, then writes and consumes receipt refs through Lattice story artifacts. It must not trust Claude, Codex, local cache, transport success, or shadow diagnostics as production authority.

Baseline precondition: this worktree currently does not include the detailed receipt/gate decision docs that exist in the main working tree (`lattice-authority-receipt-contract.md`, `lattice-cli-authority-client-receipt-ref.md`, `lifecycle-gate-receipt-consumption.md`, `authority-receipt-cross-repo-live-smoke.md`, and `authority-receipt-gate-integration-execution-plan.md`). Before source implementation begins, either bring those docs into this story branch or update relatedDocs to existing truth-source paths. Do not implement from orphaned assumptions.

Dependency precondition: Server story B-f053 owns `GET /v1/receipts/{receiptId}/proof`. Until that endpoint is available in a merged server baseline, CLI tests should use deterministic fixtures/mocks for the proof shape and keep cross-repo live smoke out of this story.

Host-neutral invariant:
- Receipt verification is pure data validation over proof JSON, canonical digest material, and Ed25519 signature verification.
- The same verified proof must produce the same outcome on Claude CLI, Codex CLI, or any host running Lattice CLI.
- Local/shadow/transport-accepted paths must keep `receiptVerified=false`, `strongEvidenceConsumed=false`, and `productionDone=false` unless a production-classified gate_decision receipt ref is verified and consumed by the gate adapter.

## CHK-001 — Add receipt proof client and verifier

Implementation:
- Extend `AuthorityClient` with a proof fetch method for `GET /v1/receipts/{receiptId}/proof` using the existing outcome taxonomy.
- Define a proof contract/schema for the Server proof bundle: signed receipt, input payload, decision payload, decisionDigestPayload, requestedByActorId, server key id/public key/profile, story/phase/head/material fields needed for gate matching.
- Add `authority-gate-receipt-verifier.ts` as the single pure verifier for proof schema validation, signature verification, inputDigest recomputation, decisionDigest recomputation, story/phase/head/material matching, freshness, and production/local-test classification.
- Reuse existing canonical JSON and Ed25519 helpers. Only add hex-key support if Server receipts expose hex public keys; do not replace existing base64 runner signing helpers unnecessarily.

Correctness constraints:
- A cryptographically valid local-test/default key is not production authority.
- Any corrupt signature, payload, digest, story, phase, head, or material mismatch returns a machine-readable fail reason and cannot write a production ref.
- Verifier functions should be deterministic and not depend on process cwd, host name, or active Claude/Codex runtime.

Validation:
- Logic smoke covers valid production proof, valid local-test proof, corrupt signature, digest mismatch, wrong story/phase/head/material, and malformed schema.
- Expected visible output contains `Receipt verification: PASS receiptVerified=true classification=production-gate-decision receiptId=<id>` for a valid production proof.

## CHK-002 — Add receipt-ref writer command and store support

Implementation:
- Add a CLI command surface such as `lattice authority receipt verify` that fetches/verifies a proof and writes `authority-receipt-refs.json` only when verifier classification is production gate_decision.
- Store refs under the active story artifact path, preserving previous refs and replacing or deduplicating by receipt id / gate / phase according to the receipt-ref contract.
- Register the receipt-ref artifact and any new process facts in `process-fact-registry` / `process-fact-levels`.

Correctness constraints:
- Invalid, local-test, transport-accepted, contract-only, or shadow diagnostics do not write production refs.
- Re-running verification for the same receipt is idempotent and does not create duplicate refs.
- The writer should emit clear machine-readable status and path output for operators.

Validation:
- Smoke writes one active ref for a valid production proof and preserves prior unrelated refs.
- Re-verifying the same proof remains idempotent.
- Negative controls prove invalid/local-test proofs write no production ref.
- Expected visible output contains `Receipt ref: PASS path=.koala/story/actives/<storyId>/authority-receipt-refs.json receiptId=<id> status=active`.

## CHK-003 — Wire idempotent TEST gate consumption

Implementation:
- Add/extend `authority-gate-receipts.ts` to load, filter, verify freshness, and consume matching TEST receipt refs.
- Wire the adapter into `validate` / TEST gate enforcement through `phase-gates.ts` and related verifier/workflow-policy/config surfaces.
- Consumption must derive `strongEvidenceConsumed=true` only from the gate adapter after a matching verified production ref, not from proof fetch alone.

Correctness constraints:
- Enforce mode fails closed for missing, stale, wrong story, wrong phase, wrong head, wrong material, or unverifiable refs.
- Shadow/local mode may report diagnostics but must not block existing local workflows by default.
- Consumption is idempotent: repeated gate checks do not consume or duplicate stronger evidence in a way that changes the result incorrectly.

Validation:
- Happy path TEST ref consumption prints `Authority gate consumption: PASS strongEvidenceConsumed=true receiptId=<id> gate=TEST`.
- Shadow mode reports diagnostics without blocking.
- Enforce mode blocks each negative control with an `authority_receipt_*` reason.

## CHK-004 — Wire DONE gate policy and status output

Implementation:
- Require a distinct DONE receipt for DONE unless an explicit policy allows TEST coverage.
- Re-check head/material/story/phase freshness before DONE and route failures through structured `authority_receipt_*` reasons.
- Keep DONE gate policy separate from operator status rendering. CHK-006 owns the status lines; this item owns gate behavior.

Correctness constraints:
- A TEST receipt cannot satisfy DONE by accident.
- Local diagnostic receipts never set `productionDone=true`.
- DONE gate logic must use the same verifier/consumer semantics as TEST, with phase-specific policy applied on top.

Validation:
- A valid DONE receipt passes and prints `Authority DONE gate: PASS receiptId=<id> gate=DONE`.
- TEST-to-DONE coverage passes only when the policy explicitly allows it.
- Missing, stale, wrong-phase, or local-test receipts block DONE in enforce mode.

## CHK-005 — Add CLI smoke tests and process fact coverage

Implementation:
- Add deterministic smoke tasks for proof verification and gate consumption.
- Add package scripts for the new smoke tasks without disturbing existing authority smoke scripts.
- Extend process fact contract verification for `authority-receipt-refs.json` and any new authority facts used by gates/status.

Correctness constraints:
- Smoke tests must include negative controls, not only happy paths.
- Cross-repo live smoke remains excluded until Server B-f053 and CLI B-eca1 both have merged foundations.
- Process facts must not let status/prose bypass gate semantics.

Validation commands:

```bash
npm run build
npm --prefix packages/main run test:authority-receipt-proof-smoke
npm --prefix packages/main run test:authority-gate-consumption-smoke
npm run test:process-fact-contract
```

Expected visible output contains `authority receipt proof smoke passed` and `authority gate consumption smoke passed`, with negative controls listed as blocked.

## CHK-006 — Separate Authority receipt status and operator feedback

Implementation:
- Render readiness, verification, eligibility, consumption, and production completion as distinct status facts in relevant status/session/autopilot views.
- Avoid overloading `productionDone` with readiness or verification; production completion is only true after gate consumption semantics allow it.
- Keep operator output clear enough for users to know whether they are missing config, missing a verified ref, or blocked by gate consumption.

Correctness constraints:
- `authorityReady`, `receiptVerified`, `receiptEligible`, `receiptConsumed`, and `productionDone` are separate facts.
- A verified but unconsumed receipt is visible as verified/eligible, not consumed/done.
- Local diagnostic receipts and transport accepted responses keep `receiptVerified=false`, `authorityChanged=false`, and `productionDone=false`.

Validation:
- Status smoke covers configured, verified, eligible, consumed, and not-done states.
- Existing authority status smoke remains compatible with local/shadow false invariants unless a verified production receipt is explicitly part of the fixture.
- Expected visible output contains separate lines for `authorityReady`, `receiptVerified`, `receiptEligible`, `receiptConsumed`, and `productionDone`.

## Out of Scope

- Server proof endpoint implementation; owned by Lattice Authority Server story B-f053.
- Cross-repo live smoke against a running server; open a separate integration/smoke story after foundations merge.
- Multi-tenant API key management, server key rotation/revocation, or operator UI dashboards.
- Arbitrary cleanup of authority/autopilot naming or unrelated legacy Koala compatibility paths.
