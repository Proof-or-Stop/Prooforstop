# Plan: B-2c0c Enforce decision-doc 3-round 2-host verification as a DONE gate

## CHK-001: Add decision-doc quorum detector and DONE gate

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/machine.ts
- Modify: packages/main/src/core/types.ts
- Create: packages/main/src/core/decision-doc-quorum.ts

**Verify**:
- `npm --prefix packages/main run build` completes successfully.
- `npm --prefix packages/main run test:decision-doc-quorum-smoke` includes pass cases for changed decision docs with three distinct rounds, two distinct hosts per round, and a fresh material digest.
- `npm --prefix packages/main run test:decision-doc-quorum-smoke` includes fail cases for stale digest, duplicate host, insufficient host count, insufficient round count, and prose-only/non-host evidence.

**DoneWhen**:
- A story with no changed `docs/requirements/decisions/*.md` is not subject to the quorum gate.
- A story with changed decision docs is blocked before DONE unless the current changed-doc material digest has three passing rounds.
- Each counted round requires at least two distinct passing host ids.
- Duplicate host submissions and stale material digests do not satisfy the gate.
- Existing DONE guards for validation evidence, bugs, delivery check, and docs promises remain active.

## CHK-002: Provide CLI-visible diagnostics for the decision-doc gate

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/cli-engine.ts
- Modify: packages/main/src/registry.ts
- Create: packages/main/src/handlers/decision-doc-quorum.ts

**Verify**:
- `lattice decision_doc_quorum_check --storyId=B-2c0c` reports changed decision docs, current digest, valid rounds, missing rounds, and ignored stale or duplicate verdicts.
- DONE failure text from `story_advance` names the decision-doc quorum problem instead of returning a generic cannot-merge reason.
- The diagnostic command is read-only and does not write story metadata.

**DoneWhen**:
- Operators can run one Lattice command to see whether decision-doc quorum is satisfied.
- Incomplete states explain the exact missing round, host diversity, or digest freshness requirement.
- Prose-only evidence, wrong digest, and duplicate host submissions are described as ignored or insufficient.

## CHK-003: Cover pass and fail paths with focused tests

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/package.json
- Create: packages/main/src/tasks/decision-doc-quorum-smoke.ts

**Verify**:
- `npm --prefix packages/main run build` compiles the new task and core helper.
- `npm --prefix packages/main run test:decision-doc-quorum-smoke` passes locally.
- The smoke test constructs deterministic temporary git repositories so changed decision-doc detection is exercised against real git state.

**DoneWhen**:
- Tests cover not-applicable no-change behavior.
- Tests cover missing host_verdict events, insufficient hosts, insufficient rounds, stale material digest, duplicate host submissions, and valid passing quorum.
- A regression that counts prose-only events or stale host verdicts as quorum would fail the smoke test.

## CHK-004: Document process fact contract for host quorum gate

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: packages/main/src/core/command-policy.ts
- Modify: packages/main/src/core/process-fact-levels.ts
- Modify: packages/main/src/core/process-fact-registry.ts
- Modify: scripts/verify-process-fact-contract.mjs
- Modify: docs/requirements/decisions/story-lifecycle.md
- Modify: docs/requirements/decisions/lifecycle-gate-receipt-consumption.md

**Verify**:
- `node scripts/verify-process-fact-contract.mjs` passes and includes assertions for the decision-doc quorum DONE gate fact.
- `rg -n "decision-doc quorum|host_verdict|three distinct rounds|two distinct" docs/requirements/decisions/story-lifecycle.md docs/requirements/decisions/lifecycle-gate-receipt-consumption.md packages/main/src/core/process-fact-levels.ts packages/main/src/core/process-fact-registry.ts scripts/verify-process-fact-contract.mjs` shows the gate-consumed fact contract in code, docs, and verifier assertions.
- `npm --prefix packages/main run build` still passes after registry updates.

**DoneWhen**:
- Docs state that changed decision docs require `host_verdict` quorum before DONE: three distinct rounds, at least two distinct passing hosts per round, and fresh digest.
- `autopilot_review_submit`/`host_verdict` is registered as gate-consumed workflow evidence for this local quorum gate without claiming Authority Server receipt completion.
- `scripts/verify-process-fact-contract.mjs` fails if the host verdict quorum fact is no longer L4, no longer gateEvidence, lacks the DONE gate consumer, or drifts into Authority Server receipt overclaim.
- Runtime-only facts remain out of the process fact registry.
